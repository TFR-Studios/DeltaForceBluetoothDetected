'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { loadAnimation, prepareAnimation, resolveSegment, estimateDurationMs } = require('../src/shared/animation');

const ANIM_DIR = path.join(__dirname, '..', 'animation');
const hasAnimation = fs.existsSync(path.join(ANIM_DIR, 'data.json'));

function cfg(patch) {
  return Object.assign({
    animation: {
      dir: ANIM_DIR, file: 'data.json', fromFrame: null, toFrame: null, speed: 1,
      counter: false, textMode: 'original', caption: false, font: null,
    },
  }, patch || {});
}

test('loadAnimation 读取动画元信息', { skip: !hasAnimation }, function () {
  const loaded = loadAnimation(cfg());
  assert.strictEqual(loaded.width, 1920);
  assert.strictEqual(loaded.height, 1080);
  assert.ok(loaded.fps > 0);
  assert.ok(loaded.op > loaded.ip);
});

test('prepareAnimation 把图片资源指向自定义协议', { skip: !hasAnimation }, function () {
  const loaded = loadAnimation(cfg());
  const prepared = prepareAnimation(loaded, cfg(), { assetBase: 'btanim://app/anim/' });
  assert.ok(prepared.data.assets.length > 0);
  prepared.data.assets.forEach(function (asset) {
    assert.ok(asset.u.indexOf('btanim://app/anim/') === 0, '资源前缀应被改写: ' + asset.u);
  });
});

test('prepareAnimation 能识别数字文本图层（用于显示设备数量）', { skip: !hasAnimation }, function () {
  const loaded = loadAnimation(cfg());
  const prepared = prepareAnimation(loaded, cfg(), {});
  assert.ok(prepared.counterLayers.length >= 1, '应至少识别出一个数字图层');
  prepared.counterLayers.forEach(function (layer) {
    assert.match(String(layer.nm), /^[0-9]+$/);
  });
});

test('textMode=bt 时替换画面文案', { skip: !hasAnimation }, function () {
  const loaded = loadAnimation(cfg());
  const prepared = prepareAnimation(loaded, cfg({ animation: Object.assign({}, cfg().animation, { textMode: 'bt' }) }), {});
  const texts = [];
  prepared.data.layers.forEach(function (layer) {
    if (layer.ty !== 5) return;
    ((layer.t && layer.t.d && layer.t.d.k) || []).forEach(function (doc) {
      if (doc && doc.s && doc.s.t) texts.push(doc.s.t);
    });
  });
  assert.ok(texts.indexOf('附近蓝牙设备') >= 0, '应替换为蓝牙文案');
  assert.ok(texts.indexOf('附近敌人') < 0, '原始文案应被替换');
});

test('字体回退会拼接原字体名', { skip: !hasAnimation }, function () {
  const loaded = loadAnimation(cfg());
  const prepared = prepareAnimation(loaded, cfg({ animation: Object.assign({}, cfg().animation, { font: 'Microsoft YaHei' }) }), {});
  const list = prepared.data.fonts.list;
  assert.ok(list.length > 0);
  assert.ok(list[0].fFamily.indexOf('Microsoft YaHei') === 0);
});

test('resolveSegment / estimateDurationMs 计算播放区间', { skip: !hasAnimation }, function () {
  const loaded = loadAnimation(cfg());
  const seg = resolveSegment(loaded, cfg());
  assert.strictEqual(seg.from, loaded.ip);
  assert.strictEqual(seg.to, loaded.op);

  const limited = resolveSegment(loaded, cfg({ animation: Object.assign({}, cfg().animation, { fromFrame: 100, toFrame: 400 }) }));
  assert.deepStrictEqual(limited, { from: 100, to: 400 });

  const full = estimateDurationMs(loaded, cfg());
  const half = estimateDurationMs(loaded, cfg({ animation: Object.assign({}, cfg().animation, { speed: 2 }) }));
  assert.ok(Math.abs(half - full / 2) < 40, '倍速应减半时长');
});
