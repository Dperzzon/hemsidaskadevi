# Skadevi Bokningsportal — lokal demo och Azure-förberedelse

Portalen är en separat, read-only administrationsapp. Den ändrar inte den
publika webbplatsen, prisberäkningen, Azure-resurserna, DNS eller några
riktiga bokningar. Detta dokument beskriver både den lokala demon och den
förberedda produktiondriftsättningen.

## 1. Starta demon

```powershell
npm ci --no-audit --no-fund
npm run admin:dev
```

Öppna `http://localhost:3001/admin`.

Demoläget:

- använder endast syntetiska bokningar med referenser som börjar på `DEMO-`;
- kräver ingen Azure-åtkomst och inga hemligheter;
- är read-only; inga statusändringar, mejl eller lagringsskrivningar görs;
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
| `/admin/bookings/:reference` | Bokningsdetaljer med gäst, vistelse, tillval, prissnapshot, mejlstatus och anteckningar |
| `/healthz` | Publik, datalös health check |

Alla `/api/admin/*` kräver autentisering och administratörsroll:

| Metod | Endpoint | Beskrivning |
|---|---|---|
| GET | `/api/admin/session` | Användare, roller, CSRF-token, datakälla |
| GET | `/api/admin/dashboard` | Dashboarddata |
| GET | `/api/admin/bookings` | Lista med `q`, `status`, `from`, `to`, `sort`, `dir` |
| GET | `/api/admin/bookings/:reference` | En bokning |
| POST | `/api/admin/bookings/:reference/status` | Förberett kontrakt; kräver CSRF och Owner för confirm/cancel. Svarar alltid 503 och skriver inget i denna version. |

## 3. Föreslagen Azure-konfiguration

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
| Tabellroll | `Storage Table Data Reader` endast på `bookingrequests` |
| Key Vault | Ingen åtkomst behövs för adminappen |
| Custom domain | `bokning.skadeviherrgard.com` först efter DNS-cutover |

Den fristående mallen `infra/admin-webapp.bicep` skapar appen, managed
identity och läsrollen på tabellen. Den deployas inte av `infra/main.bicep`
och körs inte automatiskt. `infra/admin-webapp.bicepparam` innehåller samma
värden utan hemligheter.

Mallen sätter `ADMIN_TRUST_EASY_AUTH=1`. Appen fail-closed om Easy Auth inte
är aktiverad och verifierad; den startar då inte. Aktivera därför Easy Auth
innan appkoden startas, eller sätt parametern till `0` tillfälligt.

## 4. Exakta steg i Azure Portal

### 4.1 Entra-appregistrering

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

### 4.2 Approller

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

### 4.3 Klienthemlighet

1. **Certificates & secrets → Client secrets → New client secret**.
2. Välj kortaste rimliga livslängd och dokumentera förfallodatum.
3. Kopiera secret-värdet en gång. Det ska endast anges i App Service
   Authentication, aldrig i repo, Bicep, frontend eller appinställningar.
4. Planera rotation innan det går ut.

### 4.4 Assignment required och användare

1. Gå till **Enterprise applications → Skadevi Admin → Properties**.
2. Sätt **Assignment required?** till **Yes**.
3. Gå till **Users and groups → Add user/group**.
4. Tilldela endast uttryckligen godkända personer/grupper och välj rätt
   approll (`Owner` eller `Staff`).
5. Skapa inga användare automatiskt. En borttagen gruppmedlem förlorar
   åtkomst vid nästa inloggning.

### 4.5 MFA

Välj en av följande:

- **Security Defaults** (kostnadsfritt): aktiverar MFA för alla användare.
- **Conditional Access** (kräver Entra ID P1): ny policy som riktar sig mot
  admin-gruppen och appen `Skadevi Admin`, med **Require multifactor
  authentication** och sedan **On**.

MFA ska gälla för alla konton som kan nå adminportalen.

### 4.6 Skapa admin-App Service

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

### 4.7 Tabelläsbehörighet

1. Gå till lagringskontot `stskadevibokningprod`.
2. **Access Control (IAM) → Add role assignment**.
3. Välj **Storage Table Data Reader**.
4. Scope: den enskilda tabellen `bookingrequests` — inte lagringskontot,
   resursgruppen eller prenumerationen.
5. Tilldela adminappens system-assigned managed identity.

Använd **inte** `Storage Table Data Contributor` i denna read-only version.
Roll-ID för Reader är `76199698-9eea-4c19-bc75-cec21354c6b6`.

### 4.8 App Service Authentication (Easy Auth)

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

### 4.9 Appinställningar

Lägg till följande i adminappen:

```text
NODE_ENV=production
ADMIN_DATA_SOURCE=table
AZURE_STORAGE_ACCOUNT_NAME=stskadevibokningprod
AZURE_TABLE_NAME=bookingrequests
ADMIN_TRUST_EASY_AUTH=1
```

