# Testplan – isolerat end-to-end-test av Resend-flödet

Status: förberedd 2026-11-11 (steg 7I). Ingen deployment, aktivering eller mejlutskick har gjorts.

## Mål

Verifiera hela kedjan från utkorgspost till Resend-anrop och statusuppdatering utan att påverka produktion, riktiga gäster eller befintliga bokningar.

## Säkerhetsprinciper

- Produktionsworkflowet `logic-skadevi-bokningsnotis` ska förbli **Disabled** under testet.
- Produktionstabellen `bookingrequests` och partitionen `outbox` ska inte användas.
- `BOOKING_REQUESTS_ENABLED` ska förbli avstängt.
- Inga riktiga gästuppgifter, bokningsreferenser eller adresser används.
- Inga mejl till riktiga gäster. Endast Resends dokumenterade testadresser eller en kontrollerad testbrevlåda.
- Inga ändringar i DNS, Wix, GoDaddy eller befintliga Key Vault-hemligheter.
- Inga hemliga värden skrivs till loggar, filer eller rapport.

## Rekommenderad isolering

**Använd ett separat testworkflow, inte produktionsworkflowet.**

Produktionsworkflowet pollar `bookingrequests`/`outbox` och använder produktionsnyckeln. Även om det är Disabled innebär en aktivering att det kan plocka upp befintliga produktionsposter. Ett separat testworkflow är därför säkrare än att aktivera produktionsflödet.

Testworkflowet ska ha:

1. Egen Logic App, t.ex. `logic-skadevi-bokningsnotis-test`, skapad i Disabled-läge.
2. Egen tabell, t.ex. `bookingrequeststest`, eller egen storage-account. Produktionstabellen får inte användas.
3. Egen testnyckel i Key Vault, t.ex. `resend-api-key-test`, med `Key Vault Secrets User` endast på det sekretet. Produktionsnyckeln `resend-api-key` ska inte användas för negativa tester.
4. `mailFrom`:
   - före domänverifiering: `onboarding@resend.dev` och mottagare = Resend-kontots ägarmejl (Resend tillåter endast kontots egen adress då),
   - efter domänverifiering: `bokning@skadeviherrgard.com` och Resends testadresser.
5. `mailTo`/`hostRecipient` endast testadresser, t.ex. `delivered+host@resend.dev` och `delivered+guest@resend.dev`.
6. `resendApiUrl` mot en mock-endpoint för fel- och idempotenstester.
7. Ingen koppling till produktionswebbappen eller produktionsbokningar.

### Nödvändig förberedelse i koden

Nuvarande `infra/modules/logic-app-notify.bicep` hårdkodar `tableName = 'bookingrequests'` och `resendApiUrl = 'https://api.resend.com/emails'`. För ett separat testworkflow behöver dessa bli parametrar med produktionsvärden som default, eller så används en separat testmodul. Detta är en förberedande ändring och ska inte deployas i detta steg.

## Resend-testadresser

Enligt Resends dokumentation:

| Adress | Simulerar |
| --- | --- |
| `delivered@resend.dev` | leverans |
| `bounced@resend.dev` | bounce |
| `complained@resend.dev` | spammarkering |
| `suppressed@resend.dev` | suppression |

Adresserna stöder label, t.ex. `delivered+skadevi-test@resend.dev`. Undvik `@example.com` och `@test.com` – Resend blockerar dem med `422`.

Före domänverifiering gäller: `onboarding@resend.dev` får endast skicka till Resend-kontots egen ägaradress. Därför krävs antingen en verifierad domän eller test till ägarmejlen.

## Testfall

### A. Lyckad mejlsändning

**Steg**
1. Skapa två testposter i testtabellen: en host- och en guest-post med syntetisk referens `TEST-SK-...`.
2. Använd `delivered+host@resend.dev` och `delivered+guest@resend.dev`.
3. Aktivera endast testworkflowet.

**Förväntat**
- Resend svarar med ett `id`.
- Båda posterna får status `Skickad`, `sentAt` och `resendId`.
- `attemptCount` är 1.
- Två separata utskick, inga dubbletter.
- Ingen produktionspost eller bokning påverkas.

**Automatiserad täckning:** payload och statusövergångar finns i enhetstesterna; verkligt Resend-anrop saknas och kräver isolerat E2E-test.

### B. Tillfälligt fel och säkert återförsök

**Steg**
1. Låt testworkflowets `resendApiUrl` peka på en mock som först svarar `500` eller `429` och därefter `200`.
2. Kör en testpost.

**Förväntat**
- HTTP-actionens retryPolicy (exponential, 4 försök, 30 s–10 min) används.
- Samma `Idempotency-Key` används vid alla försök.
- Vid lyckat retry blir status `Skickad`.
- Om alla försök misslyckas blir status `Misslyckad` och nästa pollning får försöka igen.
- Ingen dubblett skickas.

### C. Permanent fel utan oändliga återförsök

**Steg**
1. Mock svarar `401`, `403` eller `422` varje gång.
2. Kör en testpost.

**Förväntat**
- Efter `maxAttempts` (5) sätts status `Kräver manuell kontroll`.
- `manualReviewReason` anger att alla återförsök är förbrukade.
- Inga fler automatiska försök görs för posten.
- Ingen oändlig loop.

### D. Skydd mot dubbla mejl

**Steg**
1. Skicka samma testpost två gånger med samma RowKey/Idempotency-Key.
2. Variant: återanvänd samma nyckel med ändrat innehåll.

**Förväntat**
- Resend returnerar samma `id` eller `409`.
- Endast ett mejl skickas.
- `409` leder till `Kräver manuell kontroll`.
- Ingen ny utkorgspost skapas.

### E. Två separata mejl där ett misslyckas

