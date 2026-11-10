# Visuella regressionstester (Playwright)

Syfte: garantera att refaktoreringen inte förändrar webbplatsens UI/UX.
Referensbilderna togs från den ursprungliga main-versionen **innan**
Vite-migreringen och får inte uppdateras bara för att få tester gröna.

## Köra

```powershell
npm run build              # referensbilder ska jämföras mot produktionsservern
npm run test:visual        # alla projekt + brytpunkter (taggade @visual)
npm run test:e2e           # funktionella tester utan skärmbilder (CI-säkra)
```

`playwright.config.js` startar produktionsservern (`server/index.js`) på
port 4173 automatiskt. Sätt `E2E_BASE_URL` för att jämföra mot en annan
redan startad server, t.ex. den ursprungliga koden:

```powershell
E2E_BASE_URL=http://127.0.0.1:4180 npm run test:visual
```

## Determinism

Alla tester körs med (se `tests/e2e/helpers.js`):

- **Fast klocka** — `page.clock.setFixedTime` låser datumet till
  2026-11-09, så kalendern visar alltid samma månader och sidfoten samma år.
- **Mockat kalender-API** — deterministiska bokade datum oavsett riktig
  iCal-källa (och ett felläge med 503).
- **Fast tidszon och språk** — `Europe/Stockholm`, `sv-SE`.
- **`settle()`** — scrollar igenom sidan, tvingar alla lazy-bilder att
  ladda (`loading="eager"`), väntar på typsnitt och bilder, och misslyckas
  om en bild inte laddar (så att tomma ytor aldrig spärras in i baslinjen).

## Täckning

- 16 sidor × 3 viewportar (desktop 1440, tablet 768, mobil 390) — helsidor
- Brytpunkter 1920/1300/1100/1024/900/480/360 px (style.css: 360–1300)
- Interaktioner: header efter scroll, öppen mobilmeny, galleri (nästa + miniatyrer),
  öppen FAQ-fråga, kalendern (nästa månad + felläge), sidfoten
- Funktionella tester (utan bilder): titlar, canonical, omdirigeringar,
  404, cache-rubriker, aria-tillstånd, kalenderns beteende, API-validering

## Plattformar och tolerans

Referensbilderna lagras per plattform (`__screenshots__/<plattform>/`).
Typsnittsrendering skiljer mellan operativsystem — nya baslinjer genereras
därför per maskin vid behov (`npx playwright test --grep @visual
--update-snapshots`), men ENDAST efter medvetna, godkända designändringar.
Toleransen är `threshold: 0.2` per pixel och max 1 % avvikande pixlar —
tillräckligt för förlustbehaftad bildkomprimering, men fångar layout- och
typsnittsförändringar.
