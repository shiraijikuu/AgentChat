// 收到 @ 时按配置执行命令。
//
// 这是整个项目里唯一一处「消息板主动拉起外部程序」的地方，所以规矩定死：
//
// 1. 配置在 <数据目录>/hooks.json。文件不存在就完全不触发，默认是关的。
// 2. 只认配置里明确写了 command 或 run 的名字，没写的名字一律不管。
// 3. 同一个名字有冷却时间，默认 60 秒。防止有人连发几条 @ 就拉起一堆进程。
// 4. 消息内容写到 <数据目录>/_hook-payload/<消息id>-<名字>.json，
//    路径通过环境变量 AGENT_CHAT_PAYLOAD 给。不拼进命令行，正文里有引号、
//    换行、特殊符号都不会把命令搞坏。
// 5. 每次触发、跳过、失败都写 <数据目录>/_hooks.log，出了事能查。
//
// 配置长这样：
// {
//   "desktopNotify": ["doubao", "qoder", "workbuddy"],
//   "dsh":   { "run": "codex resume --last", "cwd": "D:/work", "cooldownSec": 60 },
//   "doubao": { "command": "node", "args": ["D:/tools/wake.mjs"], "cooldownSec": 120 }
// }
//
// run 走 shell，command + args 不走 shell。能用 command + args 就别用 run。
//
// desktopNotify 是给「没有命令行、拉不起来」的 agent 用的：被 @ 的时候弹一条
// Windows 通知，人看到就知道该去开哪个。写 true 表示全部名字都弹。

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { nowIso } from './store.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// 打包之后这里是 app.asar 里面的虚拟路径，PowerShell 读不到，所以要指向解包出去的那份。
// electron-builder.yml 里 asarUnpack 配了这个文件。开发态路径里没有 app.asar，替换是空操作。
const TOAST_SCRIPT = path.join(HERE, 'notify-desktop.ps1').replace(
  `app.asar${path.sep}`,
  `app.asar.unpacked${path.sep}`,
);
const DEFAULT_COOLDOWN = 60;
// 通知比拉起轻得多，冷却短一点，但也别让连发几条 @ 弹一屏
const NOTIFY_COOLDOWN = 20;
// 上一轮的进程记录最多认多久。
//
// detached 加 unref 之后，子进程的 close 事件不保证还能收到。收不到就会在
// running 里留一条永远 exitCode === null 的记录，之后这个名字再也不会被拉起。
// 所以给个上限，超过就当成它已经结束了，宁可偶尔重叠也不要永久卡死。
const STALE_RUN_MS = 15 * 60 * 1000;

export class Hooks {
  constructor(dir) {
    this.dir = dir;
    this.file = path.join(dir, 'hooks.json');
    this.logFile = path.join(dir, '_hooks.log');
    this.payloadDir = path.join(dir, '_hook-payload');
    this.last = new Map();
    this.lastNotify = new Map();
    // 名字 -> { child, at }。冷却只能防连发，防不了「这一轮跑得比冷却久」。
    // 两个进程同时读同一个 inbox 会重复回复，比不回复更糟，所以拉起前先看这个。
    this.running = new Map();
    // 子进程的输出留一份。命令一启动就报错（比如参数冲突）的时候，
    // stdio: 'ignore' 会把错误全吞掉，日志里只剩「已拉起」，实际什么都没干。
    // 这个坑踩过一次，之后必须有地方能看。
    this.outDir = path.join(dir, '_hook-out');
    this._cache = null;
    this._mtime = 0;
    // 载荷文件是临时数据，每次启动清掉，别越攒越多
    try {
      fs.rmSync(this.payloadDir, { recursive: true, force: true });
    } catch {}
    try { fs.mkdirSync(this.payloadDir, { recursive: true }); } catch {}
    try { fs.mkdirSync(this.outDir, { recursive: true }); } catch {}
    // 输出日志留 7 天，太久远的删掉，别无限涨
    try {
      const cut = Date.now() - 7 * 24 * 3600 * 1000;
      for (const f of fs.readdirSync(this.outDir)) {
        const full = path.join(this.outDir, f);
        try { if (fs.statSync(full).mtimeMs < cut) fs.unlinkSync(full); } catch {}
      }
    } catch {}
  }

  _log(line) {
    try { fs.appendFileSync(this.logFile, `[${nowIso()}] ${line}\n`, 'utf8'); } catch {}
  }

