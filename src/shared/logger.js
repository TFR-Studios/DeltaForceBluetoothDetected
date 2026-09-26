'use strict';
/**
 * 极简日志器：带时间戳与级别，可选写入状态目录下的日志文件。
 */
const fs = require('fs');
const path = require('path');
const { logDir, ensureDir } = require('./paths');

const LEVELS = { silent: 0, error: 1, warn: 2, info: 3, debug: 4 };

function createLogger(options) {
  const opts = options || {};
  const level = LEVELS[opts.level] === undefined ? LEVELS.info : LEVELS[opts.level];
  let stream = null;

  if (opts.file) {
    try {
      const dir = ensureDir(logDir());
      const file = path.join(dir, 'bt-anim.log');
      try {
        const st = fs.statSync(file);
        if (st.size > 2 * 1024 * 1024) fs.truncateSync(file, 0);
      } catch (err) { /* 文件不存在则忽略 */ }
      stream = fs.createWriteStream(file, { flags: 'a' });
    } catch (err) {
      stream = null;
    }
  }

  function write(name, args) {
    if (LEVELS[name] > level) return;
    const line = '[' + new Date().toISOString() + '] [' + name.toUpperCase() + '] ' +
      args.map(function (a) {
        if (typeof a === 'string') return a;
        if (a instanceof Error) return a.stack || a.message;
        try { return JSON.stringify(a); } catch (err) { return String(a); }
      }).join(' ');
    if (name === 'error' || name === 'warn') process.stderr.write(line + '\n');
    else process.stdout.write(line + '\n');
    if (stream) stream.write(line + '\n');
  }

  return {
    level: opts.level || 'info',
    file: stream ? path.join(logDir(), 'bt-anim.log') : null,
    error: function () { write('error', Array.prototype.slice.call(arguments)); },
    warn: function () { write('warn', Array.prototype.slice.call(arguments)); },
    info: function () { write('info', Array.prototype.slice.call(arguments)); },
    debug: function () { write('debug', Array.prototype.slice.call(arguments)); },
    close: function () { if (stream) stream.end(); },
  };
}

module.exports = { createLogger, LEVELS };
