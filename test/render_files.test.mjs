// 从 ui/index.html 里抽出渲染函数，离线验一遍。
// 跑法：node E:/codex/AgentChat/test/render_files.test.mjs
//
// 不启浏览器、不起服务，只验证「服务端给的 files/occurrences 能不能正确变成 HTML」。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const html = fs.readFileSync(path.join(HERE, '..', 'ui', 'index.html'), 'utf8');

// 抽出从 escapeHtml 到 fmtTime 之间的那一段（纯函数，不碰 DOM）。
const start = html.indexOf('function escapeHtml(s)');
const end = html.indexOf('function fmtTime(ts)');
if (start < 0 || end < 0 || end <= start) {
  console.error('没找到要抽的函数段，index.html 结构变了？');
  process.exit(1);
}
const src = html.slice(start, end);
const factory = new Function(src + '\nreturn { escapeHtml, pathHref, bodyHtml, decorateBody };');
const { bodyHtml, decorateBody, pathHref } = factory();

let pass = 0;
const fails = [];
function ok(name, cond, detail = '') {
  if (cond) { pass += 1; return; }
  fails.push(name + (detail ? `：${detail}` : ''));
}

function file(pathStr, occurrences, line = null, lineEnd = null) {
  return { path: pathStr, line, lineEnd, raw: occurrences[0].raw, occurrences };
}

// ---- 1 已确认引用变成链接 ----
{
  const body = '看 E:\\codex\\a.mjs 这个';
  const a = body.indexOf('E:\\codex\\a.mjs');
  const m = {
    body,
    files: [file('E:\\codex\\a.mjs', [{ start: a, end: a + 'E:\\codex\\a.mjs'.length, raw: 'E:\\codex\\a.mjs', line: null, lineEnd: null }])],
    fileCandidates: [],
    filesMeta: { version: 2, source: 'stored', degraded: false, reasons: [] },
  };
  const d = decorateBody(body, m);
  ok('已确认引用渲染成 a.fref', d.html.includes('class="fref"'), d.html);
  ok('链接 href 是 file:///', d.html.includes('href="file:///E:/codex/a.mjs"'), d.html);
  ok('data-path 带原路径', d.html.includes('data-path="E:\\codex\\a.mjs"'), d.html);
  ok('stored 不产生说明', d.note === '', d.note);
  ok('正文其余部分保留', d.html.includes('看 ') && d.html.includes(' 这个'));
}

// ---- 2 候选只标待确认，不做链接 ----
{
  const body = '看 E:\\docs\\report最终版.txt 吧';
  const a = body.indexOf('E:\\docs');
  const m = {
    body,
    files: [],
    fileCandidates: [{
      candidatePath: 'E:\\docs\\report',
      alternatives: ['E:\\docs\\report', 'E:\\docs\\report最终版.txt'],
      reason: 'cjk-ascii-boundary',
      raw: 'E:\\docs\\report',
      line: null, lineEnd: null,
      occurrences: [{ start: a, end: a + 16, raw: 'E:\\docs\\report', line: null, lineEnd: null }],
    }],
    filesMeta: { version: 2, source: 'stored', degraded: false, reasons: [] },
  };
  const d = decorateBody(body, m);
  ok('候选不进 href', !d.html.includes('href="file:///'), d.html);
  ok('候选带 cand 类', d.html.includes('fref cand'), d.html);
  ok('候选标待确认', d.html.includes('待确认'), d.html);
  ok('候选备选进 title', d.html.includes('E:\\docs\\report最终版.txt'), d.html);
  ok('候选产生说明', d.note.includes('待确认'), d.note);
}

// ---- 3 老消息 derived 挂说明 ----
{
  const body = 'E:\\a\\b.txt';
  const m = {
    body,
    files: [file('E:\\a\\b.txt', [{ start: 0, end: 10, raw: 'E:\\a\\b.txt', line: null, lineEnd: null }])],
    fileCandidates: [],
    filesMeta: { version: 1, source: 'derived', degraded: false, reasons: [] },
  };
  const d = decorateBody(body, m);
  ok('derived 挂老消息说明', d.note.includes('老消息'), d.note);
}

// ---- 4 未知版本：不装饰、不回落、挂说明 ----
{
  const body = '看 E:\\codex\\a.mjs 这个';
  const m = {
    body, files: null, fileCandidates: null,
    filesMeta: { version: null, source: null, degraded: false, reasons: ['unsupported-version:string:"2"'] },
  };
  const d = decorateBody(body, m);
  ok('未知版本不出链接', !d.html.includes('href="file:///'), d.html);
  ok('未知版本正文照原样', d.html.includes('E:\\codex\\a.mjs'), d.html);
  ok('未知版本挂说明', d.note.includes('无法校验'), d.note);
  ok('未知版本不降级标注', !d.note.includes('降级'), d.note);
}

