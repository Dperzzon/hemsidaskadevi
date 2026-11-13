'use strict';

// Lagring för bokningsförfrågningar i Azure Table Storage.
//
// AUTENTISERING: Microsoft Entra (Managed Identity) föredras framför SharedKey.
// På Azure App Service hämtas en åtkomsttoken via instansens Managed Identity
// (IDENTITY_ENDPOINT/IDENTITY_HEADER, system- eller user-assigned via
// AZURE_CLIENT_ID). Även client credentials stöds (hemligheter enbart via
// miljö/Key Vault — aldrig i koden). SharedKey behålls som bakåtkompatibel
// reserv, men rekommenderas inte och bör stängas av i lagringskontot
// (se infra/modules/storage-tables.bicep: sharedKeyAccessKey = false).
//
// RBAC (minsta möjliga behörighet): "Storage Table Data Contributor" på
// tabellnivå för webbappens och Logic Appens managed identities — tilldelas
// via infra/, aldrig manuellt.
//
// Bokningsinskick hålls avstängt tills hela kedjan är verifierad
// (se requests.js: BOOKING_REQUESTS_ENABLED).
//
// Inga fler personuppgifter än nödvändigt lagras (ingen IP, inga loggar).

const crypto = require('node:crypto');
const fsp = require('node:fs/promises');
const path = require('node:path');

const TABLE_API_VERSION_SHAREDKEY = '2021-10-04';
const TABLE_API_VERSION_OAUTH = '2019-02-02'; // lägsta version som stöder Entra-tokens
const MANAGED_IDENTITY_SCOPE_SUFFIX = '/.default';

// --- Hanterad identitet (Microsoft Entra) ---

// Hämtar en åtkomsttoken via App Service Managed Identity. Injektion via
// options.identity används i tester.
function createManagedIdentityTokenProvider(options = {}) {
  const endpoint = options.identityEndpoint ?? process.env.IDENTITY_ENDPOINT;
  const header = options.identityHeader ?? process.env.IDENTITY_HEADER;
  const clientId = options.clientId ?? process.env.AZURE_CLIENT_ID;
  const scope = options.scope ?? 'https://storage.azure.com/';
  return {
    type: 'app-service-managed-identity',
    async getToken() {
      if (!endpoint || !header) throw new Error('Managed Identity är inte tillgänglig i denna miljö');
      const url = new URL(endpoint);
      url.searchParams.set('api-version', '2019-08-01');
      url.searchParams.set('resource', scope);
      if (clientId) url.searchParams.set('client_id', clientId);
      const response = await (options.fetchImpl ?? fetch)(url, {
        method: 'GET',
        headers: { 'X-IDENTITY-HEADER': header }
      });
      if (!response.ok) {
        throw new Error(`Managed Identity-tokentjänst svarade ${response.status}`);
      }
      const token = await response.json();
      if (!token.access_token) throw new Error('Tokentjänsten saknade access_token');
      return {
        accessToken: token.access_token,
        expiresOn: Number(token.expires_on) || (Math.floor(Date.now() / 1000) + 3600)
      };
    }
  };
}

function createTokenCache(provider) {
  let cached = null;
  return {
    async getToken() {
      if (cached && cached.expiresOn > Math.floor(Date.now() / 1000) + 60) {
        return cached;
      }
      cached = await provider.getToken();
      return cached;
    },
    reset() { cached = null; }
  };
}

function hasManagedIdentity(options = {}) {
  const endpoint = options.identityEndpoint ?? process.env.IDENTITY_ENDPOINT;
  const header = options.identityHeader ?? process.env.IDENTITY_HEADER;
  return Boolean(endpoint && header);
}

