# Skadevi Bokningsportal — lokal demo och Azure-förberedelse

Portalen är en separat administrationsapp. Den ändrar inte den publika
webbplatsens beteende, Azure-resurserna, DNS eller `BOOKING_REQUESTS_ENABLED`.
Bokningshanteringen är aktiv i produktion: manuella bokningar,
statusövergångar, datumblockering, betalstatus, anteckningar, auditlogg och
intern kalender. Skrivningar mot Azure Table Storage använder managed identity
med Contributor endast på tabellen `bookingrequests`. Mejl är fortfarande
avstängt.

## 1. Starta demon

```powershell
npm ci --no-audit --no-fund
npm run admin:dev
```

Öppna `http://localhost:3001/admin`.

Demoläget:

- använder endast syntetiska bokningar med referenser som börjar på `DEMO-`;
- kräver ingen Azure-åtkomst och inga hemligheter;
- har skrivbara manuella bokningar och blockeringar i processminnet;
- skickar aldrig mejl och rör aldrig Azure;
- visar en tydlig demobanner i gränssnittet.

Porten kan ändras med `ADMIN_PORT`:

```powershell
$env:ADMIN_PORT = "3005"; npm run admin:dev
```

## 2. Sidor och API:er

| Route | Beskrivning |
|---|---|
| `/admin` | Dashboard med nya förfrågningar, kommande bokningar, värde, åtgärder samt närmaste in- och utcheckning |
| `/admin/bookings` | Bokningslista med sökning, statusfilter, datumintervall och sortering |
| `/admin/bookings/new` | Manuell bokning eller ren datumblockering (Owner) |
| `/admin/bookings/:reference` | Bokningsdetaljer med gäst, vistelse, tillval, prissnapshot, mejlstatus, åtgärder, anteckningar och auditlogg |
| `/admin/calendar` | Månadskalender med bekräftade bokningar, manuella block, förfrågningar och preliminära bokningar |
| `/healthz` | Publik, datalös health check |

Alla `/api/admin/*` kräver autentisering och administratörsroll. Alla
skrivningar kräver dessutom Owner, CSRF-token och (där det är relevant)
ETag/`If-Match`.

Easy Auth kontrollerar Referer för cookie-autentiserade POST/PATCH/DELETE.
Därför använder portalen `Referrer-Policy: same-origin` och skickar
`referrerPolicy: 'same-origin'` i fetch. `no-referrer` gav annars
`403` med substatus 60 innan appens egen CSRF-kontroll kördes.

| Metod | Endpoint | Beskrivning |
|---|---|---|
| GET | `/api/admin/session` | Användare, roller, CSRF-token, datakälla och skrivläge |
| GET | `/api/admin/dashboard` | Dashboarddata |
| GET | `/api/admin/bookings` | Lista med `q`, `status`, `from`, `to`, `sort`, `dir` |
| GET | `/api/admin/bookings/:reference` | En bokning |
| GET | `/api/admin/bookings/:reference/history` | Append-only auditlogg |
| GET | `/api/admin/bookings/:reference/quote.pdf` | Servergenererad PDF-offert; alla bokningar utom datumblockeringar |
| GET | `/api/admin/bookings/:reference/confirmation.pdf` | PDF-bokningsbekräftelse; endast `CONFIRMED` |
| POST | `/api/admin/bookings` | Manuell bokning; `Idempotency-Key` krävs |
| POST | `/api/admin/bookings/:reference/status` | `approve`, `preliminary`, `decline`, `confirm`, `cancel`; ETag |
| POST | `/api/admin/bookings/:reference/notes` | Intern anteckning; ETag |
| PATCH | `/api/admin/bookings/:reference/addons` | Nya tillval med ny prisberäkning; ETag + orsak |
| PATCH | `/api/admin/bookings/:reference/payment` | Betalstatus och mottaget belopp; ETag |
| GET | `/api/admin/calendar?from=YYYY-MM` | Intern kalender och mjuka överlägg |
| POST | `/api/admin/calendar/blocks` | Blockera datum utan gästuppgifter; `Idempotency-Key` |
| DELETE | `/api/admin/calendar/blocks/:reference` | Avblockera; ETag via `If-Match` |

## 3. Automatiska bokningsförfrågningar

Den publika sidan använder redan `POST /api/booking-requests`. Servern:

1. kontrollerar kill switch, publicerade regler, durabel lagring,
   idempotens, rate limit, fält och tillgänglighet;
