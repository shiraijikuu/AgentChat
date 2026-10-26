// 更新检查。只比对 version 和 build，不下载也不安装。
//
// 为什么不接 electron-updater：AgentChat 的版本号锁死在 1.0.0，只递增 build。
// electron-updater 看语义版本没变就认为没更新，接进来也是摆设。LumEdit 能双轨并行，
// 是因为它两条路都留着；这边只留真正起作用的那条。
//
// 清单地址有内置默认值，装上就能查，不用先配一个 json 文件。想覆盖按优先级：
//   1. 环境变量 AGENT_CHAT_UPDATE_URL，配套 AGENT_CHAT_UPDATE_PREFIX 限定下载域名
//   2. userData/update-source.json，形如 {"url": "...", "downloadPrefix": "..."}
//   3. 内置的 jsdelivr 镜像
// 彻底关掉用 AGENT_CHAT_NO_UPDATE=1。
//
// 清单格式跟 LumEdit 保持一致，以后要挪过来直接能用：
//   { "version": "1.0.0", "build": 2, "downloads": { "windows": "..." },
//     "notes": { "zh": "..." } }

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const TIMEOUT_MS = 8000;
const DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000;

// 取清单的退避间隔。国内连 jsdelivr 会间歇性被重置，实测同一条地址前一次
// ECONNRESET、几秒后再试就是 200，只试一次的话用户只会看到一句 fetch failed。
// 第一次立刻打，后面两次隔一小会儿。
const RETRY_DELAYS_MS = [0, 600, 1400];

// jsdelivr 的几个入口走的是不同线路，被重置的时间点常常错开。
// 主入口连着失败时换一个再试，比在同一台机器上死磕有用。
const JSDELIVR_MIRRORS = ['fastly.jsdelivr.net', 'gcore.jsdelivr.net'];

// 同一个清单的候选地址。只有 jsdelivr 会展开成多个，别的源原样返回。
export function candidateUrls(url) {
  const list = [url];
  let u;
  try {
    u = new URL(url);
  } catch {
    return list;
  }
  if (!/(^|\.)jsdelivr\.net$/i.test(u.hostname)) return list;
  for (const host of JSDELIVR_MIRRORS) {
    if (host === u.hostname) continue;
    const alt = new URL(url);
    alt.hostname = host;
    list.push(alt.toString());
  }
  return list;
}

// 网络层的错误只有 message（fetch failed），真正的原因在 cause.code 里。
function describeFetchError(e, url, triedHosts = 1) {
  if (e && e.status) return `清单请求失败 ${e.status}（${url}）`;
  const cause = e?.cause?.code || e?.cause?.message || '';
  const detail = [e?.message || String(e), cause].filter(Boolean).join('，');
  const tail = triedHosts > 1
    ? `${triedHosts} 个入口各试了 ${RETRY_DELAYS_MS.length} 次`
    : `试了 ${RETRY_DELAYS_MS.length} 次`;
  return `连不上更新源 ${url}（${detail}），${tail}`;
}

// 取清单，网络错误和 5xx 重试，4xx 直接报（地址写错了重试也一样）。
async function fetchManifestJson(url, doFetch) {
  let last = null;
  for (let i = 0; i < RETRY_DELAYS_MS.length; i += 1) {
    if (RETRY_DELAYS_MS[i]) await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[i]));

    let r;
    try {
      r = await doFetch(url, {
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: { accept: 'application/json' },
      });
    } catch (e) {
      last = e;
      continue;
    }

    if (r.status >= 400 && r.status < 500) {
      const err = new Error(`清单请求失败 ${r.status}`);
      err.status = r.status;
      throw err;
    }
    if (!r.ok) {
      const err = new Error(`服务端 ${r.status}`);
      err.status = r.status;
      last = err;
      continue;
    }
    try {
      return await r.json();
    } catch (e) {
      // 拿到的不是合法 JSON，可能是 CDN 抽风，重试一次也可能好
      last = e;
    }
  }
  throw last;
}