// --- SharedKey (bakåtkompatibel reserv) ---

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
  // query är par [namn, värde] med avkodade värden; kodningen sker här så att
  // SharedKey-signaturen exakt motsvarar vad som skickas på tråden.
  const url = new URL(`https://${accountName}.table.core.windows.net/${table}${target}`);
  const encoded = (query ?? [])
    .map(([name, value]) => `${encodeURIComponent(name)}=${encodeURIComponent(value)}`)
    .join('&');
  if (encoded) url.search = `?${encoded}`;
  return url;
}

async function tableRequest(options) {
  const {
    accountName, method, table, target = '', query = [],
    body, fetchImpl = fetch, auth
  } = options;
  const url = tableUrl(accountName, table, target, query);
  // Kodade frågepar för signaturbygget (matchar exakt URL:n på tråden).
  const encodedQuery = (query ?? []).map(([name, value]) => [name, encodeURIComponent(value)]);
  const headers = {
    Accept: 'application/json;odata=nometadata'
  };
  if (auth.mode === 'managed-identity') {
    const token = await auth.tokens.getToken();
    headers.Authorization = `Bearer ${token.accessToken}`;
    headers['x-ms-version'] = TABLE_API_VERSION_OAUTH;
  } else {
    const date = new Date().toUTCString();
    headers['x-ms-date'] = date;
    headers['x-ms-version'] = TABLE_API_VERSION_SHAREDKEY;
    headers.Authorization = `SharedKey ${accountName}:${sharedKeySignature(
      accountName, auth.accountKey, method, url.pathname, '', date, headers, encodedQuery
    )}`;
  }
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json;odata=nometadata';
  }
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
    statusCode: record.statusCode ?? '',
    version: String(record.version ?? 1),
    arrival: record.arrival,
    departure: record.departure,
    nights: String(record.nights),
    guests: String(record.guests),
    firstName: record.firstName,
    lastName: record.lastName,
    email: record.email,
    replyTo: record.replyTo ?? '',
    phone: record.phone,
    company: record.company ?? '',
    message: record.message ?? '',
    bookingSource: record.bookingSource ?? 'WEB',
    addons: JSON.stringify(record.addons),
    totalAddons: String(record.totalAddons),
    discount: record.discount ? JSON.stringify(record.discount) : '',
    // Serverberäknad prisoffert (verifierbar prisuppdelning + total + version).
    lodgingBase: String(record.lodgingBase ?? 0),
    lodgingAfterDiscount: String(record.lodgingAfterDiscount ?? 0),
    total: String(record.total ?? 0),
    calculatedTotal: String(record.calculatedTotal ?? record.total ?? 0),
    agreedTotal: record.agreedTotal === undefined || record.agreedTotal === null ? '' : String(record.agreedTotal),
    priceAdjustmentReason: record.priceAdjustmentReason ?? '',
    priceVersion: record.priceVersion ?? '',
    pricing: JSON.stringify({
      nightlyBreakdown: record.nightlyBreakdown ?? [],
      peakNights: record.peakNights ?? 0,
      peakBase: record.peakBase ?? 0,
      discountAmount: record.discountAmount ?? 0,
      addonLines: record.addonLines ?? []
    }),
    originalPricing: record.originalPricing ? JSON.stringify(record.originalPricing) : '',
    rulesVersion: record.rulesVersion,
    consentContact: String(record.consentContact),
    paymentStatus: record.paymentStatus ?? (Number(record.total) > 0 ? 'UNPAID' : 'UNKNOWN'),
    amountPaid: String(record.amountPaid ?? 0),
    balance: String(record.balance ?? (Number(record.total) - Number(record.amountPaid ?? 0))),
    latestNote: record.latestNote ?? '',
    blockId: record.blockId ?? '',
    airbnbBlockedAt: record.airbnbBlockedAt ?? '',
    airbnbOverride: String(record.airbnbOverride === true),
    airbnbOverrideReason: record.airbnbOverrideReason ?? '',
    airbnbOverrideApprovedBy: record.airbnbOverrideApprovedBy ?? '',
    airbnbOverrideApprovedAt: record.airbnbOverrideApprovedAt ?? '',
    airbnbBlockedNights: JSON.stringify(record.airbnbBlockedNights ?? []),
    confirmedAt: record.confirmedAt ?? '',
    declinedAt: record.declinedAt ?? '',
    cancelledAt: record.cancelledAt ?? '',
    updatedAt: record.updatedAt ?? '',
    updatedBy: record.updatedBy ?? '',
    attemptCount: String(record.attemptCount ?? 0),
    attemptedAt: record.attemptedAt ?? '',
    sentAt: record.sentAt ?? '',
    createdAt: record.createdAt
  };
}

