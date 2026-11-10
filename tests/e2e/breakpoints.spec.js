// Responsiva brytpunkter (style.css: 1300, 1100, 1024, 768, 480, 360 px).
// Körs endast i desktop-projektet; viewporten sätts explicit per test.
import { test, expect } from '@playwright/test';
import { prepare, settle } from './helpers.js';

const WIDTHS = [1920, 1300, 1100, 1024, 900, 480, 360];
const PATHS = [
  { name: 'startsida', path: '/' },
  { name: 'brollop', path: '/brollop' },
  { name: 'priser', path: '/priser' }
];

for (const width of WIDTHS) {
  for (const { name, path } of PATHS) {
    test(`@visual brytpunkt ${width}px: ${name}`, async ({ page }, testInfo) => {
      test.skip(testInfo.project.name !== 'desktop', 'Brytpunkter testas bara en gång.');
      await page.setViewportSize({ width, height: 900 });
      await prepare(page);
      await page.goto(path, { waitUntil: 'load' });
      await settle(page);
      await expect(page).toHaveScreenshot(`${name}-${width}.png`, { fullPage: true });
    });
  }
}
