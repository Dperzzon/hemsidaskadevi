# Direktbokning med kortbetalning

Detta dokument beskriver det automatiska direktbokningsflödet (steg 9L) och
den kvarstående Airbnb-risken.

## Sammanfattning

Alla datum som är lediga i den interna kalendern och i senast hämtade
Airbnb-kalender kan erbjudas för direktbetalning med kort. Owner behöver inte
längre blockera datum i Airbnb och sedan öppna dem manuellt i portalen.

Direktbetalning erbjuds endast när servern har verifierat:

- att samtliga nätter är fria i den interna kalendern,
- att ingen bekräftad bokning eller manuell datumblockering överlappar,
- att ingen aktiv Checkout-reservation överlappar,
- att Airbnb iCal har hämtats och tolkats korrekt,
- att ingen natt är upptagen i Airbnb,
- att de ordinarie bokningsreglerna är uppfyllda.

Nattintervall räknas med inklusiv ankomst och exklusiv avresa.

## Feature flaggor och Owner-inställning

| Variabel | Standard | Betydelse |
| --- | --- | --- |
| `DIRECT_BOOKING_ENABLED` | `0` | Deployment-flagga för direktbokningsfunktionen. |
| `DIRECT_BOOKING_ALLOW_LIVE` | `0` | Krävs dessutom när Stripe är i live-läge. |
| `STRIPE_ENABLED` | `0` | Måste vara `1` för att Stripe ska användas. |
| `STRIPE_CARD_ENABLED` | `1` | Kortbetalning är den enda metoden i direktbokningen. |

Utöver deployment-flaggan finns en Owner-inställning i adminportalen:
**Automatisk direktbokning på/av**. Den sparas i
`PartitionKey = directbooking`, `RowKey = __setting__`. Om ingen inställning
finns är automatisk direktbokning på. Owner kan stänga av den om
kalenderintegrationen visar problem. Staff har endast läsbehörighet.

## Automatisk tillgänglighet

`GET /api/direct-booking/availability` och `POST /api/direct-booking` använder
samma server-side kontroll:

1. Deployment-flaggan och Owner-inställningen måste vara på.
2. Interna kalenderrader, bekräftade bokningar, manuella blockeringar och
   aktiva betalningsreservationer får inte överlappa.
3. Airbnb iCal hämtas färskt inför varje kontroll. Gamla cachade svar används
   aldrig som bevis för tillgänglighet. Hämtningen har timeout och begränsade
   återförsök; HTTP-status, innehållstyp och kalenderformat kontrolleras.
4. Om iCal inte kan hämtas eller tolkas nekas direktbetalning.
5. Om någon natt är upptagen i Airbnb nekas direktbetalning.
6. Reservationens nattlås verifieras innan Stripe Checkout skapas.
7. Först därefter skapas en Stripe Checkout-session.

En konfigurerbar säkerhetsgräns nära ankomst finns via
`DIRECT_BOOKING_MIN_LEAD_HOURS` (standard `0` = avstängd). Se
`docs/kalender-export.md` för import/export, synkstatus och övervakning.

Den gamla manuella öppningen av datumintervall krävs inte längre. Tidigare
`directbooking`-rader och historik bevaras för spårbarhet men påverkar inte
automatisk direktbokning. En tidigare öppning eller stängning ändrar aldrig en
bekräftad bokning.

## Atomisk nattreservation

Reservationen består av:

- en request-post med `statusCode = PENDING_PAYMENT` och ett `reservation`-objekt,
- en kalenderrad per natt i `PartitionKey = calendar` med `type = RESERVATION`.

Kalenderraderna skapas med Table Storage Insert Entity, som är create-only.
Samma natt kan därför aldrig ägas av två referenser samtidigt. Om en natt i en
flernattsreservation krockar rullas alla nätter som försöket hann skapa tillbaka.
Det finns ingen kontroll-före-skrivning som kan släppa igenom två samtidiga
bokningar.

När betalningen är verifierad uppdateras `RESERVATION`-raderna till `BOOKING`
på plats. Ingen rad raderas, så det finns ingen tidslucka där en annan bokning
kan ta datumen.

## Stripe Checkout

