// Enhetstester för den auktoritativa prisberäkningen på serversidan
// (server/booking/pricing.js) samt konsistens mot den gemensamma
// prisdefinitionen (shared/pricing-config.json).
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  PRICE_VERSION, CONFIG, nightRate, bestDiscount, nightsBetween, nightKeys, quote,
  addonTotals, dayNumber, keyFromDayNumber, weekdayOf
} = require('../../server/booking/pricing');

const RATES = CONFIG.nightRates;

test('varje veckodags nattpris: söndag–torsdag 7 000 kr, fredag och lördag 10 000 kr', () => {
  // Vecka: 2026-11-15 = söndag … 2026-11-21 = lördag.
  const rates = {
    söndag: '2026-11-15', måndag: '2026-11-16', tisdag: '2026-11-17',
    onsdag: '2026-11-18', torsdag: '2026-11-19', fredag: '2026-11-20', lördag: '2026-11-21'
  };
  assert.equal(weekdayOf(rates.söndag), 0);
  assert.equal(weekdayOf(rates.lördag), 6);
  for (const [name, key] of Object.entries(rates)) {
    const { rate, type } = nightRate(key);
    if (name === 'fredag' || name === 'lördag') {
      assert.equal(rate, 10000, `${name} ska kosta 10 000 kr`);
      assert.ok(type === 'friday' || type === 'saturday');
    } else {
      assert.equal(rate, 7000, `${name} ska kosta 7 000 kr`);
      assert.equal(type, 'weekday');
    }
  }
});

test('högpris prioriteras före helgpris: fredag/lördag i godkänd högtidsperiod = 12 000 kr', () => {
  // Konfigurationen saknar godkända perioder — utövar logiken med en tillfällig.
  const period = { id: 'testperiod', label: 'Test', start: '2026-06-01', end: '2026-06-30', approved: true };
  CONFIG.peakPeriods.push(period);
  try {
    assert.equal(nightRate('2026-06-19').rate, RATES.peak); // fredag
    assert.equal(nightRate('2026-06-20').rate, RATES.peak); // lördag
    assert.equal(nightRate('2026-06-16').rate, RATES.peak); // tisdag
    assert.equal(nightRate('2026-06-19').type, 'peak');
    assert.equal(nightRate('2026-05-15').rate, RATES.friday); // utanför perioden
  } finally {
    CONFIG.peakPeriods.pop();
  }
});

test('föreslagna men ännu inte godkända högprisperioder påverkar inte totalpriset', () => {
  // Samtliga perioder i konfigurationen är förslag (approved: false).
  assert.equal(CONFIG.peakPeriods.filter((p) => p.approved).length, 0);
  // Midsommarhelgen 2026 (föreslagen) prisas därför ordinarie: fre/lör 10 000.
  assert.equal(nightRate('2026-06-19').rate, RATES.friday);
  assert.equal(nightRate('2026-06-20').rate, RATES.saturday);
  const q = quote({ arrival: '2026-06-19', departure: '2026-06-21' });
  assert.equal(q.lodgingBase, 20000);
  assert.equal(q.peakNights, 0);
});

test('blandade vardags-, helg- och högtidsnätter med godkänd period', () => {
  // Godkänd period som täcker vardag + helg.
  const period = { id: 'test-blandad', label: 'Test', start: '2026-11-16', end: '2026-11-22', approved: true };
  CONFIG.peakPeriods.push(period);
  try {
    const q = quote({ arrival: '2026-11-16', departure: '2026-11-23' }); // må–sö (7 nätter)
    assert.equal(q.peakNights, 7);
    assert.equal(q.lodgingBase, 7 * RATES.peak);
    assert.deepEqual(q.discount, { id: 'veckorabatt', label: 'Veckorabatt', percent: 30, amount: Math.round(7 * RATES.peak * 0.3) });
    assert.equal(q.lodgingAfterDiscount, Math.round(7 * RATES.peak * 0.7));
  } finally {
    CONFIG.peakPeriods.pop();
  }
});

test('vistelser över nyår (årsskifte) räknas med avresedagen odebiterad', () => {
  assert.deepEqual(nightKeys('2026-12-30', '2027-01-02'), ['2026-12-30', '2026-12-31', '2027-01-01']);
  assert.equal(nightsBetween('2026-12-31', '2027-01-01'), 1);
  // Fredag 1 januari 2027 → helgpris, nätterna 30–31 december 2026: ons/tors 7 000.
  const q = quote({ arrival: '2026-12-30', departure: '2027-01-02' });
  assert.deepEqual(q.nightlyBreakdown.map((n) => n.rate), [RATES.weekday, RATES.weekday, RATES.friday]);
  assert.equal(q.total, RATES.weekday * 2 + RATES.friday);
});

