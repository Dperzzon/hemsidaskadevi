import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Bygger ett separat publiceringspaket för adminportalen. Paketet innehåller
// medvetet inte den publika sajten, Logic App-koden eller hemligheter.
// Mejlmallar för bekräftelser får ingå; de skickar inget utanför appen.
// Användning: node scripts/package-admin.mjs [målkatalog]

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const target = path.resolve(process.argv[2] ?? path.join(root, 'package-admin'));

const allowed = [
  'package.json',
  'package-lock.json',
  'server/admin',
  'server/calendar',
  'server/booking/store.js',
  'server/booking/pricing.js',
  'server/booking/payment-ledger.js',
  'server/booking/payment-access.js',
  'server/booking/invoice-requests.js',
  'server/booking/stripe.js',
  'server/booking/mail.js',
  'server/booking/booking-mail.js',
  'server/booking/mail-templates.js',
  'server/booking/outbox.js',
  'server/booking/rules.js',
  'server/booking/house-rules.json',
  'server/booking/buffer-nights.js',
  'server/booking/addon-availability.js',
  'shared',
  'src/css/fonts.css',
  'public/fonts',
  'public/images/logo.png'
];

const required = [
  'server/admin/index.js',
  'server/admin/auth.js',
  'server/admin/booking-service.js',
  'server/admin/public/admin.css',
  'server/admin/public/admin.js',
  'server/calendar/availability.js',
  'server/calendar/calendar-worker.js',
  'server/calendar/sync-status.js',
  'server/booking/store.js',
  'server/booking/pricing.js',
  'server/booking/payment-ledger.js',
  'server/booking/payment-access.js',
  'server/booking/invoice-requests.js',
  'server/booking/stripe.js',
  'server/booking/mail.js',
  'server/booking/booking-mail.js',
  'server/booking/mail-templates.js',
  'server/booking/outbox.js',
  'server/booking/rules.js',
  'server/booking/house-rules.json',
  'server/booking/buffer-nights.js',
  'server/booking/addon-availability.js',
  'shared/pricing-config.json',
  'shared/practical-info.json',
  'src/css/fonts.css',
  'public/images/logo.png',
  'package.json'
];

const forbidden = [
  'server/booking/requests.js',
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

  // Gör paketet självständigt. App Service zip-deploy tar bort befintliga
  // node_modules, så runtime-beroenden måste ingå i paketet. Endast
  // produktionsberoenden installeras; inga dev-verktyg eller hemligheter.
  execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', [
    'ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'
  ], {
    cwd: target,
    stdio: 'inherit',
    env: { ...process.env, NODE_ENV: 'production' },
    shell: process.platform === 'win32'
  });
  if (!(await exists('node_modules/node-ical')) || !(await exists('node_modules/temporal-polyfill')) ||
      !(await exists('node_modules/pdfkit'))) {
    throw new Error('Adminpaketet saknar runtime-beroenden');
  }

  await fs.writeFile(path.join(target, 'ADMIN_PACKAGE.txt'), [
    'Skadevi Bokningsportal — separat adminpaket',
    'Startkommando: node server/admin/index.js',
    'Datakälla i produktion: Table Storage via managed identity',
    'Runtime-beroenden ingår i node_modules (endast production).',
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
  console.log('Kontrollerat: server/admin, statiska resurser, pricing/store, mejlmallar och inga publika sidor eller hemligheter.');
}

main().catch((error) => {
  console.error(`Paketering misslyckades: ${error.message}`);
  process.exit(1);
});