- Endast `card` skickas som tillåten betalmetod.
- Beloppet är `Math.round(serverpris * 100)` i SEK/öre.
- Sessionen får `expires_at` 30 minuter framåt (Stripes minimitid).
- Reservationens `expiresAt` sätts till samma tid som sessionens `expires_at`.
- `Idempotency-Key` skickas till Stripe som `direct-<nyckel>`.
- Sessionen verifieras innan den används: id, HTTPS-URL till Stripe, belopp,
  valuta, läge, referens och att endast kort är tillåtet.
- Om en session behöver avslutas i förtid anropas `expireCheckoutSession` och
  sessionens slutstatus verifieras hos Stripe innan datumen frigörs.

## Webhook och bekräftelse

Den befintliga signerade webhooken används. För direktbokningar:

1. Signaturen verifieras.
2. Rätt bokning och Checkout-session verifieras.
3. Betalningen måste vara genomförd.
4. Belopp och SEK verifieras.
5. Reservationens ägarskap verifieras mot kalenderraderna.
6. Kortbetalningen registreras exakt en gång i betalningsliggaren.
7. Reservationen omvandlas till en bekräftad bokning.
8. Auditlogg skrivs.

Om betalningen är genomförd men bokningen inte säkert kan bekräftas sätts
status `RECONCILIATION` ("Avstämning krävs"). Stripe-transaktionen bevaras och
Owner får en tydlig varning i adminportalen. Bokningen visas inte som bekräftad.

## Avbruten och misslyckad betalning

- Kunden lämnar Checkout: reservationen ligger kvar till sessionen löper ut.
- `checkout.session.expired`: webhooken verifierar sessionen hos Stripe och
  frigör därefter reservationen.
- Kortet nekas: ingen bokning skapas. Reservationen ligger kvar till utgång.
- Dubbel webhook: betalningen registreras en gång och bekräftelsen är idempotent.
- Stripe tillfälligt otillgängligt: direktbokningen returnerar 503 och ingen
  reservation skapas eller frigörs på osäkra grunder.
- Betalning lyckas men databasskrivningen misslyckas: webhooken returnerar 503
  så att Stripe försöker igen. Om bekräftelsen ändå inte kan göras sparas ett
  avstämningsärende.

## En gemensam bokningssida

Den publika bokningen finns på `/boka`. Den innehåller kalender, datumval,
gäster, tillval, prisberäkning, kontaktuppgifter, bokningsvillkor,
betalningsalternativ och prisöversikt.

`/lediga-datum` är en permanent 301-omdirigering till `/boka`. Query-parametrar
bevaras. Navigering och knappar använder `/boka` som gemensam destination.

När datumen är verifierat tillgängliga visas **"Betala med kort och bekräfta
bokningen"**. När datumen inte kan direktbokas visas **"Skicka
bokningsförfrågan"**. Faktura hanteras alltid manuellt och innebär aldrig en
automatiskt bekräftad bokning.

## Airbnb-risk

Airbnb iCal är en **läsbar, fördröjd export**, inte en transaktionell
bokningskälla. Ett färskt iCal-svar garanterar inte Airbnbs tillgänglighet i
realtid.

Vi accepterar en kvarstående risk för extern dubbelbokning. Risken minskas
genom att:

- iCal hämtas färskt inför varje Checkout-försök,
- gamla cachade svar aldrig används som bevis,
- interna lås kontrolleras atomiskt,
- två samtidiga direktbokningar på samma nätter förhindras,
- direktbetalning stoppas om kalendern inte kan hämtas eller tolkas,
- direktbetalning stoppas vid okänd eller motsägelsefull tillgänglighet.

**Kvarstående risk:** en extern Airbnb-bokning kan ske på en natt som iCal ännu
inte har uppdaterat. Systemet kan inte garantera Airbnbs realtidsstatus. Owner
kan stänga av automatisk direktbokning i adminportalen om
kalenderintegrationen visar problem.

## Adminportal

Under **Direktbokning** kan Owner:

- se om automatisk direktbokning är på eller av,
- slå av eller på automatisk direktbokning för hela hemsidan,
- läsa om Airbnb-synkroniseringens begränsning,
- gå till kalendern för manuella datumblockeringar,
- se aktiva betalningsreservationer, bekräftade direktbokningar och
  avstämningsärenden,
- se historiken över tidigare manuella direktbokningsgodkännanden.

Alla ändringar auditloggas. Staff har endast läsbehörighet.
