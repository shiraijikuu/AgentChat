// 端到端：起一个独立数据目录的 AgentChat 服务，真发消息、真走 HTTP，
// 验「写入时算 files / 读时装饰 / 落盘契约」在真实服务里成立，而不只是在单元测试里。
//
// 与 parse_files.test.mjs 的分工：那个测 parseFileRefs 的纯函数行为；
// 这个测服务边界 —— jsonl 里到底落了什么、HTTP 读回来是什么形状。
//
// 用完自己关服务、自己删数据目录。端口用 7799，不碰在跑的 7788。

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const PORT = Number(process.env.AC_E2E_PORT || 7799);
const BASE = `http://127.0.0.1:${PORT}`;

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-e2e-'));
const out = [];
const log = (s) => { out.push(s); console.log(s); };

const fails = [];
function check(cond, label, detail) {
  if (cond) { log(`  ok   ${label}`); return true; }
  fails.push(`${label}${detail ? `\n      ${detail}` : ''}`);
  log(`  FAIL ${label}${detail ? `\n      ${detail}` : ''}`);
  return false;
}

async function api(method, p, body, key) {
  const headers = { 'content-type': 'application/json' };
  if (key) headers.authorization = `Bearer ${key}`;
  const r = await fetch(BASE + p, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: r.status, json, text };
}

// 起服务
const srv = spawn(process.execPath, [path.join(ROOT, 'src', 'standalone.mjs')], {
  cwd: ROOT,
  env: { ...process.env, AGENT_CHAT_DIR: dataDir, AGENT_CHAT_PORT: String(PORT), AGENT_CHAT_HOST: '127.0.0.1' },
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
});
const srvErr = [];
srv.stderr.on('data', (c) => srvErr.push(String(c)));

async function waitUp() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`${BASE}/api/who`);
      if (r.ok) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

function cleanup() {
  try { srv.kill(); } catch {}
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
}

