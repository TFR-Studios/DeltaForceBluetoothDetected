#!/usr/bin/env node
'use strict';
/**
 * bt-anim 命令行入口（npx 运行的就是这个文件）。
 */
const path = require('path');
const fs = require('fs');
const http = require('http');
const { spawn, spawnSync } = require('child_process');

const pkg = require('../package.json');
const { loadConfig } = require('../src/shared/config');
const { appRoot, runFile, stateDir, readJson, ensureDir } = require('../src/shared/paths');
const { ensureElectron, binaryInPackage, electronVersion } = require('../src/shared/electron-bootstrap');

const HELP = [
  'bt-anim  ' + pkg.version + '  ——  蓝牙连接 / 扫到新设备时，在系统最顶层播放动画',
  '',
  '用法:',
  '  npx bt-anim-overlay [命令] [选项]',
  '',
  '命令:',
  '  start        启动悬浮层并开始监听蓝牙（默认命令）',
  '  trigger      立刻播放一次动画（测试用）',
  '  scan         立刻扫描一次附近的蓝牙设备',
  '  status       查看运行状态（设备、扫描、播放记录）',
  '  pause        暂停触发（仍继续监听）',
  '  resume       恢复触发',
  '  stop         退出正在运行的实例',
  '  doctor       环境自检（PowerShell / 蓝牙 / Electron / 动画文件）',
  '  help         显示本帮助',
  '',
  '常用选项:',
  '  --test               启动后立即播放一次动画',
  '  --once               播放一次后自动退出',
  '  --detach             后台运行（关掉终端也不影响）',
  '  --restart            先结束已有实例再启动',
  '  --only <类型>        只响应指定事件: connected,disconnected,paired,discovered,all',
  '  --no-scan            关闭「扫描到新设备」检测',
  '  --scan-interval <秒> 扫描间隔，默认 90 秒（0 表示关闭）',
  '  --scan-mode <模式>   扫描类型: le(默认) | classic | both',
  '  --poll <毫秒>        连接状态轮询间隔，默认 1200',
  '  --cooldown <毫秒>    两次播放的最小间隔，默认 4000',
  '  --from <帧> --to <帧> 只播放动画的某一段（默认整段）',
  '  --speed <倍速>       播放速度，默认 1',
  '  --counter            把画面上的数字改成本次事件的设备数量',
  '  --text-mode bt       把画面文案换成蓝牙版本（附近蓝牙设备 / 新设备信号数）',
  '  --caption            在动画下方显示设备名',
  '  --font <字体>        指定画面文字使用的中文字体',
  '  --display <目标>     显示在哪个屏幕: primary(默认) | all | 序号(1,2…)',
  '  --fit <方式>         画面适配: cover(默认) | contain | stretch',
  '  --opacity <0-1>      悬浮层不透明度',
  '  --backdrop <0-0.9>   动画背后压一层暗色遮罩（动画偏淡时更好看，默认 0）',
  '  --boost <倍数>       画面亮度增强倍数（默认 1）',
  '  --no-tray            不创建托盘图标',
  '  --no-control         关闭本地控制接口',
  '  --port <端口>        控制接口端口，默认 17892',
  '  --animation <目录>   使用自己的 Lottie 动画目录（含 data.json 与图片）',
  '  --config <文件>      指定配置文件',
  '  --verbose / --quiet  日志详细程度',
  '',
  '示例:',
  '  npx bt-anim-overlay --test            立刻验证效果（启动并播放一次）',
  '  npx bt-anim-overlay --once --test     播放一次后自动退出',
  '  npx bt-anim-overlay --detach          后台常驻监听',
  '  npx bt-anim-overlay trigger           让正在运行的实例播放一次',
  '  npx bt-anim-overlay start --backdrop 0.4 --boost 1.5   画面更醒目',
  '  npx bt-anim-overlay capture           把悬浮层当前画面存成 PNG（排查用）',
  '  npx bt-anim-overlay doctor            环境自检',
  '',
].join('\n');

function color(code, text) {
  if (!process.stdout.isTTY || process.env.NO_COLOR) return text;
  return '\u001b[' + code + 'm' + text + '\u001b[0m';
}
const green = function (t) { return color('32', t); };
const red = function (t) { return color('31', t); };
const yellow = function (t) { return color('33', t); };
const gray = function (t) { return color('90', t); };
const bold = function (t) { return color('1', t); };

function isAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err && err.code === 'EPERM';
  }
}

function readRun() {
  const data = readJson(runFile(), null);
  if (!data || !data.port || !data.pid) return null;
  if (!isAlive(data.pid)) return null;
  return data;
}

