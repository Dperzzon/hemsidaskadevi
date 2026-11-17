'use strict';

// Verifierar att alla publika sidor använder exakt samma menyrad som
// startsidan. Headern genereras av scripts/sync-header.mjs.

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

const EXPECTED_DESKTOP = [
  '/foretag', '/fest', '/brollop', '/semester',
  '/digital-visning', '/boende', '/aktiviteter', '/boka'
];

const EXPECTED_MOBILE = [
  '/foretag', '/fest', '/brollop', '/semester',
  '/digital-visning', '/boende', '/aktiviteter', '/priser', '/boka', '/vanliga-fragor'
];

function read(file) {
  return fs.readFileSync(file, 'utf8');
}

function headerOf(html) {
  const match = /<header class="header(?: [^"]*)?"[\s\S]*?<\/header>/.exec(html);
  assert.ok(match, 'header saknas');
  return match[0];
}

function links(block) {
  return [...block.matchAll(/<a href="([^"]+)"[^>]*>([^<]+)<\/a>/g)]
    .map((match) => ({ href: match[1], label: match[2] }));
}

function desktopLinks(header) {
  return [...header.matchAll(/<div class="header-side">[\s\S]*?<\/div>/g)]
    .flatMap((match) => links(match[0]));
}

function mobileLinks(header) {
  return links(header.slice(header.indexOf('<nav class="header-nav"')));
}

test('alla sidor använder samma menyrad som startsidan', () => {
  const reference = headerOf(read(path.join(src, 'index.html')));
  const referenceDesktop = desktopLinks(reference);
  const referenceMobile = mobileLinks(reference);

  for (const file of pages) {
    const header = headerOf(read(file));
    assert.match(header, /<img width="512" height="512" src="\/images\/logo.png" alt="Skadevi Gård">/);
    assert.doesNotMatch(header, /header-inner|header-cta/, `${path.basename(file)} använder gammal header`);

    const desktop = desktopLinks(header);
    const mobile = mobileLinks(header);
    assert.deepEqual(
      desktop.map((link) => link.href),
      referenceDesktop.map((link) => link.href),
      `${path.basename(file)} har avvikande desktoplänkar`
    );
    assert.deepEqual(
      mobile.map((link) => link.href),
      referenceMobile.map((link) => link.href),
      `${path.basename(file)} har avvikande mobillänkar`
    );
  }

  assert.deepEqual(referenceDesktop.map((link) => link.href), EXPECTED_DESKTOP);
  assert.deepEqual(referenceMobile.map((link) => link.href), EXPECTED_MOBILE);
});

test('Bilder heter Boka i navigationen och länkar till /boka', () => {
  for (const file of pages) {
    const header = headerOf(read(file));
    assert.doesNotMatch(header, />Bilder</, `${path.basename(file)} visar fortfarande Bilder`);
    const desktop = desktopLinks(header);
    const mobile = mobileLinks(header);
    assert.equal(desktop.filter((link) => link.label === 'Boka').length, 1);
    assert.equal(desktop.filter((link) => link.label === 'Boka')[0].href, '/boka');
    assert.equal(mobile.filter((link) => link.label === 'Boka').length, 1);
    assert.equal(mobile.filter((link) => link.label === 'Boka')[0].href, '/boka');
  }
});
