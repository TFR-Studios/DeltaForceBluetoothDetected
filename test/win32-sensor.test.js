'use strict';
const test = require('node:test');
const assert = require('node:assert');

const { normalizeDevice, normalizeAddress, prettyAddress, label } = require('../src/sensors/win32');

test('normalizeAddress 处理各种写法', function () {
  assert.strictEqual(normalizeAddress('4c43f65c13ab'), '4C43F65C13AB');
  assert.strictEqual(normalizeAddress('4C:43:F6:5C:13:AB'), '4C43F65C13AB');
  assert.strictEqual(normalizeAddress(''), '');
});

test('prettyAddress 还原成 MAC 写法', function () {
  assert.strictEqual(prettyAddress('4c43f65c13ab'), '4C:43:F6:5C:13:AB');
  assert.strictEqual(prettyAddress('bad'), 'bad');
});

test('normalizeDevice 归一化传感器输出', function () {
  const device = normalizeDevice({ address: 'e4aae46704f6', name: '  Redmi K70 ', kind: 'classic', status: 'Started' });
  assert.strictEqual(device.address, 'E4AAE46704F6');
  assert.strictEqual(device.mac, 'E4:AA:E4:67:04:F6');
  assert.strictEqual(device.name, 'Redmi K70');
  assert.strictEqual(device.kind, 'classic');
});

test('label 在没有名称时回落到 MAC', function () {
  assert.strictEqual(label({ name: 'DualSense', mac: '14:3A:9A:CE:3B:CB' }), 'DualSense');
  assert.strictEqual(label({ name: '', mac: '14:3A:9A:CE:3B:CB' }), '蓝牙设备 14:3A:9A:CE:3B:CB');
});
