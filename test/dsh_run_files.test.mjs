// 验 dsh-run.mjs 把载荷里的文件清单渲染成提示词附录的行为。
//
// dsh-run.mjs 是个带顶层副作用的脚本（会 spawn dsh），不能直接 import。
// 所以只把 renderFilesBlock 这一个函数从源码里抽出来单独跑 —— 它只依赖 fs 和
// process.stderr，抽出来是纯函数，测得动。

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, '..', 'src', 'dsh-run.mjs');
const text = fs.readFileSync(SRC, 'utf8');

const begin = text.indexOf('function renderFilesBlock(');
const end = text.indexOf('const base = process.argv');
if (begin < 0 || end < 0 || end <= begin) {
  console.error('抽不出 renderFilesBlock：源码结构变了');
  process.exit(1);
}
const fnSrc = text.slice(begin, end);

// 收集 stderr，验证失败路径不留噪音到真终端
const errs = [];
const fakeProcess = { stderr: { write: (s) => { errs.push(String(s)); } } };
const renderFilesBlock = new Function('fs', 'process', `${fnSrc}\nreturn renderFilesBlock;`)(
  fs,
  fakeProcess,
);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dshrun-'));

function payload(obj) {
  const f = path.join(tmp, `p-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(f, JSON.stringify(obj), 'utf8');
  return f;
}

const cases = [];
const t = (name, fn) => cases.push([name, fn]);

function eq(actual, expect, label) {
  if (actual !== expect) {
    throw new Error(`${label}\n  期望: ${JSON.stringify(expect)}\n  实际: ${JSON.stringify(actual)}`);
  }
}
function has(hay, needle, label) {
  if (!hay.includes(needle)) throw new Error(`${label}\n  找不到: ${JSON.stringify(needle)}\n  实际: ${JSON.stringify(hay)}`);
}
function notHas(hay, needle, label) {
  if (hay.includes(needle)) throw new Error(`${label}\n  不该出现: ${JSON.stringify(needle)}\n  实际: ${JSON.stringify(hay)}`);
}

// 1. 没有载荷路径 → 空串，提示词不加任何尾巴
t('无载荷路径返回空串', () => {
  eq(renderFilesBlock(''), '', '空字符串应返回空串');
});

// 2. 载荷读不出来 → 空串 + stderr 留一行，不炸
t('载荷坏掉返回空串并记 stderr', () => {
  const bad = path.join(tmp, 'bad.json');
  fs.writeFileSync(bad, '{ 不是 json', 'utf8');
  const before = errs.length;
  eq(renderFilesBlock(bad), '', '坏载荷应返回空串');
  eq(errs.length, before + 1, '应写一行 stderr');
  has(errs[errs.length - 1], '[dsh-run] 载荷读不出来', 'stderr 应说明原因');
});

// 3. files 为 null（无法校验）→ 明确说不知道，不能说「没有文件」
t('files 为 null 说无法校验', () => {
  const f = payload({
    files: null,
    fileCandidates: [],
    filesMeta: { version: null, source: null, degraded: false, reasons: ['unsupported-version:string:"3"'] },
  });
  const out = renderFilesBlock(f);
  has(out, '无法校验', '应说明无法校验');
  has(out, '不要假设清单是空的', '应提醒不要假设为空');
  notHas(out, '已确认', '不能出现已确认');
});

// 4. files 为空数组（校验过确实没有）→ 不加任何东西
t('files 空数组不加尾巴', () => {
  const f = payload({
    files: [],
    fileCandidates: [],
    filesMeta: { version: 2, source: 'stored', degraded: false, reasons: [] },
  });
  eq(renderFilesBlock(f), '', '空数组应返回空串');
});

// 5. 已确认单条带行号
t('已确认单条带行号', () => {
  const f = payload({
    files: [{ path: 'E:\\codex\\a.mjs', line: 12, lineEnd: null, raw: 'E:\\codex\\a.mjs:12', quoted: true, occurrences: [] }],
    fileCandidates: [],
    filesMeta: { version: 2, source: 'stored', degraded: false, reasons: [] },
  });
  const out = renderFilesBlock(f);
  has(out, '已确认 1 条', '应报条数');
  has(out, '- E:\\codex\\a.mjs:12', '应带行号');
  notHas(out, '裸写', '带引号的引用不该加裸写备注');
});

// 6. 行号区间
t('行号区间渲染成 :12-34', () => {
  const f = payload({
    files: [{ path: 'E:\\a\\b.mjs', line: 12, lineEnd: 34, raw: 'E:\\a\\b.mjs:12-34', quoted: true, occurrences: [] }],
    fileCandidates: [],
    filesMeta: { version: 2, source: 'stored', degraded: false, reasons: [] },
  });
  has(renderFilesBlock(f), '- E:\\a\\b.mjs:12-34', '区间格式');
});

// 7. 裸写的引用要标出来（边界靠词法判断，可能不准）
t('裸写引用加备注', () => {
  const f = payload({
    files: [{ path: 'E:\\codex\\c.txt', line: null, lineEnd: null, raw: 'E:\\codex\\c.txt', quoted: false, occurrences: [] }],
    fileCandidates: [],
    filesMeta: { version: 2, source: 'stored', degraded: false, reasons: [] },
  });
  has(renderFilesBlock(f), '裸写', '裸写应加备注');
});

// 8. 候选单独一段，且不能混进已确认清单
t('候选单独成段', () => {
  const f = payload({
    files: [{ path: 'E:\\codex\\a.mjs', line: null, lineEnd: null, raw: 'E:\\codex\\a.mjs', quoted: true, occurrences: [] }],
    fileCandidates: [{
      candidatePath: 'E:\\codex\\b.mjs',
      alternatives: ['E:\\codex\\b.mjs', 'E:\\codex\\b.mjs里'],
      reason: 'cjk-ascii-boundary',
      raw: 'E:\\codex\\b.mjs里',
      line: null,
      lineEnd: null,
      occurrences: [],
    }],
    filesMeta: { version: 2, source: 'stored', degraded: false, reasons: [] },
  });
  const out = renderFilesBlock(f);
  has(out, '待确认路径（1 条', '应报候选条数');
  has(out, 'E:\\codex\\b.mjs 或 E:\\codex\\b.mjs里', '两条备选都要列出来');
  has(out, 'cjk-ascii-boundary', '应带原因');
  // 候选段必须排在已确认段之后，且候选路径不能出现在已确认那一段里
  const head = out.slice(0, out.indexOf('待确认路径'));
  notHas(head, 'b.mjs', '候选路径不能进已确认段');
});

// 9. 只有候选、没有已确认文件
t('只有候选时不出已确认段', () => {
  const f = payload({
    files: [],
    fileCandidates: [{
      candidatePath: 'E:\\codex\\d.mjs',
      alternatives: ['E:\\codex\\d.mjs'],
      reason: 'unterminated-quote',
      raw: '"E:\\codex\\d.mjs',
      line: null,
      lineEnd: null,
      occurrences: [],
    }],
    filesMeta: { version: 2, source: 'stored', degraded: false, reasons: [] },
  });
  const out = renderFilesBlock(f);
  notHas(out, '已确认', '没有已确认文件就不出这一段');
  has(out, 'unterminated-quote', '应带原因');
});

// 10. 末尾空行：拼到提示词前面时靠两个换行分隔
t('返回值以两个换行结尾', () => {
  const f = payload({
    files: [{ path: 'E:\\codex\\a.mjs', line: null, lineEnd: null, raw: 'E:\\codex\\a.mjs', quoted: true, occurrences: [] }],
    fileCandidates: [],
    filesMeta: { version: 2, source: 'stored', degraded: false, reasons: [] },
  });
  const out = renderFilesBlock(f);
  eq(out.slice(-2), '\n\n', '应以两个换行结尾');
});

let pass = 0;
const failed = [];
for (const [name, fn] of cases) {
  try {
    fn();
    pass++;
  } catch (e) {
    failed.push([name, e.message]);
  }
}
fs.rmSync(tmp, { recursive: true, force: true });

console.log(`dsh-run 文件清单渲染：通过 ${pass} / 失败 ${failed.length}`);
for (const [n, m] of failed) console.log(`\n✗ ${n}\n${m}`);
process.exit(failed.length ? 1 : 0);