test('skottår och sommartidsomställningar räknas kalenderdag-precist', () => {
  assert.equal(nightsBetween('2028-02-28', '2028-03-01'), 2); // 2028 är skottår
  assert.equal(nightsBetween('2027-02-28', '2027-03-01'), 1);
  assert.equal(nightsBetween('2026-02-28', '2026-03-01'), 1);
  // Sommartidsomställning mars 2026 (29 mars) — nattantalet ändras inte.
  assert.equal(nightsBetween('2026-03-28', '2026-03-30'), 2);
  assert.equal(nightsBetween('2026-10-24', '2026-10-26'), 2); // october omställning
  assert.equal(nightsBetween('2027-01-01', '2027-01-31'), 30);
  assert.equal(nightsBetween('2026-01-01', '2027-01-01'), 365);
  assert.equal(nightsBetween('2028-01-01', '2029-01-01'), 366);
  assert.equal(keyFromDayNumber(dayNumber('2028-02-29')), '2028-02-29');
  assert.equal(keyFromDayNumber(dayNumber('2026-03-01')), '2026-03-01');
  assert.equal(keyFromDayNumber(dayNumber('2027-12-31')), '2027-12-31');
});

test('6, 7, 27 och 28 nätter: rabatter träder in vid 7 respektive 28 nätter', () => {
  assert.equal(bestDiscount(6), null);
  assert.equal(bestDiscount(7).id, 'veckorabatt');
  assert.equal(bestDiscount(27).id, 'veckorabatt');
  assert.equal(bestDiscount(28).id, 'manadsrabatt');
  assert.equal(bestDiscount(93).id, 'manadsrabatt');
});

test('rabatterna staplas inte: 28 nätter ger månadsrabatten 69 %, inte båda', () => {
  const discount = bestDiscount(28);
  assert.equal(discount.percent, 69);
  const q = quote({ arrival: '2026-11-01', departure: '2026-11-29' }); // 28 nätter
  const expectedBase = q.nightlyBreakdown.reduce((sum, n) => sum + n.rate, 0);
  assert.equal(q.lodgingBase, expectedBase);
  assert.equal(q.discountAmount, Math.round(expectedBase * 0.69));
  assert.equal(q.lodgingAfterDiscount, expectedBase - q.discountAmount);
  assert.equal(q.lodgingAfterDiscount, Math.round(expectedBase * 0.31));
});

test('rabatter dras endast på boendepriset — tillval är orabatterade', () => {
  // 7 nätter må–sö: 5 vardagsnätter + fredag + lördag = 55 000 kr;
  // veckorabatt 30 % → 38 500 kr; tillval orörda.
  const q = quote({
    arrival: '2026-11-16', departure: '2026-11-23', guests: 2,
    addons: { slutstad: true, lakan: true, linenCount: 2, ved: true, tidigIncheckning: true, senUtcheckning: true }
  });
  assert.equal(q.lodgingBase, 5 * RATES.weekday + RATES.friday + RATES.saturday);
  assert.equal(q.lodgingAfterDiscount, Math.round(q.lodgingBase * 0.7));
  assert.equal(q.addonsTotal, 2500 + 400 + 350 + 500 + 500);
  assert.equal(q.total, q.lodgingAfterDiscount + q.addonsTotal);
});

test('tillval och antal personer: lakan per person 0 till antal gäster', () => {
  const addons = { lakan: true };
  assert.deepEqual(addonTotals(addons, 5, 5).total, 1000);
  assert.deepEqual(addonTotals(addons, 5, 0).total, 0);
  assert.deepEqual(addonTotals(addons, 5, 12).total, 1000); // klamras till gästantal
  const lines = addonTotals(addons, 5, 3).lines;
  assert.equal(lines[0].quantity, 3);
  assert.equal(lines[0].amount, 600);
  // Okända/ogiltiga värden ger 0, inte felaktiga belopp.
  assert.deepEqual(addonTotals({ lakan: true }, 5, 'x').total, 0);
});

test('exempel: vanlig helg — ankomst fredag, avresa söndag = 20 000 kr', () => {
  const q = quote({ arrival: '2026-11-20', departure: '2026-11-22' }); // fre–sön
  assert.deepEqual(q.nightlyBreakdown.map((n) => n.rate), [RATES.friday, RATES.saturday]);
  assert.equal(q.lodgingBase, 20000);
  assert.equal(q.total, 20000);
  assert.equal(q.discount, null);
});

