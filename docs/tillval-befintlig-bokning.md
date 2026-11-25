# Tillval till en befintlig bokning (Steg 15)

## Sammanfattning

Gäster med en bekräftad bokning kan på `/boka` välja **Lägg till tillval till min bokning**. Flödet identifierar bokningen med bokningsnummer och registrerad e-postadress, verifierar med en sexsiffrig engångskod och utfärdar därefter en kortlivad, bokningsbunden session. Gästen kan sedan köpa endast de nya tillvalen. Stripe Checkout debiterar aldrig boendet igen, och den ursprungliga bokningen ändras först när en signerad webhook har verifierat betalningen.

Funktionen är avstängd i produktion med `EXISTING_BOOKING_ADDONS_ENABLED=0` (Bicep-parametern `enableExistingBookingAddons = false`).

## 1. Identifiering och verifiering

- Bokningsnumret återanvänds från befintliga bokningar. Inget parallellt nummersystem finns.
- Gästen anger bokningsnummer och e-postadress. Servern svarar alltid med ett neutralt meddelande, även när uppgifterna är fel.
- Verifieringskoden skickas endast till den e-postadress som finns registrerad på bokningen.
- Koden är sexsiffrig, gäller i 10 minuter, lagras endast som scrypt-hash med salt och har maximalt fem försök.
- Kodutskick begränsas per IP, per bokning/e-post (fem per timme) och har 30 sekunders cooldown.
- Efter lyckad verifiering skapas en slumpad sessionstoken. Endast SHA-256-hashen lagras, tillsammans med bokningsreferensen och 30 minuters giltighet.
- Sessionen ger endast åtkomst till den verifierade bokningen. Ingen endpoint accepterar en referens från klienten efter verifieringen.
- Inga personuppgifter visas före verifiering. Efter verifiering visas bokningsnummer, datum, gästantal och tillval – inte namn, e-post eller telefon.
- Bokningar utan registrerad e-postadress kan inte verifieras automatiskt. Gästen hänvisas till Skadevi Herrgård för manuell hjälp.

## 2. Vilka bokningar får kompletteras?

Automatisk komplettering kräver att bokningen:

- har status `CONFIRMED`,
- inte är en datumblockering,
- har en registrerad e-postadress,
- har giltiga ankomst- och avresedatum,
- inte redan har avslutats (`departure > dagens datum`).

Avbokade, nekade, preliminära, obetalda, utgångna, blockerade och bokningar i `RECONCILIATION` nekas. Manuella och Airbnb-relaterade bokningar omfattas bara när de finns i Skadevis system med samma uppgifter och verifierad e-postadress.

## 3. Tillval och priser

Priser, maxantal och regler läses från `shared/pricing-config.json` via `server/booking/pricing.js`. Inga nya priser är hårdkodade.

Automatiskt köpbara tillval:

- Slutstädning (engångspris, kan inte dubbelköpas).
- Lakan och handdukar (antal per person, begränsat till återstående `linenLimit(totalGuests)`).
- Ved (engångspris, kan inte dubbelköpas).
- Tidig incheckning kl. 09.00 (kräver `bufferNightsMode = 'auto'` och ledig buffertnatt).
- Sen utcheckning kl. 16.00 (kräver `bufferNightsMode = 'auto'` och ledig buffertnatt).

Endast förfrågan, aldrig direktdebitering:

- Extrahus (egen kalender, manuell tillgänglighet och prissättning).
- Tidig/sen utcheckning när bokningen har manuella buffertar, buffertnatten är upptagen eller kalendern inte kan verifieras.
- Andra specialtillval som gästen beskriver fritt.

En förfrågan sparas i `addonrequest`-partitionen, visas i admin och notifierar värden samt gästen. Huvudbokningens status ändras aldrig av en förfrågan och inget debiteras.

## 4. Stripe Checkout – endast tillvalen

- Beloppet beräknas alltid server-side från valda tillval och central priskonfiguration.
- Stripe-sessionen får metadata `source=existing-booking-addons`, `reference`, `addonOrderId`, `amountOre` och `termsVersion`.
- Sessionsbelopp, valuta (`sek`), läge (test/live), betalsätt (`card`) och metadata verifieras innan ordern sparas.
- Varje köp får en unik tillvalsorder i `addonorder`-partitionen. En deterministisk idempotensnyckel återanvänder en pågående Checkout.
- Boendekostnaden ingår aldrig i Checkout-beloppet.
- `checkout.session.expired` och misslyckade betalningar frigör endast de buffertnätter som ordern själv skapade och ändrar inte bokningen.

## 5. Buffertnätter under betalning

- Endast nya buffertnätter för vald tidig incheckning/sen utcheckning reserveras.
- Reservationen sker med create-only-skrivning i kalendern, vilket ger atomisk konfliktkontroll vid samtidiga köp.
- Intern kalender, aktiva bokningar, manuella blockeringar och Airbnb-kalendern kontrolleras före Checkout.
- Reserverade rader har `source=ADDON` och `blockId=<orderId>` så att de kan identifieras exakt.
- Vid avbruten/utgången Checkout frigörs endast orderns egna rader. Om betalning redan registrerats frigörs ingenting.
- Efter lyckad betalning görs en ny Airbnb-kontroll. Om buffertnatten då är upptagen bevaras betalningen och ordern går till `RECONCILIATION` i stället för att felaktigt bekräftas.
- Äldre bokningar utan `bufferNightsMode='auto'` får aldrig nya automatiska blockeringar. De erbjuds manuell förfrågan. Befintliga manuella Airbnb-spärrar rörs inte.

