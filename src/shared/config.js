'use strict';
/**
 * 配置：默认值 -> 配置文件 -> 环境变量 -> 命令行参数。
 */
const fs = require('fs');
const path = require('path');
const { stateDir } = require('./paths');

const DEFAULTS = {
  logLevel: 'info',
  logFile: true,
  playOnStart: false,
  exitAfterPlay: false,
  triggers: {
    connected: true,
    disconnected: false,
    paired: true,
    discovered: true,
  },
  cooldownMs: 4000,
  batchWindowMs: 900,
  onBusy: 'restart',
  sensor: {
    enabled: true,
    pollMs: 1200,
    pairMs: 5000,
    heartbeatMs: 60000,
  },
  scan: {
    enabled: true,
    intervalMs: 90000,
    mode: 'le',
    timeoutSec: 45,
    baselineFirst: true,
    excludePaired: true,
  },
  animation: {
    dir: null,
    file: 'data.json',
    fromFrame: null,
    toFrame: null,
    speed: 1,
    counter: false,
    textMode: 'original',
    caption: false,
    font: null,
  },
  window: {
    display: 'primary',
    fit: 'cover',
    opacity: 1,
    clickThrough: true,
    extraMs: 700,
    tray: true,
    keepMounted: true,
    backdrop: 0,
    boost: 1,
  },
  control: {
    enabled: true,
    port: 17892,
  },
};

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function deepMerge(base, patch) {
  const out = Array.isArray(base) ? base.slice() : Object.assign({}, base);
  if (!isPlainObject(patch)) return out;
  Object.keys(patch).forEach(function (key) {
    const value = patch[key];
    if (value === undefined) return;
    if (isPlainObject(value) && isPlainObject(out[key])) out[key] = deepMerge(out[key], value);
    else out[key] = value;
  });
  return out;
}

const COMMANDS = ['start', 'stop', 'status', 'trigger', 'scan', 'capture', 'pause', 'resume', 'doctor', 'help', 'version'];

const FLAGS = {
  '--test': { key: 'playOnStart', type: 'bool' },
  '--play-on-start': { key: 'playOnStart', type: 'bool' },
  '--once': { key: 'exitAfterPlay', type: 'bool' },
  '--detach': { key: 'detach', type: 'bool' },
  '--restart': { key: 'restart', type: 'bool' },
  '--kind': { key: 'triggers', type: 'kindList' },
  '--only': { key: 'triggers', type: 'kindList' },
  '--cooldown': { key: 'cooldownMs', type: 'int' },
  '--batch': { key: 'batchWindowMs', type: 'int' },
  '--on-busy': { key: 'onBusy', type: 'string' },
  '--poll': { key: 'sensor.pollMs', type: 'int' },
  '--pair-poll': { key: 'sensor.pairMs', type: 'int' },
  '--no-sensor': { key: 'sensor.enabled', type: 'bool', value: false },
  '--no-scan': { key: 'scan.enabled', type: 'bool', value: false },
  '--scan': { key: 'scan.enabled', type: 'bool', value: true },
  '--scan-interval': { key: 'scan.intervalMs', type: 'seconds' },
  '--scan-mode': { key: 'scan.mode', type: 'string' },
  '--scan-timeout': { key: 'scan.timeoutSec', type: 'int' },
  '--animation': { key: 'animation.dir', type: 'string' },
  '--animation-file': { key: 'animation.file', type: 'string' },
  '--from': { key: 'animation.fromFrame', type: 'int' },
  '--to': { key: 'animation.toFrame', type: 'int' },
  '--speed': { key: 'animation.speed', type: 'float' },
  '--counter': { key: 'animation.counter', type: 'bool' },
  '--no-counter': { key: 'animation.counter', type: 'bool', value: false },
  '--text-mode': { key: 'animation.textMode', type: 'string' },
  '--font': { key: 'animation.font', type: 'string' },
  '--caption': { key: 'animation.caption', type: 'bool' },
  '--display': { key: 'window.display', type: 'string' },
  '--fit': { key: 'window.fit', type: 'string' },
  '--opacity': { key: 'window.opacity', type: 'float' },
  '--backdrop': { key: 'window.backdrop', type: 'float' },
  '--boost': { key: 'window.boost', type: 'float' },
  '--no-click-through': { key: 'window.clickThrough', type: 'bool', value: false },
  '--no-tray': { key: 'window.tray', type: 'bool', value: false },
  '--tray': { key: 'window.tray', type: 'bool', value: true },
  '--port': { key: 'control.port', type: 'int' },
  '--no-control': { key: 'control.enabled', type: 'bool', value: false },
  '--config': { key: 'configPath', type: 'string' },
  '--json': { key: 'json', type: 'bool' },
  '--verbose': { key: 'logLevel', type: 'const', value: 'debug' },
  '--debug': { key: 'logLevel', type: 'const', value: 'debug' },
  '--quiet': { key: 'logLevel', type: 'const', value: 'error' },
};

const TRIGGER_ALIASES = {
  all: ['connected', 'disconnected', 'paired', 'discovered'],
  device: ['connected', 'paired', 'discovered'],
};