try {
  if (!await waitUp()) {
    console.error(`服务没起来，stderr：\n${srvErr.join('')}`);
    cleanup();
    process.exit(1);
  }
  log(`服务已起 ${BASE}，数据目录 ${dataDir}`);

  const reg = async (name) => {
    const r = await api('POST', '/api/register', { name });
    if (r.status !== 200) throw new Error(`注册 ${name} 失败：${r.status} ${r.text}`);
    return r.json.key;
  };
  const kAuthor = await reg('author');
  const kReader = await reg('reader');

  // ── 1. 落盘契约：正文里的文件引用写进 jsonl 的 files / fileCandidates ──
  log('\n[1] 落盘契约');
  const body1 = '看 `E:\\codex\\AgentChat\\src\\store.mjs:166` 和 E:\\codex\\AgentChat\\ui\\index.html 还有 E:\\codex\\AgentChat\\test\\a.mjs里，别漏 https://example.com/x.txt';
  const p1 = await api('POST', '/api/post', {
    project: 'general', from: 'author', type: 'ask', body: body1,
    agentKey: kAuthor,
  }, kAuthor);
  check(p1.status === 200, '发消息 200', `${p1.status} ${p1.text}`);
  // /api/post 返回 { ok, deduped, msg, agent }，不是 { message }
  const msgId = p1.json?.msg?.id;
  check(!!msgId, '拿到消息 id', JSON.stringify(Object.keys(p1.json || {})));

  // 直接读 jsonl，看磁盘上到底落了什么
  const jsonl = path.join(dataDir, 'general.jsonl');
  check(fs.existsSync(jsonl), 'general.jsonl 已生成');
  const lines = fs.readFileSync(jsonl, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const rec = lines.find((m) => m.id === msgId);
  check(!!rec, '能找到刚写的那条记录');
  check(rec?.filesVersion === 2, 'filesVersion 落盘为 2', `实际 ${JSON.stringify(rec?.filesVersion)}`);
  check(Array.isArray(rec?.files), 'files 是数组', `实际 ${typeof rec?.files}`);
  check(Array.isArray(rec?.fileCandidates), 'fileCandidates 是数组', `实际 ${typeof rec?.fileCandidates}`);

  const paths = (rec?.files || []).map((f) => f.path);
  check(paths.includes('E:\\codex\\AgentChat\\src\\store.mjs'), '确认了带行号的那条', JSON.stringify(paths));
  check(paths.includes('E:\\codex\\AgentChat\\ui\\index.html'), '确认了裸写的那条', JSON.stringify(paths));
  check(!paths.some((p) => p.includes('example.com')), 'https 链接没被当成本地路径', JSON.stringify(paths));
  check(!paths.some((p) => p.endsWith('a.mjs')), 'CJK 边界那条没进 files（应是候选）', JSON.stringify(paths));
  check((rec?.fileCandidates || []).some((c) => (c.alternatives || []).some((a) => a.includes('a.mjs'))), 'CJK 边界那条在候选里', JSON.stringify(rec?.fileCandidates));

  const lineOf = (rec?.files || []).find((f) => f.path.endsWith('store.mjs'));
  check(lineOf?.line === 166, '行号解析为 166', `实际 ${JSON.stringify(lineOf?.line)}`);

  // filesMeta 是读时派生的，不该进 jsonl。写侧装饰是给 hooks 用的，
  // 必须发生在 appendFileSync 之后 —— 顺序反了就会把派生数据写进磁盘。
  check(!('filesMeta' in (rec || {})), '磁盘上不含 filesMeta（派生数据不落盘）', `实际字段：${Object.keys(rec || {}).join(', ')}`);
  check(Array.isArray(lineOf?.occurrences), '磁盘上保留了 occurrences（v2 需要它算区间）', JSON.stringify(typeof lineOf?.occurrences));

  // occurrence 区间必须能对回原文
  const occ = lineOf?.occurrences?.[0];
  check(Number.isInteger(occ?.start) && Number.isInteger(occ?.end), 'occurrence 有整数区间', JSON.stringify(occ));
  check(typeof occ?.raw === 'string' && rec.body.slice(occ.start, occ.end).includes(occ.raw.replace(/:\d+(-\d+)?$/, '')), 'occurrence 区间对得回原文', `raw=${JSON.stringify(occ?.raw)} 区间=${JSON.stringify(rec.body.slice(occ?.start ?? 0, occ?.end ?? 0))}`);

  // ── 2. 读时装饰：v2 原样用，source 是 stored ──
  log('\n[2] 读时装饰（v2）');
  const r2 = await api('GET', '/api/messages?project=general', undefined, kReader);
  check(r2.status === 200, '读消息 200', `${r2.status} ${r2.text}`);
  const m2 = (r2.json?.messages || []).find((m) => m.id === msgId);
  check(!!m2, '读回来能找到那条');
  check(m2?.filesMeta?.version === 2, 'filesMeta.version = 2', JSON.stringify(m2?.filesMeta));
  check(m2?.filesMeta?.source === 'stored', 'filesMeta.source = stored', JSON.stringify(m2?.filesMeta));
  check(m2?.filesMeta?.degraded === false, 'degraded = false', JSON.stringify(m2?.filesMeta));
  check(JSON.stringify(m2?.files) === JSON.stringify(rec.files), '读回来的 files 与磁盘一致');

  // ── 3. 手工塞一条 v1 老记录，验读时派生 ──
  log('\n[3] v1 老记录读时派生');
  const v1 = {
    id: '20261026-v1legacy0001', ts: '2026-10-26T20:00:00+08:00', project: 'general',
    from: 'author', fromId: 'ag_x', type: 'say',
    body: '老消息：`E:\\codex\\v1\\old.mjs:9` 在这里',
    mentions: ['reader'], mentionsAll: false,
    files: [{ path: 'E:\\codex\\v1\\old.mjs', line: 9 }],  // 旧结构，没有 occurrences
    replyTo: null,
  };
  fs.appendFileSync(jsonl, JSON.stringify(v1) + '\n', 'utf8');
  const r3 = await api('GET', '/api/messages?project=general', undefined, kReader);
  const m3 = (r3.json?.messages || []).find((m) => m.id === v1.id);
  check(!!m3, '读回来能找到 v1 记录');
  check(m3?.filesMeta?.version === 1, 'v1 标 version 1', JSON.stringify(m3?.filesMeta));
  check(m3?.filesMeta?.source === 'derived', 'v1 标 derived', JSON.stringify(m3?.filesMeta));
  check(m3?.filesMeta?.degraded === false, 'v1 派生不算降级', JSON.stringify(m3?.filesMeta));
  check((m3?.files || []).some((f) => f.path.endsWith('old.mjs') && f.line === 9), 'v1 重新解析出行号 9', JSON.stringify(m3?.files));

  // ── 4. 未知版本：files 必须是 null，不能是 [] ──
  log('\n[4] 未知版本不冒充 v1');
  for (const bad of [null, false, 0, 3, '2']) {
    const id = `20261026-badv${String(bad).replace(/[^a-z0-9]/gi, '')}0001`.slice(0, 32);
    const rec2 = {
      id, ts: '2026-10-26T20:00:01+08:00', project: 'general',
      from: 'author', fromId: 'ag_x', type: 'say',
      body: '有路径 `E:\\codex\\x\\y.mjs` 但版本不认识',
      mentions: ['reader'], mentionsAll: false,
      filesVersion: bad, files: [], fileCandidates: [],
      replyTo: null,
    };
    fs.appendFileSync(jsonl, JSON.stringify(rec2) + '\n', 'utf8');
  }
  const r4 = await api('GET', '/api/messages?project=general', undefined, kReader);
  const badOnes = (r4.json?.messages || []).filter((m) => m.id.startsWith('20261026-badv'));
  check(badOnes.length === 5, '五条非法版本都读回来了', `实际 ${badOnes.length}`);
  for (const m of badOnes) {
    check(m.files === null, `版本 ${JSON.stringify(m.filesMeta?.version)} → files 为 null（不是 []）`, `实际 ${JSON.stringify(m.files)}`);
    check(m.filesMeta?.source === null, `版本 ${JSON.stringify(m.filesMeta?.version)} → source 为 null`, JSON.stringify(m.filesMeta));
    check(m.filesMeta?.degraded === false, `版本 ${JSON.stringify(m.filesMeta?.version)} → degraded false`, JSON.stringify(m.filesMeta));
  }

  // ── 5. 磁盘没被读接口写脏：读三次后 jsonl 字节数不变 ──
  log('\n[5] 读接口不写盘');
  const before = fs.statSync(jsonl).size;
  await api('GET', '/api/messages?project=general', undefined, kReader);
  await api('GET', '/api/messages?project=general', undefined, kReader);
  await api('GET', '/api/messages?project=general', undefined, kReader);
  const after = fs.statSync(jsonl).size;
  check(before === after, '读三次 jsonl 字节数不变', `${before} → ${after}`);

  // ── 6. hooks 载荷：已确认进 AGENT_CHAT_FILES，候选只进载荷 + 置 unverified ──
  log('\n[6] hooks 载荷分流');
  const dumpJs = path.join(dataDir, '_dump.mjs');
  fs.writeFileSync(dumpJs, `
import fs from 'node:fs';
const env = process.env;
fs.writeFileSync(env.DUMP_OUT, JSON.stringify({
  files: env.AGENT_CHAT_FILES || '',
  unverified: env.AGENT_CHAT_FILES_UNVERIFIED || '',
  payload: env.AGENT_CHAT_PAYLOAD || '',
}, null, 2));
`, 'utf8');
  const dumpOut = path.join(dataDir, '_dump.json');
  fs.writeFileSync(path.join(dataDir, 'hooks.json'), JSON.stringify({
    reader: {
      command: process.execPath,
      args: [dumpJs],
      cooldownSec: 0,
    },
  }, null, 2), 'utf8');

  // 直接给子进程塞 DUMP_OUT：hooks.mjs 只透传服务进程的 env，
  // 所以得让服务进程带上它。服务已经起来了，改不了 env —— 用固定路径代替。
  // 固定路径写在 dump 脚本里更省事，这里重写一遍。
  fs.writeFileSync(dumpJs, `
import fs from 'node:fs';
const env = process.env;
fs.writeFileSync(${JSON.stringify(dumpOut)}, JSON.stringify({
  files: env.AGENT_CHAT_FILES || '',
  unverified: env.AGENT_CHAT_FILES_UNVERIFIED || '',
  payload: env.AGENT_CHAT_PAYLOAD || '',
}, null, 2));
`, 'utf8');

  const p6 = await api('POST', '/api/post', {
    project: 'general', from: 'author', type: 'ask',
    body: '这条 @reader：确认的 `E:\\codex\\AgentChat\\src\\store.mjs:166`，不确定的 E:\\codex\\AgentChat\\test\\a.mjs里',
    agentKey: kAuthor,
  }, kAuthor);
  check(p6.status === 200, '发带 @reader 的消息 200', `${p6.status} ${p6.text}`);

  let dump = null;
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 250));
    if (fs.existsSync(dumpOut)) {
      try { dump = JSON.parse(fs.readFileSync(dumpOut, 'utf8')); } catch {}
      if (dump) break;
    }
  }
  check(!!dump, 'hook 被拉起并写了 dump', `等 10 秒没等到 ${dumpOut}`);
  if (dump) {
    check(dump.files.includes('E:\\codex\\AgentChat\\src\\store.mjs:166'), 'AGENT_CHAT_FILES 含已确认那条', JSON.stringify(dump.files));
    check(!dump.files.includes('a.mjs'), 'AGENT_CHAT_FILES 不含候选那条', JSON.stringify(dump.files));
    check(dump.unverified === '1', '有候选时 AGENT_CHAT_FILES_UNVERIFIED=1', JSON.stringify(dump.unverified));
    check(!!dump.payload && fs.existsSync(dump.payload), '载荷文件真的落盘了', JSON.stringify(dump.payload));
    if (dump.payload && fs.existsSync(dump.payload)) {
      const pl = JSON.parse(fs.readFileSync(dump.payload, 'utf8'));
      check(Array.isArray(pl.files) && pl.files.length === 1, '载荷 files 只 1 条', JSON.stringify(pl.files?.length));
      check(Array.isArray(pl.fileCandidates) && pl.fileCandidates.length >= 1, '载荷 fileCandidates 有内容', JSON.stringify(pl.fileCandidates?.length));
      check(pl.filesMeta?.source === 'stored', '载荷 filesMeta.source = stored', JSON.stringify(pl.filesMeta));
    }
  }
} catch (e) {
  fails.push(`异常：${e.stack || e.message}`);
  log(`\n异常：${e.stack || e.message}`);
} finally {
  cleanup();
}

console.log(`\n端到端：通过 ${out.filter((l) => l.startsWith('  ok')).length} / 失败 ${fails.length}`);
if (fails.length) {
  console.log('\n失败明细：');
  for (const f of fails) console.log(`✗ ${f}`);
}
process.exit(fails.length ? 1 : 0);
