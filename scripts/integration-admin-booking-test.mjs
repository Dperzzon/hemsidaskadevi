#!/usr/bin/env node
// ============================================================================
// Begränsat integrationstest för bokningsportalens skrivfunktioner.
//
// Kör ENDAST mot den isolerade testtabellen bookingrequeststest i det kända
// testlagringskontot. Vägrar alla andra tabeller/konton. Testet använder
// storagekontonyckeln via miljövariabeln ADMIN_TEST_STORAGE_KEY och skriver
// aldrig ut den. Alla rader som skapas städas med exakt referens; ingen
// produktionsdata läses eller raderas.
//
// Användning:
//   $env:ADMIN_TEST_STORAGE_KEY = (az storage account keys list ... )
//   node scripts/integration-admin-booking-test.mjs
// ============================================================================

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  tableRequest,
  rowTarget,
  toEntity,
  fromEntity
} = require('../server/booking/store.js');
const {
  normalizeBooking,
  addDays
} = require('../server/admin/domain.js');
const {
  createManualBooking,
  changeStatus
} = require('../server/admin/booking-service.js');

const ACCOUNT = 'stskadevibokningprod';
const TABLE = 'bookingrequeststest';
const MAX_ROWS = 1000;

if (TABLE !== 'bookingrequeststest' || ACCOUNT !== 'stskadevibokningprod') {
  throw new Error('Testharnesket är låst till bookingrequeststest');
}

const useMemory = process.env.ADMIN_TEST_REPO === 'memory';
const accountKey = process.env.ADMIN_TEST_STORAGE_KEY;
const bearerToken = process.env.ADMIN_TEST_STORAGE_TOKEN;
if (!useMemory && !accountKey && !bearerToken) {
  console.error('Sätt ADMIN_TEST_STORAGE_TOKEN (Azure CLI-token), ADMIN_TEST_STORAGE_KEY eller ADMIN_TEST_REPO=memory.');
  process.exit(2);
}

const auth = useMemory
  ? null
  : bearerToken
    ? {
        mode: 'managed-identity',
        tokens: {
          async getToken() {
            return {
              accessToken: bearerToken,
              expiresOn: Math.floor(Date.now() / 1000) + 1800
            };
          }
        }
      }
    : { mode: 'shared-key', accountKey };
const owner = { id: 'integration-owner', name: 'Integrationstest Owner', roles: ['Owner'] };
let passed = 0;

function assert(condition, message) {
  if (!condition) throw new Error(`FEL: ${message}`);
  passed += 1;
  console.log(`  OK: ${message}`);
}

function escapeOData(value) {
  return String(value).replaceAll("'", "''");
}

async function request(options) {
  return tableRequest({
    accountName: ACCOUNT,
    table: TABLE,
    fetchImpl: fetch,
    auth,
    ...options
  });
}

async function query(filter) {
  const result = await request({
    method: 'GET',
    query: [['$filter', filter], ['$top', String(MAX_ROWS)]]
  });
  if (result.status !== 200) throw new Error(`Testtabellen svarade ${result.status}`);
  return Array.isArray(result.json?.value) ? result.json.value : [];
}

function conflict(message) {
  const error = new Error(message);
  error.status = 409;
  return error;
}

function missing(message) {
  const error = new Error(message);
  error.status = 404;
  return error;
}

async function getRawBooking(reference) {
  const rows = await query(`PartitionKey eq 'request' and reference eq '${escapeOData(reference)}'`);
  if (!rows.length) return null;
  const single = await request({
    method: 'GET',
    target: rowTarget('request', rows[0].RowKey)
  });
  if (single.status !== 200 || !single.json) return null;
  return { record: fromEntity(single.json), etag: single.etag };
}

async function listCalendar(from, to) {
  const rows = await query(
    `PartitionKey eq 'calendar' and RowKey ge '${escapeOData(from)}' and RowKey lt '${escapeOData(to)}'`
  );
  return rows.map((row) => ({
    night: row.RowKey,
    type: row.type ?? '',
    reference: row.reference ?? '',
    createdBy: row.createdBy ?? ''
  }));
}

