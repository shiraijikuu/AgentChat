// 把数据目录上一层的 AGENTS 目录里有哪些项目列出来，给「建频道时绑一个项目」用。
//
// 目的是解决「光看频道名不知道这个频道是干什么的」。
// 项目名之外还能拿到工作区和当前状态，这些都来自 AGENTS\INDEX.md 的表格。
// INDEX.md 是人工维护的，格式变了这里会读不到，所以解析失败就当没有，不影响主流程。

import fs from 'node:fs';
import path from 'node:path';
import { readLocalConfig } from './paths.mjs';

// 项目根目录在哪。
//
// 三种给法，优先级从高到低：环境变量、配置文件里的 agentsDir、数据目录往上退一层。
// 加配置文件这一条是因为别人装完默认数据目录在 <程序目录>\data\chat，
// 退一层得到 <程序目录>\data，那里只有自家目录，不是项目根。让普通用户为了绑一个
// 项目去设系统环境变量太别扭了，写进 agentchat.local.json 就行。
export function agentsRoot(dataDir) {
  const fromEnv = process.env.AGENT_CHAT_AGENTS_DIR;
  if (fromEnv) return fromEnv;
  const fromConfig = readLocalConfig().agentsDir;
  if (typeof fromConfig === 'string' && fromConfig.trim()) return fromConfig.trim();
  return path.dirname(dataDir);
}

// 不是项目、不该出现在绑定列表里的目录。
//
// 自家数据目录和缓存目录要按名字排掉：退一层算出来的根目录有可能就是程序的 data/，
// 里面正好有 chat 和 cache，不排掉的话下拉框里会冒出「cache」这种能绑的假项目。
function skipNames(dataDir) {
  return new Set(['chat', '_archive', 'node_modules', '.git', 'cache', path.basename(dataDir)]);
}

/**
 * 解析 INDEX.md 的项目表格。
 * 表格长这样：
 *   | 项目 | 工作区 | 当前状态 | 日记 | 总结 |
 *   | myproject | `D:\work\myproject` | 开发中 | 23 篇 | 5 份 |
 * 只取前三列，后面两列是统计，会变，不当描述用。
 */
function parseIndex(file) {
  const out = {};
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { return out; }

  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t.startsWith('|')) continue;
    const cols = t.split('|').map((c) => c.trim());
    // split 后首尾是空串：['', 'lumedit', '`E:\...`', '状态', ...]
    if (cols.length < 5) continue;
    const name = cols[1];
    if (!name || name === '项目' || /^-+$/.test(name)) continue;
    if (!/^[A-Za-z0-9_-]+$/.test(name)) continue;
    out[name] = {
      workspace: cols[2].replace(/`/g, ''),
      status: cols[3],
    };
  }
  return out;
}

export function listAgentProjects(dataDir) {
  const root = agentsRoot(dataDir);
  const SKIP = skipNames(dataDir);
  let dirs = [];
  try {
    dirs = fs.readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !SKIP.has(e.name) && !e.name.startsWith('_'))
      .map((e) => e.name)
      .filter((n) => /^[A-Za-z0-9_-]+$/.test(n))
      .sort();
  } catch {
    return { root, projects: [] };
  }

  const index = parseIndex(path.join(root, 'INDEX.md'));

  const projects = dirs.map((name) => {
    const meta = index[name] || {};
    // 总结目录里到底有几份东西。
    //
    // 只认 PROJECT-SUMMARY.md 会误判：多数项目用「说明书01-xxx.md」「00-xxx经验总结.txt」
    // 这类文件名，按那个判断的话界面上大部分项目会标成「没写总结」，明明都有内容。
    // 所以数文件，另外单独标出有没有那份统一的。
    const summaryDir = path.join(root, name, '总结');
    let summaryCount = 0;
    try {
      for (const f of fs.readdirSync(summaryDir)) {
        if (!/\.(md|txt)$/i.test(f)) continue;
        let st = null;
        try { st = fs.statSync(path.join(summaryDir, f)); } catch {}
        if (st && st.isFile()) summaryCount += 1;
      }
    } catch {}
    let hasSummary = false;
    try { hasSummary = fs.statSync(path.join(summaryDir, 'PROJECT-SUMMARY.md')).isFile(); } catch {}
    return {
      name,
      workspace: meta.workspace || '',
      status: meta.status || '',
      // hasSummary 专指那份统一命名的接手文档，summaryCount 是目录里的实际份数
      hasSummary,
      summaryCount,
      dir: path.join(root, name),
    };
  });

  return { root, projects };
}
