'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..', '..');

function read(relative) {
  return fs.readFileSync(path.join(root, relative), 'utf8');
}

test('Stripe Live är aktiverat i produktionsparametrarna', () => {
  const main = read('infra/main.bicepparam');
  const admin = read('infra/admin-webapp.bicepparam');
  assert.match(main, /param enableStripeWebhook = true/);
  assert.match(main, /param enableCardCheckout = true/);
  assert.match(main, /param enableSwishCheckout = false/);
  assert.match(main, /param stripeMode = 'live'/);
  assert.match(main, /param allowStripeLive = true/);
  assert.match(main, /param stripeSecretUri = 'https:\/\/kv-skadevi-prod\.vault\.azure\.net\/secrets\/stripe-secret-key'/);
  assert.match(main, /param stripeWebhookSecretUri = 'https:\/\/kv-skadevi-prod\.vault\.azure\.net\/secrets\/stripe-webhook-secret'/);
  assert.match(admin, /param enableStripePayments = true/);
  assert.match(admin, /param stripeMode = 'live'/);
  assert.match(admin, /param stripeSwishEnabled = false/);
  assert.match(admin, /param publicBaseUrl = 'https:\/\/www\.skadeviherrgard\.com'/);
});

test('Stripe-inställningarna är fail-closed och live-nycklar är blockerade', () => {
  const webapp = read('infra/modules/webapp.bicep');
  const admin = read('infra/admin-webapp.bicep');
  assert.match(webapp, /param enableStripeWebhook bool = false/);
  assert.match(webapp, /param enableCardCheckout bool = false/);
  assert.match(webapp, /param enableSwishCheckout bool = false/);
  assert.match(webapp, /name: 'STRIPE_WEBHOOK_ENABLED'\s+value: enableStripeWebhook \? '1' : '0'/);
  assert.match(webapp, /name: 'STRIPE_ENABLED'\s+value: \(enableCardCheckout \|\| enableSwishCheckout\) \? '1' : '0'/);
  assert.match(webapp, /name: 'STRIPE_CARD_ENABLED'\s+value: enableCardCheckout \? '1' : '0'/);
  assert.match(webapp, /name: 'STRIPE_SWISH_ENABLED'\s+value: enableSwishCheckout \? '1' : '0'/);
  assert.match(webapp, /name: 'STRIPE_MODE'\s+value: stripeMode/);
  assert.match(webapp, /name: 'STRIPE_ALLOW_LIVE'\s+value: allowStripeLive \? '1' : '0'/);
  assert.match(webapp, /enableStripeWebhook && !empty\(stripeWebhookSecretUri\)/);
  assert.match(webapp, /\(enableCardCheckout \|\| enableSwishCheckout\) && !empty\(stripeSecretUri\)/);
  assert.match(admin, /param enableStripePayments bool = false/);
  assert.match(admin, /name: 'STRIPE_MODE'\s+value: stripeMode/);
  assert.match(admin, /name: 'STRIPE_SWISH_ENABLED'\s+value: stripeSwishEnabled \? '1' : '0'/);
  assert.doesNotMatch(admin, /STRIPE_SECRET_KEY/);
});

test('inga Stripe-hemligheter är hårdkodade i infra eller server', () => {
  const files = [
    'infra/main.bicep',
    'infra/main.bicepparam',
    'infra/admin-webapp.bicep',
    'infra/admin-webapp.bicepparam',
    'infra/modules/webapp.bicep'
  ];
  for (const file of files) {
    const content = read(file);
    assert.doesNotMatch(content, /sk_(test|live)_[A-Za-z0-9]+/, file);
    assert.doesNotMatch(content, /whsec_[A-Za-z0-9]+/, file);
  }
});

test('Bicep bevarar aktiverad utkorg, aktiveringsdatum och analytics-hemlighet', () => {
  const main = read('infra/main.bicepparam');
  const admin = read('infra/admin-webapp.bicepparam');
  const logic = read('infra/logic-app-notify.bicepparam');
  const webapp = read('infra/modules/webapp.bicep');
  assert.match(main, /param enableStripeOutbox = true/);
  assert.match(admin, /param enableMailOutbox = true/);
  assert.match(logic, /param outboxActivationSince = '2026-11-21T17:15:00Z'/);
  assert.match(webapp, /name: 'ANALYTICS_TRANSACTION_SECRET'\s+value: '@Microsoft\.KeyVault/);
  assert.match(webapp, /name: 'AZURE_TABLE_NAME'\s+value: bookingTableName/);
  assert.match(webapp, /name: 'STRIPE_RECONCILE_INTERVAL_MINUTES'\s+value: string\(stripeReconcileIntervalMinutes\)/);
});
