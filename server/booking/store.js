'use strict';

// Lagring för bokningsförfrågningar.
//
// BESLUTSPUNKT (se docs/bokningsflode.md): permanent lagring ska ske i
// Azure Table Storage med variablerna AZURE_STORAGE_ACCOUNT_NAME och
// AZURE_STORAGE_KEY (och valfritt AZURE_TABLE_NAME). Det kräver inga nya
// Azure-resurser utöver en tabell i ett redan existerande lagringskonto,
// men kontot måste godkännas/utses av Skadevi innan riktiga förfrågningar
// tas emot. Utan konfiguration faller modulen tillbaka på en lokal JSONL-fil
// som ENDAST är avsedd för utveckling och test — produktionsservern varnar
// tydligt vid start om den durabla lagringen saknas och API:et håller
// verklig inskick avstängd tills dess (se requests.js).
//
// Inga personuppgifter loggas; endast förfrågans data lagras på angiven plats.

const crypto = require('node:crypto');
const fsp = require('node:fs/promises');
const path = require('node:path');

const TABLE_API_VERSION = '2021-10-04';

function isConfigured() {
  return Boolean(process.env.AZURE_STORAGE_ACCOUNT_NAME && process.env.AZURE_STORAGE_KEY);
}

// --- Azure Table Storage (SharedKey, inga externa beroenden) ---

function sharedKeySignature(accountName, accountKey, method, pathname, contentType, date, headers, query) {
  const canonicalizedHeaders = Object.keys(headers)
    .filter((name) => name.startsWith('x-ms-'))
    .sort()
    .map((name) => `${name}:${String(headers[name]).trim()}`)
    .join('\n');
  let canonicalizedResource = `/${accountName}${pathname}`;
  for (const [name, value] of query) {
    canonicalizedResource += `\n${name.toLowerCase()}:${value}`;
  }
  const stringToSign = [
    method,
    '',
    '',
    contentType,
    '',
    canonicalizedHeaders,
    canonicalizedResource
  ].join('\n');
  return crypto.createHmac('sha256', Buffer.from(accountKey, 'base64'))
    .update(stringToSign, 'utf8')
    .digest('base64');
}

function tableUrl(accountName, table, target, query) {
  const url = new URL(`https://${accountName}.table.core.windows.net/${table}${target}`);
  for (const [name, value] of query ?? []) url.searchParams.set(name, value);
  return url;
}

