'use strict';

// Read-only demorepository. All data är syntetisk och varje post är märkt
// isDemo. Repositoryt har inga skrivmetoder och rör aldrig Azure.

const { DEMO_BOOKINGS } = require('../demo-data');
const {
  normalizeBookings,
  filterBookings,
  sortBookings,
  dashboardData
} = require('../domain');

function createDemoRepository(options = {}) {
  const initialNow = options.now ?? new Date();
  function allBookings(now = initialNow) {
    return normalizeBookings(DEMO_BOOKINGS, { now });
  }
  return {
    type: 'demo',
    readOnly: true,
    async listBookings(filters = {}, now = initialNow) {
      return sortBookings(filterBookings(allBookings(now), filters), filters.sort, filters.dir);
    },
    async getBooking(reference, now = initialNow) {
      return allBookings(now).find((booking) => booking.reference === reference) ?? null;
    },
    async dashboard(now = initialNow) {
      return dashboardData(allBookings(now), now);
    },
    async allBookings(now = initialNow) {
      return allBookings(now);
    }
  };
}

module.exports = { createDemoRepository };