## 6. Uppdatering av befintlig bokning

När webhooken har verifierat betalningen:

- läggs endast de nya tillvalen till,
- bevaras `arrival`, `departure`, `lodgingBase`, `lodgingAfterDiscount`, `originalPricing` och ursprunglig villkorsversion,
- appendas en ny betalningspost till den befintliga betalningshistoriken,
- sparas ordern i `addonOrders` och betalningen även i `addonPayments`,
- ökas `total` och `totalAddons` med orderns belopp,
- räknas `amountPaid`, `balance` och `paymentStatus` om med befintlig betalningsliggare,
- konverteras orderns buffertrader från `RESERVATION` till `BOOKING`,
- skapas ingen ny boendebokning.

Dubbla webhooks är idempotenta: ordern markeras `PAID`, betalningsposten återanvänds och mejlen har deterministiska idempotensnycklar.

## 7. Mejl och notifieringar

Nya mejltyper:

- `GUEST_ADDON_VERIFICATION_CODE` – engångskod, utan bokningsuppgifter.
- `GUEST_ADDON_PURCHASE_CONFIRMATION` – "Bekräftelse på tillval till din bokning" med logotyp, hälsning, bokningsnummer, vistelsedatum, nya tillval, priser, summa, betalstatus, uppdaterad tillvalssammanställning och kontaktuppgifter.
- `HOST_ADDON_PURCHASE` – värdnotifiering med gäst, order, belopp och Stripe-session.
- `GUEST_ADDON_REQUEST_RECEIVED` och `HOST_ADDON_REQUEST` – mottagningsbekräftelse respektive värdnotifiering för manuella förfrågningar.

Alla mejl går via befintlig utkorg/Resend-infrastruktur. Bekräftelse köas endast efter att betalningen verifierats och tillvalen faktiskt lagts till. Samma order skapar aldrig dubbla mejl.

## 8. Adminportal

Bokningsdetaljen visar under **Tillvalsköp och förfrågningar**:

- tillvalsorder med status (väntar på betalning, betald, avstämning, utgången, misslyckad),
- belopp, skapad/betald tidpunkt, Stripe-session, betalningspost, villkorsversion, buffertnätter och mejlstatus,
- radering av exakt vad som köptes,
- pågående Checkout och dess giltighetstid,
- avstämningsorsak och kod,
- manuella tillvalsförfrågningar med meddelande.

Tillvalsordrar är visuellt och datamässigt separerade från boendebetalningen. Owner-autentisering och befintlig auditlogg används oförändrat. Historiken får actions `ADDON_ORDER_CHECKOUT_STARTED`, `ADDON_ORDER_PAID_AND_APPLIED`, `ADDON_ORDER_EXPIRED` och `ADDON_REQUEST_CREATED`.

## 9. Villkor, återbetalning och avbokning

- Gästen måste aktivt godkänna aktuell villkorsversion. Servern kräver att `termsVersion` matchar publicerad version.
- Villkorsversionen sparas på tillvalsordern.
- Den ursprungliga bokningens villkorsversion ändras aldrig retroaktivt.
- Ingen automatisk Stripe-återbetalning görs. Befintlig manuell återbetalningshantering används.
- Avbokning av boendet frigör kalenderrader via befintlig logik, inklusive orderns buffertrader. Tillvalshistoriken bevaras för spårbarhet.
- En återbetalning av ett tillval avbokar aldrig boendet automatiskt.

## 10. Feature flagga och driftsättning

Produktionsvärde:

```
EXISTING_BOOKING_ADDONS_ENABLED=0
EXISTING_BOOKING_ADDONS_ALLOW_LIVE=0
```

Bicep:

- `infra/main.bicep`: `param enableExistingBookingAddons bool = false`
- `infra/modules/webapp.bicep`: sätter båda miljövariablerna till `'1'` endast när parametern är true.
- `infra/main.bicepparam`: `param enableExistingBookingAddons = false`

Funktionen aktiveras först efter godkända tester, granskad what-if och Skadevis uttryckliga beslut. Live-betalningar kräver dessutom att `EXISTING_BOOKING_ADDONS_ALLOW_LIVE=1` sätts medvetet.

## 11. Testning

- `tests/unit/existing-booking-addons.test.js`: verifiering, neutrala svar, gissningsskydd, sessionsisolering, priser, dubbelköp, linnetak, Stripe-belopp, buffertreservation, webhook-idempotens, avstämning, Airbnb-konflikt, utgången Checkout, manuella förfrågningar och signerad webhook-dirigering.
- `tests/unit/existing-booking-addons-server.test.js`: API-routing, same-origin-skydd, resultatsida och avstängd flagga.
- `tests/unit/existing-booking-addons-infra.test.js`: att flaggan är false i produktion.
- `tests/e2e/addons.spec.js`: desktop, tablet och mobil; ny bokning finns kvar, addon-läget döljer datumväljaren, verifiering, endast nya tillval och att checkout-body inte innehåller boendepris.

Inga riktiga Stripe-, Resend- eller Azure-anrop görs i testerna.

## 12. Kvarstående risker och beslut

- Live-aktivering kräver separat godkännande och en live-verifierad testplan.
- `RECONCILIATION` kräver manuell Owner-hantering. Ingen automatisk återbetalning eller automatisk bekräftelse görs.
- Kodutskick kräver att utkorgen/Logic App är aktiv. Funktionen är annars verkningslös men fail-closed.
- Äldre bokningar med manuella buffertar får endast manuell förfrågan.
- Eventuella framtida antalsbaserade tillval måste läggas till i både central konfiguration och servervalidering innan de exponeras.
