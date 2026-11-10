// Visuell regressionssvit. Referensbilderna i tests/e2e/__screenshots__/
// togs från den ursprungliga main-versionen (före Vite-migreringen) och får
// INTE uppdateras för att få testerna gröna. Se docs/regressionstester.md.
import { test, expect } from '@playwright/test';
import { PAGES, prepare, settle } from './helpers.js';

for (const { name, path } of PAGES) {
  test(`@visual helsida: ${name}`, async ({ page }) => {
    await prepare(page);
    await page.goto(path, { waitUntil: 'load' });
    await settle(page);
    await expect(page).toHaveScreenshot(`${name}.png`, { fullPage: true });
  });
}

test('@visual startsida: header efter scroll', async ({ page }) => {
  await prepare(page);
  await page.goto('/', { waitUntil: 'load' });
  await settle(page);
  await page.evaluate(() => window.scrollTo(0, 400));
  await page.waitForTimeout(500);
  await expect(page).toHaveScreenshot('startsida-scrolled.png');
});

test('@visual startsida: öppen meny', async ({ page }) => {
  await prepare(page);
  await page.goto('/', { waitUntil: 'load' });
  await settle(page);
  await page.locator('.mobile-toggle').click();
  await page.waitForTimeout(300);
  await expect(page).toHaveScreenshot('startsida-meny.png');
});

test('@visual startsida: galleri efter nästa-klick', async ({ page }) => {
  await prepare(page);
  await page.goto('/', { waitUntil: 'load' });
  await settle(page);
  await page.locator('#gallery-next').click();
  await page.locator('#gallery-next').click();
  await settle(page);
  await expect(page.locator('.gallery-carousel')).toHaveScreenshot('startsida-galleri.png');
});

test('@visual vanliga frågor: öppen fråga', async ({ page }) => {
  await prepare(page);
  await page.goto('/vanliga-fragor', { waitUntil: 'load' });
  await settle(page);
  await page.locator('.faq-question').first().click();
  await page.waitForTimeout(600);
  await expect(page.locator('.faq-layout')).toHaveScreenshot('faq-oppen.png');
});

test('@visual lediga datum: nästa månader', async ({ page }) => {
  await prepare(page);
  await page.goto('/lediga-datum', { waitUntil: 'load' });
  await settle(page);
  await page.locator('#cal-next').click();
  await expect(page.locator('.cal-month h3').first()).toHaveText('December 2026');
  await expect(page.locator('.calendar-card')).toHaveScreenshot('kalender-nasta.png');
});

test('@visual lediga datum: felläge', async ({ page }) => {
  await prepare(page, { calendar: 'error' });
  await page.goto('/lediga-datum', { waitUntil: 'load' });
  await settle(page);
  await expect(page.locator('.calendar-card')).toHaveScreenshot('kalender-fel.png');
});

test('@visual sidfot', async ({ page }) => {
  await prepare(page);
  await page.goto('/', { waitUntil: 'load' });
  await settle(page);
  await expect(page.locator('footer.footer')).toHaveScreenshot('sidfot.png');
});
