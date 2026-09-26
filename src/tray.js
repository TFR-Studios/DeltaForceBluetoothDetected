'use strict';
/**
 * 系统托盘：随时测试播放、重新扫描、暂停监听、退出。
 */
const { Tray, Menu, nativeImage, shell } = require('electron');

function createAppTray(options) {
  const opts = options || {};
  let icon = nativeImage.createFromPath(opts.iconPath);
  if (icon.isEmpty()) icon = nativeImage.createEmpty();
  else if (process.platform === 'win32') icon = icon.resize({ width: 16, height: 16 });

  const tray = new Tray(icon);
  tray.setToolTip(opts.title || 'bt-anim 蓝牙动画悬浮层');

  function rebuild() {
    const state = opts.getState ? opts.getState() : {};
    const menu = Menu.buildFromTemplate([
      { label: state.title || 'bt-anim', enabled: false },
      { label: state.detail || '', enabled: false },
      { type: 'separator' },
      { label: '立即播放测试动画', click: function () { opts.onTest(); } },
      { label: '重新扫描附近设备', click: function () { opts.onScan(); } },
      { label: state.paused ? '恢复监听' : '暂停监听', click: function () { opts.onTogglePause(); } },
      { type: 'separator' },
      { label: '打开状态目录', click: function () { shell.openPath(opts.stateDir); } },
      { label: '退出 bt-anim', click: function () { opts.onQuit(); } },
    ]);
    tray.setContextMenu(menu);
  }

  tray.on('double-click', function () { opts.onTest(); });
  rebuild();

  return {
    update: rebuild,
    destroy: function () { try { tray.destroy(); } catch (err) { /* 忽略 */ } },
  };
}

module.exports = { createAppTray };
