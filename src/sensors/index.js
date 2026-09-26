'use strict';
/**
 * 传感器工厂：按平台选择实现。统一事件：
 *   'ready'      -> { platform, engine, connected:[], paired:[] }
 *   'change'     -> { kind:'connected'|'disconnected'|'paired', device:{...} }
 *   'discovered' -> { kind:'discovered', device:{...} }
 *   'error'      -> Error
 *   'status'     -> {...}
 */
const { EventEmitter } = require('events');

function createNullSensor(reason) {
  const emitter = new EventEmitter();
  emitter.platform = process.platform;
  emitter.supported = false;
  emitter.reason = reason;
  emitter.start = function () {
    emitter.emit('ready', { platform: process.platform, engine: 'none', connected: [], paired: [] });
    emitter.emit('error', new Error(reason));
  };
  emitter.stop = function () {};
  emitter.scanNow = function () { return Promise.resolve([]); };
  emitter.status = function () { return { supported: false, reason: reason }; };
  return emitter;
}

function createSensor(config, log) {
  if (process.platform === 'win32') {
    return require('./win32').createWindowsSensor(config, log);
  }
  if (process.platform === 'darwin') {
    return require('./darwin').createDarwinSensor(config, log);
  }
  if (process.platform === 'linux') {
    return require('./linux').createLinuxSensor(config, log);
  }
  return createNullSensor('当前系统（' + process.platform + '）暂不支持蓝牙监听');
}

module.exports = { createSensor, createNullSensor };
