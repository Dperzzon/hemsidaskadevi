# Säker aktivering av bokningsmejl (STEG 11D)

Detta dokument beskriver hur utkorgen får skicka **endast nya, godkända mejl**.
Ingen aktivering görs i STEG 11D. Produktionsvärdena är fortsatt:

- `logic-skadevi-bokningsnotis`: **Disabled**
- `outboxActivationSince`: **9999-12-31T23:59:59Z**
- `STRIPE_OUTBOX_ENABLED`: **av/saknas**
- `ADMIN_MAIL_OUTBOX_ENABLED`: **0**
- `BOOKING_REQUESTS_ENABLED`: **1** (oförändrat)

## Skyddsmekanismer i koden

En utkorgspost får endast plockas av Logic App om **alla** följande gäller:

1. `PartitionKey eq 'outbox'`
2. `dispatchEligible eq 'true'`
3. `outboxVersion eq '1'`
4. `createdAt ge '<outboxActivationSince>'`
5. `status` är `Utkorg`, `Skickar` eller `Misslyckad`

Alla nya mejl skapas via `server/booking/outbox.js`, som sätter
`dispatchEligible='true'`, `outboxVersion='1'` och `deliveryStatus='Ej skickad'`.
Gamla testposter som saknar fälten, har annan version eller ligger före
startgränsen kan därför aldrig bli sändningsbara.

Dessutom makuleras väntande betalningslänks- och bekräftelseposter när en
bokning avbokas eller ändras. Makulerade poster har status `Makulerad` och
plockas aldrig upp av Logic App.

## Förberedelse före aktivering

1. Kontrollera att senaste commit är deployad till båda apparna och att
   `npm test` är grönt.
2. Kontrollera att Resend-domänen är verifierad i Resend Dashboard och att
   avsändaren `bokning@skadeviherrgard.com` är tillåten.
3. Kontrollera att Logic Appens Managed Identity har:
   - `Key Vault Secrets User` på `resend-api-key`
   - `Storage Table Data Contributor` på `bookingrequests`
4. Kontrollera att `outboxActivationSince` fortfarande är `9999-12-31T23:59:59Z`.
5. Kontrollera att `STRIPE_OUTBOX_ENABLED` och `ADMIN_MAIL_OUTBOX_ENABLED`
   fortfarande är avstängda.

## Välj starttidpunkt utan gamla poster

Använd en tidpunkt **efter** den senaste befintliga utkorgsposten och **innan**
det första nya testmejlet skapas. Alla tider är UTC.

1. Sätt `T0` till aktuell UTC-tid när inga nya utkorgsposter skapas, till
   exempel `2026-12-01T09:00:00Z`.
2. Kontrollera att det inte finns någon utkorgspost med
   `createdAt >= T0`. Gör kontrollen med endast tekniska fält
   (`PartitionKey`, `RowKey`, `status`, `createdAt`) och utan mejladresser
   eller mejlbody.
3. Om en post finns efter `T0`, vänta eller välj en senare `T0`. Flytta aldrig
   gränsen bakåt för att få med en post.

## Isolerat test med testworkflow

Testworkflowet `logic-skadevi-bokningsnotis-test` används först. Det får endast
skicka till syntetiska mottagare som `delivered@resend.dev`.

1. Skapa två syntetiska utkorgsposter med `scripts/test-outbox-seed.mjs` mot
   testtabellen. De har unika `TEST-SKADEVI-*`-nycklar och riktiga
   sändningsfält.
2. Sätt testworkflowets `outboxActivationSince` till en tid före de syntetiska
   posternas `createdAt`, men efter alla gamla testposter.
3. Aktivera endast testworkflowet under en kort period.
4. Verifiera i körhistoriken att exakt de två syntetiska posterna skickades,
   att status blev `Skickad`, att Resend-ID finns och att ingen annan post
   plockades upp.
5. Stäng av testworkflowet igen.

## Aktivering i produktion

1. Deploya kodändringarna. Ändra inga produktionsflaggor i detta moment.
2. Sätt `outboxActivationSince` till den valda `T0` i
   `logic-skadevi-bokningsnotis`. Logic App är fortfarande **Disabled**.
3. Skapa **en** kontrollerad testpost i produktionsoutkorgen med syntetisk
   mottagare (`delivered@resend.dev`) och en unik `TEST-SKADEVI-*`-nyckel.
   Den ska ha `createdAt` strax efter `T0`.
4. Aktivera Logic App under en kort kontrollperiod.
5. Verifiera att endast testposten skickades. Kontrollera att inga gamla
   poster fick status `Skickar`, `Skickad` eller `Misslyckad`.
6. Stäng av Logic App igen.
7. Aktivera därefter en flagga i taget:
   - `ADMIN_MAIL_OUTBOX_ENABLED=1` för manuella bekräftelser och avbokningar.
   - `STRIPE_OUTBOX_ENABLED=1` för betalningskvitton, betalningslänkar och
     fakturabegäranden.
   - `BOOKING_REQUESTS_ENABLED` är redan 1 och påverkas inte av aktiveringen.
8. Aktivera Logic App permanent och övervaka de första körningarna.

## Verifiering av första riktiga utskicket

- Skicka ett testmejl till en intern adress, inte till en kund.
- Kontrollera att `from` är `bokning@skadeviherrgard.com` och att reply-to är
  `skadevigard@gmail.com`.
- Kontrollera i adminportalen att raden visar:
  - `Köat` innan Logic App har kört
  - `Accepterat av Resend` med Resend-ID efter API-acceptans
  - leveransstatus endast om Resend-webhooks har aktiverats
- Kontrollera att mejlet innehåller rätt referens, datum, gäster, tillval,
  belopp och betalstatus.
- Kontrollera att ett obetalt eller delbetalt mejl **inte** påstår att hela
  bokningen är slutbetald.

## Rollback

Vid oväntat utskick:

1. Sätt Logic App till **Disabled** omedelbart.
2. Sätt `outboxActivationSince` till `9999-12-31T23:59:59Z`.
3. Sätt `STRIPE_OUTBOX_ENABLED=0` och `ADMIN_MAIL_OUTBOX_ENABLED=0`.
4. Makulera påverkade väntande utkorgsposter genom att sätta status
   `Makulerad`. Skicka aldrig en ny post för att kompensera ett fel.
5. Granska körhistoriken och historiken i adminportalen. Logga aldrig
   mejlbody eller personuppgifter i felsökningen.
