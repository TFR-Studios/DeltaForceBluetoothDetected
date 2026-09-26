'use strict';
/**
 * bt-anim 主进程：
 *  - 每个显示器一个「透明 + 置顶 + 点击穿透」的悬浮窗（平时隐藏）
 *  - 蓝牙事件 -> 触发引擎 -> 播放动画
 *  - 本地控制接口 + 托盘
 */
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');
const {
  app, BrowserWindow, ipcMain, protocol, net, screen, nativeImage,
} = require('electron');

const { loadConfig, FLAGS } = require('./shared/config');
const { createLogger } = require('./shared/logger');
const { createSensor } = require('./sensors');
const { createTriggerEngine } = require('./trigger-engine');
const { createControlServer } = require('./control-server');
const {
  loadAnimation, prepareAnimation, resolveSegment, estimateDurationMs, resolveAnimationDir,
} = require('./shared/animation');
const { appRoot, ensureDir, runFile, writeJson, stateDir } = require('./shared/paths');
const { createAppTray } = require('./tray');

const pkg = require('../package.json');

// Windows 上 Chromium 会做「窗口遮挡检测」，被判断为遮挡后就不再重绘窗口表面，
// 透明置顶悬浮层会因此变成看不见（页面内部其实还在播放）。这里关掉相关优化。
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('disable-renderer-backgrounding');

protocol.registerSchemesAsPrivileged([{
  scheme: 'btanim',
  privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true },
}]);

// ---------------------------------------------------------------- 配置
function cliFlagsOnly(argv) {
  const out = [];
  (argv || []).forEach(function (arg) {
    if (typeof arg !== 'string' || arg.charAt(0) !== '-') return;
    const name = arg.split('=')[0];
    if (FLAGS[name]) out.push(arg);
  });
  return out;
}

const loaded = loadConfig({ argv: cliFlagsOnly(process.argv.slice(1)), env: process.env });
const cfg = loaded.config;
const logger = createLogger({
  level: cfg.logLevel,
  file: cfg.logFile !== false,
});
const log = logger;

log.debug('配置: ' + JSON.stringify({
  triggers: cfg.triggers,
  scan: cfg.scan,
  playback: cfg.animation,
  window: cfg.window,
  configPath: loaded.configPath,
}));
if (loaded.warnings.length) loaded.warnings.forEach(function (w) { log.warn(w); });

// ---------------------------------------------------------------- 资源协议
let animation = null;
try {
  animation = loadAnimation(cfg);
  log.info('已加载动画: ' + animation.file + '（' + animation.width + 'x' + animation.height +
    '，' + Math.round(animation.durationMs / 1000) + ' 秒）');
} catch (err) {
  log.error('无法读取动画文件: ' + err.message);
  animation = null;
}

const ANIMATION_DIR = resolveAnimationDir(cfg);

function sectionRoot(section) {
  switch (section) {
    case 'renderer': return path.join(appRoot(), 'renderer');
    case 'vendor': return path.join(appRoot(), 'vendor');
    case 'assets': return path.join(appRoot(), 'assets');
    case 'anim': return ANIMATION_DIR;
    default: return null;
  }
}

function registerProtocol() {
  protocol.handle('btanim', function (request) {
    try {
      const url = new URL(request.url);
      const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '');
      const parts = rel.split('/').filter(Boolean);
      const base = sectionRoot(parts.shift());
      if (!base) return new Response('not found', { status: 404 });
      const target = path.resolve(base, parts.join('/'));
      if (target !== path.resolve(base) && !target.startsWith(path.resolve(base) + path.sep)) {
        return new Response('forbidden', { status: 403 });
      }
      if (!fs.existsSync(target)) {
        log.debug('资源不存在: ' + rel);
        return new Response('not found', { status: 404 });
      }
      log.debug('资源请求: ' + rel);
      return net.fetch(pathToFileURL(target).toString(), { bypassCustomProtocolHandlers: true });
    } catch (err) {
      log.debug('资源请求失败: ' + err.message);
      return new Response('error', { status: 500 });
    }
  });
}

