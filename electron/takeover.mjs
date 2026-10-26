// 桌面版启动前先看一眼端口上蹲的是谁。
//
// startServer 的复用只按数据目录认实例，分不出两种情况：
//   1. 同一个桌面程序开了两次，第二个窗口应该贴到第一个上，这是对的；
//   2. 开发时 node src/standalone.mjs 起的服务还在跑，桌面版贴上去就变成
//      用那个没有 Electron 外壳的服务，更新能力直接没了，跑的还可能是旧代码。
// 这里只处理第 2 种：_runtime.json 里 electron 明确写着 false 才动手。
// 蹲着的是另一个桌面版就原样复用，不能杀。
//
// 单独一个文件是为了能脱离 Electron 跑起来验，见 test/selfcheck.mjs。

import fs from 'node:fs';
import path from 'node:path';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @returns {Promise<'none'|'taken-over'|'kept'>}
 *   none      端口上没人
 *   taken-over 收掉了源码态服务，端口已放开
 *   kept      有实例但没动它（是桌面版，或者停不掉）
 */
export async function takeOverFromSourceServer({ dir, port, log = () => {}, waitMs = 3000 } = {}) {
  const rtFile = path.join(dir, '_runtime.json');
  let rt = null;
  try {
    rt = JSON.parse(fs.readFileSync(rtFile, 'utf8'));
  } catch {
    return 'none';
  }
  if (!rt || !rt.pid || rt.electron !== false) return 'kept';

  // 进程还活着才算数。EPERM 说明进程在，只是没权限发信号，也算活着。
  try {
    process.kill(rt.pid, 0);
  } catch (e) {
    if (e.code !== 'EPERM') return 'none';
  }

  log(`端口上蹲着源码态服务（pid ${rt.pid}），停掉它，改用桌面版自己的服务`);
  try {
    process.kill(rt.pid);
  } catch (e) {
    log(`停不掉 pid ${rt.pid}（${e.message}），继续复用，更新能力会没有`);
    return 'kept';
  }

  // 等端口真放开。进程退出和端口释放之间有间隔，直接起会撞 EADDRINUSE。
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    await sleep(100);
    try {
      await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(300) });
    } catch {
      log(`源码态服务已停，端口 ${port} 已释放`);
      return 'taken-over';
    }
  }
  log(`源码态服务 ${waitMs} 毫秒内没退出，仍然复用它`);
  return 'kept';
}