function fromEntity(entity) {
  const parse = (value, fallback) => {
    if (!value) return fallback;
    try { return JSON.parse(value); } catch { return fallback; }
  };
  return {
    idempotencyKey: entity.RowKey,
    rowKey: entity.RowKey,
    reference: entity.reference,
    status: entity.status,
    statusCode: entity.statusCode || '',
    version: Number(entity.version ?? 1),
    arrival: entity.arrival,
    departure: entity.departure,
    nights: Number(entity.nights),
    guests: Number(entity.guests),
    firstName: entity.firstName,
    lastName: entity.lastName,
    email: entity.email,
    replyTo: entity.replyTo || '',
    phone: entity.phone,
    company: entity.company || '',
    message: entity.message || '',
    bookingSource: entity.bookingSource || 'WEB',
    addons: parse(entity.addons, {}),
    totalAddons: Number(entity.totalAddons),
    discount: parse(entity.discount, null),
    lodgingBase: Number(entity.lodgingBase ?? 0),
    lodgingAfterDiscount: Number(entity.lodgingAfterDiscount ?? 0),
    total: Number(entity.total ?? 0),
    calculatedTotal: Number(entity.calculatedTotal ?? entity.total ?? 0),
    agreedTotal: entity.agreedTotal === '' || entity.agreedTotal === undefined ? null : Number(entity.agreedTotal),
    priceAdjustmentReason: entity.priceAdjustmentReason ?? '',
    priceVersion: entity.priceVersion ?? '',
    pricing: parse(entity.pricing, null),
    originalPricing: parse(entity.originalPricing, null),
    rulesVersion: entity.rulesVersion,
    consentContact: entity.consentContact === 'true',
    paymentStatus: entity.paymentStatus || (Number(entity.total) > 0 ? 'UNPAID' : 'UNKNOWN'),
    amountPaid: Number(entity.amountPaid ?? 0),
    balance: Number(entity.balance ?? (Number(entity.total) - Number(entity.amountPaid ?? 0))),
    latestNote: entity.latestNote ?? '',
    blockId: entity.blockId ?? '',
    airbnbBlockedAt: entity.airbnbBlockedAt ?? '',
    airbnbOverride: entity.airbnbOverride === 'true' || entity.airbnbOverride === true,
    airbnbOverrideReason: entity.airbnbOverrideReason ?? '',
    airbnbOverrideApprovedBy: entity.airbnbOverrideApprovedBy ?? '',
    airbnbOverrideApprovedAt: entity.airbnbOverrideApprovedAt ?? '',
    airbnbBlockedNights: parse(entity.airbnbBlockedNights, []),
    confirmedAt: entity.confirmedAt ?? '',
    declinedAt: entity.declinedAt ?? '',
    cancelledAt: entity.cancelledAt ?? '',
    updatedAt: entity.updatedAt ?? '',
    updatedBy: entity.updatedBy ?? '',
    attemptCount: Number(entity.attemptCount ?? 0),
    attemptedAt: entity.attemptedAt ?? '',
    sentAt: entity.sentAt ?? '',
    createdAt: entity.createdAt
  };
}

function rowTarget(partition, rowKey) {
  return `(PartitionKey='${partition}',RowKey='${encodeURIComponent(rowKey)}')`;
}

