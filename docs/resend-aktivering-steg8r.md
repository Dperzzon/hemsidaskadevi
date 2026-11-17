# Steg 8R – Resend-integration redo för aktivering

Status 2026-11-13: genomfört på branch `integration/resend-aktivering-8r`.
Ingen DNS-ändring, inget mejl har skickats och båda Logic Apps är fortsatt
`Disabled`.

## 1. Kompatibilitet publik kod ↔ produktionsworkflow

Produktionsworkflowet `logic-skadevi-bokningsnotis` läser samma utkorgsformat
som den publika bokningskoden skriver:

| Fält | Skrivs av webbappen | Läses av workflowet |
| --- | --- | --- |
| `PartitionKey` | `outbox` | filter `PartitionKey eq 'outbox'` |
| `RowKey` | `outbox-<idempotensnyckel>-host` / `-guest` | `Idempotency-Key` |
| `mailType` | `HOST_NEW_REQUEST` / `GUEST_REQUEST_ACK` | sparas, påverkar inte filter |
| `reference` | bokningsreferens | ingår i ämne/innehåll |
| `status` | `Utkorg` | `Utkorg` / `Skickar` / `Misslyckad` |
| `attemptCount` | `0` (Edm.Int32) | återförsöksgräns `maxAttempts = 5` |
| `mailTo`, `mailReplyTo` | mottagare / reply-to | Resend-fälten `to` / `reply_to` |
| `mailSubject`, `mailHtml`, `mailText` | servergenererat, HTML-escapas | Resend-fälten `subject` / `html` / `text` |

Slutsats: formatet är kompatibelt. Den enda nödvändiga korrigeringen var att
införa en säker startgräns och ett uttryckligt sändningstillstånd, eftersom
workflowet annars hade kunnat plocka upp äldre `Utkorg`-poster vid aktivering.

## 2. Befintlig utkorg i `bookingrequests`

Inventering 2026-11-13 (endast metadata, inga personuppgifter):

| Partition | Status | Antal |
| --- | --- | --- |
| `outbox` | samtliga | **0** |
| `outbox` | `HOST_NEW_REQUEST` | 0 |
| `outbox` | `GUEST_REQUEST_ACK` | 0 |
| `request` | `Inväntar godkännande` (PENDING) | 1 syntetisk testpost (Steg 8N) |
| `request` | `Bekräftad` (CONFIRMED) | 1 manuellt skapad bokning |

Det finns alltså **inga gamla utkorgsposter** som kan skickas vid aktivering.
Den syntetiska testförfrågan och den manuella bokningen saknar båda
utkorgsposter. Historik och riktiga förfrågningar har inte ändrats eller
raderats.

## 3. Säker startgräns

Nya utkorgsposter får endast skickas om alla följande gäller:

1. `PartitionKey = outbox`
2. `dispatchEligible = 'true'`
3. `outboxVersion = '1'`
4. `createdAt >= outboxActivationSince`
5. status är `Utkorg`, `Skickar` eller `Misslyckad` enligt befintlig logik

`outboxActivationSince` har default `9999-12-31T23:59:59Z`, vilket innebär att
**ingenting kan skickas även om Logic Appen av misstag aktiveras**. Vid godkänd
aktivering sätts parametern uttryckligen till en tidpunkt efter sista
kontrollen. Äldre poster saknar `dispatchEligible`/`outboxVersion` och kan
därför aldrig bli sändningsbara.

## 4. Genomförda korrigeringar

- Nya utkorgsposter markerar `dispatchEligible: 'true'`, `outboxVersion: '1'`
  och `deliveryStatus: 'Ej skickad'`.
- Produktionsworkflowet kräver startgräns, sändningstillstånd och
  utkorgsversion; testworkflowet har samma skydd.
- Värdmejlets ämne är `Ny bokningsförfrågan – <referens>`.
- Gästmejlet innehåller referens, datum, antal gäster, boendepris efter rabatt,
  rabatt, samtliga tillval och totalpris. Båda mejlen använder Skadevis
  färgprofil (guld `#c9a96e`, mörk `#333333`, bakgrund `#f7f5f0`) och tydligt
  besked om att förfrågan inte är godkänd.
- `deliveryStatus` skiljer på API-acceptans och leverans:
  - `Accepterad av Resend – leverans ej verifierad`
  - `Skick misslyckades`
  - `Kräver manuell kontroll` med orsak
  - `Levererad` får endast sättas efter verifiering i Resend; workflowet
    påstår aldrig leverans enbart från ett Resend-ID.
