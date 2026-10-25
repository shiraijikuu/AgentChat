// 找当前真正在用的 codex，然后原样把参数传下去。
//
// 为什么要这一层：codex 有两套安装并存。
//   ~/.local/bin/codex.exe            独立安装的旧构建（这台机器停在 0.160.0）
//   %LOCALAPPDATA%/OpenAI/Codex/bin/<哈希>/codex.exe   应用自更新的新构建（0.164）
// PATH 上排前面的是旧那个，而旧构建要一个 codex-code-mode-host.exe 在旁边，
// 实际文件只在新构建的哈希目录里。结果就是钩子把 codex 拉起来了，它却一条命令都执行不了。
// 写死哈希目录也不行，每次更新哈希都会变，所以这里按时间挑最新的。
//
// 用法：node codex-run.mjs exec --ephemeral ... "<prompt>"
// 环境变量 AGENT_CHAT_CODEX 可以指定死路径，出问题时拿它绕开自动查找。

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';

const EXE = process.platform === 'win32' ? 'codex.exe' : 'codex';

function newestIn(dir) {
  let best = null;
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const p = path.join(dir, e.name, EXE);
    let st = null;
    try {
      st = fs.statSync(p);
    } catch {
      continue;
    }
    if (!st.isFile()) continue;
    if (!best || st.mtimeMs > best.mtimeMs) best = { file: p, mtimeMs: st.mtimeMs };
  }
  return best ? best.file : null;
}

function candidates() {
  const list = [];
  if (process.env.AGENT_CHAT_CODEX) list.push(process.env.AGENT_CHAT_CODEX);

  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  // 应用自更新的构建，带配套的 code-mode host，优先用这个
  const appDir = newestIn(path.join(localAppData, 'OpenAI', 'Codex', 'bin'));
  if (appDir) list.push(appDir);

  // 独立安装的旧构建，兜底
  list.push(path.join(os.homedir(), '.local', 'bin', EXE));
  return list;
}

function pick() {
  for (const p of candidates()) {
    try {
      if (fs.statSync(p).isFile()) return p;
    } catch {
      // 没有就试下一个
    }
  }
  return null;
}

const file = pick();
if (!file) {
  // 一个都没找到，交给 PATH 自己解析，好歹留一线
  process.stderr.write('[codex-run] 没在已知目录找到 codex，改用 PATH 上的 codex\n');
}

const target = file || 'codex';
let mtime = '';
try {
  mtime = new Date(fs.statSync(target).mtimeMs).toISOString().slice(0, 10);
} catch {
  mtime = '未知';
}
process.stderr.write(`[codex-run] 用 ${target}（构建日期 ${mtime}）\n`);

// stdin 必须是空的。codex exec 见到能读的 stdin 会一直等，等到超时也不动。
const child = spawn(target, process.argv.slice(2), {
  stdio: ['ignore', 'inherit', 'inherit'],
  windowsHide: true,
});

child.on('error', (e) => {
  process.stderr.write(`[codex-run] 起不来：${e.message}\n`);
  process.exit(127);
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.stderr.write(`[codex-run] 被信号打断：${signal}\n`);
    process.exit(1);
  }
  process.exit(code === null ? 1 : code);
});