test('exempel: veckovistelse med veckorabatt', () => {
  const q = quote({ arrival: '2026-11-16', departure: '2026-11-23' }); // må–sö
  assert.equal(q.lodgingBase, 5 * RATES.weekday + RATES.friday + RATES.saturday); // 55 000 kr
  assert.equal(q.lodgingAfterDiscount, Math.round(55000 * 0.7)); // 38 500 kr
  assert.equal(q.total, 38500);
});

test('prisreglernas version sparas med offerten', () => {
  const q = quote({ arrival: '2026-11-20', departure: '2026-11-23' });
  assert.equal(q.priceVersion, PRICE_VERSION);
  assert.ok(PRICE_VERSION.length > 0);
});

test('ofullständig vistelse ger ingen felaktig offert', () => {
  assert.equal(quote({ arrival: '2026-11-20', departure: '2026-11-20' }).incomplete, true);
  assert.equal(quote({ arrival: '', departure: '2026-11-23' }).incomplete, true);
  assert.equal(quote({ arrival: '2026-11-23', departure: '2026-11-20' }).incomplete, true);
});

test('peakExemptFromDiscounts-flaggan kan aktivera undantag utan ombyggnad', () => {
  const period = { id: 'test-exempt', label: 'Test', start: '2026-11-16', end: '2026-11-22', approved: true };
  CONFIG.peakPeriods.push(period);
  const original = CONFIG.peakExemptFromDiscounts;
  CONFIG.peakExemptFromDiscounts = true;
  try {
    // 7 högtidsnätter: 84 000 kr. Rabatten gäller endast icke-högtidsdel (0 kr).
    const q = quote({ arrival: '2026-11-16', departure: '2026-11-23' });
    assert.equal(q.discount, null); // inga rabattberättigade kronor → ingen rabatt
    // Blandad period: 2 vardagsnätter utanför + 5 högtidsnätter.
    const period2 = { id: 'test-exempt-2', label: 'Test', start: '2026-11-18', end: '2026-11-22', approved: true };
    CONFIG.peakPeriods.pop();
    CONFIG.peakPeriods.push(period2);
    const q2 = quote({ arrival: '2026-11-16', departure: '2026-11-23' });
    assert.equal(q2.lodgingBase, 2 * RATES.weekday + 5 * RATES.peak);
    const exemptBase = 2 * RATES.weekday;
    assert.equal(q2.lodgingAfterDiscount, exemptBase - Math.round(exemptBase * 0.3) + 5 * RATES.peak);
  } finally {
    CONFIG.peakPeriods.pop();
    CONFIG.peakExemptFromDiscounts = original;
  }
});

test('högprisperioder i konfigurationen är förslag tills de godkänts', () => {
  for (const period of CONFIG.peakPeriods) {
    assert.equal(period.approved, false, `${period.id} ska vara ombeslutat (approved: false)`);
    assert.ok(period.start && period.end && period.label, `${period.id} saknar datum/etikett`);
    assert.ok(period.end >= period.start, `${period.id} har omvänd ordning`);
    assert.ok(Number.isFinite(Number(period.year)));
  }
  // Periodelängden är rimlig (upp till 3 veckor för jul/mellandagarna).
  for (const period of CONFIG.peakPeriods) {
    assert.ok(nightsBetween(period.start, period.end) + 1 <= 21, `${period.id} är orealistiskt lång`);
  }
});

test('högprisperioderna för 2026–2028 täcker förväntade högtider (förslag)', () => {
  const periods = CONFIG.peakPeriods.filter((p) => p.approved === false);
  for (const year of [2026, 2027, 2028]) {
    const ids = periods.filter((p) => p.year === year).map((p) => p.id);
    assert.ok(ids.some((id) => id.startsWith('pasklov')), `påsk ${year} saknas`);
    assert.ok(ids.some((id) => id.startsWith('midsommar')), `midsommar ${year} saknas`);
    assert.ok(ids.some((id) => id.startsWith('jul-nyar')), `jul/nyår ${year} saknas`);
    assert.ok(ids.some((id) => id.startsWith('hostlov')), `höstlov ${year} saknas`);
    assert.ok(ids.some((id) => id.startsWith('kristihimmelsfard')), `Kristi himmelsfärd ${year} saknas`);
    assert.ok(ids.some((id) => id.startsWith('nationaldag')), `nationaldag ${year} saknas`);
    assert.ok(ids.some((id) => id.startsWith('valborg')), `valborg/första maj ${year} saknas`);
  }
});