- 24-timmarsvakten är kvar: en post med tidigare försök äldre än 24 timmar
  flaggas för manuell kontroll i stället för att skickas igen, eftersom Resends
  idempotensskydd upphör efter 24 timmar.

## 5. Driftsatt workflow

En isolerad workflow-only-deployment gjordes mot `logic-skadevi-bokningsnotis`
med `assignTableRole=false`. Endast Logic Appens definition och parametern
`outboxActivationSince` uppdaterades. Rolltilldelningar, tabellen, Key Vault,
webbappar och DNS påverkades inte. Logic Appen är fortsatt `Disabled` och
`resendApiUrl` pekar fortfarande på `https://api.resend.com/emails`.

Testworkflowet `logic-skadevi-bokningsnotis-test` är också fortsatt `Disabled`.

## 6. Domänverifiering i Resend

Domänen `skadeviherrgard.com` ligger fortfarande på Wix-namnservrar
(`ns0.wixdns.net`, `ns1.wixdns.net`). Publik DNS saknar Resend-poster.

Kontots domänstatus kunde **inte** hämtas säkert. Steg 8S verifierade orsaken
utan att skicka mejl eller exponera nyckeln:

- Produktionsnyckeln `resend-api-key` ger `422` på ett medvetet ofullständigt
  `POST /emails`. Det betyder att nyckeln är giltig och har behörighet att
  skicka, men `GET /domains` ger `401`. Nyckeln är alltså begränsad till
  sändning, inte återkallad eller felaktigt formaterad.
- Testnyckeln `resend-api-key-test` ger `401` även på `POST /emails` och är
  därför ingen giltig Resend-nyckel.

Nyckeln ska inte breddas eller roteras enbart för att läsa domänstatus. Inga
DNS-värden har hittats på eller gissats.

### Hämta de faktiska DNS-värdena manuellt

1. Logga in på <https://resend.com/domains> med Resend-kontots ägarkonto.
2. Öppna domänen `skadeviherrgard.com`. Om den inte finns: lägg till domänen
   och välj samma region som kontot använder.
3. Öppna domänens **DNS records**-vy. Kopiera exakt:
   - DKIM: TXT-posten `resend._domainkey`
   - SPF: TXT-posten `send`
   - MX: posten `send` (värd och prioritet)
4. Lägg in dem i GoDaddy/Azure DNS först när namnservrarna är flyttade.
   Ändra inte Wix eller GoDaddy i detta steg.

Exakta poster som återstår att lägga in när Azure DNS/GoDaddy-zonen är aktiv:

| Namn | Typ | Värde |
| --- | --- | --- |
| `resend._domainkey.skadeviherrgard.com` | TXT | `p=...` – DKIM-nyckeln från Resends domäninställningar |
| `send.skadeviherrgard.com` | TXT | SPF-posten från Resends domäninställningar |
| `send.skadeviherrgard.com` | MX | Resends feedback-SMTP-värd, prioritet 10, från domäninställningarna |

Värdena måste kopieras från Resend-dashboarden eller hämtas med en nyckel som
har läsbehörighet till domäner. `infra/dns-skadeviherrgard.bicep` är förberedd
för dessa poster men har `enableResend = false`; inga DNS-ändringar har gjorts.

## 7. Ett kontrollerat riktigt mejltest

Förutsättningar innan ett enda riktigt test:

1. Lägg in Resends faktiska DKIM-/SPF-/MX-värden och verifiera domänen.
2. Publicera den publika webbappens kod som sätter `dispatchEligible` och
   `outboxVersion` (denna branch får inte publiceras förrän ändringen är
   godkänd).
3. Sätt `outboxActivationSince` till en tidpunkt strax före testet, aldrig
   tidigare än den sista gamla posten.
4. Använd en syntetisk testpost med en kontrollerad mottagare och verifiera
   `accepted` i Resend samt leveransstatus separat.
5. Aktivera därefter Logic Appen under en kort, övervakad period och stäng av
   den igen. Gamla och osäkra poster lämnas för manuell kontroll.

## 8. Återstående hinder

- Resend-domänen är ännu inte verifierad och de faktiska DNS-värdena är inte
  hämtade (401 med nuvarande nyckel).
- Den publika webbappen kör ännu inte denna branch; nya poster får därför inte
  `dispatchEligible` förrän den publiceras.
- Leveransbekräftelse (delivered/bounced/complained) saknar webhook. Status
  `Skickad` betyder endast att Resend accepterade anropet.
- Ingen aktivering, inget riktigt mejl och ingen DNS-ändring har gjorts.
