// 自检。跑一遍就知道多 agent 同时用会不会出问题。
//   node test/selfcheck.mjs
//
// 查八件事：
// 1. 并发写会不会串行、行会不会交错
// 2. 消息 id 会不会撞
// 3. 同一次提交重试会不会写两遍
// 4. 崩溃留下的半行会不会让文件读不动
// 5. 第二个服务实例会不会抢着写
// 6. 刷屏会不会被限流
// 7. 游标会不会被覆盖
// 8. 身份第一次接入会不会锁住、别人能不能冒用

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { startServer } from '../src/server.mjs';
import { Store } from '../src/store.mjs';
import { discover, readRuntime } from '../src/lock.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.join(HERE, '.testdata');
const PORT = 7799;
const HOST = '127.0.0.1';

let pass = 0;
let fail = 0;
const fails = [];

function ok(name, cond, detail = '') {
  if (cond) { pass += 1; console.log(`  ok   ${name}`); }
  else { fail += 1; fails.push(name + (detail ? `：${detail}` : '')); console.log(`  FAIL ${name}${detail ? '  ' + detail : ''}`); }
}

function rmrf(p) {
  try { fs.rmSync(p, { recursive: true, force: true }); } catch {}
}

const api = (p) => `http://${HOST}:${PORT}${p}`;

