// Electron 主进程。
//
// 这里只干三件事：抢单实例、把服务起在本进程里、把窗口指向它。
// 服务跟窗口同生共死，不会出现「窗口关了服务还在后台乱写」的情况。
//
// 第二个实例被系统拦掉之后，会把第一个窗口拉到前面再自己退出。
// 这就是「同一台机器上不会有两个群聊在写同一份数据」的第一道闸。

import { app, BrowserWindow, Menu, Tray, shell, dialog, clipboard, nativeTheme } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { startServer } from '../src/server.mjs';
import { resolveDataDir } from '../src/paths.mjs';
import { checkForUpdate, downloadUpdate, readUpdateSource } from '../src/update.mjs';
import { createAppSettings } from './app-settings.mjs';
import { resolveCloseAction } from './window-lifecycle.mjs';
import { takeOverFromSourceServer } from './takeover.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// 自绘标题栏。高度要跟界面那条 .titlebar 完全一致，否则拖动区和窗口按钮会错位。
const TITLEBAR_HEIGHT = 34;
const TITLEBAR_DARK = '#0d0f13';
const TITLEBAR_LIGHT = '#f6f7f9';

function hexLuminance(value) {
  const hex = String(value || '').replace('#', '');
  if (!/^[0-9a-f]{6}$/i.test(hex)) return 0;
  const channels = [0, 2, 4].map((at) => Number.parseInt(hex.slice(at, at + 2), 16) / 255)
    .map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

// build 号从产物里的 package.json 读，dist.mjs 打包时用 extraMetadata 写进去。
// 开发态没有这个字段，读出来是 0。
let buildNumber = 0;
try {
  const pkg = createRequire(import.meta.url)('../package.json');
  buildNumber = Number.isFinite(pkg.buildNumber) ? pkg.buildNumber : 0;
} catch {}

// ---------------- 落盘位置 ----------------
// Electron 默认把 userData 写到 C:\Users\<用户名>\AppData\Roaming\AgentChat，
// Chromium 的 Cache、GPUCache、Code Cache 全在它下面，用一阵子就是几百兆。
// 这里统一挪到程序目录下的 data，绿色版整个文件夹拷走时缓存和配置跟着走，也不占系统盘。
//
// 安装版如果装在 Program Files 这种只读位置，写不进去就保持默认，别因为挪不了起不来。
const DEFAULT_USER_DATA = app.getPath('userData');
const appRoot = app.isPackaged ? path.dirname(app.getPath('exe')) : path.join(HERE, '..');

let userDataDir = DEFAULT_USER_DATA;
if (app.isPackaged) {
  const wanted = path.join(appRoot, 'data');
  try {
    fs.mkdirSync(wanted, { recursive: true });
    fs.accessSync(wanted, fs.constants.W_OK);
    app.setPath('userData', wanted);
    userDataDir = wanted;
  } catch {
    userDataDir = DEFAULT_USER_DATA;
  }
}

// 下载的更新包也放程序目录下，不用系统临时目录（那在 C 盘）。
// 留着不删，下次重装或者回退时还能拿到。
const updateCacheDir = path.join(userDataDir, 'cache', 'updates');

// 默认关掉硬件加速。
//
// 这个工具本质就是显示一个网页，GPU 加速没有任何收益。而这台机器上硬件加速一崩，
// 表现就是窗口出来了但里面全空，日志里连着刷 GPU process exited unexpectedly，
// 然后 FATAL 退出。用户双击 exe 时不会去设环境变量，所以每次都是白窗口。
//
// 真要开硬件加速，设 AGENT_CHAT_SOFTWARE_GL=0。这个变量名是历史遗留，
// 现在含义反过来了：不设就关，设成 0 才开。
if (process.env.AGENT_CHAT_SOFTWARE_GL !== '0') {
  app.disableHardwareAcceleration();
  // 光 disableHardwareAcceleration 压不住：Electron 44 里 GPU 进程照样会起来然后崩。
  // 这几个开关是实测能过的组合，走 ANGLE 的软件后端。
  app.commandLine.appendSwitch('use-gl', 'angle');
  app.commandLine.appendSwitch('use-angle', 'swiftshader');
  app.commandLine.appendSwitch('enable-unsafe-swiftshader');
  app.commandLine.appendSwitch('no-sandbox');
}

// ---------------- 自动更新 ----------------
//
// 走 update.json 比对 build，不用 electron-updater。原因在 src/update.mjs 开头写了。
//
// 流程：检查 → 下载安装包到临时目录 → 校验 → 起一个独立进程，等本进程退出后静默装 →
// 装完把新版拉起来。
//
// 三个开关：
//   AGENT_CHAT_UPDATE_URL      覆盖清单地址（本地测试就指这里）
//   AGENT_CHAT_UPDATE_PREFIX   限制下载域名，不设就只认 github.com
//   AGENT_CHAT_NO_UPDATE=1     彻底关掉，自检和截图时用
function createUpdater({ quit = () => app.quit() } = {}) {
  const sourceFile = path.join(app.getPath('userData'), 'update-source.json');
  // 便携版是自解压的单文件，运行在临时目录里，没法原地替换
  const isPortable = Boolean(process.env.PORTABLE_EXECUTABLE_DIR);
  // 绿色版：解压出来直接双击跑的那种（win-unpacked）。NSIS 安装版目录里会有卸载程序，
  // 没有就是绿色版。这种更新要下整个目录包解压覆盖自己，不能跑安装程序，
  // 否则会在别处凭空装一份，手里这个文件夹还是旧的。
  const exeDir = path.dirname(app.getPath('exe'));
  const isGreen = !isPortable && !fs.existsSync(path.join(exeDir, 'Uninstall AgentChat.exe'));

  const state = {
    phase: 'idle', // idle | checking | downloading | ready | error | disabled
    localVersion: app.getVersion(),
    localBuild: buildNumber,
    remote: null,
    percent: 0,
    message: '',
    checkedAt: '',
    file: '',
  };

  const snapshot = () => ({
    ...state,
    portable: isPortable,
    green: isGreen,
    packaged: app.isPackaged,
    canInstall: app.isPackaged && !isPortable,
  });

  async function check() {
    if (process.env.AGENT_CHAT_NO_UPDATE === '1') {
      state.phase = 'disabled';
      state.message = '更新已关闭（AGENT_CHAT_NO_UPDATE=1）';
      return snapshot();
    }
    if (!app.isPackaged) {
      state.phase = 'disabled';
      state.message = '开发态没有更新能力，要测请用打包版';
      return snapshot();
    }
    const source = readUpdateSource(sourceFile);
    if (!source) {
      state.phase = 'disabled';
      // 正常不会走到这里：readUpdateSource 有内置兜底，永远返回一个地址。
      // 留着是防以后有人把兜底去掉，那时这里要能说清楚原因。
      state.message = '更新源读不出来，内置地址也没生效';
      return snapshot();
    }

    state.phase = 'checking';
    state.message = '';
    const r = await checkForUpdate({
      localVersion: state.localVersion,
      localBuild: state.localBuild,
      source,
    });
    state.checkedAt = new Date().toISOString();

    if (r.kind === 'newer' || r.kind === 'rebuilt') {
      state.phase = 'idle';
      state.remote = r;
      state.message = r.kind === 'rebuilt'
        ? `同版本修复包 build ${r.build}`
        : `新版本 ${r.version} build ${r.build}`;
    } else if (r.kind === 'latest') {
      state.phase = 'idle';
      state.remote = null;
      state.file = '';
      state.percent = 0;
      state.message = '已经是最新';
    } else if (r.kind === 'disabled') {
      state.phase = 'disabled';
      state.message = '更新源不可用';
    } else {
      state.phase = 'error';
      state.message = r.message || '检查失败';
    }
    return snapshot();
  }

  async function download() {
    if (isPortable) throw new Error('便携版不能自动替换，请下载新包手动换掉');
    if (state.phase === 'downloading') throw new Error('已经在下载了');

    // 绿色版要整个目录包，安装版要安装程序
    const url = isGreen ? state.remote?.zipUrl : state.remote?.downloadUrl;
    if (!url) {
      throw new Error(isGreen ? '清单里没有绿色版目录包（downloads.windowsZip）' : '清单里没有可信的下载地址');
    }

    state.phase = 'downloading';
    state.percent = 0;
    state.message = '';
    const ext = isGreen ? 'zip' : 'exe';
    // 放程序目录下的 cache/updates，不放系统临时目录
    const dest = path.join(
      updateCacheDir,
      `AgentChat-${state.remote.version}-build${state.remote.build}.${ext}`,
    );
    try {
      const r = await downloadUpdate({
        url,
        dest,
        // 绿色版下的是目录包，哈希跟安装包不是同一个，要分开取
        expectedSha256: isGreen ? state.remote.sha256Zip : state.remote.sha256,
        expectMagic: isGreen ? 'PK' : 'MZ',
        onProgress: (p) => { state.percent = p; },
      });
      state.file = r.file;
      state.percent = 100;
      state.phase = 'ready';
      state.message = '下载完成，可以安装了';
    } catch (e) {
      state.phase = 'error';
      state.message = e.message;
      throw e;
    }
    return snapshot();
  }

  function install() {
    if (!state.file || !fs.existsSync(state.file)) throw new Error('安装包不在，先下载');

    // 先落一个标记，确认这一步真的执行到了。之前排查过「点了没反应」，
    // 没有这个文件就说明根本没走到这里。
    try {
      fs.mkdirSync(updateCacheDir, { recursive: true });
      fs.writeFileSync(
        path.join(updateCacheDir, 'install-called.txt'),
        `${new Date().toISOString()} file=${state.file} green=${isGreen} dest=${exeDir}\n`,
        'utf8',
      );
    } catch (e) {
      throw new Error(`写标记失败，缓存目录可能不可写：${e.message}`);
    }

    // 不能直接动手：自己还占着安装目录里的文件。所以起一个独立进程，
    // 先睡两秒等我们退干净，再干活，干完把新版拉起来。
    //
    // 用 cmd 的 start 而不是 detached + unref：后者起的进程会跟着本进程一起被收走
    // （实测父进程 exit 后子进程直接没了）。start 起的是独立控制台，活得住。
    const exePath = app.getPath('exe');
    const file = state.file;
    const q = (s) => s.replace(/'/g, "''");
    const logFile = path.join(updateCacheDir, 'install.log');

    const work = isGreen
      // 绿色版：解压覆盖当前目录，不碰注册表也不装到别处
      ? `Expand-Archive -LiteralPath '${q(file)}' -DestinationPath '${q(exeDir)}' -Force; Start-Process -FilePath '${q(exePath)}'`
      // 安装版：静默装，装完再拉起来
      : `Start-Process -FilePath '${q(file)}' -ArgumentList '/S' -Wait; Start-Process -FilePath '${q(exePath)}'`;

    // 整个过程写一份日志到缓存目录，出问题能查，不静默失败
    const ps = [
      `$ErrorActionPreference='Stop'`,
      `'start ' + (Get-Date -Format o) | Out-File -FilePath '${q(logFile)}' -Encoding utf8`,
      'Start-Sleep -Seconds 2',
      `try { ${work}; 'ok' | Out-File -FilePath '${q(logFile)}' -Encoding utf8 -Append }` +
        ` catch { ('fail: ' + $_.Exception.Message) | Out-File -FilePath '${q(logFile)}' -Encoding utf8 -Append }`,
    ].join('; ');

    spawn(
      'cmd.exe',
      ['/c', 'start', '', 'powershell', '-NoProfile', '-NonInteractive', '-Command', ps],
      { detached: true, stdio: 'ignore', windowsHide: true },
    ).unref();

    // 走正常退出流程，让 before-quit 里的 server.close 把锁和运行时文件清掉。
    // 等三秒再退：短了这次 HTTP 响应发不出去，界面那边会显示成失败，实际却已经在装了。
    setTimeout(() => quit(), 3000);
    return { ok: true };
  }

  return { snapshot, check, download, install };
}

const gotLock = app.requestSingleInstanceLock();

if (!gotLock) {
  app.quit();
} else {
  let win = null;
  let server = null;
  let url = null;
  let updater = null;
  let appSettings = null;
  let tray = null;
  let quitRequested = false;
  let closePromptOpen = false;

  // Windows 任务栏靠这个把窗口和 exe 认成同一个程序，否则图标会变成默认的
  app.setAppUserModelId('cn.codex.agentchat');

  const log = (m) => console.log(`[agent-chat] ${m}`);

  function showWindow() {
    if (!win && url) createWindow();
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  }

  function requestQuit() {
    if (quitRequested) return;
    quitRequested = true;
    app.quit();
  }

  app.on('second-instance', () => {
    showWindow();
  });

  async function boot() {
    // 数据目录优先用总库里的固定位置（E 盘），没有才落到程序目录下的 data/chat
    const dir = resolveDataDir(path.join(appRoot, 'data', 'chat'));
    const port = Number(process.env.AGENT_CHAT_PORT || 7788);
    log(`程序目录 ${appRoot}`);
    log(`数据目录 ${dir}`);
    log(`缓存目录 ${updateCacheDir}${userDataDir === DEFAULT_USER_DATA ? '（程序目录不可写，退回了系统默认位置）' : ''}`);

    // 先看一眼端口上是不是蹲着源码态服务。是的话收掉，免得桌面版贴过去之后
    // 既没有更新能力，跑的还是那份旧代码。
    await takeOverFromSourceServer({ dir, port, log });

    // 更新器交给服务，界面上点「更新」走的是 HTTP 接口，跟其它能力一个路子，
    // 不用为了这一个功能加 preload 和 IPC 通道。
    appSettings = createAppSettings({ dir: userDataDir, onLog: log });
    updater = createUpdater({ quit: requestQuit });

    server = await startServer({
      dir,
      port,
      host: '127.0.0.1',
      onLog: log,
      reuse: true,
      updater,
      appSettings,
      // 设置一改就把新的外观推给标题栏，不用重启窗口
      onAppSettings: (next) => applyTitleBarTheme(next?.appearance),
    });
    url = `http://127.0.0.1:${server.port}/`;
    log(`界面地址 ${url}`);
    return url;
  }

  // 标题栏跟着外观设置走。浅色模式下留一条黑边太跳，所以这里要能换。
  // 界面那边改完外观会 POST /api/app-settings，服务把新值回传到这里。
  function applyTitleBarTheme(appearance) {
    if (!win || win.isDestroyed()) return;
    const mode = appearance?.mode || 'system';
    let dark = true;
    if (mode === 'light') dark = false;
    else if (mode === 'dark') dark = true;
    else if (mode === 'custom') dark = hexLuminance(appearance?.background) < 0.5;
    else dark = nativeTheme.shouldUseDarkColors;
    try {
      win.setTitleBarOverlay({
        color: dark ? TITLEBAR_DARK : TITLEBAR_LIGHT,
        symbolColor: dark ? '#e6e8eb' : '#1c1f24',
        height: TITLEBAR_HEIGHT,
      });
    } catch (e) {
      log(`标题栏配色没跟上：${e.message}`);
    }
  }

  function createWindow() {
    win = new BrowserWindow({
      width: 1120,
      height: 780,
      minWidth: 820,
      minHeight: 560,
      title: 'AgentChat',
      icon: path.join(HERE, 'icon.ico'),
      backgroundColor: '#0d0f13',
      autoHideMenuBar: true,
      // 系统标题栏会被 Windows 的强调色染色，粉的紫的都有，跟应用配色完全不合。
      // 改成隐藏标题栏，窗口按钮交给 titleBarOverlay 画，左边留一条自己画的深色条。
      // 这样按钮的悬停和贴边行为还是系统的，只是颜色归我们管。
      titleBarStyle: 'hidden',
      titleBarOverlay: {
        color: TITLEBAR_DARK,
        symbolColor: '#e6e8eb',
        height: TITLEBAR_HEIGHT,
      },
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        spellcheck: false,
      },
    });

    win.loadURL(url);
    applyTitleBarTheme(appSettings?.snapshot().appearance);

    win.on('close', async (event) => {
      const action = resolveCloseAction({
        preference: appSettings?.snapshot().closeAction,
        explicitQuit: quitRequested,
        trayAvailable: !!tray,
      });
      if (action === 'quit') {
        if (!quitRequested) {
          event.preventDefault();
          requestQuit();
        }
        return;
      }

      event.preventDefault();
      if (action === 'tray') {
        win.hide();
        return;
      }
      if (closePromptOpen) return;

      closePromptOpen = true;
      try {
        const canHide = !!tray;
        const buttons = canHide ? ['最小化到托盘', '退出应用', '取消'] : ['退出应用', '取消'];
        const result = await dialog.showMessageBox(win, {
          type: 'question',
          title: '关闭 AgentChat',
          message: '关闭窗口时要怎么做？',
          detail: canHide ? '最小化到托盘后，本地服务和 agent 通知会继续运行。' : '托盘当前不可用，只能退出或取消。',
          buttons,
          defaultId: 0,
          cancelId: buttons.length - 1,
          noLink: true,
        });
        if (canHide && result.response === 0) win?.hide();
        else if ((canHide && result.response === 1) || (!canHide && result.response === 0)) requestQuit();
      } finally {
        closePromptOpen = false;
      }
    });

    // 站内链接走窗口，站外链接交给系统浏览器
    //
    // file: 单独处理：界面上引用的文件路径点一下要能打开，但只放行能看的东西。
    // 直接 shell.openExternal(file://) 等于「谁在消息里写个 exe 路径，点一下就运行」，
    // 所以按扩展名白名单来，白名单外的只复制路径不打开。
    const OPENABLE_EXT = new Set([
      '.txt', '.md', '.log', '.json', '.jsonl', '.csv', '.tsv', '.yml', '.yaml', '.toml', '.ini', '.conf',
      '.mjs', '.cjs', '.js', '.jsx', '.ts', '.tsx', '.vue', '.svelte', '.html', '.htm', '.css', '.scss', '.less',
      '.py', '.ps1', '.sh', '.bat', '.cmd', '.rs', '.go', '.java', '.c', '.h', '.cpp', '.sql',
      '.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.svg', '.avif',
      '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.rtf',
      '.mp4', '.webm', '.mp3', '.wav',
    ]);

    win.webContents.setWindowOpenHandler(({ url: target }) => {
      if (target.startsWith('http://127.0.0.1')) return { action: 'allow' };

      if (target.startsWith('file:')) {
        try {
          let p = decodeURIComponent(new URL(target).pathname);
          // file:///E:/a.txt 解析出来是 /E:/a.txt，去掉前导斜杠
          if (/^\/[A-Za-z]:/.test(p)) p = p.slice(1);
          const ext = path.extname(p).toLowerCase();
          if (OPENABLE_EXT.has(ext) && fs.existsSync(p)) {
            shell.openPath(p).catch(() => {});
          } else {
            log(`不打开这个文件（扩展名不在白名单或文件不存在）：${p}`);
          }
        } catch (e) {
          log(`file: 链接解析失败 ${e.message}`);
        }
        return { action: 'deny' };
      }

      shell.openExternal(target);
      return { action: 'deny' };
    });

    win.on('closed', () => { win = null; });

    // 自检用：设 AGENT_CHAT_SHOT=<png 路径> 就截一张图然后退出，不干别的
    if (process.env.AGENT_CHAT_SHOT) {
      win.webContents.once('did-finish-load', () => {
        setTimeout(async () => {
          try {
            const img = await win.webContents.capturePage();
            const fs = await import('node:fs');
            fs.writeFileSync(process.env.AGENT_CHAT_SHOT, img.toPNG());
            log(`截图已存 ${process.env.AGENT_CHAT_SHOT}`);
          } catch (e) {
            log(`截图失败 ${e.message}`);
          }
          try { if (server) await server.close(); } catch {}
          app.exit(0);
        }, 1500);
      });
    }

    const menu = Menu.buildFromTemplate([
      {
        label: '文件',
        submenu: [
          { label: '在浏览器打开', click: () => shell.openExternal(url) },
          { label: '复制接口地址', click: () => clipboard.writeText(url) },
          { type: 'separator' },
          { label: '退出', click: requestQuit },
        ],
      },
      {
        label: '查看',
        submenu: [
          { role: 'reload', label: '重新载入' },
          { role: 'toggleDevTools', label: '开发者工具' },
          { type: 'separator' },
          { role: 'resetZoom', label: '实际大小' },
          { role: 'zoomIn', label: '放大' },
          { role: 'zoomOut', label: '缩小' },
        ],
      },
    ]);
    Menu.setApplicationMenu(menu);
  }

  function createTray() {
    try {
      tray = new Tray(path.join(HERE, 'icon.ico'));
      tray.setToolTip('AgentChat');
      tray.setContextMenu(Menu.buildFromTemplate([
        { label: '打开 AgentChat', click: showWindow },
        { type: 'separator' },
        { label: '退出应用', click: requestQuit },
      ]));
      tray.on('double-click', showWindow);
    } catch (e) {
      tray = null;
      log(`托盘创建失败，关闭时改为询问：${e.message}`);
    }
  }

  app.whenReady().then(async () => {
    try {
      await boot();
      createWindow();
      createTray();
    } catch (e) {
      const dir = resolveDataDir(path.join(app.getPath('userData'), 'data'));
      dialog.showErrorBox('群聊服务起不来', `${e.message}\n\n数据目录：${dir}\n\n常见原因：7788 到 7799 都被别的程序占了，或者数据目录没有写权限。`);
      requestQuit();
    }

    app.on('activate', () => {
      showWindow();
    });

    // 启动十秒后安静查一次。没配更新源、网络不通都不打扰用户，状态里记一笔就行。
    // 想立刻看结果就点界面上的「更新」，那条路是强制的。
    setTimeout(() => { updater?.check().catch(() => {}); }, 10000);
  });

  app.on('window-all-closed', () => {});

  let closing = false;
  app.on('before-quit', async (e) => {
    quitRequested = true;
    if (closing) return;
    closing = true;
    e.preventDefault();
    try { tray?.destroy(); } catch {}
    tray = null;
    try { if (server) await server.close(); } catch {}
    app.exit(0);
  });
}
