#!/usr/bin/env node
// 把 AgentChat 的 hook 载荷转成一次 `dsh headless` 任务。
//
// 为什么需要这一层：
//   hooks.json 里 dsh 那段的 command 原先指向 codex-run.mjs，实际拉起的是
//   codex.exe，顶着 dsh 的名字去读收件箱。结果是「dsh 已拉起」记了 22 条，
//   真正的 dsh 一次没被叫醒，回帖其实是 codex 代发。
//
// 为什么要自己补密钥：
//   `dsh headless` 需要 DEEPSEEK_API_KEY 在环境里，否则直接
//   MISSING_CREDENTIAL: llm-deepseek: no API key for provider route
//   "deepseek-official"。而 hooks.mjs 只透传服务进程的 env（L254-255），
//   不支持 hook.env 字段。所以这里从 ~/.dsh/.credentials.yaml 的
//   refs.DEEPSEEK_API_KEY 读出来补上 —— 密钥不进 hooks.json，
//   也不动系统环境变量。
//
// 为什么要自己读载荷里的文件清单：
//   提示词是 hooks.json 里写死的静态文本，正文里的文件路径不会自己进去。
//   hooks.mjs 已经把已确认的路径算好放在 AGENT_CHAT_PAYLOAD 的 files 字段里，
//   但 dsh 拿到的只有提示词 + 环境变量，不知道载荷长什么样。所以这里读一次载荷，
//   把已确认的 files 和待确认的 fileCandidates 各自渲染成一段，插在提示词前面。
//   分两段是契约要求：候选不能混进「可以直接 open」的那份清单。
//
// 用法（hooks.json 的 dsh 段）：
//   "command": "C:/Program Files/nodejs/node.exe",
//   "args": ["E:/codex/AgentChat/src/dsh-run.mjs", "<给 dsh 的提示词>"]

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
const CRED_FILE = path.join(DSH_HOME, '.credentials.yaml');

// dsh 启动器的实际位置。DSH_BIN 可以覆盖，出问题时拿它绕开自动查找。
function candidates() {
  const list = [];
  if (process.env.DSH_BIN) list.push(process.env.DSH_BIN);
  list.push('E:\\dshw\\resources\\runtime\\cli\\bin\\dsh.cmd');
  list.push(path.join(process.env.LOCALAPPDATA || '', 'Programs', 'dsh', 'dsh.cmd'));
  return list;
}

function pickTarget() {
  for (const c of candidates()) {
    if (!c) continue;
    try {
      if (fs.statSync(c).isFile()) return c;
    } catch {}
  }
  return null;
}

// 只认 .credentials.yaml 里 refs 段那一行，别的 deepseek 字样不碰。
function readDeepseekKey() {
  if (process.env.DEEPSEEK_API_KEY) return process.env.DEEPSEEK_API_KEY;
  try {
    const text = fs.readFileSync(CRED_FILE, 'utf8');
    const m = text.match(/^\s+DEEPSEEK_API_KEY:\s*(\S+)\s*$/m);
    if (m) return m[1];
  } catch {}
  return null;
}