function apiRequest(run, method, route, body, timeoutMs) {
  return new Promise(function (resolve, reject) {
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request({
      host: '127.0.0.1',
      port: run.port,
      path: route,
      method: method,
      timeout: timeoutMs || 120000,
      headers: Object.assign(
        { 'x-bt-anim-token': run.token },
        payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}
      ),
    }, function (res) {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', function (chunk) { raw += chunk; });
      res.on('end', function () {
        let json = null;
        try { json = JSON.parse(raw); } catch (err) { json = { raw: raw }; }
        resolve({ status: res.statusCode, json: json });
      });
    });
    req.on('timeout', function () { req.destroy(new Error('请求超时')); });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function printStatus(data) {
  const lines = [];
  lines.push(bold('bt-anim ' + data.app.version) + gray('  pid ' + data.app.pid + '  启动于 ' + data.app.startedAt));
  lines.push('状态    : ' + (data.paused ? yellow('已暂停触发') : green('监听中')) + gray('  悬浮窗' + (data.window.visible ? '正在显示' : '隐藏中')));
  if (data.animation) {
    lines.push('动画    : ' + path.basename(data.animation.file) + gray('  ' + data.animation.width + 'x' + data.animation.height +
      ' / ' + Math.round(data.animation.durationMs / 1000) + 's / ' + data.animation.fps + 'fps' +
      ' 帧 ' + (data.animation.segment ? data.animation.segment.from + '-' + data.animation.segment.to : '-') +
      ' 速度 x' + data.animation.speed));
  }
  const sensor = data.sensor || {};
  lines.push('监听    : ' + (data.sensor && data.sensor.running ? green('运行中') : red('未运行')) +
    gray('  引擎 ' + (sensor.engine || '-') + '  已配对 ' + (sensor.pairedCount || 0) + ' 个'));
  const connected = (sensor.connected || []);
  lines.push('已连接  : ' + (connected.length ? connected.map(function (d) { return d.name || d.mac; }).join('、') : gray('无')));
  if (sensor.scan) {
    lines.push('扫描    : ' + (sensor.scan.enabled ? green('开启') : gray('关闭')) +
      gray('  间隔 ' + Math.round((sensor.scan.intervalMs || 0) / 1000) + 's  已扫描 ' + sensor.scan.scans + ' 次' +
        (sensor.scan.last ? '  上次发现 ' + sensor.scan.last.devices + ' 个设备' : '') +
        '  记忆 ' + sensor.scan.knownDevices + ' 个'));
  }
  const engine = data.engine || {};
  lines.push('播放    : ' + gray('累计 ' + (engine.played || 0) + ' 次' + (engine.lastPlayAt ? '，最近 ' + engine.lastPlayAt : '')));
  if (engine.last) {
    lines.push('最近事件: ' + gray(engine.last.label + ' - ' + engine.last.name));
  }
  const triggers = data.triggers || {};
  const on = Object.keys(triggers).filter(function (k) { return triggers[k]; });
  lines.push('触发条件: ' + gray(on.length ? on.join(', ') : '（无）'));
  console.log(lines.join('\n'));
}

async function waitForExit(pid, timeoutMs) {
  const deadline = Date.now() + (timeoutMs || 6000);
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    await new Promise(function (r) { setTimeout(r, 150); });
  }
  return !isAlive(pid);
}

async function cmdStart(loaded) {
  const cfg = loaded.config;
  const animDir = cfg.animation.dir
    ? path.resolve(process.cwd(), cfg.animation.dir)
    : path.join(appRoot(), 'animation');
  cfg.animation.dir = animDir;
  const animFile = path.join(animDir, cfg.animation.file || 'data.json');
  if (!fs.existsSync(animFile)) {
    console.error(red('找不到动画文件: ' + animFile));
    console.error('可以用 --animation <目录> 指定自己的 Lottie 动画目录（需包含 data.json 与图片）。');
    return 2;
  }
  if (!cfg.sensor.enabled && !cfg.playOnStart) {
    console.log(yellow('提示: 已用 --no-sensor 关闭蓝牙监听，只会响应手动 trigger。'));
  }

  const existing = readRun();
  if (existing && !cfg.restart) {
    console.log(yellow('bt-anim 已在运行（pid ' + existing.pid + '，端口 ' + existing.port + '）。'));
    try {
      const res = await apiRequest(existing, 'GET', '/status', null, 4000);
      if (res.json && res.json.data) printStatus(res.json.data);
    } catch (err) { /* 忽略 */ }
    console.log(gray('如需重启: bt-anim start --restart；如需退出: bt-anim stop'));
    return 0;
  }
  if (existing && cfg.restart) {
    console.log(gray('正在结束已有实例（pid ' + existing.pid + '）…'));
    try { await apiRequest(existing, 'POST', '/quit', null, 3000); } catch (err) { /* 忽略 */ }
    await waitForExit(existing.pid, 6000);
  }

  let electronPath = null;
  try {
    electronPath = ensureElectron({ log: function (msg) { console.log(gray(msg)); } });
  } catch (err) {
    console.error(red(err.message));
    return 3;
  }
  console.log(gray('Electron: ' + electronPath));

  const env = Object.assign({}, process.env, {
    BT_ANIM_CONFIG_JSON: JSON.stringify(cfg),
    BT_ANIM_STATE_DIR: stateDir(),
  });
  delete env.ELECTRON_RUN_AS_NODE;

  const child = spawn(electronPath, [path.join(appRoot(), 'src', 'main.js')], {
    env: env,
    stdio: cfg.detach ? 'ignore' : 'inherit',
    detached: !!cfg.detach,
    windowsHide: !!cfg.detach,
  });

  if (cfg.detach) {
    child.unref();
    console.log(green('bt-anim 已在后台启动（pid ' + child.pid + '）。'));
    console.log(gray('查看状态: bt-anim status    退出: bt-anim stop'));
    return 0;
  }

  let stopping = false;
  const shutdown = async function () {
    if (stopping) return;
    stopping = true;
    const run = readRun();
    if (run) { try { await apiRequest(run, 'POST', '/quit', null, 2000); } catch (err) { /* 忽略 */ } }
    setTimeout(function () {
      try { child.kill(); } catch (err) { /* 忽略 */ }
    }, 1200);
  };
  process.on('SIGINT', function () { console.log(gray('\n正在退出…')); shutdown(); });
  process.on('SIGTERM', function () { shutdown(); });

  return new Promise(function (resolve) {
    child.on('exit', function (code) { resolve(code === null ? 0 : code); });
    child.on('error', function (err) {
      console.error(red('启动 Electron 失败: ' + err.message));
      resolve(4);
    });
  });
}

async function withInstance(fn) {
  const run = readRun();
  if (!run) {
    console.error(red('bt-anim 没有在运行。先执行: bt-anim start'));
    return 1;
  }
  return fn(run);
}

async function cmdStop() {
  return withInstance(async function (run) {
    try {
      await apiRequest(run, 'POST', '/quit', null, 5000);
      const ok = await waitForExit(run.pid, 6000);
      console.log(ok ? green('已退出 bt-anim。') : yellow('已发送退出指令，进程可能仍在收尾。'));
      return 0;
    } catch (err) {
      console.error(red('退出失败: ' + err.message));
      return 1;
    }
  });
}

async function cmdStatus(asJson) {
  return withInstance(async function (run) {
    try {
      const res = await apiRequest(run, 'GET', '/status', null, 6000);
      if (asJson) console.log(JSON.stringify(res.json.data, null, 2));
      else printStatus(res.json.data);
      return 0;
    } catch (err) {
      console.error(red('无法读取状态: ' + err.message));
      return 1;
    }
  });
}

async function cmdTrigger(positionals) {
  return withInstance(async function (run) {
    const name = positionals && positionals.length ? positionals.join(' ') : '演示设备';
    try {
      await apiRequest(run, 'POST', '/trigger', { name: name, kind: 'connected' }, 10000);
      console.log(green('已触发一次动画播放: ' + name));
      return 0;
    } catch (err) {
      console.error(red('触发失败: ' + err.message));
      return 1;
    }
  });
}

async function cmdScan() {
  return withInstance(async function (run) {
    console.log(gray('正在扫描附近的蓝牙设备（约 30 秒）…'));
    try {
      const res = await apiRequest(run, 'POST', '/scan', {}, 180000);
      const data = res.json.data || {};
      const devices = data.devices || [];
      console.log(green('扫描到 ' + devices.length + ' 个附近设备：'));
      devices.forEach(function (d) {
        console.log('  - ' + (d.name || gray('(未命名)')) + gray('  ' + d.mac + '  ' + (d.kind || '')));
      });
      return 0;
    } catch (err) {
      console.error(red('扫描失败: ' + err.message));
      return 1;
    }
  });
}

async function cmdCapture() {
  return withInstance(async function (run) {
    try {
      const res = await apiRequest(run, 'POST', '/capture', {}, 20000);
      console.log(JSON.stringify(res.json.data));
      return 0;
    } catch (err) {
      console.error(red('截取悬浮层画面失败: ' + err.message));
      return 1;
    }
  });
}

async function cmdSimple(action) {
  return withInstance(async function (run) {
    try {
      await apiRequest(run, 'POST', '/' + action, null, 5000);
      console.log(green(action === 'pause' ? '已暂停触发。' : '已恢复触发。'));
      return 0;
    } catch (err) {
      console.error(red('操作失败: ' + err.message));
      return 1;
    }
  });
}

function psFile(scriptPath, args, timeoutMs) {
  const params = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath].concat(args || []);
  const result = spawnSync('powershell.exe', params, {
    encoding: 'utf8',
    timeout: timeoutMs || 30000,
    windowsHide: true,
  });
  if (result.error) return { ok: false, error: result.error.message };
  const out = (result.stdout || '').trim();
  let json = null;
  if (out) {
    const lines = out.split(/\r?\n/).filter(Boolean);
    try { json = JSON.parse(lines[lines.length - 1]); } catch (err) { json = null; }
  }
  return { ok: result.status === 0, out: out, error: (result.stderr || '').trim(), json: json };
}