Lägg inte till `AZURE_STORAGE_KEY`, `AZURE_STORAGE_CONNECTION_STRING` eller
Resend-nycklar. Adminappen ska inte ha Key Vault-åtkomst.

### 4.10 Publicera koden

Publicera endast adminappens paket:

- `server/admin/`
- nödvändiga delar av `server/booking/` och `server/calendar/`
- `shared/`
- `public/fonts/` och `public/images/logo.png` om de inte redan ingår i
  adminappens statiska servering
- `package.json` och produktionsberoenden

Startkommandot ska vara `node server/admin/index.js`, inte den publika
serverns `npm start`. Den publika appen och dess deployment ska inte ändras.
Använd inte den publika deploy-workflowen mot adminappen; skapa en separat,
manuellt godkänd admin-workflow när appen finns.

## 5. Datakälla och verkliga bokningar

Adminappen använder `server/admin/repository/table.js`:

- managed identity och Bearer-token, aldrig lagringsnycklar;
- endast `GET`-anrop;
- `PartitionKey = 'request'` samt metadata från `outbox`;
- max 1 000 rader per fråga, sedan filtrering/sortering i serverminnet;
- priser läses från den sparade prisöversikten och räknas aldrig om;
- inga data cachas publikt; alla svar är `Cache-Control: no-store`;
- webbläsaren har ingen direktåtkomst till Table Storage.

Demo och produktion är separerade. `ADMIN_DATA_SOURCE=table` krävs i
produktion, och `createAdminRepository` vägrar demoläget när
`NODE_ENV=production`. Demodata kan därför inte visas som riktiga bokningar.

Kända schemaglapp för verklig data:

- befintliga `outbox`-poster saknar `reference`/`mailType`, så mejlstatus kan
  visas som okänd tills skrivflödet utökas;
- riktiga poster saknar `latestNote`, så anteckningar kan vara tomma tills
  fältet eller historiken införs.

## 6. Roller och behörigheter

| Roll | Nuvarande read-only version | Planerad behörighet |
|---|---|---|
| Owner | Läsa dashboard, lista och detaljer | Full boknings- och betalningshantering |
| Staff | Läsa dashboard, lista och detaljer | Operativ läsning/anteckningar; inga bindande ekonomiska åtgärder utan beslut |

I denna version är alla skrivningar avstängda för båda rollerna. Servern
kontrollerar rollen i API-koden. Staff får `403` på Owner-only-kontraktet
`confirm`/`cancel`; UI-knapparna är endast förberedda.

## 7. Säkerhetsverifiering efter publicering

Gör följande kontroller innan portalen anses klar:

1. `https://hemsida-skadevi-admin-prod.azurewebsites.net/admin` utan
   inloggning ska skicka till Microsoft-inloggning, inte visa data.
2. `/api/admin/bookings` utan inloggning ska inte returnera JSON-data.
3. Skicka en påhittad `X-MS-CLIENT-PRINCIPAL`-header till en oautentiserad
   förfrågan. App Service ska ta bort/ersätta den och begäran ska inte få
   åtkomst. Om data returneras ska appen stoppas omedelbart.
4. Logga in som Owner: dashboard och bokningslista ska fungera.
5. Logga in som Staff: läsning ska fungera, men `confirm`/`cancel` ska ge
   `403`.
6. Kontrollera att `/healthz` är den enda publika rutten och att inga andra
   `excludedPaths` finns.
7. Kontrollera att adminappens managed identity endast har
   `Storage Table Data Reader` på tabellen.
8. Kontrollera att `X-Robots-Tag: noindex`, `Cache-Control: no-store`,
   CSP och HTTPS/HSTS finns.
9. Kontrollera att inga riktiga bokningar ändras och att status-API:t svarar
   `503`.

## 8. Kostnad och påverkan på B1-planen

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

## 9. Domän och HTTPS

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

## 10. Vad som medvetet inte är byggt

- Statusändringar, godkännande, nekande eller avbokning.
- Kalender och manuella blockeringar.
- Mejlutskick, omsändning eller leveranspolling.
- Betalning, fakturering eller återbetalning.
- Azure-deployment, DNS-cutover och custom domain-bindning.
- Riktiga bokningar i demodata.

## 11. Filer

```text
server/admin/                 admin-server, auth, domän, vyer och demorepository
server/admin/repository/table.js   read-only Table Storage med managed identity
server/admin/public/          admin-CSS och minimal browser-JS
infra/admin-webapp.bicep      förberedd app, managed identity och Reader-roll
infra/admin-webapp.bicepparam parametervärden utan hemligheter
tests/unit/admin-portal.test.js
docs/bokningsportal.md
```

## 12. Kontroller

```powershell
npm run lint
npm test
npm run build
```

Den publika webbplatsen, kalendern och prisberäkningen är oförändrade. Inga
nya npm-beroenden har lagts till för portalen.
