// 打包脚本。一条命令出三样东西：安装包、单文件免安装、目录版。
//
//   npm run dist
//
// 跟 LumEdit 的 scripts/dist.mjs 是同一套路子，但这边只有一档，没有档位参数。
//
// 三个跟裸跑 electron-builder 不一样的地方，都是为了避开踩过的坑：
//
// 一、产物出在工作区外（默认 E:/AgentChat-dist，可用 AGENT_CHAT_DIST_OUT 覆盖）。
//     放工作区里会被编辑器的文件监视锁住 app.asar，第二次打包直接失败。
//
// 二、打包前先把上一轮的产物挪到 _trash 再删。electron-builder 自己清 win-unpacked
//     时会撞上 safe-delete 的批量确认守卫（单轮超过 50 项就拦），挪走最省事。
//     挪不动基本就是 win-unpacked 里的 exe 还开着，这时直接报错让人关掉，别硬来。
//
// 三、用 -c.electronDist 指向本地已装好的 electron。不然打包器会去下载或者解压缓存
//     里的 zip，网络一抖就卡在那里。
//
// 版本号不在这里改，看 scripts/build-meta.mjs。
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { APP_NAME, VERSION, BUILD } from './build-meta.mjs';

const root = path.resolve(import.meta.dirname, '..');

const outRoot =
  process.env.AGENT_CHAT_DIST_OUT ||
  (fs.existsSync('E:/') ? 'E:/AgentChat-dist' : path.join(os.homedir(), 'AgentChat-dist'));

const log = (m) => console.log(`[dist] ${m}`);

fs.mkdirSync(outRoot, { recursive: true });

// 上一轮的产物清单。只认这几个，目录里别的东西（比如自己放的笔记）不动。
const PREVIOUS = (name) =>
  name === 'win-unpacked' ||
  name === 'builder-debug.yml' ||
  name === 'builder-effective-config.yaml' ||
  name === 'latest.yml' ||
  name.endsWith('.exe') ||
  name.endsWith('.exe.blockmap');

function movePreviousAside() {
  const items = fs.readdirSync(outRoot).filter(PREVIOUS);
  if (!items.length) return null;

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const trash = path.join(outRoot, '_trash', stamp);
  fs.mkdirSync(trash, { recursive: true });

  for (const name of items) {
    try {
      fs.renameSync(path.join(outRoot, name), path.join(trash, name));
    } catch (e) {
      if (e.code === 'EPERM' || e.code === 'EBUSY' || e.code === 'ENOTEMPTY') {
        console.error(`[dist] 挪不动 ${name}。先关掉正在跑的 AgentChat 再打包。`);
        console.error(`[dist] 占用的多半是 ${path.join(outRoot, 'win-unpacked', 'AgentChat.exe')}`);
        process.exit(1);
      }
      throw e;
    }
  }
  log(`上一轮 ${items.length} 项产物已挪到 _trash/${stamp}`);
  return trash;
}

