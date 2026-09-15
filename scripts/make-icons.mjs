// Generates the PNG app icons (same design as public/icon.svg) with no dependencies.
// Usage: node scripts/make-icons.mjs
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const BRAND = [0x2f, 0x6f, 0x5e];
const WHITE = [0xff, 0xff, 0xff];

function crc32(buf) {
  let c = ~0;
  for (const byte of buf) {
    c ^= byte;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

function png(size, rounded) {
  const s = size / 512;
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const px = (x + 0.5) / s;
      const py = (y + 0.5) / s;
      let color = BRAND;
      let alpha = 255;
      if (rounded) {
        const r = 112;
        const cx = Math.min(Math.max(px, r), 512 - r);
        const cy = Math.min(Math.max(py, r), 512 - r);
        if (Math.hypot(px - cx, py - cy) > r) alpha = 0;
      }
      const d = Math.hypot(px - 256, py - 256);
      if (Math.abs(d - 150) <= 18) color = WHITE;
      if (px >= 236 && px <= 276 && py >= 166 && py <= 346) color = WHITE;
      const i = y * (size * 4 + 1) + 1 + x * 4;
      raw[i] = color[0];
      raw[i + 1] = color[1];
      raw[i + 2] = color[2];
      raw[i + 3] = alpha;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// iOS applies its own corner mask, and maskable icons need a full-bleed square.
writeFileSync('public/icon-180.png', png(180, false));
writeFileSync('public/icon-192.png', png(192, true));
writeFileSync('public/icon-512.png', png(512, false));
console.log('Wrote public/icon-180.png, icon-192.png, icon-512.png');