2. räknar priset på servern med `shared/pricing-config.json`;
3. sparar en `request`-post med `statusCode = PENDING`,
   `bookingSource = WEB`, unik referens, tidsstämpel, gästuppgifter, alla
   tillval, rabatt, totalpris och prissnapshot;
4. skriver två utkorgsposter med `mailType = HOST_NEW_REQUEST` och
   `GUEST_REQUEST_ACK`, kopplade till bokningens referens.

Portalen läser samma `request`-partition via managed identity och visar
förfrågan automatiskt. Ingen import behövs. En förfrågan är aldrig en
bekräftad bokning och blockerar därför inga datum.

## 4. Manuell bokning

`/admin/bookings/new` är Owner-only och registrerar:

- gästens namn, e-post, telefon och företag;
- incheckning, utcheckning och gästantal;
- källa: Telefon, E-post, Airbnb, Direkt eller Annat;
- alla befintliga tillval med antal och pris;
- status vid skapandet: bekräftad, preliminär eller inväntar godkännande;
- avtalat totalpris med obligatorisk ändringsorsak;
- betalstatus och mottaget belopp;
- intern anteckning.

Servern räknar alltid en prisoffert med samma regler som hemsidan. Det
serverberäknade priset sparas som `calculatedTotal`; om Owner anger ett
avtalat pris sparas det som `total` tillsammans med orsaken. Vid senare
tillvalsändring sparas den ursprungliga prisbilden i `originalPricing` så att
historiken aldrig räknas om automatiskt.

Samma formulär kan växla till **ren datumblockering**. Då krävs inga
gästuppgifter, ingen gästmejl skapas och blockeringen får referens `BLOCK-…`.

### PDF-offert och bokningsbekräftelse

Bokningsdetaljen har knappar för att ladda ned två servergenererade
A4-dokument. PDF:erna skapas med PDFKit på servern och använder den befintliga
logotypen i `public/images/logo.png`. Ingen bokningsdata ändras och inga
publika länkar skapas.

- **Offert** kan skapas för alla bokningar utom datumblockeringar. Offertnumret
  är `OFF-` följt av bokningsreferensen. Offerten visar att den inte är en
  bekräftad bokning och låser inga datum.
- **Bokningsbekräftelse** kan endast skapas för `CONFIRMED`. För `PENDING`,
  `DECLINED`, `BLOCKED` och `CANCELLED` svarar API:et `409` med
  `CONFIRMATION_REQUIRES_CONFIRMED`.

Priserna hämtas från bokningens sparade prissnapshot. Finns ett avtalat pris
visas det som totalpris tillsammans med det beräknade priset. Rabatt visas
endast som en separat informationsrad när den redan är avdragen från
boendepriset. Betalningar och återstående belopp visas endast i
bokningsbekräftelsen. Dokumenten kräver samma Microsoft Entra-inloggning som
övriga admin-API:er och är tillgängliga för Owner och Staff.

## 5. Status, kalender och samtidighet

| Status | Blockerar datum |
|---|---:|
| Inväntar godkännande (`PENDING`) | Nej |
| Preliminär (`PRELIMINARY`) | Nej |
| Bekräftad (`CONFIRMED`) | Ja |
| Avbokad (`CANCELLED`) | Nej, kalenderrader tas bort |
| Nekad (`DECLINED`) | Nej |
| Blockerad (`BLOCKED`) | Ja, manuell datumblockering |

Vid bekräftelse kontrolleras:

1. interna kalenderrader,
2. andra bekräftade bokningar och blockeringar,
3. Airbnb iCal (om konfigurerad och kontrollen är påslagen).

Därefter skapas en kalenderrad per natt med `If-None-Match: *`. Två samtidiga
bekräftelser kan därför aldrig båda lyckas för samma natt. Om en rad i en
flernattsbokning krockar rullas redan skapade rader tillbaka. Bokningen
uppdateras sedan med ETag/`If-Match`; vid konflikt returneras `409` och
kalenderraderna rullas tillbaka.

Airbnb iCal är en fördröjd export, inte realtidssynkronisering. En intern
bekräftelse skyddar därför alltid mot interna dubbletter, men Airbnb måste
fortfarande blockeras manuellt efter bekräftelse.

## 6. Föreslagen Azure-konfiguration

