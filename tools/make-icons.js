'use strict';
/**
 * 生成托盘 / 应用图标（纯 Node，无需任何依赖）。
 * 图形：琥珀色蓝牙标志 + 外发光。
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const CRC_TABLE = (function () {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function encodePng(width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function distToSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lenSq = dx * dx + dy * dy;
  let t = lenSq === 0 ? 0 : ((px - x1) * dx + (py - y1) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  const cx = x1 + t * dx;
  const cy = y1 + t * dy;
  return Math.hypot(px - cx, py - cy);
}

// 蓝牙标志（0..1 坐标系）
const SEGMENTS = [
  [0.50, 0.08, 0.50, 0.92],
  [0.50, 0.08, 0.78, 0.30],
  [0.78, 0.30, 0.26, 0.68],
  [0.50, 0.92, 0.78, 0.70],
  [0.78, 0.70, 0.26, 0.32],
];

function render(size) {
  const rgba = Buffer.alloc(size * size * 4);
  const stroke = size * 0.075;
  const glow = size * 0.20;
  const samples = 4;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let core = 0;
      let halo = 0;
      for (let sy = 0; sy < samples; sy++) {
        for (let sx = 0; sx < samples; sx++) {
          const px = (x + (sx + 0.5) / samples) / size;
          const py = (y + (sy + 0.5) / samples) / size;
          let best = Infinity;
          for (const s of SEGMENTS) {
            const d = distToSegment(px, py, s[0], s[1], s[2], s[3]);
            if (d < best) best = d;
          }
          const dist = best * size;
          if (dist <= stroke / 2) core += 1;
          else if (dist <= glow) halo += Math.max(0, 1 - (dist - stroke / 2) / (glow - stroke / 2));
        }
      }
      const total = samples * samples;
      const coreA = core / total;
      const haloA = halo / total;
      const alpha = Math.min(1, coreA + haloA * 0.55);
      const index = (y * size + x) * 4;
      if (alpha <= 0.004) continue;
      const warm = Math.min(1, coreA * 1.15);
      rgba[index] = Math.round(255 * (0.72 + 0.28 * warm));
      rgba[index + 1] = Math.round(255 * (0.55 + 0.31 * warm));
      rgba[index + 2] = Math.round(255 * (0.18 + 0.20 * warm));
      rgba[index + 3] = Math.round(255 * Math.min(1, alpha));
    }
  }
  return rgba;
}

function write(file, size) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, encodePng(size, size, render(size)));
  return file;
}

if (require.main === module) {
  const assets = path.resolve(__dirname, '..', 'assets');
  console.log('生成 ' + write(path.join(assets, 'tray.png'), 32));
  console.log('生成 ' + write(path.join(assets, 'icon.png'), 256));
}

module.exports = { encodePng, render, write };