async function cmdDoctor() {
  const lines = [];
  const check = function (label, ok, detail) {
    lines.push((ok ? green('  [OK]  ') : red('  [!!]  ')) + label + (detail ? gray('  ' + detail) : ''));
  };

  console.log(bold('bt-anim 环境自检'));
  console.log(gray('  Node ' + process.version + '  平台 ' + process.platform + '  状态目录 ' + stateDir()));
  lines.push('');

  const animFile = path.join(appRoot(), 'animation', 'data.json');
  let animOk = false;
  let animDetail = animFile;
  try {
    const data = JSON.parse(fs.readFileSync(animFile, 'utf8'));
    animOk = true;
    animDetail = data.w + 'x' + data.h + ' ' + data.fr + 'fps ' + Math.round(data.op / data.fr) + 's';
  } catch (err) {
    animDetail = animFile + '（' + err.message + '）';
  }
  check('动画文件', animOk, animDetail);

  const lottie = path.join(appRoot(), 'vendor', 'lottie.min.js');
  check('lottie 运行时', fs.existsSync(lottie), lottie);

  let electronPath = null;
  try {
    const dir = path.dirname(require.resolve('electron/package.json', { paths: [appRoot()] }));
    electronPath = binaryInPackage(dir);
  } catch (err) { electronPath = null; }
  check('Electron 运行时', !!electronPath, electronPath || '未下载（首次启动会自动下载，约 100MB）');
  if (electronVersion()) lines.push(gray('         electron 包版本 ' + electronVersion()));

  if (process.platform === 'win32') {
    const probePath = path.join(appRoot(), 'src', 'sensors', 'scripts', 'win-probe.ps1');
    const probe = psFile(probePath, [], 30000);
    const info = probe.json || {};
    check('Windows PowerShell', !!info.ps, info.ps || probe.error);
    check('pnputil 蓝牙枚举', info.pnputil === true, '当前已连接蓝牙外设 ' + (info.connected === undefined ? '?' : info.connected) + ' 个');
    const adapters = info.adapters || [];
    const radio = adapters.filter(function (name) { return /Bluetooth\(R\)|Bluetooth 适配器|Wireless Bluetooth/i.test(name); });
    check('蓝牙适配器', adapters.length > 0, adapters.length ? (radio.length ? radio.join('、') : adapters.join('、')) : '未检测到蓝牙硬件');
    check('WinRT 扫描能力', info.winrt === true, info.winrt ? '支持附近设备扫描' : '不支持（无法检测新设备）');
  } else {
    lines.push(yellow('  [--]  非 Windows 平台：使用系统命令轮询，扫描功能可能不可用'));
  }

  const run = readRun();
  check('运行实例', !!run, run ? ('pid ' + run.pid + '，端口 ' + run.port) : '未运行');

  console.log(lines.join('\n'));
  console.log('');
  console.log(gray('  提示：独占全屏的游戏会挡住所有置顶窗口，建议把游戏设为「无边框窗口」模式。'));
  return 0;
}

