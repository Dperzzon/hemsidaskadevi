#!/usr/bin/env node
// ============================================================================
// Lokal mock för Resends Email API (steg 7J/7O).
//
// Används ENDAST för tester. Skickar inga mejl, lyssnar endast på 127.0.0.1
// och kräver ingen riktig API-nyckel. Loggar aldrig Authorization-värdet.
//
//   POST /emails          -> 200 {"id":"mock-..."} (idempotent per nyckel)
//   GET  /status/<kod>    -> valfri HTTP-status, t.ex. /status/429
//   GET  /timeout         -> håller anslutningen öppen (simulerar timeout)
//
// Idempotens: samma Idempotency-Key med samma body returnerar samma id och
// skapar ingen ny leverans. Samma nyckel med annan body ger 409.
// Med loseResponseTimes=N registreras leveransen men anslutningen stängs utan
// svar för de första N anropen – används för att testa förlorat svar.
// ============================================================================

import http from 'node:http';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';

function bodyHash(body) {
  return crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex');
}

export function createMockResendServer(options = {}) {
  const requests = [];
  const delivered = [];
  const idempotency = new Map();
  let nextId = 1;
  let loseResponseRemaining = options.loseResponseTimes ?? 0;

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
        const key = req.headers['idempotency-key'] ?? null;
        requests.push({
          authorization: req.headers.authorization,
          idempotencyKey: key,
          contentType: req.headers['content-type'],
          body
        });

        if (key && idempotency.has(key)) {
          const existing = idempotency.get(key);
          if (existing.bodyHash !== bodyHash(body)) {
            res.writeHead(409, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ statusCode: 409, name: 'invalid_idempotent_request' }));
            return;
          }
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ id: existing.id, duplicate: true }));
          return;
        }

        const failWith = options.failWith ?? 0;
        if (failWith) {
          res.writeHead(failWith, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ statusCode: failWith, name: `mock_${failWith}` }));
          return;
        }

        const id = `mock-${nextId++}`;
        if (key) idempotency.set(key, { id, bodyHash: bodyHash(body), body });
        delivered.push({ id, idempotencyKey: key, body });

        if (loseResponseRemaining > 0) {
          loseResponseRemaining -= 1;
          res.destroy();
          return;
        }

        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id }));
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
    delivered,
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
  console.log(`Mock-Resend lyssnar på ${url} (endast localhost)`);
  console.log('POST /emails, /status/<kod>, /timeout. Inga mejl skickas.');
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
