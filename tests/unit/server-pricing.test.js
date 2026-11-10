// Enhetstester för rabattlogiken på serversidan (server/booking/pricing.js).
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { bestDiscount, applyDiscount, DISCOUNTS } = require('../../server/booking/pricing');

test('veckorabatt 30 % från 7 nätter, månadsrabatt 69 % från 28 nätter', () => {
  assert.equal(bestDiscount(6), null);
  assert.deepEqual(bestDiscount(7), { id: 'veckorabatt', label: 'Veckorabatt', percent: 30, minNights: 7 });
  assert.deepEqual(bestDiscount(27), { id: 'veckorabatt', label: 'Veckorabatt', percent: 30, minNights: 7 });
  assert.deepEqual(bestDiscount(28), { id: 'manadsrabatt', label: 'Månadsrabatt', percent: 69, minNights: 28 });
  assert.deepEqual(bestDiscount(93), { id: 'manadsrabatt', label: 'Månadsrabatt', percent: 69, minNights: 28 });
});

test('applyDiscount tillämpar procentsatserna korrekt', () => {
  assert.equal(applyDiscount(12000, DISCOUNTS[0]), 8400); // -30 %
  assert.equal(applyDiscount(12000, DISCOUNTS[1]), 3720); // -69 %
  assert.equal(applyDiscount(12000, null), 12000);
});

test('serverns rabattlogik matchar klientens (beslutade värden)', () => {
  assert.deepEqual(DISCOUNTS.map((discount) => [discount.id, discount.percent, discount.minNights]), [
    ['veckorabatt', 30, 7],
    ['manadsrabatt', 69, 28]
  ]);
});
