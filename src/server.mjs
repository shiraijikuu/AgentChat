// HTTP 服务。只有一个实例能跑起来，见 lock.mjs。
// 所有写操作都经过这里，agent 不许直接改 jsonl。

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { Store, nowIso, MAIN_PROJECT, isValidName } from './store.mjs';
import { Hooks } from './hooks.mjs';
import { listAgentProjects } from './agentsDirs.mjs';
import { readKey, saveKey } from './keys.mjs';
import { tryAcquireLock, writeRuntime, clearRuntime, releaseLock, discover } from './lock.mjs';
import { DEFAULT_APP_SETTINGS } from '../electron/app-settings.mjs';
import { resolveDefaultName } from './paths.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const UI_DIR = path.join(HERE, '..', 'ui');
const APP = 'agent-chat';

// 版本号从包里的 package.json 读。打包时 dist.mjs 用 -c.extraMetadata 把 buildNumber
// 写进产物里那份 package.json，所以开发态（没有 buildNumber）显示 build 0，
// 装好的包显示真实 build 号。反过来说，界面上看到 build 0 就是没走打包直接跑的。
let pkg = {};
try { pkg = createRequire(import.meta.url)('../package.json'); } catch { pkg = {}; }
const APP_VERSION = typeof pkg.version === 'string' ? pkg.version : '0.0.0';
const APP_BUILD = Number.isFinite(pkg.buildNumber) ? pkg.buildNumber : 0;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
};

function sendJson(res, code, obj, extraHeaders) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...(extraHeaders || {}),
  });
  res.end(body);
}

function readBody(req, limit = 65536) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('body 太大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch { reject(new Error('JSON 解析失败')); }
    });
    req.on('error', reject);
  });
}

// 身份既可以从 body 带，也可以从 header 带。
//
// 很多人直觉是把 key 放 Authorization，写脚本的时候手一滑就放 header 了，
// 服务端只认 body 的话会被静默忽略，然后报「名字被占用」，排查起来很费劲。
// 这里三种都收：body 的 agentKey、Authorization: Bearer、x-agent-key。
// body 优先，因为那是显式写的。
function headerKey(req) {
  const auth = String(req.headers.authorization || '');
  if (/^bearer\s+/i.test(auth)) return auth.replace(/^bearer\s+/i, '').trim() || null;
  const xk = String(req.headers['x-agent-key'] || '').trim();
  return xk || null;
}

function headerName(req) {
  const n = String(req.headers['x-agent-name'] || '').trim();
  return n || null;
}

// 把 body 和 header 合成一份身份参数。body 里显式给了就用 body。
function identityOf(req, body) {
  return {
    name: body.name || body.from || headerName(req) || null,
    key: body.agentKey || body.key || headerKey(req) || null,
  };
}

function serveStatic(res, urlPath) {
  let rel = urlPath === '/' ? 'index.html' : decodeURIComponent(urlPath.slice(1));
  if (rel.includes('..')) { res.writeHead(403); return res.end('forbidden'); }
  const full = path.join(UI_DIR, rel);
  if (!full.startsWith(UI_DIR)) { res.writeHead(403); return res.end('forbidden'); }
  if (!fs.existsSync(full) || fs.statSync(full).isDirectory()) { res.writeHead(404); return res.end('not found'); }
  res.writeHead(200, {
    'content-type': MIME[path.extname(full)] || 'application/octet-stream',
    'cache-control': 'no-store',
  });
  fs.createReadStream(full).pipe(res);
}

function listenOnce(port, host) {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    server.once('error', (e) => { try { server.close(); } catch {} reject(e); });
    server.listen(port, host, () => {
      server.removeAllListeners('error');
      resolve(server);
    });
  });
}

