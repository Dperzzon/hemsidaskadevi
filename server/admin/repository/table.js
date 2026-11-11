'use strict';

// Read-only Table Storage-adapter för bokningsportalen. Den använder samma
// managed identity som den publika appen men har inga skrivmetoder alls.
// I Azure ska identiteten endast ha "Storage Table Data Reader" på tabellen.
// Inga lagringsnycklar läses och ingen data skickas till webbläsaren direkt.

const {
  createManagedIdentityTokenProvider,
  createTokenCache
} = require('../../booking/store');
const {
  normalizeBooking,
  filterBookings,
  sortBookings,
  dashboardData
} = require('../domain');

const TABLE_API_VERSION = '2019-02-02';
const DEFAULT_TABLE = 'bookingrequests';
const MAX_ROWS = 1000;

function escapeOData(value) {
  return String(value).replaceAll("'", "''");
}

function createTableUrl(accountName, table, filter, select) {
  const url = new URL(`https://${accountName}.table.core.windows.net/${table}`);
  url.searchParams.set('$filter', filter);
  url.searchParams.set('$top', String(MAX_ROWS));
  if (select) url.searchParams.set('$select', select);
  return url;
}

function createTableAdminRepository(options = {}) {
  const accountName = options.accountName ?? process.env.AZURE_STORAGE_ACCOUNT_NAME;
  const table = options.table ?? process.env.AZURE_TABLE_NAME ?? DEFAULT_TABLE;
  const fetchImpl = options.fetchImpl ?? fetch;
  if (!accountName) {
    throw new Error('Azure Table Storage är inte konfigurerat för portalen');
  }
  const tokenProvider = options.tokenProvider ??
    createTokenCache(createManagedIdentityTokenProvider({ fetchImpl, ...options.identity }));
  const tokens = options.tokens ?? createTokenCache(tokenProvider);

  async function query(filter, select) {
    const token = await tokens.getToken();
    const response = await fetchImpl(createTableUrl(accountName, table, filter, select), {
      method: 'GET',
      headers: {
        Accept: 'application/json;odata=nometadata',
        Authorization: `Bearer ${token.accessToken}`,
        'x-ms-version': TABLE_API_VERSION
      }
    });
    const text = await response.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    if (!response.ok) {
      const error = new Error(`Table Storage svarade ${response.status}`);
      error.status = response.status;
      throw error;
    }
    return Array.isArray(json?.value) ? json.value : [];
  }

  async function loadRequests() {
    return query("PartitionKey eq 'request'");
  }

  async function loadOutboxRows() {
    // Endast metadata om mejlen — aldrig hela mejltexten till adminvyn.
    return query(
      "PartitionKey eq 'outbox'",
      'reference,mailType,status,deliveryStatus,resendId,sentAt,createdAt'
    );
  }

  function groupOutbox(rows) {
    const grouped = new Map();
    for (const row of rows) {
      const reference = row.reference;
      if (!reference) continue;
      if (!grouped.has(reference)) grouped.set(reference, []);
      grouped.get(reference).push(row);
    }
    return grouped;
  }

  async function loadAllBookings() {
    const [requests, outbox] = await Promise.all([loadRequests(), loadOutboxRows()]);
    const grouped = groupOutbox(outbox);
    return requests.map((entity) => normalizeBooking(entity, {
      outbox: grouped.get(entity.reference) ?? []
    }));
  }

  return {
    type: 'table',
    readOnly: true,
    async listBookings(filters = {}) {
      const bookings = await loadAllBookings();
      return sortBookings(filterBookings(bookings, filters), filters.sort, filters.dir);
    },
    async getBooking(reference) {
      const safe = escapeOData(reference);
      const [requests, outbox] = await Promise.all([
        query(`PartitionKey eq 'request' and reference eq '${safe}'`),
        query(
          `PartitionKey eq 'outbox' and reference eq '${safe}'`,
          'reference,mailType,status,deliveryStatus,resendId,sentAt,createdAt'
        )
      ]);
      if (!requests.length) return null;
      return normalizeBooking(requests[0], { outbox });
    },
    async dashboard() {
      const bookings = await loadAllBookings();
      return dashboardData(bookings);
    },
    async allBookings() {
      return loadAllBookings();
    }
  };
}

module.exports = { createTableAdminRepository, createTableUrl, escapeOData, DEFAULT_TABLE };
