// Verifierar att Vite-bygget är komplett: alla sidor finns, alla refererade
// hashade resurser existerar och inga referenser pekar fel.
// Körs i CI (npm run build && node scripts/verify-dist.mjs) och lokalt.
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const dist = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), 'dist');
const errors = [];

const expectedPages = [
  'index.html',
  '404.html',
  ...['foretag', 'fest', 'brollop', 'semester', 'boende', 'aktiviteter', 'priser',
    'mat-dryck', 'om-oss', 'vanliga-fragor', 'kontakt', 'digital-visning', 'boka',
    'lediga-datum'].map((name) => `pages/${name}.html`)
];

for (const page of expectedPages) {
  try {
    await stat(path.join(dist, page));
  } catch {
    errors.push(`Saknad sida: dist/${page}`);
  }
}

for (const asset of ['robots.txt', 'sitemap.xml', 'images/logo.png']) {
  try {
    await stat(path.join(dist, asset));
  } catch {
    errors.push(`Saknad resurs: dist/${asset}`);
  }
}

// Kontrollera att alla lokala referenser i HTML-filerna pekar på existerande filer.
const PAGE_ROUTES = new Set(['foretag', 'fest', 'brollop', 'semester', 'boende', 'aktiviteter',
  'priser', 'mat-dryck', 'om-oss', 'vanliga-fragor', 'kontakt', 'digital-visning', 'boka', 'lediga-datum']);
const htmlFiles = [
  ...expectedPages,
  ...(await readdir(path.join(dist, 'pages'))).filter((name) => name.endsWith('.html') && !expectedPages.includes(`pages/${name}`)).map((name) => `pages/${name}`)
];

for (const page of [...new Set(htmlFiles)]) {
  const html = await readFile(path.join(dist, page), 'utf8');
  const refs = [...html.matchAll(/(?:src|href)="(\/[^"]+)"/g)].map((m) => m[1]);
  for (const ref of refs) {
    if (ref.startsWith('//') || ref.startsWith('/api')) continue;
    const clean = ref.split('#')[0].split('?')[0].replace(/\/+$/, '');
    if (clean === '/' || clean === '') continue;
    const route = clean.replace(/^\//, '');
    if (PAGE_ROUTES.has(route)) continue;
    try {
      await stat(path.join(dist, clean));
    } catch {
      errors.push(`${page} refererar saknad resurs: ${ref}`);
    }
  }
}

if (errors.length > 0) {
  console.error(errors.join('\n'));
  process.exit(1);
}
console.log(`dist/ verifierad: ${expectedPages.length} sidor, alla referenser löser.`);
