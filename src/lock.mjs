// 单实例守卫。
//
// 群聊最容易出的事故是两个服务同时活着：各自持有不同的内存状态，
// 各自往同一个 jsonl 追加，游标互相覆盖，前端还连到不知道哪个。
// 这里用「锁文件 + pid 存活 + 端口探测」三重判断，保证全机只有一个写入者。
//
// 锁文件残留是常态（进程被杀、断电），所以不能只看到文件就当有锁，
// 必须 pid 还活着并且端口真能应答，才算数。

import fs from 'node:fs';
import path from 'node:path';
import { isPidAlive, readJsonSafe, writeJsonAtomic, nowIso } from './store.mjs';

export const LOCK_NAME = '_server.lock';
export const RUNTIME_NAME = '_runtime.json';
export const HEALTH_PATH = '/api/health';

export function lockPath(dir) { return path.join(dir, LOCK_NAME); }
export function runtimePath(dir) { return path.join(dir, RUNTIME_NAME); }

export function readRuntime(dir) {
  return readJsonSafe(runtimePath(dir), null);
}

export function writeRuntime(dir, info) {
  writeJsonAtomic(runtimePath(dir), info);
}

export function clearRuntime(dir, instanceId) {
  const cur = readRuntime(dir);
  if (!cur || !instanceId || cur.instanceId === instanceId) {
    try { fs.unlinkSync(runtimePath(dir)); } catch {}
  }
}

export function clearLock(dir, pid) {
  const cur = readJsonSafe(lockPath(dir), null);
  if (!cur || !pid || cur.pid === pid) {
    try { fs.unlinkSync(lockPath(dir)); } catch {}
  }
}

// 问一下某个端口上跑的是不是我们，返回 health 对象或 null
export async function pingHealth(port, host = '127.0.0.1', timeoutMs = 900) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(`http://${host}:${port}${HEALTH_PATH}`, { signal: ac.signal });
    if (!r.ok) return null;
    const d = await r.json();
    return d && d.ok && d.app === 'agent-chat' ? d : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// 找一个活着的服务。没有就返回 null。
export async function discover(dir, host = '127.0.0.1') {
  const rt = readRuntime(dir);
  if (!rt || !rt.port) return null;
  if (rt.pid && !isPidAlive(rt.pid)) return null;
  const health = await pingHealth(rt.port, host);
  if (!health) return null;
  if (rt.instanceId && health.instanceId !== rt.instanceId) return null;
  return { ...rt, health };
}

// 抢锁。抢到返回 true。已有活锁返回 false。
export function tryAcquireLock(dir, payload) {
  const file = lockPath(dir);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = fs.openSync(file, 'wx');
      fs.writeSync(fd, JSON.stringify({ ...payload, at: nowIso() }));
      fs.closeSync(fd);
      return true;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const cur = readJsonSafe(file, null);
      // 锁在但进程没了，属于残留，删掉重抢
      if (!cur || !isPidAlive(cur.pid)) {
        try { fs.unlinkSync(file); } catch {}
        continue;
      }
      return false;
    }
  }
  return false;
}

export function releaseLock(dir) {
  clearLock(dir, process.pid);
}