| Inställning | Värde |
|---|---|
| App Service | `hemsida-skadevi-admin-prod` |
| Resursgrupp | `rg-skadevi-prod` |
| Plan | Befintlig `asp-skadevi-prod`, Linux B1, Sweden Central |
| Runtime | Node 22 LTS |
| Startkommando | `node server/admin/index.js` |
| Always On | Ja |
| Health check | `/healthz` |
| HTTPS | Endast HTTPS, TLS 1.2, HTTP/2, FTPS av |
| Managed identity | System-assigned |
| Tabellroll | `Storage Table Data Reader` endast på `bookingrequests` (Contributor först vid aktivering) |
| Key Vault | Ingen åtkomst i detta steg; före aktiverad Airbnb-kontroll krävs snäv läsroll på `airbnb-ical-url` |
| Custom domain | `bokning.skadeviherrgard.com` först efter DNS-cutover |

Den fristående mallen `infra/admin-webapp.bicep` skapar appen, managed
identity, läsrollen på tabellen och en `Website Contributor`-roll för den
befintliga GitHub Actions-identiteten, begränsad till den nya adminappen.
Den deployas inte av `infra/main.bicep` och körs inte automatiskt.
`infra/admin-webapp.bicepparam` innehåller samma värden utan hemligheter.

Mallen sätter `ADMIN_TRUST_EASY_AUTH=1`. Appen fail-closed om Easy Auth inte
är aktiverad och verifierad; den startar då inte. Aktivera därför Easy Auth
innan appkoden startas, eller sätt parametern till `0` tillfälligt.

## 7. Exakta steg i Azure Portal

### 7.1 Entra-appregistrering

1. Gå till **Microsoft Entra admin center → App registrations → New
   registration**.
2. Namn: `Skadevi Admin`.
3. Supported account types: **Accounts in this organizational directory only
   (single tenant)**.
4. Redirect URI: **Web** och
   `https://hemsida-skadevi-admin-prod.azurewebsites.net/.auth/login/aad/callback`.
   Lägg senare till `https://bokning.skadeviherrgard.com/.auth/login/aad/callback`.
5. Registrera och notera **Application (client) ID** och **Directory (tenant)
   ID**.

### 7.2 Approller

Skapa två approller, antingen via **App roles → Create app role** eller i
manifestet:

```json
"appRoles": [
  {
    "allowedMemberTypes": ["User"],
    "description": "Full administratörsbehörighet",
    "displayName": "Owner",
    "id": "<unikt GUID>",
    "isEnabled": true,
    "value": "Owner"
  },
  {
    "allowedMemberTypes": ["User"],
    "description": "Operativ personalbehörighet",
    "displayName": "Staff",
    "id": "<unikt GUID>",
    "isEnabled": true,
    "value": "Staff"
  }
]
```

Använd unika GUID:n. Rollerna måste heta exakt `Owner` och `Staff` eftersom
servern kontrollerar dessa värden.

### 7.3 Klienthemlighet

1. **Certificates & secrets → Client secrets → New client secret**.
2. Välj kortaste rimliga livslängd och dokumentera förfallodatum.
3. Kopiera secret-värdet en gång. Det ska endast anges i App Service
   Authentication, aldrig i repo, Bicep, frontend eller appinställningar.
4. Planera rotation innan det går ut.

### 7.4 Assignment required och användare

1. Gå till **Enterprise applications → Skadevi Admin → Properties**.
2. Sätt **Assignment required?** till **Yes**.
3. Gå till **Users and groups → Add user/group**.
4. Tilldela endast uttryckligen godkända personer/grupper och välj rätt
   approll (`Owner` eller `Staff`).
5. Skapa inga användare automatiskt. En borttagen gruppmedlem förlorar
   åtkomst vid nästa inloggning.

### 7.5 MFA

Välj en av följande:

- **Security Defaults** (kostnadsfritt): aktiverar MFA för alla användare.
- **Conditional Access** (kräver Entra ID P1): ny policy som riktar sig mot
  admin-gruppen och appen `Skadevi Admin`, med **Require multifactor
  authentication** och sedan **On**.

MFA ska gälla för alla konton som kan nå adminportalen.

### 7.6 Skapa admin-App Service

1. Skapa en ny **Web App** i `rg-skadevi-prod`, namn
   `hemsida-skadevi-admin-prod`.
2. Välj **Publish: Code**, **Runtime stack: Node 22 LTS**, **Operating
   System: Linux**, **Region: Sweden Central**.
3. Välj den befintliga planen `asp-skadevi-prod` (B1).
4. Slå på **HTTPS Only**, **Always On**, HTTP/2 och stäng av FTPS.
5. Sätt **Health check path** till `/healthz`.
6. Under **Configuration → General settings**, sätt **Startup Command** till
   `node server/admin/index.js`.
