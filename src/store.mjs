// 存储层。所有落盘动作只在这里发生，别的地方不许直接写 jsonl。
//
// 这里要防的事，按发生概率排：
// 1. 两个进程同时写同一个文件，行交错，JSON 解析崩
// 2. 写到一半断电或被杀，留下半行，后面整个文件读不动
// 3. 消息 id 撞车，前端按 id 去重时丢消息
// 4. agent 网络重试把同一条消息写两遍
// 5. 游标被两个进程同时改，读到一半丢一半
// 6. 某个 agent 死循环刷屏，把文件写爆
// 7. 端口被别的程序占了，客户端连不上

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const NAME_RE = /^[A-Za-z0-9_-]+$/;
const MAX_BODY = 20000;
const MAX_MENTIONS = 200;
const MAX_FILES = 20;
const TYPES = new Set(['post', 'ask', 'answer', 'notice', 'handoff']);
const DEDUPE_CAP = 800;
const TAIL_SCAN = 300;

// 主频道。所有 agent 天然是它的成员，不用拉，也移不出去。
export const MAIN_PROJECT = 'general';

// @全体 的几种写法。all / everyone / here 跟名字一样是纯 ASCII，所以要有保留字，
// 不然真有人叫 all，@all 就不知道该喊一个人还是喊所有人。这里定死：喊所有人。
//
// 中文只认「全体成员」，不认「全体」：后者是前者的前缀，两种都收的话
// @全体成员 会被当成 @全体 + 「成员」，谁看都别扭。要喊人就写全。
const ALL_TOKENS = new Set(['all', 'everyone', 'here']);
const ALL_WORDS = ['全体成员'];
export const RESERVED_NAMES = new Set([...ALL_TOKENS, ...ALL_WORDS]);

const pad = (n) => String(n).padStart(2, '0');

export function nowIso() {
  const d = new Date();
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
    `${sign}${pad(Math.floor(Math.abs(off) / 60))}:${pad(Math.abs(off) % 60)}`;
}

export function isValidName(n) {
  return typeof n === 'string' && n.length > 0 && n.length <= 64 && NAME_RE.test(n);
}

// 正文里有没有 @全体
export function mentionsAllIn(body) {
  const s = String(body ?? '');
  if (ALL_WORDS.some((w) => s.includes('@' + w))) return true;
  return /@(all|everyone|here)(?![A-Za-z0-9_-])/i.test(s);
}

