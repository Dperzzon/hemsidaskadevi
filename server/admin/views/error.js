'use strict';

const { escapeHtml } = require('../domain');
const { layout } = require('./layout');

function renderErrorPage(options) {
  const { status, message, principal, demo, csrfToken } = options;
  const content = `<section class="panel error-panel">
    <p class="eyebrow">Fel ${status}</p>
    <h1>${escapeHtml(status === 403 ? 'Behörighet saknas' : status === 404 ? 'Sidan hittades inte' : 'Något gick fel')}</h1>
    <p>${escapeHtml(message || 'Försök igen eller kontakta ansvarig administratör.')}</p>
    <div class="button-row"><a class="btn btn-primary" href="/admin">Till översikten</a></div>
  </section>`;
  if (principal) {
    return layout({ title: `Fel ${status}`, active: '', principal, demo, csrfToken, content });
  }
  return `<!doctype html><html lang="sv"><head><meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="robots" content="noindex, nofollow">
    <title>Fel ${escapeHtml(status)} · Skadevi Bokningsportal</title>
    <link rel="stylesheet" href="/assets/admin.css">
  </head><body class="standalone-error"><main class="error-panel">
    <p class="eyebrow">Skadevi Bokningsportal</p>
    <h1>${escapeHtml(status === 403 ? 'Behörighet saknas' : 'Inloggning krävs')}</h1>
    <p>${escapeHtml(message || 'Du behöver logga in med ett godkänt administratörskonto.')}</p>
    <a class="btn btn-primary" href="/.auth/login/aad?post_login_redirect_uri=%2Fadmin">Logga in</a>
  </main></body></html>`;
}

module.exports = { renderErrorPage };