// ---------------------------------------------------------------- 悬浮窗
const overlays = [];
let prepared = null;
let session = null;
let sessionSeq = 0;
const pendingPlay = [];
let paused = false;
let quitting = false;
let firstPlayDone = false;
let tray = null;
let control = null;
let sensor = null;
let engine = null;

function selectDisplays() {
  const all = screen.getAllDisplays();
  const mode = cfg.window.display;
  if (mode === 'all' || mode === '*') return all;
  if (mode === undefined || mode === null || mode === 'primary') return [screen.getPrimaryDisplay()];
  const num = parseInt(mode, 10);
  if (!isNaN(num)) {
    const byIndex = all[num - 1];
    if (byIndex) return [byIndex];
    const byId = all.filter(function (d) { return String(d.id) === String(mode); });
    if (byId.length) return byId;
  }
  return [screen.getPrimaryDisplay()];
}

function createOverlays() {
  selectDisplays().forEach(function (display) {
    const bounds = display.bounds;
    const win = new BrowserWindow({
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
      transparent: true,
      frame: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      focusable: false,
      hasShadow: false,
      show: false,
      backgroundColor: '#00000000',
      enableLargerThanScreen: true,
      title: 'bt-anim overlay',
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        backgroundThrottling: false,
        devTools: false,
      },
    });

    try {
      win.setAlwaysOnTop(true, 'screen-saver');
      win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
      if (cfg.window.clickThrough !== false) win.setIgnoreMouseEvents(true, { forward: true });
      win.setOpacity(Math.min(1, Math.max(0.05, Number(cfg.window.opacity) || 1)));
    } catch (err) {
      log.warn('设置窗口属性失败: ' + err.message);
    }

    win.on('closed', function () {
      const index = overlays.findIndex(function (o) { return o.win === win; });
      if (index >= 0) overlays.splice(index, 1);
    });

    win.webContents.on('render-process-gone', function (_e, details) {
      log.warn('渲染进程异常: ' + (details && details.reason));
      hideAll();
    });

    win.loadURL('btanim://app/renderer/index.html' + (process.env.BT_ANIM_PAINT_TEST ? '?paint-test=1' : '')).catch(function (err) {
      log.error('加载悬浮窗页面失败: ' + err.message);
    });

    overlays.push({ win: win, display: display, ready: false });
  });
  log.info('已创建 ' + overlays.length + ' 个悬浮窗（显示器: ' + selectDisplays().map(function (d) { return d.size.width + 'x' + d.size.height; }).join(', ') + '）');
}

function buildInitPayload(overlay) {
  const bounds = overlay.display.bounds;
  return {
    animation: prepared ? prepared.data : null,
    meta: prepared ? {
      counterLayers: prepared.counterLayers,
      durationMs: prepared.durationMs,
      width: prepared.width,
      height: prepared.height,
      fps: prepared.fps,
    } : null,
    playback: {
      from: prepared ? prepared.segment.from : 0,
      to: prepared ? prepared.segment.to : 0,
      speed: Number(cfg.animation.speed) || 1,
      counter: !!cfg.animation.counter,
      caption: !!cfg.animation.caption,
      fit: cfg.window.fit || 'cover',
      extraMs: cfg.window.extraMs || 700,
      backdrop: Math.min(0.9, Math.max(0, Number(cfg.window.backdrop) || 0)),
      boost: Math.min(5, Math.max(0.2, Number(cfg.window.boost) || 1)),
    },
    window: {
      width: bounds.width,
      height: bounds.height,
      scaleFactor: overlay.display.scaleFactor,
    },
  };
}

function showOverlays() {
  overlays.forEach(function (overlay) {
    if (overlay.win.isDestroyed()) return;
    if (!overlay.win.isVisible()) overlay.win.showInactive();
    // 重新确认置顶层级：即使其它程序（全屏游戏 / 播放器）也设了置顶，也要压在最上面
    try {
      overlay.win.setAlwaysOnTop(true, 'screen-saver');
      if (typeof overlay.win.moveTop === 'function') overlay.win.moveTop();
      if (overlay.win.webContents && typeof overlay.win.webContents.invalidate === 'function') {
        overlay.win.webContents.invalidate();
      }
    } catch (err) {
      log.debug('置顶失败: ' + err.message);
    }
  });
}

