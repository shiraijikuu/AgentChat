// parseFileRefs / decorateFiles 验收用例。
// 跑法：node E:/codex/AgentChat/test/parse_files.test.mjs
//
// 每条用例都是频道里真实出现过的写法，不是编的。
import { parseFileRefs, decorateFiles } from '../src/store.mjs';

let pass = 0;
const fails = [];

function eq(name, got, want) {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g === w) { pass += 1; return; }
  fails.push(`${name}\n    期望 ${w}\n    实际 ${g}`);
}

function refs(body) {
  const d = parseFileRefs(body);
  return { paths: d.files.map((f) => `${f.path}${f.line ? ':' + f.line : ''}`), cands: d.candidates.length };
}

// ---------- 一、显式分隔优先 ----------
eq('反引号包裹', refs('看 `E:\\a\\b.txt` 这个文件'), { paths: ['E:\\a\\b.txt'], cands: 0 });
eq('双引号包裹带空格', refs('打开 "E:\\my docs\\报告 终稿.docx" 看看'), { paths: ['E:\\my docs\\报告 终稿.docx'], cands: 0 });
eq('尖括号包裹', refs('见 <E:\\x y\\z.log>'), { paths: ['E:\\x y\\z.log'], cands: 0 });
eq('单引号包裹', refs("在 'E:\\it's\\c.txt' 里"), { paths: ["E:\\it's\\c.txt"], cands: 0 });
eq('引号内带行号', refs('`E:\\a\\b.mjs:12-34`'), { paths: ['E:\\a\\b.mjs:12'], cands: 0 });
eq('引号内带行号末行也记', parseFileRefs('`E:\\a\\b.mjs:12-34`').files[0].lineEnd, 34);

// 未闭合的引号：不出 files，只出候选
const unter = parseFileRefs('打开 "E:\\a b\\c.txt 这个');
eq('未闭合引号不进 files', unter.files.length, 0);
eq('未闭合引号出候选', unter.candidates.length, 1);
eq('未闭合引号候选原因', unter.candidates[0].reason, 'unterminated-quote');

// ---------- 二、裸式 ----------
eq('裸路径', refs('文件在 E:\\codex\\a.mjs 里'), { paths: ['E:\\codex\\a.mjs'], cands: 0 });
// 中文紧跟 ASCII 字母属于契约第 3 条的不可判定区，截断 + 标候选是设计行为，不是漏收。
const zhongwen = parseFileRefs('文件在E:\\codex\\a.mjs里');
eq('中文紧跟 ASCII 走候选', [zhongwen.files.length, zhongwen.candidates.length], [0, 1]);
eq('中文紧跟 ASCII 首选截断形态', zhongwen.candidates[0].alternatives[0], 'E:\\codex\\a.mjs');
eq('中文紧跟 ASCII 备选全量形态', zhongwen.candidates[0].alternatives[1], 'E:\\codex\\a.mjs里');
eq('正斜杠', refs('改 E:/codex/AgentChat/src/store.mjs'), { paths: ['E:/codex/AgentChat/src/store.mjs'], cands: 0 });
eq('尾标点剥掉', refs('看 E:\\codex\\a.mjs。'), { paths: ['E:\\codex\\a.mjs'], cands: 0 });
eq('尾逗号剥掉', refs('E:\\codex\\a.mjs, E:\\codex\\b.mjs'), { paths: ['E:\\codex\\a.mjs', 'E:\\codex\\b.mjs'], cands: 0 });

// 协议头不能误收
eq('https 不误收', refs('见 https://302ai.cn/x 这个'), { paths: [], cands: 0 });
eq('ftp 不误收', refs('见 ftp://host/a 这个'), { paths: [], cands: 0 });

// UNC
eq('UNC 保留双反斜杠', parseFileRefs('共享 \\\\server\\share\\a.txt').files[0].path, '\\\\server\\share\\a.txt');
eq('UNC 长前缀', parseFileRefs('\\\\?\\C:\\very\\long\\a.txt').files[0].path, '\\\\?\\C:\\very\\long\\a.txt');

// 重复反斜杠折叠（UNC 前缀不动）
eq('重复反斜杠折叠', parseFileRefs('E:\\\\codex\\\\a.mjs').files[0].path, 'E:\\codex\\a.mjs');

// ---------- 三、CJK 边界：出候选，不猜 ----------
const cjk1 = parseFileRefs('看 E:\\docs\\report最终版.txt 吧');
eq('CJK 紧跟 ASCII：不进 files', cjk1.files.length, 0);
eq('CJK 紧跟 ASCII：出候选', cjk1.candidates.length, 1);
eq('CJK 紧跟 ASCII：候选原因', cjk1.candidates[0].reason, 'cjk-ascii-boundary');
eq('CJK 紧跟 ASCII：候选两个备选', cjk1.candidates[0].alternatives.length, 2);

