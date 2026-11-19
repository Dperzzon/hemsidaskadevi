# Testplan â€“ isolerat end-to-end-test av Resend-flÃ¶det

Status: fÃ¶rberedd 2026-11-11 (steg 7I). Ingen deployment, aktivering eller mejlutskick har gjorts.

## MÃ¥l

Verifiera hela kedjan frÃ¥n utkorgspost till Resend-anrop och statusuppdatering utan att pÃ¥verka produktion, riktiga gÃ¤ster eller befintliga bokningar.

## SÃ¤kerhetsprinciper

- Produktionsworkflowet `logic-skadevi-bokningsnotis` ska fÃ¶rbli **Disabled** under testet.
- Produktionstabellen `bookingrequests` och partitionen `outbox` ska inte anvÃ¤ndas.
- `BOOKING_REQUESTS_ENABLED` ska fÃ¶rbli avstÃ¤ngt.
- Inga riktiga gÃ¤stuppgifter, bokningsreferenser eller adresser anvÃ¤nds.
- Inga mejl till riktiga gÃ¤ster. Endast Resends dokumenterade testadresser eller en kontrollerad testbrevlÃ¥da.
- Inga Ã¤ndringar i DNS, Wix, GoDaddy eller befintliga Key Vault-hemligheter.
- Inga hemliga vÃ¤rden skrivs till loggar, filer eller rapport.

## Rekommenderad isolering

**AnvÃ¤nd ett separat testworkflow, inte produktionsworkflowet.**

Produktionsworkflowet pollar `bookingrequests`/`outbox` och anvÃ¤nder produktionsnyckeln. Ã„ven om det Ã¤r Disabled innebÃ¤r en aktivering att det kan plocka upp befintliga produktionsposter. Ett separat testworkflow Ã¤r dÃ¤rfÃ¶r sÃ¤krare Ã¤n att aktivera produktionsflÃ¶det.

Testworkflowet ska ha:

1. Egen Logic App, t.ex. `logic-skadevi-bokningsnotis-test`, skapad i Disabled-lÃ¤ge.
2. Egen tabell, t.ex. `bookingrequeststest`, eller egen storage-account. Produktionstabellen fÃ¥r inte anvÃ¤ndas.
3. Egen testnyckel i Key Vault, t.ex. `resend-api-key-test`, med `Key Vault Secrets User` endast pÃ¥ det sekretet. Produktionsnyckeln `resend-api-key` ska inte anvÃ¤ndas fÃ¶r negativa tester.
4. `mailFrom`:
   - fÃ¶re domÃ¤nverifiering: `onboarding@resend.dev` och mottagare = Resend-kontots Ã¤garmejl (Resend tillÃ¥ter endast kontots egen adress dÃ¥),
   - efter domÃ¤nverifiering: `bokning@skadeviherrgard.com` och Resends testadresser.
5. `mailTo`/`hostRecipient` endast de fyra adresser som testspÃ¤rren tillÃ¥ter: `skadevigard@gmail.com`, `delivered@resend.dev`, `bounced@resend.dev` eller `complained@resend.dev`.
6. `resendApiUrl` mot en mock-endpoint fÃ¶r fel- och idempotenstester.
7. Ingen koppling till produktionswebbappen eller produktionsbokningar.

### NÃ¶dvÃ¤ndig fÃ¶rberedelse i koden

Nuvarande `infra/modules/logic-app-notify.bicep` hÃ¥rdkodar `tableName = 'bookingrequests'` och `resendApiUrl = 'https://api.resend.com/emails'`. FÃ¶r ett separat testworkflow behÃ¶ver dessa bli parametrar med produktionsvÃ¤rden som default, eller sÃ¥ anvÃ¤nds en separat testmodul. Detta Ã¤r en fÃ¶rberedande Ã¤ndring och ska inte deployas i detta steg.

## Resend-testadresser

Enligt Resends dokumentation:

| Adress | Simulerar |
| --- | --- |
| `delivered@resend.dev` | leverans |
| `bounced@resend.dev` | bounce |
| `complained@resend.dev` | spammarkering |
| `suppressed@resend.dev` | suppression |