async function tableRequest(options) {
  const {
    accountName, accountKey, method, table, target = '', query = [],
    body, fetchImpl = fetch
  } = options;
  const url = tableUrl(accountName, table, target, query);
  const date = new Date().toUTCString();
  const headers = {
    'x-ms-date': date,
    'x-ms-version': TABLE_API_VERSION,
    Accept: 'application/json;odata=nometadata'
  };
  let contentType = '';
  if (body !== undefined) {
    contentType = 'application/json;odata=nometadata';
    headers['Content-Type'] = contentType;
  }
  const authorization = `SharedKey ${accountName}:${sharedKeySignature(
    accountName, accountKey, method, url.pathname, contentType, date, headers, [...url.searchParams]
  )}`;
  headers.Authorization = authorization;
  const response = await fetchImpl(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = response.headers.get('content-length') === '0' ? '' : await response.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  return { status: response.status, json };
}

// OData-egenskaper: alla värden skickas som strängar för enkelhetens skull.
function toEntity(record, partition) {
  return {
    PartitionKey: partition,
    RowKey: record.idempotencyKey,
    reference: record.reference,
    status: record.status,
    arrival: record.arrival,
    departure: record.departure,
    nights: String(record.nights),
    guests: String(record.guests),
    firstName: record.firstName,
    lastName: record.lastName,
    email: record.email,
    phone: record.phone,
    company: record.company ?? '',
    message: record.message ?? '',
    addons: JSON.stringify(record.addons),
    totalAddons: String(record.totalAddons),
    rulesVersion: record.rulesVersion,
    consentContact: String(record.consentContact),
    createdAt: record.createdAt
  };
}

function fromEntity(entity) {
  return {
    idempotencyKey: entity.RowKey,
    reference: entity.reference,
    status: entity.status,
    arrival: entity.arrival,
    departure: entity.departure,
    nights: Number(entity.nights),
    guests: Number(entity.guests),
    firstName: entity.firstName,
    lastName: entity.lastName,
    email: entity.email,
    phone: entity.phone,
    company: entity.company || '',
    message: entity.message || '',
    addons: JSON.parse(entity.addons),
    totalAddons: Number(entity.totalAddons),
    rulesVersion: entity.rulesVersion,
    consentContact: entity.consentContact === 'true',
    createdAt: entity.createdAt
  };
}

function createTableStore(options = {}) {
  const accountName = options.accountName ?? process.env.AZURE_STORAGE_ACCOUNT_NAME;
  const accountKey = options.accountKey ?? process.env.AZURE_STORAGE_KEY;
  const table = options.table ?? process.env.AZURE_TABLE_NAME ?? 'bookingrequests';
  if (!accountName || !accountKey) {
    throw new Error('Azure Table Storage är inte konfigurerat');
  }
  return {
    type: 'azure-table',
    async save(record, context = {}) {
      const result = await tableRequest({
        accountName, accountKey, method: 'POST', table, body: toEntity(record, 'request'),
        fetchImpl: options.fetchImpl
      });
      if (result.status === 201) return { duplicate: false, record };
      if (result.status === 409) {
        const existing = await tableRequest({
          accountName, accountKey, method: 'GET', table,
          target: `(PartitionKey='request',RowKey='${encodeURIComponent(record.idempotencyKey)}')`,
          fetchImpl: options.fetchImpl
        });
        if (existing.status === 200 && existing.json) return { duplicate: true, record: fromEntity(existing.json) };
        throw new Error('Dubbelkontroll av sparad förfrågan misslyckades');
      }
      context.warn?.(`Azure Table Storage svarade ${result.status} vid sparande.`);
      throw new Error('Förfrågan kunde inte sparas');
    },
    async findByIdempotencyKey(key) {
      const result = await tableRequest({
        accountName, accountKey, method: 'GET', table,
        target: `(PartitionKey='request',RowKey='${encodeURIComponent(key)}')`,
        fetchImpl: options.fetchImpl
      });
      return result.status === 200 && result.json ? fromEntity(result.json) : null;
    }
  };
}

// --- Lokal JSONL-fil: ENDAST utveckling/test, inte permanent lagring ---

function createLocalStore(options = {}) {
  const file = path.resolve(options.file ?? path.join(process.cwd(), 'data', 'booking-requests.jsonl'));
  const records = new Map();
  let loaded = false;
  async function loadOnce(context = {}) {
    if (loaded) return;
    loaded = true;
    try {
      const raw = await fsp.readFile(file, 'utf8');
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue;
        const record = JSON.parse(line);
        records.set(record.idempotencyKey, record);
      }
    } catch {
      // Ingen fil ännu.
    }
    context.warn?.('BOKNINGSLAGRING: lokal fil används — konfigurera Azure Table Storage innan riktiga förfrågningar tas emot.');
  }
  return {
    type: 'local-jsonl',
    file,
    async save(record, context = {}) {
      await loadOnce(context);
      if (records.has(record.idempotencyKey)) {
        return { duplicate: true, record: records.get(record.idempotencyKey) };
      }
      records.set(record.idempotencyKey, record);
      await fsp.mkdir(path.dirname(file), { recursive: true });
      await fsp.appendFile(file, `${JSON.stringify(record)}\n`, 'utf8');
      return { duplicate: false, record };
    },
    async findByIdempotencyKey(key) {
      await loadOnce();
      return records.get(key) ?? null;
    }
  };
}

// Väljer backend enligt miljön (azure om konfigurerat, annars lokal fil).
function createStore(options = {}) {
  if (options.store) return options.store;
  if (options.forceLocal || !isConfigured()) return createLocalStore(options.local);
  return createTableStore({ fetchImpl: options.fetchImpl });
}

module.exports = { createStore, createTableStore, createLocalStore, isConfigured, sharedKeySignature, toEntity, fromEntity };
