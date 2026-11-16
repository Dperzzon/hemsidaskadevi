# Swish och faktura för Skadevi Herrgård

Skadevi Herrgård erbjuder endast två betalningsvägar:

1. **Swish** via Stripe Checkout.
2. **Faktura** som en spårbar begäran som Skadevi hanterar manuellt.

Kortbetalningar, Klarna och andra betalningsmetoder är borttagna från
gästflödet. Stripe Checkout använder dynamiska betalmetoder med filtret
`allowed_payment_method_types[0]=swish`; endast Swish får vara aktiverat i
Dashboard. Äldre historiska kortposter kan fortfarande visas i
betalningsliggaren, men nya kortbetalningar kan inte väljas.

## Affärsregler

- Endast en `CONFIRMED`-bokning med giltig intern kalenderlåsning får en
  betalningssida.
- `PRELIMINARY` och `PENDING` nekas, både när Owner skapar länken och när
  gästen försöker öppna sidan eller starta Swish.
- En betalning ändrar aldrig bokningens status, pris eller kalenderlås.
- En fakturabegäran markerar aldrig bokningen som betald och skickar ingen
  faktura automatiskt.
- Avbokning, nekande eller pris-/tillvalsändring återkallar betalningssidan.
  Redan skapade Swish-sessioner markeras som ersatta. Om en sen betalning ändå
  kommer in registreras den med granskningsvarning i stället för att tappas.

## Flöde

1. Gästen skickar en bokningsförfrågan.
2. Owner godkänner och bekräftar bokningen. Kalenderlås skapas.
3. Owner skapar en betalningssida från bokningsdetaljen.
4. Gästen får en personlig länk med begränsad giltighetstid. Länken innehåller
   en kryptografiskt säker token. Endast en hash av token sparas.
5. Gästen väljer **Betala med Swish** eller **Begär faktura**.
6. Swish startar en Stripe Checkout-session med endast `swish` och valutan
   `sek`. Gästen godkänner i Swish-appen.
7. Stripes signerade webhook verifieras. Betalningen registreras som `SWISH` i
   betalningsliggaren med belopp, datum, session och event.
8. Fakturabegäran sparas med status `REQUESTED` och hanteras av Owner.

## Komponenter

| Komponent | Fil | Syfte |
| --- | --- | --- |
| Stripe-klient | `server/booking/stripe.js` | Swish-only Checkout, expire, HMAC-verifiering. |
| Betalningsliggare | `server/booking/payment-ledger.js` | Betalstatus, Swish-poster, idempotens och granskningsvarningar. |
| Betalningsåtkomst | `server/booking/payment-access.js` | Token, hash, TTL, återkallning och kalenderlåskontroll. |
| Fakturabegäran | `server/booking/invoice-requests.js` | Statusflöde utan betalningsstatus. |
| Gästsida | `server/booking/payment-page.js` | Personlig sida med Swish och faktura. |
| Webhook | `server/booking/stripe-webhook.js` | Signerade `checkout.session.*`. |
| Admin-tjänst | `server/admin/stripe-payment-service.js` | Owner-kontroll, länk, återkallning och fakturastatus. |
| Admin-API | `POST /api/admin/bookings/:reference/payment-link` | Skapar ny betalningssida. |
| Admin-API | `POST /api/admin/bookings/:reference/payment-link/revoke` | Återkallar länken. |
| Admin-API | `PATCH /api/admin/bookings/:reference/invoice-requests/:id` | Ändrar fakturastatus. |
| Publik sida | `GET /betala/:token` | Personlig betalningssida. |
| Publik Swish | `POST /api/payments/:token/swish` | Startar Swish Checkout. |
| Publik faktura | `POST /api/payments/:token/invoice-request` | Skapar fakturabegäran. |
| Webhook | `POST /api/stripe/webhook` | Tar emot Stripes händelser. |

## Säkerhet

- Token är 32 slumpade byte i base64url. Endast SHA-256-hash lagras.
- Länken är personlig, har TTL (standard 7 dagar) och kan återkallas.
- En ny länk ersätter och ogiltiggör den gamla direkt.
- Ingen betalning kan startas med enbart bokningsreferensen.
- Betalningssidan har `Cache-Control: no-store`, `Referrer-Policy: no-referrer`
  och `X-Robots-Tag: noindex`.
