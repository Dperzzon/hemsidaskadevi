# Kort, Swish (avstängt) och faktura

Skadevi Herrgård erbjuder just nu två betalningsvägar:

1. **Kort** via Stripe Checkout.
2. **Faktura** som en spårbar begäran som Skadevi hanterar manuellt.

Swish finns kvar i koden bakom en separat funktionsflagga men är avstängt tills
Stripe aktiverar Swish för kontot. Inga andra metoder, som Klarna eller
banköverföring, visas i gästflödet.

## Affärsregler

- Endast en `CONFIRMED`-bokning med giltig intern kalenderlåsning får en
  betalningssida.
- `PRELIMINARY` och `PENDING` nekas, både när Owner skapar länken och när
  gästen försöker öppna sidan eller starta en betalning.
- En betalning ändrar aldrig bokningens status, pris eller kalenderlås.
- En fakturabegäran markerar aldrig bokningen som betald och skickar ingen
  faktura automatiskt.
- Avbokning, nekande eller pris-/tillvalsändring återkallar betalningssidan.
  Redan skapade Checkout-sessioner markeras som ersatta. Om en sen betalning
  ändå kommer in registreras den med granskningsvarning i stället för att
  tappas.

## Flöde

1. Gästen skickar en bokningsförfrågan.
2. Owner godkänner och bekräftar bokningen. Kalenderlås skapas.
3. Owner skapar en betalningssida från bokningsdetaljen.
4. Gästen får en personlig länk med begränsad giltighetstid. Länken innehåller
   en kryptografiskt säker token. Endast en hash av token sparas.
5. Gästen väljer **Betala med kort** eller **Begär faktura**.
6. Kort startar en Stripe Checkout-session med dynamiska betalmetoder filtrerade
   till `card`. Gästen betalar på Stripes hostade sida.
7. Stripes signerade webhook verifieras. Betalningen registreras som `CARD` i
   betalningsliggaren med belopp, datum, session och event.
8. Fakturabegäran sparas med status `REQUESTED` och hanteras av Owner.

## Komponenter

| Komponent | Fil | Syfte |
| --- | --- | --- |
| Stripe-klient | `server/booking/stripe.js` | Kort/Swish Checkout, expire, HMAC-verifiering. |
| Betalningsliggare | `server/booking/payment-ledger.js` | Betalstatus, CARD/SWISH-poster, idempotens och granskningsvarningar. |
| Betalningsåtkomst | `server/booking/payment-access.js` | Token, hash, TTL, återkallning och kalenderlåskontroll. |
| Fakturabegäran | `server/booking/invoice-requests.js` | Statusflöde utan betalningsstatus. |
| Gästsida | `server/booking/payment-page.js` | Personlig sida med kort, valfri Swish och faktura. |
| Webhook | `server/booking/stripe-webhook.js` | Signerade `checkout.session.*`. |
| Admin-tjänst | `server/admin/stripe-payment-service.js` | Owner-kontroll, länk, återkallning och fakturastatus. |
| Admin-API | `POST /api/admin/bookings/:reference/payment-link` | Skapar ny betalningssida. |
| Admin-API | `POST /api/admin/bookings/:reference/payment-link/revoke` | Återkallar länken. |
| Admin-API | `PATCH /api/admin/bookings/:reference/invoice-requests/:id` | Ändrar fakturastatus. |
| Publik sida | `GET /betala/:token` | Personlig betalningssida. |
| Publik kort | `POST /api/payments/:token/card` | Startar kort-Checkout. |
| Publik Swish | `POST /api/payments/:token/swish` | Endast när `STRIPE_SWISH_ENABLED=1`. |
| Publik faktura | `POST /api/payments/:token/invoice-request` | Skapar fakturabegäran. |
| Webhook | `POST /api/stripe/webhook` | Tar emot Stripes händelser. |

## Betalmetoder

Stripe Checkout använder dynamiska betalmetoder. Koden skickar
`allowed_payment_method_types` med exakt de metoder som är aktiverade:

```text
Kort:  allowed_payment_method_types[0]=card
Swish: allowed_payment_method_types[0]=swish   (endast med flaggan)
```

Kort är standard. Swish kräver både `STRIPE_SWISH_ENABLED=1` och att Swish är
aktiverat i Stripe Dashboard. Kort, Swish och Klarna kan aldrig blandas av
misstag eftersom listan alltid skickas explicit.

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
| `STRIPE_ENABLED` | `0` | Master: tillåter betalningslänkar och digital betalning. |
| `STRIPE_CARD_ENABLED` | `1` | Visar och tillåter kort när master är på. |
| `STRIPE_SWISH_ENABLED` | `0` | Visar och tillåter Swish. Kräver Stripe-aktivering. |
| `STRIPE_WEBHOOK_ENABLED` | `0` | Publik app: tillåter webhook. Annars `503`. |
| `STRIPE_SECRET_KEY` | tom | Stripes hemliga nyckel. Krävs av den publika appen. |
| `STRIPE_WEBHOOK_SECRET` | tom | Webhookhemlighet (`whsec_...`). |
| `STRIPE_MODE` | `test` | Visar test/live i admin. |
| `STRIPE_ALLOW_LIVE` | `0` | Måste vara `1` för live-nyckel. |
| `PUBLIC_BASE_URL` | `https://www.skadeviherrgard.com` | Bas-URL för betalningssidan. |
| `STRIPE_OUTBOX_ENABLED` | `0` | `1` köar betalnings- och faktura mejl. |
| `PAYMENT_LINK_TTL_MS` | 7 dagar | Giltighetstid för betalningssidan. |