7. Slå på **Identity → System assigned → On** och spara. Notera
   principal-ID.

### 7.7 Tabelläsbehörighet

1. Gå till lagringskontot `stskadevibokningprod`.
2. **Access Control (IAM) → Add role assignment**.
3. Välj **Storage Table Data Reader**.
4. Scope: den enskilda tabellen `bookingrequests` — inte lagringskontot,
   resursgruppen eller prenumerationen.
5. Tilldela adminappens system-assigned managed identity.

Använd **inte** `Storage Table Data Contributor` i denna read-only version.
Roll-ID för Reader är `76199698-9eea-4c19-bc75-cec21354c6b6`.

### 7.8 App Service Authentication (Easy Auth)

1. Gå till adminappen → **Settings → Authentication**.
2. **Add identity provider → Microsoft**.
3. Välj **Existing app registration** och ange client ID, tenant-ID och den
   klienthemlighet som skapades i 4.3.
4. Issuer: `https://login.microsoftonline.com/<tenant-id>/v2.0`.
5. Kräv autentisering för alla förfrågningar.
6. Oautentiserade webbläsaranrop: **HTTP 302 – redirect to login**.
7. Under **Excluded paths**, lägg endast till `/healthz` så att App Service
   health check fungerar. Inga andra undantag.
8. Spara och kontrollera att `/.auth/login/aad` fungerar.

När Easy Auth är aktiv sätter App Service `WEBSITE_AUTH_ENABLED=True` och
`WEBSITE_AUTH_DEFAULT_PROVIDER=AzureActiveDirectory`. Servern kräver dessutom
den explicita appinställningen `ADMIN_TRUST_EASY_AUTH=1`. Utan båda delarna
startar inte portalen. Detta förhindrar att `X-MS-CLIENT-PRINCIPAL` litas på
i ett läge där Easy Auth inte är tvingande.

### 7.9 Appinställningar

Lägg till följande i adminappen:

```text
NODE_ENV=production
ADMIN_DATA_SOURCE=table
AZURE_STORAGE_ACCOUNT_NAME=stskadevibokningprod
AZURE_TABLE_NAME=bookingrequests
ADMIN_TRUST_EASY_AUTH=1
ADMIN_WRITES_ENABLED=0
ADMIN_MAIL_OUTBOX_ENABLED=0
ADMIN_REQUIRE_AIRBNB_CHECK=1
```

`ADMIN_WRITES_ENABLED=0` är avsiktligt i detta steg. Skrivningarna aktiveras
först när tabellrollen har uppgraderats och skrivfunktionerna granskats.
`ADMIN_MAIL_OUTBOX_ENABLED=0` innebär att inga nya bekräftelsemejl köas från
portalen. Ändra inte dessa värden i Azure som en del av detta steg.

Lägg inte till `AZURE_STORAGE_KEY`, `AZURE_STORAGE_CONNECTION_STRING` eller
Resend-nycklar. Adminappen ska inte ha Key Vault-åtkomst för mejl.

**Viktigt före aktivering av bekräftelse:** `ADMIN_REQUIRE_AIRBNB_CHECK=1`
innebär att adminappen måste kunna läsa `AIRBNB_ICAL_URL` (i Azure en
Key Vault-referens till `airbnb-ical-url`). Det kräver en separat, snäv
`Key Vault Secrets User`-roll på just det secretet för adminappens managed
identity. Rollen får inte läggas till i detta steg. Utan åtkomst svarar
bekräftelse `503` (fail closed), vilket är avsiktligt.

### 7.10 Publicera koden

Publicera endast adminappens paket:

- `server/admin/`
- nödvändiga delar av `server/booking/` och `server/calendar/`
- `shared/`
- `public/fonts/` och `public/images/logo.png` om de inte redan ingår i
  adminappens statiska servering
- `package.json` och produktionsberoenden

Startkommandot ska vara `node server/admin/index.js`, inte den publika
serverns `npm start`. Den publika appen och dess deployment ska inte ändras.
Använd inte den publika deploy-workflowen mot adminappen; använd den separata,
manuellt godkända `.github/workflows/deploy-admin.yml` när appen finns.

Bygg och verifiera paketet lokalt:

```powershell
npm run package:admin
npm run smoke:admin
```

Paketet hamnar i `package-admin/`, innehåller endast adminens serverfiler,
`store.js`, `pricing.js`, nödvändiga statiska resurser och `shared/`. Det
innehåller inte den publika sajten, Resend/Logic App-koden eller hemligheter.

## 8. Datakälla, skrivningar och verkliga bokningar