Resend stÃ¶der label, men testworkflowets mottagarspÃ¤rr tillÃ¥ter endast de fyra exakta adresserna ovan. Plusetiketter som `delivered+test@resend.dev` blockeras. Undvik `@example.com` och `@test.com` â€“ Resend blockerar dem med `422`.

FÃ¶re domÃ¤nverifiering gÃ¤ller: `onboarding@resend.dev` fÃ¥r endast skicka till Resend-kontots egen Ã¤garadress. DÃ¤rfÃ¶r krÃ¤vs antingen en verifierad domÃ¤n eller test till Ã¤garmejlen.

## Testfall

### A. Lyckad mejlsÃ¤ndning

**Steg**
1. Skapa tvÃ¥ testposter i testtabellen: en host- och en guest-post med syntetisk referens `TEST-SK-...`.
2. AnvÃ¤nd `delivered@resend.dev` (eller `bounced@resend.dev`/`complained@resend.dev` fÃ¶r leveranshÃ¤ndelser) och `skadevigard@gmail.com`.
3. Aktivera endast testworkflowet.

**FÃ¶rvÃ¤ntat**
- Resend svarar med ett `id`.
- BÃ¥da posterna fÃ¥r status `Skickad`, `sentAt` och `resendId`.
- `attemptCount` Ã¤r 1.
- TvÃ¥ separata utskick, inga dubbletter.
- Ingen produktionspost eller bokning pÃ¥verkas.

**Automatiserad tÃ¤ckning:** payload och statusÃ¶vergÃ¥ngar finns i enhetstesterna; verkligt Resend-anrop saknas och krÃ¤ver isolerat E2E-test.

### B. TillfÃ¤lligt fel och sÃ¤kert Ã¥terfÃ¶rsÃ¶k

**Steg**
1. LÃ¥t testworkflowets `resendApiUrl` peka pÃ¥ en mock som fÃ¶rst svarar `500` eller `429` och dÃ¤refter `200`.
2. KÃ¶r en testpost.

**FÃ¶rvÃ¤ntat**
- HTTP-actionens retryPolicy (exponential, 4 fÃ¶rsÃ¶k, 30 sâ€“10 min) anvÃ¤nds.
- Samma `Idempotency-Key` anvÃ¤nds vid alla fÃ¶rsÃ¶k.
- Vid lyckat retry blir status `Skickad`.
- Om alla fÃ¶rsÃ¶k misslyckas blir status `Misslyckad` och nÃ¤sta pollning fÃ¥r fÃ¶rsÃ¶ka igen.
- Ingen dubblett skickas.

### C. Permanent fel utan oÃ¤ndliga Ã¥terfÃ¶rsÃ¶k

**Steg**
1. Mock svarar `401`, `403` eller `422` varje gÃ¥ng.
2. KÃ¶r en testpost.

**FÃ¶rvÃ¤ntat**
- Efter `maxAttempts` (5) sÃ¤tts status `KrÃ¤ver manuell kontroll`.
- `manualReviewReason` anger att alla Ã¥terfÃ¶rsÃ¶k Ã¤r fÃ¶rbrukade.
- Inga fler automatiska fÃ¶rsÃ¶k gÃ¶rs fÃ¶r posten.
- Ingen oÃ¤ndlig loop.

### D. Skydd mot dubbla mejl

**Steg**
1. Skicka samma testpost tvÃ¥ gÃ¥nger med samma RowKey/Idempotency-Key.
2. Variant: Ã¥teranvÃ¤nd samma nyckel med Ã¤ndrat innehÃ¥ll.

**FÃ¶rvÃ¤ntat**
- Resend returnerar samma `id` eller `409`.
- Endast ett mejl skickas.
- `409` leder till `KrÃ¤ver manuell kontroll`.
- Ingen ny utkorgspost skapas.

### E. TvÃ¥ separata mejl dÃ¤r ett misslyckas

**Steg**
1. Skapa host- och guest-post med olika RowKeys.
2. LÃ¥t mocken eller testadressen fÃ¥ guest-posten att misslyckas men host-posten att lyckas.