function createTableStore(options = {}) {
  const accountName = options.accountName ?? process.env.AZURE_STORAGE_ACCOUNT_NAME;
  const table = options.table ?? process.env.AZURE_TABLE_NAME ?? 'bookingrequests';
  const accountKey = options.accountKey ?? process.env.AZURE_STORAGE_KEY;
  let mode = options.authMode;
  if (!mode) mode = hasManagedIdentity(options) ? 'managed-identity' : 'shared-key';
  if (!accountName) throw new Error('Azure Table Storage är inte konfigurerat');
  if (mode === 'managed-identity') {
    const provider = options.tokenProvider ?? createManagedIdentityTokenProvider(options);
    var tokens = createTokenCache(provider);
  } else if (mode === 'shared-key' && accountKey) {
    // SharedKey-används bara som uttryckligt vald reserv.
  } else {
    throw new Error('Azure Table Storage: varken Managed Identity eller nyckel är konfigurerat');
  }
  const auth = mode === 'managed-identity'
    ? { mode, tokens }
    : { mode, accountKey };
  return {
    type: 'azure-table',
    authMode: mode,
    async save(record, context = {}) {
      const isOutbox = record.partition === 'outbox';
      const result = await tableRequest({
        accountName, method: 'POST', table,
        body: isOutbox ? toOutboxEntity(record) : toEntity(record, 'request'),
        fetchImpl: options.fetchImpl, auth
      });
      if (result.status === 201) return { duplicate: false, record };
      if (result.status === 409) {
        const existing = await tableRequest({
          accountName, method: 'GET', table,
          target: rowTarget(isOutbox ? 'outbox' : 'request', record.idempotencyKey),
          fetchImpl: options.fetchImpl, auth
        });
        if (existing.status === 200 && existing.json) {
          return { duplicate: true, record: isOutbox ? fromOutboxEntity(existing.json) : fromEntity(existing.json) };
        }
        throw new Error('Dubbelkontroll av sparad förfrågan misslyckades');
      }
      context.warn?.(`Azure Table Storage svarade ${result.status} vid sparande.`);
      throw new Error('Förfrågan kunde inte sparas');
    },
    async findByIdempotencyKey(key) {
      const result = await tableRequest({
        accountName, method: 'GET', table, target: rowTarget('request', key),
        fetchImpl: options.fetchImpl, auth
      });
      return result.status === 200 && result.json ? fromEntity(result.json) : null;
    },
    async findByReference(reference) {
      const result = await tableRequest({
        accountName, method: 'GET', table,
        query: [['$filter', `reference eq '${reference}'`]],
        fetchImpl: options.fetchImpl, auth
      });
      if (result.status !== 200 || !result.json?.value) return null;
      return result.json.value.length ? fromEntity(result.json.value[0]) : null;
    },
    async listPending() {
      const result = await tableRequest({
        accountName, method: 'GET', table,
        query: [['$filter', `PartitionKey eq 'request' and status eq 'Inväntar godkännande'`]],
        fetchImpl: options.fetchImpl, auth
      });
      return result.status === 200 && result.json?.value ? result.json.value.map(fromEntity) : [];
    },
    // Gallring: tar bort request- och utkorgsposter äldre än tröskeln
    // (bör köras som schemalagd rutin, se scripts/purge-old-bookings.mjs).
    async purgeOlderThan(thresholdIso, context = {}) {
      let purged = 0;
      for (const partition of ['request', 'outbox']) {
        const result = await tableRequest({
          accountName, method: 'GET', table,
          query: [['$filter', `PartitionKey eq '${partition}' and createdAt lt datetime'${thresholdIso}'`]],
          fetchImpl: options.fetchImpl, auth
        });
        if (result.status !== 200 || !result.json?.value) {
          context.warn?.(`Gallring: fråga mot ${partition} misslyckades (${result.status}).`);
          continue;
        }
        for (const entity of result.json.value) {
          const removed = await tableRequest({
            accountName, method: 'DELETE', table,
            target: rowTarget(partition, entity.RowKey),
            fetchImpl: options.fetchImpl, auth
          });
          if (removed.status === 204) purged += 1;
        }
      }
      return purged;
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
    },
    async findByReference(reference) {
      await loadOnce();
      return [...records.values()].find((record) => record.reference === reference) ?? null;
    },
    async listPending() {
      await loadOnce();
      return [...records.values()].filter((record) => record.status === 'Inväntar godkännande');
    },
    async purgeOlderThan(thresholdIso, context = {}) {
      await loadOnce(context);
      let purged = 0;
      for (const [key, record] of records) {
        if (record.createdAt < thresholdIso) {
          records.delete(key);
          purged += 1;
        }
      }
      if (purged > 0) {
        await fsp.mkdir(path.dirname(file), { recursive: true });
        await fsp.writeFile(file, [...records.values()].map((record) => JSON.stringify(record)).join('\n') + '\n', 'utf8');
      }
      return purged;
    }
  };
}