function setPath(target, dotted, value) {
  const parts = dotted.split('.');
  let cur = target;
  for (let i = 0; i < parts.length - 1; i++) {
    if (!isPlainObject(cur[parts[i]])) cur[parts[i]] = {};
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = value;
  return target;
}

function parseKindList(raw) {
  const triggers = { connected: false, disconnected: false, paired: false, discovered: false };
  String(raw).split(/[,\s]+/).filter(Boolean).forEach(function (name) {
    const key = name.trim().toLowerCase();
    if (TRIGGER_ALIASES[key]) {
      TRIGGER_ALIASES[key].forEach(function (k) { triggers[k] = true; });
    } else if (Object.prototype.hasOwnProperty.call(triggers, key)) {
      triggers[key] = true;
    } else {
      throw new Error('未知的事件类型: ' + name + '（可用: connected, disconnected, paired, discovered, all）');
    }
  });
  return triggers;
}

/**
 * 解析命令行。返回 { command, patch, positionals, help, version, errors }
 */
function parseArgs(argv) {
  const args = Array.isArray(argv) ? argv.slice() : [];
  const result = { command: null, patch: {}, positionals: [], errors: [] };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--') {
      result.positionals = result.positionals.concat(args.slice(i + 1));
      break;
    }
    if (arg === '-h' || arg === '--help' || arg === 'help') { result.help = true; continue; }
    if (arg === '-v' || arg === '--version' || arg === 'version') { result.version = true; continue; }

    if (arg.charAt(0) === '-') {
      let name = arg;
      let inlineValue = null;
      const eq = arg.indexOf('=');
      if (eq > 0) {
        name = arg.slice(0, eq);
        inlineValue = arg.slice(eq + 1);
      }
      const spec = FLAGS[name];
      if (!spec) {
        result.errors.push('未知参数: ' + arg);
        continue;
      }
      if (spec.type === 'bool' && inlineValue === null) {
        setPath(result.patch, spec.key, spec.value === undefined ? true : spec.value);
        continue;
      }
      if (spec.type === 'const') {
        setPath(result.patch, spec.key, spec.value);
        continue;
      }
      let raw = inlineValue;
      if (raw === null) {
        raw = args[i + 1];
        if (raw === undefined || raw.charAt(0) === '-') {
          result.errors.push('参数 ' + name + ' 需要一个值');
          continue;
        }
        i++;
      }
      try {
        if (spec.type === 'int') setPath(result.patch, spec.key, parseInt(raw, 10));
        else if (spec.type === 'float') setPath(result.patch, spec.key, parseFloat(raw));
        else if (spec.type === 'seconds') {
          const sec = parseFloat(raw);
          if (!isFinite(sec) || sec < 0) throw new Error('需要非负秒数');
          setPath(result.patch, spec.key, Math.round(sec * 1000));
        } else if (spec.type === 'kindList') setPath(result.patch, spec.key, parseKindList(raw));
        else setPath(result.patch, spec.key, raw);
      } catch (err) {
        result.errors.push('参数 ' + name + ' 无效: ' + err.message);
      }
      continue;
    }

    if (!result.command && COMMANDS.indexOf(arg) >= 0) result.command = arg;
    else result.positionals.push(arg);
  }
  return result;
}

function findConfigFile(explicit) {
  if (explicit) return path.resolve(explicit);
  const candidates = [
    path.join(process.cwd(), 'bt-anim.config.json'),
    path.join(stateDir(), 'config.json'),
  ];
  for (const file of candidates) {
    try {
      if (fs.statSync(file).isFile()) return file;
    } catch (err) { /* 忽略 */ }
  }
  return null;
}

/**
 * 构建最终配置。sources: { argv, env, cwd }
 */
function loadConfig(sources) {
  const src = sources || {};
  const parsed = parseArgs(src.argv || []);
  const warnings = [];
  let config = deepMerge(DEFAULTS, {});
  let configPath = null;

  const explicit = parsed.patch.configPath;
  const fromEnv = (src.env || process.env).BT_ANIM_CONFIG_JSON;
  if (fromEnv) {
    try {
      config = deepMerge(config, JSON.parse(fromEnv));
    } catch (err) {
      warnings.push('BT_ANIM_CONFIG_JSON 解析失败: ' + err.message);
    }
  } else {
    configPath = findConfigFile(explicit);
    if (configPath) {
      try {
        config = deepMerge(config, JSON.parse(fs.readFileSync(configPath, 'utf8')));
      } catch (err) {
        warnings.push('配置文件解析失败 ' + configPath + ': ' + err.message);
      }
    } else if (explicit) {
      warnings.push('找不到配置文件: ' + explicit);
    }
  }

  const patch = Object.assign({}, parsed.patch);
  delete patch.configPath;
  config = deepMerge(config, patch);

  return {
    config: config,
    command: parsed.command || 'start',
    positionals: parsed.positionals,
    help: !!parsed.help,
    version: !!parsed.version,
    errors: parsed.errors,
    warnings: warnings,
    configPath: configPath,
    flags: parsed.patch,
  };
}

module.exports = { DEFAULTS, loadConfig, parseArgs, deepMerge, parseKindList, COMMANDS, FLAGS };