**FÃ¶rvÃ¤ntat**
- Host-posten blir `Skickad`.
- Guest-posten blir `Misslyckad` eller `KrÃ¤ver manuell kontroll` enligt fÃ¶rsÃ¶ksrÃ¤kningen.
- Endast den misslyckade posten Ã¥terfÃ¶rsÃ¶ks.
- Ingen pÃ¥verkan pÃ¥ den andra posten.

### F. Resends 24-timmars idempotensgrÃ¤ns

**Steg**
1. Skapa en `Skickar`-post i testtabellen med `attemptedAt` Ã¤ldre Ã¤n 24 timmar.
2. Skapa en `Misslyckad`-post med tidigare fÃ¶rsÃ¶k Ã¤ldre Ã¤n 24 timmar.
3. Skapa en `Skickar`-post med `attemptCount >= maxAttempts`.
4. KÃ¶r testworkflowet.

**FÃ¶rvÃ¤ntat**
- Alla tre flaggas `KrÃ¤ver manuell kontroll`.
- Ingen av dem skickas automatiskt.
- Ingen dubblett riskeras efter att Resends idempotensskydd har upphÃ¶rt.
- En fÃ¤rsk `Skickar`-post under 24 timmar och under maxfÃ¶rsÃ¶k fÃ¥r Ã¥terfÃ¶rsÃ¶kas.

### G. Inga riktiga bokningar och ingen automatisk bekrÃ¤ftelse

**Steg**
1. AnvÃ¤nd endast syntetiska testposter i testtabellen.
2. Verifiera att testworkflowet inte anropar boknings-API:t.
3. Kontrollera eventuell testbokning i testmiljÃ¶n.

**FÃ¶rvÃ¤ntat**
- Ingen post skapas i `bookingrequests`/produktionsdata.
- Ingen bokning fÃ¥r status `BekrÃ¤ftad`.
- Status fÃ¶r en eventuell testfÃ¶rfrÃ¥gan Ã¤r fortsatt `InvÃ¤ntar godkÃ¤nnande`.
- Inga mejl till riktiga gÃ¤ster.

## Acceptanskriterier

- Alla Aâ€“G Ã¤r genomfÃ¶rda med dokumenterat resultat.
- Inga produktionsposter, riktiga gÃ¤stuppgifter eller riktiga bokningsreferenser har anvÃ¤nts.
- Produktionsworkflowet har varit Disabled under hela testet.
- `BOOKING_REQUESTS_ENABLED` har varit avstÃ¤ngt.
- Inga dubbletter, oÃ¤ndliga Ã¥terfÃ¶rsÃ¶k eller automatiska bekrÃ¤ftelser har observerats.
- Testtabell, testworkflow och eventuell testnyckel stÃ¤das efter testet.

## StÃ¤dning

1. Inaktivera/ta bort testworkflowet.
2. Ta bort testposterna eller testtabellen.
3. Ta bort testsekretet om ett sÃ¥dant skapades.
4. Verifiera att produktionsworkflowet fortfarande Ã¤r Disabled och att inga kÃ¶rningar finns.

## KvarstÃ¥ende fÃ¶re fÃ¶rsta riktiga testmejlet

1. Resend-domÃ¤nen mÃ¥ste vara verifierad, eller sÃ¥ testas endast mot Resend-kontots Ã¤garmejl med `onboarding@resend.dev`.
2. DNS-posterna fÃ¶r Resend mÃ¥ste finnas; offentlig DNS visar Ã¤nnu Wix-namnservrar och saknar `resend._domainkey` samt `send` TXT/MX.
3. Ett separat testworkflow med testtabell och testnyckel behÃ¶ver fÃ¶rberedas.
4. Produktionsworkflowet ska fÃ¶rbli Disabled till dess att ett isolerat test Ã¤r godkÃ¤nt.

## Steg 7J â€” testmiljÃ¶ som kod

TestmiljÃ¶n Ã¤r fÃ¶rberedd men **inte deployad**:

- `infra/test/logic-app-notify-test.bicep` + `.bicepparam`
- `infra/test/keyvault-secret-role-test.bicepparam`
- `scripts/test-outbox-seed.mjs`
- `npm run seed:test-outbox` (dry-run som standard)

Resurser som skapas vid en godkÃ¤nd fas A-deployment:

