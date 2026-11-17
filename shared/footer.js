'use strict';

// Gemensam sidfot för alla publika sidor. Källan till sanningen är denna
// modul: scripts/sync-footer.mjs skriver in den i de statiska HTML-sidorna och
// de serverrenderade betalningssidorna importerar samma funktion.

const EXPLORE_LINKS = [
  ['/foretag', 'Företag'],
  ['/brollop', 'Bröllop'],
  ['/semester', 'Semester'],
  ['/fest', 'Fest'],
  ['/boende', 'Boendet']
];

const INFO_LINKS = [
  ['/priser', 'Priser'],
  ['/om-oss', 'Om oss'],
  ['/vanliga-fragor', 'Vanliga frågor'],
  ['/boka', 'Boka']
];

function linkList(links) {
  return links
    .map(([href, label]) => `          <li><a href="${href}">${label}</a></li>`)
    .join('\n');
}

function renderFooter() {
  return `<footer class="footer" role="contentinfo">
  <div class="footer-inner">
    <div class="footer-grid">
      <div class="footer-col footer-col-brand">
        <a class="footer-logo" href="/" aria-label="Skadevi Herrgård – startsidan">
          <img src="/images/logo.png" alt="Skadevi Herrgård" width="512" height="512" loading="lazy">
        </a>
        <p class="footer-tagline">En privat herrgård för minnesvärda vistelser, möten och firanden.</p>
      </div>
      <nav class="footer-col" aria-labelledby="footer-explore">
        <h3 id="footer-explore">Utforska</h3>
        <ul class="footer-links">
${linkList(EXPLORE_LINKS)}
        </ul>
      </nav>
      <nav class="footer-col" aria-labelledby="footer-info">
        <h3 id="footer-info">Information</h3>
        <ul class="footer-links">
${linkList(INFO_LINKS)}
        </ul>
      </nav>
      <div class="footer-col footer-col-contact">
        <h3>Kontakt</h3>
        <address>
          <p>Skoklostervägen 16<br>746 94 Häggeby</p>
          <p><a href="tel:+46702730422">+46 70 273 04 22</a></p>
          <p><a href="mailto:skadevigard@gmail.com">skadevigard@gmail.com</a></p>
        </address>
        <p class="footer-social"><a href="https://www.instagram.com/skadevigard/" target="_blank" rel="noopener">Instagram</a></p>
      </div>
    </div>
    <div class="footer-bottom">
      <p>&copy; <span data-year>2026</span> Skadevi Herrgård</p>
    </div>
  </div>
</footer>`;
}

module.exports = { renderFooter };