// 走 jsdelivr 镜像而不是 raw.githubusercontent：后者在国内经常连不上，
// 而自动检查更新失败是静默的，用户只会觉得「从来没提示过有新版本」。
// 代价是 jsdelivr 对分支有缓存，发版后最长可能等十二小时才刷到新清单，
// 实测一般几分钟。清单后面的 ?t= 只能绕开本地缓存，绕不开 CDN。
const DEFAULT_UPDATE_URL = 'https://cdn.jsdelivr.net/gh/shiraijikuu/AgentChat@main/update.json';
// 内置源只认自己仓库的 Release 附件。清单放在第三方 CDN 上没有签名，
// 万一被改，至少不能让下载地址指到别处。
const DEFAULT_DOWNLOAD_PREFIX = 'https://github.com/shiraijikuu/AgentChat/releases/';

// 清单来自第三方 CDN，没有签名。下载地址只认这些前缀，其余一律丢掉，
// 免得清单被改了指到别处让人下载安装包。
const DEFAULT_ALLOWED_PREFIXES = ['https://github.com/'];

export function compareSemver(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i += 1) {
    const x = Number.isFinite(pa[i]) ? pa[i] : 0;
    const y = Number.isFinite(pb[i]) ? pb[i] : 0;
    if (x > y) return 1;
    if (x < y) return -1;
  }
  return 0;
}

export function resolveDownloadUrl(raw, allowedPrefixes) {
  const list = allowedPrefixes?.length ? allowedPrefixes : DEFAULT_ALLOWED_PREFIXES;
  if (typeof raw !== 'string') return '';
  const trimmed = raw.trim();
  if (!trimmed) return '';
  return list.some((prefix) => trimmed.startsWith(prefix)) ? trimmed : '';
}

export function readUpdateSource(file) {
  const fromEnv = (process.env.AGENT_CHAT_UPDATE_URL || '').trim();
  if (fromEnv) {
    return {
      url: fromEnv,
      downloadPrefix: (process.env.AGENT_CHAT_UPDATE_PREFIX || '').trim(),
      origin: 'env',
    };
  }
  if (file) {
    try {
      const j = JSON.parse(fs.readFileSync(file, 'utf8'));
      const url = String(j.url || '').trim();
      if (url) {
        return { url, downloadPrefix: String(j.downloadPrefix || '').trim(), origin: file };
      }
    } catch {
      // 文件不存在或者写坏了都走默认，不当成错误。用户可能压根没建过这个文件。
    }
  }
  return { url: DEFAULT_UPDATE_URL, downloadPrefix: DEFAULT_DOWNLOAD_PREFIX, origin: 'default' };
}

/**
 * @returns {{kind:'newer'|'rebuilt'|'latest'|'disabled'|'error', version?:string,
 *            build?:number, notes?:string, downloadUrl?:string, message?:string}}
 */
export async function checkForUpdate({ localVersion, localBuild, source, fetchImpl }) {
  if (!source?.url) return { kind: 'disabled' };

  const doFetch = fetchImpl || globalThis.fetch;
  // CDN 会缓存，加个时间戳绕过去。清单很小，每次都取新的也无所谓。
  const u = new URL(source.url);
  u.searchParams.set('t', String(Date.now()));

  // 网络这一段单独兜。连不上和「清单内容不合法」是两回事，报错要分得开，
  // 不然界面上只会显示一句 fetch failed，看不出是网络还是清单坏了。
  let j = null;
  let lastErr = null;
  const candidates = candidateUrls(u.toString());
  for (const target of candidates) {
    try {
      j = await fetchManifestJson(target, doFetch);
      break;
    } catch (e) {
      // 4xx 是地址问题，换入口也一样，直接报，别再折腾别的镜像
      if (e && e.status && e.status < 500) {
        return { kind: 'error', message: describeFetchError(e, source.url) };
      }
      lastErr = e;
    }
  }
  if (!j) return { kind: 'error', message: describeFetchError(lastErr, source.url, candidates.length) };

  try {
    const remoteVersion = String(j.version || '').trim();
    if (!/^\d+(\.\d+){2}/.test(remoteVersion)) throw new Error('清单里的 version 不合法');

    const remoteBuild = Number(j.build || 0);
    if (!Number.isFinite(remoteBuild) || remoteBuild < 0) throw new Error('清单里的 build 不合法');

    const notes = j.notes?.zh || j.notes?.en || '';
    const allowed = source.downloadPrefix ? [source.downloadPrefix] : null;
    const downloadUrl = resolveDownloadUrl(j.downloads?.windows ?? j.download_url, allowed);
    // 绿色版更新要的是整个目录包，不是安装程序
    const zipUrl = resolveDownloadUrl(j.downloads?.windowsZip, allowed);
    const sha256 = typeof j.sha256 === 'string' ? j.sha256.trim() : '';
    const size = Number(j.size || 0) || 0;
    // 绿色版下的是目录包，跟安装包不是同一个文件，哈希也不一样。
    // 只留一组字段的话，绿色版更新拿安装包的哈希去比，必然校验失败。
    const sha256Zip = typeof j.sha256Zip === 'string' ? j.sha256Zip.trim() : '';
    const sizeZip = Number(j.sizeZip || 0) || 0;

    const cmp = compareSemver(remoteVersion, localVersion);
    if (cmp > 0) {
      return { kind: 'newer', version: remoteVersion, build: remoteBuild, notes, downloadUrl, zipUrl, sha256, size, sha256Zip, sizeZip };
    }
    if (cmp === 0 && remoteBuild > localBuild) {
      return { kind: 'rebuilt', version: remoteVersion, build: remoteBuild, notes, downloadUrl, zipUrl, sha256, size, sha256Zip, sizeZip };
    }
    return { kind: 'latest', version: localVersion, build: localBuild };
  } catch (e) {
    return { kind: 'error', message: e.message || String(e) };
  }
}

