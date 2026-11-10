// Enhetstester för rena datumfunktioner i bokningsflödet.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as dates from '../../src/js/booking/dates.js';

test('nightsBetween räknar nätter exklusivt avresedagen', () => {
  assert.equal(dates.nightsBetween('2026-11-10', '2026-11-13'), 3);
  assert.equal(dates.nightsBetween('2026-11-10', '2026-11-11'), 1);
  assert.equal(dates.nightsBetween('2026-11-10', '2026-11-10'), 0);
  assert.equal(dates.nightsBetween(null, null), 0);
});

test('nightsBetween fungerar över årsskiftet', () => {
  assert.equal(dates.nightsBetween('2026-12-29', '2027-01-03'), 5);
});

test('eachNight listar nätterna i perioden', () => {
  assert.deepEqual(dates.eachNight('2026-11-10', '2026-11-13'), ['2026-11-10', '2026-11-11', '2026-11-12']);
  assert.deepEqual(dates.eachNight('2026-11-10', '2026-11-11'), ['2026-11-10']);
});

test('stockholmTodayKey ger dagens datum i svensk tid', () => {
  // Vintertid (UTC+1): 2026-11-10 23:30 UTC är 11 november i Sverige.
  assert.equal(dates.stockholmTodayKey(new Date('2026-11-10T23:30:00Z')), '2026-11-11');
  assert.equal(dates.stockholmTodayKey(new Date('2026-11-10T12:00:00Z')), '2026-11-10');
  // Sommartid (UTC+2): 2026-07-01 22:30 UTC är 2 juli i Sverige.
  assert.equal(dates.stockholmTodayKey(new Date('2026-07-01T22:30:00Z')), '2026-07-02');
});

test('validateArrival avvisar förflutna och bokade datum', () => {
  const blocked = new Set(['2026-11-12', '2026-11-13']);
  assert.deepEqual(dates.validateArrival('2026-11-12', blocked, '2026-11-10'), { ok: false, reason: 'booked' });
  assert.deepEqual(dates.validateArrival('2026-11-09', blocked, '2026-11-10'), { ok: false, reason: 'past' });
  assert.deepEqual(dates.validateArrival('2026-11-10', blocked, '2026-11-10'), { ok: true });
});

test('validateRange kräver att alla nätter är lediga', () => {
  const blocked = new Set(['2026-11-13']);
  // Avresedagen får vara bokad (det är ingen natt).
  assert.deepEqual(dates.validateRange('2026-11-12', '2026-11-13', blocked), { ok: true });
  // Men en bokad natt i mitten avvisas med första blockerade natten.
  assert.deepEqual(dates.validateRange('2026-11-12', '2026-11-15', blocked), {
    ok: false, reason: 'booked-night', firstBlocked: '2026-11-13'
  });
  assert.deepEqual(dates.validateRange('2026-11-15', '2026-11-13', blocked), { ok: false, reason: 'incomplete' });
  assert.deepEqual(dates.validateRange('2026-11-13', '2026-11-13', blocked), { ok: false, reason: 'incomplete' });
});

test('validateRange fungerar över månads- och årsskiften', () => {
  const blocked = new Set(['2026-12-30', '2026-12-31', '2027-01-01']);
  assert.deepEqual(dates.validateRange('2026-12-28', '2027-01-02', blocked), {
    ok: false, reason: 'booked-night', firstBlocked: '2026-12-30'
  });
  assert.deepEqual(dates.validateRange('2026-12-28', '2026-12-30', blocked), { ok: true });
  assert.deepEqual(dates.validateRange('2027-01-02', '2027-01-03', blocked), { ok: true });
});