**Steg**
1. Skapa host- och guest-post med olika RowKeys.
2. Låt mocken eller testadressen få guest-posten att misslyckas men host-posten att lyckas.

**Förväntat**
- Host-posten blir `Skickad`.
- Guest-posten blir `Misslyckad` eller `Kräver manuell kontroll` enligt försöksräkningen.
- Endast den misslyckade posten återförsöks.
- Ingen påverkan på den andra posten.

### F. Resends 24-timmars idempotensgräns

**Steg**
1. Skapa en `Skickar`-post i testtabellen med `attemptedAt` äldre än 24 timmar.
2. Skapa en `Misslyckad`-post med tidigare försök äldre än 24 timmar.
3. Skapa en `Skickar`-post med `attemptCount >= maxAttempts`.
4. Kör testworkflowet.

**Förväntat**
- Alla tre flaggas `Kräver manuell kontroll`.
- Ingen av dem skickas automatiskt.
- Ingen dubblett riskeras efter att Resends idempotensskydd har upphört.
- En färsk `Skickar`-post under 24 timmar och under maxförsök får återförsökas.

### G. Inga riktiga bokningar och ingen automatisk bekräftelse

**Steg**
1. Använd endast syntetiska testposter i testtabellen.
2. Verifiera att testworkflowet inte anropar boknings-API:t.
3. Kontrollera eventuell testbokning i testmiljön.

**Förväntat**
- Ingen post skapas i `bookingrequests`/produktionsdata.
- Ingen bokning får status `Bekräftad`.
- Status för en eventuell testförfrågan är fortsatt `Inväntar godkännande`.
- Inga mejl till riktiga gäster.

## Acceptanskriterier

- Alla A–G är genomförda med dokumenterat resultat.
- Inga produktionsposter, riktiga gästuppgifter eller riktiga bokningsreferenser har använts.
- Produktionsworkflowet har varit Disabled under hela testet.
- `BOOKING_REQUESTS_ENABLED` har varit avstängt.
- Inga dubbletter, oändliga återförsök eller automatiska bekräftelser har observerats.
- Testtabell, testworkflow och eventuell testnyckel städas efter testet.

## Städning

1. Inaktivera/ta bort testworkflowet.
2. Ta bort testposterna eller testtabellen.
3. Ta bort testsekretet om ett sådant skapades.
4. Verifiera att produktionsworkflowet fortfarande är Disabled och att inga körningar finns.

## Kvarstående före första riktiga testmejlet

1. Resend-domänen måste vara verifierad, eller så testas endast mot Resend-kontots ägarmejl med `onboarding@resend.dev`.
2. DNS-posterna för Resend måste finnas; offentlig DNS visar ännu Wix-namnservrar och saknar `resend._domainkey` samt `send` TXT/MX.
3. Ett separat testworkflow med testtabell och testnyckel behöver förberedas.
4. Produktionsworkflowet ska förbli Disabled till dess att ett isolerat test är godkänt.

## Steg 7J — testmiljö som kod

Testmiljön är förberedd men **inte deployad**:

- `infra/test/logic-app-notify-test.bicep` + `.bicepparam`
- `infra/test/keyvault-secret-role-test.bicepparam`
- `scripts/test-outbox-seed.mjs`
- `npm run seed:test-outbox` (dry-run som standard)

Resurser som skapas vid en godkänd fas A-deployment:

1. Testtabellen `bookingrequeststest` i befintligt lagringskonto.
   Azure Table-namn får inte innehålla bindestreck, därför valdes
   `bookingrequeststest` i stället för `bookingrequests-test`.
2. Logic App `logic-skadevi-bokningsnotis-test` i `Disabled`-läge.
3. `Storage Table Data Contributor` för test-Logic Appens managed identity på
   **endast** `bookingrequeststest`.
4. Valfri `Storage Table Data Contributor` för testoperatören på **endast**
   `bookingrequeststest` (krävs för lokal seedning).

Fas B (`infra/test/keyvault-secret-role-test.bicepparam`) skapar endast
`Key Vault Secrets User` på `secrets/resend-api-key-test`. Testsekretet måste
skapas manuellt först och får aldrig innehålla produktionsnyckeln.

Testharnesket:

```powershell
# Visar planerade testposter, skriver ingenting
npm run seed:test-outbox

# Skriver två syntetiska outbox-poster till bookingrequeststest
npm run seed:test-outbox -- --commit
```

Harnesket vägrar allt utom `bookingrequeststest`/`stskadevibokningprod`, skapar
endast partition `outbox`, skickar inga mejl och kräver Storage Table Data
Contributor på testtabellen. Testoperatörens objekt-ID läggs in som
`testOperatorPrincipalId` vid deployment/what-if.

För HTTP-fel och timeout används en mock-endpoint via `resendApiUrl`. Använd ett
falskt testnyckelvärde i `resend-api-key-test` för mock-testerna så att ingen
riktig nyckel exponeras. Riktig sändning testas först mot Resends testadresser
efter domänverifiering.

Kostnad: ingen ny storage-account och inget nytt Key Vault. Testtabellen är
några KB, test-Logic Appen kostar inget när den är Disabled och enstaka
testkörningar ligger långt under en krona. Uppskattad merkostnad är i praktiken
**0–0,05 USD/månad**.

What-if (förberett, ej deployat):

- Fas A: **4 att skapa** (testtabell, testworkflow, test-MI:ns tabellroll,
  valfri operatörsroll), **8 Ignore**, **0 Modify/Delete**.
- Fas B: **1 att skapa** (testsekretets roll), **8 Ignore**, **0 Modify/Delete**.

Produktionsresurserna visas endast som `Ignore` i testmiljöns what-if.