- Formulär kräver samma origin. Token fungerar som kapacitetsbevis.
- Endast Owner kan skapa/återkalla länkar och ändra fakturastatus.
- Staff ser betalstatus och fakturabegäranden men inte betalningslänken.
- Stripe Checkout använder dynamiska betalmetoder med filtret
  `allowed_payment_method_types[0]=swish`. Swish måste vara aktiverat i Stripe
  Dashboard; kort och Klarna får inte vara aktiva för kontot.
- Serverbelopp i öre används alltid. Klientens belopp ignoreras.
- Webhooksignaturen verifieras med HMAC-SHA256 och 5 minuters tidsfönster.
- Webhooken är idempotent per Stripe-session och skyddad mot samtidiga anrop
  med ETag och återförsök.
- Betalningar med annan metod, ändrat belopp, ersatt session eller icke
  bekräftad bokning registreras men flaggas för manuell granskning.
- Live-nycklar blockeras om inte `STRIPE_ALLOW_LIVE=1` satts uttryckligen.
- Inga kortuppgifter passerar Skadevis servrar.

## Fakturastatus

```text
REQUESTED      Begärd
IN_PROGRESS    Under behandling
SENT           Skickad
CANCELLED      Makulerad
```

Tillåtna övergångar:

```text
REQUESTED   -> IN_PROGRESS, CANCELLED
IN_PROGRESS -> SENT, CANCELLED
SENT        -> CANCELLED
CANCELLED   -> (terminal)
```

`PAID` finns medvetet inte som fakturastatus. Betalning registreras endast via
betalningsliggaren eller manuell betalningsregistrering.

## Miljövariabler

| Variabel | Standard | Betydelse |
| --- | --- | --- |
| `STRIPE_ENABLED` | `0` | Admin: tillåter betalningslänkar. Publik app: visar Swish. |
| `STRIPE_WEBHOOK_ENABLED` | `0` | Publik app: tillåter webhook. Annars `503`. |
| `STRIPE_SECRET_KEY` | tom | Stripes hemliga nyckel. Krävs av den publika appen för Swish. |
| `STRIPE_WEBHOOK_SECRET` | tom | Webhookhemlighet (`whsec_...`). |
| `STRIPE_MODE` | `test` | Visar test/live i admin. |
| `STRIPE_ALLOW_LIVE` | `0` | Måste vara `1` för live-nyckel. |
| `PUBLIC_BASE_URL` | `https://www.skadeviherrgard.com` | Bas-URL för betalningssidan. |
| `STRIPE_OUTBOX_ENABLED` | `0` | `1` köar betalnings- och faktura mejl. |
| `PAYMENT_LINK_TTL_MS` | 7 dagar | Giltighetstid för betalningssidan. |

Hemligheter får aldrig ligga i Git. I Azure läses de som Key Vault-referenser
när funktionen aktiveras. Adminportalen behöver ingen Stripe-nyckel; endast den
publika appen skapar Swish-sessioner.

## Swish-berättigande

Stripe stödjer Swish för konton med verksamhetsland i Sverige, presentmentvaluta
SEK och kund i Sverige. Kontrollera följande i Stripe Dashboard innan Swish
aktiveras:

- **Affärsmodell:** Swish stöds för B2C. B2B är inte behörigt enligt Stripes
  nuvarande villkor. Om kontot är registrerat som ren B2B kan Swish saknas.
- **MCC-kod:** vissa koder är förbjudna, bland annat `6513 Real Estate Agents
  and Managers - Rentals`. En felaktig MCC för uthyrning kan göra Swish
  otillgängligt.
- **Land och valuta:** Sverige och SEK.
- **Åtkomst:** Swish kan kräva att åtkomst begärs via Stripes Swish-preview
  eller support innan det visas under `Settings → Payments → Payment methods`.
- **Dashboard:** endast Swish ska vara aktiverat. Kort och Klarna ska vara
  avstängda.

Om Swish inte finns i listan är det ett konto-/behörighetsproblem, inte ett
kodproblem. Använd då Stripes payment method troubleshooting och begär åtkomst;
ersätt aldrig med kort eller Klarna.

## Stripe Tax och moms

Stripe Tax är inte aktiverat i koden eller i produktion. Innan det slås på
behöver Skadevi och en skatterådgivare bekräfta:

- vilka tjänster som är momspliktiga och vilka undantag som gäller,
- rätt `tax_code` per tjänst (accommodation, event, mat, tillval med mera),
- svenska momsregistreringar och eventuella utlandsregistreringar.

Rekommenderad konfiguration när det är godkänt:

