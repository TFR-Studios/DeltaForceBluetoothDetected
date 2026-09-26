'use strict';
/**
 * 读取 Lottie 动画并生成运行时数据（文本替换 / 字体回退 / 资源地址）。
 */
const fs = require('fs');
const path = require('path');
const { appRoot } = require('./paths');

const TEXT_MAP_BT = {
  '附近敌人': '附近蓝牙设备',
  '敌方干员信号数': '新设备信号数',
};

function resolveAnimationDir(config) {
  const dir = (config && config.animation && config.animation.dir) || path.join(appRoot(), 'animation');
  return path.resolve(dir);
}

function loadAnimation(config) {
  const dir = resolveAnimationDir(config);
  const file = path.join(dir, (config.animation && config.animation.file) || 'data.json');
  const raw = fs.readFileSync(file, 'utf8');
  const data = JSON.parse(raw);
  const fps = data.fr || 60;
  const ip = typeof data.ip === 'number' ? data.ip : 0;
  const op = typeof data.op === 'number' ? data.op : fps * 5;
  return {
    dir: dir,
    file: file,
    data: data,
    fps: fps,
    ip: ip,
    op: op,
    width: data.w || 1920,
    height: data.h || 1080,
    durationMs: Math.round(((op - ip) / fps) * 1000),
  };
}

function isDigits(value) {
  return !!value && /^[0-9]+$/.test(String(value).trim());
}

/** 在原始动画数据上做静态改写（文本/字体/资源地址），返回新的对象。 */
function prepareAnimation(loaded, config, options) {
  const opts = options || {};
  const data = JSON.parse(JSON.stringify(loaded.data));
  const animCfg = (config && config.animation) || {};
  const counterLayers = [];

  if (animCfg.font && Array.isArray(data.fonts && data.fonts.list)) {
    data.fonts.list.forEach(function (font) {
      const original = font.fFamily || '';
      font.fFamily = original ? animCfg.font + ', ' + original : animCfg.font;
    });
  }

  const strip = process.env.BT_ANIM_STRIP || '';
  if (strip) {
    (data.layers || []).forEach(function (layer) {
      if (strip.indexOf('masks') >= 0 && layer.hasMask) {
        layer.hasMask = false;
        delete layer.masksProperties;
      }
      if (strip.indexOf('effects') >= 0 && layer.ef) delete layer.ef;
    });
  }

  (data.layers || []).forEach(function (layer) {
    if (layer.ty === 5 && isDigits(layer.nm)) counterLayers.push({ ind: layer.ind, nm: layer.nm });
    if (layer.ty === 5 && animCfg.textMode === 'bt') {
      const docs = (layer.t && layer.t.d && layer.t.d.k) || [];
      docs.forEach(function (doc) {
        if (doc && doc.s && typeof doc.s.t === 'string' && TEXT_MAP_BT[doc.s.t]) {
          doc.s.t = TEXT_MAP_BT[doc.s.t];
        }
      });
    }
  });

  const baseUrl = opts.assetBase || 'btanim://app/anim/';
  const inlineAssets = opts.inlineAssets || process.env.BT_ANIM_INLINE === '1';
  (data.assets || []).forEach(function (asset) {
    if (!asset || asset.p === undefined) return;
    if (/^(https?:|data:)/i.test(asset.p)) return;
    const prefix = asset.u || '';
    if (inlineAssets && !/^https?:/i.test(prefix)) {
      try {
        const file = path.join(loaded.dir, prefix + asset.p);
        const buffer = fs.readFileSync(file);
        const ext = path.extname(file).toLowerCase();
        const mime = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : ext === '.webp' ? 'image/webp' : 'image/png';
        asset.p = 'data:' + mime + ';base64,' + buffer.toString('base64');
        asset.u = '';
        return;
      } catch (err) {
        // 读取失败时回退到协议地址
      }
    }
    asset.u = baseUrl + prefix;
  });

  return {
    data: data,
    counterLayers: counterLayers,
    durationMs: Math.round(((loaded.op - loaded.ip) / loaded.fps) * 1000),
    width: loaded.width,
    height: loaded.height,
    fps: loaded.fps,
    ip: loaded.ip,
    op: loaded.op,
  };
}

/** 播放区间（帧） */
function resolveSegment(loaded, config) {
  const animCfg = (config && config.animation) || {};
  let from = animCfg.fromFrame;
  let to = animCfg.toFrame;
  if (from === null || from === undefined) from = loaded.ip;
  if (to === null || to === undefined) to = loaded.op;
  from = Math.max(loaded.ip, Math.min(loaded.op, Number(from)));
  to = Math.max(from + 1, Math.min(loaded.op, Number(to)));
  return { from: from, to: to };
}

function estimateDurationMs(loaded, config) {
  const seg = resolveSegment(loaded, config);
  const speed = Math.max(0.1, Number((config.animation && config.animation.speed) || 1));
  return Math.round((((seg.to - seg.from) / loaded.fps) * 1000) / speed);
}

module.exports = {
  loadAnimation,
  prepareAnimation,
  resolveSegment,
  estimateDurationMs,
  resolveAnimationDir,
  TEXT_MAP_BT,
};
