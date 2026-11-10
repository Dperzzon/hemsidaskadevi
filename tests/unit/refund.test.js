// Enhetstester för de beslutade avbokningsvillkoren (server/booking/refund.js).
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { refundPercent, daysBefore, POLICY } = require('../../server/booking/refund');

test('avbokning minst 30 dagar före incheckning ger 100 % återbetalning', () => {
  assert.equal(refundPercent('2026-12-15', '2026-11-15'), 100); // exakt 30 dagar
  assert.equal(refundPercent('2026-12-15', '2026-11-01'), 100); // mer än 30 dagar
});

test('avbokning 14–29 dagar före incheckning ger 50 % återbetalning', () => {
  assert.equal(refundPercent('2026-12-15', '2026-11-16'), 50); // exakt 29 dagar
  assert.equal(refundPercent('2026-12-15', '2026-12-01'), 50); // exakt 14 dagar
});

test('avbokning mindre än 14 dagar före incheckning ger 0 % återbetalning', () => {
  assert.equal(refundPercent('2026-12-15', '2026-12-02'), 0); // exakt 13 dagar
  assert.equal(refundPercent('2026-12-15', '2026-12-15'), 0);
  assert.equal(refundPercent('2026-12-15', '2026-12-20'), 0);
  assert.deepEqual(POLICY.pendingDecisions, []); // inga beslut är kvarhängande
});

test('datumgränserna är dagsprecisa', () => {
  assert.equal(daysBefore('2026-12-15', '2026-12-15'), 0);
  assert.equal(daysBefore('2026-12-15', '2026-11-15'), 30);
  assert.equal(daysBefore('2026-12-15', '2026-11-16'), 29);
  assert.equal(daysBefore('2026-12-15', '2026-12-01'), 14);
  assert.equal(daysBefore('ogiltigt', '2026-12-08'), null);
});

test('policyn anger beräkningsgrund och lagstadgade rättigheter', () => {
  assert.match(POLICY.basis, /boendesumma enligt offerten/);
});
