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

test('godkända högtidsperioder ger 12 000 kr oavsett veckodag', () => {
  // Midsommar 2026 (godkänd): fredag och lördag ersätts av högtidspriset.
  assert.equal(nightRate('2026-06-19').rate, RATES.peak); // fredag
  assert.equal(nightRate('2026-06-20').rate, RATES.peak); // lördag
  assert.equal(nightRate('2026-06-16').rate, RATES.weekday); // tisdag utanför perioden
  assert.equal(nightRate('2026-06-18').rate, RATES.peak); // torsdag: periodens första natt
  assert.equal(nightRate('2026-06-19').type, 'peak');
  assert.equal(nightRate('2026-11-16').rate, RATES.weekday); // utanför alla perioder
});

test('varje högprisperiod: första och sista debiterade natt samt omgivande nätter', () => {
  const periods = CONFIG.peakPeriods.filter((p) => p.approved);
  assert.ok(periods.length > 0);
  for (const period of periods) {
    // start och end är INKLUSIVA nättnycklar.
    assert.equal(nightRate(period.start).type, 'peak', `${period.id}: första natten ska ha högpris`);
    assert.equal(nightRate(period.end).type, 'peak', `${period.id}: sista natten ska ha högpris`);
    // Natten före och dagen efter perioden ska ha ordinarie pris.
    const dayBefore = keyFromDayNumber(dayNumber(period.start) - 1);
    const dayAfter = keyFromDayNumber(dayNumber(period.end) + 1);
    const rateBefore = nightRate(dayBefore);
    const rateAfter = nightRate(dayAfter);
    assert.notEqual(rateBefore.type, 'peak', `${period.id}: natten ${dayBefore} ska inte ha högpris`);
    assert.notEqual(rateAfter.type, 'peak', `${period.id}: natten ${dayAfter} ska inte ha högpris`);
  }
});

test('påsk 2026–2028: onsdagen före skärtorsdag till och med annandag påsk', () => {
  // 2026: påskdagen 5 april; natten 2/4 (onsdag) – natten 6/4 (måndag, annandag påsk).
  assert.equal(nightRate('2026-04-01').type, 'weekday'); // natten före perioden
  assert.equal(nightRate('2026-04-02').type, 'peak');
  assert.equal(nightRate('2026-04-06').type, 'peak'); // annandag påsk (måndag)
  assert.equal(nightRate('2026-04-07').type, 'weekday'); // natten efter perioden
  // 2027: påskdagen 28 mars; 25–29 mars.
  assert.equal(nightRate('2027-03-24').type, 'weekday');
  assert.equal(nightRate('2027-03-25').type, 'peak');
  assert.equal(nightRate('2027-03-29').type, 'peak'); // annandag påsk (måndag)
  assert.equal(nightRate('2027-03-30').type, 'weekday');
  // 2028: påskdagen 16 april; 13–17 april.
  assert.equal(nightRate('2028-04-12').type, 'weekday');
  assert.equal(nightRate('2028-04-13').type, 'peak');
  assert.equal(nightRate('2028-04-17').type, 'peak'); // annandag påsk (måndag)
  assert.equal(nightRate('2028-04-18').type, 'weekday');
});

test('inkluderande slutdatum: söndagsnatt vid midsommar och måndagsnatt vid påsk får högpris', () => {
  // Midsommar 2026: torsdag 18/6 – söndag 21/6 (söndagsnatten ingår).
  assert.equal(nightRate('2026-06-21').type, 'peak');
  assert.equal(weekdayOf('2026-06-21'), 0); // söndag
  // Påsk 2026: annandag påsk måndag 6/4 (måndagsnatten ingår).
  assert.equal(nightRate('2026-04-06').type, 'peak');
  assert.equal(weekdayOf('2026-04-06'), 1); // måndag
  // Samma sak 2027 och 2028.
  assert.equal(nightRate('2027-06-27').type, 'peak'); // söndag
  assert.equal(nightRate('2027-03-29').type, 'peak'); // måndag
  assert.equal(nightRate('2028-06-25').type, 'peak'); // söndag
  assert.equal(nightRate('2028-04-17').type, 'peak'); // måndag
});

test('vistelse över nyår 2026–2027: samtliga nätter i godkänd jul-/nyårsperiod', () => {
  const q = quote({ arrival: '2026-12-30', departure: '2027-01-02' });
  assert.deepEqual(q.nightlyBreakdown.map((n) => n.rate), [RATES.peak, RATES.peak, RATES.peak]);
  assert.equal(q.lodgingBase, 36000);
  // Sista godkända natten är 2027-01-04; 2027-01-05 är ordinarie vardag.
  assert.equal(nightRate('2027-01-04').type, 'peak');
  assert.equal(nightRate('2027-01-05').rate, RATES.weekday);
});

