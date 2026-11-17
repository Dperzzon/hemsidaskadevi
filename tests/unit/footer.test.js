'use strict';

// Verifierar att alla publika sidor använder exakt samma sidfot.
// Sidfoten genereras av scripts/sync-footer.mjs från shared/footer.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const src = path.join(__dirname, '..', '..', 'src');
const pages = [
  path.join(src, 'index.html'),
  ...fs.readdirSync(path.join(src, 'pages'))
    .filter((name) => name.endsWith('.html'))
    .map((name) => path.join(src, 'pages', name))
];

const EXPECTED_LINKS = [
  '/foretag', '/brollop', '/semester', '/fest', '/boende',
  '/priser', '/om-oss', '/vanliga-fragor', '/boka'
];

function footerOf(html) {
  const match = /<footer class="footer"[\s\S]*?<\/footer>/.exec(html);
  assert.ok(match, 'footer saknas');
  return match[0].replaceAll('\r\n', '\n');
}

test('alla sidor använder samma sidfot med korrekta länkar', () => {
  const reference = footerOf(fs.readFileSync(path.join(src, 'index.html'), 'utf8'));

  for (const file of pages) {
    const footer = footerOf(fs.readFileSync(file, 'utf8'));
    assert.equal(footer, reference, `${path.basename(file)} har avvikande sidfot`);
  }

  const hrefs = [...reference.matchAll(/<a href="([^"]+)"/g)].map((match) => match[1]);
  for (const href of EXPECTED_LINKS) {
    assert.ok(hrefs.includes(href), `saknar länk ${href}`);
  }
  assert.ok(hrefs.includes('tel:+46702730422'), 'telefonlänk saknas');
  assert.ok(hrefs.includes('mailto:skadevigard@gmail.com'), 'e-postlänk saknas');
  assert.doesNotMatch(reference, /href="\/kontakt"/, 'gammal kontaktsida får inte länkas');
  assert.match(reference, /©|&copy;/, 'copyright saknas');
  assert.match(reference, /2026<\/span> Skadevi Herrgård/);
});
