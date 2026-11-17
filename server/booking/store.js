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
    body, fetchImpl = fetch, auth, ifMatch, ifNoneMatch, headers: extraHeaders
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
  if (ifMatch !== undefined) headers['If-Match'] = ifMatch;
  if (ifNoneMatch !== undefined) headers['If-None-Match'] = ifNoneMatch;
  if (extraHeaders) Object.assign(headers, extraHeaders);
  const response = await fetchImpl(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const contentLength = response.headers?.get?.('content-length');
  const text = contentLength === '0' ? '' : await response.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  return {
    status: response.status,
    json,
    etag: response.headers?.get?.('etag') ?? response.headers?.get?.('ETag') ?? ''
  };
}

// OData-egenskaper: alla värden skickas som strängar för enkelhetens skull.
function toEntity(record, partition) {
  return {
    PartitionKey: partition,
    RowKey: record.rowKey ?? record.idempotencyKey,
    reference: record.reference,
    status: record.status,
    statusCode: record.statusCode ?? '',
    version: String(record.version ?? 1),
    arrival: record.arrival,
    departure: record.departure,
    nights: String(record.nights),
    guests: String(record.guests),
    totalGuests: String(record.totalGuests ?? record.guests ?? 0),
    extrahus: record.extrahus ? JSON.stringify(record.extrahus) : '',
    firstName: record.firstName,
    lastName: record.lastName,
    email: record.email,
    replyTo: record.replyTo ?? '',
    phone: record.phone,
    company: record.company ?? '',
    message: record.message ?? '',
    bookingSource: record.bookingSource ?? 'WEB',
    directBookingApprovalId: String(record.directBookingApprovalId ?? ''),
    directBookingApprovals: JSON.stringify(record.directBookingApprovals ?? []),
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
    paymentOpeningBalanceOre: String(record.paymentOpeningBalanceOre ?? ''),
    payments: JSON.stringify(record.payments ?? []),
    paymentRequests: JSON.stringify(record.paymentRequests ?? []),
    paymentRequest: record.paymentRequest ? JSON.stringify(record.paymentRequest) : '',
    paymentTokenHash: String(record.paymentTokenHash ?? ''),
    paymentAccess: record.paymentAccess ? JSON.stringify(record.paymentAccess) : '',
    reservation: record.reservation ? JSON.stringify(record.reservation) : '',
    reconciliation: record.reconciliation ? JSON.stringify(record.reconciliation) : '',
    invoiceRequests: JSON.stringify(record.invoiceRequests ?? []),
    latestNote: record.latestNote ?? '',
    blockId: record.blockId ?? '',
    airbnbBlockedAt: record.airbnbBlockedAt ?? '',
    airbnbOverride: String(record.airbnbOverride === true),
    airbnbOverrideReason: record.airbnbOverrideReason ?? '',
    airbnbOverrideApprovedBy: record.airbnbOverrideApprovedBy ?? '',
    airbnbOverrideApprovedAt: record.airbnbOverrideApprovedAt ?? '',
    airbnbBlockedNights: JSON.stringify(record.airbnbBlockedNights ?? []),
    airbnbOverrideFingerprint: record.airbnbOverrideFingerprint ?? '',
    airbnbVerification: record.airbnbVerification ? JSON.stringify(record.airbnbVerification) : '',
    warningAcknowledgements: JSON.stringify(record.warningAcknowledgements ?? []),
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

const CALENDAR_SYNC_PARTITION = 'calendarsync';
const CALENDAR_SYNC_ROW = 'airbnb';

function fromCalendarSyncEntity(entity) {
  if (!entity) return null;
  return {
    status: entity.status ?? 'error',
    lastCheckAt: entity.lastCheckAt ?? '',
    lastSuccessAt: entity.lastSuccessAt ?? '',
    lastErrorAt: entity.lastErrorAt ?? '',
    lastErrorCode: entity.lastErrorCode ?? '',
    consecutiveFailures: Number(entity.consecutiveFailures ?? 0),
    blockedNights: Number(entity.blockedNights ?? 0),
    nightsChecked: Number(entity.nightsChecked ?? 0),
    conflicts: (() => {
      try {
        const value = JSON.parse(entity.conflicts ?? '[]');
        return Array.isArray(value) ? value : [];
      } catch {
        return [];
      }
    })(),
    source: entity.source ?? '',
    checkedFrom: entity.checkedFrom ?? '',
    checkedTo: entity.checkedTo ?? '',
    etag: entity['odata.etag'] ?? entity.etag ?? ''
  };
}

function calendarSyncEntity(data) {
  return {
    PartitionKey: CALENDAR_SYNC_PARTITION,
    RowKey: CALENDAR_SYNC_ROW,
    status: data.status === 'ok' ? 'ok' : 'error',
    lastCheckAt: data.lastCheckAt ?? '',
    lastSuccessAt: data.lastSuccessAt ?? '',
    lastErrorAt: data.lastErrorAt ?? '',
    lastErrorCode: data.lastErrorCode ?? '',
    consecutiveFailures: String(data.consecutiveFailures ?? 0),
    blockedNights: String(data.blockedNights ?? 0),
    nightsChecked: String(data.nightsChecked ?? 0),
    conflicts: JSON.stringify(Array.isArray(data.conflicts) ? data.conflicts : []),
    source: data.source ?? '',
    checkedFrom: data.checkedFrom ?? '',
    checkedTo: data.checkedTo ?? ''
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
    totalGuests: Number(entity.totalGuests ?? entity.guests ?? 0),
    extrahus: parse(entity.extrahus, null),
    firstName: entity.firstName,
    lastName: entity.lastName,
    email: entity.email,
    replyTo: entity.replyTo || '',
    phone: entity.phone,
    company: entity.company || '',
    message: entity.message || '',
    bookingSource: entity.bookingSource || 'WEB',
    directBookingApprovalId: entity.directBookingApprovalId ?? '',
    directBookingApprovals: parse(entity.directBookingApprovals, []),
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
    paymentOpeningBalanceOre: entity.paymentOpeningBalanceOre === '' || entity.paymentOpeningBalanceOre === undefined
      ? null
      : Number(entity.paymentOpeningBalanceOre),
    payments: parse(entity.payments, []),
    paymentRequests: parse(entity.paymentRequests, []),
    paymentRequest: parse(entity.paymentRequest, null),
    paymentTokenHash: entity.paymentTokenHash ?? '',
    paymentAccess: parse(entity.paymentAccess, null),
    reservation: parse(entity.reservation, null),
    reconciliation: parse(entity.reconciliation, null),
    invoiceRequests: parse(entity.invoiceRequests, []),
    latestNote: entity.latestNote ?? '',
    blockId: entity.blockId ?? '',
    airbnbBlockedAt: entity.airbnbBlockedAt ?? '',
    airbnbOverride: entity.airbnbOverride === 'true' || entity.airbnbOverride === true,
    airbnbOverrideReason: entity.airbnbOverrideReason ?? '',
    airbnbOverrideApprovedBy: entity.airbnbOverrideApprovedBy ?? '',
    airbnbOverrideApprovedAt: entity.airbnbOverrideApprovedAt ?? '',
    airbnbBlockedNights: parse(entity.airbnbBlockedNights, []),
    airbnbOverrideFingerprint: entity.airbnbOverrideFingerprint ?? '',
    airbnbVerification: parse(entity.airbnbVerification, null),
    warningAcknowledgements: parse(entity.warningAcknowledgements, []),
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

// Huvudbyggnaden och extrahuset har separata kalenderpartitioner. Samma natt
// kan därför bokas på båda resurserna utan att den ena blockerar den andra.
function calendarPartition(resource) {
  return resource === 'extrahus' ? 'calendar-extrahus' : 'calendar';
}

function calendarResourceOf(partition) {
  return partition === 'calendar-extrahus' ? 'extrahus' : 'main';
}

function escapeOData(value) {
  return String(value ?? '').replaceAll("'", "''");
}

function fromDirectBookingEntity(entity) {
  return {
    night: entity.RowKey,
    status: entity.status ?? 'CLOSED',
    approvalId: entity.approvalId ?? '',
    from: entity.from ?? '',
    to: entity.to ?? '',
    approvedBy: entity.approvedBy ?? '',
    approvedById: entity.approvedById ?? '',
    approvedAt: entity.approvedAt ?? '',
    note: entity.note ?? '',
    airbnbBlockedNights: entity.airbnbBlockedNights ?? '[]',
    airbnbCheckedAt: entity.airbnbCheckedAt ?? '',
    closedBy: entity.closedBy ?? '',
    closedById: entity.closedById ?? '',
    closedAt: entity.closedAt ?? '',
    createdAt: entity.createdAt ?? '',
    updatedAt: entity.updatedAt ?? '',
    updatedBy: entity.updatedBy ?? '',
    etag: entity['odata.etag'] ?? entity.etag ?? ''
  };
}

function directBookingEntity(night, data) {
  return {
    PartitionKey: 'directbooking',
    RowKey: night,
    status: data.status ?? 'CLOSED',
    approvalId: data.approvalId ?? '',
    from: data.from ?? '',
    to: data.to ?? '',
    approvedBy: data.approvedBy ?? '',
    approvedById: data.approvedById ?? '',
    approvedAt: data.approvedAt ?? '',
    note: data.note ?? '',
    airbnbBlockedNights: data.airbnbBlockedNights ?? '[]',
    airbnbCheckedAt: data.airbnbCheckedAt ?? '',
    closedBy: data.closedBy ?? '',
    closedById: data.closedById ?? '',
    closedAt: data.closedAt ?? '',
    createdAt: data.createdAt ?? new Date().toISOString(),
    updatedAt: data.updatedAt ?? new Date().toISOString(),
    updatedBy: data.updatedBy ?? ''
  };
}

function groupDirectBookingApprovals(rows) {
  const groups = new Map();
  for (const row of rows) {
    if (!row.approvalId) continue;
    if (!groups.has(row.approvalId)) {
      groups.set(row.approvalId, {
        approvalId: row.approvalId,
        from: row.from,
        to: row.to,
        nights: [],
        approvedBy: row.approvedBy,
        approvedById: row.approvedById,
        approvedAt: row.approvedAt,
        note: row.note,
        airbnbCheckedAt: row.airbnbCheckedAt,
        status: row.status,
        closedBy: row.closedBy,
        closedById: row.closedById,
        closedAt: row.closedAt
      });
    }
    const group = groups.get(row.approvalId);
    group.nights.push(row.night);
    if (row.status === 'OPEN') group.status = 'OPEN';
    if (row.closedAt && !group.closedAt) {
      group.closedBy = row.closedBy;
      group.closedById = row.closedById;
      group.closedAt = row.closedAt;
    }
  }
  return [...groups.values()]
    .map((group) => ({ ...group, nights: group.nights.sort() }))
    .sort((a, b) => String(b.approvedAt).localeCompare(String(a.approvedAt)));
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
    async getByReference(reference) {
      const safe = String(reference ?? '').replaceAll("'", "''");
      const result = await tableRequest({
        accountName, method: 'GET', table,
        query: [['$filter', `PartitionKey eq 'request' and reference eq '${safe}'`]],
        fetchImpl: options.fetchImpl, auth
      });
      if (result.status !== 200 || !Array.isArray(result.json?.value) || !result.json.value.length) {
        return null;
      }
      const row = result.json.value[0];
      const single = await tableRequest({
        accountName, method: 'GET', table,
        target: rowTarget('request', row.RowKey),
        fetchImpl: options.fetchImpl, auth
      });
      if (single.status !== 200 || !single.json) return null;
      return { record: fromEntity(single.json), etag: single.etag };
    },
    async getByPaymentTokenHash(tokenHash) {
      const safe = String(tokenHash ?? '').replaceAll("'", "''");
      if (!/^[0-9a-f]{64}$/i.test(safe)) return null;
      const result = await tableRequest({
        accountName, method: 'GET', table,
        query: [['$filter', `PartitionKey eq 'request' and paymentTokenHash eq '${safe}'`]],
        fetchImpl: options.fetchImpl, auth
      });
      if (result.status !== 200 || !Array.isArray(result.json?.value) || !result.json.value.length) {
        return null;
      }
      const row = result.json.value[0];
      const single = await tableRequest({
        accountName, method: 'GET', table,
        target: rowTarget('request', row.RowKey),
        fetchImpl: options.fetchImpl, auth
      });
      if (single.status !== 200 || !single.json) return null;
      return { record: fromEntity(single.json), etag: single.etag };
    },
    async listCalendarByReference(reference) {
      const safe = String(reference ?? '').replaceAll("'", "''");
      const result = await tableRequest({
        accountName, method: 'GET', table,
        query: [['$filter', `(PartitionKey eq 'calendar' or PartitionKey eq 'calendar-extrahus') and reference eq '${safe}'`]],
        fetchImpl: options.fetchImpl, auth
      });
      if (result.status !== 200 || !Array.isArray(result.json?.value)) {
        return null;
      }
      return result.json.value.map((row) => ({
        night: row.RowKey,
        resource: calendarResourceOf(row.PartitionKey),
        type: row.type ?? '',
        reference: row.reference ?? '',
        blockId: row.blockId ?? '',
        source: row.source ?? '',
        note: row.note ?? '',
        createdBy: row.createdBy ?? '',
        createdAt: row.createdAt ?? '',
        etag: row['odata.etag'] ?? row.etag ?? ''
      }));
    },
    async listCalendar(from, to) {
      const safeFrom = String(from ?? '').replaceAll("'", "''");
      const safeTo = String(to ?? '').replaceAll("'", "''");
      const result = await tableRequest({
        accountName, method: 'GET', table,
        query: [['$filter', `PartitionKey eq 'calendar' and RowKey ge '${safeFrom}' and RowKey lt '${safeTo}'`]],
        fetchImpl: options.fetchImpl, auth
      });
      if (result.status !== 200 || !Array.isArray(result.json?.value)) {
        return null;
      }
      return result.json.value.map((row) => ({
        night: row.RowKey,
        resource: 'main',
        type: row.type ?? '',
        reference: row.reference ?? '',
        blockId: row.blockId ?? '',
        source: row.source ?? '',
        note: row.note ?? '',
        createdBy: row.createdBy ?? '',
        createdAt: row.createdAt ?? '',
        etag: row['odata.etag'] ?? row.etag ?? ''
      }));
    },
    async listCalendarByResource(resource, from, to) {
      const safeFrom = String(from ?? '').replaceAll("'", "''");
      const safeTo = String(to ?? '').replaceAll("'", "''");
      const partition = calendarPartition(resource);
      const result = await tableRequest({
        accountName, method: 'GET', table,
        query: [['$filter', `PartitionKey eq '${partition}' and RowKey ge '${safeFrom}' and RowKey lt '${safeTo}'`]],
        fetchImpl: options.fetchImpl, auth
      });
      if (result.status !== 200 || !Array.isArray(result.json?.value)) {
        return null;
      }
      return result.json.value.map((row) => ({
        night: row.RowKey,
        resource: calendarResourceOf(partition),
        type: row.type ?? '',
        reference: row.reference ?? '',
        blockId: row.blockId ?? '',
        source: row.source ?? '',
        note: row.note ?? '',
        createdBy: row.createdBy ?? '',
        createdAt: row.createdAt ?? '',
        etag: row['odata.etag'] ?? row.etag ?? ''
      }));
    },
    // Atomisk nattlåsning: Table Storage Insert Entity är create-only. Samma
    // PartitionKey + RowKey ger 409 EntityAlreadyExists, vilket gör att två
    // samtidiga bokningsförsök aldrig kan äga samma natt.
    async createCalendarNight(night, data, { resource } = {}) {
      const partition = calendarPartition(resource);
      const result = await tableRequest({
        accountName, method: 'POST', table,
        body: {
          PartitionKey: partition,
          RowKey: night,
          type: data.type ?? '',
          reference: data.reference ?? '',
          blockId: data.blockId ?? '',
          source: data.source ?? '',
          note: data.note ?? '',
          createdBy: data.createdBy ?? '',
          createdAt: data.createdAt ?? new Date().toISOString()
        },
        fetchImpl: options.fetchImpl, auth
      });
      if (result.status === 409 || result.status === 412) {
        const conflict = new Error('Natten är redan blockerad');
        conflict.status = 409;
        throw conflict;
      }
      if (result.status !== 201) {
        throw new Error(`Kalenderraden kunde inte sparas (${result.status})`);
      }
    },
    // Uppdaterar en befintlig nattlåsning på plats (t.ex. RESERVATION ->
    // BOOKING) utan att radera raden. Därmed finns ingen tidslucka där en
    // annan bokning kan ta datumen.
    async updateCalendarNight(night, data, { ifMatch, resource } = {}) {
      const partition = calendarPartition(resource);
      const result = await tableRequest({
        accountName, method: 'PUT', table,
        target: rowTarget(partition, night),
        body: {
          PartitionKey: partition,
          RowKey: night,
          type: data.type ?? '',
          reference: data.reference ?? '',
          blockId: data.blockId ?? '',
          source: data.source ?? '',
          note: data.note ?? '',
          createdBy: data.createdBy ?? '',
          createdAt: data.createdAt ?? new Date().toISOString()
        },
        ifMatch: ifMatch ?? '*',
        fetchImpl: options.fetchImpl, auth
      });
      if (result.status === 412 || result.status === 409) {
        const conflict = new Error('Kalenderraden har ändrats av någon annan');
        conflict.status = 409;
        throw conflict;
      }
      if (![200, 204].includes(result.status)) {
        throw new Error(`Kalenderraden kunde inte uppdateras (${result.status})`);
      }
    },
    async deleteCalendarNight(night, reference, { resource } = {}) {
      const partition = calendarPartition(resource);
      const single = await tableRequest({
        accountName, method: 'GET', table,
        target: rowTarget(partition, night),
        fetchImpl: options.fetchImpl, auth
      });
      if (single.status === 404) return;
      if (single.status !== 200 || !single.json) {
        throw new Error(`Kalenderraden kunde inte läsas (${single.status})`);
      }
      if (reference && single.json.reference !== reference) {
        const conflict = new Error('Natten tillhör en annan bokning');
        conflict.status = 409;
        throw conflict;
      }
      const removed = await tableRequest({
        accountName, method: 'DELETE', table,
        target: rowTarget(partition, night),
        ifMatch: single.etag || '*',
        fetchImpl: options.fetchImpl, auth
      });
      if (removed.status === 412 || removed.status === 409) {
        const conflict = new Error('Kalenderraden har ändrats av någon annan');
        conflict.status = 409;
        throw conflict;
      }
      if (![200, 204, 404].includes(removed.status)) {
        throw new Error(`Kalenderraden kunde inte tas bort (${removed.status})`);
      }
    },
    // Intern överlappskontroll mot bekräftade bokningar och datumblockeringar.
    // Kalenderpartitionen är den primära låsningen, men denna kontroll fångar
    // även äldre poster som saknar kalenderrader.
    async listBlockingBookings(arrival, departure) {
      const safeArrival = String(arrival ?? '').replaceAll("'", "''");
      const safeDeparture = String(departure ?? '').replaceAll("'", "''");
      const result = await tableRequest({
        accountName, method: 'GET', table,
        query: [['$filter', `PartitionKey eq 'request' and (statusCode eq 'CONFIRMED' or statusCode eq 'BLOCKED') and arrival lt '${safeDeparture}' and departure gt '${safeArrival}'`]],
        fetchImpl: options.fetchImpl, auth
      });
      if (result.status !== 200 || !Array.isArray(result.json?.value)) return null;
      return result.json.value.map(fromEntity);
    },
    async getDirectBookingNight(night) {
      const result = await tableRequest({
        accountName, method: 'GET', table,
        target: rowTarget('directbooking', night),
        fetchImpl: options.fetchImpl, auth
      });
      if (result.status === 404) return null;
      if (result.status !== 200 || !result.json) {
        throw new Error(`Direktbokningsraden kunde inte läsas (${result.status})`);
      }
      return fromDirectBookingEntity(result.json);
    },
    async listDirectBookingNights(from, to) {
      const result = await tableRequest({
        accountName, method: 'GET', table,
        query: [['$filter', `PartitionKey eq 'directbooking' and RowKey ge '${escapeOData(from)}' and RowKey lt '${escapeOData(to)}'`]],
        fetchImpl: options.fetchImpl, auth
      });
      if (result.status !== 200 || !Array.isArray(result.json?.value)) return null;
      return result.json.value.map(fromDirectBookingEntity);
    },
    async upsertDirectBookingNight(night, data) {
      const existing = await this.getDirectBookingNight(night);
      const body = directBookingEntity(night, data);
      if (existing) {
        const result = await tableRequest({
          accountName, method: 'PUT', table,
          target: rowTarget('directbooking', night),
          body,
          ifMatch: existing.etag || '*',
          fetchImpl: options.fetchImpl, auth
        });
        if (result.status === 412 || result.status === 409) {
          const conflict = new Error('Direktbokningsraden har ändrats av någon annan');
          conflict.status = 409;
          throw conflict;
        }
        if (![200, 204].includes(result.status)) {
          throw new Error(`Direktbokningsraden kunde inte uppdateras (${result.status})`);
        }
        return;
      }
      const result = await tableRequest({
        accountName, method: 'POST', table,
        body,
        fetchImpl: options.fetchImpl, auth
      });
      if (result.status !== 201) {
        throw new Error(`Direktbokningsraden kunde inte sparas (${result.status})`);
      }
    },
    async deleteDirectBookingNight(night) {
      const existing = await this.getDirectBookingNight(night);
      if (!existing) return;
      const result = await tableRequest({
        accountName, method: 'DELETE', table,
        target: rowTarget('directbooking', night),
        ifMatch: existing.etag || '*',
        fetchImpl: options.fetchImpl, auth
      });
      if (![200, 204, 404].includes(result.status)) {
        throw new Error(`Direktbokningsraden kunde inte tas bort (${result.status})`);
      }
    },
    async listDirectBookingNightsByApproval(approvalId) {
      const result = await tableRequest({
        accountName, method: 'GET', table,
        query: [['$filter', `PartitionKey eq 'directbooking' and approvalId eq '${escapeOData(approvalId)}'`]],
        fetchImpl: options.fetchImpl, auth
      });
      if (result.status !== 200 || !Array.isArray(result.json?.value)) return null;
      return result.json.value.map(fromDirectBookingEntity);
    },
    async listDirectBookingApprovals() {
      const result = await tableRequest({
        accountName, method: 'GET', table,
        query: [['$filter', "PartitionKey eq 'directbooking'"]],
        fetchImpl: options.fetchImpl, auth
      });
      if (result.status !== 200 || !Array.isArray(result.json?.value)) return null;
      return groupDirectBookingApprovals(result.json.value.map(fromDirectBookingEntity));
    },
    async getDirectBookingSetting() {
      const result = await tableRequest({
        accountName, method: 'GET', table,
        target: rowTarget('directbooking', '__setting__'),
        fetchImpl: options.fetchImpl, auth
      });
      if (result.status === 404) return null;
      if (result.status !== 200 || !result.json) {
        throw new Error(`Direktbokningsinställningen kunde inte läsas (${result.status})`);
      }
      return {
        enabled: result.json.enabled === '1' || result.json.enabled === true,
        updatedBy: result.json.updatedBy ?? '',
        updatedAt: result.json.updatedAt ?? '',
        note: result.json.note ?? '',
        etag: result.json['odata.etag'] ?? ''
      };
    },
    async setDirectBookingSetting(data) {
      const existing = await this.getDirectBookingSetting();
      const body = {
        PartitionKey: 'directbooking',
        RowKey: '__setting__',
        enabled: data.enabled ? '1' : '0',
        updatedBy: data.updatedBy ?? '',
        updatedAt: data.updatedAt ?? new Date().toISOString(),
        note: data.note ?? ''
      };
      if (existing) {
        const result = await tableRequest({
          accountName, method: 'PUT', table,
          target: rowTarget('directbooking', '__setting__'),
          body,
          ifMatch: existing.etag || '*',
          fetchImpl: options.fetchImpl, auth
        });
        if (result.status === 412 || result.status === 409) {
          const conflict = new Error('Direktbokningsinställningen har ändrats av någon annan');
          conflict.status = 409;
          throw conflict;
        }
        if (![200, 204].includes(result.status)) {
          throw new Error(`Direktbokningsinställningen kunde inte uppdateras (${result.status})`);
        }
        return;
      }
      const result = await tableRequest({
        accountName, method: 'POST', table,
        body,
        fetchImpl: options.fetchImpl, auth
      });
      if (result.status !== 201) {
        throw new Error(`Direktbokningsinställningen kunde inte sparas (${result.status})`);
      }
    },
    async getCalendarSyncStatus() {
      const result = await tableRequest({
        accountName, method: 'GET', table,
        target: rowTarget(CALENDAR_SYNC_PARTITION, CALENDAR_SYNC_ROW),
        fetchImpl: options.fetchImpl, auth
      });
      if (result.status === 404) return null;
      if (result.status !== 200 || !result.json) {
        throw new Error(`Kalendersynkstatusen kunde inte läsas (${result.status})`);
      }
      return fromCalendarSyncEntity(result.json);
    },
    async saveCalendarSyncStatus(data) {
      const existing = await this.getCalendarSyncStatus().catch(() => null);
      const body = calendarSyncEntity(data);
      if (existing) {
        const result = await tableRequest({
          accountName, method: 'PUT', table,
          target: rowTarget(CALENDAR_SYNC_PARTITION, CALENDAR_SYNC_ROW),
          body,
          ifMatch: existing.etag || '*',
          fetchImpl: options.fetchImpl, auth
        });
        if (result.status === 412 || result.status === 409) {
          throw new Error('Kalendersynkstatusen har ändrats av någon annan');
        }
        if (![200, 204].includes(result.status)) {
          throw new Error(`Kalendersynkstatusen kunde inte uppdateras (${result.status})`);
        }
        return;
      }
      const result = await tableRequest({
        accountName, method: 'POST', table,
        body,
        fetchImpl: options.fetchImpl, auth
      });
      if (result.status !== 201) {
        throw new Error(`Kalendersynkstatusen kunde inte sparas (${result.status})`);
      }
    },
    async updateRequest(record, { ifMatch } = {}) {
      const rowKey = record.rowKey ?? record.idempotencyKey;
      const result = await tableRequest({
        accountName, method: 'PUT', table,
        target: rowTarget('request', rowKey),
        body: toEntity({ ...record, rowKey }, 'request'),
        ifMatch: ifMatch ?? '*',
        fetchImpl: options.fetchImpl, auth
      });
      if (result.status === 412 || result.status === 409) {
        const conflict = new Error('ETag-konflikt');
        conflict.status = 409;
        throw conflict;
      }
      if (result.status === 404) {
        const missing = new Error('Bokningen hittades inte');
        missing.status = 404;
        throw missing;
      }
      if (![200, 204].includes(result.status)) {
        throw new Error(`Bokningen kunde inte uppdateras (${result.status})`);
      }
      return { record, etag: result.etag ?? '' };
    },
    async appendHistory(entry) {
      const result = await tableRequest({
        accountName, method: 'POST', table,
        body: {
          PartitionKey: 'history',
          RowKey: entry.idempotencyKey,
          reference: entry.reference,
          action: entry.action,
          fromStatus: entry.fromStatus ?? '',
          toStatus: entry.toStatus ?? '',
          changes: entry.changes ?? '{}',
          reason: entry.reason ?? '',
          actorId: entry.actorId ?? '',
          actorName: entry.actorName ?? '',
          correlationId: entry.correlationId ?? '',
          at: entry.at
        },
        fetchImpl: options.fetchImpl, auth
      });
      if (result.status !== 201) {
        throw new Error(`Historikposten kunde inte sparas (${result.status})`);
      }
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
  const historyFile = path.resolve(options.historyFile ?? path.join(path.dirname(file), 'booking-history.jsonl'));
  const records = new Map();
  const calendar = new Map();
  const calendarKey = (resource, night) => `${resource === 'extrahus' ? 'extrahus' : 'main'}:${night}`;
  const directBooking = new Map();
  let syncStatus = null;
  let loaded = false;
  function etagFor(record) {
    return `local-${record.version ?? 1}-${record.updatedAt ?? record.createdAt ?? ''}`;
  }
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
    async getByReference(reference) {
      await loadOnce();
      const record = [...records.values()].find((item) => item.reference === reference);
      return record ? { record, etag: etagFor(record) } : null;
    },
    async getByPaymentTokenHash(tokenHash) {
      await loadOnce();
      if (!/^[0-9a-f]{64}$/i.test(String(tokenHash ?? ''))) return null;
      const record = [...records.values()].find((item) => item.paymentTokenHash === tokenHash);
      return record ? { record, etag: etagFor(record) } : null;
    },
    async listCalendarByReference(reference) {
      return [...calendar.values()]
        .filter((row) => row.reference === reference)
        .map((row) => ({ ...row }));
    },
    async listCalendar(from, to) {
      return [...calendar.values()]
        .filter((row) => (row.resource ?? 'main') === 'main' && row.night >= from && row.night < to)
        .map((row) => ({ ...row }));
    },
    async listCalendarByResource(resource, from, to) {
      return [...calendar.values()]
        .filter((row) => (row.resource ?? 'main') === resource && row.night >= from && row.night < to)
        .map((row) => ({ ...row }));
    },
    async createCalendarNight(night, data, { resource } = {}) {
      const target = resource === 'extrahus' ? 'extrahus' : 'main';
      const key = calendarKey(target, night);
      if (calendar.has(key)) {
        const conflict = new Error('Natten är redan blockerad');
        conflict.status = 409;
        throw conflict;
      }
      calendar.set(key, {
        night,
        resource: target,
        type: data.type ?? '',
        reference: data.reference ?? '',
        blockId: data.blockId ?? '',
        source: data.source ?? '',
        note: data.note ?? '',
        createdBy: data.createdBy ?? '',
        createdAt: data.createdAt ?? new Date().toISOString(),
        etag: `cal-${target}-${night}-1`
      });
    },
    async updateCalendarNight(night, data, { ifMatch, resource } = {}) {
      const target = resource === 'extrahus' ? 'extrahus' : 'main';
      const key = calendarKey(target, night);
      const current = calendar.get(key);
      if (!current) {
        const missing = new Error('Kalenderraden hittades inte');
        missing.status = 404;
        throw missing;
      }
      if (ifMatch && ifMatch !== '*' && ifMatch !== current.etag) {
        const conflict = new Error('Kalenderraden har ändrats av någon annan');
        conflict.status = 409;
        throw conflict;
      }
      calendar.set(key, {
        ...current,
        type: data.type ?? '',
        reference: data.reference ?? '',
        blockId: data.blockId ?? '',
        source: data.source ?? '',
        note: data.note ?? '',
        createdBy: data.createdBy ?? '',
        createdAt: data.createdAt ?? current.createdAt,
        etag: `cal-${target}-${night}-${Number(current.etag.split('-').at(-1)) + 1}`
      });
    },
    async deleteCalendarNight(night, reference, { resource } = {}) {
      const target = resource === 'extrahus' ? 'extrahus' : 'main';
      const key = calendarKey(target, night);
      const current = calendar.get(key);
      if (!current) return;
      if (reference && current.reference !== reference) {
        const conflict = new Error('Natten tillhör en annan bokning');
        conflict.status = 409;
        throw conflict;
      }
      calendar.delete(key);
    },
    async listBlockingBookings(arrival, departure) {
      await loadOnce();
      return [...records.values()].filter((record) =>
        record.partition !== 'outbox' &&
        (record.statusCode === 'CONFIRMED' || record.statusCode === 'BLOCKED') &&
        record.arrival < departure && record.departure > arrival
      );
    },
    async getDirectBookingNight(night) {
      return directBooking.get(night) ? { ...directBooking.get(night) } : null;
    },
    async listDirectBookingNights(from, to) {
      return [...directBooking.values()]
        .filter((row) => row.night >= from && row.night < to)
        .map((row) => ({ ...row }));
    },
    async upsertDirectBookingNight(night, data) {
      const existing = directBooking.get(night);
      directBooking.set(night, {
        ...directBookingEntity(night, data),
        night,
        etag: existing ? `db-${night}-${Number(existing.etag.split('-').at(-1)) + 1}` : `db-${night}-1`
      });
    },
    async deleteDirectBookingNight(night) {
      directBooking.delete(night);
    },
    async listDirectBookingNightsByApproval(approvalId) {
      return [...directBooking.values()]
        .filter((row) => row.approvalId === approvalId)
        .map((row) => ({ ...row }));
    },
    async listDirectBookingApprovals() {
      return groupDirectBookingApprovals([...directBooking.values()]);
    },
    async getDirectBookingSetting() {
      const row = directBooking.get('__setting__');
      if (!row) return null;
      return {
        enabled: row.enabled === '1' || row.enabled === true,
        updatedBy: row.updatedBy ?? '',
        updatedAt: row.updatedAt ?? '',
        note: row.note ?? '',
        etag: row.etag ?? ''
      };
    },
    async setDirectBookingSetting(data) {
      const existing = directBooking.get('__setting__');
      directBooking.set('__setting__', {
        night: '__setting__',
        enabled: data.enabled ? '1' : '0',
        updatedBy: data.updatedBy ?? '',
        updatedAt: data.updatedAt ?? new Date().toISOString(),
        note: data.note ?? '',
        etag: existing ? `db-setting-2` : 'db-setting-1'
      });
    },
    async getCalendarSyncStatus() {
      return syncStatus ? { ...syncStatus, conflicts: [...syncStatus.conflicts] } : null;
    },
    async saveCalendarSyncStatus(data) {
      syncStatus = {
        ...data,
        conflicts: Array.isArray(data.conflicts) ? [...data.conflicts] : []
      };
    },
    async updateRequest(record, { ifMatch } = {}) {
      await loadOnce();
      const current = records.get(record.idempotencyKey) ??
        [...records.values()].find((item) => item.reference === record.reference);
      if (!current) {
        const missing = new Error('Bokningen hittades inte');
        missing.status = 404;
        throw missing;
      }
      if (ifMatch && ifMatch !== etagFor(current)) {
        const conflict = new Error('ETag-konflikt');
        conflict.status = 409;
        throw conflict;
      }
      const stored = {
        ...record,
        idempotencyKey: current.idempotencyKey,
        rowKey: current.rowKey ?? current.idempotencyKey
      };
      records.set(stored.idempotencyKey, stored);
      await fsp.mkdir(path.dirname(file), { recursive: true });
      await fsp.appendFile(file, `${JSON.stringify(stored)}\n`, 'utf8');
      return { record: stored, etag: etagFor(stored) };
    },
    async appendHistory(entry) {
      await fsp.mkdir(path.dirname(historyFile), { recursive: true });
      await fsp.appendFile(historyFile, `${JSON.stringify(entry)}\n`, 'utf8');
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
  fromDirectBookingEntity, directBookingEntity, groupDirectBookingApprovals,
  fromCalendarSyncEntity, calendarSyncEntity,
  CALENDAR_SYNC_PARTITION, CALENDAR_SYNC_ROW,
  createManagedIdentityTokenProvider, createTokenCache, hasManagedIdentity,
  tableRequest, tableUrl, rowTarget,
  MANAGED_IDENTITY_SCOPE_SUFFIX
};