1. Testtabellen `bookingrequeststest` i befintligt lagringskonto.
   Azure Table-namn fÃ¥r inte innehÃ¥lla bindestreck, dÃ¤rfÃ¶r valdes
   `bookingrequeststest` i stÃ¤llet fÃ¶r `bookingrequests-test`.
2. Logic App `logic-skadevi-bokningsnotis-test` i `Disabled`-lÃ¤ge.
3. `Storage Table Data Contributor` fÃ¶r test-Logic Appens managed identity pÃ¥
   **endast** `bookingrequeststest`.
4. Valfri `Storage Table Data Contributor` fÃ¶r testoperatÃ¶ren pÃ¥ **endast**
   `bookingrequeststest` (krÃ¤vs fÃ¶r lokal seedning).

Fas B (`infra/test/keyvault-secret-role-test.bicepparam`) skapar endast
`Key Vault Secrets User` pÃ¥ `secrets/resend-api-key-test`. Testsekretet mÃ¥ste
skapas manuellt fÃ¶rst och fÃ¥r aldrig innehÃ¥lla produktionsnyckeln.

Testharnesket:

```powershell
# Visar planerade testposter, skriver ingenting
npm run seed:test-outbox

# Skriver tvÃ¥ syntetiska outbox-poster till bookingrequeststest
npm run seed:test-outbox -- --commit
```

Harnesket vÃ¤grar allt utom `bookingrequeststest`/`stskadevibokningprod`, skapar
endast partition `outbox`, skickar inga mejl och krÃ¤ver Storage Table Data
Contributor pÃ¥ testtabellen. TestoperatÃ¶rens objekt-ID lÃ¤ggs in som
`testOperatorPrincipalId` vid deployment/what-if.

FÃ¶r HTTP-fel och timeout anvÃ¤nds en mock-endpoint via `resendApiUrl`. Standard-
parameterfilen anvÃ¤nder den icke-routbara adressen
`https://mock-resend.invalid/emails`, sÃ¥ ett mocktest kan aldrig nÃ¥ Resends
riktiga API av misstag. AnvÃ¤nd ett tydligt ogiltigt testnyckelvÃ¤rde i
`resend-api-key-test` fÃ¶r mock-testerna. Riktig sÃ¤ndning krÃ¤ver den separata
filen `infra/test/logic-app-notify-test-real.bicepparam`, verifierad domÃ¤n och
en giltig Resend-nyckel med endast Sending access.

Kostnad: ingen ny storage-account och inget nytt Key Vault. Testtabellen Ã¤r
nÃ¥gra KB, test-Logic Appen kostar inget nÃ¤r den Ã¤r Disabled och enstaka
testkÃ¶rningar ligger lÃ¥ngt under en krona. Uppskattad merkostnad Ã¤r i praktiken
**0â€“0,05 USD/mÃ¥nad**.

What-if (fÃ¶rberett, ej deployat):

- Fas A: **4 att skapa** (testtabell, testworkflow, test-MI:ns tabellroll,
  valfri operatÃ¶rsroll), **8 Ignore**, **0 Modify/Delete**.
- Fas B: **1 att skapa** (testsekretets roll), **9 Ignore**, **0 Modify/Delete**.

Produktionsresurserna visas endast som `Ignore` i testmiljÃ¶ns what-if.

## Steg 7L â€” mocktest kontra riktigt test

- Den **driftsatta** testworkflowen skapades fÃ¶re 7L och har fortfarande
  `https://api.resend.com/emails` som `resendApiUrl`. Den Ã¤r **Disabled** och
  fÃ¥r inte aktiveras fÃ¶r mocktester fÃ¶rrÃ¤n den redeployats med standardfilen
  (mock-URL). Detta krÃ¤ver ett separat godkÃ¤nnande.
- Lokal kod/parameterfil anvÃ¤nder nu `https://mock-resend.invalid/emails`.
  Det Ã¤r en icke-routbar reservdomÃ¤n och kan inte nÃ¥ Resend.
- `infra/test/logic-app-notify-test-real.bicepparam` Ã¤r den enda filen som
  pekar pÃ¥ Resends riktiga API. Den krÃ¤ver verifierad domÃ¤n, giltig testnyckel
  med Sending access och uttryckligt godkÃ¤nnande.
