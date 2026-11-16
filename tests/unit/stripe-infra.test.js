'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..', '..');

function read(relative) {
  return fs.readFileSync(path.join(root, relative), 'utf8');
}

test('Stripe är inaktiverat som standard i produktionsparametrarna', () => {
  const main = read('infra/main.bicepparam');
  const admin = read('infra/admin-webapp.bicepparam');
  assert.match(main, /param enableStripeWebhook = false/);
  assert.match(main, /param enableSwishPayments = false/);
  assert.match(main, /param stripeSecretUri = ''/);
  assert.match(main, /param stripeWebhookSecretUri = ''/);
  assert.match(admin, /param enableStripePayments = false/);
  assert.match(admin, /param publicBaseUrl = 'https:\/\/www\.skadeviherrgard\.com'/);
});

test('Stripe-inställningarna är fail-closed och live-nycklar är blockerade', () => {
  const webapp = read('infra/modules/webapp.bicep');
  const admin = read('infra/admin-webapp.bicep');
  assert.match(webapp, /param enableStripeWebhook bool = false/);
  assert.match(webapp, /param enableSwishPayments bool = false/);
  assert.match(webapp, /name: 'STRIPE_WEBHOOK_ENABLED'\s+value: enableStripeWebhook \? '1' : '0'/);
  assert.match(webapp, /name: 'STRIPE_ENABLED'\s+value: enableSwishPayments \? '1' : '0'/);
  assert.match(webapp, /name: 'STRIPE_ALLOW_LIVE'\s+value: '0'/);
  assert.match(webapp, /enableStripeWebhook && !empty\(stripeWebhookSecretUri\)/);
  assert.match(webapp, /enableSwishPayments && !empty\(stripeSecretUri\)/);
  assert.match(admin, /param enableStripePayments bool = false/);
  assert.match(admin, /name: 'STRIPE_MODE'\s+value: stripeMode/);
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
