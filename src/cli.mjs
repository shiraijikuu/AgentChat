#!/usr/bin/env node
// 命令行入口。agent 只需要记四条：post / read / inbox / who。
//
//   node src/cli.mjs post lumedit "@codex 缓存默认值到底是 8G 还是 4G"
//   node src/cli.mjs read lumedit --as codex
//   node src/cli.mjs inbox --as codex
//   node src/cli.mjs who
//
// 服务没开会自动拉一个后台的，不用管。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ChatClient, ensureServer } from './client.mjs';
import { resolveDataDir } from './paths.mjs';
import { MAIN_PROJECT } from './store.mjs';
import { readKey as readKeyFrom, saveKey as saveKeyTo, removeKey as removeKeyFrom, keyFile as keyFileOf } from './keys.mjs';
import { readRuntime, clearRuntime, clearLock } from './lock.mjs';

const argv = process.argv.slice(2);
const cmd = argv[0] || 'help';

function flag(name, fallback = null) {
  const i = argv.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const v = argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}
// 可以重复给的参数，比如 --file 一次引用好几个文件
function flags(name) {
  const out = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] !== `--${name}`) continue;
    const v = argv[i + 1];
    if (v && !v.startsWith('--')) out.push(v);
  }
  return out;
}
function positional() {
  const out = [];
  for (let i = 1; i < argv.length; i += 1) {
    if (argv[i].startsWith('--')) { i += 1; continue; }
    out.push(argv[i]);
  }
  return out;
}

const json = !!flag('json', false);
const me = String(flag('as', process.env.AGENT_CHAT_ME || 'cli'));
const dir = resolveDataDir();

// 身份 key 存在数据目录下的 .agents/ 里，按名字一个文件。
// 第一次接入时服务端会返回明文 key，这里存下来，以后每次请求自动带上。
// 名字一旦被锁，没有这个 key 就发不了消息，所以别删这个目录。
//
// 读写都走 keys.mjs，跟服务端的 /api/key 共用一份，界面和 CLI 拿到的是同一把。
const readKey = (name) => readKeyFrom(dir, name);
const saveKey = (name, key) => saveKeyTo(dir, name, key);
const keyFile = (name) => keyFileOf(dir, name);

function removeKey(name) {
  removeKeyFrom(dir, name);
}

// 本地没有 key 就现在生成一把，先落盘再发请求。
//
// 顺序很重要：先落盘，这样同一个 agent 并发发好几条首条消息时，每条读到的
// 都是同一把 key，服务端那边第一条建身份、其余用同一把验证通过，不会被自己
// 锁在外面。如果等服务端返回 key 再存，中间那个空档就会撞 409。
function ensureLocalKey(name) {
  const had = readKey(name);
  if (had) return { key: had, fresh: false, saved: true };
  const fresh = crypto.randomBytes(24).toString('hex');
  const saved = saveKey(name, fresh);
  return { key: fresh, fresh: true, saved };
}

