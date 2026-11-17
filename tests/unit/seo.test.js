'use strict';

// SEO-kontroller: unika titlar och metabeskrivningar, self-referencing
// canonical, robots, Open Graph, JSON-LD, sitemap och interna länkar.
// Testerna läser källfilerna (körs före build i CI) och kräver inga
// externa tjänster eller nätverksanrop.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..', '..');
const base = 'https://www.skadeviherrgard.com';

const INDEXABLE = {
  'src/index.html': '/',
  'src/pages/foretag.html': '/foretag',
  'src/pages/brollop.html': '/brollop',
  'src/pages/semester.html': '/semester',
  'src/pages/fest.html': '/fest',
  'src/pages/boende.html': '/boende',
  'src/pages/aktiviteter.html': '/aktiviteter',
  'src/pages/priser.html': '/priser',
  'src/pages/mat-dryck.html': '/mat-dryck',
  'src/pages/om-oss.html': '/om-oss',
  'src/pages/vanliga-fragor.html': '/vanliga-fragor',
  'src/pages/digital-visning.html': '/digital-visning',
  'src/pages/boka.html': '/boka'
};

const NOINDEX = {
  'src/pages/betalning-klar.html': 'noindex, nofollow',
  'src/pages/betalning-avbruten.html': 'noindex, nofollow',
  'src/pages/lediga-datum.html': 'noindex, follow',
  'src/pages/kontakt.html': 'noindex, follow',
  'src/404.html': 'noindex, follow'
};

const LEGACY_PREFIXES = ['/service-page', '/product-page', '/about-1', '/team-4', '/services-7', '/historia', '/event', '/firande'];

function read(file) {
  return fs.readFileSync(path.join(root, file), 'utf8');
}

function meta(html, name) {
  const match = new RegExp(`<meta\\s+name="${name}"\\s+content="([^"]*)"`, 'i').exec(html);
  return match ? match[1] : null;
}

function property(html, name) {
  const match = new RegExp(`<meta\\s+property="${name}"\\s+content="([^"]*)"`, 'i').exec(html);
  return match ? match[1] : null;
}

function titleOf(html) {
  const match = /<title>([\s\S]*?)<\/title>/i.exec(html);
  return match ? match[1].replace(/&amp;/g, '&').replace(/&quot;/g, '"').trim() : null;
}

function canonicalOf(html) {
  const match = /<link\s+rel="canonical"\s+href="([^"]*)"/i.exec(html);
  return match ? match[1] : null;
}

