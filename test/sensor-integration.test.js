'use strict';
/**
 * 传感器集成测试：用假的 PowerShell 脚本喂事件，验证解析与事件派发。
 * 只在 Windows 上运行。
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const isWindows = process.platform === 'win32';
const fakeScript = path.join(__dirname, 'fixtures', 'fake-watch.ps1');

function silentLog() {
  return { error: function () {}, warn: function () {}, info: function () {}, debug: function () {} };
}

test('Windows 传感器能解析 ready / connected / disconnected / paired 事件', { skip: !isWindows, timeout: 30000 }, async function () {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-anim-test-'));
  process.env.BT_ANIM_STATE_DIR = stateDir;
  process.env.BT_ANIM_WATCH_SCRIPT = fakeScript;

  // 需要在设置环境变量之后再 require，保证路径被读取到
  delete require.cache[require.resolve('../src/sensors/win32')];
  delete require.cache[require.resolve('../src/sensors/known-store')];
  delete require.cache[require.resolve('../src/shared/paths')];
  const { createWindowsSensor } = require('../src/sensors/win32');

  const sensor = createWindowsSensor({
    sensor: { enabled: true, pollMs: 1000, pairMs: 1000, heartbeatMs: 60000 },
    scan: { enabled: false },
  }, silentLog());

  const ready = [];
  const changes = [];
  sensor.on('ready', function (status) { ready.push(status); });
  sensor.on('change', function (event) { changes.push(event); });

  sensor.start();
  await new Promise(function (r) { setTimeout(r, 4000); });
  const status = sensor.status();
  sensor.stop();

  assert.strictEqual(ready.length, 1, '应该收到一次 ready');
  assert.strictEqual(ready[0].connected.length, 1, 'ready 中应包含 1 个已连接设备');
  assert.strictEqual(ready[0].connected[0].name, 'TestPhone');
  assert.strictEqual(ready[0].pairedCount, 2, 'ready 中应记录 2 个已配对设备');

  const kinds = changes.map(function (e) { return e.kind + ':' + (e.device.name || e.device.address); });
  assert.deepStrictEqual(kinds, [
    'connected:NewHeadset',
    'disconnected:TestPhone',
    'paired:NewPair',
  ]);

  const connected = changes[0];
  assert.strictEqual(connected.device.address, '112233445566');
  assert.strictEqual(connected.device.mac, '11:22:33:44:55:66');
  assert.strictEqual(connected.device.kind, 'le');

  assert.strictEqual(status.running, true);
  assert.strictEqual(status.connected.length, 1, '断开后应只剩 1 个已连接设备');

  try { fs.rmSync(stateDir, { recursive: true, force: true }); } catch (err) { /* 忽略 */ }
  delete process.env.BT_ANIM_WATCH_SCRIPT;
  delete process.env.BT_ANIM_STATE_DIR;
});
