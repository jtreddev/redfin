// Draws the app's PNG icons from the same mark as public/icon.svg (the month ribbon in miniature, in the
// accent on paper). A dev-only tool; nothing at runtime uses it.
//
// Usage, from the project folder:  node scripts/make-icons.mjs
//
// It renders with sharp, which is already in node_modules as a dependency of the Cloudflare dev tooling
// (miniflare). sharp is deliberately not listed in package.json. If it's ever missing, install it for the
// one run without saving it:  npm install --no-save sharp  &&  node scripts/make-icons.mjs
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const sharp = createRequire(join(root, 'package.json'))('sharp');

const PAPER = '#fbfcfd';
const ACCENT = '#3f4aa6';
// Keep in step with public/icon.svg and the side-menu Mark in src/client/App.tsx.
const MARK = `
  <rect x="92" y="214" width="164" height="84" rx="18" fill="${ACCENT}"/>
  <rect x="268" y="214" width="76" height="84" rx="18" fill="${ACCENT}" fill-opacity="0.7"/>
  <rect x="356" y="214" width="30" height="84" rx="12" fill="${ACCENT}" fill-opacity="0.45"/>
  <rect x="398" y="164" width="24" height="184" rx="12" fill="${ACCENT}"/>`;

// Full-bleed paper squares (the OS applies its own mask). The maskable one shrinks the mark to stay well
// inside the central 80% safe zone.
const square = (scale) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512" fill="${PAPER}"/>` +
  `<g transform="translate(256 256) scale(${scale}) translate(-256 -256)">${MARK}</g></svg>`;

for (const [name, size, scale] of [
  ['icon-180.png', 180, 1],
  ['icon-192.png', 192, 1],
  ['icon-512.png', 512, 1],
  ['icon-maskable-512.png', 512, 0.78],
]) {
  const png = await sharp(Buffer.from(square(scale)), { density: ((72 * size) / 512) * 4 })
    .resize(size, size)
    .flatten({ background: PAPER })
    .png({ compressionLevel: 9 })
    .toBuffer();
  writeFileSync(join(root, 'public', name), png);
  console.log(`public/${name}`, png.length, 'bytes');
}
