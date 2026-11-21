'use strict';

// Table Storage-adapter för bokningsportalen. Läser och skriver med samma
// managed identity som den publika appen. Inga lagringsnycklar används.
//
// SKRIVNINGAR KRÄVER "Storage Table Data Contributor" på tabellen. I detta
// utvecklingssteg är rollen fortfarande Reader; aktiveringen av skrivningar i
// Azure görs först efter granskning (se docs/bokningsportal.md). Lokalt och i
// tester används demorepositoryt.

const {
  createManagedIdentityTokenProvider,
  createTokenCache,
  tableRequest,
  rowTarget,
  toEntity,
  fromEntity,
  toOutboxEntity,
  fromDirectBookingEntity,
  directBookingEntity,
  groupDirectBookingApprovals,
  fromCalendarSyncEntity,
  calendarSyncEntity,
  CALENDAR_SYNC_PARTITION,
  CALENDAR_SYNC_ROW
} = require('../../booking/store');
const {
  normalizeBooking,
  filterBookings,
  sortBookings,
  dashboardData
} = require('../domain');

const DEFAULT_TABLE = 'bookingrequests';
const MAX_ROWS = 1000;

function escapeOData(value) {
  return String(value).replaceAll("'", "''");
}

function calendarPartition(resource) {
  return resource === 'extrahus' ? 'calendar-extrahus' : 'calendar';
}

function calendarResourceOf(partition) {
  return partition === 'calendar-extrahus' ? 'extrahus' : 'main';
}

function conflict(message) {
  const cause = new Error(message);
  cause.status = 409;
  return cause;
}

