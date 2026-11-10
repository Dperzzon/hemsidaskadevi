# Migrering: Vite + modernisering (november 2026)

Teknisk refaktorering av skadeviherrgard.com — **UI/UX oförändrat**,
verifierat med 90 visuella regressionstester mot baslinjer tagna från
ursprungliga `main` (se docs/regressionstester.md).

## Ny arkitektur

- **Vite 8 (MPA)** bygger alla 16 sidor (startsidan, 14 undersidor, 404).
  Rena URL:er (`/priser`, `/lediga-datum` …) bevaras exakt; servern mappar
  dem mot `dist/pages/*.html` och redirectar gamla `.html`-URL:er (301).
- **Produktionsservern** (`server/index.js`, tidigare `server.js`) serverar
  `dist/` med: rena URL:er, 301:or, brotli/gzip (förkomprimerat i bygget),
  cache-rubriker (immutable för hashade assets, 1 vecka för bilder/fonts,
  no-cache för HTML), säkerhetsrubriker (CSP, HSTS, nosniff, frame-ancestors,
  referrer-policy, permissions-policy), 404 utan SPA-fallback, ETag/304 och
  path traversal-skydd. Kalender-API:et (`/api/availability`) är oförändrat
  (`server/calendar/`, tidigare `api/src/`).
- **Vanilla HTML/CSS/JS** bevaras — inga ramverk. Skripten är ES-moduler som
  Vite bundle:ar till tre små hashade chunks (main, images, calendar).
- **Selfhostade typsnitt**: Google Fonts hämtas till `public/fonts/`
  (`npm run fetch-fonts`) — inga tredjepartsanrop, ingen GDPR-exponering,
  snabbare FCP. Endast de fyra föråldrade mallsidorna behåller (den trasiga)
  Google-länken, eftersom en fix skulle förändra deras utseende.

## Bästa optimeringarna

| Område | Före | Efter |
|---|---|---|
| Webbplatsens bilder | 26,1 MB (använda), 99,7 MB skickades till Azure | 3,9 MB (WebP/PNG-palett, samma bildstorlekar) |
| Total sidvikt (startsidan, Lighthouse) | 18,1 MB | 2,3 MB |
| Total sidvikt (/brollop) | 10,7 MB | 0,75 MB |
| Total sidvikt (/priser) | 72 kB | 16 kB |
| LCP /brollop (mobil simulerad) | 46,9 s | 2,7 s |
| LCP /lediga-datum (mobil simulerad) | 32,7 s | 2,5 s |
| LCP / (mobil simulerad) | 1,5 s | 0,8 s |
| Performance Lighthouse /brollop | 75 | 96 |
| Performance /lediga-datum | 75 | 98 |
| CLS (alla mätta sidor) | 0–0,006 | 0 |
| TBT (alla sidor) | 0 ms | 0 ms |
| Deploypaket | ≈ 105 MB | ≈ 4,6 MB + server + prod-beroenden |

Mätförutsättningar: Lighthouse 13.6 lokalt mot localhost, standard
mobil-emulering (simulerad Slow 4G, 4×CPU), 4 sidor före/efter.
Värden på riktigt nät blir bättre; siffrorna är inte påhittade men
localhost-baserade.

## JavaScript/CSS

- `images.js`: borttaget dött remote/Wix-fallback-lager (`ImageStorage.getUrl`
  behållen för fel diagnos/test), saknade bildnycklar rensade — beteendet
  (IntersectionObserver, galleri) identiskt.
- `calendar.js`: tävlingsfel fixat — ett gammalt API-svar kan inte längre
  skriva över ett nyare (request-token). Felsökningsmeddelanden och
  tillståndsmaskin identiska; 8 enhetstester täcker inkl. racet.
- `main.js`: passiv scroll-listener (INP); logik oförändrad.
- CSS: oförändrad utformning; endast tillägg av `prefers-reduced-motion`
  (tillgänglighet) + minifiering via Vite.
- Dubbla event listeners, saknade DOM-element och blockerande skript:
  inga fanns (verifierat via tester); modulskript är deferred som tidigare.

## Bilder och resurser

- WebP (q72–q82) med oförändrad bildstorlek/beskärning; logotyp som
  palett-PNG 512px (favicon-kompatibilitet): 2 MB → 45 kB.
- 800w-varianter av hero-bilderna + `srcset/sizes` — desktop hämtar samma
  fullstorleksfil som förut, mobilen en 800w-variant.
