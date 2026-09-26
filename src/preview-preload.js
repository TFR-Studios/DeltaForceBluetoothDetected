'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('preview', {
  onInit: function (cb) { ipcRenderer.on('preview:init', function (_e, p) { cb(p); }); },
  onFrame: function (cb) { ipcRenderer.on('preview:frame', function (_e, p) { cb(p); }); },
  ready: function () { ipcRenderer.send('preview:ready'); },
});
