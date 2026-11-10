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