const tableRepo = {
  type: 'table-test',
  writable: true,
  async allBookings(now = new Date()) {
    const rows = await query("PartitionKey eq 'request'");
    return rows.map((row) => normalizeBooking(fromEntity(row), { now }));
  },
  async getRawBooking(reference) {
    return getRawBooking(reference);
  },
  async findByReference(reference) {
    return (await getRawBooking(reference))?.record ?? null;
  },
  async findByIdempotencyKey(key) {
    const result = await request({ method: 'GET', target: rowTarget('request', key) });
    return result.status === 200 && result.json ? fromEntity(result.json) : null;
  },
  async createRequest(record) {
    const result = await request({ method: 'POST', body: toEntity(record, 'request') });
    if (result.status === 201) return { duplicate: false, record };
    if (result.status === 409) {
      const existing = await getRawBooking(record.reference);
      if (existing) return { duplicate: true, record: existing.record };
      throw conflict('Posten finns redan');
    }
    throw new Error(`Testtabellen kunde inte spara bokningen (${result.status})`);
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
    const raw = key.startsWith('SK-') || key.startsWith('BLOCK-')
      ? await getRawBooking(key)
      : null;
    const rowKey = raw ? raw.record.rowKey : key;
    const etag = ifMatch ?? raw?.etag ?? '*';
    const result = await request({
      method: 'DELETE',
      target: rowTarget('request', rowKey),
      ifMatch: etag
    });
    if (result.status === 412 || result.status === 409) throw conflict('ETag-konflikt');
    if (![200, 204, 404].includes(result.status)) {
      throw new Error(`Bokningen kunde inte tas bort (${result.status})`);
    }
  },
  async listCalendar(from, to) {
    return listCalendar(from, to);
  },
  async listCalendarByReference(reference) {
    const rows = await query(
      `PartitionKey eq 'calendar' and reference eq '${escapeOData(reference)}'`
    );
    return rows.map((row) => ({ night: row.RowKey, reference: row.reference ?? '' }));
  },
  async createCalendarNight(night, data) {
    // Insert Entity är create-only: duplicate RowKey ger 409.
    const result = await request({
      method: 'POST',
      body: {
        PartitionKey: 'calendar',
        RowKey: night,
        type: data.type ?? '',
        reference: data.reference ?? '',
        blockId: data.blockId ?? '',
        source: data.source ?? '',
        note: data.note ?? '',
        createdBy: data.createdBy ?? '',
        createdAt: data.createdAt ?? new Date().toISOString()
      }
    });
    if (result.status === 409 || result.status === 412) throw conflict('Natten är redan blockerad');
    if (result.status !== 201) throw new Error(`Kalenderraden kunde inte sparas (${result.status})`);
  },
  async deleteCalendarNight(night, reference) {
    const single = await request({ method: 'GET', target: rowTarget('calendar', night) });
    if (single.status === 404) return;
    if (single.status !== 200 || !single.json) {
      throw new Error(`Kalenderraden kunde inte läsas (${single.status})`);
    }
    if (reference && single.json.reference !== reference) {
      throw conflict('Natten tillhör en annan bokning');
    }
    const removed = await request({
      method: 'DELETE',
      target: rowTarget('calendar', night),
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
    if (result.status !== 201) throw new Error(`Auditposten kunde inte sparas (${result.status})`);
  },
  async listHistory(reference) {
    const rows = await query(
      `PartitionKey eq 'history' and reference eq '${escapeOData(reference)}'`
    );
    return rows
      .map((row) => ({ action: row.action, reason: row.reason ?? '', at: row.at }))
      .sort((a, b) => String(b.at).localeCompare(String(a.at)));
  }
};

const repo = useMemory
  ? require('../server/admin/repository/demo.js').createDemoRepository({ now: new Date() })
  : tableRepo;

function randomFutureDate() {
  const base = Date.UTC(2036, 0, 1) + Math.floor(Math.random() * 1400) * 86400000;
  return new Date(base).toISOString().slice(0, 10);
}

function bookingBody(arrival, departure, overrides = {}) {
  return {
    mode: 'booking',
    firstName: 'Integration',
    lastName: 'Test',
    email: 'integration-test@example.se',
    phone: '+46 70 000 00 00',
    arrival,
    departure,
    guests: 2,
    bookingSource: 'PHONE',
    statusCode: 'CONFIRMED',
    addons: { slutstad: false, lakan: false, linenCount: 0, ved: false, tidigIncheckning: false, senUtcheckning: false },
    paymentStatus: 'UNPAID',
    amountPaid: 0,
    latestNote: 'Syntetiskt integrationstest',
    ...overrides
  };
}

async function cleanup(reference) {
  if (!reference) return;
  try {
    if (useMemory) {
      const rows = await repo.listCalendarByReference(reference);
      for (const row of rows) await repo.deleteCalendarNight(row.night, reference);
      const raw = await repo.getRawBooking(reference);
      if (raw) await repo.deleteRequest(raw.record.rowKey, { ifMatch: raw.etag });
      console.log(`  Städat (minne): ${reference}`);
      return;
    }
    const rows = await repo.listCalendarByReference(reference);
    for (const row of rows) await repo.deleteCalendarNight(row.night, reference);
    const raw = await getRawBooking(reference);
    if (raw) await repo.deleteRequest(raw.record.rowKey, { ifMatch: raw.etag });
    const history = await query(
      `PartitionKey eq 'history' and reference eq '${escapeOData(reference)}'`
    );
    for (const row of history) {
      await request({
        method: 'DELETE',
        target: rowTarget('history', row.RowKey),
        ifMatch: '*'
      });
    }
    console.log(`  Städat: ${reference}`);
  } catch (error) {
    console.warn(`  Varning: städning av ${reference} misslyckades: ${error.message}`);
  }
}

async function main() {
  const createdReferences = new Set();
  const options = {
    now: new Date(),
    requireAirbnbCheck: false,
    idempotencyKey: `it-${Date.now()}-${Math.random().toString(36).slice(2)}`
  };

  try {
    console.log('1. Två samtidiga bekräftelser för samma nätter');
    const d1 = randomFutureDate();
    const [a, b] = await Promise.all([
      createManualBooking(repo, owner, bookingBody(d1, addDays(d1, 2)), {
        ...options, idempotencyKey: `${options.idempotencyKey}-a`
      }),
      createManualBooking(repo, owner, bookingBody(d1, addDays(d1, 2)), {
        ...options, idempotencyKey: `${options.idempotencyKey}-b`
      })
    ]);
    const statuses = [a.status, b.status].sort();
    assert(statuses[0] === 201 && statuses[1] === 409,
      `en bekräftelse lyckades (201) och en nekades (409), fick ${statuses.join('/')}`);
    const winner = a.status === 201 ? a : b;
    createdReferences.add(winner.jsonBody.reference);
    const concurrentRows = await repo.listCalendar(d1, addDays(d1, 2));
    assert(concurrentRows.length === 2, 'exakt två nattlås finns för den vinnande bokningen');
    assert(concurrentRows.every((row) => row.reference === winner.jsonBody.reference),
      'alla nattlås tillhör den vinnande bokningen');

    console.log('2. Rollback tar inte bort en annan boknings lås');
    const d2 = addDays(d1, 10);
    const block = await createManualBooking(repo, owner, {
      mode: 'block',
      arrival: d2, departure: addDays(d2, 1), latestNote: 'Främmande lås'
    }, { ...options, idempotencyKey: `${options.idempotencyKey}-block` });
    assert(block.status === 201, 'datumblockeringen skapades');
    createdReferences.add(block.jsonBody.reference);
    const rollbackAttempt = await createManualBooking(repo, owner,
      bookingBody(addDays(d2, -1), addDays(d2, 1)),
      { ...options, idempotencyKey: `${options.idempotencyKey}-rollback` }
    );
    assert(rollbackAttempt.status === 409, 'den överlappande bokningen nekades');
    const rollbackRows = await repo.listCalendar(addDays(d2, -1), addDays(d2, 1));
    assert(rollbackRows.length === 1, 'endast det främmande låset återstår');
    assert(rollbackRows[0].night === d2 && rollbackRows[0].reference === block.jsonBody.reference,
      'det främmande låset ligger kvar orört');

    console.log('3. Godkänn, bekräfta, avboka, neka och auditlogg');
    const d3 = addDays(d2, 10);
    const pending = await createManualBooking(repo, owner,
      bookingBody(d3, addDays(d3, 2), { statusCode: 'PENDING' }),
      { ...options, idempotencyKey: `${options.idempotencyKey}-pending` }
    );
    assert(pending.status === 201, 'förfrågan skapades som PENDING');
    const pendingRef = pending.jsonBody.reference;
    createdReferences.add(pendingRef);
    const approved = await changeStatus(repo, owner, pendingRef, 'approve', {}, options);
    assert(approved.status === 200 && approved.jsonBody.statusCode === 'PRELIMINARY',
      'förfrågan godkändes som PRELIMINARY');
    const confirmed = await changeStatus(repo, owner, pendingRef, 'confirm', {}, options);
    assert(confirmed.status === 200 && confirmed.jsonBody.statusCode === 'CONFIRMED',
      'bokningen bekräftades');
    assert((await repo.listCalendar(d3, addDays(d3, 2))).length === 2,
      'bekräftelsen skapade två nattlås');
    const cancelled = await changeStatus(repo, owner, pendingRef, 'cancel', { reason: 'Testavbokning' }, options);
    assert(cancelled.status === 200 && cancelled.jsonBody.statusCode === 'CANCELLED',
      'bokningen avbokades');
    assert((await repo.listCalendar(d3, addDays(d3, 2))).length === 0,
      'avbokningen frigjorde nattlåsen');
    const history = await repo.listHistory(pendingRef);
    const actions = new Set(history.map((entry) => entry.action));
    for (const action of ['MANUAL_CREATED', 'approve', 'confirm', 'cancel']) {
      assert(actions.has(action), `auditloggen innehåller ${action}`);
    }

    const d4 = addDays(d3, 10);
    const declineMe = await createManualBooking(repo, owner,
      bookingBody(d4, addDays(d4, 1), { statusCode: 'PENDING' }),
      { ...options, idempotencyKey: `${options.idempotencyKey}-decline` }
    );
    createdReferences.add(declineMe.jsonBody.reference);
    const declined = await changeStatus(repo, owner, declineMe.jsonBody.reference, 'decline', {
      reason: 'Testnekande'
    }, options);
    assert(declined.status === 200 && declined.jsonBody.statusCode === 'DECLINED',
      'förfrågan nekades');
    assert((await repo.listCalendar(d4, addDays(d4, 1))).length === 0,
      'nekad förfrågan blockerar inga datum');

    console.log('4. Airbnb-kontrollen fail-closed vid timeout och blockerad natt');
    const d5 = addDays(d4, 10);
    const airbnbPending = await createManualBooking(repo, owner,
      bookingBody(d5, addDays(d5, 2), { statusCode: 'PENDING' }),
      { ...options, idempotencyKey: `${options.idempotencyKey}-airbnb` }
    );
    const airbnbRef = airbnbPending.jsonBody.reference;
    createdReferences.add(airbnbRef);
    const timeout = await changeStatus(repo, owner, airbnbRef, 'confirm', {}, {
      ...options,
      requireAirbnbCheck: true,
      availabilityHandler: async () => { throw new Error('timeout'); }
    });
    assert(timeout.status === 503, 'Airbnb-timeout gav 503, inte bekräftelse');
    assert((await repo.getRawBooking(airbnbRef)).record.statusCode === 'PENDING',
      'bokningen ligger kvar som PENDING efter timeout');
    assert((await repo.listCalendar(d5, addDays(d5, 2))).length === 0,
      'inga nattlås skapades vid timeout');
    const blocked = await changeStatus(repo, owner, airbnbRef, 'confirm', {}, {
      ...options,
      requireAirbnbCheck: true,
      availabilityHandler: async () => ({ status: 200, jsonBody: { blocked: [d5] } })
    });
    assert(blocked.status === 409, 'Airbnb-blockerad natt gav 409');
    assert((await repo.listCalendar(d5, addDays(d5, 2))).length === 0,
      'inga nattlås skapades vid Airbnb-konflikt');
    const airbnbOk = await changeStatus(repo, owner, airbnbRef, 'confirm', {}, {
      ...options,
      requireAirbnbCheck: true,
      availabilityHandler: async () => ({ status: 200, jsonBody: { blocked: [] } })
    });
    assert(airbnbOk.status === 200 && airbnbOk.jsonBody.statusCode === 'CONFIRMED',
      'bekräftelse lyckades när Airbnb-kontrollen svarade utan blockering');
    assert((await repo.listCalendar(d5, addDays(d5, 2))).length === 2,
      'bekräftelsen skapade nattlås efter godkänd Airbnb-kontroll');

    console.log('6. Manuell Airbnb-blockering kan åsidosättas med motivering och audit');
    const d6 = addDays(d5, 10);
    const overridePending = await createManualBooking(repo, owner,
      bookingBody(d6, addDays(d6, 2), { statusCode: 'PENDING' }),
      { ...options, idempotencyKey: `${options.idempotencyKey}-override` }
    );
    const overrideRef = overridePending.jsonBody.reference;
    createdReferences.add(overrideRef);
    const overrideBlocked = await changeStatus(repo, owner, overrideRef, 'confirm', {
      airbnbOverrideIntent: true,
      airbnbOverride: true,
      airbnbOverrideConfirmed: true,
      airbnbOverrideReason: 'Egen Airbnb-blockering för denna bokning'
    }, {
      ...options,
      requireAirbnbCheck: true,
      availabilityHandler: async () => ({ status: 200, jsonBody: { blocked: [d6, addDays(d6, 1)] } })
    });
    assert(overrideBlocked.status === 200 && overrideBlocked.jsonBody.statusCode === 'CONFIRMED',
      'bekräftelse med Airbnb-override lyckades');
    const overrideRaw = await repo.getRawBooking(overrideRef);
    assert(overrideRaw.record.airbnbOverride === true, 'override-flaggan sparades');
    assert(overrideRaw.record.airbnbOverrideReason === 'Egen Airbnb-blockering för denna bokning',
      'motiveringen sparades');
    assert(Array.isArray(overrideRaw.record.airbnbBlockedNights) &&
      overrideRaw.record.airbnbBlockedNights.length === 2, 'de blockerade nätterna sparades');
    assert(overrideRaw.record.airbnbOverrideApprovedBy.length > 0, 'godkännaren sparades');
    assert((await repo.listCalendar(d6, addDays(d6, 2))).length === 2,
      'interna nattlås skapades trots Airbnb-override');
    const overrideHistory = await repo.listHistory(overrideRef);
    assert(overrideHistory.some((entry) => entry.action === 'AIRBNB_OVERRIDE_APPROVED'),
      'Airbnb-override loggades i auditloggen');
  } finally {
    console.log('5. Städar endast testets egna rader');
    for (const reference of createdReferences) await cleanup(reference);
  }

  console.log(`\nIntegrationstest OK: ${passed} kontroller mot ${ACCOUNT}/${TABLE}.`);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
