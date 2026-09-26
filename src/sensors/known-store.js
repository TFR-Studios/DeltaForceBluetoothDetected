'use strict';
/**
 * 已见过的设备记录（用于“扫描到新设备”去重）。
 */
const { knownFile, readJson, writeJson } = require('../shared/paths');

function createKnownStore(options) {
  const opts = options || {};
  const file = opts.file || knownFile();
  const data = readJson(file, null) || { version: 1, discovered: {}, paired: {} };
  if (!data.discovered) data.discovered = {};
  if (!data.paired) data.paired = {};
  let dirty = false;
  let lastSave = 0;

  function save(force) {
    const now = Date.now();
    if (!force && now - lastSave < 5000) return;
    lastSave = now;
    dirty = false;
    try {
      writeJson(file, data);
    } catch (err) { /* 无法写入时忽略，仅影响记忆功能 */ }
  }

  return {
    file: file,
    has(key) { return Object.prototype.hasOwnProperty.call(data.discovered, key); },
    get(key) { return data.discovered[key] || null; },
    remember(key, info) {
      data.discovered[key] = Object.assign({ firstSeen: new Date().toISOString() }, info || {});
      dirty = true;
      save(false);
    },
    touch(key) {
      const entry = data.discovered[key];
      if (!entry) return;
      entry.lastSeen = new Date().toISOString();
      dirty = true;
      save(false);
    },
    forget(key) {
      delete data.discovered[key];
      save(true);
    },
    size() { return Object.keys(data.discovered).length; },
    all() { return data.discovered; },
    flush() { if (dirty) save(true); else save(true); },
  };
}

module.exports = { createKnownStore };
