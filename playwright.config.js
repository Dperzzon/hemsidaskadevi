// Playwright-konfiguration: visuella regressionstester och funktionella E2E-tester.
// Servern är den riktiga produktionsservern (server.js) som serverar dist/.
const { defineConfig } = require('@playwright/test');

const PORT = Number(process.env.E2E_PORT || 4173);
const external = process.env.E2E_BASE_URL;

module.exports = defineConfig({
  testDir: './tests/e2e',
  outputDir: './test-results',
  fullyParallel: true,
  timeout: 180000,
  workers: process.env.CI ? 2 : 3,
  retries: 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list']],
  // Referensbilder är plattformsspecifika (typsnittsrendering skiljer mellan OS).
  snapshotPathTemplate: '{testDir}/__screenshots__/{platform}/{projectName}/{arg}{ext}',
  expect: {
    toHaveScreenshot: {
      animations: 'disabled',
      caret: 'hide',
      scale: 'css',
      // Per-pixeltolerans för förlustfri/förlustbehäftad bildkomprimering.
      threshold: 0.2,
      maxDiffPixelRatio: 0.01
    }
  },
  use: {
    baseURL: external || `http://127.0.0.1:${PORT}`,
    locale: 'sv-SE',
    timezoneId: 'Europe/Stockholm',
    deviceScaleFactor: 1,
    colorScheme: 'light',
    reducedMotion: 'no-preference',
    trace: 'retain-on-failure'
  },
  projects: [
    { name: 'desktop', use: { browserName: 'chromium', viewport: { width: 1440, height: 900 } } },
    { name: 'tablet', use: { browserName: 'chromium', viewport: { width: 768, height: 1024 } } },
    { name: 'mobile', use: { browserName: 'chromium', viewport: { width: 390, height: 844 }, hasTouch: true } }
  ],
  webServer: external ? undefined : {
    command: process.env.E2E_SERVER_COMMAND || 'node server/index.js',
    url: `http://127.0.0.1:${PORT}/robots.txt`,
    env: { PORT: String(PORT), NODE_ENV: 'production' },
    reuseExistingServer: false,
    timeout: 60000
  }
});