// ---- 5 代码块里的引用不变成链接 ----
{
  const body = '```\nlet p = "E:\\codex\\a.mjs";\n```\n外面 E:\\codex\\b.mjs';
  const a1 = body.indexOf('E:\\codex\\a.mjs');
  const a2 = body.indexOf('E:\\codex\\b.mjs');
  const m = {
    body,
    files: [
      file('E:\\codex\\a.mjs', [{ start: a1, end: a1 + 'E:\\codex\\a.mjs'.length, raw: 'E:\\codex\\a.mjs', line: null, lineEnd: null }]),
      file('E:\\codex\\b.mjs', [{ start: a2, end: a2 + 'E:\\codex\\b.mjs'.length, raw: 'E:\\codex\\b.mjs', line: null, lineEnd: null }]),
    ],
    fileCandidates: [],
    filesMeta: { version: 2, source: 'stored', degraded: false, reasons: [] },
  };
  const d = decorateBody(body, m);
  ok('代码块里的路径不变成链接', !d.html.includes('file:///E:/codex/a.mjs'), d.html);
  ok('代码块内容原样保留', d.html.includes('let p = &quot;E:\\codex\\a.mjs&quot;'), d.html);
  ok('代码块外的路径仍成链接', d.html.includes('file:///E:/codex/b.mjs'), d.html);
}

// ---- 6 行号带进 data-path 但不进 href ----
{
  const body = 'E:\\a\\b.mjs:12-34';
  const m = {
    body,
    files: [file('E:\\a\\b.mjs', [{ start: 0, end: 'E:\\a\\b.mjs:12-34'.length, raw: 'E:\\a\\b.mjs:12-34', line: 12, lineEnd: 34 }], 12, 34)],
    fileCandidates: [],
    filesMeta: { version: 2, source: 'stored', degraded: false, reasons: [] },
  };
  const d = decorateBody(body, m);
  ok('data-path 带行号', d.html.includes('data-path="E:\\a\\b.mjs:12-34"'), d.html);
  ok('href 不带行号', d.html.includes('href="file:///E:/a/b.mjs"'), d.html);
}

// ---- 7 转义：路径里的 & 和引号 ----
{
  const body = 'E:\\a&b\\c.txt';
  const m = {
    body,
    files: [file('E:\\a&b\\c.txt', [{ start: 0, end: 'E:\\a&b\\c.txt'.length, raw: 'E:\\a&b\\c.txt', line: null, lineEnd: null }])],
    fileCandidates: [],
    filesMeta: { version: 2, source: 'stored', degraded: false, reasons: [] },
  };
  const d = decorateBody(body, m);
  ok('& 被转义', d.html.includes('&amp;'), d.html);
  ok('没有裸 &', !/[^&]&[^a-z#]/.test(d.html.replace(/&amp;/g, '')), d.html);
}

// ---- 8 空正文 ----
{
  const d = decorateBody('', { body: '', files: [], fileCandidates: [], filesMeta: { version: 2, source: 'stored', degraded: false, reasons: [] } });
  ok('空正文不炸', typeof d.html === 'string' && d.html === '');
}

// ---- 9 @ 与加粗仍然工作 ----
{
  const body = '@codex 看 **E:\\a\\b.txt**';
  const m = { body, files: [], fileCandidates: [], filesMeta: { version: 2, source: 'stored', degraded: false, reasons: [] } };
  const d = decorateBody(body, m);
  ok('@ 仍然高亮', d.html.includes('<span class="at">@codex</span>'), d.html);
  ok('加粗仍然生效', d.html.includes('<strong>'), d.html);
}

// ---- 10 pathHref ----
ok('pathHref 反斜杠转正斜杠', pathHref('E:\\a\\b.mjs') === 'file:///E:/a/b.mjs');
ok('pathHref 去行号', pathHref('E:\\a\\b.mjs:12') === 'file:///E:/a/b.mjs');
ok('pathHref 去行号区间', pathHref('E:\\a\\b.mjs:12-34') === 'file:///E:/a/b.mjs');

console.log(`\n通过 ${pass} / 失败 ${fails.length}`);
if (fails.length) {
  console.log('\n失败用例：');
  for (const f of fails) console.log('  ✗ ' + f);
  process.exit(1);
}
console.log('全部通过');
