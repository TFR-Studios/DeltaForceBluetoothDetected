'use strict';
/**
 * Windows 蓝牙传感器：
 *  1) 常驻 PowerShell 进程轮询 PnP（pnputil /enum-devices /class Bluetooth）判断连接/断开；
 *  2) 轮询 BTHPORT 注册表发现“新配对设备”；
 *  3) 定时用 WinRT 做一次附近未配对设备扫描，发现“新设备”。
 */
const path = require('path');
const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const { createKnownStore } = require('./known-store');

const SCRIPTS_DIR = path.join(__dirname, 'scripts');
const WATCH_SCRIPT = process.env.BT_ANIM_WATCH_SCRIPT || path.join(SCRIPTS_DIR, 'win-bt-watch.ps1');
const SCAN_SCRIPT = process.env.BT_ANIM_SCAN_SCRIPT || path.join(SCRIPTS_DIR, 'win-bt-scan.ps1');

function powershellExe() {
  if (process.env.BT_ANIM_POWERSHELL) return process.env.BT_ANIM_POWERSHELL;
  return 'powershell.exe';
}

function normalizeAddress(raw) {
  if (!raw) return '';
  return String(raw).replace(/[^0-9a-fA-F]/g, '').toUpperCase();
}

function prettyAddress(address) {
  const a = normalizeAddress(address);
  if (a.length !== 12) return address || '';
  return [a.slice(0, 2), a.slice(2, 4), a.slice(4, 6), a.slice(6, 8), a.slice(8, 10), a.slice(10, 12)].join(':');
}

function normalizeDevice(raw) {
  const device = raw || {};
  const address = normalizeAddress(device.address);
  return {
    address: address,
    mac: prettyAddress(address),
    name: (device.name || '').trim(),
    kind: device.kind || 'unknown',
    status: device.status || '',
    id: device.id || '',
  };
}

function label(device) {
  if (!device) return '蓝牙设备';
  if (device.name) return device.name;
  return device.mac ? ('蓝牙设备 ' + device.mac) : '蓝牙设备';
}

