# Bokningsflödet för Skadevi Herrgård

Bokningsflödet gör det möjligt för gästen att välja datum direkt i kalendern
på `/lediga-datum`, fylla i en bokningsförfrågan, välja tillval, godkänna
bokningsreglerna och skicka en förfrågan — utan att lämna sidan.

En bokningsförfrågan är **aldrig** en bekräftad bokning: den sparas alltid med
status **"Inväntar godkännande"** och påverkar aldrig Airbnb-kalendern.

## Beslutade regler och avbokningsvillkor (2026-11-10-v2)

Bokningsreglerna är publicerade i `server/booking/house-rules.json` med
version `2026-11-10-v2`:

- Avbokning minst 30 dagar före incheckning: 100 % återbetalning.
- Avbokning från 7 dagar till mindre än 30 dagar före incheckning: 50 % återbetalning.
- Återbetalningsprocenten beräknas på den bekräftade boendesumman enligt
  offerten; tillval debiteras inte i förväg; villkoren begränsar inte
  lagstadgade konsumenträttigheter.
- **Ej beslutat (flaggat, inte påhittat):** avbokning mindre än 7 dagar före
  incheckning — specificeras vid bekräftelse (`pendingDecisions` i JSON,
  verifierat i `tests/unit/refund.test.js`). Uppdateras villkoret: ändra texten
  och höj reglerversionen.
- Husregler: ingen rökning; lås alla dörrar och stäng alla fönster vid avfärd;
  max två husdjur; inga katter.

Datumgränserna är dagsprecisa och verifierade i `tests/unit/refund.test.js`
(exakt 30 dagar → 100 %, 29 dagar → 50 %, exakt 7 dagar → 50 %, 6 dagar → ej
beslutat). Bindande bokningar är fortfarande inte aktiverade (se kill switch
nedan).

## Azure-inventering (2026-11-10)

Utförd med az CLI (läsbara frågor):

- **Prenumeration "Azure subscription 1" (Skadevi):** Key Vault
  `kv-skadevi-prod`, App Service-plan `asp-skadevi-prod`, webbapp
  `hemsida-skadevi-prod` (Bicep definierar system-assigned managed identity),
  user-assigned identitet `id-gh-actions-skadevi` (GitHub OIDC). **Inga
  lagringskonton, ingen Logic Apps-miljö.**
