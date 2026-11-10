// Minimal ESLint-konfiguration: fångar verkliga fel utan att ställa
// stilkrav. Körtid är Node 22; klientkoden är ES-moduler för webbläsaren.
const nodeGlobals = {
  process: 'readonly', console: 'readonly', URL: 'readonly', URLSearchParams: 'readonly',
  Response: 'readonly', fetch: 'readonly', Buffer: 'readonly', setTimeout: 'readonly',
  clearTimeout: 'readonly', setInterval: 'readonly', clearInterval: 'readonly',
  AbortController: 'readonly', TextDecoder: 'readonly', performance: 'readonly',
  queueMicrotask: 'readonly', structuredClone: 'readonly', crypto: 'readonly',
  __dirname: 'readonly', __filename: 'readonly', setImmediate: 'readonly',
  require: 'readonly', module: 'readonly', exports: 'readonly', global: 'readonly'
};

const browserGlobals = {
  window: 'readonly', document: 'readonly', navigator: 'readonly', location: 'readonly',
  IntersectionObserver: 'readonly', fetch: 'readonly', AbortController: 'readonly',
  URLSearchParams: 'readonly', console: 'readonly', setTimeout: 'readonly',
  clearTimeout: 'readonly', requestAnimationFrame: 'readonly', setImmediate: 'readonly',
  CustomEvent: 'readonly', sessionStorage: 'readonly', crypto: 'readonly',
  Intl: 'readonly', Number: 'readonly', Math: 'readonly'
};

export default [
  {
    ignores: ['dist/**', 'node_modules/**', 'test-results/**', 'playwright-report/**', 'assets/**']
  },
  {
    files: ['scripts/**/*.mjs', 'vite.config.mjs'],
    languageOptions: { sourceType: 'module', globals: nodeGlobals },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      'no-undef': 'error'
    }
  },
  {
    files: ['server/**/*.js', 'tests/unit/**/*.js', 'playwright.config.js'],
    languageOptions: { sourceType: 'commonjs', globals: nodeGlobals },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      'no-undef': 'error'
    }
  },
  {
    files: ['src/js/**/*.js'],
    languageOptions: { sourceType: 'module', globals: browserGlobals },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      'no-undef': 'error'
    }
  },
  {
    files: ['tests/e2e/**/*.js'],
    languageOptions: {
      sourceType: 'module',
      globals: { ...nodeGlobals, window: 'readonly', document: 'readonly', requestAnimationFrame: 'readonly' }
    },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      'no-undef': 'error'
    }
  }
];
