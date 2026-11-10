// Smoke-test av det paketerade programmet (samma filer som läggs på Azure):
// startar servern på en slumpad port och kontrollerar sidor, statiska
// resurser, omdirigeringar, 404-hantering och API:et.
// Användning: node scripts/smoke-test.mjs [paketkatalog]
import { spawn } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { setTimeout as wait } from 'node:timers/promises';

const root = path.resolve(process.argv[2] ?? '.');
const port = 18080 + Math.floor(Math.random() * 1000);
const base = `http://127.0.0.1:${port}`;

function fail(message) {
  console.error(`SMOKE FEL: ${message}`);
  process.exit(1);
}

const child = spawn(process.execPath, [path.join(root, 'server', 'index.js')], {
  env: { ...process.env, PORT: String(port), NODE_ENV: 'production' },
  stdio: ['ignore', 'pipe', 'pipe']
});
child.stderr.on('data', (data) => console.error(`[server] ${data}`.trim()));

try {
  const deadline = Date.now() + 20000;
  let ready = false;
  while (Date.now() < deadline && !ready) {
    try {
      await fetch(`${base}/robots.txt`);
      ready = true;
    } catch {
      await wait(300);
    }
  }
  if (!ready) fail('servern startade inte inom 20 sekunder');

  const checks = [
    ['/', 200],
    ['/foretag', 200], ['/fest', 200], ['/brollop', 200], ['/semester', 200],
    ['/boende', 200], ['/aktiviteter', 200], ['/priser', 200], ['/mat-dryck', 200],
    ['/om-oss', 200], ['/vanliga-fragor', 200], ['/kontakt', 200],
    ['/digital-visning', 200], ['/boka', 200], ['/lediga-datum', 200],
    ['/robots.txt', 200],
    ['/sitemap.xml', 200],
    ['/css/style.css', 200],
    ['/js/main.js', 200],
    ['/images/logo.png', 200],
    ['/images/gallery/dukning-pergola.webp', 200],
    ['/fonts/v20-UcC73FwrK3iLTeHuS_nVMrMxCp50SjIa1ZL7.woff2', 200],
    ['/denna-sida-finns-inte', 404],
    ['/package.json', 404],
    ['/server/index.js', 404],
    ['/../package.json', 404]
  ];
  for (const [pathname, expected] of checks) {
    const response = await fetch(`${base}${encodeURI(pathname)}`, { redirect: 'manual' });
    if (response.status !== expected) fail(`${pathname} gav ${response.status}, förväntat ${expected}`);
    await response.body?.cancel();
  }

  for (const [from, to] of [['/pages/priser.html', '/priser'], ['/priser.html', '/priser'], ['/index.html', '/']]) {
    const response = await fetch(`${base}${from}`, { redirect: 'manual' });
    if (response.status !== 301) fail(`${from} gav ${response.status}, förväntat 301`);
    if (response.headers.get('location') !== to) fail(`${from} omdirigerar till ${response.headers.get('location')}, förväntat ${to}`);
    await response.body?.cancel();
  }

  const bad = await fetch(`${base}/api/availability?start=2026-01-01`);
  if (bad.status !== 400) fail(`API utan slutdatum gav ${bad.status}, förväntat 400`);
  await bad.body?.cancel();

  // Hashade resurser ska ha immutable cache och serveras komprimerade.
  const index = await (await fetch(`${base}/`)).text();
  const cssRef = index.match(/href="(\/assets\/[\w-]+\.css)"/)?.[1];
  if (!cssRef) fail('startsidan refererar ingen hashad css');
  const css = await fetch(`${base}${cssRef}`, { headers: { 'Accept-Encoding': 'br, gzip' } });
  if (css.status !== 200) fail(`hashad css gav ${css.status}`);
  if (!/immutable/.test(css.headers.get('cache-control') ?? '')) fail('hashad css saknar immutable cache');
  if (!['br', 'gzip'].includes(css.headers.get('content-encoding') ?? '')) fail('hashad css serveras okomprimerad');
  await css.body?.cancel();

  console.log(`Smoke-test OK: ${checks.length} URL:er, omdirigeringar, API och cache — på port ${port}.`);
} finally {
  child.kill('SIGTERM');
  await wait(500).then(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
}
