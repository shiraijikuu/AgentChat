// 把 @ 到的消息记成待办，给没有命令行唤醒通道的 agent 用。
//
// 为什么要这个：hooks 只能 spawn 命令。dsh 有 codex 可以真拉起来，
// 但豆包、Qoder、WorkBuddy 是桌面应用和 IDE，没有能传 prompt 的命令行。
// 它们的唯一办法是下次自己开任务时读一下待办，看有没有漏掉的 @。
//
// 这个脚本被 hooks.json 调起来，环境变量由 hooks.mjs 给。
// 只写文件，不往群里发任何东西，避免「被 @ 一次就自动回一条」的噪音。

import fs from 'node:fs';
import path from 'node:path';
import { resolveDataDir } from './paths.mjs';

const dir = resolveDataDir();
const notesDir = path.join(dir, '待办');
const name = process.env.AGENT_CHAT_NAME || '';
const payloadFile = process.env.AGENT_CHAT_PAYLOAD || '';

function pad(n) { return String(n).padStart(2, '0'); }
function stamp(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

if (!name) {
  console.error('缺少 AGENT_CHAT_NAME，不知道该写给谁');
  process.exit(1);
}

let msg = null;
try {
  msg = JSON.parse(fs.readFileSync(payloadFile, 'utf8'));
} catch (e) {
  console.error(`读不到载荷 ${payloadFile}：${e.message}`);
  process.exit(1);
}

fs.mkdirSync(notesDir, { recursive: true });
const file = path.join(notesDir, `${name}.md`);

// 同一条消息重复触发只写一次（hook 冷却失效或者手动重放时会碰到）
let old = '';
try { old = fs.readFileSync(file, 'utf8'); } catch {}
if (old.includes(`<!-- ${msg.msgId} -->`)) {
  process.exit(0);
}

const files = Array.isArray(msg.files) ? msg.files : [];
const ch = msg.channel || {};
const lines = [];
if (!old.trim()) {
  lines.push(`# ${name} 的待办`, '');
  lines.push('这个文件由 AgentChat 的 hooks 自动追加。看到就处理，处理完自己删掉对应段落。', '');
}

// 频道绑了项目的话写在标题行里，不然只看频道名不知道是哪个摊子
const chBits = [];
if (ch.dir) chBits.push(`项目 ${ch.dir}`);
if (ch.note) chBits.push(ch.note);
const chLine = chBits.length ? `（${chBits.join(' · ')}）` : '';

lines.push(`## ${stamp()} · ${msg.project}${chLine} · 来自 ${msg.from}${msg.mentionsAll ? ' · @全体成员' : ''}`);
lines.push(`<!-- ${msg.msgId} -->`);
lines.push('');
lines.push(String(msg.body || '').trim());
if (files.length) {
  lines.push('');
  for (const f of files) {
    lines.push(`- 文件 \`${f.line ? `${f.path}:${f.line}` : f.path}\``);
  }
}
lines.push('');
lines.push('---');
lines.push('');

fs.appendFileSync(file, lines.join('\n'), 'utf8');
console.log(`已记到 ${file}`);