const cjk2 = parseFileRefs('E:\\codex\\webapi我建立了文件夹');
eq('CJK 紧跟上段也出候选', cjk2.candidates.length >= 1, true);

// CJK 紧跟反斜杠：并入路径，是确定的
eq('中文目录名保住', refs('看 E:\\图片\\raw\\a.ARW 这张'), { paths: ['E:\\图片\\raw\\a.ARW'], cands: 0 });

// ---------- 四、去重与 occurrences ----------
const dupBody = '先看 E:\\a\\b.mjs 再看 E:\\a\\b.mjs';
const dup = parseFileRefs(dupBody);
eq('重复引用合成一条', dup.files.length, 1);
eq('重复引用保留两处', dup.files[0].occurrences.length, 2);
eq('occurrence start 是 UTF-16 下标', dup.files[0].occurrences[1].start, dupBody.lastIndexOf('E:\\a\\b.mjs'));
eq('区间切回原文', dupBody.slice(dup.files[0].occurrences[1].start, dup.files[0].occurrences[1].end), 'E:\\a\\b.mjs');

// 大小写折叠只归组，path 保留首次拼写
const cs = parseFileRefs('E:\\Codex\\A.mjs 和 e:\\codex\\a.mjs');
eq('大小写归组', cs.files.length, 1);
eq('归组后保留首次拼写', cs.files[0].path, 'E:\\Codex\\A.mjs');
eq('打开按字面拼写（第二处）', cs.files[0].occurrences[1].raw, 'e:\\codex\\a.mjs');

// ---------- 五、decorateFiles 四条不变量 ----------
// v2 正常
const v2 = decorateFiles({ body: 'x E:\\a\\b.txt', filesVersion: 2, files: [{ path: 'E:\\a\\b.txt', line: null, lineEnd: null, raw: 'E:\\a\\b.txt', occurrences: [{ start: 2, end: 12, raw: 'E:\\a\\b.txt', line: null, lineEnd: null }] }], fileCandidates: [] });
eq('v2 不降级', [v2.filesMeta.source, v2.filesMeta.degraded], ['stored', false]);

// v2 但区间对不上 → degraded
const v2bad = decorateFiles({ body: 'x E:\\a\\b.txt', filesVersion: 2, files: [{ path: 'E:\\a\\b.txt', line: null, lineEnd: null, raw: 'E:\\zzz', occurrences: [{ start: 2, end: 12, raw: 'E:\\zzz', line: null, lineEnd: null }] }] });
eq('v2 区间不符 → derived+degraded', [v2bad.filesMeta.source, v2bad.filesMeta.degraded], ['derived', true]);

// v1 老记录 → derived，不降级
const v1 = decorateFiles({ body: 'x E:\\a\\b.txt' });
eq('v1 → derived 不算降级', [v1.filesMeta.source, v1.filesMeta.degraded, v1.filesMeta.version], ['derived', false, 1]);
eq('v1 重新解析出 files', v1.files.length, 1);

// 未知版本 → null，不回落 v1
for (const bad of [null, false, 0, 3, '2', undefined]) {
  const r = decorateFiles({ body: 'x E:\\a\\b.txt', filesVersion: bad, files: [{ path: 'E:\\a\\b.txt' }] });
  eq(`版本 ${JSON.stringify(bad)} → files null`, r.files, null);
  eq(`版本 ${JSON.stringify(bad)} → source null`, r.filesMeta.source, null);
  eq(`版本 ${JSON.stringify(bad)} → degraded false`, r.filesMeta.degraded, false);
}

// 不变量：source === null ⟺ files === null
const unk = decorateFiles({ body: 'x', filesVersion: 9 });
eq('不变量 1', unk.files === null && unk.filesMeta.source === null, true);

// ---------- 六、上限 ----------
const many = Array.from({ length: 40 }, (_, i) => `E:\\d\\f${i}.txt`).join(' ');
eq('超过上限截到 20', parseFileRefs(many).files.length, 20);

// ---------- 七、正文为空 / 非字符串 ----------
eq('空正文', refs(''), { paths: [], cands: 0 });
eq('null 正文', refs(null), { paths: [], cands: 0 });
eq('undefined 正文', refs(undefined), { paths: [], cands: 0 });

// ---------- 输出 ----------
console.log(`\n通过 ${pass} / 失败 ${fails.length}`);
if (fails.length) {
  console.log('\n失败用例：');
  for (const f of fails) console.log('  ✗ ' + f);
  process.exit(1);
}
console.log('全部通过');
