'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const { parseArgs, deepMerge, parseKindList, DEFAULTS } = require('../src/shared/config');

test('parseArgs 解析命令与常用参数', function () {
  const parsed = parseArgs(['start', '--test', '--cooldown', '2500', '--only', 'connected,paired', '--scan-interval', '30']);
  assert.strictEqual(parsed.command, 'start');
  assert.strictEqual(parsed.patch.playOnStart, true);
  assert.strictEqual(parsed.patch.cooldownMs, 2500);
  assert.strictEqual(parsed.patch.scan.intervalMs, 30000);
  assert.deepStrictEqual(parsed.patch.triggers, {
    connected: true, disconnected: false, paired: true, discovered: false,
  });
  assert.deepStrictEqual(parsed.errors, []);
});

test('parseArgs 支持 --key=value 与布尔取反', function () {
  const parsed = parseArgs(['--speed=1.5', '--no-tray', '--opacity', '0.8']);
  assert.strictEqual(parsed.patch.animation.speed, 1.5);
  assert.strictEqual(parsed.patch.window.tray, false);
  assert.strictEqual(parsed.patch.window.opacity, 0.8);
});

test('parseArgs 对未知参数与缺失值给出错误', function () {
  const parsed = parseArgs(['--nope', '--cooldown']);
  assert.strictEqual(parsed.errors.length, 2);
  assert.match(parsed.errors[0], /未知参数/);
  assert.match(parsed.errors[1], /需要一个值/);
});

test('parseKindList 支持别名 all / device', function () {
  assert.deepStrictEqual(parseKindList('all'), {
    connected: true, disconnected: true, paired: true, discovered: true,
  });
  assert.deepStrictEqual(parseKindList('device'), {
    connected: true, disconnected: false, paired: true, discovered: true,
  });
  assert.throws(function () { parseKindList('nope'); }, /未知的事件类型/);
});

test('deepMerge 递归合并且不修改原对象', function () {
  const base = { a: 1, nested: { x: 1, y: 2 }, list: [1, 2] };
  const merged = deepMerge(base, { nested: { y: 9 }, list: [3] });
  assert.strictEqual(merged.a, 1);
  assert.strictEqual(merged.nested.x, 1);
  assert.strictEqual(merged.nested.y, 9);
  assert.deepStrictEqual(merged.list, [3]);
  assert.strictEqual(base.nested.y, 2);
});

test('默认配置包含四类事件开关', function () {
  assert.deepStrictEqual(Object.keys(DEFAULTS.triggers).sort(), ['connected', 'disconnected', 'discovered', 'paired']);
  assert.strictEqual(DEFAULTS.triggers.connected, true);
  assert.strictEqual(DEFAULTS.scan.enabled, true);
});