export async function startServer({ dir, port = 7788, host = '127.0.0.1', portSpan = 12, onLog = () => {}, reuse = true, updater = null, appSettings = null, onAppSettings = null } = {}) {
  // 已经有一个活着的服务就复用它，不再起第二个
  if (reuse) {
    const live = await discover(dir, host);
    if (live) {
      onLog(`已有实例在跑，直接复用 ${host}:${live.port}（pid ${live.pid}）`);
      // 复用别人起的服务，本进程准备好的 updater、appSettings 一个都用不上，
      // 能力以那个实例为准。最常见的踩法是源码态服务占着端口，桌面版贴上去，
      // 界面上就显示「这个模式下没有更新能力」。这里至少要在日志里说清楚。
      const liveBuild = Number(live.health?.build);
      if (liveBuild !== Number(APP_BUILD)) {
        onLog(`注意：复用实例是 build ${liveBuild}，本进程是 build ${APP_BUILD}，更新和桌面设置能力以那个实例为准`);
      }
      if (live.electron === false) {
        onLog('注意：复用实例是源码态服务（不是桌面版），没有更新能力');
      }
      return { port: live.port, host, instanceId: live.instanceId, reused: true, close: async () => {}, store: new Store(dir) };
    }
  }

  const store = new Store(dir);
  const hooks = new Hooks(dir);
  // 老数据没把发言记进成员表，启动时补一次，补完写标记，以后不再扫
  try {
    const bf = store.backfillMembership();
    if (!bf.skipped && bf.fixed) onLog(`成员回填：从历史消息补了 ${bf.fixed} 条频道归属`);
  } catch {}
  const got = tryAcquireLock(dir, { pid: process.pid, port, instanceId: store.instanceId });
  if (!got) {
    const live = await discover(dir, host);
    if (live && reuse) {
      onLog(`锁被 pid ${live.pid} 持有，复用 ${host}:${live.port}`);
      return { port: live.port, host, instanceId: live.instanceId, reused: true, close: async () => {}, store };
    }
    throw new Error('另一个实例正在启动，稍后再试');
  }

  const clients = new Set();
  const broadcast = (payload) => {
    const data = `data: ${JSON.stringify(payload)}\n\n`;
    for (const res of clients) {
      try { res.write(data); } catch { clients.delete(res); }
    }
  };

  const handler = async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const p = url.pathname;

    try {
      if (p === '/api/health') {
        return sendJson(res, 200, {
          ok: true,
          app: APP,
          version: APP_VERSION,
          build: APP_BUILD,
          instanceId: store.instanceId,
          pid: process.pid,
          port: actualPort,
          host,
          dir,
          startedAt,
          uptime: Math.round(process.uptime()),
          // 界面第一次打开时用它当自己的名字。以前这个名字写死在界面里，
          // 谁下载下来都叫作者那个名字，还改不掉，因为名字发第一条消息就锁死。
          defaultName: resolveDefaultName(),
        });
      }

      if (p === '/api/projects' && req.method === 'GET') {
        // agents 只给界面用的字段，keyHash 不外发
        const agents = {};
        for (const [name, a] of Object.entries(store.registry())) {
          agents[name] = { id: a.id, projects: a.projects, locked: !!a.keyHash, lastSeen: a.lastSeen };
        }
        return sendJson(res, 200, { projects: store.listProjects(), agents });
      }

      if (p === '/api/projects' && req.method === 'POST') {
        const b = await readBody(req);
        const id = identityOf(req, b);
        const r = store.createProject(b.name, {
          by: b.by || id.name || null,
          dir: b.dir || null,
          title: b.title || '',
          note: b.note || '',
        });
        return sendJson(res, 200, { ok: true, ...r });
      }

      // 建频道时能选的那些项目。来自 AGENTS 目录 + INDEX.md 的表格。
      if (p === '/api/agents-projects') {
        return sendJson(res, 200, listAgentProjects(dir));
      }

      // 给已经存在的频道补绑项目，或者改说明
      if (p === '/api/channel-meta' && req.method === 'POST') {
        const b = await readBody(req);
        const id = identityOf(req, b);
        if (!b.project) return sendJson(res, 400, { error: '要传 project' });
        const meta = store.setChannelMeta(b.project, {
          ...('dir' in b ? { dir: b.dir } : {}),
          ...('title' in b ? { title: b.title } : {}),
          ...('note' in b ? { note: b.note } : {}),
        }, { by: b.by || id.name || null });
        return sendJson(res, 200, { ok: true, project: b.project, meta });
      }

      // 频道改名。消息里的 project 字段、成员关系、游标一起迁，别留半截旧名字。
      if (p === '/api/rename-project' && req.method === 'POST') {
        const b = await readBody(req);
        const id = identityOf(req, b);
        const r = store.renameProject(b.project || b.from, b.name || b.to, {
          by: b.by || id.name || null,
        });
        broadcast({ kind: 'refresh' });
        return sendJson(res, 200, { ok: true, ...r });
      }

      // 删频道。消息文件挪到 _deleted/ 留底，真删不掉数据。
      if (p === '/api/delete-project' && req.method === 'POST') {
        const b = await readBody(req);
        const id = identityOf(req, b);
        if (!b.project) return sendJson(res, 400, { error: '要传 project' });
        const r = store.deleteProject(b.project, { by: b.by || id.name || null });
        broadcast({ kind: 'refresh' });
        return sendJson(res, 200, { ok: true, ...r });
      }

      // 界面的身份 key 存在数据目录里，不放 localStorage。
      //
      // localStorage 绑 origin，界面跑在 http://127.0.0.1:端口 上，端口一变就是另一份存储，
      // 换安装目录 userData 变了也一样。表现就是每次重进都要重新接管名字。
      // 数据目录固定，key 放这儿就不受端口和安装位置影响，CLI 和界面也共用同一把。
      //
      // 明文返回。能访问 127.0.0.1 的人本来就能读这个文件，加密只是骗自己。
      if (p === '/api/key' && req.method === 'GET') {
        const name = url.searchParams.get('name');
        if (!isValidName(name)) return sendJson(res, 400, { error: '名字只能用字母、数字、下划线、连字符' });
        return sendJson(res, 200, { name, key: readKey(dir, name) });
      }

      if (p === '/api/key' && req.method === 'POST') {
        const b = await readBody(req);
        if (!isValidName(b.name)) return sendJson(res, 400, { error: '名字只能用字母、数字、下划线、连字符' });
        if (!b.key) return sendJson(res, 400, { error: '要传 key' });
        const saved = saveKey(dir, b.name, b.key);
        return sendJson(res, 200, { ok: true, name: b.name, saved });
      }

      if (p === '/api/who') {
        // keyHash 不外发。对外只说锁没锁，够用了。
        const reg = store.registry();
        const agents = {};
        for (const [name, a] of Object.entries(reg)) {
          agents[name] = {
            id: a.id,
            createdAt: a.createdAt,
            lastSeen: a.lastSeen,
            projects: a.projects,
            locked: !!a.keyHash,
            lockedAt: a.lockedAt || null,
            resetCount: a.resetCount || 0,
          };
        }
        return sendJson(res, 200, { agents });
      }

      if (p === '/api/messages') {
        const project = url.searchParams.get('project') || 'general';
        const messages = store.readMessages(project, {
          since: url.searchParams.get('since') || null,
          limit: url.searchParams.get('limit'),
        });
        // 把频道是干什么的一起返回。agent 光看消息内容不知道 qqbot 是哪个项目，
        // 带上这个它就知道该用什么背景理解这些消息。
        return sendJson(res, 200, { project, channel: store.channelOf(project), count: messages.length, messages });
      }

      if (p === '/api/inbox') {
        const agent = url.searchParams.get('agent');
        if (!agent) return sendJson(res, 400, { error: '要传 agent' });
        const unreadOnly = url.searchParams.get('unread') === '1';
        const { messages, total } = store.inbox(agent, url.searchParams.get('limit'), { unreadOnly });
        // 收件箱跨频道，所以把这次涉及到的频道说明一起带上
        const channels = {};
        for (const m of messages) {
          if (!channels[m.project]) channels[m.project] = store.channelOf(m.project);
        }
        // count 是这一页几条，total 是符合条件的总数。两个不一样就说明还有没列出来的，
        // 调用方接着再跑一次 inbox 就行，游标会把它往后推。
        return sendJson(res, 200, { agent, unreadOnly, count: messages.length, total, channels, messages });
      }

      if (p === '/api/inbox/ack' && req.method === 'POST') {
        const b = await readBody(req);
        const cur = store.ackInbox(b.agent, { id: b.lastId, ts: b.lastTs });
        return sendJson(res, 200, { ok: true, cursor: cur });
      }

      if (p === '/api/cursor' && req.method === 'GET') {
        const agent = url.searchParams.get('agent');
        if (!agent) return sendJson(res, 400, { error: '要传 agent' });
        return sendJson(res, 200, { agent, cursor: store.getCursor(agent) });
      }

      if (p === '/api/cursor' && req.method === 'POST') {
        const b = await readBody(req);
        const c = store.setCursor(b.agent, b.project, b.lastId);
        return sendJson(res, 200, { ok: true, cursor: c });
      }

      if (p === '/api/post' && req.method === 'POST') {
        const b = await readBody(req);
        const id = identityOf(req, b);
        const { msg, deduped, agent, agentKey } = store.post({
          project: b.project,
          from: id.name,
          body: b.body,
          type: b.type,
          replyTo: b.replyTo,
          clientKey: b.clientKey,
          agentKey: id.key,
        });
        if (!deduped) broadcast({ kind: 'message', project: msg.project, msg });
        // @ 到配了启动命令的人，就把他的会话拉起来。重复提交不重复拉。
        if (!deduped) {
          try { hooks.fire(msg, store.channelOf(msg.project)); } catch (e) { /* 触发失败不能影响发消息 */ }
        }
        // agent 里带 keyHash，不外发。agentKey 只在服务端签发的那一次出现，明文。
        return sendJson(res, 200, {
          ok: true,
          deduped,
          msg,
          agent: agent ? {
            id: agent.id,
            createdAt: agent.createdAt,
            lastSeen: agent.lastSeen,
            projects: agent.projects,
            locked: !!agent.keyHash,
          } : null,
          agentKey: agentKey || null,
        });
      }

      if (p === '/api/register' && req.method === 'POST') {
        const b = await readBody(req);
        const id = identityOf(req, b);
        const r = store.registerAgent(id.name, { project: b.project, key: id.key });
        return sendJson(res, 200, {
          ok: true,
          created: r.created,
          claimed: r.claimed,
          usable: r.usable,
          key: r.key,
          agent: {
            id: r.agent.id,
            createdAt: r.agent.createdAt,
            lastSeen: r.agent.lastSeen,
            projects: r.agent.projects,
            locked: !!r.agent.keyHash,
          },
        });
      }

      if (p === '/api/reset-key' && req.method === 'POST') {
        const b = await readBody(req);
        const id = identityOf(req, b);
        const r = store.resetAgentKey(id.name, { by: b.by || 'api' });
        return sendJson(res, 200, {
          ok: true,
          key: r.key,
          agent: {
            id: r.agent.id,
            createdAt: r.agent.createdAt,
            locked: true,
            resetCount: r.agent.resetCount,
          },
        });
      }

      if (p === '/api/seal' && req.method === 'POST') {
        const b = await readBody(req);
        const sealed = store.sealUnlockedAgents({ by: b.by || 'api', keys: b.keys || {} });
        return sendJson(res, 200, {
          ok: true,
          count: sealed.length,
          sealed: sealed.map((s) => ({ name: s.name, id: s.id, key: s.key, adopted: s.adopted })),
        });
      }

      if (p === '/api/forget' && req.method === 'POST') {
        const b = await readBody(req);
        const id = identityOf(req, b);
        const r = store.forgetAgent(id.name, { by: b.by || 'api' });
        return sendJson(res, 200, { ok: true, ...r });
      }

      if (p === '/api/members' && req.method === 'GET') {        const project = url.searchParams.get('project') || MAIN_PROJECT;
        const members = store.membersOf(project);
        return sendJson(res, 200, {
          project,
          main: project === MAIN_PROJECT,
          count: members.length,
          members,
        });
      }

      if (p === '/api/invite' && req.method === 'POST') {
        const b = await readBody(req);
        const r = store.inviteToProject(b.project, b.name);
        return sendJson(res, 200, { ok: true, ...r });
      }

      if (p === '/api/kick' && req.method === 'POST') {
        const b = await readBody(req);
        const r = store.removeFromProject(b.project, b.name);
        return sendJson(res, 200, { ok: true, ...r });
      }

      if (p === '/api/hooks' && req.method === 'GET') {
        return sendJson(res, 200, {
          file: path.join(dir, 'hooks.json'),
          exists: fs.existsSync(path.join(dir, 'hooks.json')),
          hooks: hooks.list(),
        });
      }

      if (p === '/api/stream') {
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
          'x-accel-buffering': 'no',
        });
        res.write(`data: ${JSON.stringify({ kind: 'hello', instanceId: store.instanceId })}\n\n`);
        clients.add(res);
        const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 25000);
        req.on('close', () => { clearInterval(ping); clients.delete(res); });
        return;
      }

      if (p === '/api/update' && req.method === 'GET') {
        if (!updater) {
          // build 0 是源码态（node src/standalone.mjs 或者 npm run serve），
          // 没有 Electron 外壳，也就没有更新器。桌面版要是发现端口已经被这种
          // 服务占着，会直接复用，同样会走到这里，所以文案得把这一点说出来。
          const message = Number(APP_BUILD) === 0
            ? '当前连的是源码态服务（build 0），更新能力只在桌面版里有。桌面版如果发现端口已被它占着会直接复用，也会看到这一条。'
            : '这个模式下没有更新能力';
          return sendJson(res, 200, { phase: 'disabled', message, packaged: false, localBuild: APP_BUILD });
        }
        // 带 check=1 才真去拉清单。不带就只读当前状态，界面轮询进度用这个。
        if (url.searchParams.get('check') === '1') {
          return sendJson(res, 200, await updater.check());
        }
        return sendJson(res, 200, updater.snapshot());
      }

      if (p === '/api/update/download' && req.method === 'POST') {
        if (!updater) return sendJson(res, 400, { error: '这个模式下没有更新能力' });
        try {
          return sendJson(res, 200, await updater.download());
        } catch (e) {
          return sendJson(res, 400, { error: e.message, state: updater.snapshot() });
        }
      }

      if (p === '/api/update/install' && req.method === 'POST') {
        if (!updater) return sendJson(res, 400, { error: '这个模式下没有更新能力' });
        try {
          return sendJson(res, 200, updater.install());
        } catch (e) {
          return sendJson(res, 400, { error: e.message });
        }
      }

      if (p === '/api/app-settings' && req.method === 'GET') {
        return sendJson(res, 200, {
          available: !!appSettings,
          ...(appSettings ? appSettings.snapshot() : JSON.parse(JSON.stringify(DEFAULT_APP_SETTINGS))),
        });
      }

      if (p === '/api/app-settings' && req.method === 'POST') {
        if (!appSettings) return sendJson(res, 400, { error: '这个模式下不能保存桌面设置' });
        const body = await readBody(req);
        try {
          const next = appSettings.update(body);
          // 主进程要靠这个回调重画标题栏配色，不然浅色模式下上面还压着一条黑边
          try { onAppSettings?.(next); } catch (e) { onLog(`设置回调失败：${e.message}`); }
          return sendJson(res, 200, { available: true, ...next });
        } catch (e) {
          return sendJson(res, 400, { error: e.message, available: true, ...appSettings.snapshot() });
        }
      }

      if (p.startsWith('/api/')) return sendJson(res, 404, { error: '没有这个接口' });
      return serveStatic(res, p);
    } catch (e) {
      const code = e.code === 'RATE_LIMIT' ? 429
        : e.code === 'NAME_TAKEN' ? 409
        : e.code === 'NAME_RESERVED' ? 400
        : e.code === 'PROJECT_EXISTS' ? 409
        : e.code === 'PROJECT_MISSING' ? 404
        : e.code === 'MAIN_PROJECT' ? 403
        : 400;
      return sendJson(res, code, {
        error: e.message,
        code: e.code || null,
        retryAfter: e.retryAfter || null,
        agentId: e.agentId || null,
      });
    }
  };

  let actualPort = port;
  let server = null;
  const startedAt = nowIso();

  for (let i = 0; i < portSpan; i += 1) {
    const tryPort = port + i;
    try {
      server = await listenOnce(tryPort, host);
      server.on('request', handler);
      actualPort = tryPort;
      break;
    } catch (e) {
      if (e.code !== 'EADDRINUSE' && e.code !== 'EACCES') {
        releaseLock(dir);
        throw e;
      }
      onLog(`端口 ${tryPort} 被占，试下一个`);
    }
  }

  if (!server) {
    releaseLock(dir);
    throw new Error(`端口 ${port} 到 ${port + portSpan - 1} 全被占，起不来`);
  }

  // 目录变动兜底：外部工具直接改文件时也能推给前端
  let watchTimer = null;
  let watcher = null;
  try {
    watcher = fs.watch(dir, () => {
      clearTimeout(watchTimer);
      watchTimer = setTimeout(() => {
        try { broadcast({ kind: 'refresh', projects: store.listProjects() }); } catch {}
      }, 300);
    });
  } catch {}

  const info = {
    app: APP,
    pid: process.pid,
    port: actualPort,
    host,
    dir,
    instanceId: store.instanceId,
    startedAt,
    // 记下是哪个 node 起的。之前有服务被别的程序的沙箱 node 拉起来，
    // 看进程树完全看不出是 AgentChat，排查了半天。写在这里一眼就能认。
    nodePath: process.execPath,
    electron: !!process.versions.electron,
  };
  writeRuntime(dir, info);

  const close = async () => {
    try { if (watcher) watcher.close(); } catch {}
    clearTimeout(watchTimer);
    for (const res of clients) { try { res.end(); } catch {} }
    clients.clear();
    await new Promise((r) => server.close(r));
    clearRuntime(dir, store.instanceId);
    releaseLock(dir);
  };

  onLog(`agent-chat 已启动 http://${host}:${actualPort}`);
  onLog(`数据目录 ${dir}`);
  return { port: actualPort, host, instanceId: store.instanceId, reused: false, close, store, info };
}
