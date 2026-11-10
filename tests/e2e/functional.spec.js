// Funktionella E2E-tester (utan skärmbilder; körs även i CI).
// Visuella regressionstester ligger i visual.spec.js/breakpoints.spec.js
// och taggas @visual eftersom referensbilderna är plattformsspecifika.
import { test, expect } from '@playwright/test';
import { FIXED_NOW } from './helpers.js';

const PAGES = [
  { path: '/', title: 'Skadevi Gård — Hyr en hel privat herrgård nära Stockholm' },
  { path: '/foretag', title: 'Företag — Konferens, kickoff & ledningsgrupp | Skadevi Gård' },
  { path: '/fest', title: 'Fest & firande — Skadevi Gård' },
  { path: '/brollop', title: 'Bröllop på Skadevi Gård — En helt egen bröllopshelg' },
  { path: '/semester', title: 'Semester — Familjesemester på herrgård | Skadevi Gård' },
  { path: '/boende', title: 'Boendet — Sovrum, kök & faciliteter | Skadevi Gård' },
  { path: '/aktiviteter', title: 'Aktiviteter — Tennis, badtunna & utflykter | Skadevi Gård' },
  { path: '/priser', title: 'Priser — Hyr herrgård från 9 000 kr/natt | Skadevi Gård' },
  { path: '/mat-dryck', title: 'Mat & Dryck — Catering & självhushåll | Skadevi Gård' },
  { path: '/om-oss', title: 'Om oss — Historia & ägare | Skadevi Gård' },
  { path: '/vanliga-fragor', title: 'Vanliga frågor — FAQ | Skadevi Gård' },
  { path: '/kontakt', title: 'Bilder — Skadevi Gård' },
  { path: '/digital-visning', title: 'Digital visning — 3D-tur av Skadevi Gård | Skadevi Gård' },
  { path: '/boka', title: 'Boka — Skadevi Gård' },
  { path: '/lediga-datum', title: 'Lediga datum — Skadevi Gård' }
];

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(FIXED_NOW);
  await page.route('**/api/availability?*', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '{"blocked":[]}' }));
});