function missing(message) {
  const cause = new Error(message);
  cause.status = 404;
  return cause;
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
  const auth = { mode: 'managed-identity', tokens };

  async function request({ method, target = '', query = [], body, ifMatch, ifNoneMatch, partition }) {
    const result = await tableRequest({
      accountName,
      table,
      method,
      target,
      query: partition ? [...query, ['PartitionKey', partition]] : query,
      body,
      ifMatch,
      ifNoneMatch,
      fetchImpl,
      auth
    });
    return result;
  }

  async function query(filter, select) {
    const params = [['$filter', filter], ['$top', String(MAX_ROWS)]];
    if (select) params.push(['$select', select]);
    const result = await request({ method: 'GET', query: params });
    if (result.status !== 200) {
      const cause = new Error(`Table Storage svarade ${result.status}`);
      cause.status = result.status;
      throw cause;
    }
    return Array.isArray(result.json?.value) ? result.json.value : [];
  }

  async function loadRequests() {
    return query("PartitionKey eq 'request'");
  }

  async function loadOutboxRows() {
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
    return requests.map((entity) => normalizeBooking(fromEntity(entity), {
      outbox: grouped.get(entity.reference) ?? []
    }));
  }

  async function getRawBooking(reference) {
    const safe = escapeOData(reference);
    const rows = await query(`PartitionKey eq 'request' and reference eq '${safe}'`);
    if (!rows.length) return null;
    const rowKey = rows[0].RowKey;
    const single = await request({
      method: 'GET',
      target: rowTarget('request', rowKey)
    });
    if (single.status !== 200 || !single.json) return null;
    return { record: fromEntity(single.json), etag: single.etag };
  }

  return {
    type: 'table',
    readOnly: false,
    writable: true,
    async listBookings(filters = {}) {
      const bookings = await loadAllBookings();
      return sortBookings(filterBookings(bookings, filters), filters.sort, filters.dir);
    },
    async getBooking(reference) {
      const raw = await getRawBooking(reference);
      if (!raw) return null;
      const outbox = await query(
        `PartitionKey eq 'outbox' and reference eq '${escapeOData(reference)}'`,
        'reference,mailType,status,deliveryStatus,resendId,sentAt,createdAt'
      );
      return normalizeBooking(raw.record, { outbox, etag: raw.etag });
    },
    async getRawBooking(reference) {
      return getRawBooking(reference);
    },
    async getByReference(reference) {
      return getRawBooking(reference);
    },
    async findByIdempotencyKey(key) {
      const result = await request({
        method: 'GET',
        target: rowTarget('request', key)
      });
      return result.status === 200 && result.json ? fromEntity(result.json) : null;
    },
    async findByReference(reference) {
      return (await getRawBooking(reference))?.record ?? null;
    },
    async createRequest(record) {
      const result = await request({
        method: 'POST',
        body: toEntity(record, 'request')
      });
      if (result.status === 201) return { duplicate: false, record };
      if (result.status === 409) {
        const existing = await getRawBooking(record.reference);
        if (existing) return { duplicate: true, record: existing.record };
        throw conflict('Posten finns redan');
      }
      throw new Error(`Bokningen kunde inte sparas (${result.status})`);
    },
    async updateRequest(record, { ifMatch } = {}) {
      const rowKey = record.rowKey ?? record.idempotencyKey;
      const result = await request({
        method: 'PUT',
        target: rowTarget('request', rowKey),
        body: toEntity({ ...record, rowKey }, 'request'),
        ifMatch: ifMatch ?? '*'
      });
      if (result.status === 412 || result.status === 409) throw conflict('ETag-konflikt');
      if (result.status === 404) throw missing('Bokningen hittades inte');
      if (![200, 204].includes(result.status)) {
        throw new Error(`Bokningen kunde inte uppdateras (${result.status})`);
      }
      const etag = result.etag || (await getRawBooking(record.reference))?.etag || '';
      return { record, etag };
    },
    async deleteRequest(key, { ifMatch } = {}) {
      let rowKey = key;
      let etag = ifMatch;
      if (!/^[A-Za-z0-9-]{8,}$/.test(String(key)) || String(key).startsWith('SK-') || String(key).startsWith('BLOCK-')) {
        const raw = await getRawBooking(key);
        if (!raw) throw missing('Bokningen hittades inte');
        rowKey = raw.record.rowKey;
        etag = etag ?? raw.etag;
      }
      const result = await request({
        method: 'DELETE',
        target: rowTarget('request', rowKey),
        ifMatch: etag ?? '*'
      });
      if (result.status === 412 || result.status === 409) throw conflict('ETag-konflikt');
      if (result.status === 404) throw missing('Bokningen hittades inte');
      if (![200, 204].includes(result.status)) {
        throw new Error(`Bokningen kunde inte tas bort (${result.status})`);
      }
    },
    async listCalendar(from, to) {
      const safeFrom = escapeOData(from);
      const safeTo = escapeOData(to);
      const rows = await query(
        `PartitionKey eq 'calendar' and RowKey ge '${safeFrom}' and RowKey lt '${safeTo}'`
      );
      return rows.map((row) => ({
        night: row.RowKey,
        resource: 'main',
        type: row.type ?? '',
        kind: row.kind ?? '',
        reference: row.reference ?? '',
        blockId: row.blockId ?? '',
        source: row.source ?? '',
        note: row.note ?? '',
        createdBy: row.createdBy ?? '',
        createdAt: row.createdAt ?? ''
      }));
    },
    async listCalendarByReference(reference) {
      const rows = await query(
        `(PartitionKey eq 'calendar' or PartitionKey eq 'calendar-extrahus') and reference eq '${escapeOData(reference)}'`
      );
      return rows.map((row) => ({
        night: row.RowKey,
        resource: calendarResourceOf(row.PartitionKey),
        type: row.type ?? '',
        kind: row.kind ?? '',
        reference: row.reference ?? '',
        blockId: row.blockId ?? '',
        source: row.source ?? '',
        note: row.note ?? '',
        createdBy: row.createdBy ?? '',
        createdAt: row.createdAt ?? ''
      }));
    },
    async listCalendarByResource(resource, from, to) {
      const partition = calendarPartition(resource);
      const rows = await query(
        `PartitionKey eq '${partition}' and RowKey ge '${escapeOData(from)}' and RowKey lt '${escapeOData(to)}'`
      );
      return rows.map((row) => ({
        night: row.RowKey,
        resource: calendarResourceOf(partition),
        type: row.type ?? '',
        kind: row.kind ?? '',
        reference: row.reference ?? '',
        blockId: row.blockId ?? '',
        source: row.source ?? '',
        note: row.note ?? '',
        createdBy: row.createdBy ?? '',
        createdAt: row.createdAt ?? ''
      }));
    },
    async getDirectBookingNight(night) {
      const result = await request({
        method: 'GET',
        target: rowTarget('directbooking', night)
      });
      if (result.status === 404) return null;
      if (result.status !== 200 || !result.json) {
        throw new Error(`Direktbokningsraden kunde inte läsas (${result.status})`);
      }
      return fromDirectBookingEntity(result.json);
    },
    async listDirectBookingNights(from, to) {
      const rows = await query(
        `PartitionKey eq 'directbooking' and RowKey ge '${escapeOData(from)}' and RowKey lt '${escapeOData(to)}'`
      );
      return rows.map(fromDirectBookingEntity);
    },
    async upsertDirectBookingNight(night, data) {
      const existing = await this.getDirectBookingNight(night);
      const body = directBookingEntity(night, data);
      if (existing) {
        const result = await request({
          method: 'PUT',
          target: rowTarget('directbooking', night),
          body,
          ifMatch: existing.etag || '*'
        });
        if (result.status === 412 || result.status === 409) throw conflict('Direktbokningsraden har ändrats av någon annan');
        if (![200, 204].includes(result.status)) {
          throw new Error(`Direktbokningsraden kunde inte uppdateras (${result.status})`);
        }
        return;
      }
      const result = await request({
        method: 'POST',
        body
      });
      if (result.status !== 201) {
        throw new Error(`Direktbokningsraden kunde inte sparas (${result.status})`);
      }
    },
    async deleteDirectBookingNight(night) {
      const existing = await this.getDirectBookingNight(night);
      if (!existing) return;
      const result = await request({
        method: 'DELETE',
        target: rowTarget('directbooking', night),
        ifMatch: existing.etag || '*'
      });
      if (![200, 204, 404].includes(result.status)) {
        throw new Error(`Direktbokningsraden kunde inte tas bort (${result.status})`);
      }
    },
    async listDirectBookingNightsByApproval(approvalId) {
      const rows = await query(
        `PartitionKey eq 'directbooking' and approvalId eq '${escapeOData(approvalId)}'`
      );
      return rows.map(fromDirectBookingEntity);
    },
    async listDirectBookingApprovals() {
      const rows = await query("PartitionKey eq 'directbooking'");
      return groupDirectBookingApprovals(rows.map(fromDirectBookingEntity));
    },
    async getDirectBookingSetting() {
      const result = await request({
        method: 'GET',
        target: rowTarget('directbooking', '__setting__')
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
        const result = await request({
          method: 'PUT',
          target: rowTarget('directbooking', '__setting__'),
          body,
          ifMatch: existing.etag || '*'
        });
        if (result.status === 412 || result.status === 409) throw conflict('Direktbokningsinställningen har ändrats av någon annan');
        if (![200, 204].includes(result.status)) {
          throw new Error(`Direktbokningsinställningen kunde inte uppdateras (${result.status})`);
        }
        return;
      }
      const result = await request({ method: 'POST', body });
      if (result.status !== 201) {
        throw new Error(`Direktbokningsinställningen kunde inte sparas (${result.status})`);
      }
    },
    async getCalendarSyncStatus() {
      const result = await request({
        method: 'GET',
        target: rowTarget(CALENDAR_SYNC_PARTITION, CALENDAR_SYNC_ROW)
      });
      if (result.status === 404) return null;
      if (result.status !== 200 || !result.json) {
        throw new Error(`Kalendersynkstatusen kunde inte läsas (${result.status})`);
      }
      return fromCalendarSyncEntity({ ...result.json, etag: result.etag });
    },
    async saveCalendarSyncStatus(data) {
      const existing = await this.getCalendarSyncStatus().catch(() => null);
      const body = calendarSyncEntity(data);
      if (existing) {
        const result = await request({
          method: 'PUT',
          target: rowTarget(CALENDAR_SYNC_PARTITION, CALENDAR_SYNC_ROW),
          body,
          ifMatch: existing.etag || '*'
        });
        if (result.status === 412 || result.status === 409) throw conflict('Kalendersynkstatusen har ändrats av någon annan');
        if (![200, 204].includes(result.status)) {
          throw new Error(`Kalendersynkstatusen kunde inte uppdateras (${result.status})`);
        }
        return;
      }
      const result = await request({ method: 'POST', body });
      if (result.status !== 201) {
        throw new Error(`Kalendersynkstatusen kunde inte sparas (${result.status})`);
      }
    },
    async createCalendarNight(night, data, { resource } = {}) {
      // Table Storage POST/Insert Entity är create-only: samma PartitionKey +
      // RowKey ger 409 EntityAlreadyExists. If-None-Match får inte skickas på
      // POST och behövs inte för atomisk nattlåsning.
      const partition = calendarPartition(resource);
      const result = await request({
        method: 'POST',
        body: {
          PartitionKey: partition,
          RowKey: night,
          type: data.type ?? '',
          kind: data.kind ?? '',
          reference: data.reference ?? '',
          blockId: data.blockId ?? '',
          source: data.source ?? '',
          note: data.note ?? '',
          createdBy: data.createdBy ?? '',
          createdAt: data.createdAt ?? new Date().toISOString()
        }
      });
      if (result.status === 409 || result.status === 412) throw conflict('Natten är redan blockerad');
      if (result.status !== 201) {
        throw new Error(`Kalenderraden kunde inte sparas (${result.status})`);
      }
    },
    async updateCalendarNight(night, data, { resource, ifMatch } = {}) {
      const partition = calendarPartition(resource);
      const result = await request({
        method: 'PUT',
        target: rowTarget(partition, night),
        body: {
          PartitionKey: partition,
          RowKey: night,
          type: data.type ?? '',
          kind: data.kind ?? '',
          reference: data.reference ?? '',
          blockId: data.blockId ?? '',
          source: data.source ?? '',
          note: data.note ?? '',
          createdBy: data.createdBy ?? '',
          createdAt: data.createdAt ?? new Date().toISOString()
        },
        ifMatch: ifMatch ?? '*'
      });
      if (result.status === 409 || result.status === 412) throw conflict('ETag-konflikt');
      if (![200, 204].includes(result.status)) {
        throw new Error(`Kalenderraden kunde inte uppdateras (${result.status})`);
      }
    },
    async deleteCalendarNight(night, reference, { resource } = {}) {
      const partition = calendarPartition(resource);
      const single = await request({
        method: 'GET',
        target: rowTarget(partition, night)
      });
      if (single.status === 404) return;
      if (single.status !== 200 || !single.json) {
        throw new Error(`Kalenderraden kunde inte läsas (${single.status})`);
      }
      if (reference && single.json.reference !== reference) {
        throw conflict('Natten tillhör en annan bokning');
      }
      const removed = await request({
        method: 'DELETE',
        target: rowTarget(partition, night),
        ifMatch: single.etag || '*'
      });
      if (removed.status === 412 || removed.status === 409) throw conflict('ETag-konflikt');
      if (![200, 204, 404].includes(removed.status)) {
        throw new Error(`Kalenderraden kunde inte tas bort (${removed.status})`);
      }
    },
    async appendHistory(entry) {
      const result = await request({
        method: 'POST',
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
        }
      });
      if (result.status !== 201) {
        throw new Error(`Auditposten kunde inte sparas (${result.status})`);
      }
    },
    async listHistory(reference) {
      const rows = await query(
        `PartitionKey eq 'history' and reference eq '${escapeOData(reference)}'`
      );
      return rows
        .map((row) => ({
          reference: row.reference,
          action: row.action,
          fromStatus: row.fromStatus ?? '',
          toStatus: row.toStatus ?? '',
          changes: row.changes ?? '{}',
          reason: row.reason ?? '',
          actorId: row.actorId ?? '',
          actorName: row.actorName ?? '',
          correlationId: row.correlationId ?? '',
          at: row.at
        }))
        .sort((a, b) => String(b.at).localeCompare(String(a.at)));
    },
    async saveOutbox(entry) {
      const result = await request({
        method: 'POST',
        body: toOutboxEntity(entry)
      });
      if (![201, 409].includes(result.status)) {
        throw new Error(`Utkorgsposten kunde inte sparas (${result.status})`);
      }
    },
    async cancelPendingOutbox(reference, options = {}) {
      const mailTypes = Array.isArray(options.mailTypes) ? options.mailTypes : [];
      const now = options.now ?? new Date();
      const rows = await query(
        `PartitionKey eq 'outbox' and reference eq '${escapeOData(reference)}'`
      );
      let cancelled = 0;
      for (const row of rows) {
        if (!['Utkorg', 'Misslyckad', 'Skickar'].includes(String(row.status ?? ''))) continue;
        if (mailTypes.length && !mailTypes.includes(row.mailType)) continue;
        const result = await request({
          method: 'PATCH',
          target: rowTarget('outbox', row.RowKey),
          ifMatch: row['odata.etag'] ?? row.etag ?? '*',
          body: {
            status: 'Makulerad',
            deliveryStatus: 'Makulerad – bokningen ändrades',
            cancelledAt: now.toISOString(),
            cancelledReason: String(options.reason ?? '')
          }
        });
        if ([200, 204].includes(result.status)) cancelled += 1;
      }
      return cancelled;
    },
    async dashboard(now = new Date()) {
      const bookings = await loadAllBookings();
      return dashboardData(bookings, now);
    },
    async allBookings() {
      return loadAllBookings();
    }
  };
}

module.exports = { createTableAdminRepository, escapeOData, DEFAULT_TABLE };
