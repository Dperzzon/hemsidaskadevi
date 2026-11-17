// Skapar små miniatyrer (160x160) för startsidans bildgalleri. Miniatyrerna
// visas i 60 px cirklar (44/36/32 px på mindre skärmar) och originalet på
// 800x600 behöver därför inte laddas elva gånger. Kör vid behov:
// node scripts/generate-gallery-thumbs.mjs
import sharp from 'sharp';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dir = path.join(root, 'public', 'images', 'gallery');

const names = [
  'kok-open-spis',
  'vardagsrum',
  'blommigt-rum',
  'svart-badrum',
  'gront-badrum',
  'dukning-langbord',
  'dukning-pergola',
  'mohippa-pergola',
  'tennisplan',
  'biljardbord',
  'badtunna'
];

await mkdir(dir, { recursive: true });
for (const name of names) {
  const output = path.join(dir, `${name}-thumb.webp`);
  const info = await sharp(path.join(dir, `${name}.webp`))
    .resize(160, 160, { fit: 'cover', kernel: 'lanczos3' })
    .webp({ quality: 70, smartSubsample: true })
    .toFile(output);
  console.log(`${name}-thumb.webp (${info.width}x${info.height}, ${(info.size / 1024).toFixed(0)} kB)`);
}
