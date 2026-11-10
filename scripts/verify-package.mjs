// Regressionskontroll: verifierar att alla lokala moduler som krävs av
// paketerad serverkod faktiskt finns i package/server.
// Kör: node scripts/verify-package.mjs ./package
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const pkgRoot = path.resolve(process.argv[2] || './package');
const serverDir = path.join(pkgRoot, 'server');

if (!fs.existsSync(serverDir)) {
  console.error(`::error::${serverDir} saknas — paketet är ofullständigt`);
  process.exit(1);
}

function collectJsFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectJsFiles(full));
    else if (/\.(c|m)?js$/.test(entry.name)) out.push(full);
  }
  return out;
}

function resolveRequire(fromFile, spec) {
  if (!spec.startsWith('.')) return null; // extern modul (node_modules)
  const base = path.resolve(path.dirname(fromFile), spec);
  for (const candidate of [
    base,
    `${base}.js`,
    `${base}.json`,
    path.join(base, 'index.js'),
  ]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return candidate;
    }
  }
  return base; // hittades inte — returnera förväntad sökväg för felmeddelandet
}

const errors = [];
const files = collectJsFiles(serverDir);
if (files.length === 0) {
  errors.push('package/server innehåller inga JS-filer');
}

for (const file of files) {
  const src = fs.readFileSync(file, 'utf8');
  const requireRe = /require\(\s*['"]([^'"]+)['"]\s*\)/g;
  let match;
  while ((match = requireRe.exec(src)) !== null) {
    const resolved = resolveRequire(file, match[1]);
    if (resolved && !fs.existsSync(resolved)) {
      errors.push(
        `${path.relative(pkgRoot, file)} kräver '${match[1]}' men ${path.relative(pkgRoot, resolved)} saknas i paketet`
      );
    }
  }
}

// Kritiska filer som produktionsservern behöver.
const required = [
  'server/index.js',
  'server/calendar/availability.js',
  'server/calendar/calendar-worker.js',
  'server/booking/requests.js',
  'server/booking/rules.js',
  'server/booking/store.js',
  'server/booking/pricing.js',
  'server/booking/mail.js',
  'server/booking/refund.js',
  'server/booking/house-rules.json',
  'dist/index.html',
  'package.json',
];
for (const rel of required) {
  if (!fs.existsSync(path.join(pkgRoot, rel))) {
    errors.push(`Obligatorisk fil saknas i paketet: ${rel}`);
  }
}

// Tester, utvecklingsfiler och hemligheter får aldrig följa med.
const forbidden = [/\.test\.[cm]?js$/, /\.spec\.[cm]?js$/, /(^|\/)__tests__(\/|$)/, /(^|\/)\.env/, /(^|\/)\.env\./];
for (const file of files) {
  const rel = path.relative(pkgRoot, file);
  if (forbidden.some((re) => re.test(rel))) {
    errors.push(`Utvecklingsfil/potentiell hemlighet fick med i paketet: ${rel}`);
  }
}
for (const name of ['.env', '.env.local', 'secrets.json']) {
  if (fs.existsSync(path.join(pkgRoot, name))) {
    errors.push(`Hemlighetsfil fick med i paketet: ${name}`);
  }
}

if (errors.length > 0) {
  for (const err of errors) console.error(`::error::${err}`);
  console.error(`::error::Paketverifiering misslyckades med ${errors.length} fel`);
  process.exit(1);
}
console.log(`Paketverifiering OK: ${files.length} serverfiler, alla lokala moduler lösta.`);