async function post(body) {
  const r = await fetch(api('/api/post'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: r.status, data: await r.json() };
}

async function main() {
  rmrf(DIR);
  fs.mkdirSync(DIR, { recursive: true });

  const s1 = await startServer({ dir: DIR, port: PORT, host: HOST, onLog: () => {} });
  ok('服务起得来', !!s1.port, `port=${s1.port}`);

  // ---- 1 并发写 ----
  console.log('\n并发写：8 个 agent 各 10 条，同时打');
  const agents = ['codex', 'dsh', 'workbuddy', 'claude', 'cursor', 'gemini', 'qwen', 'kimi'];
  // 真实客户端是先在本地生成 key、落盘、再发请求的，这里照做。
  // 不带 key 的话首条会把名字锁上，后 9 条全被 409 挡掉，那测的就不是并发了。
  const agentKeys = {};
  for (const a of agents) agentKeys[a] = crypto.randomBytes(24).toString('hex');
  const jobs = [];
  for (const a of agents) {
    for (let i = 0; i < 10; i += 1) {
      jobs.push(post({
        project: 'stress', from: a, body: `第 ${i} 条，来自 ${a}`,
        clientKey: `${a}-${i}`, agentKey: agentKeys[a],
      }));
    }
  }
  const results = await Promise.all(jobs);
  const bad = results.filter((r) => r.status !== 200);
  ok('80 条全部成功', bad.length === 0, `失败 ${bad.length} 条`);

  const file = path.join(DIR, 'stress.jsonl');
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  ok('落盘 80 行', lines.length === 80, `实际 ${lines.length}`);

  let parsed = 0;
  let parseErr = 0;
  const ids = new Set();
  const cks = new Set();
  let idDup = 0;
  let ckDup = 0;
  for (const line of lines) {
    let m;
    try { m = JSON.parse(line); parsed += 1; } catch { parseErr += 1; continue; }
    if (ids.has(m.id)) idDup += 1;
    ids.add(m.id);
    if (m.ck) { if (cks.has(m.ck)) ckDup += 1; cks.add(m.ck); }
  }
  ok('每行都是完整 JSON（没有交错）', parseErr === 0, `坏行 ${parseErr}`);
  ok('id 不重复', idDup === 0, `重复 ${idDup}`);
  ok('幂等键不重复', ckDup === 0, `重复 ${ckDup}`);

  // ---- 2 重试去重 ----
  console.log('\n重试：同一个 clientKey 打三次');
  const r1 = await post({ project: 'stress', from: 'codex', body: '重试测试', clientKey: 'retry-1', agentKey: agentKeys.codex });
  const r2 = await post({ project: 'stress', from: 'codex', body: '重试测试', clientKey: 'retry-1', agentKey: agentKeys.codex });
  const r3 = await post({ project: 'stress', from: 'codex', body: '重试测试', clientKey: 'retry-1', agentKey: agentKeys.codex });
  ok('三次返回同一条', r1.data.msg.id === r2.data.msg.id && r2.data.msg.id === r3.data.msg.id);
  ok('后两次标记为去重', r2.data.deduped === true && r3.data.deduped === true);
  const after = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).length;
  ok('文件只多一行', after === 81, `实际 ${after}`);

  // ---- 3 游标 ----
  console.log('\n游标：读一次推进一次');
  const c0 = await (await fetch(api('/api/cursor?agent=codex'))).json();
  const m0 = await (await fetch(api('/api/messages?project=stress&limit=10'))).json();
  await fetch(api('/api/cursor'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ agent: 'codex', project: 'stress', lastId: m0.messages[9].id }),
  });
  const c1 = await (await fetch(api('/api/cursor?agent=codex'))).json();
  ok('游标写进去了', c1.cursor.stress && c1.cursor.stress.lastId === m0.messages[9].id);
  const next = await (await fetch(api(`/api/messages?project=stress&since=${m0.messages[9].id}`))).json();
  ok('按游标只拿到新的', next.messages.every((m) => m.id !== m0.messages[9].id));

  // ---- 4 半行自愈 ----
  console.log('\n半行：模拟写到一半被杀');
  const halfFile = path.join(DIR, 'half.jsonl');
  fs.writeFileSync(halfFile, '{"id":"a","body":"完整的一行"}\n{"id":"b","body":"写到一半', 'utf8');
  const store2 = new Store(DIR);
  const got = store2.readMessages('half');
  ok('半行被截掉，只剩完整那条', got.length === 1, `读到 ${got.length} 条`);
  const tail = fs.readFileSync(halfFile, 'utf8');
  ok('文件末尾是换行', tail.endsWith('\n'));
  ok('残缺内容记进了 _corrupt.log', fs.existsSync(path.join(DIR, '_corrupt.log')));

  // ---- 5 第二实例 ----
  console.log('\n第二实例：同目录再起一个');
  const rt = readRuntime(DIR);
  const live = await discover(DIR, HOST);
  ok('能发现活着的实例', !!live && live.instanceId === rt.instanceId);
  const s2 = await startServer({ dir: DIR, port: PORT + 1, host: HOST, onLog: () => {} });
  ok('第二实例直接复用，不新起', s2.reused === true && s2.instanceId === s1.instanceId);
  await s2.close();
  ok('复用实例的 close 不会杀掉真服务', !!(await discover(DIR, HOST)));

  // ---- 6 限流 ----
  console.log('\n限流：一个 agent 连打 50 条');
  const floodKey = crypto.randomBytes(24).toString('hex');
  let limited = 0;
  for (let i = 0; i < 50; i += 1) {
    const r = await post({ project: 'flood', from: 'flooder', body: `刷屏 ${i}`, agentKey: floodKey });
    if (r.status === 429) limited += 1;
  }
  ok('超量被拦下来了', limited > 0, `429 共 ${limited} 条`);

  // ---- 7 名字校验 ----
  console.log('\n名字校验：中文名、带斜杠的项目名');
  const badName = await post({ project: 'stress', from: '张三', body: 'x' });
  ok('中文 agent 名被拒', badName.status === 400);
  const badProj = await post({ project: '../etc', from: 'codex', body: 'x' });
  ok('路径穿越被拒', badProj.status === 400);

  // ---- 8 身份 ----
  console.log('\n身份：注册、锁定、认领');
  const reg = await fetch(api('/api/register'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'locked_agent', project: 'ident' }),
  }).then((r) => r.json());
  ok('注册拿到固定 id', /^ag_[0-9a-f]{8}$/.test(String(reg.agent?.id)), `id=${reg.agent?.id}`);
  ok('注册返回 key', typeof reg.key === 'string' && reg.key.length >= 32);

  const noKey = await post({ project: 'ident', from: 'locked_agent', body: '不带 key' });
  ok('锁住之后不带 key 被拒', noKey.status === 409, `status=${noKey.status}`);

  const wrongKey = await post({ project: 'ident', from: 'locked_agent', body: '错的 key', agentKey: 'deadbeef' });
  ok('带错 key 被拒', wrongKey.status === 409);

  const goodKey = await post({ project: 'ident', from: 'locked_agent', body: '对的 key', agentKey: reg.key });
  ok('带对 key 能发', goodKey.status === 200, `status=${goodKey.status}`);
  ok('消息里记了 fromId', goodKey.data.msg?.fromId === reg.agent.id);

  const again = await post({ project: 'ident', from: 'locked_agent', body: '再发一条', agentKey: reg.key });
  ok('同一个 key 可以反复用', again.status === 200 && again.data.msg?.fromId === reg.agent.id);

  const auto = await post({ project: 'ident', from: 'fresh_agent', body: '第一次来' });
  ok('没注册过的名字自动建档', auto.status === 200 && /^ag_[0-9a-f]{8}$/.test(String(auto.data.agent?.id)));
  ok('自动建档当场锁定', auto.data.agent?.locked === true, '还是没锁');
  ok('锁定时把 key 交回来', typeof auto.data.agentKey === 'string' && auto.data.agentKey.length >= 32);

  const autoNoKey = await post({ project: 'ident', from: 'fresh_agent', body: '不带 key 再来' });
  ok('自动锁定之后不带 key 被拒', autoNoKey.status === 409, `status=${autoNoKey.status}`);

  const auto2 = await post({ project: 'ident', from: 'fresh_agent', body: '带 key 再来', agentKey: auto.data.agentKey });
  ok('自动签发的 key 能用，id 不变', auto2.status === 200 && auto2.data.msg?.fromId === auto.data.agent.id);

  // 客户端自带 key：服务端不存明文，也就不该把 key 再吐回来
  const ownKey = crypto.randomBytes(24).toString('hex');
  const own = await post({ project: 'ident', from: 'selfkey_agent', body: '自带 key', agentKey: ownKey });
  ok('客户端自带 key 能建档', own.status === 200 && /^ag_/.test(String(own.data.agent?.id)));
  ok('自带 key 时不回传明文', own.data.agentKey === null, `回了 ${String(own.data.agentKey).slice(0, 8)}`);
  const ownAgain = await post({ project: 'ident', from: 'selfkey_agent', body: '还用这把', agentKey: ownKey });
  ok('自带 key 可以反复用', ownAgain.status === 200 && ownAgain.data.msg?.fromId === own.data.agent.id);

  // 同一个 agent 并发发首条：本地先落盘同一把 key，服务端不会自己把自己锁在外面
  const raceKey = crypto.randomBytes(24).toString('hex');
  const race = await Promise.all([0, 1, 2, 3, 4].map((i) => post({
    project: 'ident', from: 'race_agent', body: `并发首条 ${i}`, clientKey: `race-${i}`, agentKey: raceKey,
  })));
  ok('并发首条全部成功（同一把 key）', race.every((r) => r.status === 200),
    `失败 ${race.filter((r) => r.status !== 200).length} 条`);
  ok('并发首条拿到同一个 id',
    new Set(race.map((r) => r.data.msg?.fromId)).size === 1);

  // id 是全局的，跟名字绑，不分频道。同一个名字在两个频道发言，id 必须是同一个。
  const crossKey = crypto.randomBytes(24).toString('hex');
  const m1 = await post({ project: 'ident', from: 'multi', body: '在 ident 说', agentKey: crossKey });
  const m2 = await post({ project: 'stress', from: 'multi', body: '在 stress 说', agentKey: crossKey });
  ok('跨频道是同一个 id', m1.data.msg?.fromId === m2.data.msg?.fromId, `${m1.data.msg?.fromId} vs ${m2.data.msg?.fromId}`);
  ok('两个频道都记进同一个档案',
    (await fetch(api('/api/who')).then((r) => r.json())).agents?.multi?.projects?.length === 2);

  // 身份也可以从 header 带，body 优先
  const hdrOk = await fetch(api('/api/post'), {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${crossKey}`, 'x-agent-name': 'multi' },
    body: JSON.stringify({ project: 'ident', body: '用 header 带身份' }),
  });
  const hdrData = await hdrOk.json();
  ok('header 带 key 和名字也认', hdrOk.status === 200 && hdrData.msg?.fromId === m1.data.msg?.fromId);
  const hdrBad = await fetch(api('/api/post'), {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-agent-key': '0'.repeat(48), 'x-agent-name': 'multi' },
    body: JSON.stringify({ project: 'ident', body: 'header 里带错 key' }),
  });
  ok('header 带错 key 被拒', hdrBad.status === 409, `status=${hdrBad.status}`);

  // 升级前的老条目（只有 {project, lastSeen}，没 id 没 key）第一次接入就锁定
  const legacyDir = path.join(DIR, 'legacy');
  fs.mkdirSync(legacyDir, { recursive: true });
  fs.writeFileSync(path.join(legacyDir, 'agents.json'), JSON.stringify({
    oldie: { project: 'ident', lastSeen: '2026-01-01T00:00:00+08:00' },
  }));
  const ls = new Store(legacyDir);
  const legacyId = ls.registry().oldie.id;
  const legacyPost = ls.post({ project: 'ident', from: 'oldie', body: '升级后第一次' });
  ok('老条目第一次发消息就锁定', !!ls.registry().oldie.keyHash);
  ok('老条目锁定时交出 key', typeof legacyPost.agentKey === 'string' && legacyPost.agentKey.length >= 32);
  ok('老条目 id 沿用原来那个', ls.registry().oldie.id === legacyId);
  let legacyBlocked = false;
  try { ls.post({ project: 'ident', from: 'oldie', body: '冒充' }); } catch (e) { legacyBlocked = e.code === 'NAME_TAKEN'; }
  ok('老条目锁定后不带 key 被拒', legacyBlocked);

  // 升级收尾：把所有还没锁的条目一次锁上，本地已有 key 的沿用不覆盖
  const sealDir = path.join(DIR, 'seal');
  fs.mkdirSync(sealDir, { recursive: true });
  fs.writeFileSync(path.join(sealDir, 'agents.json'), JSON.stringify({
    aaa: { project: 'ident', lastSeen: '2026-01-01T00:00:00+08:00' },
    bbb: { project: 'ident', lastSeen: '2026-01-02T00:00:00+08:00' },
  }));
  const ss = new Store(sealDir);
  const keep = crypto.randomBytes(24).toString('hex');
  const sealed = ss.sealUnlockedAgents({ by: 'selfcheck', keys: { bbb: keep } });
  ok('seal 锁上所有未锁条目', sealed.length === 2, `锁了 ${sealed.length} 个`);
  ok('seal 沿用本地已有的 key', sealed.find((s) => s.name === 'bbb')?.adopted === true);
  let sealBlocked = false;
  try { ss.post({ project: 'ident', from: 'aaa', body: '没 key 还想发' }); } catch (e) { sealBlocked = e.code === 'NAME_TAKEN'; }
  ok('seal 之后没 key 用不了', sealBlocked);
  ok('seal 之后沿用 key 的照常能用',
    ss.post({ project: 'ident', from: 'bbb', body: '我有 key', agentKey: keep }).msg.fromId ===
    sealed.find((s) => s.name === 'bbb').id);

  const who = await fetch(api('/api/who')).then((r) => r.json());
  ok('who 里能看到 id 和锁定状态',
    who.agents?.locked_agent?.id === reg.agent.id && who.agents?.locked_agent?.locked === true);
  ok('who 里看不到 key 哈希', who.agents?.locked_agent?.keyHash === undefined);

  const reclaim = await fetch(api('/api/register'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'locked_agent' }),
  }).then((r) => r.json());
  ok('已锁的名字再注册拿不到 key', reclaim.key === null && reclaim.agent?.id === reg.agent.id);
  ok('已锁的名字再注册标记为不可用', reclaim.usable === false);

  const mine = await fetch(api('/api/register'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'locked_agent', key: reg.key }),
  }).then((r) => r.json());
  ok('拿自己的 key 去注册标记为可用', mine.usable === true && mine.key === null);

  // key 丢了重新签发：旧 key 立刻失效，新 key 接上同一个 id
  const reset = await fetch(api('/api/reset-key'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'locked_agent', by: 'selfcheck' }),
  }).then((r) => r.json());
  ok('reset 签发新 key', typeof reset.key === 'string' && reset.key !== reg.key);
  const dead = await post({ project: 'ident', from: 'locked_agent', body: '旧 key', agentKey: reg.key });
  ok('reset 之后旧 key 立刻失效', dead.status === 409, `status=${dead.status}`);
  const rev = await post({ project: 'ident', from: 'locked_agent', body: '新 key', agentKey: reset.key });
  ok('reset 之后新 key 接上同一个 id', rev.status === 200 && rev.data.msg?.fromId === reg.agent.id);
  ok('reset 记了审计日志',
    fs.existsSync(path.join(DIR, '_identity.log')) &&
    fs.readFileSync(path.join(DIR, '_identity.log'), 'utf8').includes('locked_agent'));

  // forget 释放名字，之后重新用会拿到新 id
  await post({ project: 'ident', from: 'tempname', body: '先建一个', agentKey: crypto.randomBytes(24).toString('hex') });
  const fg = await fetch(api('/api/forget'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'tempname', by: 'selfcheck' }),
  }).then((r) => r.json());
  ok('forget 删掉条目并回报原 id', fg.ok === true && /^ag_[0-9a-f]{8}$/.test(String(fg.id)));
  const refg = await post({ project: 'ident', from: 'tempname', body: '重新来一次', agentKey: crypto.randomBytes(24).toString('hex') });
  ok('forget 之后名字能被重新占用，id 是新的', refg.status === 200 && refg.data.msg?.fromId !== fg.id);

  // ---- 9 频道与成员 ----
  console.log('\n频道与成员：建频道、拉人、踢人');
  const mk = await fetch(api('/api/projects'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'teamroom', by: 'locked_agent' }),
  }).then((r) => r.json());
  ok('建频道成功', mk.ok === true && mk.project === 'teamroom');
  const dupProj = await fetch(api('/api/projects'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'teamroom' }),
  });
  ok('重名频道被拒', dupProj.status === 409, `status=${dupProj.status}`);

  const whoAll = await fetch(api('/api/who')).then((r) => r.json());
  const gm = await fetch(api('/api/members?project=general')).then((r) => r.json());
  ok('主频道返回全部 agent',
    gm.main === true && gm.count === Object.keys(whoAll.agents).length,
    `${gm.count} vs ${Object.keys(whoAll.agents).length}`);

  const tm = await fetch(api('/api/members?project=teamroom')).then((r) => r.json());
  ok('新频道里只有建的人', tm.count === 1 && tm.members[0]?.name === 'locked_agent');

  await fetch(api('/api/invite'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ project: 'teamroom', name: 'fresh_agent' }),
  });
  const tm2 = await fetch(api('/api/members?project=teamroom')).then((r) => r.json());
  ok('拉人之后出现在成员里', tm2.count === 2 && tm2.members.some((m) => m.name === 'fresh_agent'));
  ok('被拉进来但没发言的标成未参与',
    tm2.members.find((m) => m.name === 'fresh_agent')?.joined === false);

  const kickMain = await fetch(api('/api/kick'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ project: 'general', name: 'fresh_agent' }),
  });
  // 403 而不是 400：不是参数写错了，是这个操作本身不允许
  ok('主频道不能踢人', kickMain.status === 403, `status=${kickMain.status}`);

  const kicked = await fetch(api('/api/kick'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ project: 'teamroom', name: 'fresh_agent' }),
  });
  ok('普通频道能踢人', kicked.status === 200);
  const tm3 = await fetch(api('/api/members?project=teamroom')).then((r) => r.json());
  ok('踢完之后成员少一个', tm3.count === 1);

  // ---- 10 @ 触发启动命令 ----
  console.log('\n@ 触发：配了命令的名字，被 @ 就拉起来');
  const hookOut = path.join(DIR, 'hook-out.txt');
  fs.writeFileSync(path.join(DIR, 'hooks.json'), JSON.stringify({
    // desktopNotify 是配置项不是 agent。数组也是 object，不排掉的话会出现在
    // hooks 列表里，界面上就多出一个叫 desktopNotify 的假成员。
    desktopNotify: ['hookprobe'],
    hookprobe: {
      command: process.execPath,
      args: ['-e', `require('fs').appendFileSync(${JSON.stringify(hookOut)}, process.env.AGENT_CHAT_MSG_ID + '|' + process.env.AGENT_CHAT_PROJECT + '\\n')`],
      cooldownSec: 3600,
    },
  }, null, 2), 'utf8');

  const hk = await fetch(api('/api/hooks')).then((r) => r.json());
  ok('hooks 配置能读出来',
    hk.exists === true && hk.hooks.length === 1 && hk.hooks[0].name === 'hookprobe');
  ok('desktopNotify 不算一个 agent',
    !hk.hooks.some((h) => h.name === 'desktopNotify'),
    JSON.stringify(hk.hooks.map((h) => h.name)));

  const callerKey = crypto.randomBytes(24).toString('hex');
  await post({ project: 'ident', from: 'caller', body: '@hookprobe 你来看一下', agentKey: callerKey });
  await new Promise((r) => setTimeout(r, 1400));
  const fired = fs.existsSync(hookOut) ? fs.readFileSync(hookOut, 'utf8').trim() : '';
  ok('@ 之后命令被拉起来了', fired.includes('ident'), `输出 ${JSON.stringify(fired)}`);

  const beforeHook = fs.existsSync(hookOut) ? fs.readFileSync(hookOut, 'utf8') : '';
  await post({ project: 'ident', from: 'caller', body: '@hookprobe 再来一条', agentKey: callerKey });
  await new Promise((r) => setTimeout(r, 1000));
  const afterHook = fs.existsSync(hookOut) ? fs.readFileSync(hookOut, 'utf8') : '';
  ok('冷却期内不重复拉起', afterHook === beforeHook);

  const payloadFiles = fs.existsSync(path.join(DIR, '_hook-payload'))
    ? fs.readdirSync(path.join(DIR, '_hook-payload'))
    : [];
  ok('载荷文件写下来了', payloadFiles.length >= 1, `实际 ${payloadFiles.length} 个`);
  if (payloadFiles.length) {
    const pf = JSON.parse(fs.readFileSync(path.join(DIR, '_hook-payload', payloadFiles[0]), 'utf8'));
    ok('载荷里有正文和频道', pf.project === 'ident' && String(pf.body).includes('hookprobe'));
  }

  // 没配命令的名字，@ 了也不该拉起任何东西
  const outBefore = fs.existsSync(hookOut) ? fs.readFileSync(hookOut, 'utf8') : '';
  await post({ project: 'ident', from: 'caller', body: '@nohook 你好', agentKey: callerKey });
  await new Promise((r) => setTimeout(r, 700));
  ok('没配命令的名字不会被拉起',
    (fs.existsSync(hookOut) ? fs.readFileSync(hookOut, 'utf8') : '') === outBefore);

  // ---- 10b 单实例：上一轮没跑完，不重复拉起 ----
  //
  // 冷却只能防连发，防不了「这一轮跑得比冷却久」。两个进程同时读同一个 inbox
  // 会重复回复，所以拉起前要按名字看上一轮是否还活着。
  console.log('\n单实例：上一轮没结束就不拉新的');
  const slowOut = path.join(DIR, 'hook-slow.txt');
  const slowScript = `const fs=require('fs');fs.appendFileSync(${JSON.stringify(slowOut)},'start\\n');setTimeout(()=>{fs.appendFileSync(${JSON.stringify(slowOut)},'end\\n')},2600)`;
  fs.writeFileSync(path.join(DIR, 'hooks.json'), JSON.stringify({
    slowprobe: {
      command: process.execPath,
      args: ['-e', slowScript],
      // 0 就是真的不冷却，正好把单实例这道闸单独露出来
      cooldownSec: 0,
    },
  }, null, 2), 'utf8');

  const startsOf = () => (fs.existsSync(slowOut) ? (fs.readFileSync(slowOut, 'utf8').match(/start/g) || []).length : 0);
  await post({ project: 'ident', from: 'caller', body: '@slowprobe 第一条', agentKey: callerKey });
  await new Promise((r) => setTimeout(r, 700));
  ok('第一条被拉起来了', startsOf() === 1, `start 出现 ${startsOf()} 次`);

  await post({ project: 'ident', from: 'caller', body: '@slowprobe 第二条', agentKey: callerKey });
  await new Promise((r) => setTimeout(r, 700));
  ok('上一轮还在跑，第二条没被拉起', startsOf() === 1, `start 出现 ${startsOf()} 次`);

  const slowLog = fs.existsSync(path.join(DIR, '_hooks.log')) ? fs.readFileSync(path.join(DIR, '_hooks.log'), 'utf8') : '';
  ok('日志里说清了为什么跳过', /slowprobe 上一轮还没结束，跳过/.test(slowLog));

  // 等第一轮真跑完
  await new Promise((r) => setTimeout(r, 2400));
  ok('第一轮跑完了', fs.readFileSync(slowOut, 'utf8').includes('end'));

  await post({ project: 'ident', from: 'caller', body: '@slowprobe 第三条', agentKey: callerKey });
  await new Promise((r) => setTimeout(r, 700));
  ok('上一轮结束后能重新拉起', startsOf() === 2, `start 出现 ${startsOf()} 次`);

  // ---- 11 收件箱已读 ----
  console.log('\n收件箱：未读、标记已读、又来新的');
  const ibKey = crypto.randomBytes(24).toString('hex');
  await post({ project: 'ident', from: 'ibcaller', body: '@ibagent 第一条', agentKey: ibKey });
  await post({ project: 'ident', from: 'ibcaller', body: '@ibagent 第二条', agentKey: ibKey });

  const ib1 = await fetch(api('/api/inbox?agent=ibagent&unread=1')).then((r) => r.json());
  ok('未读能捞到两条 @', ib1.count === 2, `实际 ${ib1.count}`);

  const ibLast = ib1.messages[ib1.messages.length - 1];
  await fetch(api('/api/inbox/ack'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ agent: 'ibagent', lastId: ibLast.id, lastTs: ibLast.ts }),
  });
  const ib2 = await fetch(api('/api/inbox?agent=ibagent&unread=1')).then((r) => r.json());
  ok('标记之后未读清空', ib2.count === 0, `实际 ${ib2.count}`);

  const ib3 = await fetch(api('/api/inbox?agent=ibagent')).then((r) => r.json());
  ok('全部模式还能看到那两条', ib3.count === 2, `实际 ${ib3.count}`);

  await post({ project: 'ident', from: 'ibcaller', body: '@ibagent 第三条', agentKey: ibKey });
  const ib4 = await fetch(api('/api/inbox?agent=ibagent&unread=1')).then((r) => r.json());
  ok('新来的一条又变成未读', ib4.count === 1 && String(ib4.messages[0].body).includes('第三条'));

  // ---- 12 @全体成员 和文件路径引用 ----
  console.log('\n@全体成员：展开成所有人；文件路径引用');
  const allKey = crypto.randomBytes(24).toString('hex');

  // @全体成员 展开的是这个频道的成员，不是整个注册表。
  // 拿频道成员和展开结果对，另外单独验一条：别的频道的人不能被喊到。
  const identMembers = (await fetch(api('/api/members?project=ident')).then((r) => r.json())).members
    .map((m) => m.name).sort();

  const allMsg = (await post({
    project: 'ident',
    from: 'allcaller',
    body: '@全体成员 都看一下 D:/work/a.mjs:120 这里',
    agentKey: allKey,
  })).data.msg;
  const allMentions = (allMsg.mentions || []).slice().sort();
  ok('@全体成员 标记成全体', allMsg.mentionsAll === true);
  ok('@全体成员 展开成这个频道的人',
    allMentions.length > 0 && allMentions.every((n) => identMembers.includes(n)),
    `展开 ${allMentions.length} 个（${allMentions.join(',')}），频道 ${identMembers.length} 人`);
  ok('@全体成员 不把「全体成员」本身当名字', !allMentions.includes('全体成员'));

  // 另建一个频道，放两个人进去，在这个频道里 @全体成员 不能喊到 ident 的人
  await fetch(api('/api/projects'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'otherch', by: 'other1' }),
  });
  const key1 = crypto.randomBytes(24).toString('hex');
  const key2 = crypto.randomBytes(24).toString('hex');
  await post({ project: 'otherch', from: 'other1', body: '我在别的频道', agentKey: key1 });
  await post({ project: 'otherch', from: 'other2', body: '我也在', agentKey: key2 });

  const otherAll = (await post({
    project: 'otherch',
    from: 'other1',
    body: '@全体成员 这个频道的人都看下',
    agentKey: key1,
  })).data.msg;
  ok('别的频道 @全体成员 只喊本频道',
    JSON.stringify((otherAll.mentions || []).slice().sort()) === JSON.stringify(['other2']),
    JSON.stringify(otherAll.mentions));
  ok('别的频道 @全体成员 不喊 ident 的人',
    !(otherAll.mentions || []).some((n) => n === 'allcaller' || n === 'ibagent'),
    JSON.stringify(otherAll.mentions));

  const identInbox = await fetch(api('/api/inbox?agent=ibagent&unread=1')).then((r) => r.json());
  ok('跨频道的全体消息不会进 ident 的收件箱',
    !(identInbox.messages || []).some((m) => m.project === 'otherch'),
    `共 ${identInbox.count} 条`);

  ok('文件路径被解析出来', Array.isArray(allMsg.files) && allMsg.files.length === 1,
    JSON.stringify(allMsg.files));
  ok('路径和行号分开存', allMsg.files?.[0]?.path === 'D:/work/a.mjs' && allMsg.files?.[0]?.line === 120,
    JSON.stringify(allMsg.files?.[0]));

  const bs = (await post({ project: 'ident', from: 'allcaller', body: '反斜杠 D:\\work\\b.mjs 也行', agentKey: allKey })).data.msg;
  ok('反斜杠路径认', bs.files?.[0]?.path === 'D:\\work\\b.mjs', JSON.stringify(bs.files));

  const punc = (await post({ project: 'ident', from: 'allcaller', body: '看 D:/work/c.mjs，还有 D:/work/d.mjs。', agentKey: allKey })).data.msg;
  ok('尾部中文标点被剥掉',
    punc.files?.length === 2 && punc.files[0].path === 'D:/work/c.mjs' && punc.files[1].path === 'D:/work/d.mjs',
    JSON.stringify(punc.files?.map((f) => f.path)));

  const range = (await post({ project: 'ident', from: 'allcaller', body: 'D:/work/e.mjs:10-20', agentKey: allKey })).data.msg;
  ok('行号区间认', range.files?.[0]?.line === 10 && range.files?.[0]?.lineEnd === 20,
    JSON.stringify(range.files?.[0]));

  const rel = (await post({ project: 'ident', from: 'allcaller', body: '相对路径 src/store.mjs 不算', agentKey: allKey })).data.msg;
  ok('相对路径不当文件引用', Array.isArray(rel.files) && rel.files.length === 0);

  const bare = (await post({ project: 'ident', from: 'allcaller', body: '@全体 单独写不算全体', agentKey: allKey })).data.msg;
  ok('@全体 不是合法收件人，最终按漏写规则回落全体',
    bare.body === '@全体成员 @全体 单独写不算全体' && bare.mentionsAll === true,
    JSON.stringify({ body: bare.body, mentionsAll: bare.mentionsAll }));
  ok('@全体 也不当成人名', !(bare.mentions || []).includes('全体'));

  // 保留字不能被注册成名字
  const reserved = await post({ project: 'ident', from: 'all', body: '我想叫 all', agentKey: crypto.randomBytes(24).toString('hex') });
  ok('all 是保留字，注册被拒', reserved.data.code === 'NAME_RESERVED', `code=${reserved.data.code}`);

  // @全体成员 展开的是注册表里的人（发过言或被注册过的）。
  // 从没露过面的名字不在注册表里，也就不会被喊到，这里一并钉住。
  const inboxCaller = await fetch(api('/api/inbox?agent=caller&unread=1')).then((r) => r.json());
  ok('@全体成员 进到别人的未读里',
    inboxCaller.messages?.some((m) => m.mentionsAll === true),
    `共 ${inboxCaller.count} 条：${JSON.stringify((inboxCaller.messages || []).map((m) => [m.from, String(m.body).slice(0, 20), m.mentionsAll]))}`);
  ok('从没露过面的名字不在全体里', !allMentions.includes('ibagent'));

  // ---- 13 收件人兜底 ----
  console.log('\n收件人规则：回复自动 @ 原发送者；漏写 @ 自动通知本频道全体');
  const rrAliceKey = crypto.randomBytes(24).toString('hex');
  const rrBobKey = crypto.randomBytes(24).toString('hex');
  const rrCarolKey = crypto.randomBytes(24).toString('hex');

  const rrBase = (await post({
    project: 'recipient-rules', from: 'rr-alice', body: '@rr-bob 请看基础消息', agentKey: rrAliceKey,
  })).data.msg;
  await post({
    project: 'recipient-rules', from: 'rr-bob', body: '@rr-alice 我已加入', agentKey: rrBobKey,
  });
  await post({
    project: 'recipient-rules', from: 'rr-carol', body: '@rr-alice 我也加入', agentKey: rrCarolKey,
  });
  const recipientRulesFile = path.join(DIR, 'recipient-rules.jsonl');
  const historicalPrefix = fs.readFileSync(recipientRulesFile, 'utf8');

  const directed = (await post({
    project: 'recipient-rules', from: 'rr-alice', body: '@rr-bob 只给 Bob', agentKey: rrAliceKey,
  })).data.msg;
  ok('明确 @ 一人时不扩散',
    JSON.stringify(directed.mentions) === JSON.stringify(['rr-bob']) && directed.mentionsAll === false,
    JSON.stringify({ body: directed.body, mentions: directed.mentions, mentionsAll: directed.mentionsAll }));

  const autoReply = (await post({
    project: 'recipient-rules', from: 'rr-bob', body: '收到', replyTo: rrBase.id, agentKey: rrBobKey,
  })).data.msg;
  ok('回复漏写 @ 时自动补原发送者',
    autoReply.body === '@rr-alice 收到' && JSON.stringify(autoReply.mentions) === JSON.stringify(['rr-alice']),
    JSON.stringify({ body: autoReply.body, mentions: autoReply.mentions }));

  const namedReply = (await post({
    project: 'recipient-rules', from: 'rr-bob', body: '@rr-alice 已经写了', replyTo: rrBase.id, agentKey: rrBobKey,
  })).data.msg;
  ok('回复已有原发送者时不重复补 @',
    namedReply.body === '@rr-alice 已经写了' && JSON.stringify(namedReply.mentions) === JSON.stringify(['rr-alice']),
    JSON.stringify({ body: namedReply.body, mentions: namedReply.mentions }));

  const fallback = (await post({
    project: 'recipient-rules', from: 'rr-alice', body: '漏写收件人', agentKey: rrAliceKey,
  })).data.msg;
  ok('新消息漏写 @ 时自动补全体成员', fallback.body === '@全体成员 漏写收件人' && fallback.mentionsAll === true,
    JSON.stringify({ body: fallback.body, mentionsAll: fallback.mentionsAll }));
  ok('自动全体只含本频道其他成员',
    JSON.stringify((fallback.mentions || []).slice().sort()) === JSON.stringify(['rr-bob', 'rr-carol']),
    JSON.stringify(fallback.mentions));
  ok('自动全体排除发送者', !(fallback.mentions || []).includes('rr-alice'), JSON.stringify(fallback.mentions));

  const missingReply = (await post({
    project: 'recipient-rules', from: 'rr-alice', body: '引用不存在', replyTo: 'missing-message-id', agentKey: rrAliceKey,
  })).data.msg;
  ok('不存在的 replyTo 不会虚构收件人而是回落全体',
    missingReply.body === '@全体成员 引用不存在' && missingReply.mentionsAll === true,
    JSON.stringify({ body: missingReply.body, mentions: missingReply.mentions }));

  const otherChannelBase = (await post({
    project: 'recipient-other', from: 'rr-outsider', body: '@rr-alice 另一频道',
    agentKey: crypto.randomBytes(24).toString('hex'),
  })).data.msg;
  const crossReply = (await post({
    project: 'recipient-rules', from: 'rr-bob', body: '跨频道引用', replyTo: otherChannelBase.id, agentKey: rrBobKey,
  })).data.msg;
  ok('跨频道 replyTo 不会 @ 另一频道发送者',
    crossReply.body === '@全体成员 跨频道引用' && !(crossReply.mentions || []).includes('rr-outsider'),
    JSON.stringify({ body: crossReply.body, mentions: crossReply.mentions }));

  const selfBase = (await post({
    project: 'recipient-rules', from: 'rr-alice', body: '@rr-bob 自己的原消息', agentKey: rrAliceKey,
  })).data.msg;
  const selfReply = (await post({
    project: 'recipient-rules', from: 'rr-alice', body: '回复自己', replyTo: selfBase.id, agentKey: rrAliceKey,
  })).data.msg;
  ok('回复自己的消息不会 @ 自己而是回落全体',
    selfReply.body === '@全体成员 回复自己' && !(selfReply.mentions || []).includes('rr-alice'),
    JSON.stringify({ body: selfReply.body, mentions: selfReply.mentions }));
  ok('启用新规则后不会改写既有消息',
    fs.readFileSync(recipientRulesFile, 'utf8').startsWith(historicalPrefix));

  const solo = (await post({
    project: 'recipient-solo', from: 'rr-solo', body: '单人频道消息', agentKey: crypto.randomBytes(24).toString('hex'),
  })).data.msg;
  ok('单人频道也补全体标记但不会 @ 自己',
    solo.body === '@全体成员 单人频道消息' && solo.mentionsAll === true && solo.mentions.length === 0,
    JSON.stringify({ body: solo.body, mentions: solo.mentions, mentionsAll: solo.mentionsAll }));

  // ---- 14 频道绑项目 ----
  console.log('\n频道绑项目：建的时候带目录和说明');
  const dirs = await fetch(api('/api/agents-projects')).then((r) => r.json());
  ok('/api/agents-projects 能列项目', Array.isArray(dirs.projects) && dirs.projects.length >= 0,
    `根 ${dirs.root}，${dirs.projects?.length || 0} 个`);

  // 绑一个真实存在的项目目录名（不一定真的在这个根下，元数据只记名字）
  const bound = await fetch(api('/api/projects'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'boundch', by: 'diruser', dir: 'lumedit', note: '修图软件那个项目' }),
  }).then((r) => r.json());
  ok('建频道时能带项目和说明', bound.meta?.dir === 'lumedit' && bound.meta?.note === '修图软件那个项目',
    JSON.stringify(bound.meta));

  const plist = await fetch(api('/api/projects')).then((r) => r.json());
  const boundInList = plist.projects.find((p) => p.name === 'boundch');
  ok('频道列表带回绑定信息', boundInList?.dir === 'lumedit' && boundInList?.note === '修图软件那个项目',
    JSON.stringify({ dir: boundInList?.dir, note: boundInList?.note }));

  // 没绑的频道不该有这些字段的值
  const plainCh = plist.projects.find((p) => p.name === 'ident');
  ok('没绑的频道是空的', !plainCh?.dir && !plainCh?.note, JSON.stringify({ dir: plainCh?.dir, note: plainCh?.note }));

  // 后改绑定
  const rebind = await fetch(api('/api/channel-meta'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ project: 'boundch', dir: 'website', note: '改成网站那个了' }),
  }).then((r) => r.json());
  ok('能给已有频道改绑', rebind.meta?.dir === 'website' && rebind.meta?.note === '改成网站那个了',
    JSON.stringify(rebind.meta));

  // 解绑
  const unbind = await fetch(api('/api/channel-meta'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ project: 'boundch', dir: null }),
  }).then((r) => r.json());
  ok('能解绑', unbind.meta?.dir === null, JSON.stringify(unbind.meta));

  // 目录名不合法要拒掉
  const badDir = await fetch(api('/api/channel-meta'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ project: 'boundch', dir: '../../etc' }),
  });
  ok('非法目录名被拒', badDir.status === 400, `status=${badDir.status}`);

  // 元数据要落盘，服务重启后还在
  const channelsFile = path.join(DIR, 'channels.json');
  ok('绑定信息落盘了', fs.existsSync(channelsFile), channelsFile);

  // ---- 14 频道改名 ----
  //
  // 名字散在四个地方：jsonl 文件名、每条消息的 project 字段、channels.json 的键、
  // 成员关系和游标。改完要挨个查，漏一处就会出现「收件箱里还有旧频道」这种事。
  console.log('\n频道改名：文件、消息、成员、游标一起迁');
  const rk = crypto.randomBytes(24).toString('hex');
  await post({ project: 'boundch', from: 'renuser', body: '改名之前说一句', agentKey: rk });
  await post({ project: 'boundch', from: 'renuser', body: '再说一句', agentKey: rk });

  const before = await fetch(api('/api/messages?project=boundch')).then((r) => r.json());
  const lastId = before.messages[before.messages.length - 1].id;
  // 游标也设一个，看改名会不会跟着走
  await fetch(api('/api/cursor'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ agent: 'renuser', project: 'boundch', lastId }),
  });

  const ren = await fetch(api('/api/rename-project'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ from: 'boundch', to: 'renamed' }),
  }).then((r) => r.json());
  ok('改名接口通', ren.ok === true && ren.project === 'renamed', JSON.stringify(ren));
  ok('旧文件没了', !fs.existsSync(path.join(DIR, 'boundch.jsonl')));
  ok('新文件在', fs.existsSync(path.join(DIR, 'renamed.jsonl')));

  const afterMsgs = await fetch(api('/api/messages?project=renamed')).then((r) => r.json());
  ok('消息跟着过去了', afterMsgs.count === 2, `count=${afterMsgs.count}`);
  ok('消息里的 project 字段改成新名', afterMsgs.messages.every((m) => m.project === 'renamed'),
    JSON.stringify(afterMsgs.messages.map((m) => m.project)));

  const renList = await fetch(api('/api/projects')).then((r) => r.json());
  ok('频道列表里是新名', renList.projects.some((p) => p.name === 'renamed')
    && !renList.projects.some((p) => p.name === 'boundch'));
  ok('改名把绑定信息带过去',
    renList.projects.find((p) => p.name === 'renamed')?.dir === null,
    JSON.stringify(renList.projects.find((p) => p.name === 'renamed')));

  const renMembers = await fetch(api('/api/members?project=renamed')).then((r) => r.json());
  ok('成员关系跟到新频道', renMembers.members.some((m) => m.name === 'renuser'),
    JSON.stringify(renMembers.members.map((m) => m.name)));

  const renCursor = await fetch(api('/api/cursor?agent=renuser')).then((r) => r.json());
  ok('游标键换成新名', renCursor.cursor?.renamed?.lastId === lastId
    && !('boundch' in (renCursor.cursor || {})),
    JSON.stringify(Object.keys(renCursor.cursor || {})));

  const renTo = await fetch(api('/api/rename-project'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ from: 'renamed', to: 'ident' }),
  });
  ok('改成已存在的名字被拒', renTo.status === 409, `status=${renTo.status}`);

  const renMain = await fetch(api('/api/rename-project'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ from: 'general', to: 'main' }),
  });
  ok('general 不给改名', renMain.status === 403, `status=${renMain.status}`);

  const renMissing = await fetch(api('/api/rename-project'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ from: 'nosuchchannel', to: 'whatever' }),
  });
  ok('改不存在的频道报 404', renMissing.status === 404, `status=${renMissing.status}`);

  // ---- 15 删频道 ----
  console.log('\n删频道：消息挪到 _deleted 留底，成员和游标清干净');
  const del = await fetch(api('/api/delete-project'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ project: 'renamed' }),
  }).then((r) => r.json());
  ok('删除接口通', del.ok === true && del.deleted === true, JSON.stringify(del));
  ok('消息条数报对了', del.count === 2, `count=${del.count}`);
  ok('频道文件挪走了', !fs.existsSync(path.join(DIR, 'renamed.jsonl')));
  ok('留底文件在 _deleted 里', !!del.archived && fs.existsSync(del.archived), del.archived);
  ok('留底文件里消息没丢',
    !!del.archived && fs.readFileSync(del.archived, 'utf8').split('\n').filter(Boolean).length === 2);

  const delList = await fetch(api('/api/projects')).then((r) => r.json());
  ok('频道列表里没了', !delList.projects.some((p) => p.name === 'renamed'));
  ok('成员关系也清了', !(delList.agents.renuser?.projects || []).includes('renamed'),
    JSON.stringify(delList.agents.renuser?.projects));

  const delCursor = await fetch(api('/api/cursor?agent=renuser')).then((r) => r.json());
  ok('游标里的键清掉了', !('renamed' in (delCursor.cursor || {})),
    JSON.stringify(Object.keys(delCursor.cursor || {})));

  const delMain = await fetch(api('/api/delete-project'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ project: 'general' }),
  });
  ok('general 不给删', delMain.status === 403, `status=${delMain.status}`);

  const delMissing = await fetch(api('/api/delete-project'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ project: 'nosuchchannel' }),
  });
  ok('删不存在的频道报 404', delMissing.status === 404, `status=${delMissing.status}`);

  // 同名重建不该带着旧成员
  const rebuild = await fetch(api('/api/projects'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'renamed' }),
  }).then((r) => r.json());
  const rebuildMembers = await fetch(api('/api/members?project=renamed')).then((r) => r.json());
  ok('同名重建不带旧成员', rebuild.ok === true
    && !rebuildMembers.members.some((m) => m.name === 'renuser'),
    JSON.stringify(rebuildMembers.members.map((m) => m.name)));

  // ---- 16 界面的 key 存在数据目录里 ----
  //
  // 界面原来只把 key 存 localStorage，那是按 origin 分的，端口一变（7788 被占就换 7789）
  // 就是另一份存储，换安装目录 userData 变了也一样。表现是每次重进都要重新接管名字。
  // 现在 key 存数据目录，界面读不到本地缓存就问服务端要。
  console.log('\n界面身份：key 存数据目录，不靠 localStorage');
  const uiKey = 'f'.repeat(48);
  const lockUi = await post({ project: 'general', from: 'uikeyuser', body: '占个名字', agentKey: uiKey });
  ok('先把名字锁上', lockUi.status === 200, `status=${lockUi.status}`);

  const noKeyYet = await fetch(api('/api/key?name=uikeyuser')).then((r) => r.json());
  ok('还没存时读到 null', noKeyYet.key === null, JSON.stringify(noKeyYet));

  const putKey = await fetch(api('/api/key'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'uikeyuser', key: uiKey }),
  }).then((r) => r.json());
  ok('能写进数据目录', putKey.saved === true, JSON.stringify(putKey));

  const gotKey = await fetch(api('/api/key?name=uikeyuser')).then((r) => r.json());
  ok('能原样读回来', gotKey.key === uiKey, JSON.stringify(gotKey));
  ok('落的是 .agents 下的文件',
    fs.existsSync(path.join(DIR, '.agents', 'uikeyuser.key')));

  const keyBadName = await fetch(api('/api/key?name=' + encodeURIComponent('../etc'))).then((r) => r.status);
  ok('非法名字被拒', keyBadName === 400, `status=${keyBadName}`);

  // 读回来的 key 拿去发言，应该通
  const useKey = await post({ project: 'general', from: 'uikeyuser', body: '用数据目录里那把 key', agentKey: gotKey.key });
  ok('读回来的 key 真能用', useKey.status === 200, `status=${useKey.status}`);

  // ---- 17 项目清单里的总结份数 ----
  //
  // 这里踩过一次：原来只认 总结/PROJECT-SUMMARY.md，而实际 11 个项目里只有 lumedit
  // 用了这个统一文件名，其余叫「说明书01-xxx.md」。结果界面上十个项目全标「没写总结」，
  // 明明都有内容。改成数目录里的文件，另外单独标出有没有那份统一的。
  console.log('\n项目清单：总结要数份数，不能只看有没有 PROJECT-SUMMARY.md');
  const agRoot = path.join(DIR, 'fakeagents');
  const mkSummary = (proj, files) => {
    const d = path.join(agRoot, proj, '总结');
    fs.mkdirSync(d, { recursive: true });
    for (const f of files) fs.writeFileSync(path.join(d, f), 'x');
  };
  mkSummary('withsum', ['PROJECT-SUMMARY.md', '说明书01-a.md']);
  mkSummary('loose', ['说明书01-a.md', '00-经验总结.txt']);
  mkSummary('emptydir', []);
  fs.mkdirSync(path.join(agRoot, 'nodir'), { recursive: true });

  process.env.AGENT_CHAT_AGENTS_DIR = agRoot;
  const fakeDirs = await fetch(api('/api/agents-projects')).then((r) => r.json());
  delete process.env.AGENT_CHAT_AGENTS_DIR;

  const byName = Object.fromEntries(fakeDirs.projects.map((p) => [p.name, p]));
  ok('有统一那份的同时报出份数',
    byName.withsum?.hasSummary === true && byName.withsum?.summaryCount === 2,
    JSON.stringify(byName.withsum));
  ok('零散总结数份数，hasSummary 为假',
    byName.loose?.hasSummary === false && byName.loose?.summaryCount === 2,
    JSON.stringify(byName.loose));
  ok('空的总结目录算 0', byName.emptydir?.summaryCount === 0, JSON.stringify(byName.emptydir));
  ok('没有总结目录也算 0', byName.nodir?.summaryCount === 0, JSON.stringify(byName.nodir));

  const appearanceModuleResponse = await fetch(api('/appearance.mjs'));
  ok('浏览器模块使用 JavaScript MIME', appearanceModuleResponse.status === 200
    && String(appearanceModuleResponse.headers.get('content-type')).startsWith('text/javascript'),
    `status=${appearanceModuleResponse.status} type=${appearanceModuleResponse.headers.get('content-type')}`);

  await s1.close();
  ok('关掉之后运行时文件清干净', !fs.existsSync(path.join(DIR, '_runtime.json')));
  ok('关掉之后锁也清了', !fs.existsSync(path.join(DIR, '_server.lock')));

  // ---- 18 桌面设置：默认、校验、原子落盘 ----
  console.log('\n桌面设置：默认、校验、原子落盘');
  let settingsMod = null;
  try { settingsMod = await import('../electron/app-settings.mjs'); } catch {}
  ok('设置控制器模块存在', !!settingsMod);
  if (settingsMod) {
    const settingsDir = path.join(DIR, 'app-user-data');
    const ctl = settingsMod.createAppSettings({ dir: settingsDir });
    const initial = ctl.snapshot();
    ok('首次启动使用安全默认值', initial.closeAction === 'ask'
      && initial.appearance?.mode === 'system'
      && initial.appearance?.accent === '#2563EB'
      && initial.appearance?.font === 'system', JSON.stringify(initial));
    ok('读取默认值不会提前创建文件', !fs.existsSync(path.join(settingsDir, 'app-settings.json')));

    for (const action of ['ask', 'tray', 'quit']) {
      ctl.update({ closeAction: action });
      ok(`关闭行为 ${action} 可保存`, ctl.snapshot().closeAction === action);
    }
    ok('保存后设置文件存在', fs.existsSync(path.join(settingsDir, 'app-settings.json')));
    ok('原子写临时文件没有残留', !fs.existsSync(path.join(settingsDir, 'app-settings.json.tmp')));

    ctl.update({
      appearance: {
        mode: 'custom', accent: '#FF6600', background: '#000000', foreground: '#757575', font: 'microsoft-yahei',
      },
    });
    const reopened = settingsMod.createAppSettings({ dir: settingsDir }).snapshot();
    ok('重开控制器能读回完整外观', reopened.appearance.mode === 'custom'
      && reopened.appearance.accent === '#FF6600'
      && reopened.appearance.background === '#000000'
      && reopened.appearance.foreground === '#757575'
      && reopened.appearance.font === 'microsoft-yahei', JSON.stringify(reopened));
    ok('黑白对比度是 21', Math.abs(settingsMod.contrastRatio('#000000', '#FFFFFF') - 21) < 0.001);

    const beforeBad = JSON.stringify(ctl.snapshot());
    const badPatches = [
      { closeAction: 'hide' },
      { appearance: { ...ctl.snapshot().appearance, accent: 'blue' } },
      { appearance: { ...ctl.snapshot().appearance, font: 'comic-sans' } },
      { appearance: { mode: 'custom', accent: '#2563EB', background: '#777777', foreground: '#777778', font: 'system' } },
    ];
    for (const bad of badPatches) {
      let rejected = false;
      try { ctl.update(bad); } catch { rejected = true; }
      ok('非法设置被拒绝', rejected);
      ok('拒绝后内存状态不变', JSON.stringify(ctl.snapshot()) === beforeBad);
    }

    const mixedDir = path.join(DIR, 'mixed-user-data');
    fs.mkdirSync(mixedDir, { recursive: true });
    fs.writeFileSync(path.join(mixedDir, 'app-settings.json'), JSON.stringify({
      closeAction: 'tray',
      appearance: { mode: 'dark', accent: '坏颜色', background: '#101010', foreground: '#F0F0F0', font: 'segoe-ui' },
    }));
    const mixed = settingsMod.createAppSettings({ dir: mixedDir }).snapshot();
    ok('损坏配置只回退坏字段', mixed.closeAction === 'tray'
      && mixed.appearance.mode === 'dark'
      && mixed.appearance.accent === '#2563EB'
      && mixed.appearance.background === '#101010'
      && mixed.appearance.foreground === '#F0F0F0'
      && mixed.appearance.font === 'segoe-ui', JSON.stringify(mixed));

    console.log('\n桌面设置接口：可用与不可用路径');
    const settingsApiDir = path.join(DIR, 'settings-api-data');
    const settingsApiCtl = settingsMod.createAppSettings({ dir: path.join(DIR, 'settings-api-user') });
    const settingsServer = await startServer({
      dir: settingsApiDir, port: PORT + 20, host: HOST, reuse: false, onLog: () => {}, appSettings: settingsApiCtl,
    });
    const settingsBase = `http://${HOST}:${settingsServer.port}`;
    const getSettings = await fetch(settingsBase + '/api/app-settings');
    const getSettingsJson = await getSettings.json();
    ok('桌面壳设置接口标记为可用', getSettings.status === 200 && getSettingsJson.available === true,
      `status=${getSettings.status} ${JSON.stringify(getSettingsJson)}`);

    const savedSettingsRes = await fetch(settingsBase + '/api/app-settings', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ closeAction: 'tray' }),
    });
    const savedSettings = await savedSettingsRes.json();
    ok('接口能保存关闭行为', savedSettingsRes.status === 200 && savedSettings.closeAction === 'tray');

    const savedAppearanceRes = await fetch(settingsBase + '/api/app-settings', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        appearance: { mode: 'light', accent: '#7C3AED', background: '#F6F7F9', foreground: '#1C1F24', font: 'segoe-ui' },
      }),
    });
    const savedAppearance = await savedAppearanceRes.json();
    ok('接口能保存完整外观', savedAppearanceRes.status === 200
      && savedAppearance.appearance?.mode === 'light'
      && savedAppearance.appearance?.accent === '#7C3AED', JSON.stringify(savedAppearance));

    const beforeInvalidApi = JSON.stringify(settingsApiCtl.snapshot());
    const invalidSettingsRes = await fetch(settingsBase + '/api/app-settings', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        appearance: { mode: 'custom', accent: '#2563EB', background: '#777777', foreground: '#777778', font: 'system' },
      }),
    });
    ok('接口拒绝低对比度外观', invalidSettingsRes.status === 400, `status=${invalidSettingsRes.status}`);
    ok('接口拒绝后设置不变', JSON.stringify(settingsApiCtl.snapshot()) === beforeInvalidApi);
    await settingsServer.close();

    const bareDir = path.join(DIR, 'bare-settings-api');
    const bareServer = await startServer({ dir: bareDir, port: PORT + 21, host: HOST, reuse: false, onLog: () => {} });
    const bareBase = `http://${HOST}:${bareServer.port}`;
    const bareGet = await fetch(bareBase + '/api/app-settings');
    const bareGetJson = await bareGet.json();
    ok('独立服务明确设置不可用', bareGet.status === 200 && bareGetJson.available === false
      && bareGetJson.closeAction === 'ask', `status=${bareGet.status} ${JSON.stringify(bareGetJson)}`);
    const barePost = await fetch(bareBase + '/api/app-settings', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ closeAction: 'quit' }),
    });
    ok('独立服务不伪装已保存', barePost.status === 400, `status=${barePost.status}`);
    await bareServer.close();
  }

  // ---- 19 窗口关闭策略：显式退出、托盘兜底 ----
  console.log('\n窗口关闭策略：显式退出、托盘兜底');
  let lifecycleMod = null;
  try { lifecycleMod = await import('../electron/window-lifecycle.mjs'); } catch {}
  ok('窗口生命周期模块存在', !!lifecycleMod);
  if (lifecycleMod) {
    const resolve = lifecycleMod.resolveCloseAction;
    ok('显式退出永远直接退出', ['ask', 'tray', 'quit', 'bad'].every((preference) =>
      resolve({ preference, explicitQuit: true, trayAvailable: true }) === 'quit'));
    ok('询问模式保持询问', resolve({ preference: 'ask', explicitQuit: false, trayAvailable: true }) === 'ask');
    ok('退出模式保持退出', resolve({ preference: 'quit', explicitQuit: false, trayAvailable: true }) === 'quit');
    ok('托盘可用时可以隐藏', resolve({ preference: 'tray', explicitQuit: false, trayAvailable: true }) === 'tray');
    ok('托盘不可用时回落询问', resolve({ preference: 'tray', explicitQuit: false, trayAvailable: false }) === 'ask');
    ok('未知行为回落询问', resolve({ preference: 'unknown', explicitQuit: false, trayAvailable: true }) === 'ask');
  }

  // ---- 20 外观计算：模式、字体、颜色、对比度 ----
  console.log('\n外观计算：模式、字体、颜色、对比度');
  let appearanceMod = null;
  try { appearanceMod = await import('../ui/appearance.mjs'); } catch {}
  ok('外观计算模块存在', !!appearanceMod);
  if (appearanceMod) {
    const baseAppearance = {
      mode: 'system', accent: '#2563eb', background: '#0d0f13', foreground: '#e6e8eb', font: 'system',
    };
    const systemLight = appearanceMod.appearanceToCss(baseAppearance, { systemDark: false });
    const systemDark = appearanceMod.appearanceToCss(baseAppearance, { systemDark: true });
    ok('跟随系统能解析浅色', systemLight.theme === 'light' && systemLight.vars['--bg'] === '#F6F7F9');
    ok('跟随系统能解析深色', systemDark.theme === 'dark' && systemDark.vars['--bg'] === '#0D0F13');
    ok('明确浅色不受系统深色影响',
      appearanceMod.appearanceToCss({ ...baseAppearance, mode: 'light' }, { systemDark: true }).theme === 'light');
    ok('明确深色不受系统浅色影响',
      appearanceMod.appearanceToCss({ ...baseAppearance, mode: 'dark' }, { systemDark: false }).theme === 'dark');

    const custom = appearanceMod.appearanceToCss({
      mode: 'custom', accent: '#ff6600', background: '#101820', foreground: '#f2f2f2', font: 'microsoft-yahei',
    });
    ok('自定义颜色规范成大写并写进变量', custom.theme === 'custom'
      && custom.vars['--accent'] === '#FF6600'
      && custom.vars['--bg'] === '#101820'
      && custom.vars['--text'] === '#F2F2F2', JSON.stringify(custom));
    ok('微软雅黑映射到固定字体栈', custom.fontFamily === '"Microsoft YaHei", "Segoe UI", sans-serif');
    ok('Segoe UI 映射到固定字体栈', appearanceMod.appearanceToCss({ ...baseAppearance, font: 'segoe-ui' }).fontFamily
      === '"Segoe UI", "Microsoft YaHei", sans-serif');
    ok('系统字体映射包含平台回退', systemLight.fontFamily
      === '-apple-system, "Segoe UI", "Microsoft YaHei", sans-serif');
    ok('外观模块黑白对比度是 21', Math.abs(appearanceMod.contrastRatio('#000000', '#ffffff') - 21) < 0.001);
    ok('相近颜色对比度低于 4.5', appearanceMod.contrastRatio('#777777', '#777778') < 4.5);
  }

  rmrf(DIR);

  console.log(`\n通过 ${pass}，失败 ${fail}`);
  if (fail) {
    console.log('失败项：');
    for (const f of fails) console.log('  - ' + f);
    process.exit(1);
  }
  console.log('全部通过');
}

main().catch((e) => {
  console.error('自检自己崩了：', e);
  process.exit(1);
});
