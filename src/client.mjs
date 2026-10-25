// 客户端。agent 用这个，不用自己拼 curl。
//
// 服务没开就顺手拉起来（headless），开过就直接连。
// 端口不写死，从 _runtime.json 里读，所以服务换端口也不用改脚本。

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { discover } from './lock.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STANDALONE = path.join(HERE, 'standalone.mjs');

// 拉后台服务用哪个 node。
//
// 当前 node 可能挂在别的程序的沙箱里（豆包、编辑器插件、临时解压目录）。
// 那种 node 随宿主退出就没了，路径看着也完全不像 AgentChat，出问题很难查。
// 遇到这种情况换成系统装的 node。
function pickNode() {
  const self = process.execPath;
  const suspicious = /[\\/]sandbox_runtime[\\/]|[\\/]ms-playwright[\\/]|[\\/]\.workbuddy-ai[\\/]|[\\/]Temp[\\/]|[\\/]tmp[\\/]/i;
  if (!suspicious.test(self)) return self;
  const roots = [
    process.env.ProgramFiles,
    process.env['ProgramFiles(x86)'],
    'C:\\Program Files',
  ].filter(Boolean);
  for (const r of roots) {
    const c = path.join(r, 'nodejs', 'node.exe');
    try { if (fs.existsSync(c)) return c; } catch {}
  }
  return self;
}

export class ChatClient {
  constructor({ base, host = '127.0.0.1', port = 7788 }) {
    this.base = base || `http://${host}:${port}`;
  }

  async _call(method, p, body) {
    const res = await fetch(this.base + p, {
      method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let data;
    try { data = text ? JSON.parse(text) : {}; } catch { throw new Error(`服务返回的不是 JSON：${text.slice(0, 200)}`); }
    if (!res.ok) {
      const err = new Error(data.error || `HTTP ${res.status}`);
      err.status = res.status;
      err.retryAfter = data.retryAfter;
      err.code = data.code || null;
      err.agentId = data.agentId || null;
      throw err;
    }
    return data;
  }

  health() { return this._call('GET', '/api/health'); }
  projects() { return this._call('GET', '/api/projects'); }
  // 新建频道。by 是创建人，会顺手算这个频道的成员。
  // dir / title / note 可选，用来把这个频道绑到 AGENTS 下的一个项目。
  createProject(name, opts = {}) {
    const { by = null, dir = null, title = '', note = '' } = typeof opts === 'string' ? { by: opts } : opts;
    return this._call('POST', '/api/projects', { name, by, dir, title, note });
  }
  // 给已有频道补绑项目或改说明
  channelMeta(patch) { return this._call('POST', '/api/channel-meta', patch); }
  // 频道改名。服务端会把消息、成员关系、游标一起迁走
  renameProject(from, to, opts = {}) {
    return this._call('POST', '/api/rename-project', { from, to, by: opts.by || null });
  }
  // 删频道。消息文件挪到 _deleted/ 留底，不真删
  deleteProject(project, opts = {}) {
    return this._call('POST', '/api/delete-project', { project, by: opts.by || null });
  }
  // 建频道时能选的那些项目，来自 AGENTS 目录
  agentsProjects() { return this._call('GET', '/api/agents-projects'); }
  who() { return this._call('GET', '/api/who'); }
  messages(project, opts = {}) {
    const q = new URLSearchParams({ project });
    if (opts.since) q.set('since', opts.since);
    if (opts.limit) q.set('limit', String(opts.limit));
    return this._call('GET', `/api/messages?${q}`);
  }
  inbox(agent, limit, opts = {}) {
    const q = new URLSearchParams({ agent });
    if (limit) q.set('limit', String(limit));
    if (opts.unread) q.set('unread', '1');
    return this._call('GET', `/api/inbox?${q}`);
  }
  // 把收件箱游标推到这条消息，下次就只看到比它更新的 @
  ackInbox(agent, msg) {
    return this._call('POST', '/api/inbox/ack', { agent, lastId: msg.id, lastTs: msg.ts });
  }
  post({ project, from, body, type, replyTo, clientKey, agentKey }) {
    return this._call('POST', '/api/post', { project, from, body, type, replyTo, clientKey, agentKey });
  }
  register(name, project, key) {
    return this._call('POST', '/api/register', { name, project, key });
  }
  // 重新签发 key。等于转移身份，只给「key 丢了、人在本机」用。
  resetKey(name, by) {
    return this._call('POST', '/api/reset-key', { name, by });
  }
  // 把还没锁的老条目一次性锁上。keys 是本地已经存着的 key，服务端会沿用不覆盖。
  seal(by, keys) {
    return this._call('POST', '/api/seal', { by, keys });
  }
  // 从注册表删掉一个名字，释放它。清垃圾条目用。
  forget(name, by) {
    return this._call('POST', '/api/forget', { name, by });
  }
  // 成员。主频道 general 返回全部 agent，其他频道返回该频道的成员。
  members(project) {
    return this._call('GET', `/api/members?project=${encodeURIComponent(project)}`);
  }
  invite(project, name) {
    return this._call('POST', '/api/invite', { project, name });
  }
  kick(project, name) {
    return this._call('POST', '/api/kick', { project, name });
  }
  // @ 到某个名字时要不要拉起它的会话，配置在 <数据目录>/hooks.json
  hooks() {
    return this._call('GET', '/api/hooks');
  }
  getCursor(agent) { return this._call('GET', `/api/cursor?agent=${encodeURIComponent(agent)}`); }
  setCursor(agent, project, lastId) { return this._call('POST', '/api/cursor', { agent, project, lastId }); }

  // 读某个项目里自己还没读过的，读完推进游标。这是 agent 最常用的动作。
  async pull(agent, project, limit = 100) {
    const { cursor } = await this.getCursor(agent);
    const since = cursor && cursor[project] ? cursor[project].lastId : null;
    const d = await this.messages(project, { since, limit });
    if (d.messages.length) {
      await this.setCursor(agent, project, d.messages[d.messages.length - 1].id);
    }
    // channel 一起带出去，调用方要打印「这个频道是干什么的」
    return { since, channel: d.channel || null, messages: d.messages };
  }
}

// 找服务，找不到就起一个后台的
export async function ensureServer({ dir, host = '127.0.0.1', port = 7788, waitMs = 8000 } = {}) {
  const live = await discover(dir, host);
  if (live) return { base: `http://${host}:${live.port}`, port: live.port, started: false };

  const env = { ...process.env, AGENT_CHAT_DIR: dir, AGENT_CHAT_PORT: String(port), AGENT_CHAT_HOST: host };
  const node = pickNode();
  const child = spawn(node, [STANDALONE], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env,
  });
  child.unref();

  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 200));
    const again = await discover(dir, host);
    if (again) return { base: `http://${host}:${again.port}`, port: again.port, started: true, node };
  }
  throw new Error(`服务没起来，试了 ${waitMs}ms。手动跑 npm run serve 看报错。`);
}
