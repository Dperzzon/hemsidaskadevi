'use strict';

// Skrivbart demorepository. All data är syntetisk och stannar i processminnet.
// Det används bara med --demo/--dev-auth och rör aldrig Azure. Metodnamnen är
// medvetet createRequest/updateRequest/deleteRequest (inte save/update/delete)
// så att den read-only-gränsen kan verifieras i befintliga tester.

const { DEMO_BOOKINGS } = require('../demo-data');
const {
  normalizeBookings,
  filterBookings,
  sortBookings,
  dashboardData,
  nightKeys
} = require('../domain');

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function etagFor(record) {
  return `demo-etag-${record.reference}-${record.version ?? 1}`;
}

function createDemoRepository(options = {}) {
  const initialNow = options.now ?? new Date();
  const requests = new Map();
  const calendar = new Map();
  const history = [];
  const outbox = [];

  for (const source of DEMO_BOOKINGS) {
    const record = clone(source);
    record.rowKey = record.idempotencyKey;
    record.statusCode = record.statusCode ?? 'PENDING';
    record.bookingSource = record.bookingSource ?? 'WEB';
    record.version = record.version ?? 1;
    requests.set(record.idempotencyKey, record);
    if (record.statusCode === 'CONFIRMED') {
      for (const night of nightKeys(record.arrival, record.departure)) {
        calendar.set(night, {
          night,
          type: 'BOOKING',
          reference: record.reference,
          blockId: '',
          source: record.bookingSource,
          note: '',
          createdBy: 'Demo',
          createdAt: record.createdAt
        });
      }
    }
  }

  function allBookings(now = initialNow) {
    return normalizeBookings([...requests.values()], { now, etagMap: null }).map((booking) => ({
      ...booking,
      etag: etagFor(requests.get(booking.idempotencyKey) ?? booking)
    }));
  }

  function getRawBooking(reference) {
    const record = [...requests.values()].find((item) => item.reference === reference);
    if (!record) return null;
    return { record: clone(record), etag: etagFor(record) };
  }

  function createCalendarNight(night, data) {
    if (calendar.has(night)) {
      const cause = new Error('Natten är redan blockerad');
      cause.status = 409;
      throw cause;
    }
    calendar.set(night, { night, ...data });
  }

  function deleteCalendarNight(night, reference) {
    const existing = calendar.get(night);
    if (!existing) return;
    if (reference && existing.reference !== reference) {
      const cause = new Error('Natten tillhör en annan bokning');
      cause.status = 409;
      throw cause;
    }
    calendar.delete(night);
  }

  return {
    type: 'demo',
    readOnly: false,
    writable: true,
    async listBookings(filters = {}, now = initialNow) {
      return sortBookings(filterBookings(allBookings(now), filters), filters.sort, filters.dir);
    },
    async getBooking(reference, now = initialNow) {
      const booking = allBookings(now).find((item) => item.reference === reference) ?? null;
      if (!booking) return null;
      return { ...booking, etag: etagFor(requests.get(booking.idempotencyKey) ?? booking) };
    },
    async getRawBooking(reference) {
      return getRawBooking(reference);
    },
    async findByIdempotencyKey(key) {
      const record = requests.get(key);
      return record ? clone(record) : null;
    },
    async findByReference(reference) {
      return getRawBooking(reference)?.record ?? null;
    },
    async createRequest(record) {
      if (requests.has(record.idempotencyKey)) {
        return { duplicate: true, record: clone(requests.get(record.idempotencyKey)) };
      }
      const stored = clone(record);
      requests.set(stored.idempotencyKey, stored);
      return { duplicate: false, record: clone(stored) };
    },
    async updateRequest(record, { ifMatch } = {}) {
      const current = requests.get(record.idempotencyKey) ??
        [...requests.values()].find((item) => item.reference === record.reference);
      if (!current) {
        const cause = new Error('Bokningen hittades inte');
        cause.status = 404;
        throw cause;
      }
      if (ifMatch && ifMatch !== etagFor(current)) {
        const cause = new Error('ETag-konflikt');
        cause.status = 409;
        throw cause;
      }
      const stored = clone({ ...record, idempotencyKey: current.idempotencyKey, rowKey: current.rowKey });
      requests.set(current.idempotencyKey, stored);
      return { record: clone(stored), etag: etagFor(stored) };
    },
    async deleteRequest(key, { ifMatch } = {}) {
      const record = requests.get(key) ??
        [...requests.values()].find((item) => item.reference === key);
      if (!record) {
        const cause = new Error('Bokningen hittades inte');
        cause.status = 404;
        throw cause;
      }
      if (ifMatch && ifMatch !== etagFor(record)) {
        const cause = new Error('ETag-konflikt');
        cause.status = 409;
        throw cause;
      }
      requests.delete(record.idempotencyKey);
    },
    async listCalendar(from, to) {
      return [...calendar.values()]
        .filter((row) => row.night >= from && row.night < to)
        .sort((a, b) => a.night.localeCompare(b.night))
        .map(clone);
    },
    async listCalendarByReference(reference) {
      return [...calendar.values()].filter((row) => row.reference === reference).map(clone);
    },
    async createCalendarNight(night, data) {
      createCalendarNight(night, data);
    },
    async deleteCalendarNight(night, reference) {
      deleteCalendarNight(night, reference);
    },
    async appendHistory(entry) {
      history.push(clone(entry));
    },
    async listHistory(reference) {
      return history
        .filter((entry) => entry.reference === reference)
        .sort((a, b) => b.at.localeCompare(a.at))
        .map(clone);
    },
    async saveOutbox(entry) {
      outbox.push(clone(entry));
    },
    async dashboard(now = initialNow) {
      return dashboardData(allBookings(now), now);
    },
    async allBookings(now = initialNow) {
      return allBookings(now);
    }
  };
}

module.exports = { createDemoRepository, etagFor };