for (const { path, title } of PAGES) {
  test(`sida: ${path}`, async ({ page }) => {
    const errors = [];
    page.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()); });
    page.on('pageerror', (error) => errors.push(String(error)));
    const response = await page.goto(path, { waitUntil: 'load' });
    expect(response.status()).toBe(200);
    await expect(page).toHaveTitle(new RegExp(`^${title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    await expect(page.locator('h1')).toHaveCount(1);
    await expect(page.locator('link[rel="canonical"]')).toHaveCount(1);
    expect(errors, `konsolfel på ${path}`).toEqual([]);
  });
}

test('404-sida returnerar 404', async ({ page }) => {
  const response = await page.goto('/denna-sida-finns-inte');
  expect(response.status()).toBe(404);
  await expect(page.locator('h1')).toHaveText('404');
});

test('gamla .html-URL:er omdirigerar till rena URL:er', async ({ request }) => {
  for (const [from, to] of [
    ['/pages/priser.html', '/priser'],
    ['/priser.html', '/priser'],
    ['/index.html', '/'],
    ['/pages/lediga-datum.html', '/lediga-datum']
  ]) {
    const response = await request.get(from, { maxRedirects: 0 });
    expect(response.status(), from).toBe(301);
    expect(response.headers().location, from).toBe(to);
  }
});

test('robots.txt och sitemap.xml serveras', async ({ request }) => {
  const robots = await request.get('/robots.txt');
  expect(robots.status()).toBe(200);
  expect(await robots.text()).toContain('Sitemap:');
  const sitemap = await request.get('/sitemap.xml');
  expect(sitemap.status()).toBe(200);
  expect(await sitemap.text()).toContain('<loc>');
});

test('hashad css- och js-resurs laddas med cachelagringsrubriker', async ({ page, request }) => {
  await page.goto('/boka', { waitUntil: 'domcontentloaded' });
  const stylesheet = await page.locator('link[href^="/assets/"][rel="stylesheet"]').first().getAttribute('href');
  const script = await page.locator('script[type="module"]').first().getAttribute('src');
  for (const url of [stylesheet, script]) {
    expect(url, 'resurs-URL').toMatch(/^\/assets\//);
    const response = await request.get(url);
    expect(response.status()).toBe(200);
    expect(response.headers()['cache-control'], url).toMatch(/max-age=31536000/);
  }
});

test('mobilmeny öppnas och stängs', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/', { waitUntil: 'load' });
  const toggle = page.locator('.mobile-toggle');
  const nav = page.locator('.header-nav');
  await expect(nav).toBeHidden();
  await toggle.click();
  await expect(nav).toBeVisible();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  // Den öppna menyn är en fullskärmsöverlägg inom .header — den stängs med
  // knappen (samma beteende som före refaktoreringen).
  await toggle.click();
  await expect(nav).toBeHidden();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
});

test('header får scrolled-klass vid scroll', async ({ page }) => {
  await page.goto('/', { waitUntil: 'load' });
  const header = page.locator('.header');
  await expect(header).not.toHaveClass(/scrolled/);
  await page.evaluate(() => window.scrollTo(0, 400));
  await expect(header).toHaveClass(/scrolled/);
  await page.evaluate(() => window.scrollTo(0, 0));
  await expect(header).not.toHaveClass(/scrolled/);
});

test('galleriet bläddrar med knappar och ministrar', async ({ page }) => {
  await page.goto('/', { waitUntil: 'load' });
  const main = page.locator('#gallery-img');
  const first = await main.getAttribute('src');
  await page.locator('#gallery-next').click();
  expect(await main.getAttribute('src')).not.toBe(first);
  await page.locator('.gallery-thumb').nth(5).click();
  await expect(page.locator('.gallery-thumb').nth(5)).toHaveClass(/active/);
  await page.locator('#gallery-prev').click();
  await expect(page.locator('.gallery-thumb').nth(4)).toHaveClass(/active/);
});

test('vanliga frågor: stäng question uppdaterar aria-expanded', async ({ page }) => {
  await page.goto('/vanliga-fragor', { waitUntil: 'load' });
  const question = page.locator('.faq-question').first();
  await expect(question).toHaveAttribute('aria-expanded', 'false');
  await question.click();
  await expect(question).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('.faq-item').first()).toHaveClass(/open/);
  await question.click();
  await expect(question).toHaveAttribute('aria-expanded', 'false');
});

test('kalendern visar två månader och bläddrar', async ({ page }) => {
  await page.goto('/lediga-datum', { waitUntil: 'load' });
  await expect(page.locator('.cal-month h3').first()).toHaveText('November 2026');
  await expect(page.locator('.cal-month')).toHaveCount(2);
  await expect(page.locator('#calendar-description')).toBeVisible();
  await page.locator('#cal-next').click();
  await expect(page.locator('.cal-month h3').first()).toHaveText('December 2026');
});

test('kalendern visar felmeddelande när API:et svarar 503', async ({ page }) => {
  await page.route('**/api/availability?*', (route) =>
    route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"x"}' }));
  await page.goto('/lediga-datum', { waitUntil: 'load' });
  await expect(page.locator('.cal-notice')).toContainText('Tillgängligheten är okänd');
  await expect(page.locator('.cal-month')).toHaveCount(0);
});

test('kalender-API:et avvisar ogiltigt intervall', async ({ request }) => {
  const response = await request.get('/api/availability?start=2026-01-01');
  expect(response.status()).toBe(400);
});

test('sidfotens årtalet uppdateras', async ({ page }) => {
  await page.goto('/', { waitUntil: 'load' });
  await expect(page.locator('[data-year]')).toHaveText('2026');
});
