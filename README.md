# Skadevi Gård

## Status

Azure-versionen (App Service, Sweden Central) är förberedd men ännu inte
verifierad i Azure. Den tidigare publicerade kalenderadressen är exponerad
och behöver roteras hos leverantören; gamla versioner kan fortfarande finnas
i historik och cache.

## Lokala tester

Förutsättningen är Node.js 22 och npm. Installera de låsta beroendena från
repositoryts rot:

```powershell
npm ci --ignore-scripts --no-audit --no-fund
npm ci --ignore-scripts --no-audit --no-fund --prefix api
```

Kör testerna:

```powershell
node --test .\tests\calendar-client.test.js
node --test .\tests\server.test.js
```

Kör webbappen lokalt:

```powershell
$env:PORT = '8080'
npm start
```

Starta en lokal testserver med en syntetisk kalender:

```powershell
node .\tests\calendar-mock-server.js success 18743
```

Öppna `http://127.0.0.1:18743/pages/lediga-datum.html`. Servern används
endast för lokala tester och hämtar inte någon riktig kalender. Avsluta den med
Ctrl+C. Andra scenarier är `empty`, `invalid`, `network`, `timeout` och
`unconfigured`; ange ett av dem i stället för `success`. Testservern är inte
en Azure-emulator.

## Kalenderfunktion

Klienten använder `/api/availability` på samma ursprung. Funktionen hämtar
flödet på begäran från serverinställningen `AIRBNB_ICAL_URL` och svarar endast
med blockerade datum för det begärda intervallet. Svar cachas inte. Timeout,
storleksbegränsning och omdirigeringar inom samma HTTPS-ursprung begränsar
hämtningen; fel ger okänd tillgänglighet. Funktionen får aldrig konfigureras
med en kalenderadress i klientkod, Git, testdata eller byggartefakter.

Hela dagar använder exklusivt slutdatum. Tidssatta händelser räknas till de
datum de berör i `Europe/Stockholm`; iCalendar-tider utan tidszon behandlas som
lokal tid där. Återkomstregler med `RRULE`, `RDATE` för datum och tid,
`EXDATE`, `EXRULE` och `RECURRENCE-ID`, inklusive `RANGE=THISANDFUTURE`,
testas med syntetiska data.

Parsern avvisar bland annat `RDATE;VALUE=PERIOD`, `VFREEBUSY`, okända
tidszoner, orimligt stora återkomstintervall och ofullständiga eller
otolkbara kalenderdata. I dessa fall visas ett fel, inte en tom lista med
lediga datum. Det är ännu inte verifierat vilka konstruktioner som förekommer
i det verkliga flödet; detta måste kontrolleras säkert innan migreringen.
Funktionens beteende i en hanterad Azure-miljö är inte verifierat.

När en säker serverlösning är redo behöver ägaren ersätta den exponerade
kalenderadressen hos leverantören, lägga den nya adressen i Azure som
serverinställningen `AIRBNB_ICAL_URL` och verifiera bytet utan att publicera
hemligheten. Den tidigare adressen kan finnas kvar i Git-historik, tidigare
publiceringar och cache. Leverantörens uppdateringsfördröjning kan inte
garanteras.

## Azure-infrastruktur

Hela infrastrukturen hanteras via Bicep, inklusive resursgruppen. En enda
subscription-scope-deployment skapar allt i **swedencentral**:

- `infra/main.bicep` — targetScope `subscription`; skapar resursgruppen
  `rg-skadevi-prod` deklarativt och anropar modulen i `infra/modules/`.
- `infra/modules/webapp.bicep` — targetScope `resourceGroup`; skapar
  App Service-planen `asp-skadevi-prod` (Linux, **Basic B1**, ≈ 130 kr/månad)
  och webbappen `hemsida-skadevi-prod` (Node.js 22) som serverar både den
  statiska webbplatsen och kalender-API:et via `server.js`. Ingen SQL,
  ingen separat Function App, ingen lagring.
- `infra/main.bicepparam` — alla namn, regioner, SKU, Node-version, domän
  och taggar. `AIRBNB_ICAL_URL` är en Key Vault-referens: hemliga värdet
  sätts en gång i valvet (`kv-skadevi-prod`) och förekommer aldrig i Git,
  Bicep eller dokumentation, och nollställs aldrig av upprepade deployments.
- `server.js` (utan extra npm-beroenden) serverar statiska filer med whitelist
  och path-traversal-skydd, rena URL:er enligt sitemap.xml, säkerhetsrubriker
  och `/api/availability` via oförändrad kalenderlogik i `api/src/`.
- B1 saknar deployment slots och har ingen SLA-förbindelse i detta val.
  Data lagras och processas i Sverige.

Granska först vad som skulle skapas (deploymenten är idempotent och fungerar
även när resursgruppen redan finns):

```powershell
az deployment sub what-if --location swedencentral --template-file .\infra\main.bicep --parameters .\infra\main.bicepparam
```

Efter separat godkännande av resursskapande kan samma parametrar användas med
`az deployment sub create` i stället för `what-if`. Skapa inte en resurs
förrän prenumeration, region, kvoter och kostnader har kontrollerats.
Kalenderadressen (roterad, hemlig) ställs in som `AIRBNB_ICAL_URL` enligt
`docs/driftsattning.md` — den ska aldrig anges i Git, klientkod, loggar eller
i `infra/main.bicepparam`. API:et visar okänd tillgänglighet tills
inställningen och appkoden är på plats.

Driftsättning av kod sker med `.github/workflows/deploy.yml`, som vid push
till `main` kör testerna (API, server, kalenderklient), paketerar endast
publika filer plus `server.js` och beroenden, och zip-driftsätter till
App Service. Workflow kräver GitHub-hemligheten
`AZURE_WEBAPP_PUBLISH_PROFILE` med publiceringsprofilen från Azure-portalen;
den sätts enligt `docs/driftsattning.md`. GitHub Pages och gamla
Static Web Apps-sekreter/hemligheter är föråldrade och bör tas bort.
Mall, paketering, driftsättning och verkligt kalenderflöde är ännu inte
verifierade i Azure. Fullständig steg-för-steg-guide för driftsättning,
uppdatering, domänkoppling och felsökning finns i
`docs/driftsattning.md`.

Microsofts referenser: [Bicep-resursen](https://learn.microsoft.com/en-us/azure/templates/microsoft.web/2024-11-01/staticsites),
[API-inställningar](https://learn.microsoft.com/en-us/azure/static-web-apps/application-settings),
[runtimes](https://learn.microsoft.com/en-us/azure/static-web-apps/languages-runtimes)
och [SWA CLI](https://learn.microsoft.com/en-us/azure/static-web-apps/static-web-apps-cli-deploy).