- **Prenumeration "Splat Reality":** `rg-splatcrm-prod` innehåller Gmail-anslutningen
  `gmail` (Microsoft.Web/connections, managed connector "gmail") samt Logic Apps
  `logic-splatcrm-gmail-in`, `logic-splatcrm-gmail-out` (Gmail-trigger "When a
  new email arrives" → HTTP POST till CRM) och
  `logic-splatcrm-user-invitation-email` (HTTP-trigger med SAS-skyddad
  callback-URL → **Send email (V2)** via samma Gmail-anslutning). Även
  lagringskontona `splatarchive`, `splatstorageprod`, `splataistorage` (Splat
  CRM/backup — ÅTERANVÄNDS EJ för Skadevis gästuppgifter: dataskiljande,
  annan verksamhet).

**Slutsats Gmail-anslutningen:** den befintliga `gmail`-anslutningen
stödjer utskick — den används redan i produktion för "Send email (V2)"
(/v2/Mail) i `logic-splatcrm-user-invitation-email`. Gmail-anslutningens
OAuth-behörighet omfattar sändning. **Kvar att verifiera:** att anslutningen
är autentiserad som skadevigard@gmail.com (anslutningens autentiserade konto
är inte läsbar via ARM — kontrolleras i portalen under Connections) och att
Googles kvoter för den kontotypen räcker (de gör det med god marginal).

**Nya resurser som förbereds (inte skapade):**
1. Lagringskonto för bokningsdata i Skadevis prenumeration, Sweden Central
   (`infra/modules/storage-tables.bicep`) — Table Storage, Standard_LRS,
   `allowSharedKeyAccess: false` (Entra-only), tabell `bookingrequests`,
   RBAC "Storage Table Data Contributor" på tabellnivå för webbappens och
   Logic Appens managed identities.
2. Logic App `logic-skadevi-bokningsnotis` i `rg-splatcrm-prod` (samma
   miljö som Gmail-anslutningen) — se nedan. Deployeras i Disabled-läge.

## Lagring: hur den fungerar

- `server/booking/store.js` — Azure Table Storage med **Microsoft Entra/
  Managed Identity först**: token hämtas via App Services identitetsslutpunkt
  (`IDENTITY_ENDPOINT`/`IDENTITY_HEADER`, valfri user-assigned identitet via
  `AZURE_CLIENT_ID`), cachelas till 60 sekunder före utgång och skickas som
  Bearer med `x-ms-version: 2019-02-02`. SharedKey finns kvar som uttrycklig
  reserv men lagringskontot ska skapas med nyckelåtkomst avstängd.
- **Idempotens:** `PartitionKey='request'`, `RowKey=<idempotensnyckel>` —
  dubbelinskick (samma nyckel) ger 409 och samma referens tillbaka.
  Samtidiga förfrågningar med olika nycklar sparas båda (se testet "olika
  idempotensnycklar ...").
- **Unika referenser:** genereras på serversidan och kontrolleras mot
  lagringen (upp till 5 försök) innan posten sparas.
- **Sparat innehåll:** referens, status, ankomst/avresa/nätter, gäster,
  namn, e-post, telefon, företag (frivilligt), meddelande, tillval, rabatt,
  godkänd regelversion, tidpunkt. Inga IP-adresser, ingen onödig data.
- **Gallring:** `store.purgeOlderThan(threshold)` för både request- och
  utkorgspartitionen; schemalagd rutin via `scripts/purge-old-bookings.mjs`
  (torrkörning som standard, `--confirm` för verklig gallring). Rekommenderad
  retention: 24 månader.
- **"Visas aldrig som mottagen om lagringen misslyckas":** misslyckat sparande
  kastar → HTTP 500 och ingen bekräftelse visas (tester bekräftar).

## E-postutskick: Resend via Logic Apps (steg 4B/4C, ej aktiverat)

Beslut 2026-11-11: Gmail-connectorn (privata Gmail-konton begränsar HTTP-actions)
och Azure Communication Services Email (pensioneras 2028-09-30) avvisades.
**Resend** används för transaktionsmejl.

- **Arkitektur:** utkorgsposter i `bookingrequests` (PartitionKey `outbox`) →
  Logic App `logic-skadevi-bokningsnotis` (Recurrence 5 min, concurrency 1,
  skapas Disabled) → hämtar API-nyckeln från Key Vault-sekret
  `resend-api-key` med Managed Identity (audience `https://vault.azure.net`,
  rollen Key Vault Secrets User — endast getSecret) → POST
  `https://api.resend.com/emails` med `Authorization: Bearer` och
  `Idempotency-Key` = utkorgspostens RowKey.
- **Avsändare:** bokning@skadeviherrgard.com (kräver domänverifiering hos
  Resend: TXT `resend._domainkey` DKIM, TXT `send` SPF, MX `send` — alla
  subdomän-scopade, rör inte befintliga poster). Mottagare för värdenotiser och
  reply-to: skadevigard@gmail.com. Gästbekräftelser till gästens angivna
  adress.
- **API-acceptans ≠ leverans:** status "Skickad" betyder endast att Resend
  accepterat anropet; `resendId` och `deliveryStatus = "Inväntar
  leveranskontroll"` sparas separat. Verklig leverans/studs följs upp via
  Resends webhooks (`email.delivered/bounced/failed/complained`) eller
  `GET /emails/:id` (`last_event`) — implementeras som eget steg före
  aktivering.
- **Skydd mot dubbla utskick:** Logic Apps ETag-anspråk ("Skickar") +
  Resends idempotensnyckel. Resends skydd gäller dock endast 24 timmar —
  därför flaggas en post som legat i "Skickar" utan bekräftat resultat i mer
  än 24 timmar som **"Kräver manuell kontroll"** i stället för att skickas
  igen. HTTP 409 (idempotenskonflikt) flaggas också för manuell kontroll, liksom
  det sista återförsöket (`attemptCount` uppnått `maxAttempts`) — ingen post
  dör tyst.

### GDPR — Resends personuppgiftsbehandling (kräver godkännande före aktivering)

- **Lagringsplats:** all kontodata (metadata, loggar, API-poster) lagras i
  **USA** oavsett vald sändningsregion (eu-west-1 är valbar för själva
  sändningen). Import till USA sker enligt EU-US Data Privacy Framework /
  standardavtalsklausuler i Resends DPA.
- **DPA:** finns i Resend Dashboard under Settings → Documents
  (resend.com/legal/dpa); förtecknad underkonsulenter på
  resend.com/legal/subprocessors. SOC 2 Type II-rapport finns i samma sektion.
- **Innehållslagring:** Resend lagrar skickat innehåll; det kan stängas av
  (kräver Pro-plan ≥ 1 månad + tillägg 50 USD/mån + minst 3 000 skickade mejl
  med < 5 % bounce). Vid låg volym är avstängning alltså inte möjlig från
  start — acceptera att sända mejl lagras hos Resend (i USA) eller välj annan
  leverantör.
- **Dataminimering:** endast referens, datum, nätter, gästantal, tillval och
  kontaktuppgifter skickas; ingen IP, inga interna ID:n, inga extra fält
  (verifierat i `tests/unit/email-resend-workflow.test.js`).
- **Åtgärder före aktivering (godkännande krävs):**
  1. Signera/granska Resends DPA (ingens contrasignering krävs — gäller vid
     kontoansvariga).
  2. Välj sändningsregion (förslag: eu-west-1, Irland).
  3. Acceptera innehållslagring i USA tills volymkraven för avstängning är
     uppfyllda, eller välj EU-alternativ hos annan leverantör.
  4. Planera radering: utkorgsposter gallras enligt 24-månadersrutinen;
     Resends lagrade mejl kvarstår tills kontot stängs/renas.

## Kill switch (inskick avstängt tills vidare)

`POST /api/booking-requests` nekas (503) så länge `BOOKING_REQUESTS_ENABLED`
inte är exakt `1` (Bicep sätter värdet till `'0'` initialt). Aktivering kräver
samtligt: lagringskonto + RBAC verifierade, Logic App-flödet verifierat,
Skadevis godkännande — därefter ändras `BOOKING_REQUESTS_ENABLED` till `'1'`
via Bicep. Oavsett läge kräver servern dessutom publicerade regler, durabel
lagring, ny tillgänglighetskontroll och status "Inväntar godkännande".

## Kostnader (uppskattning per månad)

- Table Storage (Standard_LRS): ~10 kr/GB; bokningsdata är några kB per
  förfrågan → bråkdel av en krona i lagring; transaktioner ~0,04 kr per
  10 000 (hundratals per månad i denna volym) → **< 2 kr/mån totalt**.
- Logic Apps (Consumption): action-pris ~0,000025 €/aktion; pollning var 5:e
  minut ≈ 8 640 körtiden/mån × ~3 aktioner ≈ **< 5 kr/mån**.
- Ingen annan ny resurs. Total: **< 10 kr/mån**.


## Så fungerar flödet

1. **Datumval i kalendern.** Första klicket (på ledigt, guldfärgat datum)
   väljer ankomstdatum. Andra klicket väljer avresedatum. Antal nätter visas
   omedelbart. Regler: ankomst måste vara ledigt datum framåt i tiden; alla
   nätter i perioden måste vara lediga; avresedagen är ingen natt och får
   därför sammanfalla med nästa boknings ankomstdag (samma semantik som
   serverns tillgänglighets-API). Datumval fungerar över månads- och
   årsskiften, med tangentbord (Enter/blanksteg, piltangenter) och skärmläsare.
2. **Formuläret öppnas automatiskt** under kalendern med mjuk scrollning.
   Ankomst, avresa och antal nätter är förifyllda; knappen "Ändra datum"
   återställer valet och scrollar tillbaka till kalendern.
3. **Gästuppgifter**: för-/efternamn, e-post, telefon, antal gäster (1–24),
   företag (frivilligt) och önskemål (frivilligt). Validering på klientsidan
   och serversidan.
4. **Tillval** (alla frivilliga, verifierade priser): slutstädning exklusive
   kök 2 500 kr, lakan/handdukar 200 kr per person (antal justerbart, default
   = antal gäster), ved 350 kr, tidig incheckning 500 kr och sen utcheckning
   500 kr (båda märkta som önskemål som behöver bekräftas av Skadevi).
5. **Prisöversikt**: visar perioden, antal nätter, antal gäster, tillvalsraderna
   och "Summa tillval". **Boendepriset beräknas inte** — det beror på
   vistelsetyp enligt prissidan och kan inte fastställas säkert av formuläret.
   I stället visas "Boendepris tillkommer och bekräftas i samband med
   bokningsförfrågan". Inget totalpris för boendet hittas på.
6. **Bokningsregler och samtycke.** Kryssrutan "Jag har läst och godkänner
   Skadevi Herrgårds bokningsregler." är obligatorisk; orden "bokningsregler"
   är klickbara och öppnar reglerna i en dialog så att den påbörjade
   förfrågan inte förloras. Reglerversionen sparas med förfrågan. En separat
   frivillig kryssruta för uppföljande kontakt är aldrig förvald.
7. **Inskick.** Vid "Skicka bokningsförfrågan" validerar klienten, skyddar mot
   dubbelklick (idempotensnyckel i sessionStorage), och servern kontrollerar
   på nytt att alla nätter är lediga mot Airbnb-kalendern innan förfrågan
   sparas. Bekräftelsen visas först när servern faktiskt har tagit emot
   förfrågan och innehåller unikt referensnummer och status.

## API

- `GET /api/booking-rules` → `{ published, version, text }`
- `POST /api/booking-requests`
  - Headers: `Content-Type: application/json`, `Idempotency-Key: <uuid>`
  - Svar: `201 { reference, status, nights, arrival, departure, totalAddons }`,
    `200 { ..., duplicate: true }` vid ommisskick med samma nyckel,
    `409` om nätterna bokats, `503` om tillgänglighet/regler/lagring saknas,
    `400` vid valideringsfel, `429` vid för många förfrågningar.

Servern återanvänder `handleAvailability` (server/calendar/availability.js)
för tillgänglighetskontrollen — samma kod som kalendern, med samma
"okänd tillgänglighet är aldrig ledigt"-princip.

## Beslutspunkter (kräver Skadevis godkännande)

1. ~~Bokningsreglerna~~ **BESLUTAT.** Publicerade i
   `server/booking/house-rules.json`, version `2026-11-10-v2`. Avbokning
   under 7 dagar kvarstår som flaggat beslut (`pendingDecisions`).
2. ~~Durabel lagring~~ **BESLUTAT (Azure Table Storage, Managed Identity).**
   Infrastrukturen är förberedd i `infra/modules/storage-tables.bicep` men
   inga resurser är skapade. Vid aktivering: sätt
   `AZURE_STORAGE_ACCOUNT_NAME` via Bicep (webbappen autentiserar med sin
   managed identity — ingen nyckel behövs) och tilldela RBAC.
3. **Logic App-flödet** är förberett (`infra/logicapp/` +
   `infra/modules/logic-app-notify.bicep`) men ska inte deployeras eller
   aktiveras i den befintliga Splat-miljön utan godkännande. Deployeras i
   Disabled-läge; RBAC-tilldelning för dess identitet görs efter deploy.
4. **Aktivering av verklig inskick:** `BOOKING_REQUESTS_ENABLED=1` sätts via
   Bicep först när hela kedjan (lagring → utkorg → Logic App → mejl) är
   verifierad och godkänd.
5. ~~E-postleverantör~~ **BESLUTAT.** Befintlig Gmail-anslutning i
   Splat Reality-prenumerationen återanvänds; skadevigard@gmail.com är
   mottagare och reply-to (se `server/booking/mail.js`). Kvar att verifiera:
   att anslutningen är autentiserad som just skadevigard@gmail.com (kontroll
   i portalen) och Googles sändningskvoter (överdimensionerade för volymen).

## Rabatter

Beslutade rabatter (gäller boendepriset): veckorabatt 30 % för vistelser på
7 nätter eller mer, månadsrabatt 69 % för 28 nätter eller mer (månadsrabatten
ersätter veckorabatten). Logiken finns på både klient- och serversidan
(`src/js/booking/pricing.js`, `server/booking/pricing.js`). Eftersom
boendepriset ännu inte kan beräknas säkert (vistelsetyp avgör grundpriset)
visas rabatten i prisöversikten som en diskret notis — t.ex. "Veckorabatt
30 % gäller för vistelser på 7 nätter eller fler och dras av från
boendepriset i offerten." — aldrig som en falsk totalsumma. Sparade
bokningsförfrågningar innehåller rabatten som information, och notisen till
Skadevi redovisar den. När en säker grundprismetod finns kan
`applyDiscount(base, bestDiscount(nights))` används direkt.

## Skydd

- Fältvalidering, längdgränser (meddelande ≤ 2 000 tecken) och JSON-body
  ≤ 16 kB på serversidan.
- Hastighetsbegränsning per IP (5 förfrågningar / 15 minuter) samt honungsgrop
  (dolt formulärfält) mot bottar.
- Idempotensnyckel gör att dubbla inskick inte skapar dubbla poster.
- Säkra felmeddelanden utan tekniska detaljer; ingen intern information läcker.
- Personuppgifter lagras endast i den durabla lagringen, aldrig i loggar eller
  klientens snapshot/tester; IP sparas inte.

## Utveckling och tester

- `npm test` — enhetstester (inklusive bokningslogik, lagring, regler).
- `npm run test:e2e` — funktionella E2E (bokningsflödet mockas via nätverket).
- `npm run test:visual` — visuella regressionstester (bokningsformuläret har
  egna referensbilder; befintliga sidor får inte förändras).
- `npm run test:smoke` — kontrollerar även `/api/booking-rules` och att
  POST `/api/booking-requests` är avstängt innan konfiguration finns.
