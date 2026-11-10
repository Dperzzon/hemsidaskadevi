# Bokningsflödet för Skadevi Herrgård

Bokningsflödet gör det möjligt för gästen att välja datum direkt i kalendern
på `/lediga-datum`, fylla i en bokningsförfrågan, välja tillval, godkänna
bokningsreglerna och skicka en förfrågan — utan att lämna sidan.

En bokningsförfrågan är **aldrig** en bekräftad bokning: den sparas alltid med
status **"Inväntar godkännande"** och påverkar aldrig Airbnb-kalendern.

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

1. ~~Bokningsreglerna~~ **BESLUTAT 2026-11-10.** Reglerna (avbokningspolicy
   "Begränsad" + husregler) är publicerade i `server/booking/house-rules.json`
   med version `2026-11-10`. Nivån för delvis återbetalning är markerad som
   "specificeras vid bekräftelse" (fältet `partialRefundLevel`) — ingen
   procentsats har hittats på. Uppdateras nivån: ändra texten och höj versionen.
2. **Durabel lagring.** Rekommenderad lösning: Azure Table Storage (billig,
   serverlös, ingen ny tjänst) med
   `AZURE_STORAGE_ACCOUNT_NAME` + `AZURE_STORAGE_KEY` (+ valfri
   `AZURE_TABLE_NAME`, default `bookingrequests`). Lagringskontot/table måste
   väljas/godkännas av Skadevi. Utan konfiguration svarar API:et 503 och
   produktionsservern varnar vid start. En lokal JSONL-fil (`data/`) finns
   endast för utveckling/test och är inte permanent lagring.
3. **E-postleverantör.** Mottagare och reply-to är beslutat:
   `skadevigard@gmail.com` (se `server/booking/mail.js`). Notiser (till Skadevi
   + mottagningsbekräftelse till gästen) skrivs som utkorgsposter i lagringen
   med fullständigt innehåll. Kvar att besluta: leverantör
   (t.ex. SendGrid, Azure Communication Services eller SMTP), avsändaradress
   (kan sättas via `BOOKING_MAIL_FROM`) och nödvändiga hemligheter — den
   verkliga leveransen är avstängd (`deliveryEnabled: false`) tills dess.
   Kostnad: gratisnivåerna räcker gott för denna volym.

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
