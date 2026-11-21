'use strict';

// Kontrollerar att ordinarie incheckning är 14.00 överallt där kunden ser
// informationen, att utcheckningen är kvar kl. 11.00 och att bokningsmejlet
// använder den centrala praktiska informationen.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const practicalInfo = require('../../shared/practical-info.json');
const { buildBookingConfirmation } = require('../../server/booking/booking-mail');

const ROOT = path.resolve(__dirname, '../..');

function read(relative) {
  return fs.readFileSync(path.join(ROOT, relative), 'utf8');
}

const OLD_CHECKIN_PATTERNS = [
  /(?:[Ii]ncheckning|ordinarie incheckning)[^.<>\n]{0,45}kl\.\s*15[.:]00/,
  /kl\.\s*15[.:]00[^.<>\n]{0,45}(?:incheckning|Incheckning)/
];

test('den centrala praktiska informationen har ordinarie och valfria tider', () => {
  assert.equal(practicalInfo.checkInTime, '14.00');
  assert.equal(practicalInfo.checkOutTime, '11.00');
  assert.equal(practicalInfo.earlyCheckInTime, '09.00');
  assert.equal(practicalInfo.lateCheckOutTime, '16.00');
});

test('kundsidor visar 14.00 som ordinarie incheckning och 11.00 som utcheckning', () => {
  for (const page of ['src/pages/boka.html', 'src/pages/vanliga-fragor.html', 'src/pages/lediga-datum.html']) {
    const html = read(page);
    for (const pattern of OLD_CHECKIN_PATTERNS) {
      assert.doesNotMatch(html, pattern, `${page} innehåller den gamla incheckningstiden 15.00`);
    }
  }

  assert.match(read('src/pages/boka.html'), /Incheckning från kl\. 14\.00/);
  assert.match(read('src/pages/boka.html'), /Utcheckning senast kl\. 11\.00/);
  assert.match(read('src/pages/vanliga-fragor.html'), /Standard är incheckning från kl\. 14\.00/);
  assert.match(read('src/pages/vanliga-fragor.html'), /"text":"Standard är incheckning från kl\. 14\.00/);
});

test('bokningsbekräftelsen använder 14.00 och behåller tidig incheckning enligt villkoren', () => {
  const mail = buildBookingConfirmation({
    reference: 'TEST-CHECKIN-001',
    firstName: 'Test',
    email: 'skadevigard@gmail.com',
    arrival: '2027-05-14',
    departure: '2027-05-16',
    nights: 2,
    guests: 4,
    addonLines: []
  }, {
    summary: {
      totalOre: 2000000,
      paidOre: 2000000,
      remainingOre: 0,
      overpaidOre: 0,
      paymentStatus: 'PAID',
      paymentLabel: 'Betald'
    }
  });

  assert.match(mail.html, /Incheckning från kl\. 14\.00\. Utcheckning senast kl\. 11\.00\./);
  assert.doesNotMatch(mail.html, /Incheckning från kl\. 15\.00/);
  assert.match(mail.html, /Tidig incheckning från kl\. 09\.00/);
  assert.match(mail.html, /sen utcheckning till kl\. 16\.00/);
  assert.match(mail.html, /bekräftas av Skadevi Herrgård/);
  assert.doesNotMatch(mail.body, /Incheckning från kl\. 15\.00/);
});
