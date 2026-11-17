import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { setTimeout as wait } from 'node:timers/promises';

// Minimal publiceringskontroll av det separata adminpaketet. Startar paketet
// i demoläge på en slumpad port och verifierar sidor, API och statiska filer.
// Användning: node scripts/smoke-admin-package.mjs [paketkatalog]

const root = path.resolve(process.argv[2] ?? 'package-admin');
const port = 19000 + Math.floor(Math.random() * 800);
const base = `http://127.0.0.1:${port}`;

function fail(message) {
  throw new Error(message);
}

const child = spawn(process.execPath, [path.join(root, 'server', 'admin', 'index.js'), '--demo'], {
  cwd: root,
  env: { ...process.env, NODE_ENV: 'test', ADMIN_PORT: String(port) },
  stdio: ['ignore', 'pipe', 'pipe']
});
let logs = '';
child.stdout.on('data', (data) => { logs += data.toString(); });
child.stderr.on('data', (data) => { logs += data.toString(); });

try {
  const deadline = Date.now() + 20000;
  let ready = false;
  while (Date.now() < deadline && !ready) {
    if (child.exitCode !== null) fail(`servern avslutades: ${logs.trim()}`);
    try {
      const response = await fetch(`${base}/healthz`);
      if (response.ok) ready = true;
    } catch {
      await wait(300);
    }
  }
  if (!ready) fail('adminpaketet startade inte inom 20 sekunder');

  const checks = [
    ['/admin', 200],
    ['/admin/bookings', 200],
    ['/admin/bookings/new', 200],
    ['/admin/calendar', 200],
    ['/admin/direct-booking', 200],
    ['/api/admin/session', 200],
    ['/api/admin/bookings', 200],
    ['/api/admin/calendar', 200],
    ['/api/admin/direct-booking', 200],
    ['/assets/admin.css', 200],
    ['/assets/admin.js', 200],
    ['/assets/fonts.css', 200],
    ['/assets/logo.png', 200]
  ];
  for (const [pathname, expected] of checks) {
    const response = await fetch(`${base}${pathname}`);
    if (response.status !== expected) fail(`${pathname} gav ${response.status}, förväntat ${expected}`);
    await response.body?.cancel();
  }

  const admin = await fetch(`${base}/admin`);
  const html = await admin.text();
  if (!html.includes('Demoläge') || !html.includes('DEMO-')) {
    fail('demobanner eller DEMO-referens saknas');
  }
  if (html.includes('[object Object]')) fail('gränssnittet innehåller [object Object]');

  const session = await fetch(`${base}/api/admin/session`).then((response) => response.json());
  if (session.demo !== true || session.dataSource !== 'demo' || session.writesEnabled !== true) {
    fail('sessionens demoläge eller skrivstatus är fel');
  }

  const list = await fetch(`${base}/api/admin/bookings`).then((response) => response.json());
  if (!Array.isArray(list.bookings) || list.bookings.length < 1) {
    fail('bokningslistan är tom i adminpaketet');
  }

  const fontDir = path.join(root, 'public', 'fonts');
  const font = (await fs.readdir(fontDir)).find((name) => name.endsWith('.woff2'));
  if (!font) fail('woff2-typsnitt saknas i paketet');
  const fontResponse = await fetch(`${base}/fonts/${encodeURIComponent(font)}`);
  if (fontResponse.status !== 200) fail(`typsnitt gav ${fontResponse.status}`);
  await fontResponse.body?.cancel();

  console.log(`Adminpaketets smoke-test OK: ${checks.length + 2} kontroller på port ${port}.`);
} catch (error) {
  console.error(`ADMIN-SMOKE FEL: ${error.message}`);
  process.exitCode = 1;
} finally {
  child.kill('SIGTERM');
  await wait(200);
  if (child.exitCode === null) child.kill('SIGKILL');
}
