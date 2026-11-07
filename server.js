'use strict';

const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { handleAvailability } = require('./api/src/availability');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.pdf': 'application/pdf',
  '.webmanifest': 'application/manifest+json',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2'
};

const ROOT_FILES = new Set(['robots.txt', 'sitemap.xml']);
const ALLOWED_DIRS = new Set(['css', 'js', 'images', 'pages']);

// Rena URL:er enligt sitemap.xml kanoniska länkar mappas till pages/*.html.
const PAGE_ROUTES = new Set([
  'foretag', 'fest', 'brollop', 'semester', 'boende', 'aktiviteter',
  'priser', 'mat-dryck', 'om-oss', 'vanliga-fragor', 'kontakt',
  'digital-visning', 'boka', 'lediga-datum'
]);

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'X-Frame-Options': 'DENY'
};

const API_HEADERS = {
  ...SECURITY_HEADERS,
  'Cache-Control': 'no-store',
  'Content-Type': 'application/json; charset=utf-8'
};

function sendJson(res, status, body, extraHeaders) {
  res.writeHead(status, { ...API_HEADERS, ...(extraHeaders || {}) });
  res.end(JSON.stringify(body));
}

function sendErrorPage(res, root, status) {
  fs.readFile(path.join(root, '404.html'))
    .then((data) => {
      res.writeHead(status, {
        ...SECURITY_HEADERS,
        'Content-Type': MIME_TYPES['.html'],
        'Cache-Control': 'no-cache'
      });
      res.end(data);
    })
    .catch(() => {
      res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Sidan hittades inte.');
    });
}

function resolveStatic(root, pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (!decoded.startsWith('/')) return null;

  const normalized = path.posix.normalize(decoded);
  // Blockerar path traversal: resterande '..' innebär ett försök att backa ut ur roten.
  if (!normalized.startsWith('/') || normalized.includes('..')) return null;

  let relative = normalized.replace(/^\/+/, '');
  if (relative === '') return path.join(root, 'index.html');
  relative = relative.replace(/\/+$/, '');
  if (PAGE_ROUTES.has(relative)) return path.join(root, 'pages', `${relative}.html`);
  if (ROOT_FILES.has(relative)) return path.join(root, relative);

  const [firstSegment] = relative.split('/');
  if (!ALLOWED_DIRS.has(firstSegment)) return null;

  const candidate = path.resolve(root, relative);
  const rootResolved = path.resolve(root);
  if (!candidate.startsWith(rootResolved + path.sep)) return null;
  return candidate;
}

function createRequestListener(options = {}) {
  const root = path.resolve(options.root ?? __dirname);
  const availabilityHandler = options.availabilityHandler ?? handleAvailability;
  const warn = options.warn ?? ((message) => console.error(message));

  return async function requestListener(req, res) {
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch {
      sendJson(res, 400, { error: 'Ogiltig förfrågan.' });
      return;
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendJson(res, 405, { error: 'Metod tillåts inte.' }, { Allow: 'GET, HEAD' });
      return;
    }

    if (url.pathname === '/api/availability') {
      const context = { warn };
      try {
        const result = await availabilityHandler({ query: url.searchParams }, context, options.availability ?? {});
        sendJson(res, result.status, result.jsonBody, result.headers);
      } catch {
        sendJson(res, 503, { error: 'Tillgängligheten är för tillfället okänd.' });
      }
      return;
    }

    const filePath = resolveStatic(root, url.pathname);
    if (filePath === null) {
      await sendErrorPage(res, root, 404);
      return;
    }

    try {
      const data = await fs.readFile(filePath);
      const ext = path.extname(filePath).toLowerCase();
      const mime = MIME_TYPES[ext];
      if (!mime) throw new Error('Otillåten filtyp');
      const isHtml = ext === '.html';
      res.writeHead(200, {
        ...SECURITY_HEADERS,
        'Content-Type': mime,
        'Cache-Control': isHtml ? 'no-cache' : 'public, max-age=86400'
      });
      res.end(req.method === 'HEAD' ? undefined : data);
    } catch {
      await sendErrorPage(res, root, 404);
    }
  };
}

function main() {
  const port = Number(process.env.PORT) || 8080;
  const server = http.createServer(createRequestListener());
  server.listen(port, () => {
    console.log(`Skadevi servern lyssnar på port ${port}`);
  });
}

if (require.main === module) {
  main();
}

module.exports = { createRequestListener, resolveStatic, MIME_TYPES, PAGE_ROUTES };