Hemligheter får aldrig ligga i Git. I Azure läses de som Key Vault-referenser
när funktionen aktiveras. Adminportalen behöver ingen Stripe-nyckel; endast den
publika appen skapar Checkout-sessioner.

## Swish som framtida metod

Swish är avstängt men koden finns kvar. Innan det slås på:

- Kontrollera att kontot är B2C. Swish stöds inte för ren B2B.
- Kontrollera MCC-koden. `6513 Real Estate Agents and Managers - Rentals` är
  förbjuden för Swish.
- Begär Swish-åtkomst via Stripes Swish-preview/support om det inte visas.
- Aktivera Swish i Stripe Dashboard.
- Sätt `STRIPE_SWISH_ENABLED=1` och `enableSwishCheckout=true` i Bicep.
- Testa ett riktigt Swish-köp med BankID/Swish i testläge.

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

1. Aktivera **kort** i Stripe Dashboard under
   `Settings > Payments > Payment methods`. Låt Swish och Klarna vara avstängda.
2. Använd en testnyckel `sk_test_...` och en webhookhemlighet `whsec_...`.
3. Starta den publika appen med `STRIPE_ENABLED=1`,
   `STRIPE_CARD_ENABLED=1`, `STRIPE_SWISH_ENABLED=0` och admin med
   `STRIPE_ENABLED=1`.
4. Skapa en bekräftad bokning med kalenderlås och skapa betalningssidan.
5. Öppna `/betala/<token>` och välj **Betala med kort**. Använd Stripes
   testkort `4242 4242 4242 4242`, valfritt framtida datum och valfri CVC.
6. Skicka webhook via Stripe CLI:

   ```powershell
   stripe listen --forward-to localhost:3000/api/stripe/webhook
   ```

Utan riktig Stripe-testnyckel kan hela kedjan verifieras mot lokal mock:

```powershell
npm run stripe:test-mode
```

Scriptet skapar en bekräftad bokning, en kort-Checkout, skickar en signerad
webhook och verifierar att betalningen registreras som `CARD`. Det verifierar
också en fakturabegäran. Det bevisar inte att det riktiga Stripe-kontot har
kort aktiverat.

## Verifierat i Stripe testläge

2026-11-16 genomfördes ett riktigt testköp i den isolerade sandboxen
`Skadevi Swish test 9D` med Stripes officiella CLI:

- En riktig Checkout-session skapades av vår egen Stripe-klient med
  `allowed_payment_method_types[0]=card`.
- Checkout visade endast kort. Swish och Klarna visades inte.
- Testköpet genomfördes med Stripes testkort `4242 4242 4242 4242`.
- Sessionen fick `payment_status=paid` och `status=complete`.
- En autentisk `checkout.session.completed`-webhook togs emot via
  `stripe listen`.
- Betalningen registrerades exakt en gång som `CARD`.
- En omsändning av samma Stripe-event skapade ingen dubblett.
- PDF-modellen visade 150 kr betalt och 0 kr kvar.
- Fakturabegäran verifierades separat utan att markera betalning.

Ingen riktig debitering genomfördes. Swish kunde inte testas eftersom metoden
inte är aktiverad i sandboxen.

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

- `tests/unit/stripe.test.js` – kort som standard, Swish-flagga, SEK, HMAC.
- `tests/unit/stripe-webhook.test.js` – CARD, SWISH, idempotens, belopp,
  metod, avbokning och granskningsvarningar.
- `tests/unit/payment-page.test.js` – token, TTL, CONFIRMED, kort, Swish-flagga,
  faktura, delbetalning och dubbla fakturabegäranden.
- `tests/unit/admin-stripe-payment-link.test.js` – Owner, kalenderlås,
  återkallning, fakturastatus och avbokning.

## Aktivering i produktion

Funktionerna är inaktiva som standard:

- `infra/main.bicepparam`: `enableStripeWebhook=false`,
  `enableCardCheckout=false`, `enableSwishCheckout=false`, tomma SecretUri.
- `infra/admin-webapp.bicepparam`: `enableStripePayments=false`,
  `stripeSwishEnabled=false`.

Aktivera kort i testläge först när:

1. Kort är aktiverat på Stripe-kontot.
2. `stripe-secret-key` och `stripe-webhook-secret` finns i befintligt Key Vault.
3. Webhooken pekar på `https://www.skadeviherrgard.com/api/stripe/webhook` och
   prenumererar på `checkout.session.completed`,
   `checkout.session.async_payment_succeeded`, `checkout.session.expired` och
   `checkout.session.async_payment_failed`.
4. Ett riktigt testköp med testnyckel har verifierats.
5. Owner uttryckligen godkänt live-läge.

Publicera sedan webhook och kort med testnyckel först. Byt till live-nyckel och
`STRIPE_ALLOW_LIVE=1` först efter godkännande. Rollback: sätt
`STRIPE_ENABLED=0`, `STRIPE_WEBHOOK_ENABLED=0` och publicera om. Stäng öppna
Checkout-sessioner i Stripe vid omedelbart stopp.

## Begränsningar

- Ingen automatisk återbetalning. Refunderingar hanteras manuellt.
- Ingen automatisk faktura skickas och ingen fakturamotor finns.
- Ingen automatisk bokningsbekräftelse vid betalning.
- Ingen moms-/skatteberäkning i Stripe.
- Swish kräver att Stripe aktiverar metoden för kontot.