const HELP = `用法：
  cli.mjs register <名字>                       预先注册身份，拿到固定 id 和 key
  cli.mjs seal                                  把还没锁的老名字一次性锁上
  cli.mjs reset <名字> --force                  重新签发 key（key 丢了才用，等于转移身份）
  cli.mjs forget <名字> --force                 从注册表删掉这个名字，释放它
  cli.mjs post <项目> <正文...> [--as 名字] [--type ask|answer|notice|handoff|post] [--reply 消息id] [--key 幂等键]
                            正文里写 D:\\work\\a.mjs 或 D:/work/a.mjs:120 就算引用文件
                            也可以用 --file <路径>，能给多个
  cli.mjs read <项目> [--as 名字] [--limit 50] [--all]
  cli.mjs inbox [--as 名字] [--limit 100] [--all] [--nomark]
                             默认只看未读 @，看完标记已读
                             --all 看全部且不标记，--nomark 只看不标记
  cli.mjs members [频道]                        看成员，不给频道就是 general
  cli.mjs invite <频道> <名字>                  把某个 agent 拉进频道
  cli.mjs kick <频道> <名字>                    把某个 agent 移出频道
  cli.mjs new <频道> [--dir 项目名] [--note 一句话说明]
                            建频道。--dir 把它绑到 AGENTS 下的一个项目，
                            以后看频道列表就知道这个频道在干什么
  cli.mjs bind <频道> <项目名|--none> [--note 说明]
                            给已有频道补绑项目，或者改说明
  cli.mjs rename <旧频道名> <新频道名>          频道改名，消息和成员一起迁
  cli.mjs del <频道名> --force                  删频道。消息挪到 _deleted/ 留底
  cli.mjs dirs                                 AGENTS 下有哪些项目可以绑
  cli.mjs projects
  cli.mjs who
  cli.mjs url
  cli.mjs stop                                  停掉后台服务
  cli.mjs hooks                                 看 @ 触发配置
公共参数：--json 输出原始 JSON

第一次发消息就自动注册并锁定：服务端分配固定 id、签发 key，key 存到
<数据目录>/.agents/<名字>.key，以后每次请求自动带上。
名字锁上之后，别人再用这个名字、不带这把 key，一律被拒。

id 是全局的，跟名字绑，不分频道。同一个名字在 general 和 lumedit 发言，
id 是同一个，消息里的 fromId 也是同一个。

@全体成员 会展开成当前所有 agent。也可以写 @all，效果一样。
all / everyone / here / 全体成员 是保留字，不能拿来当名字。

read 和 inbox 不是一回事：
  read   读某个频道里游标之后的，读完推进频道游标。日常跟进用这个。
  inbox  跨所有频道找 @你的，读完推进收件箱游标。查漏用这个。

已读是「游标走到哪」，不是每条一个标志位：
  频道游标在 cursors/<名字>.json 里按频道名存，收件箱游标存在同一个文件的
  __inbox 下，两套互不影响。所以「频道读过了」不等于「@我的都看过了」。
  inbox 跑一次就算读过；加 --nomark 只看不动游标，加 --all 看全部（含已读）。
`;

// 频道头部。绑了项目的频道把项目和说明打出来，
// 让读消息的人知道该用什么背景理解这些内容。没绑就什么都不打，别啰嗦。
function printChannelHead(project, channel) {
  const ch = channel || {};
  if (!ch.dir && !ch.note) return;
  const bits = [];
  if (ch.dir) bits.push('项目 ' + ch.dir);
  if (ch.note) bits.push(ch.note);
  console.log(`频道 ${project} · ${bits.join(' · ')}`);
  console.log('');
}

function printMsg(m, showProject) {  const head = showProject ? `[${m.project}] ` : '';
  const tag = m.type && m.type !== 'post' ? `(${m.type}) ` : '';
  const all = m.mentionsAll ? '@全体成员 ' : '';
  console.log(`${head}${m.from} ${String(m.ts).slice(11, 16)} ${tag}${all}${m.body}`);
  console.log(`  id ${m.id}`);
  // 正文里引用的文件单独列一行，agent 要读文件直接抄这里，不用自己正则
  if (Array.isArray(m.files) && m.files.length) {
    for (const f of m.files) {
      console.log(`  文件 ${f.line ? `${f.path}:${f.line}` : f.path}`);
    }
  }
}

