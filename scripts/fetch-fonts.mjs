// Hämtar Google Fonts CSS + woff2-filer för lokalt hostande typsnitt.
// Körs vid behov: node scripts/fetch-fonts.mjs
// Genererade filer: src/css/fonts.css och public/fonts/*.woff2
import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CSS_URL = 'https://fonts.googleapis.com/css2?family=Libre+Baskerville:ital@0;1&family=Inter:wght@300;400;500;600&display=swap';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const response = await fetch(CSS_URL, { headers: { 'User-Agent': UA } });
if (!response.ok) throw new Error(`Kunde inte hämta typsnitts-CSS: ${response.status}`);
const css = await response.text();

await mkdir(path.join(root, 'public', 'fonts'), { recursive: true });

const urls = [...css.matchAll(/url\((https:\/\/fonts\.gstatic\.com\/[^)]+\.woff2)\)/g)].map((m) => m[1]);
const unique = [...new Set(urls)];
const map = new Map();

for (const [index, url] of unique.entries()) {
  const parsed = new URL(url);
  const name = parsed.pathname.split('/').filter(Boolean).slice(-2).join('-');
  const local = `fonts/${name}`;
  map.set(url, local);
  const font = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!font.ok) throw new Error(`Kunde inte hämta ${url}: ${font.status}`);
  await writeFile(path.join(root, 'public', 'fonts', name), Buffer.from(await font.arrayBuffer()));
  console.log(`${index + 1}/${unique.length} ${name}`);
}

const localCss = css.replaceAll(/url\((https:\/\/fonts\.gstatic\.com\/[^)]+\.woff2)\)/g, (_, url) => `url(/${map.get(url)})`);
await mkdir(path.join(root, 'src', 'css'), { recursive: true });
await writeFile(path.join(root, 'src', 'css', 'fonts.css'), `/* Typsnitt hämtade från Google Fonts (scripts/fetch-fonts.mjs). Självhostade: inga anrop till tredje part. */\n${localCss}`);
console.log(`Klar: ${unique.length} typsnittsfiler, src/css/fonts.css skriven.`);
