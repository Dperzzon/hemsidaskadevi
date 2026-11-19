'use strict';

// Verifierar att /prisers ordinarie priser genereras från samma
// pris­konfiguration som bokningsmotorn använder, och att bröllopskonceptets
// priser ligger kvar oförändrade.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..', '..');

test('prissidan får alla ordinarie priser från pricing-config', async () => {
  const { applyPricingTokens, loadPricingConfig, pricingTokens } = await import('../../scripts/pricing-page.mjs');
  const config = loadPricingConfig();
  const source = readFileSync(path.join(root, 'src', 'pages', 'priser.html'), 'utf8');
  const rendered = applyPricingTokens(source, config);

  assert.equal(/\{\{[\w.]+\}\}/.test(rendered), false, 'alla pristokens ska vara ersatta');
  for (const value of Object.values(pricingTokens(config))) {
    assert.ok(rendered.includes(value), `prissidan saknar ${value}`);
  }
});

test('bröllopskonceptets priser och innehåll är oförändrade', async () => {
  const { applyPricingTokens } = await import('../../scripts/pricing-page.mjs');
  const source = readFileSync(path.join(root, 'src', 'pages', 'priser.html'), 'utf8');
  const rendered = applyPricingTokens(source);

  assert.match(rendered, /130 000 – 150 000 kr/);
  assert.match(rendered, /150 000 – 180 000 kr/);
  assert.match(rendered, /<strong>150 000 kr<\/strong>/);
  assert.match(rendered, /Bröllopskoncept — färdiga paket/);
  assert.match(rendered, /Bröllopspaket/);
});

test('gamla priser som inte gäller i bokningsmotorn är borttagna', async () => {
  const { applyPricingTokens } = await import('../../scripts/pricing-page.mjs');
  const source = readFileSync(path.join(root, 'src', 'pages', 'priser.html'), 'utf8');
  const rendered = applyPricingTokens(source);

  assert.doesNotMatch(rendered, /9 000 kr/);
  assert.doesNotMatch(rendered, /15 000 kr/);
  assert.doesNotMatch(rendered, /200 kr per person och natt/);
  assert.doesNotMatch(rendered, /Lakanspaket per person/);
  assert.doesNotMatch(rendered, /Tennishuset/);
});