- Testsekretet `resend-api-key-test` finns Ã¤nnu inte. Fas B kan inte deployas
  fÃ¶rrÃ¤n det skapats manuellt. Det fÃ¥r aldrig innehÃ¥lla produktionsnyckeln.
- Harnesket begrÃ¤nsar mottagare till Resends testadresser eller Skadevis
  kontrollerade brevlÃ¥da. En manuell tabellskrivning med en annan principal Ã¤r
  teoretiskt mÃ¶jlig fÃ¶r den som har tabellrollen.

## Steg 7M â€” mottagarspÃ¤rr i testworkflowet

- Testworkflowet anvÃ¤nder nu en **separat testdefinition**
  (`infra/logicapp/email-notifier-test.workflow.json`). Produktionsdefinitionen
  Ã¤r ofÃ¶rÃ¤ndrad och innehÃ¥ller ingen spÃ¤rr.
- SpÃ¤rren `Tillaten_mottagare` ligger fÃ¶rst i postloopen, fÃ¶re allt
  Resend-anrop. Den tillÃ¥ter endast:
  - `skadevigard@gmail.com`
  - `delivered@resend.dev`
  - `bounced@resend.dev`
  - `complained@resend.dev`
- Adressen normaliseras med `toLower(trim(string(...)))`. Tomma vÃ¤rden,
  plusetiketter, kommatecken, semikolon, mellanslag och andra adresser blockeras.
  CC/BCC finns inte i anropet.
- Blockerade poster PATCH:as till `KrÃ¤ver manuell kontroll` med orsaken
  `Testworkflow: mottagaren Ã¤r inte tillÃ¥ten` och `deliveryStatus`
  `Blockerad av testmottagarspÃ¤rr`. Inget Resend-anrop gÃ¶rs.
- Uppdateringen deployades endast mot `logic-skadevi-bokningsnotis-test` med
  `infra/test/logic-app-notify-test-workflow.bicepparam`. Testworkflowet Ã¤r
  fortfarande `Disabled`.
- Testworkflowets publicerade `resendApiUrl` Ã¤r nu
  `https://mock-resend.invalid/emails`. Det Ã¤r en **icke-funktionell,
  icke-routbar reservdomÃ¤n**, inte en mockserver.
- Produktionsworkflowet, tabellrollerna, Key Vault-rollerna och DNS Ã¤r
  ofÃ¶rÃ¤ndrade. Testsekretet finns fortfarande inte.

## Steg 7O â€” lokala integrationstester

- `scripts/mock-resend.mjs` Ã¤r en lokal mock som endast lyssnar pÃ¥
  `127.0.0.1`. Den skickar inga mejl, krÃ¤ver ingen riktig nyckel och modellerar
  Resends idempotens: samma `Idempotency-Key` med samma body ger samma `id` och
  ingen ny leverans; samma nyckel med annan body ger `409`.
- `tests/helpers/resend-flow-simulator.js` Ã¤r en **kontraktssimulator**, inte
  Azure Logic Apps. Den anvÃ¤nder konstanter frÃ¥n den faktiska
  testdefinitionen: mottagarspÃ¤rr, `maxAttempts`, `retryPolicy` och
  `Idempotency-Key`.
- `tests/unit/resend-flow-integration.test.js` tÃ¤cker Aâ€“L: 200, 429, 500,
  401/403, 409, fÃ¶rlorat svar/timeout, samma idempotensnyckel, tvÃ¥ separata
  mejl, blockerade mottagare, 24-timmarsgrÃ¤ns, stale ETag och att inga
  bokningar skapas.
- Det kritiska fÃ¶rlorade-svar-testet lÃ¥ter mocken registrera leveransen och
  dÃ¤refter stÃ¤nga anslutningen utan svar. Simulatorn Ã¥terfÃ¶rsÃ¶ker med samma
  `Idempotency-Key`; mocken returnerar samma `id` och endast en leverans finns.
- Simulatorn vÃ¤grar alla URL:er utanfÃ¶r `127.0.0.1`/`localhost`, sÃ¥ testerna kan
  inte nÃ¥ `api.resend.com`, Azure Storage eller Key Vault.

**Vad som inte kan verifieras lokalt:**

- faktisk Azure Logic Apps-exekvering och utvÃ¤rdering av alla
  workflow-uttryck,