Adminappen använder `server/admin/repository/table.js`:

- managed identity och Bearer-token, aldrig lagringsnycklar;
- läser `PartitionKey = 'request'`, `outbox`, `calendar` och `history`;
- skriver med `POST`, `PUT` och `DELETE` endast när skrivläget är aktiverat;
- använder ETag/`If-Match` för bokningar och `If-None-Match: *` för
  kalenderrader;
- max 1 000 rader per fråga, sedan filtrering/sortering i serverminnet;
- priser läses från den sparade prisöversikten och räknas aldrig om vid visning;
- inga data cachas publikt; alla svar är `Cache-Control: no-store`;
- webbläsaren har ingen direktåtkomst till Table Storage.

Demo och produktion är separerade. `ADMIN_DATA_SOURCE=table` krävs i
produktion, och `createAdminRepository` vägrar demoläget när
`NODE_ENV=production`. Demodata kan därför inte visas som riktiga bokningar.

Tabellrollen är fortfarande **Storage Table Data Reader**. Skrivningarna
fungerar lokalt/demo och är kodkompletta, men i Azure svarar de `503` tills
`ADMIN_WRITES_ENABLED=1` sätts. Innan dess ska rollen uppgraderas till
**Storage Table Data Contributor** på tabellen `bookingrequests` och
skrivfunktionerna granskas. Ingen rolländring görs i detta steg.

Kända schemaglapp för äldre verklig data:

- befintliga `outbox`-poster kan sakna `reference`/`mailType`, så mejlstatus
  kan visas som okänd för historiska poster. Nya poster skriver båda fälten.
- riktiga äldre poster kan sakna `latestNote`, `statusCode` och
  betalningsfält. De mappas i läsvyn; nya poster skriver fälten.

## 9. Roller och behörigheter

| Roll | Behörighet i denna version |
|---|---|
| Owner | Läsa allt samt skapa manuella bokningar, godkänna, neka, bekräfta, avboka, ändra tillval, anteckna, ändra betalstatus och blockera/avblockera |
| Staff | Läsa dashboard, lista, detaljer, kalender och auditlogg |

Servern kontrollerar rollen i API-koden. Alla skrivningar kräver `Owner`
oavsett vad gränssnittet visar. Staff får `403`.

## 10. Säkerhetsverifiering efter publicering

Gör följande kontroller innan skrivningarna aktiveras:

1. `https://hemsida-skadevi-admin-prod.azurewebsites.net/admin` utan
   inloggning ska skicka till Microsoft-inloggning, inte visa data.
2. `/api/admin/bookings` utan inloggning ska inte returnera JSON-data.
3. Skicka en påhittad `X-MS-CLIENT-PRINCIPAL`-header till en oautentiserad
   förfrågan. App Service ska ta bort/ersätta den och begäran ska inte få
   åtkomst. Om data returneras ska appen stoppas omedelbart.
4. Logga in som Owner: dashboard, lista, ny bokning, kalender och detaljer
   ska fungera.
5. Logga in som Staff: läsning ska fungera, men alla skrivningar ska ge `403`.
6. Kontrollera att `/healthz` är den enda publika rutten och att inga andra
   `excludedPaths` finns.
7. Kontrollera att adminappens managed identity endast har den roll som
   uttryckligen beslutats för tabellen.
8. Kontrollera att `X-Robots-Tag: noindex`, `Cache-Control: no-store`,
   CSP och HTTPS/HSTS finns.
9. Med `ADMIN_WRITES_ENABLED=0` ska alla skriv-API:er svara `503` och inga
   riktiga bokningar ändras.
10. Efter uppgradering till Contributor: verifiera i en testtabell att
    samtidiga bekräftelser ger exakt en lyckad och en `409`, samt att
    avblockering endast tar bort rätt boknings kalenderrader.

## 11. Kostnad och påverkan på B1-planen

Befintlig plan är Linux B1 med en worker: 1 kärna och 1,75 GB minne.
Publika appen körs med Always On. En andra lågtrafikerad Node-app på samma
plan delar kärna och minne.

Bedömning:

- Ingen extra App Service-plan behöver betalas; planen faktureras redan.
- Tillkommande kostnad är i praktiken lagringsloggar, egress och marginell
  statistik, normalt några kronor till ett par tiotal kronor per månad.
- En egen B1-plan skulle kosta ungefär 130–140 kr/månad extra och ge
  starkare resursisolering. Det rekommenderas inte för första versionen.