function h1sOf(html) {
  return [...html.matchAll(/<h1\b[^>]*>([\s\S]*?)<\/h1>/gi)].map((m) => m[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
}

function jsonLdBlocks(html) {
  return [...html.matchAll(/<script\s+type="application\/ld\+json">([\s\S]*?)<\/script>/gi)].map((m) => m[1]);
}

test('varje indexerbar sida har unik titel och metabeskrivning', () => {
  const titles = new Map();
  const descriptions = new Map();

  for (const file of Object.keys(INDEXABLE)) {
    const html = read(file);
    const title = titleOf(html);
    const description = meta(html, 'description');

    assert.ok(title, `${file}: titel saknas`);
    assert.ok(description, `${file}: metabeskrivning saknas`);
    assert.ok(title.length >= 15 && title.length <= 65, `${file}: titeln har längden ${title.length}: ${title}`);
    assert.ok(description.length >= 70 && description.length <= 170, `${file}: beskrivningen har längden ${description.length}`);
    assert.ok(title.includes('Skadevi'), `${file}: varumärket saknas i titeln`);

    assert.ok(!titles.has(title), `${file}: titeln används också av ${titles.get(title)}`);
    assert.ok(!descriptions.has(description), `${file}: beskrivningen används också av ${descriptions.get(description)}`);
    titles.set(title, file);
    descriptions.set(description, file);
  }
});

test('indexerbara sidor har self-referencing canonical och robots index', () => {
  for (const [file, route] of Object.entries(INDEXABLE)) {
    const html = read(file);
    const expected = `${base}${route === '/' ? '/' : route}`;
    assert.equal(canonicalOf(html), expected, `${file}: canonical`);
    assert.match(meta(html, 'robots') || '', /index/, `${file}: robots`);
    assert.doesNotMatch(meta(html, 'robots') || '', /noindex/, `${file}: robots`);
    assert.equal(h1sOf(html).length, 1, `${file}: exakt en h1 krävs`);
  }
});

test('betalnings- och aliassidor är noindex och saknar canonical där det behövs', () => {
  for (const [file, robots] of Object.entries(NOINDEX)) {
    const html = read(file);
    assert.equal(meta(html, 'robots'), robots, `${file}: robots`);
  }
  for (const file of ['src/pages/betalning-klar.html', 'src/pages/betalning-avbruten.html', 'src/404.html']) {
    assert.equal(canonicalOf(read(file)), null, `${file}: ska inte ha canonical`);
  }
});

test('Open Graph och Twitter-kort är kompletta på indexerbara sidor', () => {
  for (const file of Object.keys(INDEXABLE)) {
    const html = read(file);
    const title = titleOf(html);
    const description = meta(html, 'description');
    assert.equal(property(html, 'og:title'), title.replace(/&/g, '&amp;'), `${file}: og:title`);
    assert.equal(property(html, 'og:description'), description, `${file}: og:description`);
    assert.equal(property(html, 'og:site_name'), 'Skadevi Herrgård', `${file}: og:site_name`);
    assert.match(property(html, 'og:image') || '', /^https:\/\/www\.skadeviherrgard\.com\/images\//, `${file}: og:image ska vara absolut`);
    assert.equal(property(html, 'og:image:width'), '1600', `${file}: og:image:width`);
    assert.equal(property(html, 'og:image:height'), '900', `${file}: og:image:height`);
    assert.ok(property(html, 'og:image:alt'), `${file}: og:image:alt`);
    assert.equal(property(html, 'og:url'), canonicalOf(html), `${file}: og:url`);
    assert.equal(meta(html, 'twitter:card'), 'summary_large_image', `${file}: twitter:card`);
    assert.equal(meta(html, 'twitter:image'), property(html, 'og:image'), `${file}: twitter:image`);
  }
});

test('JSON-LD är giltig och innehåller förväntade typer', () => {
  for (const file of Object.keys(INDEXABLE)) {
    const blocks = jsonLdBlocks(read(file));
    assert.ok(blocks.length >= 1, `${file}: JSON-LD saknas`);
    for (const block of blocks) {
      const data = JSON.parse(block);
      assert.equal(data['@context'], 'https://schema.org');
      assert.ok(data['@graph'], `${file}: @graph saknas`);
    }
  }

  const home = JSON.parse(jsonLdBlocks(read('src/index.html'))[0]);
  const business = home['@graph'].find((node) => node['@id'] === `${base}/#business`);
  assert.ok(business, 'startsidan: LocalBusiness saknas');
  for (const type of ['LocalBusiness', 'LodgingBusiness', 'EventVenue']) {
    assert.ok(business['@type'].includes(type), `startsidan: ${type} saknas`);
  }
  assert.equal(business.name, 'Skadevi Herrgård');
  assert.equal(business.telephone, '+46702730422');
  assert.equal(business.address.streetAddress, 'Skoklostervägen 16');
  assert.equal(business.address.postalCode, '746 94');
  assert.equal(business.numberOfRooms, 7);
  assert.ok(!('aggregateRating' in business), 'påhittade betyg får inte användas');

  for (const file of Object.keys(INDEXABLE).filter((f) => f !== 'src/index.html')) {
    const data = JSON.parse(jsonLdBlocks(read(file))[0]);
    const breadcrumb = data['@graph'].find((node) => node['@type'] === 'BreadcrumbList');
    assert.ok(breadcrumb, `${file}: BreadcrumbList saknas`);
    assert.equal(breadcrumb.itemListElement[0].item, `${base}/`);
    assert.equal(breadcrumb.itemListElement.length, 2);
  }

  const faq = JSON.parse(jsonLdBlocks(read('src/pages/vanliga-fragor.html'))[0]);
  const faqPage = faq['@graph'].find((node) => node['@type'] === 'FAQPage');
  assert.ok(faqPage, 'FAQPage saknas');
  assert.ok(faqPage.mainEntity.length >= 10, 'FAQPage bör täcka de vanligaste frågorna');
});

test('sitemap innehåller bara kanoniska, indexerbara sidor', () => {
  const xml = read('public/sitemap.xml');
  const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  const expected = Object.values(INDEXABLE).map((route) => `${base}${route === '/' ? '/' : route}`).sort();
  assert.deepEqual([...locs].sort(), expected);
  assert.equal(new Set(locs).size, locs.length, 'dubbletter i sitemap');

  for (const loc of locs) {
    assert.ok(loc.startsWith(`${base}/`), `fel domän: ${loc}`);
    const route = new URL(loc).pathname;
    for (const legacy of LEGACY_PREFIXES) {
      assert.ok(!route.startsWith(legacy), `gammal Wix-adress i sitemap: ${loc}`);
    }
    assert.ok(!route.includes('betalning'), `betalningssida i sitemap: ${loc}`);
  }

  const lastmods = [...xml.matchAll(/<lastmod>([^<]+)<\/lastmod>/g)].map((m) => m[1]);
  assert.ok(lastmods.length === locs.length, 'lastmod saknas för någon URL');
  for (const date of lastmods) {
    assert.match(date, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(!Number.isNaN(Date.parse(date)), `ogiltigt datum: ${date}`);
  }
});

test('robots.txt tillåter rendering och hänvisar till sitemap', () => {
  const robots = read('public/robots.txt');
  assert.match(robots, /User-agent: \*/);
  assert.match(robots, /Allow: \//);
  assert.match(robots, /Disallow: \/api\//);
  assert.doesNotMatch(robots, /Disallow: \/(css|js|images|fonts)/, 'CSS/JS/bilder får inte blockeras');
  assert.match(robots, new RegExp(`Sitemap: ${base}/sitemap\\.xml`));
});

test('interna länkar pekar på kända sidor och existerande resurser', () => {
  const routes = new Set(Object.values(INDEXABLE));
  const html = Object.keys(INDEXABLE).map(read).join('\n');
  const hrefs = [...html.matchAll(/<a\b[^>]*href="([^"]+)"/g)].map((m) => m[1]);

  for (const href of hrefs) {
    if (href.startsWith('#') || href.startsWith('mailto:') || href.startsWith('tel:') || href.startsWith('http')) continue;
    const route = href.split('#')[0].split('?')[0];
    if (routes.has(route)) continue;
    const file = path.join(root, 'public', route.replace(/^\//, ''));
    assert.ok(fs.existsSync(file), `intern länk utan mål: ${href}`);
  }
});