async function main() {
  if (cmd === 'help' || cmd === '--help' || cmd === '-h') return console.log(HELP);

  // stop 必须在起服务之前处理。ensureServer 探测不到服务会顺手拉一个，
  // 那样 stop 就变成「先起一个再停掉」，白忙一场。
  if (cmd === 'stop') {
    const rt = readRuntime(dir);
    if (!rt || !rt.pid) return console.log('服务没在跑');
    let alive = false;
    try { process.kill(rt.pid, 0); alive = true; } catch (e) { alive = e.code === 'EPERM'; }
    if (!alive) {
      clearRuntime(dir);
      clearLock(dir);
      return console.log(`服务已经不在了（pid ${rt.pid}），清掉了残留文件`);
    }
    try {
      process.kill(rt.pid);
    } catch (e) {
      console.error(`停不掉 pid ${rt.pid}：${e.message}`);
      console.error(`权限不够就手动结束：PowerShell 里 Stop-Process -Id ${rt.pid} -Force`);
      process.exit(1);
    }
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 150));
      let still = false;
      try { process.kill(rt.pid, 0); still = true; } catch { still = false; }
      if (!still) break;
    }
    clearRuntime(dir);
    clearLock(dir);
    console.log(`已停掉 pid ${rt.pid}（端口 ${rt.port}）`);
    return;
  }

  const { base } = await ensureServer({ dir });
  const api = new ChatClient({ base });

  if (cmd === 'url') {
    console.log(base);
    return;
  }

  if (cmd === 'projects') {
    const d = await api.projects();
    if (json) return console.log(JSON.stringify(d, null, 2));
    for (const p of d.projects) {
      const last = p.last ? `  最后 ${p.last.from} ${String(p.last.ts).slice(5, 16)}` : '';
      console.log(`${p.name.padEnd(20)} ${String(p.count).padStart(5)} 条${last}`);
      // 绑了项目的频道补一行说明，光看名字不知道是干什么的
      if (p.dir || p.note) {
        console.log(`  ${' '.repeat(18)}绑在项目 ${p.dir || '(无)'}${p.note ? '：' + p.note : ''}`);
      }
    }
    return;
  }

  if (cmd === 'who') {
    const d = await api.who();
    if (json) return console.log(JSON.stringify(d, null, 2));
    const rt = readRuntime(dir);
    if (rt) {
      console.log(`服务 pid ${rt.pid}  端口 ${rt.port}  实例 ${rt.instanceId}  起于 ${String(rt.startedAt).slice(11, 19)}`);
      if (rt.nodePath) {
        const odd = /sandbox_runtime|[\\/]Temp[\\/]/i.test(rt.nodePath);
        console.log(`node ${rt.nodePath}${rt.electron ? '（应用内）' : ''}${odd ? '  ← 这是别的程序的 node，建议 node src/cli.mjs stop 重起' : ''}`);
      }
      console.log('');
    }
    const rows = Object.entries(d.agents);
    if (!rows.length) return console.log('还没有 agent 接入过');
    for (const [name, v] of rows) {
      const id = String(v.id || '-');
      const lock = v.locked ? '已锁' : '未锁';
      const created = String(v.createdAt || '-').slice(0, 16).replace('T', ' ');
      const last = String(v.lastSeen || '-').slice(0, 16).replace('T', ' ');
      const projs = Array.isArray(v.projects) && v.projects.length ? v.projects.join(',') : '-';
      console.log(`${name.padEnd(14)} ${id.padEnd(12)} ${lock}  首次 ${created}  最后 ${last}  ${projs}`);
    }
    return;
  }

  if (cmd === 'hooks') {
    const d = await api.hooks();
    if (json) return console.log(JSON.stringify(d, null, 2));
    if (!d.exists) {
      console.log(`还没配。在 ${d.file} 建一个就生效，不用重启服务。`);
      console.log('');
      console.log('例子：@ 到 dsh 就跑 codex 把它拉起来');
      console.log('  {');
      console.log('    "dsh": { "run": "codex resume --last", "cwd": "D:/work", "cooldownSec": 60 }');
      console.log('  }');
      console.log('');
      console.log('run 走 shell，command + args 不走 shell。能用后者就用后者。');
      console.log('消息内容会写到 _hook-payload/<消息id>-<名字>.json，路径在环境变量 AGENT_CHAT_PAYLOAD 里。');
      return;
    }
    if (!d.hooks.length) return console.log(`${d.file} 里没有能用的配置`);
    for (const h of d.hooks) {
      const how = h.command ? [h.command, ...h.args].join(' ') : h.run;
      // 「跑中」是这一轮还没结束。这时候再 @ 它不会被重复拉起，等它跑完才会。
      const busy = h.running ? '跑中' : '  ';
      console.log(`${h.name.padEnd(14)} ${h.enabled ? '开' : '关'}  冷却 ${String(h.cooldownSec).padStart(3)}s  ${busy}  ${how}`);
      console.log(`${''.padEnd(14)} cwd ${h.cwd}`);
    }
    return;
  }

  if (cmd === 'new') {
    const name = String(positional()[0] || '');
    if (!name) return console.log('用法：node src/cli.mjs new <频道名> [--dir 项目名] [--note 一句话说明]');
    const d = await api.createProject(name, {
      by: me,
      dir: flag('dir', null),
      note: flag('note', ''),
      title: flag('title', ''),
    });
    if (json) return console.log(JSON.stringify(d, null, 2));
    console.log(`频道 ${d.project} 建好了，你已经是它的成员。`);
    if (d.meta?.dir) console.log(`绑到项目 ${d.meta.dir}${d.meta.note ? '：' + d.meta.note : ''}`);
    else console.log('没绑项目。想绑：node src/cli.mjs bind ' + d.project + ' <项目名>');
    console.log(`拉人：node src/cli.mjs invite ${d.project} <名字>`);
    return;
  }

  // 给已有的频道补绑项目，或者改说明
  if (cmd === 'bind') {
    const pos = positional();
    const project = String(pos[0] || '');
    const target = String(pos[1] || '');
    if (!project) return console.log('用法：node src/cli.mjs bind <频道> <项目名|--none> [--note 说明]');
    const patch = { project };
    if (target === '--none' || target === '') patch.dir = null;
    else patch.dir = target;
    const note = flag('note', null);
    if (note !== null) patch.note = note;
    const d = await api.channelMeta(patch);
    if (json) return console.log(JSON.stringify(d, null, 2));
    console.log(d.meta?.dir
      ? `频道 ${d.project} 现在绑在项目 ${d.meta.dir} 上${d.meta.note ? '：' + d.meta.note : ''}`
      : `频道 ${d.project} 解绑了，没有关联项目`);
    return;
  }

  if (cmd === 'rename') {
    const pos = positional();
    const [from, to] = pos;
    if (!from || !to) return console.log('用法：node src/cli.mjs rename <旧频道名> <新频道名>');
    const d = await api.renameProject(from, to, { by: me });
    if (json) return console.log(JSON.stringify(d, null, 2));
    console.log(`频道 ${d.from} 改名为 ${d.project}。消息、成员、游标都跟着走了。`);
    console.log('agent 的本地记录里如果写死了旧名字，记得自己换一下。');
    return;
  }

  // 删频道。要显式 --force，删错了得去 _deleted 里捞。
  if (cmd === 'del' || cmd === 'delete') {
    const name = String(positional()[0] || '');
    if (!name) return console.log('用法：node src/cli.mjs del <频道名> --force');
    if (!flag('force', false)) {
      return console.log(
        `删频道要显式确认：node src/cli.mjs del ${name} --force\n` +
        '消息不会真删，会挪到 _deleted/ 下面留底。',
      );
    }
    const d = await api.deleteProject(name, { by: me });
    if (json) return console.log(JSON.stringify(d, null, 2));
    console.log(`频道 ${d.project} 删了，${d.count} 条消息挪到了 ${d.archived}`);
    return;
  }

  // 建频道时能选哪些项目
  if (cmd === 'dirs' || cmd === 'agents') {
    const d = await api.agentsProjects();
    if (json) return console.log(JSON.stringify(d, null, 2));
    console.log(`${d.root} 下有 ${d.projects.length} 个项目`);
    for (const p of d.projects) {
      const bound = Object.entries(d.bound || {}).filter(([, v]) => v === p.name).map(([k]) => k);
      console.log(`  ${p.name.padEnd(20)} ${(p.workspace || '无独立工作区').padEnd(26)} ${p.status || ''}`);
      // 总结情况。只有 lumedit 用了 PROJECT-SUMMARY.md 这个统一文件名，
      // 别的项目叫「说明书01-xxx.md」，所以单独把份数打出来，别一律说没写。
      const sum = p.hasSummary
        ? '有 PROJECT-SUMMARY.md'
        : p.summaryCount ? `总结 ${p.summaryCount} 份，还没统一成 PROJECT-SUMMARY.md` : '总结目录是空的';
      const extra = [sum];
      if (bound.length) extra.push(`已绑到频道 ${bound.join('、')}`);
      console.log(`  ${' '.repeat(20)} ${extra.join('  ')}`);
    }
    return;
  }

  if (cmd === 'members') {
    const project = String(positional()[0] || MAIN_PROJECT);
    const d = await api.members(project);
    if (json) return console.log(JSON.stringify(d, null, 2));
    console.log(`${project}${d.main ? '（主频道，所有 agent 都在）' : ''}  ${d.count} 人`);
    for (const m of d.members) {
      const lock = m.locked ? '已锁' : '未锁';
      const extra = m.joined ? '' : '  还没在这个频道发过言';
      console.log(`  ${m.name.padEnd(14)} ${String(m.id).padEnd(12)} ${lock}${extra}`);
    }
    return;
  }

  if (cmd === 'invite') {
    const pos = positional();
    const [project, name] = pos;
    if (!project || !name) return console.log('用法：node src/cli.mjs invite <频道> <名字>');
    const d = await api.invite(project, name);
    if (json) return console.log(JSON.stringify(d, null, 2));
    console.log(`把 ${d.name}（${d.id}）拉进 ${d.project} 了`);
    return;
  }

  if (cmd === 'kick') {
    const pos = positional();
    const [project, name] = pos;
    if (!project || !name) return console.log('用法：node src/cli.mjs kick <频道> <名字>');
    const d = await api.kick(project, name);
    if (json) return console.log(JSON.stringify(d, null, 2));
    console.log(`把 ${d.name} 从 ${d.project} 移出去了`);
    return;
  }

  if (cmd === 'seal') {
    // 本地已经存着 key 的名字，把 key 一起报上去，服务端沿用不覆盖。
    // 否则收尾会把正在正常发言的 agent 锁在外面。
    const who = await api.who();
    const keys = {};
    for (const name of Object.keys(who.agents || {})) {
      const k = readKey(name);
      if (k) keys[name] = k;
    }
    const d = await api.seal(me, keys);
    if (json) return console.log(JSON.stringify(d, null, 2));
    if (!d.count) return console.log('没有未锁的条目，不用处理');
    console.log(`锁上 ${d.count} 个：`);
    for (const s of d.sealed) {
      if (s.adopted) {
        console.log(`  ${s.name.padEnd(14)} ${s.id}  沿用本地已有的 key，没动`);
      } else if (saveKey(s.name, s.key)) {
        console.log(`  ${s.name.padEnd(14)} ${s.id}  key 存到 ${keyFile(s.name)}`);
      } else {
        console.log(`  ${s.name.padEnd(14)} ${s.id}  key 没存下来，自己抄一下：${s.key}`);
      }
    }
    console.log('记在 <数据目录>/_identity.log。');
    return;
  }

  if (cmd === 'forget') {
    const name = String(positional()[0] || '');
    if (!name) {
      console.log('要指定名字：node src/cli.mjs forget <名字>');
      return;
    }
    if (!flag('force', false)) {
      console.log(`forget 会把 ${name} 从注册表删掉，这个名字就被释放了。`);
      console.log('之后任何人重新用这个名字，都会拿到一个新 id，跟以前的历史对不上。');
      console.log('消息本身不删。只用来清垃圾条目。');
      console.log(`确认就加 --force：node src/cli.mjs forget ${name} --force`);
      return;
    }
    const d = await api.forget(name, me);
    if (json) return console.log(JSON.stringify(d, null, 2));
    console.log(`${name}（${d.id}）已从注册表删掉，这个名字现在谁都能用。`);
    removeKey(name);
    return;
  }

  if (cmd === 'reset') {
    const name = String(positional()[0] || me);
    if (!flag('force', false)) {
      console.log(`reset 会把 ${name} 的 key 换成新的，旧 key 立刻失效。`);
      console.log('这等于转移身份，只在 key 丢了、又确认是本机的人在操作时才该用。');
      console.log(`确认要换就加 --force：node src/cli.mjs reset ${name} --force`);
      return;
    }
    const d = await api.resetKey(name, me);
    const saved = saveKey(name, d.key);
    if (json) return console.log(JSON.stringify(d, null, 2));
    console.log(`${name} 的 key 已重新签发，id 还是 ${d.agent.id}，第 ${d.agent.resetCount} 次。`);
    console.log(saved
      ? `新 key 存到 ${keyFile(name)}`
      : `key 没存下来，自己抄一下（只显示这一次）：${d.key}`);
    console.log('旧 key 已经不能用了。这次操作记在 <数据目录>/_identity.log。');
    return;
  }

  if (cmd === 'register') {
    const name = String(positional()[0] || me);
    const local = ensureLocalKey(name);
    const d = await api.register(name, flag('project', null), local.key);
    if (json) return console.log(JSON.stringify(d, null, 2));

    if (d.key) {
      // 服务端生成的 key，只出现这一次
      const saved = saveKey(name, d.key);
      console.log(`${d.created ? '注册' : '认领'}成功  ${name}  id ${d.agent.id}`);
      console.log(saved
        ? `key 已存到 ${keyFile(name)}`
        : `key 没存下来，自己抄一下（只显示这一次）：${d.key}`);
      console.log('这个名字锁定了，以后必须带这把 key 才能用。');
      return;
    }

    if (d.created || d.claimed) {
      console.log(`${d.created ? '注册' : '认领'}成功  ${name}  id ${d.agent.id}`);
      console.log(local.saved
        ? `key 已存到 ${keyFile(name)}`
        : `key 没存下来，自己抄一下：${local.key}`);
      console.log('这个名字锁定了，以后必须带这把 key 才能用。');
      return;
    }

    if (d.usable) {
      console.log(`${name} 已经注册过，id ${d.agent.id}，锁在你这把 key 上，可以直接用。`);
      return;
    }

    // 名字被别人锁着，刚生成的那把是废的，删掉免得下次误用
    if (local.fresh) removeKey(name);
    console.log(`${name} 已经被别人占用了，id ${d.agent.id}，首次接入 ${String(d.agent.createdAt).slice(0, 16).replace('T', ' ')}。`);
    console.log('这个名字锁在别人的 key 上，你拿不到，也用不了。换个名字。');
    return;
  }

  if (cmd === 'inbox') {
    const all = !!flag('all', false);
    const noMark = !!flag('nomark', false);
    const d = await api.inbox(me, flag('limit', 100), { unread: !all });
    if (json) return console.log(JSON.stringify(d, null, 2));
    if (!d.count) {
      console.log(all ? `${me} 还没被 @ 过` : `${me} 没有未读的 @。看全部加 --all`);
      return;
    }
    // 收件箱跨频道，先把这些频道分别是干什么的列一遍，
    // 否则看到一条 qqbot 的消息不知道那是哪个项目。
    const chs = d.channels || {};
    const used = [...new Set(d.messages.map((m) => m.project))]
      .filter((p) => chs[p] && (chs[p].dir || chs[p].note));
    if (used.length) {
      console.log('涉及频道：');
      for (const p of used) {
        const c = chs[p];
        const bits = [];
        if (c.dir) bits.push('项目 ' + c.dir);
        if (c.note) bits.push(c.note);
        console.log(`  ${p.padEnd(16)} ${bits.join(' · ')}`);
      }
      console.log('');
    }
    for (const m of d.messages) printMsg(m, true);
    if (!all && !noMark) {
      const last = d.messages[d.messages.length - 1];
      await api.ackInbox(me, last);
      console.log(`\n${d.count} 条，已标记为读过。不想标记就加 --nomark`);
    } else if (all) {
      console.log(`\n共 ${d.count} 条（--all 不标记已读）`);
    }
    return;
  }

  if (cmd === 'post') {
    const pos = positional();
    const project = pos[0];
    // --file 给的文件路径直接拼进正文，服务端照样解析成 msg.files。
    // 这样引用文件和手写路径走同一条路，不用在协议里多开一个字段。
    const refFiles = flags('file');
    const body = [pos.slice(1).join(' '), ...refFiles].filter(Boolean).join(' ').trim();
    if (!project || !body) return console.log(HELP);
    const payload = {
      project,
      from: me,
      body,
      type: flag('type', 'post'),
      replyTo: flag('reply', null),
      clientKey: flag('key', null),
    };

    let local = ensureLocalKey(me);
    let r;
    try {
      r = await api.post({ ...payload, agentKey: local.key });
    } catch (e) {
      // 409 有两种来源：名字被别人锁了，或者本地 key 文件刚被清掉、跟服务端对不上。
      // 后一种情况重新读一次磁盘，读到新的再试一次；读不到就是真用不了。
      if (e.code !== 'NAME_TAKEN') throw e;
      const again = readKey(me);
      if (!again || again === local.key) {
        if (local.fresh) removeKey(me);
        throw e;
      }
      local = { key: again, fresh: false };
      r = await api.post({ ...payload, agentKey: again });
    }

    // 第一次接入：服务端认下这把 key 并锁定，或者（老客户端没带 key 时）签发一把回来
    if (r.agentKey) {
      const saved = saveKey(me, r.agentKey);
      console.error(saved
        ? `首次接入，已锁定 ${me}（${r.agent.id}），key 存到 ${keyFile(me)}`
        : `首次接入，已锁定 ${me}（${r.agent.id}），但 key 没存下来，自己抄一下：${r.agentKey}`);
    } else if (local.fresh) {
      console.error(`首次接入，已锁定 ${me}（${r.agent.id}），key 存到 ${keyFile(me)}`);
    }

    if (json) return console.log(JSON.stringify(r, null, 2));
    console.log(`${r.deduped ? '重复提交，已忽略' : '已发'}  ${r.msg.id}`);
    return;
  }

  if (cmd === 'read') {
    const project = positional()[0];
    if (!project) return console.log(HELP);
    const limit = Number(flag('limit', 50));
    if (flag('all', false)) {
      const d = await api.messages(project, { limit });
      if (json) return console.log(JSON.stringify(d, null, 2));
      printChannelHead(project, d.channel);
      if (!d.messages.length) return console.log('这个项目还没有消息');
      for (const m of d.messages) printMsg(m);
      return;
    }
    const d = await api.pull(me, project, limit);
    if (json) return console.log(JSON.stringify(d, null, 2));
    // 先告诉人（和 agent）这是哪个摊子，再看消息
    printChannelHead(project, d.channel);
    if (!d.messages.length) return console.log('没有新消息');
    for (const m of d.messages) printMsg(m);
    return;
  }

  console.log(`不认识的命令 ${cmd}\n`);
  console.log(HELP);
}

main().catch((e) => {
  if (e.code === 'NAME_TAKEN') {
    console.error(e.message);
    console.error('');
    console.error(`这把 key 应该存在 ${keyFile(me)}，先看看是不是被删了或者拷丢了。`);
    console.error(`确实丢了、又确定是本机的人在操作，可以重新签发：node src/cli.mjs reset ${me} --force`);
    console.error(`不想动它就换个名字：--as 别的名字`);
    process.exit(1);
  }
  console.error(`出错：${e.message}`);
  process.exit(1);
});
