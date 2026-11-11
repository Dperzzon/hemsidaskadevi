'use strict';

const { escapeHtml } = require('../domain');

function navItem(href, label, active) {
  const current = active === href ? ' aria-current="page"' : '';
  return `<a class="nav-link${active === href ? ' is-active' : ''}" href="${href}"${current}>` +
    `<span class="nav-mark" aria-hidden="true"></span>${escapeHtml(label)}</a>`;
}

function layout(options) {
  const {
    title, active, principal, demo, csrfToken, content, bodyClass = ''
  } = options;
  const demoBanner = demo
    ? `<div class="demo-banner" role="status">` +
      `<strong>Demoläge.</strong> Alla bokningar är syntetiska (DEMO-). ` +
      `Inga riktiga bokningar visas eller ändras, och inga statusändringar är aktiva.` +
      `</div>`
    : '';
  return `<!doctype html>
<html lang="sv">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex, nofollow">
  <meta name="theme-color" content="#f7f5f0">
  <title>${escapeHtml(title)} · Skadevi Bokningsportal</title>
  <link rel="icon" type="image/png" href="/assets/logo.png">
  <link rel="stylesheet" href="/assets/fonts.css">
  <link rel="stylesheet" href="/assets/admin.css">
  <script src="/assets/admin.js" defer></script>
</head>
<body class="${escapeHtml(bodyClass)}" data-csrf="${escapeHtml(csrfToken)}" data-demo="${demo ? 'true' : 'false'}" data-roles="${escapeHtml(principal.roles.join(','))}">
  <a class="skip-link" href="#main">Hoppa till innehåll</a>
  ${demoBanner}
  <div class="app-shell">
    <aside class="sidebar" id="sidebar" aria-label="Huvudmeny">
      <a class="brand" href="/admin" aria-label="Skadevi Bokningsportal – översikt">
        <img src="/assets/logo.png" width="64" height="64" alt="">
        <span><strong>Skadevi Gård</strong><small>Bokningsportal</small></span>
      </a>
      <nav class="main-nav" aria-label="Portal">
        ${navItem('/admin', 'Översikt', active)}
        ${navItem('/admin/bookings', 'Bokningar', active)}
      </nav>
      <div class="sidebar-note">
        <span class="sidebar-note-title">Första versionen</span>
        <p>Läsbar portal. Statusändringar, betalningar och kalender aktiveras i nästa etapp.</p>
      </div>
    </aside>
    <div class="workspace">
      <header class="topbar">
        <button class="menu-button" type="button" aria-controls="sidebar" aria-expanded="false">
          <span class="menu-lines" aria-hidden="true"></span>
          <span class="sr-only">Öppna meny</span>
        </button>
        <div class="topbar-spacer"></div>
        <div class="user-chip" title="${escapeHtml(principal.email || principal.name)}">
          <span class="user-avatar" aria-hidden="true">${escapeHtml((principal.name || 'A').slice(0, 1).toUpperCase())}</span>
          <span class="user-meta"><strong>${escapeHtml(principal.name)}</strong><small>${escapeHtml(principal.roles.join(', '))}${demo ? ' · demo' : ''}</small></span>
        </div>
      </header>
      <main id="main" class="main-content" tabindex="-1">
        ${content}
      </main>
      <footer class="app-footer">
        <span>Skadevi Gård · Bokningsportal</span>
        <span>Privat administration · alla sidor kräver inloggning</span>
      </footer>
    </div>
  </div>
  <div class="toast" id="toast" role="status" aria-live="polite" hidden></div>
</body>
</html>`;
}

module.exports = { layout };
