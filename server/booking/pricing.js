'use strict';

// Rabattlogik på serversidan (spegler src/js/booking/pricing.js).
// Beslutade rabatter: veckorabatt 30 % för 7+ nätter, månadsrabatt 69 % för
// 28+ nätter. Månadsrabatten ersätter veckorabatten när båda uppfylls.
// Rabatterna gäller boendepriset som bekräftas i offerten — ingen total
// prisberäkning sker på serversidan eftersom grundpriset inte kan fastställas
// säkert ur den nuvarande datamodellen.

const DISCOUNTS = [
  { id: 'veckorabatt', label: 'Veckorabatt', percent: 30, minNights: 7 },
  { id: 'manadsrabatt', label: 'Månadsrabatt', percent: 69, minNights: 28 }
];

function bestDiscount(nights) {
  let best = null;
  for (const discount of DISCOUNTS) {
    if (nights >= discount.minNights && (!best || discount.percent > best.percent)) {
      best = discount;
    }
  }
  return best;
}

function applyDiscount(baseAmount, discount) {
  if (!discount) return baseAmount;
  return Math.round(baseAmount * (1 - discount.percent / 100));
}

module.exports = { DISCOUNTS, bestDiscount, applyDiscount };
