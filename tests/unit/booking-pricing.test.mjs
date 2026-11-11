// Enhetstester för klientens prislogik (src/js/booking/pricing.js):
// tillval, rabatter och komplett totalprisberäkning — samma regler som
// serverns (tests/unit/server-pricing.test.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as pricing from '../../src/js/booking/pricing.js';

test('formatSek formaterar belopp i SEK med svenska tusentalsavgränsare', () => {
  assert.match(pricing.formatSek(2000), /^2[\s\u00a0\u202f]000 kr$/);
  assert.match(pricing.formatSek(100000), /^100[\s\u00a0\u202f]000 kr$/);
  assert.equal(pricing.formatSek(0), '0 kr');
  assert.equal(pricing.formatSek(200), '200 kr');
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

test('tidig incheckning och sen utcheckning förklarar tiderna och bekräftelsekravet', () => {
  const tidig = pricing.ADDONS.find((addon) => addon.id === 'tidigIncheckning');
  const sen = pricing.ADDONS.find((addon) => addon.id === 'senUtcheckning');
  assert.match(tidig.note, /Ordinarie incheckning är kl\. 14\.00/);
  assert.match(tidig.note, /kl\. 09\.00/);
  assert.match(tidig.note, /bekräftas av Skadevi Herrgård/);
  assert.match(tidig.note, /inte enbart genom betalning/);
  assert.match(sen.note, /Ordinarie utcheckning är kl\. 11\.00/);
  assert.match(sen.note, /stanna till kl\. 16\.00/);
  assert.match(sen.note, /bekräftas av Skadevi Herrgård/);
});

test('addonLines beräknar alla tillvalskombinationer', () => {
  assert.deepEqual(pricing.addonLines({}), []);
  const lines = pricing.addonLines({
    slutstad: true, lakan: true, linenCount: 4, guests: 4,
    ved: true, tidigIncheckning: true, senUtcheckning: true
  });
  assert.deepEqual(lines.map((line) => line.amount), [2500, 800, 350, 500, 500]);
  assert.equal(lines.find((line) => line.id === 'lakan').label.includes('4 pers'), true);
  // Önskemålen (tidig incheckning / sen utcheckning) ska vara märkta.
  assert.equal(lines.filter((line) => line.request).length, 2);
});

test('lakan räknas på 0 till antal gäster — aldrig fler', () => {
  const zero = pricing.addonLines({ lakan: true, linenCount: 0, guests: 4 });
  assert.equal(zero[0].amount, 0);
  assert.equal(zero[0].label.includes('0 pers'), true);
  const clamp = pricing.addonLines({ lakan: true, linenCount: 12, guests: 4 });
  assert.equal(clamp[0].amount, 800);
  assert.equal(clamp[0].label.includes('4 pers'), true);
});

test('sumAddons summerar tillvalen', () => {
  assert.equal(pricing.sumAddons([]), 0);
  assert.equal(
    pricing.sumAddons(pricing.addonLines({ slutstad: true, lakan: true, linenCount: 2, guests: 4, ved: true })),
    2500 + 400 + 350
  );
});

test('varje veckodags nattpris: söndag–torsdag 7 000, fredag/lördag 10 000', () => {
  // 2026-11-15 = söndag … 2026-11-21 = lördag.
  assert.deepEqual(
    ['2026-11-15', '2026-11-16', '2026-11-17', '2026-11-18', '2026-11-19'].map((d) => pricing.nightRate(d).rate),
    [7000, 7000, 7000, 7000, 7000]
  );
  assert.equal(pricing.nightRate('2026-11-20').rate, 10000); // fredag
  assert.equal(pricing.nightRate('2026-11-21').rate, 10000); // lördag
  assert.equal(pricing.nightRate('2026-11-20').type, 'friday');
  assert.equal(pricing.nightRate('2026-11-21').type, 'saturday');
});

test('högpris ersätter ordinarie pris i godkända perioder (prioritetsordningen)', () => {
  const period = { id: 'test-client', label: 'Test', start: '2026-11-01', end: '2026-11-30', approved: true };
  pricing.PRICE_CONFIG.peakPeriods.push(period);
  try {
    assert.equal(pricing.nightRate('2026-11-20').rate, 12000); // fredag: 12 000, inte 10 000
    assert.equal(pricing.nightRate('2026-11-20').type, 'peak');
    assert.equal(pricing.nightRate('2026-11-17').rate, 12000); // tisdag
  } finally {
    pricing.PRICE_CONFIG.peakPeriods.pop();
  }
});

test('godkända högtidsperioder påverkar totalpriset', () => {
  assert.equal(pricing.PRICE_CONFIG.peakPeriods.every((p) => p.approved), true);
  // Midsommar 2026 (godkänd, torsdag–söndag): fre + lör = 2 × 12 000.
  const q = pricing.quote({ arrival: '2026-06-19', departure: '2026-06-21' });
  assert.equal(q.lodgingBase, 24000);
  assert.equal(q.peakNights, 2);
  // Utanför alla perioder: ordinarie helgpris.
  const q2 = pricing.quote({ arrival: '2026-11-20', departure: '2026-11-22' });
  assert.equal(q2.lodgingBase, 20000);
  assert.equal(q2.peakNights, 0);
});

test('totalpris: vanlig helg — ankomst fredag, avresa söndag = 20 000 kr', () => {
  const q = pricing.quote({ arrival: '2026-11-20', departure: '2026-11-22' });
  assert.deepEqual(q.nightlyBreakdown.map((n) => n.rate), [10000, 10000]);
  assert.equal(q.total, 20000);
  assert.equal(q.discount, null);
});

test('totalpris: vardagsvistelse må–tors med ett tillval', () => {
  const q = pricing.quote({
    arrival: '2026-11-16', departure: '2026-11-19', guests: 2,
    addons: { slutstad: true }
  });
  assert.equal(q.lodgingBase, 21000);
  assert.equal(q.addonsTotal, 2500);
  assert.equal(q.total, 23500);
});

test('totalpris: veckovistelse med veckorabatt 30 %', () => {
  const q = pricing.quote({ arrival: '2026-11-16', departure: '2026-11-23' });
  assert.equal(q.lodgingBase, 55000);
  assert.equal(q.discount.percent, 30);
  assert.equal(q.discountAmount, 16500);
  assert.equal(q.lodgingAfterDiscount, 38500);
  assert.equal(q.total, 38500);
});

test('totalpris: månadsrabatt 69 % ersätter veckorabatten vid 28 nätter', () => {
  const q = pricing.quote({ arrival: '2026-11-01', departure: '2026-11-29' });
  assert.equal(q.nights, 28);
  assert.equal(q.discount.percent, 69);
  assert.equal(q.total, Math.round(q.lodgingBase * 0.31));
});

test('rabatter dras endast på boendepriset', () => {
  const q = pricing.quote({
    arrival: '2026-11-16', departure: '2026-11-23', guests: 2,
    addons: { slutstad: true, lakan: true, linenCount: 2 }
  });
  assert.equal(q.lodgingAfterDiscount, 38500);
  assert.equal(q.addonsTotal, 2900);
  assert.equal(q.total, 41400);
});

test('totalpris: vistelse över nyår (godkänd jul-/nyårsperiod)', () => {
  const q = pricing.quote({ arrival: '2026-12-30', departure: '2027-01-02' });
  assert.deepEqual(q.nightlyBreakdown.map((n) => n.rate), [12000, 12000, 12000]);
  assert.equal(q.peakNights, 3);
  assert.equal(q.total, 36000);
  // Sista godkända natten 2027-01-04, därefter ordinarie vardagspris.
  assert.equal(pricing.nightRate('2027-01-04').type, 'peak');
  assert.equal(pricing.nightRate('2027-01-05').rate, 7000);
});

test('skottår och sommartidsomställningar ger korrekt nattantal', () => {
  assert.equal(pricing.quote({ arrival: '2028-02-28', departure: '2028-03-01' }).nights, 2);
  assert.equal(pricing.quote({ arrival: '2026-03-28', departure: '2026-03-30' }).nights, 2);
});

test('ofullständig vistelse visar aldrig missvisande totalpris', () => {
  assert.equal(pricing.quote({ arrival: '', departure: '2026-11-23' }).incomplete, true);
  assert.equal(pricing.quote({ arrival: '2026-11-23', departure: '2026-11-23' }).incomplete, true);
});

test('klienten och servern använder samma prisreglerversion', () => {
  assert.equal(pricing.PRICE_VERSION, '2026-11-11.4');
  assert.ok(pricing.PRICE_CONFIG.discounts.length >= 2);
});

test('påsk: skärtorsdagen–annandag påsk (2026–2028)', () => {
  assert.equal(pricing.nightRate('2026-04-01').type, 'weekday');
  assert.equal(pricing.nightRate('2026-04-02').type, 'peak');
  assert.equal(pricing.nightRate('2026-04-06').type, 'peak');
  assert.equal(pricing.nightRate('2026-04-07').type, 'weekday');
  assert.equal(pricing.nightRate('2027-03-25').type, 'peak');
  assert.equal(pricing.nightRate('2027-03-29').type, 'peak');
  assert.equal(pricing.nightRate('2027-03-30').type, 'weekday');
  assert.equal(pricing.nightRate('2028-04-13').type, 'peak');
  assert.equal(pricing.nightRate('2028-04-17').type, 'peak');
  assert.equal(pricing.nightRate('2028-04-18').type, 'weekday');
});

test('inkluderande slutdatum: söndagsnatt vid midsommar och måndagsnatt vid påsk får högpris', () => {
  assert.equal(pricing.nightRate('2026-06-21').type, 'peak'); // söndag
  assert.equal(pricing.nightRate('2026-04-06').type, 'peak'); // måndag, annandag påsk
  assert.equal(pricing.nightRate('2027-06-27').type, 'peak');
  assert.equal(pricing.nightRate('2027-03-29').type, 'peak');
  assert.equal(pricing.nightRate('2028-06-25').type, 'peak');
  assert.equal(pricing.nightRate('2028-04-17').type, 'peak');
});

test('rabattinfo beskriver rabatten diskret', () => {
  assert.match(pricing.discountNote(7), /Veckorabatt 30 %/);
  assert.match(pricing.discountNote(28), /Månadsrabatt 69 %/);
  assert.equal(pricing.discountNote(3), null);
});