- Overvaka **CPU Percentage** och **Memory Percentage** för planen efter
  publicering. Om belastningen varaktigt närmar sig 70 % eller den publika
  appens svarstider försämras, flytta adminappen till en egen plan.

Portalen är read-only och har mycket låg trafik jämfört med den publika
sajten. Risken för överbelastning bedöms som låg, men B1 är en enda instans
och ska övervakas.

## 12. Domän och HTTPS

Ingen DNS-ändring får göras ännu. Under överföringen från Wix till GoDaddy
ska portalen testas via den skyddade `azurewebsites.net`-adressen.

När överföringen är klar och DNS-ändringen godkänts:

1. Skapa `CNAME bokning → hemsida-skadevi-admin-prod.azurewebsites.net`.
2. Lägg till TXT `asuid.bokning` med appens `customDomainVerificationId`.
3. Lägg till hostname i App Service.
4. Skapa ett gratis managed certificate för `bokning.skadeviherrgard.com`.
5. Bind certifikatet med SNI och kontrollera HTTPS.
6. Lägg till redirect-URI:n
   `https://bokning.skadeviherrgard.com/.auth/login/aad/callback` i
   Entra-appregistreringen.
7. Uppdatera vid behov appens issuer/redirect och testa inloggningen igen.

`www`, apex och e-post påverkas inte av enbart en `bokning`-CNAME. Hela
DNS-zonen ska inte flyttas som en del av denna publicering.

## 13. Vad som medvetet inte är aktiverat

- Azure-skrivningar: kod finns men `ADMIN_WRITES_ENABLED=0` tills rollen är
  uppgraderad och granskad.
- Mejlutskick från portalen: `ADMIN_MAIL_OUTBOX_ENABLED=0`; ingen
  bekräftelsemejl köas utan uttryckligt val.
- Logic Apps, `BOOKING_REQUESTS_ENABLED`, DNS och custom domain.
- Betalintegration, fakturering och automatisk återbetalning; betalstatus
  registreras manuellt.
- Ändring av bekräftad boknings datumintervall; använd avbokning + ny bokning.
- Riktiga bokningar i demodata.

## 14. Filer

```text
server/admin/                 admin-server, auth, domän, vyer och demorepository
server/admin/booking-service.js manuella bokningar, status, block, audit
server/admin/repository/table.js Table Storage läs/skriv med managed identity
server/admin/public/          admin-CSS och browser-JS
infra/admin-webapp.bicep      förberedd app, Reader/Contributor och Key Vault-scope
infra/admin-webapp.bicepparam normalläge utan skrivningar
infra/admin-webapp-activation.bicepparam förberedd aktivering, deployas inte ännu
scripts/integration-admin-booking-test.mjs fokuserat skriv-/kalendertest
scripts/package-admin.mjs      separat publiceringspaket för adminappen
scripts/smoke-admin-package.mjs minimal paketkontroll
.github/workflows/deploy-admin.yml manuellt godkänd adminpublicering
tests/unit/admin-portal.test.js
docs/bokningsportal.md
```

## 15. Kontroller

```powershell
npm run lint
npm test
npm run build
npm run package:admin
npm run smoke:admin
```

Den publika webbplatsen, kalendern och prisberäkningen är oförändrade. Inga
nya npm-beroenden har lagts till för portalen.

## 16. Aktiverade manuella bokningar

Aktiverat 2026-11-12 i produktion:

- adminidentiteten har `Storage Table Data Contributor` på endast `bookingrequests`
- adminidentiteten har `Key Vault Secrets User` på endast `airbnb-ical-url`
- den överflödiga Reader-tilldelningen är borttagen
- `ADMIN_WRITES_ENABLED=1`
- `ADMIN_MAIL_OUTBOX_ENABLED=0`
- `ADMIN_REQUIRE_AIRBNB_CHECK=1`
- `AIRBNB_ICAL_URL` är en Key Vault-referens, inte ett värde i Git
- appen lyssnar på port `8080` via `ADMIN_PORT` och `WEBSITES_PORT`
- adminpaketet är självständigt och innehåller endast produktionsberoenden

Aktiveringsmallen `infra/admin-webapp-activation.bicepparam` finns kvar för
reproducerbarhet. Normalläget i `admin-webapp.bicep` är fortfarande
`enableBookingWrites=false` som säkert standardvärde.

Vid aktivering (`enableBookingWrites=true`) skapas/ändras exakt:

| Åtgärd | Resurs/scope | Roll/värde |
|---|---|---|
| Skapa | Tabellen `bookingrequests` | `Storage Table Data Contributor` för adminidentiteten `1bb634ef-cc05-4161-a85f-b8caddaee4d8` |
| Skapa | Secret `kv-skadevi-prod/secrets/airbnb-ical-url` | `Key Vault Secrets User` för samma identitet |
| Ta bort | Tabellen `bookingrequests` | Reader-tilldelningen `f5171663-e1f3-58d8-afe4-f27997c50345` när Contributor verifierats |
| Ändra | Adminappens inställningar | `ADMIN_WRITES_ENABLED=1` |
| Lägg till | Adminappens inställningar | `AIRBNB_ICAL_URL=@Microsoft.KeyVault(SecretUri=https://kv-skadevi-prod.vault.azure.net/secrets/airbnb-ical-url/)` |
| Oförändrat | Adminappens inställningar | `ADMIN_MAIL_OUTBOX_ENABLED=0`, `ADMIN_REQUIRE_AIRBNB_CHECK=1` |

Roll-ID:n i Skadevis tenant:

- Storage Table Data Contributor: `0a9a7e1f-b9d0-4cc4-a60d-0319b160aaa3`
- Storage Table Data Reader: `76199698-9eea-4c19-bc75-cec21354c6b6`
- Key Vault Secrets User: `4633458b-17de-408a-b874-0445c86b69e6`

Secretvärdet läses aldrig ut i Git. `AIRBNB_ICAL_URL` är en Key Vault-referens
utan versionsnummer; endast secretnamnet finns i mallen.

### Airbnb-kontroll

Vid bekräftelse hämtas iCal-adressen färskt vid varje försök (max 5 sekunder).
Timeout, nätverksfel, ogiltig URL, för stor fil eller tolkningsfel ger `503`
och bokningen förblir obekräftad. Ett misslyckat uppslag tillåter alltså aldrig
en dubbelbokning. iCal är fortfarande fördröjd och ersätter inte intern
kalenderlåsning.

### Egen Airbnb-blockering

Om Owner själv har blockerat datumen i Airbnb kan detta anges i formuläret
Ny bokning. Portalen gör då fortfarande en färsk Airbnb-kontroll. Visar Airbnb
upptagna datum krävs:

1. en tydlig varning med de upptagna nätterna,
2. aktiv bekräftelse från Owner,
3. en kort motivering.

Först då sparas bokningen med `airbnbOverride`, motivering, godkännare,
tidpunkt och de blockerade nätterna. En separat auditpost
`AIRBNB_OVERRIDE_APPROVED` skrivs. Åsidosättningen gäller endast Airbnb;
interna kalenderlås och andra bekräftade bokningar blockeras alltid. Ett
tekniskt fel i Airbnb-kalendern ger `503` och kan aldrig åsidosättas.

Samma `Idempotency-Key` återanvänds vid override och omförsök. Om bokningen
redan sparades av ett tidigare försök återanvänds den i stället för att en
dubblett skapas.

### Fokuserat test

```powershell
# Tjänstelogik med Table-lika create-only/ETag-regler, utan Azure-åtkomst:
$env:ADMIN_TEST_REPO = 'memory'
node scripts/integration-admin-booking-test.mjs

# Live mot isolerad testtabell med Azure CLI-token och tillfällig
# Storage Table Data Contributor på bookingrequeststest:
$env:ADMIN_TEST_STORAGE_TOKEN = az account get-access-token --resource https://storage.azure.com/ --query accessToken -o tsv
node scripts/integration-admin-booking-test.mjs
```

Lagringskontot har `allowSharedKeyAccess=false`, så live-testet kräver en
dataplansroll på `bookingrequeststest`. Testet städar endast de egna raderna
och vägrar alla andra tabeller/konton. I steg 8M kördes 26/26 kontroller live
mot `bookingrequeststest`; den tillfälliga rollen togs bort efteråt.

## 17. Administrativa varningar och hanterade undantag

Bokningsdetaljen visar tre nivåer:

- **Kräver åtgärd** för verkliga, olösta problem.
- **Behöver kontrolleras** när uppgifterna inte kan verifieras.
- **Hanterad** för varningar som Owner uttryckligen har godkänt eller kvitterat.

Varje varning har en rekommendation. Owner kan **Kontrollera igen** och, när
varningen är kvitteringsbar, **Markera som hanterad** med obligatorisk
motivering. Staff kan läsa varningarna men får `403` på båda åtgärderna.