function hideAll() {
  overlays.forEach(function (overlay) {
    if (overlay.win.isDestroyed()) return;
    if (cfg.window.keepMounted === false) {
      if (overlay.win.isVisible()) overlay.win.hide();
    } else {
      // 常驻挂载模式：窗口一直存在，只让渲染层清空画面。
      // 这样可以避开 Windows 上「透明窗口 hide/show 之后不再重绘」的问题。
      try { overlay.win.webContents.send('overlay:stop', {}); } catch (err) { /* 忽略 */ }
    }
  });
  session = null;
  if (engine) engine.onPlaybackEnd();
}

function playOverlay(payload) {
  if (!overlays.length || !prepared) return;
  if (paused && !payload.forced) {
    log.debug('已暂停，忽略本次播放');
    return;
  }
  sessionSeq++;
  const current = {
    id: sessionSeq,
    waiting: new Set(overlays.map(function (o) { return o.win.id; })),
    startedAt: Date.now(),
  };
  session = current;

  const durationMs = (payload.forced && payload.durationMs)
    ? payload.durationMs
    : estimateDurationMs(animation, cfg);
  const totalMs = durationMs + (cfg.window.extraMs || 700);

  showOverlays();
  overlays.forEach(function (overlay) {
    const send = function () {
      overlay.ready = true;
      log.debug('发送播放指令 -> 窗口可见=' + overlay.win.isVisible() + ' 置顶=' + overlay.win.isAlwaysOnTop() +
        ' 尺寸=' + overlay.win.getBounds().width + 'x' + overlay.win.getBounds().height);
      overlay.win.webContents.send('overlay:play', {
        sessionId: current.id,
        payload: payload,
        waitMs: totalMs + 2000,
      });
    };
    if (overlay.ready) send();
    else pendingPlay.push({ overlay: overlay, sessionId: current.id, payload: payload });
  });

  if (engine) engine.onPlaybackStart(payload);

  current.timer = setTimeout(function () {
    if (session && session.id === current.id) {
      log.debug('播放超时，自动隐藏悬浮窗');
      endSession(current.id, true);
    }
  }, totalMs + 2500);
  if (current.timer.unref) current.timer.unref();
}

function endSession(sessionId, force) {
  if (!session || session.id !== sessionId) return;
  if (!force && session.waiting.size > 0) return;
  if (session.timer) clearTimeout(session.timer);
  session = null;
  hideAll();
  if (cfg.exitAfterPlay && !firstPlayDone) {
    firstPlayDone = true;
    log.info('播放完成，按 --once 设定退出');
    setTimeout(function () { quitApp(); }, 250);
  } else {
    firstPlayDone = true;
  }
}

// ---------------------------------------------------------------- 控制接口 / 状态
function currentStatus() {
  const status = {
    app: { name: pkg.name, version: pkg.version, pid: process.pid, startedAt: startedAt },
    paused: paused,
    platform: process.platform,
    stateDir: stateDir(),
    animation: animation ? {
      file: animation.file,
      width: animation.width,
      height: animation.height,
      fps: animation.fps,
      durationMs: animation.durationMs,
      segment: prepared ? prepared.segment : null,
      speed: cfg.animation.speed,
      counter: cfg.animation.counter,
      textMode: cfg.animation.textMode,
    } : null,
    window: {
      displays: overlays.map(function (o) { return { id: o.display.id, width: o.display.bounds.width, height: o.display.bounds.height }; }),
      fit: cfg.window.fit,
      clickThrough: cfg.window.clickThrough,
      visible: overlays.some(function (o) { return !o.win.isDestroyed() && o.win.isVisible(); }),
    },
    engine: engine ? engine.status() : null,
    sensor: sensor ? sensor.status() : null,
    triggers: cfg.triggers,
    cooldownMs: cfg.cooldownMs,
    control: control ? { port: control.port() } : null,
  };
  return status;
}

