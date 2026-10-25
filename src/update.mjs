// 更新检查。只比对 version 和 build，不下载也不安装。
//
// 为什么不接 electron-updater：AgentChat 的版本号锁死在 1.0.0，只递增 build。
// electron-updater 看语义版本没变就认为没更新，接进来也是摆设。LumEdit 能双轨并行，
// 是因为它两条路都留着；这边只留真正起作用的那条。
//
// 清单地址不写死。没有发布源的时候硬去查，只会每次检查都报错，界面上一直挂个红点。
// 所以默认关闭，配了才查，来源按优先级：
//   1. 环境变量 AGENT_CHAT_UPDATE_URL，配套 AGENT_CHAT_UPDATE_PREFIX 限定下载域名
//   2. userData/update-source.json，形如 {"url": "...", "downloadPrefix": "..."}
// 两个都没有就返回 disabled，界面什么都不显示。
//
// 清单格式跟 LumEdit 保持一致，以后要挪过来直接能用：
//   { "version": "1.0.0", "build": 2, "downloads": { "windows": "..." },
//     "notes": { "zh": "..." } }

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const TIMEOUT_MS = 8000;
const DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000;

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
  if (!file) return null;
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    const url = String(j.url || '').trim();
    if (!url) return null;
    return { url, downloadPrefix: String(j.downloadPrefix || '').trim(), origin: file };
  } catch {
    return null;
  }
}

/**
 * @returns {{kind:'newer'|'rebuilt'|'latest'|'disabled'|'error', version?:string,
 *            build?:number, notes?:string, downloadUrl?:string, message?:string}}
 */
export async function checkForUpdate({ localVersion, localBuild, source, fetchImpl }) {
  if (!source?.url) return { kind: 'disabled' };

  const doFetch = fetchImpl || globalThis.fetch;
  try {
    // CDN 会缓存，加个时间戳绕过去。清单很小，每次都取新的也无所谓。
    const u = new URL(source.url);
    u.searchParams.set('t', String(Date.now()));

    const r = await doFetch(u.toString(), {
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { accept: 'application/json' },
    });
    if (!r.ok) throw new Error(`清单请求失败 ${r.status}`);

    const j = await r.json();
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
