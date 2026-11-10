// Vite-konfiguration: multi-page app som bevarar webbplatsens rena URL:er
// (/priser, /lediga-datum ...) och serverar kalender-API:et /api/availability
// via exakt samma kod som produktionsservern (server/calendar/).
import { defineConfig } from 'vite';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { handleAvailability } = require('./server/calendar/availability.js');

// Syntetisk kalender för lokal utveckling: två nätter blockade, 12 dagar fram.
function devFetch() {
  const start = new Date();
  start.setDate(start.getDate() + 12);
  const end = new Date(start);
  end.setDate(end.getDate() + 2);
  const ics = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Skadevi Dev//EN',
    'BEGIN:VEVENT', 'UID:dev-mock',
    `DTSTART;VALUE=DATE:${start.toISOString().slice(0, 10).replaceAll('-', '')}`,
    `DTEND;VALUE=DATE:${end.toISOString().slice(0, 10).replaceAll('-', '')}`,
    'END:VEVENT', 'END:VCALENDAR', ''
  ].join('\r\n');
  return Promise.resolve(new Response(ics, { status: 200 }));
}

const PAGE_ROUTES = [
  'foretag', 'fest', 'brollop', 'semester', 'boende', 'aktiviteter',
  'priser', 'mat-dryck', 'om-oss', 'vanliga-fragor', 'kontakt',
  'digital-visning', 'boka', 'lediga-datum'
];

// Föråldrade mallsidor med en trasig typsnittslänk (rel="stylesheet> utan
// avslutande citattecken). Sidorna ska rendera EXAKT som tidigare, så Vite
// får inte transformera deras HTML: en infogad <script>/<link>-tagg skulle
// sväljas av webbläsarens tolkning av den trasiga länken. De kopieras
// oförändrade till dist/ av copyLegacyPages() och läser oförändrade sökvägar
// (/css/style.css och /js/main.js, se scripts/finalize-dist.mjs).
const LEGACY_PAGES = ['priser.html', 'mat-dryck.html', 'om-oss.html', 'digital-visning.html'];

function copyLegacyPages() {
  return {
    name: 'skadevi-copy-legacy-pages',
    apply: 'build',
    async closeBundle() {
      const { copyFile, mkdir } = await import('node:fs/promises');
      await mkdir(path.join(root, 'dist', 'pages'), { recursive: true });
      for (const name of LEGACY_PAGES) {
        await copyFile(path.join(root, 'src', 'pages', name), path.join(root, 'dist', 'pages', name));
      }
    }
  };
}

// Middleware för rena URL:er + kalender-API i dev- och preview-servern.
function cleanUrlsAndApi() {
  return {
    name: 'skadevi-clean-urls-and-api',
    configureServer(server) {
      attach(server.middlewares);
    },
    configurePreviewServer(server) {
      attach(server.middlewares);
    }
  };

  function attach(middlewares) {
    // Dev-bekvämlighet: utan AIRBNB_ICAL_URL genereras en syntetisk kalender
    // så att kalendern kan testas lokalt (produktionen påverkas inte).
    const devMock = !process.env.AIRBNB_ICAL_URL && process.env.NODE_ENV !== 'production';
    if (devMock) console.log('[dev] Kalender-API:et använder en syntetisk kalender (sätt AIRBNB_ICAL_URL för riktig data).');
    middlewares.use(async (req, res, next) => {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname === '/api/availability') {
        try {
          const result = await handleAvailability(
            { query: url.searchParams },
            { warn: (message) => console.error(message) },
            devMock ? { calendarUrl: 'https://devmock.invalid/kalender.ics', fetchImpl: devFetch } : {}
          );
          res.writeHead(result.status, result.headers);
          res.end(JSON.stringify(result.jsonBody));
        } catch {
          res.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: 'Tillgängligheten är för tillfället okänd.' }));
        }
        return;
      }
      const clean = url.pathname.replace(/\/+$/, '');
      if (PAGE_ROUTES.includes(clean.slice(1))) {
        req.url = `/pages${clean}.html${url.search}`;
      }
      next();
    });
  }
}

async function pageInputs() {
  const pages = (await readdir(path.join(root, 'src', 'pages'))).filter((name) => name.endsWith('.html') && !LEGACY_PAGES.includes(name));
  return [
    path.join(root, 'src', 'index.html'),
    path.join(root, 'src', '404.html'),
    ...pages.map((name) => path.join(root, 'src', 'pages', name))
  ];
}

export default defineConfig(async () => ({
  root: path.join(root, 'src'),
  publicDir: path.join(root, 'public'),
  appType: 'mpa',
  plugins: [cleanUrlsAndApi(), copyLegacyPages()],
  build: {
    outDir: path.join(root, 'dist'),
    emptyOutDir: true,
    sourcemap: false,
    assetsInlineLimit: 0,
    rollupOptions: {
      input: await pageInputs(),
      output: {
        entryFileNames: 'assets/[name]-[hash].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]'
      }
    }
  },
  server: {
    port: 5173,
    strictPort: false
  }
}));
