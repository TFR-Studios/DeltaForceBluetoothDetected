'use strict';
/**
 * 离线预览：把 Lottie 动画的指定帧渲染成 PNG，便于检查渲染是否正确。
 * 用法: electron tools/preview.js --out <目录> --frames 0,200,400 [--bg 000000] [--visible] [--hold 20000]
 */
const path = require('path');
const fs = require('fs');
const { app, BrowserWindow, protocol, net } = require('electron');
const { pathToFileURL } = require('url');

const argv = process.argv.slice(2);
function argOf(name, fallback) {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
}
const ROOT = path.resolve(__dirname, '..');
const OUT = path.resolve(argOf('--out', path.join(ROOT, '.probe', 'frames')));
const FRAMES = argOf('--frames', '0,200,600,1000,1400').split(',').map(function (s) { return parseInt(s, 10); });
const BG = argOf('--bg', '000000');
const VISIBLE = argv.indexOf('--visible') >= 0;
const HOLD = parseInt(argOf('--hold', '0'), 10);

const { loadAnimation, prepareAnimation } = require('../src/shared/animation');

protocol.registerSchemesAsPrivileged([{ scheme: 'btanim', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }]);

app.whenReady().then(async function () {
  protocol.handle('btanim', function (request) {
    const url = new URL(request.url);
    const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '');
    const target = path.join(ROOT, rel);
    if (!fs.existsSync(target)) return new Response('nf', { status: 404 });
    return net.fetch(pathToFileURL(target).toString(), { bypassCustomProtocolHandlers: true });
  });

  const config = { animation: { dir: path.join(ROOT, 'animation'), file: 'data.json', fromFrame: null, toFrame: null, speed: 1, counter: false, textMode: 'original', caption: false, font: null } };
  const loaded = loadAnimation(config);
  const prepared = prepareAnimation(loaded, config, {
    assetBase: 'btanim://app/animation/',
    inlineAssets: process.env.BT_ANIM_INLINE === '1',
  });

  const win = new BrowserWindow({
    width: 1920, height: 1080, frame: false,
    show: VISIBLE, alwaysOnTop: VISIBLE, skipTaskbar: VISIBLE,
    backgroundColor: '#' + BG,
    webPreferences: {
      preload: path.join(ROOT, 'src', 'preview-preload.js'),
      contextIsolation: true, nodeIntegration: false, backgroundThrottling: false,
    },
  });

  win.webContents.on('console-message', function (event) {
    const message = event && event.message !== undefined ? event.message : arguments[2];
    console.log('[console] ' + message);
  });

  await win.loadURL('btanim://app/renderer/preview.html');
  win.webContents.send('preview:init', {
    animation: prepared.data,
    bg: BG,
    renderer: argOf('--renderer', 'svg'),
    preserveAspectRatio: argOf('--par', 'xMidYMid meet'),
  });
  await new Promise(function (r) { setTimeout(r, 2500); });

  fs.mkdirSync(OUT, { recursive: true });
  for (const frame of FRAMES) {
    win.webContents.send('preview:frame', { frame: frame });
    await new Promise(function (r) { setTimeout(r, 800); });
    const image = await win.webContents.capturePage();
    const file = path.join(OUT, 'frame-' + String(frame).padStart(4, '0') + '.png');
    fs.writeFileSync(file, image.toPNG());
    console.log('frame ' + frame + ' saved: ' + file);
    if (process.env.BT_ANIM_DIAG3 === '1') {
      const d3 = await win.webContents.executeJavaScript('window.diag3()').catch(function (err) { return 'diag3 error: ' + err.message; });
      console.log('DIAG3 ' + d3);
    }
    if (process.env.BT_ANIM_DIAG2 === '1') {
      const d2 = await win.webContents.executeJavaScript('window.diag2()').catch(function (err) { return 'diag2 error: ' + err.message; });
      console.log('DIAG2 ' + d2);
      await new Promise(function (r) { setTimeout(r, 900); });
      const img2 = await win.webContents.capturePage();
      fs.writeFileSync(path.join(OUT, 'probe-image.png'), img2.toPNG());
      console.log('probe saved');
    }
  }
  if (HOLD > 0) await new Promise(function (r) { setTimeout(r, HOLD); });
  app.exit(0);
}).catch(function (err) {
  console.log('PREVIEW ERROR: ' + (err && err.stack ? err.stack : err));
  app.exit(1);
});