function refreshTray() {
  if (!tray) return;
  const sensorStatus = sensor && sensor.status ? sensor.status() : null;
  const connected = sensorStatus && sensorStatus.connected ? sensorStatus.connected.length : 0;
  tray.update({
    title: 'bt-anim 蓝牙动画悬浮层',
    detail: (paused ? '已暂停监听' : '监听中') + ' · 已连接 ' + connected + ' 个设备',
    paused: paused,
  });
}

function registerRunFile(port, token) {
  const file = runFile();
  try {
    writeJson(file, {
      pid: process.pid,
      port: port,
      token: token,
      url: 'http://127.0.0.1:' + port,
      startedAt: new Date().toISOString(),
      version: pkg.version,
      stateDir: stateDir(),
      electron: process.versions.electron,
      node: process.versions.node,
    });
  } catch (err) {
    log.warn('写入运行信息失败: ' + err.message);
  }
  return file;
}

function removeRunFile() {
  try {
    const file = runFile();
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (data && data.pid === process.pid) fs.unlinkSync(file);
  } catch (err) { /* 忽略 */ }
}

function quitApp() {
  if (quitting) return;
  quitting = true;
  log.info('正在退出…');
  try { if (sensor) sensor.stop(); } catch (err) { /* 忽略 */ }
  try { if (engine) engine.dispose(); } catch (err) { /* 忽略 */ }
  try { if (control) control.stop(); } catch (err) { /* 忽略 */ }
  try { if (tray) tray.destroy(); } catch (err) { /* 忽略 */ }
  removeRunFile();
  setTimeout(function () { app.exit(0); }, 60);
}

// ---------------------------------------------------------------- 启动
const startedAt = new Date().toISOString();
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.exit(0);
} else {
  app.on('second-instance', function () {
    log.info('检测到第二个实例，已忽略');
  });

  app.whenReady().then(function () {
    app.setAppUserModelId('bt-anim-overlay');
    registerProtocol();

    try {
      prepared = animation ? prepareAnimation(animation, cfg, { assetBase: 'btanim://app/anim/' }) : null;
      if (prepared) prepared.segment = resolveSegment(animation, cfg);
    } catch (err) {
      log.error('准备动画数据失败: ' + err.message);
      prepared = null;
    }

    createOverlays();

    engine = createTriggerEngine(cfg, log);
    engine.on('play', playOverlay);

    if (cfg.sensor.enabled) {
      sensor = createSensor(cfg, log);
      sensor.on('change', function (event) { engine.push(event); });
      sensor.on('discovered', function (event) { engine.push(event); });
      sensor.on('error', function (err) { log.error('传感器: ' + err.message); });
      sensor.on('ready', function () { refreshTray(); });
      sensor.on('status', function () { refreshTray(); });
      sensor.start();
    } else {
      log.warn('蓝牙监听已被关闭（--no-sensor）');
    }

    if (cfg.window.tray !== false) {
      try {
        tray = createAppTray({
          iconPath: path.join(appRoot(), 'assets', 'tray.png'),
          title: 'bt-anim 蓝牙动画悬浮层',
          stateDir: stateDir(),
          getState: function () {
            const sensorStatus = sensor && sensor.status ? sensor.status() : null;
            const connected = sensorStatus && sensorStatus.connected ? sensorStatus.connected.length : 0;
            return {
              title: 'bt-anim v' + pkg.version,
              detail: (paused ? '已暂停监听' : '监听中') + ' · 已连接 ' + connected + ' 个设备',
              paused: paused,
            };
          },
          onTest: function () { engine.triggerNow({ name: '演示设备', kind: 'connected' }); },
          onScan: function () { if (sensor && sensor.scanNow) sensor.scanNow('托盘手动扫描'); },
          onTogglePause: function () { paused = !paused; refreshTray(); log.info(paused ? '已暂停监听' : '已恢复监听'); },
          onQuit: quitApp,
        });
      } catch (err) {
        log.warn('创建托盘失败: ' + err.message);
      }
    }

    if (cfg.control.enabled !== false) {
      control = createControlServer({
        port: cfg.control.port,
        log: log,
        handlers: {
          status: function () { return currentStatus(); },
          trigger: function (body) {
            engine.triggerNow({
              name: (body && body.name) || '演示设备',
              kind: (body && body.kind) || 'connected',
            });
          },
          scan: function () {
            if (!sensor || !sensor.scanNow) return { supported: false };
            return sensor.scanNow('手动扫描').then(function (devices) {
              return { found: devices.length, devices: devices };
            });
          },
          capture: async function () {
            const overlay = overlays[0];
            if (!overlay || overlay.win.isDestroyed()) return { ok: false, error: '没有可用的悬浮窗' };
            const image = await overlay.win.webContents.capturePage();
            const file = path.join(stateDir(), 'capture.png');
            fs.writeFileSync(file, image.toPNG());
            return { file: file, size: image.getSize() };
          },
          pause: function () { paused = true; refreshTray(); },
          resume: function () { paused = false; refreshTray(); },
          quit: quitApp,
        },
      });
      control.start().then(function (port) {
        registerRunFile(port, control.token);
        log.info('控制接口: http://127.0.0.1:' + port + '（令牌见 ' + runFile() + '）');
      }).catch(function (err) {
        log.warn('控制接口启动失败: ' + err.message);
      });
    }

    log.info('bt-anim 已就绪，等待蓝牙事件…（托盘菜单可测试播放，Ctrl+C 退出）');

    if (cfg.playOnStart && engine) {
      setTimeout(function () { engine.triggerNow({ name: '测试设备', kind: 'connected' }); }, 1200);
    }
  });

  app.on('window-all-closed', function () { /* 托盘常驻，不退出 */ });
  app.on('before-quit', function () { quitting = true; });
  app.on('will-quit', function () {
    try { if (sensor) sensor.stop(); } catch (err) { /* 忽略 */ }
    try { if (control) control.stop(); } catch (err) { /* 忽略 */ }
    removeRunFile();
    logger.close();
  });
}