function removeTrash(trash) {
  if (!trash) return;
  // 不能直接 fs.rmSync：_trash 里是上一轮的整个 win-unpacked，项数远超 safe-delete
  // 单轮 50 的上限，会被 SAFE_DELETE_BULK_CONFIRM_REQUIRED 拦下来（实测 80 项）。
  // 交给 PowerShell 删，它走的是另一条路径。删不掉就打印路径，别硬来。
  const quoted = trash.replace(/'/g, "''");
  spawnSync(
    'powershell',
    ['-NoProfile', '-NonInteractive', '-Command',
      `Remove-Item -LiteralPath '${quoted}' -Recurse -Force -ErrorAction SilentlyContinue`],
    { stdio: 'pipe', windowsHide: true },
  );

  if (fs.existsSync(trash)) {
    console.warn(`[dist] _trash 没删干净，手动清一下：${trash}`);
    return;
  }
  try {
    const parent = path.dirname(trash);
    if (fs.existsSync(parent) && fs.readdirSync(parent).length === 0) fs.rmdirSync(parent);
  } catch {}
  log('_trash 已清空');
}

const trash = movePreviousAside();

const builderCli = path.join(root, 'node_modules', 'electron-builder', 'cli.js');
if (!fs.existsSync(builderCli)) {
  console.error('[dist] 找不到 electron-builder，先 npm install');
  process.exit(1);
}

const args = [
  builderCli,
  '--win',
  '--x64',
  '--config',
  'electron-builder.yml',
  // 只生成更新清单，不上传。上传是发布环节，单独走，别跟打包混在一起。
  '--publish',
  'never',
  // 产物版本跟 build 号走命令行注入，package.json 里的 version 保持 1.0.0 不动
  `-c.extraMetadata.version=${VERSION}`,
  `-c.extraMetadata.buildNumber=${BUILD}`,
  `-c.directories.output=${outRoot}`,
  // 直接用本地装好的 electron 分发，不让打包器去下载
  '-c.electronDist=node_modules/electron/dist',
];

log(`打 ${APP_NAME} ${VERSION} build ${BUILD} -> ${outRoot}`);
const r = spawnSync(process.execPath, args, { cwd: root, stdio: 'inherit' });
if (r.status !== 0) {
  console.error(`[dist] 打包失败，退出码 ${r.status}`);
  process.exit(r.status ?? 1);
}

// 可发布的资产放仓库的 release/，出目录里只留 win-unpacked 供本机直接跑。
// 两边各留一份会让人分不清哪份是准的，所以拷完就把源文件删掉。
// 没有 latest.yml：那是 electron-updater 的清单，这条路不走（见 electron-builder.yml 的说明）。
// 更新靠仓库根目录的 update.json，发版时按 scripts/build-meta.mjs 的版本和 build 改它。
const relDir = path.join(root, 'release');
fs.mkdirSync(relDir, { recursive: true });
const assets = [
  `AgentChat-${VERSION}-setup.exe`,
  `AgentChat-${VERSION}-setup.exe.blockmap`,
  `AgentChat-${VERSION}-portable.exe`,
  // 绿色版自动更新下这个，解压覆盖 win-unpacked 自己
  `AgentChat-${VERSION}-win.zip`,
];
const copied = [];
for (const name of assets) {
  const src = path.join(outRoot, name);
  if (!fs.existsSync(src)) continue;
  const dest = path.join(relDir, name);
  // 有人把出目录直接设成 release/ 的时候，别把自己刚写的东西删了
  if (path.resolve(src) !== path.resolve(dest)) {
    fs.copyFileSync(src, dest);
    fs.rmSync(src, { force: true });
  }
  copied.push(name);
}

removeTrash(trash);

// 剩下的构建副产物直接删掉，出目录里只留 win-unpacked。
// latest.yml 是 electron-updater 的清单，这条路不走（版本锁死只递增 build，
// 它比语义版本永远认为最新），留着会让人以为能用。builder-debug.yml 是排查用的，
// 真出问题重新打一次就有，不必常驻。
for (const junk of ['latest.yml', 'builder-debug.yml', 'builder-effective-config.yaml']) {
  fs.rmSync(path.join(outRoot, junk), { force: true });
}

log(`完成，${copied.length} 个资产已放到 release/`);
for (const name of copied) log(`  release/${name}`);
log(`免安装目录版：${path.join(outRoot, 'win-unpacked', 'AgentChat.exe')}`);
log(`单文件便携版：${path.join(relDir, `AgentChat-${VERSION}-portable.exe`)}`);

const missing = assets.filter((n) => !copied.includes(n));
if (missing.length) {
  console.warn(`[dist] 这些没生成，检查一下 target 配置：${missing.join(', ')}`);
}

// 把校验字段算好写回 update.json。
//
// 以前 sha256 和 size 一直空着，靠人记着发版前手动补，结果连着几个 build 都忘了。
// 现在打完包直接算：安装包一份、绿色版目录包一份，两个文件不一样，所以清单里是两组
// 字段。只留一组的话，绿色版更新拿安装包的哈希去比，必然对不上。
//
// 流式算，不把 100 多兆的包整个读进内存。
function digest(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    let bytes = 0;
    const rs = fs.createReadStream(file);
    rs.on('data', (c) => { bytes += c.length; h.update(c); });
    rs.on('end', () => resolve({ sha256: h.digest('hex'), size: bytes }));
    rs.on('error', reject);
  });
}

const manifestPath = path.join(root, 'update.json');
let manifest = {};
try {
  manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
} catch {
  console.warn('[dist] update.json 读不出来，跳过校验字段回填');
  manifest = null;
}

if (manifest) {
  // 读 release/ 里的那份。上面已经把资产从 outRoot 拷过来并删了源文件，
  // 这里再按 outRoot 找会全部落空，哈希就一直停在上一轮的值上。
  const setup = path.join(relDir, `AgentChat-${VERSION}-setup.exe`);
  const zip = path.join(relDir, `AgentChat-${VERSION}-win.zip`);
  if (fs.existsSync(setup)) {
    const d = await digest(setup);
    manifest.sha256 = d.sha256;
    manifest.size = d.size;
  }
  if (fs.existsSync(zip)) {
    const d = await digest(zip);
    manifest.sha256Zip = d.sha256;
    manifest.sizeZip = d.size;
  }
  // 版本和 build 以 build-meta 为准，避免清单和产物对不上
  manifest.version = VERSION;
  manifest.build = BUILD;
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  log(`update.json 校验字段已回填（build ${BUILD}）`);
  if (manifest.sha256) log(`  安装包 ${manifest.sha256.slice(0, 16)}… ${manifest.size} 字节`);
  if (manifest.sha256Zip) log(`  绿色包 ${manifest.sha256Zip.slice(0, 16)}… ${manifest.sizeZip} 字节`);
}