function createWindowsSensor(config, log) {
  const emitter = new EventEmitter();
  const cfg = config || {};
  const sensorCfg = cfg.sensor || {};
  const scanCfg = cfg.scan || {};

  const powershell = powershellExe();
  const known = createKnownStore();
  const state = {
    supported: true,
    engine: null,
    connected: new Map(),
    paired: new Map(),
    pairedNames: new Set(),
    lastHeartbeat: 0,
    watcherRestarts: 0,
    scanning: false,
    lastScanAt: 0,
    lastScanResult: null,
    scans: 0,
  };

  let watcher = null;
  let scanner = null;
  let stopping = false;
  let scanTimer = null;
  let restartTimer = null;

  function buildPairedNames() {
    state.pairedNames = new Set();
    state.paired.forEach(function (dev) {
      const name = (dev.name || '').trim().toLowerCase();
      if (name) state.pairedNames.add(name);
    });
  }

  function emitStatus() {
    emitter.emit('status', emitter.status());
  }

  function handleReady(payload) {
    state.engine = payload.engine || 'pnputil';
    state.connected = new Map();
    (payload.connected || []).forEach(function (raw) {
      const device = normalizeDevice(raw);
      if (device.address) state.connected.set(device.address, device);
    });
    state.paired = new Map();
    (payload.paired || []).forEach(function (raw) {
      const device = normalizeDevice(typeof raw === 'string' ? { address: raw } : raw);
      if (device.address) state.paired.set(device.address, device);
    });
    buildPairedNames();
    log.info('蓝牙监听已启动（' + state.engine + '），当前已连接 ' + state.connected.size + ' 个设备，已配对 ' + state.paired.size + ' 个');
    emitter.emit('ready', emitter.status());
    emitStatus();
  }

  function handleLine(line) {
    const text = line.trim();
    if (!text) return;
    let payload = null;
    try {
      payload = JSON.parse(text);
    } catch (err) {
      log.debug('无法解析传感器输出: ' + text.slice(0, 200));
      return;
    }
    switch (payload.ev) {
      case 'ready':
        handleReady(payload);
        break;
      case 'heartbeat':
        state.lastHeartbeat = Date.now();
        break;
      case 'connected':
      case 'disconnected':
      case 'paired': {
        const device = normalizeDevice(payload.device);
        if (!device.address) return;
        if (payload.ev === 'connected') state.connected.set(device.address, device);
        else if (payload.ev === 'disconnected') state.connected.delete(device.address);
        else {
          state.paired.set(device.address, device);
          if (device.name) { state.pairedNames.add(device.name.toLowerCase()); device.name = device.name; }
        }
        log.info('[' + payload.ev + '] ' + label(device));
        emitter.emit('change', { kind: payload.ev, device: device, at: new Date() });
        emitStatus();
        break;
      }
      case 'error':
        log.warn('传感器报告错误（' + (payload.scope || 'unknown') + '）: ' + payload.message);
        break;
      default:
        log.debug('未知的传感器事件: ' + payload.ev);
    }
  }

  function startWatcher() {
    if (stopping) return;
    let child;
    try {
      child = spawn(powershell, [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', WATCH_SCRIPT,
        '-PollMs', String(sensorCfg.pollMs || 1200),
        '-PairMs', String(sensorCfg.pairMs || 5000),
        '-HeartbeatMs', String(sensorCfg.heartbeatMs || 60000),
        '-ParentPid', String(process.pid),
      ], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      emitter.emit('error', new Error('无法启动 PowerShell 蓝牙监听进程: ' + err.message));
      return;
    }
    watcher = child;

    let buffer = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', function (chunk) {
      buffer += chunk;
      let index = buffer.indexOf('\n');
      while (index >= 0) {
        handleLine(buffer.slice(0, index));
        buffer = buffer.slice(index + 1);
        index = buffer.indexOf('\n');
      }
    });

    let errBuffer = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', function (chunk) {
      errBuffer += chunk;
      if (errBuffer.length > 4000) errBuffer = errBuffer.slice(-4000);
    });

    child.on('error', function (err) {
      emitter.emit('error', new Error('PowerShell 进程错误: ' + err.message));
    });

    child.on('exit', function (code) {
      watcher = null;
      if (stopping) return;
      const tail = errBuffer.trim().split('\n').slice(-3).join(' | ');
      log.warn('蓝牙监听进程退出（code=' + code + '）' + (tail ? ' : ' + tail : ''));
      if (state.watcherRestarts < 6) {
        state.watcherRestarts++;
        const delay = Math.min(15000, 800 * state.watcherRestarts);
        restartTimer = setTimeout(function () {
          restartTimer = null;
          if (!stopping) startWatcher();
        }, delay);
      } else {
        emitter.emit('error', new Error('蓝牙监听进程反复退出，已停止重启。请运行 bt-anim doctor 检查环境。'));
      }
    });
  }

  function runScan(reason) {
    if (state.scanning) return Promise.resolve([]);
    state.scanning = true;
    const mode = scanCfg.mode || 'le';
    const timeoutSec = scanCfg.timeoutSec || 45;
    const started = Date.now();
    log.debug('开始扫描附近设备（mode=' + mode + ', ' + reason + '）');

    return new Promise(function (resolve) {
      let child;
      try {
        child = spawn(powershell, [
          '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SCAN_SCRIPT,
          '-Mode', mode, '-TimeoutSec', String(timeoutSec),
        ], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (err) {
        state.scanning = false;
        emitter.emit('error', new Error('无法启动扫描进程: ' + err.message));
        resolve([]);
        return;
      }

      scanner = child;
      let out = '';
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', function (chunk) { out += chunk; });
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', function () { /* 忽略 */ });

      const guard = setTimeout(function () {
        try { child.kill(); } catch (err) { /* 忽略 */ }
      }, (timeoutSec + 20) * 1000);

      child.on('error', function (err) {
        clearTimeout(guard);
        state.scanning = false;
        emitter.emit('error', new Error('扫描进程错误: ' + err.message));
        resolve([]);
      });

      child.on('exit', function () {
        clearTimeout(guard);
        if (scanner === child) scanner = null;
        state.scanning = false;
        state.lastScanAt = Date.now();
        state.scans++;

        let payload = null;
        const lines = out.split('\n').filter(function (l) { return l.trim(); });
        for (let i = lines.length - 1; i >= 0; i--) {
          try {
            const parsed = JSON.parse(lines[i]);
            if (parsed && parsed.ev === 'scan') { payload = parsed; break; }
          } catch (err) { /* 继续找 */ }
        }
        if (!payload) {
          log.warn('扫描没有返回结果');
          state.lastScanResult = { ok: false, devices: [], elapsedMs: Date.now() - started };
          resolve([]);
          return;
        }

        const rawDevices = [].concat(payload.devices || []);
        const devices = rawDevices.map(normalizeDevice).filter(function (d) { return d.address; });
        state.lastScanResult = {
          ok: payload.ok !== false,
          elapsedMs: payload.elapsedMs || (Date.now() - started),
          devices: devices.length,
          at: new Date().toISOString(),
        };
        log.debug('扫描完成：发现 ' + devices.length + ' 个附近设备，用时 ' + state.lastScanResult.elapsedMs + 'ms');

        const fresh = [];
        devices.forEach(function (device) {
          const key = device.address;
          const isPaired = state.paired.has(key) || (device.name && state.pairedNames.has(device.name.toLowerCase()));
          if (isPaired) {
            state.paired.forEach(function (pairedDevice, pairedKey) {
              if (pairedKey === key || (pairedDevice.name && device.name && pairedDevice.name.toLowerCase() === device.name.toLowerCase())) {
                known.remember('paired:' + key, { name: device.name, kind: device.kind, via: 'scan' });
              }
            });
            return;
          }
          if (scanCfg.excludePaired === false && state.paired.has(key)) return;
          if (known.has(key)) {
            known.touch(key);
            return;
          }
          known.remember(key, { name: device.name, kind: device.kind });
          fresh.push(device);
        });

        const baseline = state.scans <= 1 && scanCfg.baselineFirst !== false;
        if (baseline) {
          log.info('首次扫描已记录 ' + fresh.length + ' 个已知设备（作为基线，不触发动画）');
        } else {
          fresh.forEach(function (device) {
            log.info('[discovered] ' + label(device));
            emitter.emit('discovered', { kind: 'discovered', device: device, at: new Date() });
          });
        }
        emitStatus();
        resolve(devices);
      });
    });
  }

  function startScanTimer() {
    if (!scanCfg.enabled) return;
    const interval = Math.max(15000, scanCfg.intervalMs || 90000);
    scanTimer = setInterval(function () {
      runScan('定时扫描').catch(function (err) { log.warn('扫描失败: ' + err.message); });
    }, interval);
    if (scanTimer.unref) scanTimer.unref();
    const warmup = setTimeout(function () {
      runScan('启动基线扫描').catch(function (err) { log.warn('扫描失败: ' + err.message); });
    }, 4000);
    if (warmup.unref) warmup.unref();
  }

  emitter.platform = 'win32';
  emitter.supported = true;

  emitter.start = function () {
    stopping = false;
    startWatcher();
    startScanTimer();
  };

  emitter.stop = function () {
    stopping = true;
    if (scanTimer) { clearInterval(scanTimer); scanTimer = null; }
    if (restartTimer) { clearTimeout(restartTimer); restartTimer = null; }
    if (watcher) {
      try { watcher.kill(); } catch (err) { /* 忽略 */ }
      watcher = null;
    }
    if (scanner) {
      try { scanner.kill(); } catch (err) { /* 忽略 */ }
      scanner = null;
    }
    known.flush();
  };

  emitter.scanNow = function (reason) { return runScan(reason || '手动扫描'); };

  emitter.status = function () {
    return {
      platform: 'win32',
      supported: true,
      engine: state.engine,
      running: !!watcher,
      connected: Array.from(state.connected.values()),
      pairedCount: state.paired.size,
      scan: {
        enabled: !!scanCfg.enabled,
        intervalMs: scanCfg.intervalMs,
        mode: scanCfg.mode,
        scanning: state.scanning,
        scans: state.scans,
        lastAt: state.lastScanAt ? new Date(state.lastScanAt).toISOString() : null,
        last: state.lastScanResult,
        knownDevices: known.size(),
      },
      watcherRestarts: state.watcherRestarts,
    };
  };

  emitter.knownStore = known;
  return emitter;
}

module.exports = {
  createWindowsSensor,
  normalizeDevice,
  normalizeAddress,
  prettyAddress,
  label,
  WATCH_SCRIPT,
  SCAN_SCRIPT,
};