// Utkorgsposter (för Logic Apps): separata partition med komplett mejlinnehåll.
// Body är servergenererad och HTML-escapad — Logic Apps skriver aldrig själv
// ut gästuppgifter, vilket håller körens historik ren från oprövad logik.
function toOutboxEntity(record) {
  return {
    PartitionKey: 'outbox',
    RowKey: record.idempotencyKey,
    reference: record.reference ?? '',
    mailType: record.mailType ?? '',
    status: record.status ?? 'Utkorg',
    mailTo: record.mailTo,
    mailReplyTo: record.mailReplyTo ?? '',
    mailSubject: record.mailSubject,
    mailHtml: record.mailHtml,
    mailText: record.mailText ?? '',
    dispatchEligible: record.dispatchEligible === true || record.dispatchEligible === 'true' ? 'true' : '',
    outboxVersion: record.outboxVersion ?? '',
    deliveryStatus: record.deliveryStatus ?? '',
    'attemptCount@odata.type': 'Edm.Int32',
    attemptCount: Number(record.attemptCount ?? 0),
    attemptedAt: record.attemptedAt ?? '',
    sentAt: record.sentAt ?? '',
    createdAt: record.createdAt
  };
}

function fromOutboxEntity(entity) {
  return {
    idempotencyKey: entity.RowKey,
    reference: entity.reference ?? '',
    mailType: entity.mailType ?? '',
    status: entity.status,
    mailTo: entity.mailTo,
    mailReplyTo: entity.mailReplyTo || '',
    mailSubject: entity.mailSubject,
    mailHtml: entity.mailHtml,
    mailText: entity.mailText ?? '',
    dispatchEligible: entity.dispatchEligible ?? '',
    outboxVersion: entity.outboxVersion ?? '',
    deliveryStatus: entity.deliveryStatus ?? '',
    attemptCount: Number(entity.attemptCount ?? 0),
    attemptedAt: entity.attemptedAt ?? '',
    sentAt: entity.sentAt ?? '',
    createdAt: entity.createdAt
  };
}

// Väljer backend enligt miljön (azure om konfigurerat, annars lokal fil).
function createStore(options = {}) {
  if (options.store) return options.store;
  if (options.forceLocal || !isConfigured(options)) return createLocalStore(options.local);
  return createTableStore({ fetchImpl: options.fetchImpl, authMode: options.authMode });
}

function isConfigured(options = {}) {
  if (options.accountName ?? process.env.AZURE_STORAGE_ACCOUNT_NAME) {
    return hasManagedIdentity(options) || Boolean(options.accountKey ?? process.env.AZURE_STORAGE_KEY);
  }
  return false;
}

module.exports = {
  createStore, createTableStore, createLocalStore, isConfigured, sharedKeySignature,
  toEntity, fromEntity, toOutboxEntity, fromOutboxEntity,
  createManagedIdentityTokenProvider, createTokenCache, hasManagedIdentity,
  MANAGED_IDENTITY_SCOPE_SUFFIX
};
