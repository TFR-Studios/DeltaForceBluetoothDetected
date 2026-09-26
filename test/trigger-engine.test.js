'use strict';
const test = require('node:test');
const assert = require('node:assert');

const { createTriggerEngine } = require('../src/trigger-engine');

const silent = { error: function () {}, warn: function () {}, info: function () {}, debug: function () {} };

function config(patch) {
  return Object.assign({
    triggers: { connected: true, disconnected: false, paired: true, discovered: true },
    cooldownMs: 0,
    batchWindowMs: 20,
  }, patch || {});
}

function device(address, name) {
  return { address: address, mac: address, name: name || '' };
}

test('同时发生的多个事件会合并成一次播放并按地址去重', function (t, done) {
  const engine = createTriggerEngine(config(), silent);
  const played = [];
  engine.on('play', function (payload) { played.push(payload); });

  engine.push({ kind: 'connected', device: device('AAAA', '手机') });
  engine.push({ kind: 'connected', device: device('AAAA', '手机') });
  engine.push({ kind: 'connected', device: device('BBBB', '耳机') });

  setTimeout(function () {
    assert.strictEqual(played.length, 1);
    assert.strictEqual(played[0].count, 2);
    assert.strictEqual(played[0].kind, 'connected');
    assert.strictEqual(played[0].name, '2 个蓝牙设备');
    engine.dispose();
    done();
  }, 90);
});

test('未开启的事件类型不会触发播放', function (t, done) {
  const engine = createTriggerEngine(config(), silent);
  let count = 0;
  engine.on('play', function () { count++; });
  assert.strictEqual(engine.push({ kind: 'disconnected', device: device('AAAA') }), false);
  setTimeout(function () {
    assert.strictEqual(count, 0);
    engine.dispose();
    done();
  }, 60);
});

test('冷却时间内的事件会延后播放', function (t, done) {
  const engine = createTriggerEngine(config({ cooldownMs: 120, batchWindowMs: 10 }), silent);
  const times = [];
  engine.on('play', function () { times.push(Date.now()); });

  engine.push({ kind: 'connected', device: device('AAAA', '一') });
  setTimeout(function () { engine.push({ kind: 'connected', device: device('BBBB', '二') }); }, 30);

  setTimeout(function () {
    assert.strictEqual(times.length, 2);
    assert.ok(times[1] - times[0] >= 110, '两次播放间隔应不小于冷却时间，实际 ' + (times[1] - times[0]));
    engine.dispose();
    done();
  }, 400);
});

test('triggerNow 立即播放并标记为强制', function () {
  const engine = createTriggerEngine(config(), silent);
  let payload = null;
  engine.on('play', function (p) { payload = p; });
  engine.triggerNow({ name: '测试设备' });
  assert.ok(payload);
  assert.strictEqual(payload.forced, true);
  assert.strictEqual(payload.name, '测试设备');
  engine.dispose();
});

test('status 汇总播放统计', function () {
  const engine = createTriggerEngine(config(), silent);
  engine.triggerNow({});
  const status = engine.status();
  assert.strictEqual(status.played, 1);
  assert.ok(status.last);
  engine.dispose();
});
