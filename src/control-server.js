'use strict';
/**
 * 本地控制接口（仅监听 127.0.0.1），供 CLI / 脚本调用。
 */
const http = require('http');
const crypto = require('crypto');

function readBody(req) {
  return new Promise(function (resolve) {
    let raw = '';
    req.on('data', function (chunk) {
      raw += chunk;
      if (raw.length > 1024 * 100) req.destroy();
    });
    req.on('end', function () {
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch (err) { resolve({ raw: raw }); }
    });
    req.on('error', function () { resolve({}); });
  });
}

function send(res, status, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

/**
 * handlers: { status, trigger, scan, pause, resume, quit }
 */
function createControlServer(options) {
  const opts = options || {};
  const token = opts.token || crypto.randomBytes(16).toString('hex');
  const log = opts.log;
  let server = null;
  let boundPort = null;

  function authorized(req, url) {
    const header = req.headers['x-bt-anim-token'];
    if (header && header === token) return true;
    if (url.searchParams.get('token') === token) return true;
    return false;
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://127.0.0.1');
    const route = url.pathname.replace(/\/+$/, '') || '/';

    if (!authorized(req, url)) {
      send(res, 401, { ok: false, error: 'unauthorized' });
      return;
    }
    const method = req.method || 'GET';
    try {
      if (route === '/' || route === '/status') {
        send(res, 200, { ok: true, data: await opts.handlers.status() });
        return;
      }
      if (method !== 'POST') {
        send(res, 405, { ok: false, error: 'method not allowed' });
        return;
      }
      const body = await readBody(req);
      if (route === '/trigger') {
        await opts.handlers.trigger(body);
        send(res, 200, { ok: true, data: { triggered: true } });
        return;
      }
      if (route === '/scan') {
        const result = await opts.handlers.scan(body);
        send(res, 200, { ok: true, data: result });
        return;
      }
      if (route === '/capture') {
        const result = await opts.handlers.capture();
        send(res, 200, { ok: true, data: result });
        return;
      }
      if (route === '/pause') { await opts.handlers.pause(); send(res, 200, { ok: true, data: { paused: true } }); return; }
      if (route === '/resume') { await opts.handlers.resume(); send(res, 200, { ok: true, data: { paused: false } }); return; }
      if (route === '/quit') {
        send(res, 200, { ok: true, data: { quitting: true } });
        setTimeout(function () { opts.handlers.quit(); }, 60);
        return;
      }
      send(res, 404, { ok: false, error: 'not found' });
    } catch (err) {
      log.warn('控制接口出错: ' + (err && err.stack ? err.stack : err));
      send(res, 500, { ok: false, error: String((err && err.message) || err) });
    }
  }

  return {
    token: token,
    start: function () {
      return new Promise(function (resolve, reject) {
        server = http.createServer(function (req, res) {
          handle(req, res).catch(function (err) {
            try { send(res, 500, { ok: false, error: String(err && err.message) }); } catch (e) { /* 忽略 */ }
          });
        });
        server.on('error', reject);
        const preferred = Number(opts.port) || 0;
        server.listen(preferred, '127.0.0.1', function () {
          boundPort = server.address().port;
          log.debug('控制接口监听 127.0.0.1:' + boundPort);
          resolve(boundPort);
        });
      });
    },
    port: function () { return boundPort; },
    stop: function () {
      if (server) {
        try { server.close(); } catch (err) { /* 忽略 */ }
        server = null;
      }
    },
  };
}

module.exports = { createControlServer };
