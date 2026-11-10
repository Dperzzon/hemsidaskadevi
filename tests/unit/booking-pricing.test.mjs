// Enhetstester för prislogiken i bokningsflödet (tillval och summering).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as pricing from '../../src/js/booking/pricing.js';

test('formatSek formaterar belopp i SEK', () => {
  // tusentalsavgränsare i sv-SE kan vara hårt/blanksteg — matcha med regex.
  assert.match(pricing.formatSek(2000), /^2[\s\u00a0\u202f]000 kr$/);
  assert.equal(pricing.formatSek(0), '0 kr');
  assert.equal(pricing.formatSek(200), '200 kr');
});

test('addonLines beräknar alla tillvalskombinationer', () => {
  assert.deepEqual(pricing.addonLines({}), []);
  const lines = pricing.addonLines({
    slutstad: true, lakan: true, linenCount: 4, ved: true,
    tidigIncheckning: true, senUtcheckning: true
  });
  assert.deepEqual(lines.map((line) => line.amount), [2500, 800, 350, 500, 500]);
  assert.equal(lines.find((line) => line.id === 'lakan').label.includes('4 pers × 200 kr'), true);
  // Önskemålen (tidig incheckning / sen utcheckning) ska vara märkta.
  assert.equal(lines.filter((line) => line.request).length, 2);
});

test('addonLines använder 1 person som minimiantal för lakan', () => {
  const lines = pricing.addonLines({ lakan: true, linenCount: 0 });
  assert.equal(lines[0].amount, 200);
  assert.equal(lines[0].label.includes('1 pers'), true);
});

test('sumAddons summerar tillvalen', () => {
  assert.equal(pricing.sumAddons([]), 0);
  assert.equal(
    pricing.sumAddons(pricing.addonLines({ slutstad: true, lakan: true, linenCount: 2, ved: true })),
    2500 + 400 + 350
  );
});

test('alla tillval är frivilliga och har verifierade priser', () => {
  for (const addon of pricing.ADDONS) {
    assert.equal(typeof addon.price, 'number');
    assert.ok(addon.price > 0);
    assert.ok(addon.label);
  }
  assert.equal(pricing.ADDONS.find((addon) => addon.id === 'slutstad').price, 2500);
  assert.equal(pricing.ADDONS.find((addon) => addon.id === 'lakan').price, 200);
  assert.equal(pricing.ADDONS.find((addon) => addon.id === 'ved').price, 350);
  assert.equal(pricing.ADDONS.find((addon) => addon.id === 'tidigIncheckning').price, 500);
  assert.equal(pricing.ADDONS.find((addon) => addon.id === 'senUtcheckning').price, 500);
});

test('veckorabatt 30 % gäller från 7 nätter', () => {
  assert.equal(pricing.bestDiscount(6), null);
  assert.deepEqual(pricing.bestDiscount(7), { id: 'veckorabatt', label: 'Veckorabatt', percent: 30, minNights: 7 });
  assert.deepEqual(pricing.bestDiscount(27), { id: 'veckorabatt', label: 'Veckorabatt', percent: 30, minNights: 7 });
});

test('månadsrabatt 69 % gäller från 28 nätter och ersätter veckorabatten', () => {
  assert.deepEqual(pricing.bestDiscount(28), { id: 'manadsrabatt', label: 'Månadsrabatt', percent: 69, minNights: 28 });
  assert.deepEqual(pricing.bestDiscount(93), { id: 'manadsrabatt', label: 'Månadsrabatt', percent: 69, minNights: 28 });
});

test('ingen rabatt används felaktigt under gränsvärdena', () => {
  for (const nights of [0, 1, 2, 3, 6]) {
    assert.equal(pricing.bestDiscount(nights), null, `${nights} nätter ska inte ge rabatt`);
    assert.equal(pricing.discountNote(nights), null);
  }
});

test('applyDiscount räknar korrekt och kan användas när grundpris finns', () => {
  const weekly = pricing.bestDiscount(7);
  const monthly = pricing.bestDiscount(28);
  assert.equal(pricing.applyDiscount(10000, weekly), 7000);
  assert.equal(pricing.applyDiscount(10000, monthly), 3100);
  assert.equal(pricing.applyDiscount(10000, null), 10000);
});

test('discountNote beskriver rabatten diskret utan totalsummor', () => {
  assert.match(pricing.discountNote(7), /Veckorabatt 30 %/);
  assert.match(pricing.discountNote(7), /boendepriset i offerten/);
  assert.match(pricing.discountNote(28), /Månadsrabatt 69 %/);
  assert.equal(pricing.discountNote(3), null);
  // Noten får aldrig innehålla en påhittad totalsumma i kronor.
  assert.doesNotMatch(pricing.discountNote(7), /kr/);
});
