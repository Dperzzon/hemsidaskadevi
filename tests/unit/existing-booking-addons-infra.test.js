'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..', '..');

test('tillvalsfunktionen är uttryckligen avstängd i produktionsparametrarna', () => {
  const params = fs.readFileSync(path.join(root, 'infra', 'main.bicepparam'), 'utf8');
  assert.match(params, /param\s+enableExistingBookingAddons\s*=\s*false/);
});

test('Bicep definierar en egen feature flagga med standardvärdet false', () => {
  const main = fs.readFileSync(path.join(root, 'infra', 'main.bicep'), 'utf8');
  const webapp = fs.readFileSync(path.join(root, 'infra', 'modules', 'webapp.bicep'), 'utf8');
  assert.match(main, /param\s+enableExistingBookingAddons\s+bool\s*=\s*false/);
  assert.match(main, /enableExistingBookingAddons:\s*enableExistingBookingAddons/);
  assert.match(webapp, /param\s+enableExistingBookingAddons\s+bool\s*=\s*false/);
  assert.match(webapp, /'EXISTING_BOOKING_ADDONS_ENABLED'\s*[\s\S]*?enableExistingBookingAddons\s*\?\s*'1'\s*:\s*'0'/);
  assert.match(webapp, /'EXISTING_BOOKING_ADDONS_ALLOW_LIVE'\s*[\s\S]*?enableExistingBookingAddons\s*\?\s*'1'\s*:\s*'0'/);
});

test('serverkoden kräver både feature flagga och Stripe-kort innan flödet aktiveras', () => {
  const source = fs.readFileSync(path.join(root, 'server', 'booking', 'existing-booking-addons.js'), 'utf8');
  assert.match(source, /process\.env\.EXISTING_BOOKING_ADDONS_ENABLED === '1'/);
  assert.match(source, /process\.env\.EXISTING_BOOKING_ADDONS_ALLOW_LIVE === '1'/);
  assert.match(source, /EXISTING_BOOKING_ADDONS_ALLOW_LIVE/);
});
