# Skadevi Gård — hemsida

Statisk webbplats (Vanilla HTML/CSS/JS) byggd med **Vite som multi-page
app (MPA)**, serverad i produktion av en egen Node.js-server med
kalender-API:et `/api/availability`.

Inga ramverk, inget annat runtime-beroende än kalenderlogikens
(`node-ical`, `temporal-polyfill`).

## Kom igång

```powershell
npm ci --no-audit --no-fund   # installerar beroenden reproducerbart
npm run dev                   # Vite dev-server på http://localhost:5173
```

`npm run dev` startar Vite och ersätter Live Server. Dev-servern serverar
samtidigt kalender-API:et på `/api/availability`:

- Sätt `AIRBNB_ICAL_URL` (https-adress) i miljön för riktig kalenderdata.
- Utan variabeln används automatiskt en syntetisk kalender (en blockad
  period tolv dagar fram i tiden) så att kalendern går att testa lokalt.

## Npm-skript

| Kommando | Vad det gör |
|---|---|
| `npm run dev` | Vite dev-server (MPA, rena URL:er, kalender-API med mock) |
| `npm run build` | Bygger `dist/` (hashade resurser) + förkomprimerar (.br/.gz) |
| `npm run preview` | Serverar `dist/` med produktionsservern (samma kod som Azure) |
| `npm run start` | Samma som `preview` — startar `server/index.js` på `$PORT` |
| `npm test` | Enhetstester (node:test): server, kalender-API, kalenderklient |
| `npm run test:e2e` | Playwright: funktionella E2E-tester mot `dist/` |
| `npm run test:visual` | Playwright: visuella regressionstester (se docs/regressionstester.md) |
| `npm run lint` | ESLint |
| `npm run optimize-images` | Regenererar optimerade bilder i `public/images/` |
| `npm run fetch-fonts` | Hämtar/selfhostar typsnitt från Google Fonts |

## Katalogstruktur

```
src/                 Webbplatsens källkod (Vite root)
  index.html         Startsidan
  404.html           Fel-sida (serveras av produktionsservern)
  pages/             Alla undersidor (rena URL:er: /priser → pages/priser.html)
  css/               style.css + fonts.css (selfhostade typsnitt)
  js/                main.js, images.js, calendar.js (ES-moduler, ingen bundling konfig)
public/              Kopieras oförändrat till dist/ (bilder, typsnitt, robots.txt, sitemap.xml)
server/              Produktionsserver
  index.js           HTTP-server: rena URL:er, 301-redirects, cache/säkerhetsrubriker, brotli/gzip
  calendar/          Kalenderlogik (availability.js, calendar-worker.js) — oförändrad
dist/                Byggresultat (skapas av npm run build)
scripts/             Bygg- och verktygsskript (fonts, bilder, verifiering, smoke-test)
tests/               Enheterstester (unit/) och Playwright-tester (e2e/)
infra/               Bicep-mallar (Azure App Service, Key Vault, managed identity)
docs/                Driftsättningsguide m.m.
.github/workflows/   CI/CD: test → Vite-build → smoke-test → Azure-deployment (OIDC)
assets/originals/    Originalbilder (källmaterial; webbplatsen använder public/images/)
```

### De fyra föråldrade mallsidorna

`priser.html`, `mat-dryck.html`, `om-oss.html` och `digital-visning.html`
innehåller en trasig typsnittslänk (`rel="stylesheet>` utan avslutande
citattecken) från den gamla mallen. Eftersom felet påverkar renderingen
(pixelfallade typsnitt, avklippt sidhuvud) och en fix skulle förändra
sidornas utseende lämnas de as-is av Vite (se `vite.config.mjs`): de
kopieras oförändrade till `dist/` och läser `/css/style.css` samt
`/js/main.js` som skapas av `scripts/finalize-dist.mjs`. Att rätta felet
kräver ett separat beslut — se docs/migrering.md.

## Produktion

- `npm run start` respekterar `PORT` och serverar `dist/` — exakt samma
  server körs i Azure App Service (`hemsida-skadevi-prod`, Sweden Central).
- Servern gör: rena URL:er (`/priser` → `dist/pages/priser.html`),
  301-redirects från gamla `.html`-URL:er, brotli/gzip-förkomprimerade
  svar, cache-rubriker (immutable för hashade assets), säkerhetsrubriker
  (CSP, HSTS, nosniff m.fl.), 404 utan SPA-fallback och path traversal-skydd.
- Kalender-API:et läser `AIRBNB_ICAL_URL` (Key Vault-referens i Azure).
- Se docs/driftsattning.md för infrastruktur, domän och felsökning.

## CI/CD

`.github/workflows/deploy.yml` kör vid push till `main`:

1. `npm ci` → ESLint → enhetstester
2. `npm run build` (Vite) → verifiering av dist/
3. Playwright E2E (funktionella) mot den byggda applikationen
4. Paketering: `dist/` + `server/` + produktionsberoenden (inga tester,
   docs eller hemligheter) → startkontroll + HTTP-smoke-test
5. `azure/login` via OIDC (`id-token: write`) + `azure/webapps-deploy`

## Felsökning

- **Konsolfel om CSP i utveckling:** dev-servern sätter inga rubriker;
  produktionsserverns CSP gäller bara i `npm run preview`/Azure.
- **404 på rena URL:er i preview:** kör `npm run build` först — preview
  serverar `dist/`.
- **Kalendern visar "okänd tillgänglighet":** `AIRBNB_ICAL_URL` saknas eller
  är fel (i produktion: Key Vault, se docs/driftsattning.md).
- **Visuella tester misslyckas på Linux/CI:** referensbilderna är
  plattformsspecifika; se docs/regressionstester.md.
