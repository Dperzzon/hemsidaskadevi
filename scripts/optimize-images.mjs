// Optimerar de bilder som webbplatsen använder: transkoder till WebP med
// bibehållen bildstorlek (ingen beskärning), lägger till ASCII-slug-namn och
// skriver resultatet till public/images/. Original i assets/originals/ röras
// inte. Körs vid behov: node scripts/optimize-images.mjs
import sharp from 'sharp';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const sourceDir = path.join(root, 'assets', 'originals');
const outDir = path.join(root, 'public', 'images');

// [källfil, målfil, alternativ]
const jobs = [
  // Favicon + sidhuvudets logotyp (visas max 180 px; 2x-retina → 512 px räcker).
  // PNG med palett behålls för maximal favicon-kompatibilitet.
  ['logo.png', 'logo.png', { palettePng: true, resizeHeight: 512 }],
  ['Startsida.jpeg', 'hero-startsida.webp', { quality: 72 }],
  ['Startsida.jpeg', 'og-startsida.jpg', { jpegQuality: 85 }],
  ['Snygga symboler.png', 'sociala-symboler.webp', { lossless: true, resizeHeight: 500 }],
  ['gallery/Huset logga.png', 'gallery/huset-logga.webp', { lossless: true, resizeHeight: 500 }],
  ['gallery/Kök Öppen Spis Akvarell.jpg', 'gallery/kok-open-spis.webp', { quality: 72 }],
  ['gallery/Vardagsrum Akvarell.jpg', 'gallery/vardagsrum.webp', { quality: 72 }],
  ['gallery/Blommigt Rum Akvarell.jpg', 'gallery/blommigt-rum.webp', { quality: 72 }],
  ['gallery/Svart Badrum Akvarell.jpg', 'gallery/svart-badrum.webp', { quality: 72 }],
  ['gallery/Grönt badrum Akvarell.jpg', 'gallery/gront-badrum.webp', { quality: 72 }],
  ['gallery/Dukning Långbord Inomhus Akvarell.jpg', 'gallery/dukning-langbord.webp', { quality: 72 }],
  ['gallery/Dukning Pergola Akvarell.png', 'gallery/dukning-pergola.webp', { quality: 72 }],
  ['gallery/Möhippa Pergola Akvarell.jpg', 'gallery/mohippa-pergola.webp', { quality: 72 }],
  ['gallery/Tennisplan Akvarell.png', 'gallery/tennisplan.webp', { quality: 72 }],
  ['gallery/Biljardbord akvarell.png', 'gallery/biljardbord.webp', { quality: 72 }],
  ['gallery/Badtunna akvarell.png', 'gallery/badtunna.webp', { quality: 72 }],
  ['gallery/Skadevi Gård.png', 'gallery/skadevi-gard.webp', { quality: 72 }],
  ['gallery/Företag Akvarell.png', 'gallery/foretag-akvarell.webp', { quality: 72 }]
];

await mkdir(path.join(outDir, 'gallery'), { recursive: true });

let before = 0;
let after = 0;
for (const [source, target, options] of jobs) {
  const input = path.join(sourceDir, source);
  let pipeline = sharp(input, { failOn: 'none' });
  const meta = await pipeline.metadata();
  if (options.resizeHeight && meta.height > options.resizeHeight) {
    pipeline = pipeline.resize({ height: options.resizeHeight, kernel: 'lanczos3' });
  }
  const isJpeg = target.endsWith('.jpg');
  const output = isJpeg
    ? await pipeline.jpeg({ quality: options.jpegQuality ?? 85, mozjpeg: true }).toBuffer()
    : options.palettePng
      ? await pipeline.png({ palette: true, quality: 90, compressionLevel: 9 }).toBuffer()
      : await pipeline.webp(options.lossless ? { lossless: true } : { quality: options.quality ?? 82, smartSubsample: true }).toBuffer();
  await writeFile(path.join(outDir, target), output);
  const info = await sharp(path.join(outDir, target)).metadata();
  before += (await stat(input)).size;
  after += output.length;
  console.log(
    `${source} (${meta.width}x${meta.height}) -> ${target} (${info.width}x${info.height}, ${(output.length / 1024).toFixed(0)} kB)`
  );
}

console.log(`Totalt: ${(before / 1048576).toFixed(1)} MB -> ${(after / 1048576).toFixed(1)} MB`);