Kvitteringar sparas på bokningen som `warningAcknowledgements` med vem, när,
vilken varning och ett fingeravtryck av datum, status, källa och varningsdata.
Ändras relevanta uppgifter slutar kvitteringen att gälla och varningen blir
olöst igen. En kvittering ändrar aldrig bokningens status, datum, pris,
betalning eller interna kalenderlås.

Airbnb-kontrollen sparar `airbnbVerification`. Endast en lyckad läsning som
visar att alla nätter är blockerade får sätta `airbnbBlockedAt`. Okänd eller
tillgänglig kalender visas som okänd/tillgänglig, aldrig som verifierat OK.
Ett godkänt Airbnb-undantag visas som **Hanterad** med godkännare, tid och
motivering, men beskrivs uttryckligen som ett administrativt godkännande och
inte som bevis på blockering. Ett nytt eller ändrat underlag ger en ny varning.

Interna kalenderkonflikter, intern dubbelbokning, saknad intern kalenderlåsning,
saknad betalning och väntande förfrågningar är inte kvitteringsbara. De måste
åtgärdas i sak.

API:

```text
POST /api/admin/bookings/:reference/warnings/recheck
POST /api/admin/bookings/:reference/warnings/acknowledge
```

Båda kräver Owner, CSRF och ETag. Recheck är endast implementerad för
Airbnb-varningar i detta steg. Auditloggen får `WARNING_RECHECKED` respektive
`WARNING_ACKNOWLEDGED`.

Fokuserade tester finns i `tests/unit/admin-warnings.test.js`.

## 18. Kort, Swish (avstängt) och faktura – Owner bekräftar först

Betalningsflödet följer affärsmodell A och erbjuder just nu kort eller faktura:

1. Gästen skickar en bokningsförfrågan.
2. Owner godkänner och bekräftar bokningen. Först då finns giltig intern
   kalenderlåsning.
3. Owner skapar en personlig betalningssida från bokningsdetaljen. Länken kan
   kopieras eller skickas via utkorgen. En ny länk ogiltiggör den gamla.
4. Gästen öppnar `/betala/<token>` och väljer **Betala med kort** eller
   **Begär faktura**.
5. Kort startar Stripe Checkout med dynamiska betalmetoder filtrerade till
   `card` och valutan `sek`. Swish, Klarna och banköverföring kan inte visas.
6. Stripes signerade webhook registrerar betalningen som `CARD` i
   betalningsliggaren. Bokningens status ändras aldrig automatiskt.
7. Fakturabegäran sparas som `Begärd` och hanteras manuellt av Owner. Den
   markerar aldrig bokningen som betald.

Swish finns kvar bakom `STRIPE_SWISH_ENABLED=0` och kan aktiveras senare när
Stripe har aktiverat metoden för kontot.

Endast `CONFIRMED` med giltig kalenderlåsning får en betalningssida.
`PRELIMINARY` och `PENDING` nekas. Avbokning, nekande eller prisändring
återkallar länken och makulerar öppna fakturabegäranden.

Admin-API:

```text
POST  /api/admin/bookings/:reference/payment-link
POST  /api/admin/bookings/:reference/payment-link/revoke
PATCH /api/admin/bookings/:reference/invoice-requests/:id
```

Kräver Owner, CSRF och valfri ETag via `If-Match` eller `expectedEtag`.

Publik betalningssida:

```text
GET  /betala/:token
POST /api/payments/:token/card
POST /api/payments/:token/swish            # endast med Swish-flaggan
POST /api/payments/:token/invoice-request
POST /api/stripe/webhook
```

Token är kryptografiskt säker, har begränsad giltighetstid och kan återkallas.
Endast en hash av token sparas. Webhooken verifierar HMAC-signatur, belopp,
valuta, referens, Stripe-session och test/live-läge, och är idempotent per
session.

Betalningar är inaktiverade som standard i produktion:

```text
STRIPE_ENABLED=0            # master för betalningssidor och digital betalning
STRIPE_CARD_ENABLED=1       # kort när master är på
STRIPE_SWISH_ENABLED=0      # Swish avstängt
STRIPE_WEBHOOK_ENABLED=0    # publik app: ta emot webhooks
STRIPE_ALLOW_LIVE=0         # blockerar sk_live_/rk_live_ utan godkännande
```

Se `docs/stripe-betalning.md` för testläge, kort/Swish-inställningar,
fakturastatus, aktivering och säkerhetsregler. Fokuserade tester finns i
`tests/unit/stripe.test.js`, `tests/unit/stripe-webhook.test.js`,
`tests/unit/payment-page.test.js` och
`tests/unit/admin-stripe-payment-link.test.js`.
