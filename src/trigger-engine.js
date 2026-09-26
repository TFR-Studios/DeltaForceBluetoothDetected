'use strict';
/**
 * 触发引擎：把传感器事件聚合成“一次播放”。
 * - 批量窗口：把几乎同时发生的事件合成一次播放
 * - 冷却时间：避免连续刷屏
 * - 播放中再次触发：restart / ignore / queue
 */
const { EventEmitter } = require('events');

const KIND_LABEL = {
  connected: '设备已连接',
  disconnected: '设备已断开',
  paired: '发现新配对设备',
  discovered: '扫描到新设备',
};

function deviceKey(device) {
  if (device && device.address) return 'addr:' + device.address;
  if (device && device.name) return 'name:' + device.name.toLowerCase();
  return 'unknown';
}

function createTriggerEngine(config, log) {
  const emitter = new EventEmitter();
  const cfg = config || {};
  const triggers = cfg.triggers || {};
  const state = {
    seq: 0,
    pending: [],
    batchTimer: null,
    cooldownTimer: null,
    lastPlayAt: 0,
    playing: null,
    played: 0,
    lastPayload: null,
  };

  function flush() {
    state.batchTimer = null;
    if (!state.pending.length) return;
    const elapsed = Date.now() - state.lastPlayAt;
    const wait = Math.max(0, (cfg.cooldownMs || 0) - elapsed);
    if (wait > 0) {
      if (!state.cooldownTimer) {
        log.debug('冷却中，' + wait + 'ms 后播放');
        state.cooldownTimer = setTimeout(function () {
          state.cooldownTimer = null;
          flush();
        }, wait);
      }
      return;
    }

    const batch = state.pending;
    state.pending = [];
    const seen = new Set();
    const devices = [];
    batch.forEach(function (item) {
      const key = deviceKey(item.device);
      if (seen.has(key)) return;
      seen.add(key);
      devices.push(item.device);
    });
    if (!devices.length) return;

    const kinds = [];
    batch.forEach(function (item) { if (kinds.indexOf(item.kind) < 0) kinds.push(item.kind); });
    const kind = kinds[0];

    state.seq++;
    state.played++;
    state.lastPlayAt = Date.now();
    const payload = {
      id: state.seq,
      kind: kind,
      kinds: kinds,
      label: KIND_LABEL[kind] || kind,
      devices: devices,
      count: devices.length,
      name: devices.length === 1 ? (devices[0].name || devices[0].mac || '蓝牙设备') : (devices.length + ' 个蓝牙设备'),
      at: new Date().toISOString(),
      forced: !!batch[0].forced,
    };
    state.lastPayload = payload;
    log.info('播放动画：' + payload.label + ' - ' + payload.name);
    emitter.emit('play', payload);
  }

  function schedule() {
    if (state.batchTimer) clearTimeout(state.batchTimer);
    state.batchTimer = setTimeout(flush, Math.max(0, cfg.batchWindowMs || 0));
    if (state.batchTimer.unref) state.batchTimer.unref();
  }

  emitter.push = function (event) {
    if (!event || !event.kind) return false;
    if (!triggers[event.kind]) {
      log.debug('事件 ' + event.kind + ' 未开启，忽略');
      return false;
    }
    state.pending.push({ kind: event.kind, device: event.device, at: event.at, forced: false });
    schedule();
    return true;
  };

  emitter.triggerNow = function (options) {
    const opts = options || {};
    const device = opts.device || {
      address: 'DEMO00000000',
      mac: 'DE:MO:00:00:00:00',
      name: opts.name || '演示设备',
      kind: 'demo',
    };
    state.pending.push({ kind: opts.kind || 'connected', device: device, at: new Date(), forced: true });
    flush();
  };

  emitter.onPlaybackStart = function (payload) {
    state.playing = payload ? payload.id : null;
  };

  emitter.onPlaybackEnd = function () {
    state.playing = null;
  };

  emitter.status = function () {
    return {
      played: state.played,
      pending: state.pending.length,
      playing: state.playing,
      lastPlayAt: state.lastPlayAt ? new Date(state.lastPlayAt).toISOString() : null,
      last: state.lastPayload,
      cooldownMs: cfg.cooldownMs,
      batchWindowMs: cfg.batchWindowMs,
      triggers: triggers,
    };
  };

  emitter.dispose = function () {
    if (state.batchTimer) clearTimeout(state.batchTimer);
    if (state.cooldownTimer) clearTimeout(state.cooldownTimer);
  };

  return emitter;
}

module.exports = { createTriggerEngine, KIND_LABEL };