/**
 * 把安装包下到本地。
 *
 * 清单里给了 sha256 就校验，没给就至少确认是 PE 文件（开头两个字节是 MZ）。
 * 没有签名的情况下这两道能挡住下到半截和拿到错误页的情况，挡不住有人主动换包，
 * 所以清单本身要放在自己能控制的地方。
 */
export async function downloadUpdate({ url, dest, expectedSha256, expectMagic = 'MZ', onProgress, fetchImpl }) {
  const doFetch = fetchImpl || globalThis.fetch;
  fs.mkdirSync(path.dirname(dest), { recursive: true });

  const part = `${dest}.part`;
  const r = await doFetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  if (!r.ok) throw new Error(`下载失败 ${r.status}`);
  if (!r.body) throw new Error('下载失败，响应里没有内容');

  const total = Number(r.headers.get('content-length') || 0);
  const hash = crypto.createHash('sha256');
  let received = 0;

  // 不用 Readable.fromWeb 转成 node 流：在 Electron 主进程里传大文件会把进程直接干掉，
  // 没有任何 JS 报错，日志里也看不到。手动读 reader 再写盘就没这问题。
  const ws = fs.createWriteStream(part);
  const reader = r.body.getReader();

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.length;
      hash.update(value);
      // 写不进去就等 drain，别把整个文件堆在内存里
      if (!ws.write(value)) {
        await new Promise((resolve, reject) => {
          ws.once('drain', resolve);
          ws.once('error', reject);
        });
      }
      if (onProgress) {
        onProgress(total > 0 ? Math.min(99, Math.round((received / total) * 100)) : 0, received, total);
      }
    }
    await new Promise((resolve, reject) => {
      ws.end(() => resolve());
      ws.once('error', reject);
    });
  } catch (e) {
    ws.destroy();
    try { fs.unlinkSync(part); } catch {}
    throw new Error(`下载中断：${e.message}`);
  }

  const actual = hash.digest('hex');
  if (expectedSha256 && actual.toLowerCase() !== String(expectedSha256).toLowerCase()) {
    try { fs.unlinkSync(part); } catch {}
    throw new Error('安装包校验不通过，文件不完整或被换过');
  }

  // 至少得是个真文件。安装包看 MZ，绿色版目录包看 PK（zip）。
  // 下到错误页或者半截文件时这里能拦住。
  let head = '';
  try {
    const fd = fs.openSync(part, 'r');
    const buf = Buffer.alloc(2);
    fs.readSync(fd, buf, 0, 2, 0);
    fs.closeSync(fd);
    head = buf.toString('ascii');
  } catch {}
  if (head !== expectMagic) {
    try { fs.unlinkSync(part); } catch {}
    throw new Error(`下载到的不是预期的文件（开头是 ${head || '空'}，应该是 ${expectMagic}）`);
  }

  try { fs.renameSync(part, dest); } catch (e) {
    try { fs.unlinkSync(part); } catch {}
    throw new Error(`安装包落盘失败：${e.message}`);
  }

  return { file: dest, bytes: received, sha256: actual };
}
