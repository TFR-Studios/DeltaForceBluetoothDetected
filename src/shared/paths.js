'use strict';
/**
 * 路径工具：应用根目录、状态目录、运行时文件位置。
 * 不依赖任何第三方包。
 */
const os = require('os');
const path = require('path');
const fs = require('fs');

const APP_ROOT = path.resolve(__dirname, '..', '..');
const APP_ID = 'bt-anim-overlay';

function stateDir() {
  const override = process.env.BT_ANIM_STATE_DIR;
  if (override) return path.resolve(override);
  const home = os.homedir();
  if (process.platform === 'win32') {
    const base = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    return path.join(base, APP_ID);
  }
  if (process.platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', APP_ID);
  }
  const base = process.env.XDG_STATE_HOME || path.join(home, '.local', 'state');
  return path.join(base, APP_ID);
}

function ensureDir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (err) {
    if (err && err.code !== 'EEXIST') throw err;
  }
  return dir;
}

function runFile() { return path.join(stateDir(), 'run.json'); }
function knownFile() { return path.join(stateDir(), 'known-devices.json'); }
function logDir() { return path.join(stateDir(), 'logs'); }

function appRoot() { return APP_ROOT; }

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    return fallback;
  }
}

function writeJson(file, value) {
  ensureDir(path.dirname(file));
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

module.exports = {
  APP_ID,
  APP_ROOT,
  appRoot,
  stateDir,
  ensureDir,
  runFile,
  knownFile,
  logDir,
  readJson,
  writeJson,
};
