#!/usr/bin/env node
'use strict';
/**
 * 安装后钩子：尽力把 Electron 二进制准备好。
 * 失败不报错（真正的兜底在 bin/bt-anim.js 启动时）。
 */
const { binaryInPackage, ensureElectron } = require('../src/shared/electron-bootstrap');

function main() {
  if (process.env.BT_ANIM_SKIP_POSTINSTALL) return;
  try {
    const path = require.resolve('electron/package.json');
    const dir = require('path').dirname(path);
    if (binaryInPackage(dir)) return;
    console.log('[bt-anim] 正在准备 Electron 运行时…');
    ensureElectron({ log: function (m) { console.log('[bt-anim] ' + m); } });
    console.log('[bt-anim] Electron 就绪。');
  } catch (err) {
    console.log('[bt-anim] Electron 尚未就绪（' + err.message.split('\n')[0] + '）');
    console.log('[bt-anim] 首次运行 bt-anim 时会自动重试下载。');
  }
}

main();