// 把载荷里的文件清单渲染成提示词附录。
//
// 契约（与 codex / workbuddy 在频道里定的）：
//   - files 是已确认的，可以直接 open；files 为 null 表示无法校验，不是「没有文件」。
//   - fileCandidates 是解析不确定的，只能提示「可能还有别的」，不能当确定路径用。
//   - filesMeta.source === null 时 files 也是 null（成对不变量），一并按无法校验处理。
//
// 返回空串表示这条消息没提文件，提示词不加任何尾巴。
function renderFilesBlock(payloadFile) {
  if (!payloadFile) return '';
  let p;
  try {
    p = JSON.parse(fs.readFileSync(payloadFile, 'utf8'));
  } catch (e) {
    process.stderr.write(`[dsh-run] 载荷读不出来（${e.message}），提示词不加文件清单\n`);
    return '';
  }
  const files = Array.isArray(p.files) ? p.files : null;
  const cands = Array.isArray(p.fileCandidates) ? p.fileCandidates : [];
  const meta = p.filesMeta || null;
  const src = meta ? meta.source : undefined;

  const lines = [];
  if (files === null || src === null) {
    // 无法校验：明确说「不知道」，不让会话以为正文里没有路径。
    lines.push('文件清单：这条消息的文件引用无法校验（载荷 files 为 null）。');
    lines.push('正文里可能还有路径，需要的话自己从原文里看，不要假设清单是空的。');
    if (cands.length) {
      lines.push(`另有 ${cands.length} 条解析不确定的路径，见载荷 fileCandidates。`);
    }
    return lines.join('\n') + '\n\n';
  }

  if (files.length) {
    lines.push(`文件清单（已确认 ${files.length} 条，可直接打开）：`);
    for (const f of files) {
      let tail = '';
      if (f.line) tail = f.lineEnd && f.lineEnd !== f.line ? `:${f.line}-${f.lineEnd}` : `:${f.line}`;
      lines.push(`- ${f.path}${tail}${f.quoted ? '' : '（正文里是裸写的，边界靠词法判断）'}`);
    }
  }
  if (cands.length) {
    lines.push(`待确认路径（${cands.length} 条，解析不确定，不要当确定路径去读）：`);
    for (const c of cands) {
      const alts = Array.isArray(c.alternatives) ? c.alternatives.filter(Boolean) : [];
      const shown = alts.length > 1 ? alts.join(' 或 ') : (alts[0] || c.candidatePath || '（未知）');
      lines.push(`- ${shown} —— 原因：${c.reason}`);
    }
  }
  if (!lines.length) return '';
  return lines.join('\n') + '\n\n';
}

const base = process.argv.slice(2).join(' ').trim();
if (!base) {
  process.stderr.write('[dsh-run] 没有提示词，什么都不做\n');
  process.exit(2);
}
const fileBlock = renderFilesBlock(process.env.AGENT_CHAT_PAYLOAD || '');
// 文件清单放最前面：提示词末尾是「不要写日记、不要改项目文件」这类收尾约束，
// 那些必须留在最后一句，不能被我拼的内容冲淡。
const prompt = fileBlock ? `${fileBlock}${base}` : base;

const target = pickTarget();
if (!target) {
  process.stderr.write('[dsh-run] 找不到 dsh 启动器，检查 DSH_BIN 或安装位置\n');
  process.exit(127);
}

const key = readDeepseekKey();
if (!key) {
  process.stderr.write(
    `[dsh-run] 拿不到 DEEPSEEK_API_KEY：${CRED_FILE} 的 refs 段里没有，环境变量也没有\n`,
  );
  process.exit(3);
}

let mtime = '未知';
try {
  mtime = new Date(fs.statSync(target).mtimeMs).toISOString().slice(0, 10);
} catch {}
process.stderr.write(`[dsh-run] 用 ${target}（构建日期 ${mtime}）\n`);

// dsh.cmd 是批处理，Windows 上必须过 cmd.exe。提示词走 stdin（`headless -`
// 从 stdin 读任务），不走命令行参数：hook 的提示词是多行带引号的中文，
// 塞进 cmd 命令行会被引号规则和换行切坏。
//
// 注意 cmd /c 的引号规则：整个命令串只加一层外层引号，路径本身不再套引号，
// 否则 cmd 会把 \"...\" 当成命令名去找，报 not recognized。
const child = spawn(
  process.env.ComSpec || 'cmd.exe',
  ['/d', '/s', '/c', `${target} headless -`],
  {
    stdio: ['pipe', 'inherit', 'inherit'],
    windowsHide: true,
    env: { ...process.env, DEEPSEEK_API_KEY: key },
  },
);

child.stdin.on('error', () => {});
child.stdin.end(prompt, 'utf8');

child.on('error', (e) => {
  process.stderr.write(`[dsh-run] 起不来：${e.message}\n`);
  process.exit(127);
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.stderr.write(`[dsh-run] 被信号打断：${signal}\n`);
    process.exit(1);
  }
  process.exit(code === null ? 1 : code);
});
