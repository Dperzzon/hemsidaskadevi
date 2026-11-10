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
- **Dokumenterade kontrastfynd (Lighthouse color-contrast) — förslag som
  INTE är genomförda eftersom de förändrar synliga färger:**
  1. `--color-secondary` `#8b6b4a` mot `#f7f5f0` = **4,48:1** (krav 4,5).
     Förslag: `#876847` → 4,70:1. En knappt märkbar mörkning av den bruna
     tonen (knappar/strong-text); inga andra kulörer berörs.
  2. `--color-accent` `#c9a96e` (guld) som **text** mot `#f7f5f0` = **2,05:1**
     (sidfotsrubriker "Kontakta oss/Följ oss" med guld på ljus bakgrund,
     kartlänk). Som text krävs t.ex. `#85693a` (≈ 4,6:1) — en synligt
     mörkare guldton. Alternativ: mörkare sidfotsbakgrund så att guldet
     behålls. Guldet som **dekoration** (ramar, linjer, strip-kanter) är
     omdiskuterat men omfattas inte av textkravet.
  3. Kalenderns bokade-datum-text `#9a958b` på `#e4e0d7` ≈ 2,1:1 — det är
     avsikten att bokade datum ska vara "tönande"; förslag: mörkare text
     (`#7d7869` ≈ 3,2:1) eller ljusare ruta.
- **Rubriknivåer — RÄTTADE (godkänt, nov 2026):** sidfoternas `h5` → `h3`
  och startsidans strip-kortrubriker `h5` → `h2` med beräknade stilar
  pinnade i CSS (vikt 500, radhöjd 1,4, versaler, spärrning). Verifierat
  visuellt oförändrat: samtliga ovidberörda sidors baslinjer passerar.
  Döda `h5`-regler (room-card/activity-card) borttagna.
- **De fyra föråldrade mallsidorna — RÄTTADE (godkänt, nov 2026):** den
  trasiga typsnittslänken (`rel="stylesheet>` utan avslutande citattecken)
  på priser, mat-dryck, om-oss och digital-visning är ersatt med sajtens
  selfhostade typsnittsblock. Sidorna går nu genom Vite-processeringen som
  alla andra (legacy-undantaget i vite.config.mjs är borttaget). Deras
  baslinjer är därför regenererade; se "Visuella skillnader" nedan.

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
  (lokalt mätt). Yttre minskning kräver lägre bildkvalitet eller
  designändring — avstår enligt uppdraget.
- Fyra legacy-sidor har en förbygglig horisontell överrullning på mobil
  (scrollWidth 406 px mot 390 vy; pris-tabellen) — pre-existerande beteende,
  oförändrat av migreringen.
- Azure-deployment är inte körd (enligt uppdrag); pipeline är förberedd,
  Linux-kompatibel och paketet är startverifierat via smoke-testet.

## Visuella skillnader vid de godkända rättelserna (nov 2026)

Baslinjer för /priser, /mat-dryck, /om-oss och /digital-visning (alla tre
viewportar + /prisers sju brytpunkter, 19 bilder) regenererades EFTER att
följande skillnader mot de gamla baslinjerna dokumenterats — de är själva
buggfixen:

1. **Sidhuvud:** `<header class="header">` finns nu i DOM:en (den var tidigare
   uppäten av den trasiga länkens attributtolkning). Logotypen "SKADEVI
   GÅRD" renderas i sajtens varumärkestypsnitt (Libre Baskerville, versaler,
   spärrning) i stället för ostylad systemfont på ett vitt band; heron
   täcker hela toppen. Sidhöjd /priser 3 965 → 3 954 px, /mat-dryck
   2 405 → 2 410 px, /om-oss 2 761 → 2 766 px, /digital-visning
   2 058 → 2 006 px (små textomflödesförskjutningar av typsnittsbytet).
2. **Typsnitt:** Inter + Libre Baskerville (selfhostade) i hela sidan i
   stället för fallback-fonts (Georgia/Arial-liknande) — samma som övriga
   12 sidor alltid haft.
3. **Meny:** hamburgerknappen öppnar/stänger `.header-nav` (aria-expanded,
   ✕-ikon) och länkarna fungerar; header får `.scrolled`-tillstånd vid scroll
   med vit bakgrund — precis som /boka och övriga undersidor.
4. **Mobil:** sidbredd vid 390 px-vy minskade från 411 → 406 px (den
   kvarvarande 16 px-överrullningen är pris-tabellen, pre-existerande).
5. Innehåll, texter, priser och sektioner oförändrade; favicon 404 i
   konsolen borttagna (link rel=icon tillagd tidigare i migreringen).