1. Aktivera Stripe Tax i Dashboard och ange head office.
2. Välj **Inclusive** som standard `tax_behavior` för SEK, eftersom befintliga
   bokningspriser redan är avtalade inklusive moms. Stripe får då inte lägga
   moms ovanpå befintligt belopp.
3. Skapa separata produkter eller line items med verifierad `tax_code` för
   tjänster som har olika momshantering. Gissa aldrig `txcd_`-koder.
4. Lägg in registreringar under Tax → Locations. Utan registrering blir
   skatteberäkningen noll.
5. Sätt `automatic_tax.enabled=true` först i en separat, godkänd ändring och
   testa i sandbox. Med inclusive-priser ska kundens totalsumma vara oförändrad.
6. Använd Stripe Tax även för framtida Stripe Invoicing, men aktivera inte
   Invoicing automatiskt i detta steg.

Fakturabegäran fortsätter vara manuell och får inte innehålla påhittade
momsuppgifter.

## Testläge

1. Aktivera **Swish** i Stripe Dashboard under
   `Settings > Payments > Payment methods`. Checkout använder dynamiska
   betalmetoder; koden filtrerar med `allowed_payment_method_types[0]=swish`.
   Kort och Klarna får inte vara aktiva.
2. Använd en testnyckel `sk_test_...` och en webhookhemlighet `whsec_...`.
3. Starta den publika appen med `STRIPE_ENABLED=1` och admin med
   `STRIPE_ENABLED=1`.
4. Skapa en bekräftad bokning med kalenderlås och skapa betalningssidan.
5. Öppna `/betala/<token>` och välj Swish. I sandbox visas en testsida eller QR
   som godkänner/nekar testbetalningen.
6. Skicka webhook via Stripe CLI:

   ```powershell
   stripe listen --forward-to localhost:3000/api/stripe/webhook
   ```

Utan riktig Stripe-testnyckel kan hela kedjan verifieras mot lokal mock:

```powershell
npm run stripe:test-mode
```

Scriptet skapar en bekräftad bokning, en Swish-only Checkout-session, skickar en
signerad webhook och verifierar att betalningen registreras som `SWISH`. Det
verifierar också en fakturabegäran. **Detta bevisar inte att det riktiga
Stripe-kontot har Swish aktiverat.**

## Verifiering

```powershell
npm run lint
npm test
npm run stripe:test-mode
npm run build
npm run test:smoke
npm run package:admin
npm run smoke:admin
```

Fokuserade tester:

- `tests/unit/stripe.test.js` – Swish-only, SEK, HMAC och live-spärr.
- `tests/unit/stripe-webhook.test.js` – SWISH, idempotens, belopp, metod,
  avbokning och granskningsvarningar.
- `tests/unit/payment-page.test.js` – token, TTL, CONFIRMED, Swish, faktura,
  delbetalning och dubbla fakturabegäranden.
- `tests/unit/admin-stripe-payment-link.test.js` – Owner, kalenderlås,
  återkallning, fakturastatus och avbokning.

## Aktivering i produktion

Funktionerna är inaktiva som standard:

- `infra/main.bicepparam`: `enableStripeWebhook=false`,
  `enableSwishPayments=false`, tomma SecretUri-värden.
- `infra/admin-webapp.bicepparam`: `enableStripePayments=false`.

Aktivera först när:

1. Swish är aktiverat på Stripe-kontot.
2. `stripe-secret-key` och `stripe-webhook-secret` finns i befintligt Key Vault.
3. Webhooken pekar på `https://www.skadeviherrgard.com/api/stripe/webhook` och
   prenumererar på `checkout.session.completed`,
   `checkout.session.async_payment_succeeded`, `checkout.session.expired` och
   `checkout.session.async_payment_failed`.
4. Ett riktigt testköp med testnyckel har verifierats.
5. Owner uttryckligen godkänt live-läge.

Publicera sedan webhook och Swish med testnyckel först. Byt till live-nyckel och
`STRIPE_ALLOW_LIVE=1` först efter godkännande. Rollback: sätt
`STRIPE_ENABLED=0`, `STRIPE_WEBHOOK_ENABLED=0` och publicera om. Stäng öppna
Checkout-sessioner i Stripe vid omedelbart stopp.

## Begränsningar

- Ingen automatisk återbetalning. Refunderingar hanteras manuellt.
- Ingen automatisk faktura skickas och ingen fakturamotor finns.
- Ingen automatisk bokningsbekräftelse vid betalning.
- Ingen moms-/skatteberäkning i Stripe.
- Riktig Stripe-testverifiering kräver ett Stripe-konto med Swish aktiverat.