// 文件路径引用。
//
// 只认带盘符的绝对路径（D:\work\a.mjs、D:/work/a.mjs），不认相对路径：
// 相对路径跟版本号、域名、比例写法混在一起没法可靠区分，宁可漏也不误伤。
// 行号用 :123 或 :123-456，跟编辑器跳转的写法一致。
// 路径里可以有中文（E:/图片/raw/a.ARW），但中文标点必须当分隔符，
// 否则「看 E:/a.mjs，还有 B」会把「，还有」一起吞进路径。
const WIN_PATH_RE = /[A-Za-z]:[\\/][^\s"'`<>|*?\n，。；：！？、（）【】「」『』《》…]*/g;
const TRAIL_PUNCT = '.,;!?)]}>、。，；！？）」』】…';

export function parseFileRefs(body) {
  const text = String(body ?? '');
  const out = [];
  const seen = new Set();

  for (const m of text.matchAll(WIN_PATH_RE)) {
    let raw = m[0];
    // 剥尾部的标点。冒号单独处理：:123 是行号要留着，裸冒号是标点。
    while (raw.length > 3) {
      const c = raw[raw.length - 1];
      if (TRAIL_PUNCT.includes(c)) { raw = raw.slice(0, -1); continue; }
      break;
    }
    if (raw.length < 4) continue;

    let file = raw;
    let line = null;
    let lineEnd = null;
    const lm = raw.match(/^(.*?):(\d+)(?:-(\d+))?$/);
    if (lm && lm[1].length > 3) {
      file = lm[1];
      line = Number(lm[2]);
      lineEnd = lm[3] ? Number(lm[3]) : null;
    }

    // Windows 路径不会有两个连续反斜杠，折叠一下。
    // 有人从 JSON 或者转义过的日志里粘过来会带双斜杠，不折叠就打不开。
    // UNC 路径不认（正则要求盘符开头），所以这里不用担心动到 \\server\share。
    file = file.replace(/\\\\/g, '\\');

    const key = `${file}:${line ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ path: file, line, lineEnd, raw });
    if (out.length >= MAX_FILES) break;
  }
  return out;
}

// 解析 @。allNames 是当前所有 agent 的名字，@全体 的时候要展开成具体的人，
// 这样收件箱、hooks 都不用为「全体」再写一套逻辑。
export function parseMentions(body, allNames = []) {
  const s = String(body ?? '');
  const out = [];
  const seen = new Set();
  const push = (n) => {
    if (!n || seen.has(n) || RESERVED_NAMES.has(n)) return;
    seen.add(n);
    out.push(n);
  };

  if (mentionsAllIn(s)) for (const n of allNames) push(n);

  for (const m of s.matchAll(/@([A-Za-z0-9_-]{1,64})/g)) {
    if (ALL_TOKENS.has(m[1].toLowerCase())) continue;
    push(m[1]);
    if (out.length >= MAX_MENTIONS) break;
  }
  return out;
}

// 原子写 JSON：先写临时文件再改名。改名在 Windows 上是替换语义，不会留半个文件。
export function writeJsonAtomic(file, value) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
  try {
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch {}
    throw e;
  }
}

export function readJsonSafe(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

export function isPidAlive(pid) {
  if (!pid || typeof pid !== 'number') return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

export class Store {
  constructor(dir) {
    this.dir = dir;
    this.instanceId = crypto.randomBytes(4).toString('hex');
    this.runtimeFile = path.join(dir, '_runtime.json');
    this.registryFile = path.join(dir, 'agents.json');
    // 频道元数据：这个频道绑了哪个项目目录、一句话说明。
    // 跟 agents.json 分开存，各管各的，坏一个不影响另一个。
    this.channelsFile = path.join(dir, 'channels.json');
    this.cursorsDir = path.join(dir, 'cursors');
    this.corruptLog = path.join(dir, '_corrupt.log');
    this._repaired = new Set();
    this._seq = 0;
    this._dedupe = new Map();
    this._rate = new Map();
    this._reg = null;
    this._channels = null;
    fs.mkdirSync(dir, { recursive: true });
    fs.mkdirSync(this.cursorsDir, { recursive: true });
    this._warmDedupe();
  }

  // ---------- 路径 ----------

  projectPath(project) {
    if (!isValidName(project)) throw new Error('project 只能用字母、数字、下划线、连字符，最长 64');
    return path.join(this.dir, `${project}.jsonl`);
  }

  // ---------- 自愈 ----------

  // 文件尾部如果残留半行（写一半被杀），截到最后一个换行符。
  // 只做一次，结果缓存在内存里，别每次都读全文件。
  repairFile(file) {
    if (this._repaired.has(file)) return;
    this._repaired.add(file);
    if (!fs.existsSync(file)) return;
    const size = fs.statSync(file).size;
    if (size === 0) return;
    const buf = fs.readFileSync(file);
    const lastNl = buf.lastIndexOf(0x0a);
    if (lastNl === buf.length - 1) return;
    const cut = lastNl < 0 ? 0 : lastNl + 1;
    const lost = buf.subarray(cut).toString('utf8');
    try {
      fs.appendFileSync(this.corruptLog,
        `[${nowIso()}] ${path.basename(file)} 尾部残缺 ${buf.length - cut} 字节，已截断。内容：${JSON.stringify(lost.slice(0, 300))}\n`,
        'utf8');
    } catch {}
    fs.truncateSync(file, cut);
  }

  // ---------- 读 ----------

  readAll(project) {
    const file = this.projectPath(project);
    if (!fs.existsSync(file)) return [];
    this.repairFile(file);
    const out = [];
    let bad = 0;
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      if (!line) continue;
      try { out.push(JSON.parse(line)); } catch { bad += 1; }
    }
    if (bad) {
      try {
        fs.appendFileSync(this.corruptLog, `[${nowIso()}] ${project}.jsonl 有 ${bad} 行解析失败，已跳过（文件未改动）\n`, 'utf8');
      } catch {}
    }
    // 老消息写的时候还没 fromId 字段。读的时候按 from 去注册表补，不动磁盘上的行。
    // id 跟名字绑，reset 也不换 id，所以这样补是准的。
    const reg = this.registry();
    for (const m of out) {
      if (!m.fromId && m.from && reg[m.from]) m.fromId = reg[m.from].id;
    }
    return out;
  }

  readMessages(project, { since, limit } = {}) {
    const all = this.readAll(project);
    let start = 0;
    if (since) {
      const idx = all.findIndex((m) => m.id === since);
      start = idx >= 0 ? idx + 1 : 0;
    }
    const n = Math.min(Math.max(Number(limit) || 500, 1), 2000);
    return all.slice(start, start + n);
  }

  // ---------- 频道元数据 ----------
  //
  // 光有频道名看不出这个频道是干什么的，所以允许给频道绑一个项目目录，
  // 再写一句说明。存在 channels.json，跟消息文件分开。
  //
  // 老频道没有这一项，读出来是空对象，界面就不显示描述，不影响使用。

  channels() {
    if (this._channels) return this._channels;
    const raw = readJsonSafe(this.channelsFile, {});
    const out = {};
    for (const [name, v] of Object.entries(raw && typeof raw === 'object' ? raw : {})) {
      if (!isValidName(name) || !v || typeof v !== 'object') continue;
      out[name] = {
        dir: typeof v.dir === 'string' && isValidName(v.dir) ? v.dir : null,
        title: typeof v.title === 'string' ? v.title.slice(0, 120) : '',
        note: typeof v.note === 'string' ? v.note.slice(0, 300) : '',
        boundAt: typeof v.boundAt === 'string' ? v.boundAt : null,
        boundBy: typeof v.boundBy === 'string' ? v.boundBy : null,
      };
    }
    this._channels = out;
    return out;
  }

  channelOf(name) {
    return this.channels()[name] || { dir: null, title: '', note: '', boundAt: null, boundBy: null };
  }

  setChannelMeta(name, patch = {}, { by = null } = {}) {
    if (!isValidName(name)) throw new Error('频道名只能用字母、数字、下划线、连字符');
    const all = { ...this.channels() };
    const cur = all[name] || { dir: null, title: '', note: '', boundAt: null, boundBy: null };
    const next = { ...cur };

    if ('dir' in patch) {
      const d = patch.dir;
      if (d === null || d === '') {
        next.dir = null;
      } else if (isValidName(String(d))) {
        next.dir = String(d);
        next.boundAt = nowIso();
        next.boundBy = by || null;
      } else {
        throw new Error('要绑的项目目录名只能用字母、数字、下划线、连字符');
      }
    }
    if ('title' in patch) next.title = String(patch.title ?? '').slice(0, 120);
    if ('note' in patch) next.note = String(patch.note ?? '').slice(0, 300);

    all[name] = next;
    this._channels = all;
    writeJsonAtomic(this.channelsFile, all);
    return next;
  }

  listProjects() {
    let names = [];
    try {
      names = fs.readdirSync(this.dir)
        .filter((n) => n.endsWith('.jsonl'))
        .map((n) => n.slice(0, -6))
        .filter((n) => isValidName(n));
    } catch {
      return [];
    }
    return names.map((name) => {
      const all = this.readAll(name);
      const last = all[all.length - 1] || null;
      const meta = this.channelOf(name);
      return {
        name,
        count: all.length,
        // 绑了项目的频道把元数据一起带上，界面靠它显示「这个频道是干什么的」
        dir: meta.dir,
        title: meta.title,
        note: meta.note,
        last: last ? { id: last.id, ts: last.ts, from: last.from, body: String(last.body).slice(0, 120) } : null,
      };
    }).sort((a, b) => String(b.last?.ts || '').localeCompare(String(a.last?.ts || '')));
  }

  inbox(agent, limit = 100, { unreadOnly = false } = {}) {
    if (!isValidName(agent)) throw new Error('agent 只能用字母、数字、下划线、连字符');
    const hits = [];
    for (const p of this.listProjects()) {
      // 老消息没有 mentions 字段，读的时候补解析一次。
      // @全体成员 按这条消息所在频道的成员展开，跟写消息时的口径一致。
      const channelMembers = this.membersOf(p.name).map((m) => m.name);
      for (const m of this.readAll(p.name)) {
        if (m.from === agent) continue;
        const ms = Array.isArray(m.mentions) ? m.mentions : parseMentions(m.body, channelMembers);
        if (ms.includes(agent)) hits.push({ project: p.name, ...m });
      }
    }
    // 只按时间排，同秒的保持读进来的顺序（Array.sort 是稳定的）。
    // 不能拿 id 当二级排序：id 里带发送者名字，跨 agent 同秒时字典序跟写入顺序不一致。
    hits.sort((a, b) => String(a.ts).localeCompare(String(b.ts)));

    // 只看没读过的。收件箱游标是独立的一套，跟频道游标互不影响：
    // read 管某个频道读到哪，inbox 管 @ 我的读到哪。
    //
    // 切分点用「游标那条在 hits 里的位置」，而不是比 ts 大小。
    // 同一秒里可能有好几个人发言，ts 只精确到秒，比大小会把后发的判成已读。
    let list = hits;
    if (unreadOnly) {
      const cur = this.getInboxCursor(agent);
      if (cur && cur.lastId) {
        const at = hits.findIndex((m) => String(m.id) === String(cur.lastId));
        if (at >= 0) {
          list = hits.slice(at + 1);
        } else if (cur.lastTs) {
          // 游标那条已经被归档或者文件被清过，退回按时间比
          list = hits.filter((m) => String(m.ts) > String(cur.lastTs));
        }
      }
    }
    return list.slice(-Math.min(Math.max(Number(limit) || 100, 1), 500));
  }

  // ---------- 收件箱游标 ----------
  //
  // 存在 cursors/<名字>.json 里一个特殊键 __inbox 下，和频道游标放一起，
  // 但语义分开。频道游标记的是「这个频道我读到第几条」，收件箱游标记的是
  // 「@我的消息我处理到哪一条」。

  getInboxCursor(agent) {
    if (!isValidName(agent)) throw new Error('agent 只能用字母、数字、下划线、连字符');
    const cur = this.getCursor(agent);
    return cur && cur.__inbox ? cur.__inbox : null;
  }

  ackInbox(agent, msg) {
    if (!isValidName(agent)) throw new Error('agent 只能用字母、数字、下划线、连字符');
    if (!msg || !msg.id || !msg.ts) throw new Error('要传最后一条消息的 id 和 ts');
    const cur = this.getCursor(agent);
    const prev = cur.__inbox;
    // 只往前走，别被旧消息拉回去
    if (prev && String(prev.lastTs) > String(msg.ts)) return prev;
    if (prev && String(prev.lastTs) === String(msg.ts) && String(prev.lastId) > String(msg.id)) return prev;
    cur.__inbox = { lastId: String(msg.id), lastTs: String(msg.ts), at: nowIso() };
    writeJsonAtomic(this.cursorFile(agent), cur);
    return cur.__inbox;
  }

  // ---------- 写 ----------

  nextId(from) {
    this._seq = (this._seq + 1) % 1000000;
    const d = new Date();
    const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-` +
      `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
    const tag = String(from).replace(/[^A-Za-z0-9]/g, '').slice(0, 4).toLowerCase() || 'anon';
    return `${stamp}-${tag}-${this.instanceId.slice(0, 4)}${String(this._seq).padStart(3, '0')}`;
  }

  _warmDedupe() {
    for (const p of this.listProjects()) {
      const all = this.readAll(p.name);
      for (const m of all.slice(-TAIL_SCAN)) {
        if (m.ck) this._remember(m.ck, m);
      }
    }
  }

  _remember(ck, msg) {
    if (this._dedupe.has(ck)) this._dedupe.delete(ck);
    this._dedupe.set(ck, msg);
    while (this._dedupe.size > DEDUPE_CAP) {
      const oldest = this._dedupe.keys().next().value;
      this._dedupe.delete(oldest);
    }
  }

  _checkRate(from) {
    const now = Date.now();
    const win = (this._rate.get(from) || []).filter((t) => now - t < 60000);
    if (win.length >= 40) {
      const wait = Math.ceil((60000 - (now - win[0])) / 1000);
      const err = new Error(`发太快了，${from} 一分钟最多 40 条，${wait} 秒后再试`);
      err.code = 'RATE_LIMIT';
      err.retryAfter = wait;
      throw err;
    }
    win.push(now);
    this._rate.set(from, win);
  }

  post({ project, from, body, type = 'post', replyTo = null, clientKey = null, agentKey = null }) {
    if (!isValidName(project)) throw new Error('project 只能用字母、数字、下划线、连字符');
    if (!isValidName(from)) throw new Error('from 只能用字母、数字、下划线、连字符，别用中文名');
    let text = String(body ?? '').trim();
    if (!text) throw new Error('body 不能为空');
    if (text.length > MAX_BODY) throw new Error(`body 太长，最多 ${MAX_BODY} 字`);
    const t = TYPES.has(type) ? type : 'post';

    // 名字被锁了就得带对的 key，否则等于谁都能冒充
    const check = this.verifyAgent(from, agentKey);
    if (!check.ok) {
      const err = new Error(
        `名字 ${from} 已经被占用了（id ${check.agent.id}，首次接入 ${String(check.agent.createdAt).slice(0, 16)}）。` +
        `换个名字，或者把当初注册拿到的 key 带上。`,
      );
      err.code = 'NAME_TAKEN';
      err.agentId = check.agent.id;
      throw err;
    }

    // 同一个 clientKey 重复提交，返回上一次的结果，不重复落盘。
    // agent 超时重试的时候靠这个。
    const ck = clientKey ? `${from}:${String(clientKey).slice(0, 120)}` : null;
    if (ck && this._dedupe.has(ck)) {
      const prev = this._dedupe.get(ck);
      return { msg: prev, deduped: true, agent: null, agentKey: null };
    }

    this._checkRate(from);

    const ts = nowIso();
    // 先确定身份拿到 id（第一次接入会顺手锁定并签发 key），消息里要记 fromId
    const { agent, issuedKey } = this.touchAgent(from, project, ts, agentKey);

    // @全体成员 展开的是这个频道的成员，不是整个注册表。
    // 用全量注册表的话，在 lumedit 里喊一声会把 general 和别的频道的人一起喊进来，
    // 那不是「全体成员」，那是「全站广播」，还顺带把人拽进本频道的收件箱。
    // general 是主频道，它的成员本来就是全部人，所以在 general 里 @全体成员 仍然是全员。
    const channelMembers = this.membersOf(project).map((m) => m.name);
    const recipients = () => parseMentions(text, channelMembers.filter((n) => n !== from));

    // 回复必须让原发送者真正收到。replyTo 只在当前频道内解析，不能拿另一频道的
    // 消息 id 把陌生人带进来；回复自己也不把自己塞进收件人。
    if (replyTo) {
      const original = this.readAll(project).find((m) => m.id === replyTo);
      if (original?.from && original.from !== from && !recipients().includes(original.from)) {
        text = `@${original.from} ${text}`;
      }
    }

    // 新消息漏写收件人时，宁可通知当前频道全体，也不要静默落成没人会读的记录。
    // 单人频道展开后可以是空数组，但 mentionsAll 仍明确记录这是一次频道广播。
    if (!mentionsAllIn(text) && recipients().length === 0) text = `@全体成员 ${text}`;

    const msg = {
      id: this.nextId(from),
      ts,
      project,
      from,
      fromId: agent.id,
      type: t,
      body: text,
      mentions: parseMentions(text, channelMembers.filter((n) => n !== from)),
      mentionsAll: mentionsAllIn(text),
      files: parseFileRefs(text),
      replyTo: replyTo || null,
      ck,
    };

    const file = this.projectPath(project);
    this.repairFile(file);
    // appendFileSync 以 O_APPEND 打开，一次 write 一行。Node 单线程 + 同步写，
    // 同进程内天然串行。跨进程靠 _runtime.json 的独占锁挡住，见 lock.mjs。
    fs.appendFileSync(file, JSON.stringify(msg) + '\n', 'utf8');

    if (ck) this._remember(ck, msg);

    // 第一次接入会把新签发的 key 带出来，调用方存下来之后就不再有明文了
    return { msg, deduped: false, agent, agentKey: issuedKey };
  }

  // ---------- 注册表 ----------
  //
  // 结构：名字 -> { id, createdAt, lastSeen, projects, keyHash }
  //
  // id 是固定的，第一次接入时分配，之后跟着这个名字走。名字改了 id 也不会重排，
  // 历史消息里记着 fromId，能追回是同一个。
  //
  // keyHash 有值就表示这个名字被锁了：别人再用这个名字必须带上原 key，
  // 否则拒掉。key 明文只在注册那一次返回，之后服务端只留 sha256。
  //
  // 老数据（只有 {project, lastSeen} 的）读进来时补一个 id，但不锁，
  // 等它第一次带 key 或者被认领的时候才锁上。这样升级不会把已有的 agent 挡在外面。

  registry() {
    if (this._reg) return this._reg;

    const raw = readJsonSafe(this.registryFile, {});
    const out = {};
    let changed = false;

    for (const [name, v] of Object.entries(raw && typeof raw === 'object' ? raw : {})) {
      if (!isValidName(name)) continue;
      const a = this._normalizeAgent(v);
      if (!a.id) { a.id = this._newAgentId(); changed = true; }
      out[name] = a;
    }

    this._reg = out;
    if (changed) this._saveRegistry();
    return out;
  }

  _saveRegistry() {
    try { writeJsonAtomic(this.registryFile, this._reg || {}); } catch {}
  }

  _newAgentId() {
    // ag_ 加 8 位十六进制。够短，肉眼能对，也不会撞
    return `ag_${crypto.randomBytes(4).toString('hex')}`;
  }

  _hashKey(key) {
    return crypto.createHash('sha256').update(String(key)).digest('hex');
  }

  _normalizeAgent(raw) {
    const projects = raw && typeof raw === 'object' && Array.isArray(raw.projects)
      ? raw.projects.filter(isValidName).slice(-100)
      : raw && raw.project && isValidName(raw.project) ? [raw.project] : [];
    if (raw && typeof raw === 'object' && typeof raw.id === 'string' && raw.id) {
      return {
        id: raw.id,
        createdAt: raw.createdAt || raw.lastSeen || nowIso(),
        lastSeen: raw.lastSeen || null,
        // projects 是「属于哪些频道」，spoken 是「在哪些频道说过话」。
        // 被拉进去但没发言的只进 projects。老数据没有 spoken，projects 里
        // 的都是当初发过言的，直接当 spoken 用。
        projects,
        spoken: Array.isArray(raw.spoken)
          ? raw.spoken.filter(isValidName).slice(-100)
          : projects.slice(),
        keyHash: typeof raw.keyHash === 'string' && raw.keyHash ? raw.keyHash : null,
        lockedAt: raw.lockedAt || null,
        resetCount: Number(raw.resetCount) || 0,
      };
    }
    // 老格式：{project, lastSeen}
    return {
      id: null,
      createdAt: raw && raw.lastSeen ? raw.lastSeen : nowIso(),
      lastSeen: raw && raw.lastSeen ? raw.lastSeen : null,
      projects,
      spoken: projects.slice(),
      keyHash: null,
      lockedAt: null,
      resetCount: 0,
    };
  }

  /**
   * 客户端可以自己带一把 key 上来。合法就采纳，不合法当没带。
   *
   * 为什么让客户端生成：同一个 agent 并发发好几条首条消息时，如果 key 由服务端
   * 生成，第一条锁上、key 还没回到客户端，后面几条就变成「不带 key 用已锁的名字」，
   * 全被 409 挡掉。客户端先本地生成好再发，所有并发请求带的是同一把，就没有这个空档。
   *
   * 服务端不信任它「安全」，只当它是这个名字的密码，弱 key 只坑自己，坑不到别人。
   */
  _acceptClientKey(key) {
    const s = String(key || '').trim();
    if (s.length < 32 || s.length > 200) return null;
    return /^[A-Za-z0-9_-]+$/.test(s) ? s : null;
  }

  /**
   * 确保一个名字有身份，并且锁上。注册和首次发消息都走这里，只有这一份逻辑。
   *
   * - 新名字：分配 id，锁定。key 优先用调用方带的，没带就服务端生成并返回
   * - 老名字且没锁：认领，锁定。同上
   * - 老名字且已锁：不动，也不给新 key（验证交给 verifyAgent）
   *
   * 明文 key 只在服务端生成的那一次返回，之后只留 sha256。
   * 客户端自带的 key 服务端根本不存明文，所以也不需要返回。
   */
  _ensureIdentity(name, { project, ts, key } = {}) {
    if (RESERVED_NAMES.has(String(name).toLowerCase())) {
      const err = new Error(`名字 ${name} 是保留字，@全体 要用它，换一个`);
      err.code = 'NAME_RESERVED';
      throw err;
    }
    const reg = this.registry();
    const now = ts || nowIso();

    if (!reg[name]) {
      const own = this._acceptClientKey(key);
      const secret = own || crypto.randomBytes(24).toString('hex');
      reg[name] = {
        id: this._newAgentId(),
        createdAt: now,
        lastSeen: now,
        projects: project && isValidName(project) ? [project] : [],
        spoken: project && isValidName(project) ? [project] : [],
        keyHash: this._hashKey(secret),
        lockedAt: now,
        resetCount: 0,
      };
      this._saveRegistry();
      return { agent: reg[name], issuedKey: own ? null : secret, created: true, claimed: false };
    }

    const a = reg[name];

    if (!a.keyHash) {
      // 升级前的老条目，或者人工清过锁。第一个来的人认领，从此固定。
      const own = this._acceptClientKey(key);
      const secret = own || crypto.randomBytes(24).toString('hex');
      a.keyHash = this._hashKey(secret);
      a.lockedAt = now;
      if (project && isValidName(project)) {
        if (!a.projects.includes(project)) {
          a.projects.push(project);
          if (a.projects.length > 100) a.projects = a.projects.slice(-100);
        }
        if (!a.spoken.includes(project)) a.spoken.push(project);
      }
      this._saveRegistry();
      return { agent: a, issuedKey: own ? null : secret, created: false, claimed: true };
    }

    return { agent: a, issuedKey: null, created: false, claimed: false };
  }

  /**
   * 显式注册或认领一个名字。语义跟首次发消息自动锁定一致。
   * - 新名字：分配 id，生成 key，锁定
   * - 老名字且没锁：认领，生成 key 并锁定
   * - 老名字且已锁：不动，拿不到 key
   */
  registerAgent(name, { project, key } = {}) {
    if (!isValidName(name)) throw new Error('名字只能用字母、数字、下划线、连字符，最长 64');
    const r = this._ensureIdentity(name, { project, key });
    // usable 表示「这把 key 能不能用这个名字」。已锁且不是这把，就是 false。
    // 不叫 ok，免得跟 HTTP 响应外层的 ok 撞名。
    const mine = !!key && r.agent.keyHash === this._hashKey(String(key));
    return {
      agent: r.agent,
      created: r.created,
      claimed: r.claimed,
      key: r.issuedKey,
      usable: mine || !!r.issuedKey,
    };
  }

  /**
   * 重新签发 key。这是转移身份，只给「key 丢了、人在本机」这种情况用。
   * 不做任何鉴权：能改数据目录的人本来就能改一切，装个假的校验只是骗自己。
   * 但会写审计日志，至少留痕。
   */
  resetAgentKey(name, { by = 'local' } = {}) {
    if (!isValidName(name)) throw new Error('名字只能用字母、数字、下划线、连字符，最长 64');
    const reg = this.registry();
    if (!reg[name]) throw new Error(`没有 ${name} 这个身份`);
    const key = crypto.randomBytes(24).toString('hex');
    reg[name].keyHash = this._hashKey(key);
    reg[name].lockedAt = nowIso();
    reg[name].resetCount = (reg[name].resetCount || 0) + 1;
    this._saveRegistry();
    try {
      fs.appendFileSync(path.join(this.dir, '_identity.log'),
        `[${nowIso()}] reset ${name} ${reg[name].id} by ${by} 第 ${reg[name].resetCount} 次\n`, 'utf8');
    } catch {}
    return { agent: reg[name], key };
  }

  /** 校验这个名字能不能被这个调用方用 */
  verifyAgent(name, key) {
    const reg = this.registry();
    const a = reg[name];
    if (!a) return { ok: true, agent: null };        // 没注册过，发消息时顺手注册
    if (!a.keyHash) return { ok: true, agent: a };   // 老条目没锁，先放行
    if (!key) return { ok: false, agent: a };
    return { ok: this._hashKey(key) === a.keyHash, agent: a };
  }

  /**
   * 发消息时顺手把身份确定下来。第一次接入就锁，不用另外注册。
   *
   * 锁的意义是：这个名字从此只认这把 key。别人再用同名发消息，不带 key 或者
   * 带错 key 一律 409，冒充不了。key 明文只在这第一次返回，调用方必须存下来。
   *
   * 并发说明：post 是同步函数，verify 到 touch 之间没有 await，Node 单线程下
   * 不会交错。所以「两个人同时首次接入同名」不会都成功，后到的那个被 409 挡掉。
   * 同一个 agent 自己并发首条也可能撞上，客户端收到 409 应该重读 key 再试一次。
   */
  touchAgent(from, project, ts, key) {
    const r = this._ensureIdentity(from, { project, ts, key });
    const a = r.agent;
    a.lastSeen = ts;
    if (project && isValidName(project)) {
      if (!a.projects.includes(project)) {
        a.projects.push(project);
        if (a.projects.length > 100) a.projects = a.projects.slice(-100);
      }
      // 发过言才算真参与，被拉进来但一直没说话的不算
      if (!a.spoken.includes(project)) a.spoken.push(project);
    }
    this._saveRegistry();
    return { agent: a, issuedKey: r.issuedKey };
  }

  /**
   * 把所有还没锁的条目一次性锁上。升级收尾用。
   *
   * 为什么需要：老版本自动建档不锁，升级之后这些名字处在「谁先到谁认领」的状态，
   * 在它本人下次来之前，任何 agent 都能拿这个名字发言并把它锁死。跑一次这个就堵上了。
   *
   * keys 里带了某个名字的 key 就沿用它，不覆盖。这样本地已经存着 key、正在正常发言的
   * agent 不会被自己的收尾动作锁在外面。没带的才签发新的。
   */
  sealUnlockedAgents({ by = 'local', keys = {} } = {}) {
    const reg = this.registry();
    const out = [];
    for (const [name, a] of Object.entries(reg)) {
      if (a.keyHash) continue;
      const own = this._acceptClientKey(keys[name]);
      const key = own || crypto.randomBytes(24).toString('hex');
      a.keyHash = this._hashKey(key);
      a.lockedAt = nowIso();
      out.push({ name, id: a.id, key, adopted: !!own });
    }
    if (!out.length) return out;
    this._saveRegistry();
    try {
      fs.appendFileSync(path.join(this.dir, '_identity.log'),
        `[${nowIso()}] seal ${out.length} 个未锁条目 by ${by}：` +
        out.map((o) => `${o.name}(${o.id}${o.adopted ? ' 沿用' : ''})`).join(', ') + '\n', 'utf8');
    } catch {}
    return out;
  }

  /**
   * 把一个名字从注册表里删掉，等于释放它。之后谁都能重新注册成新身份。
   * 历史消息不动，fromId 回填会失效（注册表里没这个名字了），消息本身还在。
   * 只用来清垃圾条目，别拿它当日常操作。
   */
  forgetAgent(name, { by = 'local' } = {}) {
    if (!isValidName(name)) throw new Error('名字只能用字母、数字、下划线、连字符，最长 64');
    const reg = this.registry();
    if (!reg[name]) throw new Error(`没有 ${name} 这个身份`);
    const id = reg[name].id;
    delete reg[name];
    this._saveRegistry();
    try {
      fs.appendFileSync(path.join(this.dir, '_identity.log'),
        `[${nowIso()}] forget ${name} ${id} by ${by}\n`, 'utf8');
    } catch {}
    return { name, id };
  }

  /**
   * 从历史消息回填成员关系。老数据里发言不写 projects，所以老频道会显示没人。
   * 扫一遍所有 jsonl，把发言者补进对应频道的 projects 和 spoken。
   *
   * 只做一次，做完写个标记文件。以后靠正常流程维护，不用每次启动都扫。
   */
  backfillMembership() {
    const mark = path.join(this.dir, '_membership.done');
    if (fs.existsSync(mark)) return { skipped: true, fixed: 0 };
    const reg = this.registry();
    let fixed = 0;
    for (const p of this.listProjects()) {
      for (const m of this.readAll(p.name)) {
        if (!m.from) continue;
        const a = reg[m.from];
        if (!a) continue;
        if (!a.projects.includes(p.name)) {
          a.projects.push(p.name);
          if (a.projects.length > 100) a.projects = a.projects.slice(-100);
          fixed += 1;
        }
        if (!a.spoken.includes(p.name)) a.spoken.push(p.name);
      }
    }
    if (fixed) this._saveRegistry();
    try { fs.writeFileSync(mark, nowIso(), 'utf8'); } catch {}
    return { skipped: false, fixed };
  }

  // ---------- 成员 ----------
  //
  // 一个 agent 就是一个用户，名字和 id 是全局的，不分频道。频道相当于群，
  // 成员关系记在注册表的 projects 里。
  //
  // general 是主频道，所有 agent 天然在里面，不用拉，也移不出去。
  // 其他频道靠 invite 加人，被拉进去但还没发言的也算成员。

  /** 建一个空频道。已经存在就报错，别把老消息覆盖掉。 */
  createProject(name, { by = null, dir = null, title = '', note = '' } = {}) {
    if (!isValidName(name)) throw new Error('频道名只能用字母、数字、下划线、连字符，最长 64');
    const file = this.projectPath(name);
    if (fs.existsSync(file)) {
      const err = new Error(`频道 ${name} 已经有了`);
      err.code = 'PROJECT_EXISTS';
      throw err;
    }
    fs.writeFileSync(file, '', 'utf8');
    // 建的人顺手算成员，不然刚建完频道里一个人都没有，看着奇怪
    if (by && isValidName(by) && this.registry()[by]) {
      this.inviteToProject(name, by);
    }
    // 绑项目是可选的。给了就一起写进 channels.json，不给就什么都不写，
    // 免得 channels.json 里堆一堆空记录。
    if (dir || title || note) {
      this.setChannelMeta(name, { dir, title, note }, { by });
    }
    return { project: name, created: true, meta: this.channelOf(name) };
  }

  /**
   * 频道改名。
   *
   * 名字在这套东西里散得到处都是：jsonl 文件名、每条消息里的 project 字段、
   * channels.json 的键、每个 agent 的 projects 和 spoken、每个游标文件里的键。
   * 漏一处就出怪事，比如改完名字收件箱里还能翻出旧频道的消息。
   * 所以这里一次全改完，最后才删旧文件。中途挂了旧文件还在，数据不会两头空。
   */
  renameProject(oldName, newName, { by = null } = {}) {
    if (!isValidName(oldName) || !isValidName(newName)) {
      throw new Error('频道名只能用字母、数字、下划线、连字符，最长 64');
    }
    if (oldName === MAIN_PROJECT) {
      const err = new Error('general 是主频道，名字不能改');
      err.code = 'MAIN_PROJECT';
      throw err;
    }
    if (oldName === newName) {
      return { project: newName, renamed: false, meta: this.channelOf(newName) };
    }
    const oldFile = this.projectPath(oldName);
    if (!fs.existsSync(oldFile)) {
      const err = new Error(`没有 ${oldName} 这个频道`);
      err.code = 'PROJECT_MISSING';
      throw err;
    }
    if (fs.existsSync(this.projectPath(newName))) {
      const err = new Error(`频道 ${newName} 已经有了`);
      err.code = 'PROJECT_EXISTS';
      throw err;
    }

    // 消息里的 project 字段要跟着改，不然 inbox 里显示的频道名对不上。
    // 解析不了的行原样留着，宁可留一条坏数据也不吞内容。
    const lines = [];
    for (const line of fs.readFileSync(oldFile, 'utf8').split('\n')) {
      if (!line) continue;
      let rec = null;
      try { rec = JSON.parse(line); } catch { rec = null; }
      lines.push(rec && typeof rec === 'object'
        ? JSON.stringify({ ...rec, project: newName })
        : line);
    }
    fs.writeFileSync(this.projectPath(newName), lines.length ? lines.join('\n') + '\n' : '', 'utf8');

    // channels.json 换键，顺序不动
    const chans = this.channels();
    if (chans[oldName]) {
      const next = {};
      for (const [k, v] of Object.entries(chans)) next[k === oldName ? newName : k] = v;
      this._channels = next;
      writeJsonAtomic(this.channelsFile, next);
    }

    // 成员关系。projects 是所属频道，spoken 是发过言的频道，两个都要换
    let regChanged = false;
    for (const a of Object.values(this.registry())) {
      for (const field of ['projects', 'spoken']) {
        if (!Array.isArray(a[field]) || !a[field].includes(oldName)) continue;
        a[field] = a[field].map((x) => (x === oldName ? newName : x));
        regChanged = true;
      }
    }
    if (regChanged) this._saveRegistry();

    this._migrateCursors(oldName, newName);

    // 去重缓存里存的是整条消息，也带着旧频道名，顺手改掉
    for (const m of this._dedupe.values()) {
      if (m && m.project === oldName) m.project = newName;
    }

    try { fs.unlinkSync(oldFile); } catch {}
    return { project: newName, renamed: true, from: oldName, meta: this.channelOf(newName) };
  }

  /**
   * 删频道。
   *
   * 消息文件不真删，挪到 _deleted/ 下面，文件名带时间戳。
   * 删了就没了这种事不该由一次右键决定，想找回来自己去 _deleted 里捞。
   * 频道元数据、成员关系、游标都清干净，不然下次建同名频道会带着旧成员。
   */
  deleteProject(name, { by = null } = {}) {
    if (!isValidName(name)) throw new Error('频道名只能用字母、数字、下划线、连字符');
    if (name === MAIN_PROJECT) {
      const err = new Error('general 是主频道，删不了');
      err.code = 'MAIN_PROJECT';
      throw err;
    }
    const file = this.projectPath(name);
    if (!fs.existsSync(file)) {
      const err = new Error(`没有 ${name} 这个频道`);
      err.code = 'PROJECT_MISSING';
      throw err;
    }
    const count = this.readAll(name).length;

    const bin = path.join(this.dir, '_deleted');
    fs.mkdirSync(bin, { recursive: true });
    const stamp = nowIso().slice(0, 19).replace(/:/g, '');
    const archived = path.join(bin, `${name}-${stamp}.jsonl`);
    fs.renameSync(file, archived);

    const chans = this.channels();
    if (chans[name]) {
      const next = { ...chans };
      delete next[name];
      this._channels = next;
      writeJsonAtomic(this.channelsFile, next);
    }

    let regChanged = false;
    for (const a of Object.values(this.registry())) {
      for (const field of ['projects', 'spoken']) {
        if (!Array.isArray(a[field]) || !a[field].includes(name)) continue;
        a[field] = a[field].filter((x) => x !== name);
        regChanged = true;
      }
    }
    if (regChanged) this._saveRegistry();

    this._migrateCursors(name, null);

    // 缓存里这个频道的消息留着没用，删掉，免得重试撞上去返回旧消息
    for (const [ck, m] of this._dedupe) {
      if (m && m.project === name) this._dedupe.delete(ck);
    }

    return { project: name, deleted: true, count, archived, by };
  }

  /**
   * 频道改名或删除时迁移游标。newName 传 null 表示这个频道没了，键直接丢掉。
   * 游标文件是每个 agent 一个，键是频道名，不改的话会留下一堆指向不存在频道的游标。
   */
  _migrateCursors(oldName, newName) {
    let files = [];
    try { files = fs.readdirSync(this.cursorsDir).filter((n) => n.endsWith('.json')); } catch { return 0; }
    let touched = 0;
    for (const f of files) {
      const file = path.join(this.cursorsDir, f);
      const cur = readJsonSafe(file, null);
      if (!cur || typeof cur !== 'object' || !(oldName in cur)) continue;
      const next = {};
      for (const [k, v] of Object.entries(cur)) {
        if (k !== oldName) { next[k] = v; continue; }
        if (newName) next[newName] = v;
      }
      writeJsonAtomic(file, next);
      touched += 1;
    }
    return touched;
  }

  membersOf(project) {
    if (!isValidName(project)) throw new Error('频道名只能用字母、数字、下划线、连字符');
    const reg = this.registry();
    const main = project === MAIN_PROJECT;
    const out = [];
    for (const [name, a] of Object.entries(reg)) {
      const inProject = a.projects.includes(project);
      if (!main && !inProject) continue;
      out.push({
        name,
        id: a.id,
        locked: !!a.keyHash,
        createdAt: a.createdAt,
        lastSeen: a.lastSeen,
        channels: a.projects.slice(),
        // joined 表示在这个频道说过话，被拉进来但没开口的是 false
        joined: a.spoken.includes(project),
      });
    }
    // 在这个频道说过话的排前面，其余按最后活跃时间
    out.sort((x, y) => {
      if (x.joined !== y.joined) return x.joined ? -1 : 1;
      return String(y.lastSeen || '').localeCompare(String(x.lastSeen || ''));
    });
    return out;
  }

  inviteToProject(project, name) {
    if (!isValidName(project)) throw new Error('频道名只能用字母、数字、下划线、连字符');
    if (!isValidName(name)) throw new Error('名字只能用字母、数字、下划线、连字符');
    const reg = this.registry();
    const a = reg[name];
    if (!a) throw new Error(`没有 ${name} 这个 agent，让它先发一条消息接入`);
    if (!a.projects.includes(project)) {
      a.projects.push(project);
      // 成员关系不按最近 N 个截断，那是发言频道列表的做法，这里不能丢
      if (a.projects.length > 100) a.projects = a.projects.slice(-100);
      this._saveRegistry();
    }
    // 频道文件不存在就建个空的，这样它才会出现在频道列表里
    const file = this.projectPath(project);
    if (!fs.existsSync(file)) fs.writeFileSync(file, '', 'utf8');
    return { project, name, id: a.id };
  }

  removeFromProject(project, name) {
    if (!isValidName(project)) throw new Error('频道名只能用字母、数字、下划线、连字符');
    if (project === MAIN_PROJECT) {
      const err = new Error('general 是主频道，成员移不出去');
      err.code = 'MAIN_PROJECT';
      throw err;
    }
    const reg = this.registry();
    const a = reg[name];
    if (!a) throw new Error(`没有 ${name} 这个 agent`);
    const before = a.projects.length;
    a.projects = a.projects.filter((p) => p !== project);
    if (a.projects.length !== before) this._saveRegistry();
    return { project, name, id: a.id };
  }

  // ---------- 游标 ----------

  cursorFile(agent) {
    if (!isValidName(agent)) throw new Error('agent 只能用字母、数字、下划线、连字符');
    return path.join(this.cursorsDir, `${agent}.json`);
  }

  getCursor(agent) {
    return readJsonSafe(this.cursorFile(agent), {});
  }

  setCursor(agent, project, lastId) {
    if (!isValidName(project)) throw new Error('project 不合法');
    const cur = this.getCursor(agent);
    cur[project] = { lastId, at: nowIso() };
    writeJsonAtomic(this.cursorFile(agent), cur);
    return cur[project];
  }
}
