// agent 的 key 文件，一个名字一个。
//
// 存在 <数据目录>/.agents/<名字>.key，明文。
//
// 为什么不放界面的 localStorage：localStorage 是按 origin 分的，界面跑在
// http://127.0.0.1:端口 上，端口一变（7788 被占就换 7789）整个存储就是另一份，
// 换个安装目录 userData 变了也一样。表现就是每次重进都要重新接管名字。
// 数据目录是固定的，重装、换端口、换目录都不影响，所以 key 的家在这里。
//
// 明文存盘的取舍：能读这个目录的人本来就能改 agents.json 和所有消息，
// 加密只是骗自己。真正的边界是「这台机器」。

import fs from 'node:fs';
import path from 'node:path';

export function keyDir(dataDir) {
  return path.join(dataDir, '.agents');
}

export function keyFile(dataDir, name) {
  return path.join(keyDir(dataDir), `${name}.key`);
}

export function readKey(dataDir, name) {
  try {
    return fs.readFileSync(keyFile(dataDir, name), 'utf8').trim() || null;
  } catch {
    return null;
  }
}

export function saveKey(dataDir, name, key) {
  try {
    fs.mkdirSync(keyDir(dataDir), { recursive: true });
    fs.writeFileSync(keyFile(dataDir, name), String(key), 'utf8');
    return true;
  } catch {
    return false;
  }
}

export function removeKey(dataDir, name) {
  try { fs.unlinkSync(keyFile(dataDir, name)); } catch {}
}