- Managed Identity-token till Key Vault/Table Storage,
- Azures ETag- och samtidighetsbeteende i den riktiga kÃ¶rningen,
- Logic Apps inbyggda retry-semantik i praktiken,
- Resends verkliga idempotens- och leveranssvar (mocken modellerar dem).

DÃ¤rfÃ¶r Ã¤r de lokala testerna ett komplement till, inte en ersÃ¤ttning fÃ¶r, ett
begrÃ¤nsat Azure-E2E-test. Inget Azure-flÃ¶de har kÃ¶rts i detta steg.

## Steg 11F — säker och körbar testmiljö

Steg 11F ändrar **endast testmiljön**. Produktionsworkflowet, produktions-
tabellen, produktionsnyckeln och produktionsflaggorna är oförändrade.

### API-nycklarnas status

- `resend-api-key` (produktion) ger `422` på ett medvetet ofullständigt
  `POST /emails`. Det visar att nyckeln är giltig och har sändningsbehörighet.
  Att `GET /domains` ger `401` är förväntat för en nyckel med endast Sending
  access och betyder **inte** att nyckeln är ogiltig.
- `resend-api-key-test` ger `401` även på `POST /emails` och är därför ingen
  giltig Resend-nyckel. Den har även fel format (saknar `re_`-prefix).
- Det tidigare `400`-svaret var ett fel i själva probe-anropet (nyckelvärdet
  skickades utan trimning), inte ett svar från Resend om nyckelns behörighet.
- Domänverifieringen kan inte läsas med en Sending access-nyckel. Den måste
  bekräftas manuellt i Resend Dashboard eller med en separat full-access-nyckel.

### Testworkflowets skyddsräcken

Testdefinitionen `infra/logicapp/email-notifier-test.workflow.json` är nu låst
till:

- `tableName` default `bookingrequeststest`
- `keyVaultSecretUri` default `resend-api-key-test`
- `resendApiUrl` default `https://mock-resend.invalid/emails`
- `mailFrom` default `onboarding@resend.dev`
- `outboxActivationSince` default `9999-12-31T23:59:59Z`
- filtret `PartitionKey eq 'outbox' and dispatchEligible eq 'true' and
  outboxVersion eq '1' and createdAt ge '<T0>'` samt status- och maxAttempts-
  villkor
- mottagarspärr för endast `skadevigard@gmail.com`, `delivered@resend.dev`,
  `bounced@resend.dev` och `complained@resend.dev`
- samma `Idempotency-Key`, retryPolicy, 409-hantering, 24-timmarsgräns och
  manuella kontrollstatus som produktionsdefinitionen

`allowRealResend` är `false` i standardparametrarna och tvingar mock-URL även
om en riktig URL skulle anges av misstag. Endast
`infra/test/logic-app-notify-test-real.bicepparam` sätter värdet till `true`.

### Mockat test

```powershell
npm run verify:resend-test
npm run test:resend-mock
```

Verifieringen kontrollerar den faktiska testdefinitionen och parameterfilerna.
Mocktesterna täcker 200, 429, 500, 401/403, 409, förlorat svar, idempotens,
blockerade mottagare och 24-timmarsgränsen utan att nå Resend.

### Förberett verkligt test (genomförs först efter godkännande)

```powershell
# Endast plan, skriver ingenting
node scripts/test-outbox-seed.mjs --single --to=skadevigard@gmail.com

# Ett enda syntetiskt mejl till godkänd intern mottagare
node scripts/test-outbox-seed.mjs --single --to=skadevigard@gmail.com --commit
```

Därefter, först efter uttryckligt godkännande:

1. Sätt ett `T0` i real-parametern som ligger före testpostens `createdAt`.
2. Deploya endast testworkflowet med real-parametern.
3. Aktivera endast `logic-skadevi-bokningsnotis-test` under en kort period.
4. Verifiera exakt en `Skickad`-post med Resend-ID och att inga andra poster
   ändrats.
5. Stäng av testworkflowet och sätt `outboxActivationSince` tillbaka till
   `9999-12-31T23:59:59Z`.
6. Städa testposterna. Produktionsworkflowet ska aldrig användas för testet.