test('högprisreglerna överlappar inte — varje natt får exakt ett pris', () => {
  const periods = CONFIG.peakPeriods.filter((p) => p.approved);
  for (let i = 0; i < periods.length; i++) {
    for (let j = i + 1; j < periods.length; j++) {
      const a = periods[i];
      const b = periods[j];
      assert.ok(a.end < b.start || b.end < a.start,
        `${a.id} och ${b.id} överlappar`);
    }
  }
  // nightRate returnerar alltid exakt ett pris per natt.
  for (const period of periods) {
    for (let day = dayNumber(period.start); day <= dayNumber(period.end); day++) {
      const rate = nightRate(keyFromDayNumber(day));
      assert.ok(Number.isFinite(rate.rate) && rate.rate > 0);
    }
  }
});

test('blandade vardags-, helg- och högtidsnätter i november 2026 (utanför perioderna)', () => {
  const q = quote({ arrival: '2026-11-16', departure: '2026-11-23' }); // må–sö (7 nätter)
  assert.deepEqual(q.nightlyBreakdown.map((n) => n.rate),
    [RATES.weekday, RATES.weekday, RATES.weekday, RATES.weekday, RATES.friday, RATES.saturday, RATES.weekday]);
  assert.equal(q.peakNights, 0);
  assert.deepEqual(q.discount, { id: 'veckorabatt', label: 'Veckorabatt', percent: 30, amount: Math.round(q.lodgingBase * 0.3) });
  assert.equal(q.lodgingAfterDiscount, Math.round(q.lodgingBase * 0.7));
});

test('vistelser över nyår (årsskifte) räknas med avresedagen odebiterad', () => {
  assert.deepEqual(nightKeys('2026-12-30', '2027-01-02'), ['2026-12-30', '2026-12-31', '2027-01-01']);
  assert.equal(nightsBetween('2026-12-31', '2027-01-01'), 1);
  // Godkänd jul-/nyårsperiod: alla tre nätterna har högtidspris.
  const q = quote({ arrival: '2026-12-30', departure: '2027-01-02' });
  assert.equal(q.lodgingBase, 3 * RATES.peak);
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

test('högprisperioderna är godkända och strukturellt korrekta', () => {
  const periods = CONFIG.peakPeriods;
  assert.ok(periods.length > 0);
  for (const period of periods) {
    assert.equal(period.approved, true, `${period.id} ska vara godkänd (approved: true)`);
    assert.ok(period.start && period.end && period.label, `${period.id} saknar datum/etikett`);
    assert.ok(period.end >= period.start, `${period.id} har omvänd ordning`);
    assert.ok(Number.isFinite(Number(period.year)));
  }
  // Periodelängden är rimlig (upp till 3 veckor för jul/mellandagarna).
  for (const period of periods) {
    assert.ok(nightsBetween(period.start, period.end) + 1 <= 21, `${period.id} är orealistiskt lång`);
  }
});

test('högprisperioderna för 2026–2028 täcker de godkända högtiderna', () => {
  for (const year of [2026, 2027, 2028]) {
    const ids = CONFIG.peakPeriods.filter((p) => p.year === year).map((p) => p.id);
    assert.ok(ids.some((id) => id.startsWith('pask-')), `påsk ${year} saknas`);
    assert.ok(ids.some((id) => id.startsWith('midsommar')), `midsommar ${year} saknas`);
    assert.ok(ids.some((id) => id.startsWith('jul-nyar')), `jul/nyår ${year} saknas`);
    assert.ok(ids.some((id) => id.startsWith('hostlov')), `höstlov ${year} saknas`);
    assert.ok(ids.some((id) => id.startsWith('kristihimmelsfard')), `Kristi himmelsfärd ${year} saknas`);
    assert.ok(ids.some((id) => id.startsWith('nationaldag')), `nationaldag ${year} saknas`);
    assert.ok(ids.some((id) => id.startsWith('valborg')), `valborg/första maj ${year} saknas`);
  }
});

test('räkneexempel: måndag till söndag = 6 nätter = 48 000 kr, ingen rabatt', () => {
  // Mån 16 nov – avresa sön 22 nov 2026 (utanför högtidsperioder).
  const q = quote({ arrival: '2026-11-16', departure: '2026-11-22' });
  assert.equal(q.nights, 6);
  assert.deepEqual(q.nightlyBreakdown.map((n) => n.rate),
    [7000, 7000, 7000, 7000, 10000, 10000]);
  assert.equal(q.lodgingBase, 48000);
  assert.equal(q.discount, null);
  assert.equal(q.total, 48000);
});

test('räkneexempel: måndag till måndag = 7 nätter = 55 000 kr före rabatt, 38 500 kr efter 30 %', () => {
  const q = quote({ arrival: '2026-11-16', departure: '2026-11-23' });
  assert.equal(q.nights, 7);
  assert.equal(q.lodgingBase, 55000);
  assert.equal(q.discountAmount, 16500);
  assert.equal(q.lodgingAfterDiscount, 38500);
});
