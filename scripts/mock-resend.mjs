#!/usr/bin/env node
// ============================================================================
// Lokal mock för Resends Email API (steg 7J).
//
// Används ENDAST för tester. Skickar inga mejl och kräver ingen riktig
// API-nyckel. Loggar aldrig Authorization-värdet.
//
//   POST /emails          -> 200 {"id":"mock-..."} (eller vald felstatus)
//   GET  /status/<kod>    -> valfri HTTP-status, t.ex. /status/429
//   GET  /timeout         -> håller anslutningen öppen (simulerar timeout)
//
// Starta: npm run mock:resend
// Peka testworkflowets resendApiUrl mot http://<host>:8787/emails eller
// motsvarande /status/<kod>.
// ============================================================================

import http from 'node:http';
import { pathToFileURL } from 'node:url';

export function createMockResendServer(options = {}) {
  const requests = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (req.method === 'POST' && url.pathname === '/emails') {
      const chunks = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        let body = null;
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        } catch {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ statusCode: 400, name: 'invalid_json' }));
          return;
        }
        requests.push({
          authorization: req.headers.authorization,
          idempotencyKey: req.headers['idempotency-key'],
          contentType: req.headers['content-type'],
          body
        });
        const failWith = options.failWith ?? 0;
        if (failWith) {
          res.writeHead(failWith, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ statusCode: failWith, name: `mock_${failWith}` }));
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: `mock-${requests.length}` }));
      });
      return;
    }
    const statusMatch = /^\/status\/(\d{3})$/.exec(url.pathname);
    if (statusMatch) {
      const statusCode = Number(statusMatch[1]);
      res.writeHead(statusCode, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ statusCode, name: `mock_${statusCode}` }));
      return;
    }
    if (url.pathname === '/timeout') {
      // Håll anslutningen öppen; klienten får timeouta.
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ statusCode: 404, name: 'not_found' }));
  });

  return {
    server,
    requests,
    listen(port = 0) {
      return new Promise((resolve) => {
        server.listen(port, '127.0.0.1', () => {
          const address = server.address();
          resolve(`http://127.0.0.1:${address.port}`);
        });
      });
    },
    close() {
      return new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  };
}

async function main() {
  const port = Number(process.env.MOCK_RESEND_PORT ?? 8787);
  const mock = createMockResendServer();
  const url = await mock.listen(port);
  console.log(`Mock-Resend lyssnar på ${url}`);
  console.log('POST /emails, /status/<kod>, /timeout. Inga mejl skickas.');
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
