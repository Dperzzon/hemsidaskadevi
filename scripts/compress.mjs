// Förkomprimerar textresurser i dist/ (.br och .gz) så att produktionsservern
// kan servera dem utan körtidsberoende. Körs som del av npm run build.
import { createBrotliCompress, createGzip, constants } from 'node:zlib';
import { createReadStream, createWriteStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const dist = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), 'dist');
const COMPRESSIBLE = /\.(html|css|js|mjs|json|svg|xml|txt|webmanifest)$/i;

async function walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...await walk(full));
    else files.push(full);
  }
  return files;
}

const files = (await walk(dist)).filter((file) => COMPRESSIBLE.test(file) && !/\.(br|gz)$/i.test(file));

for (const file of files) {
  await pipeline(createReadStream(file), createBrotliCompress({
    params: { [constants.BROTLI_PARAM_QUALITY]: constants.BROTLI_MAX_QUALITY }
  }), createWriteStream(`${file}.br`));
  await pipeline(createReadStream(file), createGzip({ level: 9 }), createWriteStream(`${file}.gz`));
}

let original = 0;
let brotli = 0;
for (const file of files) {
  original += (await stat(file)).size;
  brotli += (await stat(`${file}.br`)).size;
}
console.log(`Förkomprimerade ${files.length} filer: ${(original / 1024).toFixed(0)} kB -> ${(brotli / 1024).toFixed(0)} kB (brotli)`);
