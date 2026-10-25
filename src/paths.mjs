// 数据目录解析。
//
// 优先级：环境变量 AGENT_CHAT_DIR → 本机配置 → 调用方给的默认位置。
//
// 早先这里写死了作者自己的盘符路径，别人克隆下来会读到一个不存在的目录，
// 打包给用户也一样。现在源码里不出现任何绝对路径，个性化配置放仓库外面。
//
// 本机配置找几个地方，先找到的算数：
//   <exe 目录>\agentchat.local.json         打包版
//   %USERPROFILE%\.agentchat\config.json    机器级，开发态和打包版都能读到
//   <项目根>\agentchat.local.json           仓库内覆盖，已 gitignore
// 内容长这样：
//   { "dataDir": "D:\\AgentChatData", "defaultName": "me" }

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');

function configCandidates() {
  const list = [];
  // 打包后 src 在 app.asar 里，exe 所在目录才是人真正会放配置的地方
  try {
    list.push(path.join(path.dirname(process.execPath), 'agentchat.local.json'));
  } catch { /* 拿不到就算了 */ }
  list.push(path.join(os.homedir(), '.agentchat', 'config.json'));
  list.push(path.join(ROOT, 'agentchat.local.json'));
  list.push(path.join(process.cwd(), 'agentchat.local.json'));
  return [...new Set(list)];
}

let cached = null;

export function readLocalConfig() {
  if (cached) return cached;
  cached = {};
  for (const file of configCandidates()) {
    try {
      if (!fs.existsSync(file)) continue;
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
        cached = raw;
        break;
      }
    } catch {
      // 配置文件写坏了就当没有。启动不能挂在一个可选文件上。
    }
  }
  return cached;
}

export function resolveDataDir(fallback) {
  const fromEnv = process.env.AGENT_CHAT_DIR;
  if (fromEnv) {
    fs.mkdirSync(fromEnv, { recursive: true });
    return fromEnv;
  }
  const configured = readLocalConfig().dataDir;
  if (typeof configured === 'string' && configured.trim()) {
    const dir = configured.trim();
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }
  const fb = fallback || path.join(process.cwd(), 'data');
  fs.mkdirSync(fb, { recursive: true });
  return fb;
}

// 界面首次打开时用的名字。
//
// 名字一旦发出第一条消息就锁死，所以这个默认值必须能改，不能像以前那样写死在
// 界面里。没配置就用系统用户名，剔掉不合法字符（名字只允许字母数字下划线连字符，
// 中文用户名会整个被剔空），剔空了退到 agent。
export function resolveDefaultName() {
  const configured = readLocalConfig().defaultName;
  if (typeof configured === 'string' && configured.trim()) return configured.trim();
  let name = '';
  try {
    name = String(os.userInfo().username || '').replace(/[^A-Za-z0-9_-]/g, '');
  } catch { /* 有些环境拿不到 */ }
  return name || 'agent';
}
