'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('btAnim', {
  ready: function () { ipcRenderer.send('overlay:ready'); },
  onInit: function (cb) { ipcRenderer.on('overlay:init', function (_e, payload) { cb(payload); }); },
  onPlay: function (cb) { ipcRenderer.on('overlay:play', function (_e, payload) { cb(payload); }); },
  onStop: function (cb) { ipcRenderer.on('overlay:stop', function (_e, payload) { cb(payload); }); },
  done: function (payload) { ipcRenderer.send('overlay:done', payload); },
  log: function (message, extra) { ipcRenderer.send('overlay:log', { message: message, extra: extra }); },
});