- `width`/`height` på alla img-element (CLS 0), `fetchpriority="high"` på
  LCP-bilder, `loading="lazy"` på allt under vyn (inkl. sociala-symboler).
- Oanvända original (37 filer) flyttade till `assets/originals/` — inga
  originals raderade.
- Selfhostade woff2-typsnitt (11 filer, 297 kB) med preload av de två
  latin-filer som används vid start.

## SEO

- robots.txt: css/js/images tas bort från Disallow (de krävs för rendering),
  `/api/` blockeras.
- sitemap.xml: `/boka` och `/lediga-datum` tillagda (fanns inte).
- Canonical + Open Graph tillagda på de 9 sidor som saknade dem; alla
  og:image är nu absoluta URL:er. JSON-LD-bild absolut.
- Interna länkar går till rena URL:er (de relativa `foretag.html`-länkarna
  gav 404 från rena URL:er); gamla .html-URL:er 301:as.
- 404-sidan returnerar riktig 404-status och sida (var felfri innan).

## Tillgänglighet

- `<main>`-landmark på startsidan, aria-label på galleri-navigeringen och
  de fyra generiska "Läs mer"-länkarna, favicon länkad på alla sidor (tystar
  404 i konsolen), `prefers-reduced-motion` stöds.
- **Dokumenterade, ej genomförda (kräver beslut eftersom de förändrar
  synligt utseende):**
  1. **Färgkontrast** (Lighthouse a11y 93–94): `cal-booked` (#9a958b på
     #e4e0d7) och liknande lågkontrast-texter i designen.
  2. **Rubriknivåer** (heading-order): sidfotens `h5` efter `h3`/`h1` hoppar
     nivåer; h5 är rikligt stiliserat (footer, strip-kort, rum/aktivitetskort)
     och en ändring kräver motsvarande CSS-arbete.
  3. **De fyra föråldrade mallsidorna** (priser, mat-dryck, om-oss,
     digital-visning): trasig typsnittslänk `rel="stylesheet>` (avslutande
     citattecken saknas) som äter efterföljande `<header>`-tagg i DOM:en —
     sidorna renderar därför med fallback-typsnitt och utan fungerande
     menyknapp. Rättelse förändrar synligt utseende och avvisas därför
     här; sidorna byggs oförändrade (se vite.config.mjs).
  4. `aria-label` räcker inte för SEO-auditet "link-text" ("Läs mer" är
     generisk crawlingsbar text); att byta synlig text är en innehållsändring.

## Säkerhet

- CSP (`default-src 'self'` osv.), HSTS, frame-ancestors 'none' tillagda;
  befintliga rubriker oförändrade. Google Fonts tillåtna i CSP endast för
  de fyra legacy-sidorna.
- Path traversal-, whitelist- och metodtester (13 enhetstester på servern).
- `npm audit`: 0 sårbarheter före och efter.
- Graceful shutdown (SIGTERM/SIGINT) tillagd; GET/HEAD-only bevarat.
- API:et felhanteras oförändrat (400/503/timeout, MAX_BYTES).

## Rensat bort

- Live Server: fanns aldrig i repo (.vscode saknades); skapad minimal
  `.vscode/settings.json` utan Live Server-konfiguration. Extension i din
  VS Code-profil är orörd.
- `api/` (Azure Functions-omslag från en övergiven Static Web Apps-plan):
  `host.json`, `api/package.json` (`@azure/functions`-beroendet bort),
  `api/src/functions/`; logiken lever vidare i `server/calendar/`.
- Dubbla package.json/package-lock (ett rooot-package nu).
- Gamla tester (ersatta av `tests/unit/`), `web-strategist.json/.md` +
  `strategy-audit.md` → `docs/archive/` (inte raderade).

## Återstående risker

- Visuella baslinjer är Windows-specifika (typsnittsrendering) — regenerera
  per maskin vid behov, aldrig för att "bli grön".
- LCP 2,5–2,7 s på /brollop och /lediga-datum under simulerad Slow 4G
  (lokalt mätt). Ytterligare minskning kräver lägre bildkvalitet eller
  designändring — avstår enligt uppdraget.
- De fyra legacy-sidorna blir riktade först när deras mall-buggar tas bort
  (då kan de normaliseras och gå genom Vite-transformeringen).
- Azure-deployment är inte körd (enligt uppdrag); pipeline är förberedd och
  lokalt smoke-testad.
