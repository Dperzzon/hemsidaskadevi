'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildBookingConfirmation } = require('../../server/booking/booking-mail');

const RECORD = {
  reference: 'TEST-SKADEVI-MAIL-001',
  firstName: 'Test',
  lastName: 'Gäst',
  email: 'skadevigard@gmail.com',
  arrival: '2027-05-14',
  departure: '2027-05-16',
  nights: 2,
  guests: 16,
  addonLines: [
    { label: 'Slutstädning', quantity: 1, amount: 2500 },
    { label: 'Sänglinne', quantity: 16, amount: 3200 }
  ]
};

const PARTIAL = {
  totalOre: 2570000,
  paidOre: 500000,
  remainingOre: 2070000,
  overpaidOre: 0,
  paymentStatus: 'PARTIALLY_PAID',
  paymentLabel: 'Delbetalt'
};

const FULL = {
  totalOre: 2570000,
  paidOre: 2570000,
  remainingOre: 0,
  overpaidOre: 0,
  paymentStatus: 'PAID',
  paymentLabel: 'Betald'
};

test('bekräftelsemejlet använder Skadevis logotyp och varumärkesram', () => {
  const mail = buildBookingConfirmation(RECORD, { summary: FULL });
  assert.match(mail.html, /https:\/\/www\.skadeviherrgard\.com\/images\/logo\.png/);
  assert.match(mail.html, /width="96"/);
  assert.match(mail.html, /height="96"/);
  assert.match(mail.html, /alt="Skadevi Herrgård"/);
  assert.match(mail.html, /max-width:600px/);
  assert.match(mail.html, /www\.skadeviherrgard\.com/);
  assert.match(mail.html, /https:\/\/www\.skadeviherrgard\.com\/kontakt/);
  assert.match(mail.html, /Skoklostervägen 16/);
  assert.match(mail.html, /\+46 70 273 04 22/);
});

test('bekräftelsemejlet visar bokning, betalning och praktisk information', () => {
  const mail = buildBookingConfirmation(RECORD, { summary: PARTIAL });
  assert.match(mail.html, /Din bokning på Skadevi Herrgård är bekräftad/);
  assert.match(mail.html, /Bokningsreferens: TEST-SKADEVI-MAIL-001/);
  assert.match(mail.html, /Ankomst: 14 maj 2027/);
  assert.match(mail.html, /Avresa: 16 maj 2027/);
  assert.match(mail.html, /Antal nätter: 2/);
  assert.match(mail.html, /Antal gäster: 16/);
  assert.match(mail.html, /Slutstädning/);
  assert.match(mail.html, /Sänglinne/);
  assert.match(mail.html, /Totalt bokningsbelopp inklusive moms: 25[\s\u00a0]700 kr/);
  assert.match(mail.html, /Betalt belopp: 5[\s\u00a0]000 kr/);
  assert.match(mail.html, /Kvar att betala: 20[\s\u00a0]700 kr/);
  assert.match(mail.html, /Bokningen är bekräftad men inte fullbetald/);
  assert.doesNotMatch(mail.html, /Hela bokningsbeloppet är betalt/);
  assert.doesNotMatch(mail.html, /Fullbetald/);
  assert.match(mail.html, /Incheckning från kl\. 15\.00/);
  assert.match(mail.html, /Utcheckning senast kl\. 11\.00/);
  assert.match(mail.html, /bekräftas av Skadevi Herrgård/);
  assert.match(mail.html, /Gratis parkering/);
  assert.match(mail.html, /Hundar är välkomna/);
});

test('fullbetald bokning påstår aldrig att den är delbetald', () => {
  const mail = buildBookingConfirmation(RECORD, { summary: FULL });
  assert.match(mail.html, /Hela bokningsbeloppet är betalt/);
  assert.doesNotMatch(mail.html, /inte fullbetald/);
  assert.doesNotMatch(mail.html, /Kvar att betala: [1-9]/);
});

test('dynamiska värden escapas och testmarkeringar finns inte i kundmallen', () => {
  const mail = buildBookingConfirmation({
    ...RECORD,
    firstName: '<script>alert(1)</script>',
    addonLines: [{ label: '<img src=x onerror=alert(1)>', quantity: 1, amount: 100 }]
  }, { summary: FULL });
  assert.doesNotMatch(mail.html, /<script>/);
  assert.doesNotMatch(mail.html, /<img src=x/);
  assert.match(mail.html, /&lt;script&gt;/);
  assert.match(mail.html, /&lt;img src=x/);
  assert.doesNotMatch(mail.html, /\[TEST\]/);
  assert.doesNotMatch(mail.body, /\[TEST\]/);
  assert.doesNotMatch(mail.subject, /\[TEST\]/);
});

test('klartextversionen innehåller samma uppgifter utan HTML', () => {
  const mail = buildBookingConfirmation(RECORD, { summary: FULL });
  assert.match(mail.body, /Bokningsreferens: TEST-SKADEVI-MAIL-001/);
  assert.match(mail.body, /Ankomst: 14 maj 2027/);
  assert.match(mail.body, /Avresa: 16 maj 2027/);
  assert.match(mail.body, /Antal gäster: 16/);
  assert.match(mail.body, /Hela bokningsbeloppet är betalt/);
  assert.match(mail.body, /Incheckning från kl\. 15\.00/);
  assert.match(mail.body, /Skadevi Herrgård/);
  assert.match(mail.body, /www\.skadeviherrgard\.com/);
  assert.doesNotMatch(mail.body, /<html|<body|<p>/);
  assert.equal(mail.subject, 'Din bokning på Skadevi Herrgård är bekräftad (TEST-SKADEVI-MAIL-001)');
});