async function main() {
  const loaded = loadConfig({ argv: process.argv.slice(2), env: process.env });

  if (loaded.version) {
    console.log(pkg.version);
    return 0;
  }
  if (loaded.help || loaded.command === 'help') {
    console.log(HELP);
    return 0;
  }
  if (loaded.errors.length) {
    loaded.errors.forEach(function (e) { console.error(red(e)); });
    console.error(gray('执行 bt-anim help 查看全部参数。'));
    return 2;
  }

  switch (loaded.command) {
    case 'start': return cmdStart(loaded);
    case 'stop': return cmdStop();
    case 'status': return cmdStatus(!!loaded.config.json);
    case 'trigger': return cmdTrigger(loaded.positionals);
    case 'scan': return cmdScan();
    case 'capture': return cmdCapture();
    case 'pause': return cmdSimple('pause');
    case 'resume': return cmdSimple('resume');
    case 'doctor': return cmdDoctor();
    default:
      console.error(red('未知命令: ' + loaded.command));
      console.log(HELP);
      return 2;
  }
}

if (require.main === module) {
  main().then(function (code) {
    process.exitCode = code || 0;
  }).catch(function (err) {
    console.error(red('发生错误: ' + (err && err.stack ? err.stack : err)));
    process.exitCode = 1;
  });
}

module.exports = { main, HELP };
