// Gemensamma hjälpfunktioner för Playwright-testerna.
// Alla tester körs med fast klocka, fast tidszon och en deterministisk
// kalender-API-mock så att skärmbilder blir jämförbara mellan körningar.

/** Alla publika sidor med sina kanoniska (rena) URL:er. */
export const PAGES = [
  { name: 'startsida', path: '/' },
  { name: 'foretag', path: '/foretag' },
  { name: 'fest', path: '/fest' },
  { name: 'brollop', path: '/brollop' },
  { name: 'semester', path: '/semester' },
  { name: 'boende', path: '/boende' },
  { name: 'aktiviteter', path: '/aktiviteter' },
  { name: 'priser', path: '/priser' },
  { name: 'mat-dryck', path: '/mat-dryck' },
  { name: 'om-oss', path: '/om-oss' },
  { name: 'vanliga-fragor', path: '/vanliga-fragor' },
  { name: 'kontakt', path: '/kontakt' },
  { name: 'digital-visning', path: '/digital-visning' },
  { name: 'boka', path: '/boka' },
  { name: 'lediga-datum', path: '/lediga-datum' },
  { name: '404', path: '/denna-sida-finns-inte' }
];

/** Fast tidpunkt: alla körningar ser samma kalendermånader och årtal. */
export const FIXED_NOW = new Date('2026-11-09T10:00:00+01:00');

/** Deterministiska bokade datum för ett givet intervall. */
export function mockBlocked(start, end) {
  const blocked = [];
  const first = new Date(`${start}T00:00:00Z`);
  const last = new Date(`${end}T00:00:00Z`);
  for (let d = new Date(first); d < last; d.setUTCDate(d.getUTCDate() + 1)) {
    const day = d.getUTCDate();
    if ([12, 13, 14, 20, 27, 28].includes(day)) blocked.push(d.toISOString().slice(0, 10));
  }
  return blocked;
}

/**
 * Förbereder sidan: fast klocka och mockat kalender-API.
 * @param {import('@playwright/test').Page} page
 * @param {{ calendar?: 'ok' | 'error' }} [options]
 */
export async function prepare(page, options = {}) {
  await page.clock.setFixedTime(FIXED_NOW);
  const requests = [];
  await page.route('**/api/availability?*', async (route) => {
    const url = new URL(route.request().url());
    requests.push(url.search);
    if (options.calendar === 'error') {
      await route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"x"}' });
      return;
    }
    const blocked = mockBlocked(url.searchParams.get('start'), url.searchParams.get('end'));
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ blocked }) });
  });
  return { requests };
}

/**
 * Scrollar igenom hela sidan så att lazy-laddade bilder laddas,
 * återgår till toppen och väntar på typsnitt och bilder.
 * Native lazy-loading triggar inte alltid vid snabb programmatisk scroll,
 * därför tvingas alla lazy-bilder att ladda med en hård tidsgräns.
 * @param {import('@playwright/test').Page} page
 */
export async function settle(page) {
  await page.evaluate(async () => {
    const step = Math.max(200, Math.floor(window.innerHeight * 0.8));
    for (let y = 0; y < document.documentElement.scrollHeight; y += step) {
      window.scrollTo(0, y);
      await new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 30)));
    }
    window.scrollTo(0, 0);
  });
  await page.waitForLoadState('networkidle');
  await page.evaluate(() => {
    for (const img of document.images) {
      if (img.loading === 'lazy') img.loading = 'eager';
      // JS-driven lazy loading (data-image) direkt via registret om IO missat den.
      if (window.ImageStorage && img.hasAttribute('data-image') && !img.getAttribute('src')) {
        img.src = window.ImageStorage.getUrl(img.getAttribute('data-image'));
      }
    }
  });
  await page.waitForLoadState('networkidle');
  const pending = await page.evaluate(async () => {
    await document.fonts.ready;
    const images = [...document.images].filter((img) => img.getAttribute('src'));
    await Promise.race([
      Promise.all(images.map((img) => (img.complete ? null : new Promise((resolve) => {
        img.addEventListener('load', resolve, { once: true });
        img.addEventListener('error', resolve, { once: true });
      })))),
      new Promise((resolve) => setTimeout(resolve, 20000))
    ]);
    return images.filter((img) => !img.complete).map((img) => img.getAttribute('src'));
  });
  if (pending.length > 0) {
    throw new Error(`Bilder laddades aldrig: ${pending.join(', ')}`);
  }
  // Låt scroll-händelsen (header.scrolled) och eventuella övergångar landa.
  await page.waitForTimeout(400);
}
