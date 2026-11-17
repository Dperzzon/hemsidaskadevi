// Kontrollerar att bokningssidan har samma menyrad som startsidan och att
// hamburgermenyn fungerar utan överlapp eller horisontell scroll.
import { test, expect } from '@playwright/test';

const VIEWPORTS = [
  { width: 1440, height: 900, desktop: true },
  { width: 1024, height: 768, desktop: false },
  { width: 768, height: 1024, desktop: false },
  { width: 390, height: 844, desktop: false },
  { width: 360, height: 800, desktop: false }
];

for (const { width, height, desktop } of VIEWPORTS) {
  test(`menyrad på /boka vid ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height });

    const measure = async (path) => {
      await page.goto(path, { waitUntil: 'domcontentloaded' });
      return page.evaluate(() => {
        const header = document.querySelector('.header').getBoundingClientRect();
        const logo = document.querySelector('.header-logo img').getBoundingClientRect();
        return {
          scrollWidth: document.documentElement.scrollWidth,
          innerWidth: window.innerWidth,
          headerCenter: header.left + header.width / 2,
          logoCenter: logo.left + logo.width / 2
        };
      });
    };

    const boka = await measure('/boka');
    const home = await measure('/');

    expect(boka.scrollWidth, 'horisontell scroll').toBeLessThanOrEqual(boka.innerWidth + 1);
    expect(Math.abs(boka.logoCenter - home.logoCenter), 'samma logotypposition som startsidan').toBeLessThan(1);
    expect(Math.abs(boka.logoCenter - boka.headerCenter), 'logotypen är centrerad').toBeLessThan(24);

    await page.goto('/boka', { waitUntil: 'domcontentloaded' });

    const toggle = page.locator('.mobile-toggle');
    const nav = page.locator('.header-nav');
    await expect(toggle).toBeVisible();

    if (desktop) {
      await expect(page.locator('.header-side .header-link')).toHaveCount(8);
      const rightSide = page.locator('.header-side').nth(1);
      await expect(rightSide.locator('.header-link').last()).toHaveText('Boka');
      await expect(rightSide.locator('.header-link').last()).toHaveAttribute('href', '/boka');
      await expect(nav).toBeHidden();
    } else {
      await expect(page.locator('.header-side .header-link:visible')).toHaveCount(0);
      await expect(nav).toBeHidden();

      await toggle.click();
      await expect(nav).toBeVisible();
      await expect(toggle).toHaveAttribute('aria-expanded', 'true');
      await expect(nav.locator('a[href="/boka"]')).toHaveCount(1);
      await expect(nav.locator('a[href="/boka"]')).toHaveText('Boka');

      await toggle.click();
      await expect(nav).toBeHidden();
      await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    }
  });
}

test('menyraden på /boka har samma länkar som startsidan', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const headerLinks = async (path) => {
    await page.goto(path, { waitUntil: 'domcontentloaded' });
    return page.locator('.header-side .header-link').evaluateAll((links) =>
      links.map((link) => ({ href: link.getAttribute('href'), text: link.textContent.trim() })));
  };

  expect(await headerLinks('/boka')).toEqual(await headerLinks('/'));
});
