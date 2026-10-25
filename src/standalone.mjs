// 前台跑服务。给命令行和调试用，Electron 走的是自己的主进程。
import { startServer } from './server.mjs';
import { resolveDataDir } from './paths.mjs';

const dir = resolveDataDir();
const port = Number(process.env.AGENT_CHAT_PORT || 7788);
const host = process.env.AGENT_CHAT_HOST || '127.0.0.1';

const s = await startServer({ dir, port, host, onLog: (m) => console.log(m) });

const shutdown = async () => {
  try { await s.close(); } catch {}
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('exit', () => { try { s.close(); } catch {} });
