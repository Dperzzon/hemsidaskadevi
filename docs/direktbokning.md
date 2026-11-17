# Direktbokning med kortbetalning

Detta dokument beskriver direktbokningsflödet som är implementerat i steg 9J.
Funktionen är **avstängd i produktion** tills ett uttryckligen godkänt beslut
om Airbnb-risken finns.

## Feature flaggor

| Variabel | Standard | Betydelse |
| --- | --- | --- |
| `DIRECT_BOOKING_ENABLED` | `0` | Slår på direktbokning i applikationen. |
| `DIRECT_BOOKING_ALLOW_LIVE` | `0` | Krävs dessutom när Stripe är i live-läge. |
| `STRIPE_ENABLED` | `0` | Måste vara `1` för att Stripe ska användas. |
| `STRIPE_CARD_ENABLED` | `1` | Kortbetalning är den enda metoden i direktbokningen. |

`infra/main.bicepparam` sätter `enableDirectBooking = false`, vilket ger
`DIRECT_BOOKING_ENABLED=0` och `DIRECT_BOOKING_ALLOW_LIVE=0` i produktion.
Det gamla förfrågningsflödet och fakturaflödet är oförändrat och fungerar även
när direktbokningen är avstängd.

## Flöde

1. Gästen väljer datum i kalendern på `/boka` (samma kalender som på
   `/lediga-datum`).
2. Gästen fyller i uppgifter, tillval och väljer betalningssätt.
3. `POST /api/direct-booking` tar emot förfrågan med en `Idempotency-Key`.
4. Servern räknar alltid om priset från den publicerade prisregeln. Klientens
   belopp ignoreras.
5. Servern kontrollerar:
   - att feature-flaggan är på,
   - att bokningsreglerna är publicerade,
   - att intern kalender och datumblockeringar inte överlappar,
   - att ingen annan aktiv betalningsreservation överlappar,
   - att Airbnb-kalendern kan hämtas och tolkas,
   - att Airbnb inte visar upptagna nätter.
6. Servern skapar en atomisk nattreservation i Azure Table Storage.
7. Först därefter skapas en Stripe Checkout-session för exakt det
   serverberäknade beloppet i SEK/öre.
8. Gästen skickas till Stripe Checkout.
9. Efter betalning tar den signerade webhooken emot
   `checkout.session.completed`, registrerar betalningen exakt en gång och
   omvandlar reservationen till en bekräftad bokning.
10. Gästen ser `/bokning-klar?session_id=...`, som hämtar och verifierar
    bokningsstatus server-side. Sidan visar aldrig "Bekräftad" enbart utifrån
    Stripe-redirecten.

## Atomisk nattreservation

Reservationen består av:

- en request-post med `statusCode = PENDING_PAYMENT` och ett `reservation`-objekt
  (ägare, status, giltighetstid och Stripe-session),
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

## Webhook

Den befintliga signerade webhooken används. För direktbokningar:

1. Signaturen verifieras av befintlig kod.
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

## Faktura

Faktura är fortfarande ett separat alternativ. Det använder det befintliga
förfrågningsflödet och ger aldrig en bekräftad bokning utan Owner-godkännande.
Gästen ser tydligt att faktura/förfrågan kräver manuell hantering.

## Airbnb-risk — varför direktbokning inte är påslagen

Airbnb iCal är en **läsbar, fördröjd export**, inte en transaktionell
bokningskälla. Repot innehåller ingen Airbnb-skrivning, ingen atomisk
reservation och ingen tvåvägssynkronisering. Ett lyckat iCal-svar är därför
inte en garanti mot dubbelbokning: en gäst kan boka samma natt på Airbnb efter
att iCal-filen senast uppdaterades.

Det finns i dagsläget ingen tekniskt tillförlitlig metod i verksamheten för att
reservera eller synkronisera Airbnb-datum. Därför:

- är `DIRECT_BOOKING_ENABLED` avstängd i produktion,
- är `DIRECT_BOOKING_ALLOW_LIVE` avstängd,
- får direktbokning inte slås på för Airbnb-delade datum utan ett dokumenterat
  och uttryckligen godkänt beslut om den kvarstående dubbelbokningsrisken.

Om verksamheten senare får en tillförlitlig Airbnb-synkronisering (t.ex. en
kanalhanterare med atomisk låsning eller ett API som kan reservera datum) ska
den lösningen kopplas in innan flaggorna slås på.

## Adminportal

Direktbokningar visas automatiskt i befintlig administration med:

- källa: **Direktbokning webb**,
- bokningsstatus och betalstatus,
- Stripe-session och betalningshistorik,
- gästuppgifter, datum, tillval och totalpris,
- varningar för avstämning och kalenderkonflikter.

Befintliga PDF-bokningsbekräftelser och gamla bokningar är oförändrade.