process.on('SIGINT', function () { quitApp(); });
process.on('SIGTERM', function () { quitApp(); });
process.on('uncaughtException', function (err) {
  log.error('未捕获异常: ' + (err && err.stack ? err.stack : err));
});

// ---------------------------------------------------------------- IPC
ipcMain.on('overlay:ready', function (event) {
  const overlay = overlays.find(function (o) { return o.win.webContents.id === event.sender.id; });
  if (!overlay) return;
  overlay.ready = true;
  if (prepared) event.sender.send('overlay:init', buildInitPayload(overlay));
  if (cfg.window.keepMounted !== false && !overlay.win.isVisible()) overlay.win.showInactive();
  const queued = pendingPlay.filter(function (item) { return item.overlay === overlay; });
  queued.forEach(function (item) {
    event.sender.send('overlay:play', { sessionId: item.sessionId, payload: item.payload, waitMs: 30000 });
    const index = pendingPlay.indexOf(item);
    if (index >= 0) pendingPlay.splice(index, 1);
  });
});

ipcMain.on('overlay:done', function (event, payload) {
  const overlay = overlays.find(function (o) { return o.win.webContents.id === event.sender.id; });
  if (!overlay || !session) return;
  if (payload && payload.sessionId && payload.sessionId !== session.id) return;
  session.waiting.delete(overlay.win.id);
  log.debug('悬浮窗 ' + overlay.win.id + ' 播放完成（剩余 ' + session.waiting.size + '）');
  if (session.waiting.size === 0) endSession(session.id, false);
});

ipcMain.on('overlay:log', function (_event, payload) {
  if (!payload) return;
  if (payload.extra !== undefined) log.debug('[renderer] ' + payload.message + ' ' + JSON.stringify(payload.extra));
  else log.debug('[renderer] ' + payload.message);
});
