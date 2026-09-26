'use strict';
/**
 * 定位 / 自动安装 Electron 运行时。
 * npx 或 npm 的 postinstall 常常因为网络（GitHub）或 ignore-scripts 而没有下载到 Electron 二进制，
 * 这里做了多镜像重试与缓存，保证 npx 方式一定能跑起来。
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { ensureDir, stateDir, readJson, writeJson } = require('./paths');

const CN_MIRRORS = [
  'https://npmmirror.com/mirrors/electron/',
  'https://cdn.npmmirror.com/binaries/electron/',
  'https://mirrors.huaweicloud.com/electron/',
];
const MIRRORS = [null].concat(CN_MIRRORS);

/** 如果 npm 源是国内镜像，优先使用国内 Electron 镜像，避免 GitHub 长时间卡住。 */
function preferredMirrors() {
  const explicit = process.env.ELECTRON_MIRROR;
  if (explicit) return [explicit].concat(MIRRORS);
  let registry = '';
  try {
    const result = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['config', 'get', 'registry'], {
      encoding: 'utf8', timeout: 8000, shell: process.platform === 'win32', windowsHide: true,
    });
    registry = String(result.stdout || '').trim();
  } catch (err) { registry = ''; }
  if (/npmmirror|taobao|cnpm|huawei/i.test(registry)) return CN_MIRRORS.concat([null]);
  return MIRRORS;
}

function isFile(p) {
  try { return !!p && fs.statSync(p).isFile(); } catch (err) { return false; }
}

function cacheFile() { return path.join(stateDir(), 'runtime.json'); }

function binaryInPackage(pkgDir) {
  if (!pkgDir) return null;
  const pathFile = path.join(pkgDir, 'path.txt');
  let rel = null;
  try { rel = fs.readFileSync(pathFile, 'utf8').trim(); } catch (err) { rel = null; }
  const candidates = [];
  if (rel) candidates.push(path.join(pkgDir, 'dist', rel));
  if (process.platform === 'win32') candidates.push(path.join(pkgDir, 'dist', 'electron.exe'));
  else if (process.platform === 'darwin') candidates.push(path.join(pkgDir, 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron'));
  else candidates.push(path.join(pkgDir, 'dist', 'electron'));
  for (const candidate of candidates) {
    if (isFile(candidate)) return candidate;
  }
  return null;
}

function packageDirOf(name) {
  const roots = [path.resolve(__dirname, '..', '..')];
  try {
    return path.dirname(require.resolve(name + '/package.json', { paths: roots }));
  } catch (err) {
    try { return path.dirname(require.resolve(name + '/package.json')); } catch (err2) { return null; }
  }
}

function electronVersion() {
  const dir = packageDirOf('electron');
  if (!dir) return null;
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).version;
  } catch (err) {
    return null;
  }
}

function fromRequire() {
  try {
    const resolved = require('electron');
    if (typeof resolved === 'string' && isFile(resolved)) return resolved;
  } catch (err) { /* 未安装或二进制缺失 */ }
  return null;
}

function fromCache() {
  const data = readJson(cacheFile(), null);
  if (data && data.electron && isFile(data.electron)) return data.electron;
  return null;
}

function saveCache(bin) {
  try { writeJson(cacheFile(), { electron: bin, at: new Date().toISOString() }); } catch (err) { /* 忽略 */ }
}

function runInstaller(pkgDir, mirror, log) {
  const installer = path.join(pkgDir, 'install.js');
  if (!isFile(installer)) return false;
  const env = Object.assign({}, process.env);
  if (mirror) env.ELECTRON_MIRROR = mirror;
  log('正在下载 Electron 运行时' + (mirror ? '（镜像 ' + mirror + '）' : '（官方源）') + '，首次运行需要几分钟…');
  const result = spawnSync(process.execPath, [installer], { cwd: pkgDir, env: env, stdio: 'inherit', timeout: 15 * 60 * 1000 });
  if (result.error) {
    log('下载失败: ' + result.error.message);
    return false;
  }
  if (result.status !== 0) {
    log('下载失败（退出码 ' + result.status + '）');
    return false;
  }
  return true;
}

function npmInstallInto(dir, version, mirror, log) {
  ensureDir(dir);
  const env = Object.assign({}, process.env);
  if (mirror) env.ELECTRON_MIRROR = mirror;
  const spec = 'electron@' + (version || 'latest');
  log('尝试用 npm 安装 ' + spec + ' 到 ' + dir + '…');
  const args = ['install', spec, '--prefix', dir, '--no-save', '--no-audit', '--no-fund', '--loglevel', 'error'];
  const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const result = spawnSync(npmCmd, args, { env: env, stdio: 'inherit', shell: process.platform === 'win32', timeout: 15 * 60 * 1000 });
  if (result.error || result.status !== 0) return false;
  return binaryInPackage(path.join(dir, 'node_modules', 'electron'));
}

/**
 * 返回可执行的 Electron 二进制路径；失败时抛出带说明的错误。
 * options: { log, mirror, force }
 */
function ensureElectron(options) {
  const opts = options || {};
  const log = opts.log || function (msg) { console.log(msg); };

  if (process.env.BT_ANIM_ELECTRON && isFile(process.env.BT_ANIM_ELECTRON)) {
    return process.env.BT_ANIM_ELECTRON;
  }

  const direct = fromRequire();
  if (direct) {
    saveCache(direct);
    return direct;
  }

  const cached = fromCache();
  if (cached) return cached;

  const pkgDir = packageDirOf('electron');
  const version = electronVersion();

  if (pkgDir) {
    const existing = binaryInPackage(pkgDir);
    if (existing) { saveCache(existing); return existing; }
    const mirrors = opts.mirror ? [opts.mirror] : preferredMirrors();
    for (const mirror of mirrors) {
      if (runInstaller(pkgDir, mirror, log)) {
        const bin = binaryInPackage(pkgDir);
        if (bin) { saveCache(bin); return bin; }
      }
    }
  }

  const runtimeDir = path.join(stateDir(), 'runtime');
  const mirrors = opts.mirror ? [opts.mirror] : preferredMirrors();
  for (const mirror of mirrors) {
    const bin = npmInstallInto(runtimeDir, version, mirror, log);
    if (bin) { saveCache(bin); return bin; }
  }

  throw new Error(
    '无法准备 Electron 运行时。请检查网络，或手动安装 Electron 后设置环境变量 BT_ANIM_ELECTRON 指向 electron 可执行文件。\n' +
    '  国内网络可先执行：set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/'
  );
}

module.exports = { ensureElectron, binaryInPackage, electronVersion, MIRRORS, CN_MIRRORS, preferredMirrors };