  // 每次读之前看一眼 mtime，改完配置不用重启服务
  config() {
    let st;
    try {
      st = fs.statSync(this.file);
    } catch {
      this._cache = {};
      return this._cache;
    }
    if (this._cache && st.mtimeMs === this._mtime) return this._cache;
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this._cache = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    } catch (e) {
      this._log(`hooks.json 解析失败，这轮不触发：${e.message}`);
      this._cache = {};
    }
    this._mtime = st.mtimeMs;
    return this._cache;
  }

  // 冷却秒数。写 0 就是真的不冷却。
  // 早先写成 Number(x) || DEFAULT，0 是 falsy，写 0 反而变成默认 60 秒。
  _cooldownOf(h) {
    const n = Number(h && h.cooldownSec);
    return Number.isFinite(n) && n >= 0 ? n : DEFAULT_COOLDOWN;
  }

  // 这个名字上一轮是不是还在跑。超过 STALE_RUN_MS 就当它结束了。
  _isRunning(name) {
    const live = this.running.get(name);
    if (!live) return false;
    if (live.child.exitCode !== null) return false;
    return Date.now() - live.at < STALE_RUN_MS;
  }

  list() {
    const cfg = this.config();
    return Object.entries(cfg)
      // desktopNotify 是配置项不是 agent，数组也是 object，这里一并排掉
      .filter(([name, h]) => name !== 'desktopNotify' && h && typeof h === 'object' && !Array.isArray(h))
      .map(([name, h]) => ({
        name,
        run: h.run ? String(h.run) : null,
        command: h.command ? String(h.command) : null,
        args: Array.isArray(h.args) ? h.args.map(String) : [],
        cwd: h.cwd ? String(h.cwd) : this.dir,
        cooldownSec: this._cooldownOf(h),
        enabled: h.enabled !== false,
        running: this._isRunning(name),
      }));
  }

  // 要弹桌面通知的名字。desktopNotify 写 true 就是全部，写数组就只这些。
  _notifyList(cfg) {
    const v = cfg.desktopNotify;
    if (v === true) return 'all';
    if (Array.isArray(v)) return v.map(String);
    return null;
  }

  /**
   * 弹一条 Windows 通知。
   *
   * 给 doubao、qoder、workbuddy 这种没有命令行通道的 agent 用：它们拉不起来，
   * 但人得知道有人 @ 了它们。通知弹出来，人自己去开那个应用，开了就读 inbox。
   * 火起来失败不影响消息落盘，日志里留一行。
   */
  _notify(name, msg, channel) {
    const prev = this.lastNotify.get(name) || 0;
    if (Date.now() - prev < NOTIFY_COOLDOWN * 1000) return false;
    this.lastNotify.set(name, Date.now());

    const ch = channel || {};
    const where = ch.note ? `${msg.project}（${ch.note}）` : String(msg.project || '');
    const title = `${msg.from} 在 ${where} 里 @ 了 ${name}`;
    // 正文压成一行，太长会撑爆通知气泡
    const body = String(msg.body || '').replace(/\s+/g, ' ').trim().slice(0, 120) || '（空消息）';

    if (!fs.existsSync(TOAST_SCRIPT)) {
      this._log(`通知脚本不在（${TOAST_SCRIPT}），跳过 ${name}`);
      return false;
    }
    try {
      const child = spawn('powershell', [
        '-NoProfile', '-ExecutionPolicy', 'Bypass',
        '-File', TOAST_SCRIPT,
        '-Title', title,
        '-Text', body,
      ], { detached: true, stdio: 'ignore', windowsHide: true });
      child.on('error', (e) => this._log(`通知弹不出来：${e.message}`));
      child.unref();
      this._log(`已弹通知给 ${name}（${msg.id} @ ${msg.project}，来自 ${msg.from}）`);
      return true;
    } catch (e) {
      this._log(`通知弹不出来：${e.message}`);
      return false;
    }
  }

  /**
   * 消息落盘之后调。同步返回触发了哪些名字，实际进程异步跑，不阻塞响应。
   *
   * channel 是这条消息所在频道的元数据（绑了哪个项目、说明）。被拉起的会话
   * 光看正文不知道 qqbot 是干什么的，所以一起塞进载荷里。
   */
  fire(msg, channel = null) {
    const mentions = Array.isArray(msg.mentions) ? msg.mentions : [];
    if (!mentions.length) return [];
    const cfg = this.config();
    const notify = this._notifyList(cfg);
    const started = [];
    for (const name of mentions) {
      if (name === msg.from) continue;

      // 通知和拉起是两条独立的线：能拉起来的（dsh）也会弹一条，让人知道发生了什么；
      // 只想要拉起不要通知，就把这个名字从 desktopNotify 里去掉。
      if (notify === 'all' || (Array.isArray(notify) && notify.includes(name))) {
        this._notify(name, msg, channel);
      }

      const h = cfg[name];
      if (!h || typeof h !== 'object' || Array.isArray(h)) continue;
      if (h.enabled === false) continue;
      if (!h.run && !h.command) continue;
      const cooldown = this._cooldownOf(h) * 1000;
      const prev = this.last.get(name) || 0;
      if (Date.now() - prev < cooldown) {
        this._log(`${name} 冷却中，跳过 ${msg.id}`);
        continue;
      }
      // 上一轮还没跑完就不拉。这时候不动 last，等它真结束了下一轮照常触发。
      if (this._isRunning(name)) {
        this._log(`${name} 上一轮还没结束，跳过 ${msg.id}`);
        continue;
      }
      this.last.set(name, Date.now());
      if (this._spawn(name, h, msg, channel)) started.push(name);
    }
    return started;
  }

  _spawn(name, hook, msg, channel = null) {
    const payload = {
      name,
      msgId: msg.id,
      project: msg.project,
      // 这个频道绑了什么项目、在做什么。没有就是 null。
      channel: channel || null,
      from: msg.from,
      fromId: msg.fromId || null,
      type: msg.type,
      body: msg.body,
      ts: msg.ts,
      mentions: msg.mentions || [],
      mentionsAll: !!msg.mentionsAll,
      // 正文里提到的文件路径，被拉起的会话直接读这个数组，不用自己再解析一遍
      files: Array.isArray(msg.files) ? msg.files : [],
    };
    let payloadFile = null;
    try {
      payloadFile = path.join(this.payloadDir, `${msg.id}-${name}.json`);
      fs.writeFileSync(payloadFile, JSON.stringify(payload, null, 2), 'utf8');
    } catch (e) {
      this._log(`${name} 载荷写不下来：${e.message}`);
    }

    const files = Array.isArray(msg.files) ? msg.files : [];
    const ch = channel || {};
    const env = {
      ...process.env,
      AGENT_CHAT_NAME: name,
      AGENT_CHAT_PROJECT: String(msg.project || ''),
      // 这个频道绑的项目和说明，被拉起的会话靠它知道自己进的是哪个摊子
      AGENT_CHAT_PROJECT_DIR: String(ch.dir || ''),
      AGENT_CHAT_PROJECT_NOTE: String(ch.note || ''),
      AGENT_CHAT_FROM: String(msg.from || ''),
      AGENT_CHAT_MSG_ID: String(msg.id || ''),
      AGENT_CHAT_PAYLOAD: payloadFile || '',
      // 文件路径单独给一份，被拉起的脚本可以直接拿来用，不用读载荷
      AGENT_CHAT_FILES: files.map((f) => (f.line ? `${f.path}:${f.line}` : f.path)).join(';'),
      AGENT_CHAT_MENTION_ALL: msg.mentionsAll ? '1' : '',
    };

    const opts = {
      cwd: hook.cwd ? String(hook.cwd) : this.dir,
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env,
    };

    // 有输出文件就把 stdout 和 stderr 都导过去，出问题能看见
    let outFd = null;
    try {
      const outFile = path.join(this.outDir, `${msg.id}-${name}.log`);
      outFd = fs.openSync(outFile, 'a');
      opts.stdio = ['ignore', outFd, outFd];
    } catch (e) {
      this._log(`${name} 输出文件打不开，这轮看不到它的输出：${e.message}`);
    }

    let child;
    try {
      if (hook.command) {
        const args = Array.isArray(hook.args) ? hook.args.map(String) : [];
        child = spawn(String(hook.command), args, opts);
      } else {
        // run 走 shell。配置是用户自己写的，等同于他自己敲这条命令。
        child = spawn(String(hook.run), { ...opts, shell: true });
      }
    } catch (e) {
      this._log(`${name} 启动失败：${e.message}`);
      if (outFd !== null) { try { fs.closeSync(outFd); } catch {} }
      return false;
    }
    // 这个 child 自己结束就把记录清掉。清之前核对一下，别把后一轮的记录删了。
    const clearRunning = () => {
      const cur = this.running.get(name);
      if (cur && cur.child === child) this.running.delete(name);
    };
    child.on('error', (e) => {
      this._log(`${name} 启动失败：${e.message}`);
      clearRunning();
    });
    // 子进程结束把文件关掉。detached 之后不一定还收得到事件，关不掉也没关系，
    // 进程退出时操作系统会收。
    child.on('close', (code) => {
      if (outFd !== null) { try { fs.closeSync(outFd); } catch {} }
      if (code !== 0) this._log(`${name} 退出码 ${code}，输出在 _hook-out/${msg.id}-${name}.log`);
      clearRunning();
    });
    child.unref();
    this.running.set(name, { child, at: Date.now() });
    this._log(`${name} 已拉起（${msg.id} @ ${msg.project}，来自 ${msg.from}）`);
    return true;
  }
}
