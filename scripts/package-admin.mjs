import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Bygger ett separat publiceringspaket för adminportalen. Paketet innehåller
// medvetet inte den publika sajten, Resend/Logic App-koden eller hemligheter.
// Användning: node scripts/package-admin.mjs [målkatalog]

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const target = path.resolve(process.argv[2] ?? path.join(root, 'package-admin'));

const allowed = [
  'package.json',
  'package-lock.json',
  'server/admin',
  'server/booking/store.js',
  'server/booking/pricing.js',
  'shared',
  'src/css/fonts.css',
  'public/fonts',
  'public/images/logo.png'
];

const required = [
  'server/admin/index.js',
  'server/admin/auth.js',
  'server/admin/public/admin.css',
  'server/admin/public/admin.js',
  'server/booking/store.js',
  'server/booking/pricing.js',
  'shared/pricing-config.json',
  'src/css/fonts.css',
  'public/images/logo.png',
  'package.json'
];

const forbidden = [
  'server/booking/requests.js',
  'server/booking/mail.js',
  'server/booking/rules.js',
  'server/index.js',
  'infra',
  '.github',
  'docs',
  'src/pages',
  'dist'
];

async function copy(relative) {
  const source = path.join(root, relative);
  const destination = path.join(target, relative);
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.cp(source, destination, {
    recursive: true,
    filter: (src) => {
      const name = path.basename(src);
      return !name.endsWith('.test.js') &&
        !name.endsWith('.spec.js') &&
        !name.endsWith('.md') &&
        !name.startsWith('.env') &&
        name !== '__tests__';
    }
  });
}

async function exists(relative) {
  try {
    await fs.access(path.join(target, relative));
    return true;
  } catch {
    return false;
  }
}

async function main() {
  await fs.rm(target, { recursive: true, force: true });
  await fs.mkdir(target, { recursive: true });
  for (const relative of allowed) {
    await copy(relative);
  }

  for (const relative of required) {
    if (!(await exists(relative))) {
      throw new Error(`Adminpaketet saknar obligatorisk fil: ${relative}`);
    }
  }
  const fonts = await fs.readdir(path.join(target, 'public', 'fonts'));
  if (!fonts.some((name) => name.endsWith('.woff2'))) {
    throw new Error('Adminpaketet saknar woff2-typsnitt');
  }
  for (const relative of forbidden) {
    if (await exists(relative)) {
      throw new Error(`Adminpaketet får inte innehålla: ${relative}`);
    }
  }

  await fs.writeFile(path.join(target, 'ADMIN_PACKAGE.txt'), [
    'Skadevi Bokningsportal — separat adminpaket',
    'Startkommando: node server/admin/index.js',
    'Datakälla i produktion: Table Storage via managed identity',
    'Inga hemligheter ingår. Inga publika webbplatsfiler ingår.',
    'Byggt av scripts/package-admin.mjs.'
  ].join('\n'), 'utf8');

  const entries = await fs.readdir(target, { recursive: true });
  let bytes = 0;
  for (const entry of entries) {
    const info = await fs.stat(path.join(target, entry)).catch(() => null);
    if (info?.isFile()) bytes += info.size;
  }
  console.log(`Adminpaket klart: ${target}`);
  console.log(`Filer: ${entries.length} · storlek: ${(bytes / 1024 / 1024).toFixed(2)} MB`);
  console.log('Kontrollerat: server/admin, statiska resurser, pricing/store och inga Resend/publika filer.');
}

main().catch((error) => {
  console.error(`Paketering misslyckades: ${error.message}`);
  process.exit(1);
});
