# Skadevi Gård

## Status

Azure-versionen är under utveckling och är inte verifierad i Azure.
GitHub Pages kan inte köra kalender-API:et. När denna version publiceras där
visar kalendern därför okänd tillgänglighet tills webbplatsen körs med API:et
i Azure. Den tidigare publicerade kalenderadressen är exponerad och behöver
roteras hos leverantören; gamla versioner kan fortfarande finnas i historik
och cache.

## Lokala tester

Förutsättningen är Node.js 22 och npm. Installera de låsta API-beroendena från
repositoryts rot:

```powershell
Set-Location .\api
npm ci --ignore-scripts --no-audit --no-fund
Set-Location ..
```

Kör testerna:

```powershell
node --test .\tests\calendar-client.test.js
Set-Location .\api
npm test
Set-Location ..
```

Starta en lokal testserver med en syntetisk kalender:

```powershell
node .\tests\calendar-mock-server.js success 18743
```

Öppna `http://127.0.0.1:18743/pages/lediga-datum.html`. Servern används
endast för lokala tester och hämtar inte någon riktig kalender. Avsluta den med
Ctrl+C. Andra scenarier är `empty`, `invalid`, `network`, `timeout` och
`unconfigured`; ange ett av dem i stället för `success`. Testservern är inte en
Azure Static Web Apps- eller Azure Functions-emulator.

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

`infra/main.bicep` skapar en Azure Static Web App på Free-nivån med ett
hanterat API. Ingen separat Function App, lagring eller databas behövs för
denna arkitektur. Mallen kopplar inte GitHub, driftsätter inte kod och ändrar
inte domäner eller DNS. `staticwebapp.config.json` anger Node.js 22 för API:et.
Free saknar SLA; kontrollera aktuell tillgänglighet, kvoter och kostnader för
din prenumeration och region innan du skapar resurser.

Förutsättningar är Azure CLI med Bicep, vald prenumeration och en befintlig
resursgrupp. Granska först vad som skulle skapas:

```powershell
az deployment group what-if --resource-group <resursgrupp> --template-file .\infra\main.bicep --parameters staticWebAppName=<resursnamn> location=westeurope
```

Efter separat godkännande av resursskapande kan samma parametrar användas med
`az deployment group create` i stället för `what-if`. Skapa inte en resurs
förrän prenumeration, region, kvoter och kostnader har kontrollerats.
Mallen ändrar inte appinställningar vid senare körningar. Ställ in den nya,
roterade kalenderadressen som `AIRBNB_ICAL_URL` i Static Web Apps
**Environment variables** i Azure-portalen. Den ska inte anges i Bicep,
parameterfiler, terminalkommandon, loggar eller versionshantering. API:et
visar okänd tillgänglighet tills inställningen och appkoden är på plats.

Applikationskod måste driftsättas separat. Paketera endast publika webbassets
och `staticwebapp.config.json` som frontend; inkludera inte `api`, tester,
infrastruktur, Git-filer, beroenden eller lokala inställningar där. Skicka
`api` separat som hanterat API med Azure Static Web Apps CLI eller en
granskad distributionspipeline. Testa först en separat miljö och kontrollera
API, sidor, länkar och felhantering innan domänen flyttas. Mall, paketering,
driftsättning och verkligt kalenderflöde är ännu inte verifierade i Azure.

Microsofts referenser: [Bicep-resursen](https://learn.microsoft.com/en-us/azure/templates/microsoft.web/2024-11-01/staticsites),
[API-inställningar](https://learn.microsoft.com/en-us/azure/static-web-apps/application-settings),
[runtimes](https://learn.microsoft.com/en-us/azure/static-web-apps/languages-runtimes)
och [SWA CLI](https://learn.microsoft.com/en-us/azure/static-web-apps/static-web-apps-cli-deploy).
