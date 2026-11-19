# Google Analytics 4 via Google Tag Manager – Skadevi Herrgård

Detta dokument beskriver den tekniska installationen på
`https://www.skadeviherrgard.com` och de manuella steg som återstår i Google
Tag Manager och Google Analytics 4.

## Status

| Del | Status |
| --- | --- |
| GTM-container `GTM-WN83FQXJ` i alla publika sidor | **Installerad i koden** |
| Samtyckeshantering och Consent Mode v2 | **Installerad i koden** |
| dataLayer-händelser för bokning och betalning | **Installerad i koden** |
| `purchase` kopplad till verifierad Stripe-betalning | **Verifierad i kod och automatiska tester (Steg 10C)** |
| GA4 Measurement ID `G-NBQB2HKDYF` | **Måste skapas och publiceras som Google tag i GTM** |
| Insamling av data | **Inte verifierad förrän GTM-containern har publicerats** |

Koden laddar **inte** GA4 direkt med `gtag.js`. GA4 ska endast konfigureras som
en **Google tag** inuti GTM-containern. Detta förhindrar dubbla sidvisningar och
dubbla konverteringar.

## ID:n

| Tjänst | ID |
| --- | --- |
| Google Tag Manager-container | `GTM-WN83FQXJ` |
| GA4 Measurement ID | `G-NBQB2HKDYF` |

## Filer och ansvar

| Fil | Ansvar |
| --- | --- |
| `shared/analytics.js` | Genererar head-referensen, skapar det icke-reversibla transaktions-ID:t och bygger serverrenderad, validerad köpdata. |
| `public/js/analytics.js` | Consent Mode v2, GTM-laddning, cookiepanel, säker dataLayer-kö, köpdeduplicering som först aktiveras vid leverans och avlyssning av betalningsformulär. |
| `scripts/sync-analytics.mjs` | Injicerar samma head-referens i alla publika HTML-sidor (`npm run sync:analytics`). |
| `server/booking/payment-result.js` | Lägger till analysskriptet i serverrenderade betalningsresultat och skickar verifierad `purchase`-data. |
| `server/booking/payment-page.js` | Lägger till analysskriptet i betalningssidan och markerar kort-/Swish-formulären med `data-analytics-checkout`. |
| `server/booking/direct-booking.js` | Skickar verifierad `purchase`-data på bekräftelsesidan `/bokning-klar`. |
| `src/js/booking-form.js` | Skickar `booking_started`, `booking_request_submitted` och `begin_checkout` från bokningsflödet. |
| `src/css/style.css` | Cookiepanelens diskreta design (champagnevitt, grafitsvart, guld). |
| `src/pages/integritet.html` | Integritets- och cookieinformation på `/integritet`. |
| `server/index.js` | CSP som tillåter endast nödvändiga Google-domäner när samtycke finns. |

Adminportalen påverkas inte: den använder en separat server, separat layout och
har ingen analyskod.

## Samtycke och Consent Mode v2

Standardsläget sätts innan någon GTM-resurs laddas:

```js
gtag('consent', 'default', {
  ad_storage: 'denied',
  ad_user_data: 'denied',
  ad_personalization: 'denied',
  analytics_storage: 'denied',
  functionality_storage: 'granted',
  security_storage: 'granted',
  wait_for_update: 500
});
```

- GTM laddas **endast** när besökaren har sparat `analytics: true`.
- Ett sparat val lagras i `localStorage` under `skadevi-consent-v1` med endast
  `analytics`, `version` och tidsstämpel. Ingen personlig information lagras.
- Cookiepanelen visas när inget val finns. Besökaren kan acceptera eller neka
  statistik. Båda valen är lika tillgängliga.
- Länken **Cookieinställningar** i sidfoten öppnar panelen igen, så valet kan
  ändras när som helst.
- Vid byte från accepterat till nekat uppdateras `analytics_storage` till
  `denied`, Google-statistikcookies (`_ga`, `_gid`, `_gat`, `_gcl*`) tas bort och
  GA4 stängs av med `ga-disable-G-NBQB2HKDYF`.
- Inga dataLayer-händelser skickas till GTM före samtycke. De köas i minnet och
  skickas först efter ett aktivt samtycke. Nekas samtycke skickas ingenting.
- `ad_storage`, `ad_user_data` och `ad_personalization` är alltid `denied` i
  denna grundlösning eftersom webbplatsen inte använder marknadsföringstaggar.
  Om marknadsföring införs senare krävs en separat samtyckeskategori.

### Varför ingen noscript-iframe

Googles standardinstallation innehåller ofta en `<noscript>`-iframe. Den kan
inte läsa eller respektera besökarens samtyckesval och skulle därför kunna
kringgå samtyckeskravet. Den används medvetet **inte**. `<noscript>`-iframen
får endast läggas till om den kan villkoras av ett serververifierat
samtyckesval.

### CSP

Serverns Content-Security-Policy tillåter endast:

- `script-src 'self' https://www.googletagmanager.com`
- `img-src` och `connect-src` mot `googletagmanager.com`,
  `*.google-analytics.com` och `*.analytics.google.com`
- `frame-src https://www.googletagmanager.com`

Inget inline-script används. Detta gör att CSP kan förbli strikt och att
GTM/GA4 endast kan laddas från angivna domäner.

## Sidvisningar

GA4:s `page_view` skickas automatiskt av Google-taggen när den laddas, en gång
per riktig sidladdning. Det är en multi-page-applikation (MPA), så det finns
ingen history change-trigger och ingen manuell `page_view`-händelse. Skapa
därför **inte** en separat `page_view`-tagg i GTM.

GTM laddas först efter samtycke. Det innebär att en besökare som nekar aldrig
skickar någon sidvisning.

## Händelser och dataLayer

Alla händelser skickas som `{ event: '...', ... }` till `window.dataLayer`.
Endast följande parametrar tillåts; allt annat filtreras bort i
`public/js/analytics.js`.

| Händelse | Utlöses när | Parametrar |
| --- | --- | --- |
| `booking_started` | Gästen har valt en komplett period (ankomst och avresa) i kalendern. | `booking_nights` |
| `booking_request_submitted` | Servern har svarat att bokningsförfrågan sparats (`201` med referens). Inte vid knapptryck. | `booking_nights`, `booking_type: 'request'` |
| `begin_checkout` | Servern har skapat eller återanvänt en verifierad Stripe Checkout-session och gästen skickas vidare till Stripe. Gäller både direktbokning och betalningssidan. | `value`, `currency: 'SEK'`, `payment_method: 'card'|'swish'` |
| `purchase` | Endast på serverrenderad sida där Stripe-sessionen är verifierad som betald, beloppet matchar bokningen, miljön (test/live) stämmer och bokningen har status `CONFIRMED`. | `transaction_id`, `value`, `currency: 'SEK'` |

### Skickas aldrig

Namn, e-postadress, telefonnummer, kortuppgifter, personnummer, betalningslänkar,
bokningsreferenser, hemliga tokenvärden eller andra känsliga bokningsuppgifter.
Detta säkras både av servern (endast godkända fält skrivs till purchase-data)
och av klientens whitelist-baserade filter.

### Automatisk formulärmätning

GA4:s förbättrade mätning kan skicka `form_start` och `form_submit` när
bokningsformuläret används. Det är separata, automatiska händelser som inte
påverkar de affärskritiska händelserna. `booking_started`,
`booking_request_submitted`, `begin_checkout` och `purchase` skickas endast från
koden och får inte mappas om till eller dubbleras av den automatiska
formulärmätningen.

## Transaktioner, intäkter och deduplicering

### Exakt när `purchase` genereras

Servern renderar en `purchase`-payload endast i två flöden:

1. `/betalning-klar` (`server/booking/payment-result.js`): när bokningen har
   status `CONFIRMED` och Stripe-sessionen är verifierad som `paid`.
2. `/bokning-klar` (`server/booking/direct-booking.js`): när direktbokningen har
   status `CONFIRMED` och Stripe-sessionen är verifierad som `paid`.

Följande villkor måste vara uppfyllda innan payloaden skapas:

- Stripe-sessionen har `payment_status = "paid"` och `mode = "payment"`.
- Sessionens valuta är `sek`.
- Sessionens `amount_total` är ett positivt heltal i öre.
- Sessionens referens (`metadata.reference` eller `client_reference_id`) matchar
  bokningens referens.
- Sessionens belopp matchar den sparade betalningsbegäran.
- Sessionens miljö (`livemode`) matchar den konfigurerade Stripe-miljön
  (`test`/`live`).
- Sessionens betalmetod matchar betalningsbegäran när Stripe anger en metod.
- Bokningen har status `CONFIRMED`. `RECONCILIATION`, `PENDING_PAYMENT`,
  `CANCELLED` och andra statusar ger aldrig `purchase`.
- Stripe-beloppet överstiger inte bokningens totalbelopp.

Enbart ett besök på `/betalning-klar` eller `/bokning-klar` utlöser aldrig
`purchase`. Sidan måste serververifiera en betald Stripe-session som hör till en
bekräftad bokning.

### Parametrar

| Parameter | Värde |
| --- | --- |
| `event` | `purchase` (toppnivå i dataLayer) |
| `transaction_id` | `skd-` + 40 hexadecimala tecken = trunkerad HMAC-SHA256 av bokningsreferensen. Stabilt per bokning, icke-reversibelt och innehåller ingen referens eller personuppgift. |
| `value` | Numeriskt belopp i **kronor** (inte öre). Avser bokningens serverberäknade totalbelopp. Om totalbeloppet saknas används det verifierade Stripe-beloppet. |
| `currency` | `SEK` |

Parametrarna ligger på **toppnivå** i dataLayer, inte under `ecommerce`.
Exempel:

```js
window.dataLayer.push({
  event: 'purchase',
  transaction_id: 'skd-0123456789abcdef0123456789abcdef01234567',
  value: 16000,
  currency: 'SEK'
});
```

### Sekretess för transaktions-ID

Bokningsreferensen (`SK-2026-XXXXXX`) används **inte** som `transaction_id`.
Referensen kan i sig användas för att öppna `/betalning-klar?ref=...` och visa
bokningsuppgifter. Genom att skicka en HMAC av referensen i stället exponeras
varken referensen eller bokningsuppgifterna i GA4.

Sätt `ANALYTICS_TRANSACTION_SECRET` som en hemlighet i Azure App Service för
produktion. Utan hemligheten används en fast namnrymd; ID:t är fortfarande
deterministiskt och icke-reversibelt men inte hemligt saltat. Samma referens ger
alltid samma ID, även efter omstart och mellan deposition och slutbetalning.

Vid publiceringen av detta byte går transaktions-ID:t från bokningsreferens till
HMAC. Ett köp som redan skickats med det gamla ID:t kan i undantagsfall
registreras igen om exakt samma resultatsida laddas om efter bytet, eftersom GA4
endast deduplicerar på det nya ID:t. Detta är en engångseffekt vid bytet och
påverkar inte framtida köp.

### Intäktsmodell: ett köp per bokning

Mätmodellen är **ett köp per bokning med bokningens totalbelopp**:

- En deposition och en senare slutbetalning använder samma `transaction_id`.
  GA4 deduplicerar därför köpet och webbplatsen registrerar inte två köp.
- `value` är bokningens totalbelopp, inte enbart depositionens belopp. Det gör
  att en deposition inte räknas som ett separat mindre köp och att en senare
  slutbetalning inte lägger till ytterligare intäkt i GA4.
- Direktbokning debiterar hela bokningsbeloppet i en enda Stripe-session, så
  `value` motsvarar då exakt det debiterade beloppet.
- Endast onlinebetalningar via Stripe mäts. Manuellt registrerade betalningar
  (banköverföring, kontant, faktura) skapar ingen `purchase`-händelse.

Ekonomisk sanning är alltid Stripe och bokningssystemets betalningsliggare.
GA4-intäkten är ett analysmått och används aldrig som bokföringsunderlag.

### Dubbelregistrering

Två oberoende skydd finns:

1. **GA4 deduplicerar på `transaction_id`.** Samma bokning får alltid samma ID.
2. **Klienten har ett lokalt skydd** i `localStorage` under nyckeln
   `skadevi-purchase-<transaction_id>`. Nyckeln sätts **först när händelsen har
   skickats till dataLayer efter samtycke**. Det innebär att:
   - upprepade omladdningar av resultatsidan inte skickar köpet igen,
   - nekat samtycke aldrig sätter nyckeln och därför inte blockerar ett senare
     samtyckt köp,
   - en besökare som nekar på resultatsidan och senare accepterar fortfarande
     kan få köpet registrerat.

Dubbellevererade Stripe-webhooks påverkar inte `purchase`: webhooken registrerar
betalningen idempotent (per Stripe-session och event) och skickar aldrig någon
`purchase`-händelse. `purchase` skapas endast av den serverrenderade
resultatsidan.

**Begränsning:** klientbaserad deduplicering kan inte garantera exakt en
registrering över alla enheter, webbläsare, privata fönster eller rensad
lagring. GA4:s deduplicering på `transaction_id` är det primära skyddet.
Avstämning mot Stripe och bokningssystemet ska alltid vara ekonomisk sanning.

## Kvarvarande mätbegränsningar

- **Besökaren stänger fliken efter betalningen.** Om betalningen slutförs men
  besökaren aldrig återvänder till `/betalning-klar` eller `/bokning-klar`
  uteblir den klientbaserade `purchase`-händelsen. Detta är en inneboende
  begränsning i klientsidig mätning.
- **GTM/GA4 blockeras av besökaren.** Adblockerare, nekad samtycke eller
  nätverksfel kan göra att händelsen aldrig når GA4.
- **Ingen serverbaserad Measurement Protocol är aktiverad.** En robustare
  framtida lösning för att täcka in stängda flikar vore att skicka `purchase`
  från servern via GA4 Measurement Protocol. Det kräver separat godkännande,
  en säker hantering av samtyckesbevis, idempotens per transaktion och en
  separat testegendom. Det är medvetet **inte** aktiverat i denna lösning.
- **Manuella betalningar** (bank, kontant, faktura) mäts inte som `purchase`.
- **GA4-intäkt är inte bokföring.** Använd Stripe och betalningsliggaren som
  ekonomisk sanning.

## Manuella steg i Google Tag Manager

1. Öppna `https://tagmanager.google.com/` och välj containern **GTM-WN83FQXJ**.
2. Kontrollera under **Tags** att det inte redan finns en aktiv GA4-konfiguration
   eller Google-tagg som skickar sidvisningar för `G-NBQB2HKDYF`. Om en sådan
   finns: pausa/ta bort den så att endast en Google tag återstår.
3. Skapa taggen **Google tag**:
   - Tag type: **Google tag**
   - Tag ID: `G-NBQB2HKDYF`
   - Trigger: **Initialization – All Pages** (eller **All Pages** om
     Initialization inte erbjuds i din version)
   - Consent settings: **Require additional consent for tag to fire** och välj
     `analytics_storage`.
   - Låt **Send a page view event when this configuration loads** vara aktiverat.
4. Skapa följande **Data Layer Variables** (om de inte redan finns):

   | Variabelnamn | Data Layer Variable Name |
   | --- | --- |
   | `DL - booking_nights` | `booking_nights` |
   | `DL - booking_type` | `booking_type` |
   | `DL - value` | `value` |
   | `DL - currency` | `currency` |
   | `DL - payment_method` | `payment_method` |
   | `DL - transaction_id` | `transaction_id` |

5. Skapa fyra **Custom Event**-triggers:

   | Trigger | Event name |
   | --- | --- |
   | `CE - booking_started` | `booking_started` |
   | `CE - booking_request_submitted` | `booking_request_submitted` |
   | `CE - begin_checkout` | `begin_checkout` |
   | `CE - purchase` | `purchase` |

6. Skapa fyra **GA4 Event**-taggar som använder Google-taggen `G-NBQB2HKDYF`:

   | Taggnamn | Event name | Trigger | Parametrar |
   | --- | --- | --- | --- |
   | `GA4 - booking_started` | `booking_started` | `CE - booking_started` | `booking_nights` |
   | `GA4 - booking_request_submitted` | `booking_request_submitted` | `CE - booking_request_submitted` | `booking_nights`, `booking_type` |
   | `GA4 - begin_checkout` | `begin_checkout` | `CE - begin_checkout` | `value`, `currency`, `payment_method` |
   | `GA4 - purchase` | `purchase` | `CE - purchase` | `transaction_id`, `value`, `currency` |

   För `purchase`: ange `transaction_id`, `value` och `currency` från
   Data Layer-variablerna. Lägg **inte** till namn, e-post eller andra
   personuppgifter.

   Data Layer-variablerna läser **toppnivå** i dataLayer. Det finns ingen
   `ecommerce`-wrapper. De exakta variabelnamnen är:

   | GTM-variabel | Data Layer Variable Name |
   | --- | --- |
   | `DLV - transaction_id` | `transaction_id` |
   | `DLV - value` | `value` |
   | `DLV - currency` | `currency` |

   `transaction_id` är ett `skd-`-prefix följt av 40 hexadecimala tecken, inte
   bokningsreferensen. `value` är ett tal i kronor, inte öre och inte en
   formaterad sträng.

7. Sätt **Consent settings** på samtliga fyra händelsetaggar:
   **Require additional consent for tag to fire** → `analytics_storage`.
8. Kontrollera att ingen annan aktiv tagg skickar `page_view`,
   `begin_checkout` eller `purchase` automatiskt. Dubbelregistrering ska tas bort.
9. Publicera en ny version av containern med en tydlig beskrivning, till exempel
   `GA4 G-NBQB2HKDYF + bokningshändelser + Consent Mode v2`.

## Nyckelhändelser i GA4

När containern är publicerad och händelserna har verifierats:

1. Öppna GA4 → **Admin** → **Events**.
2. Markera följande som **Key events** (nyckelhändelser):
   - `purchase` (primär konvertering)
   - `booking_request_submitted`
   - `begin_checkout`
   - `booking_started` (valfritt, som mikrosteg)
3. Kontrollera under **Admin → Data collection** att förbättrad mätning inte
   skapar dubbla köp eller sidvisningar.

## Verifiering

### Testscenarier för `purchase` (Steg 10C)

Alla scenarier är automatiserade med mockad Stripe-klient, minneslagring och
ingen riktig betalning. Se `tests/unit/payment-result.test.js`,
`tests/unit/direct-booking.test.js`, `tests/unit/analytics.test.js` och
`tests/e2e/analytics.spec.js`.

| Scenario | Förväntat | Täcks av |
| --- | --- | --- |
| A. Lyckad betalning, `CONFIRMED`, SEK, rätt belopp, samtycke | Exakt en `purchase` med säkert ID, bokningsvärde och `SEK` | Enhetstest A + E2E |
| B. Avbruten betalning | Ingen `purchase` | Enhetstest B/C/D |
| C. Misslyckad/nekad betalning | Ingen `purchase` | Enhetstest B/C/D |
| D. Betalning under behandling | Ingen `purchase` | Enhetstest B/C/D |
| E. Betald men `RECONCILIATION`/icke bekräftad | Ingen `purchase` | Enhetstest E |
| F. Fel Stripe-belopp, valuta, miljö eller betalmetod | Ingen `purchase` | Enhetstest F |
| G. Upprepad laddning/refresh/back/forward | Samma stabila `transaction_id`; högst ett köp | Enhetstest G + E2E dedup |
| H. Nekat samtycke | Ingen Analytics-purchase skickas | E2E nekat samtycke |
| I. Dubbla Stripe-webhooks | Ingen extra betalning och ingen extra `purchase` | Enhetstest I + webhooktester |
| J. Besökaren lämnar resultatsidan | Klientbaserad `purchase` kan utebli; dokumenterad begränsning | Manuell/dokumenterad |

### GTM Preview

1. I GTM: klicka **Preview** och ange `https://www.skadeviherrgard.com`.
2. Acceptera statistik i cookiepanelen.
3. Kontrollera att `Consent Mode` visar `analytics_storage: granted` och att
   Google-taggen `G-NBQB2HKDYF` fires en gång.
4. Gå till `/boka`, välj datum: `booking_started` ska synas.
5. Skicka en bokningsförfrågan: `booking_request_submitted` ska synas först
   efter serverns `201`-svar.
6. Påbörja en kortbetalning i testläge: `begin_checkout` ska synas först när
   servern har skapat Stripe-sessionen.
7. Slutför en testbetalning: `purchase` ska endast synas på en serverrenderad
   sida där bokningen är `CONFIRMED` och Stripe-sessionen är betald.
8. Kontrollera i **Variables** att `transaction_id`, `value` och `currency`
   ligger på toppnivå och att `transaction_id` börjar med `skd-`.
9. Ladda om bekräftelsesidan: samma `transaction_id` ska inte ge ett nytt köp.

### GA4 DebugView

1. Öppna GA4 → **Admin → DebugView**.
2. Gör samma flöde med GTM Preview aktivt.
3. Kontrollera att `purchase` kommer in med `transaction_id`, `value` (tal i
   kronor) och `currency = SEK`.
4. Kontrollera att inga personuppgifter eller bokningsreferenser syns.
5. Kontrollera att inga händelser kommer in före samtycke.

### Nekat samtycke

1. Öppna webbplatsen i ett nytt privat fönster.
2. Välj **Neka statistik**.
3. Kontrollera i webbläsarens nätverkspanel att inga anrop går till
   `googletagmanager.com` eller `google-analytics.com`.
4. Öppna **Cookieinställningar** i sidfoten och välj **Acceptera statistik**.
5. Först nu får GTM laddas och händelser skickas.

## Manuella steg som återstår

- [ ] Skapa Google-taggen `G-NBQB2HKDYF` i GTM (avsnittet ovan).
- [ ] Skapa dataLayer-variabler, Custom Event-triggers och GA4-händelsetaggar.
- [ ] Kontrollera att ingen befintlig GA4-tagg eller `gtag.js` finns kvar.
- [ ] Publicera GTM-containern.
- [ ] Verifiera med GTM Preview och GA4 DebugView.
- [ ] Markera nyckelhändelser i GA4.
- [ ] Sätt `ANALYTICS_TRANSACTION_SECRET` som hemlighet i Azure App Service.
- [ ] Publicera webbplatsens kod via ordinarie deploy (push till `main`).

## Kontroll av installationen

```powershell
npm run sync:analytics   # injicerar head-referensen i alla publika sidor
npm run lint
npm test
npm run build
node scripts/verify-dist.mjs
npx playwright test --grep-invert "@visual" --project=desktop
```

Enhetstesterna kontrollerar bland annat:

- att alla publika sidor har exakt en analysreferens och rätt GTM-ID,
- att GA4 inte installeras separat med `gtag.js`,
- att Consent Mode v2 nekar allt som standard,
- att köpdata endast innehåller `transaction_id`, `value` och `currency`,
- att transaktions-ID:t är stabilt, icke-reversibelt och inte är referensen,
- att `value` är bokningens totalbelopp i kronor,
- att `purchase` endast renderas för verifierad, bekräftad betalning i rätt
  Stripe-miljö och valuta.

E2E-testet `tests/e2e/analytics.spec.js` verifierar att GTM inte laddas före
samtycke, att accepterat samtycke laddar GTM exakt en gång, att nekat samtycke
respekteras, att personuppgifter filtreras bort från dataLayer, att `purchase`
levereras först efter samtycke, att dedupliceringsnyckeln inte sätts före
samtycke och att samma köp inte skickas två gånger.

## Felsökning

| Problem | Kontroll |
| --- | --- |
| Ingen data i GA4 | Är GTM-containern publicerad? Är samtycke accepterat? Är Google-taggen aktiv? |
| Dubbla sidvisningar | Leta efter en extra GA4-konfiguration eller `page_view`-tagg i GTM. |
| Inga bokningshändelser | Kontrollera Custom Event-triggers och att händelsenamnen matchar exakt. |
| `purchase` saknas | Kräver verifierad betald Stripe-session, rätt miljö/valuta och `CONFIRMED`; kontrollera även att `transaction_id`, `value` och `currency` mappats på toppnivå. |
| `purchase` skickas inte efter att besökaren först nekat | Kontrollera att dedupliceringsnyckeln inte finns i `localStorage`; den sätts först vid leverans efter samtycke. |
| Fel transaktions-ID i GA4 | `transaction_id` ska börja med `skd-`; bokningsreferensen ska aldrig skickas. |
| CSP-fel i konsolen | Endast `googletagmanager.com` och Google Analytics-domäner får användas; lägg inte till andra leverantörer utan beslut. |
| Cookiepanelen syns inte | Kontrollera att `/js/analytics.js` laddas och att inget gammalt samtyckesval ligger i `localStorage`. |

## Rollback

Ta bort eller pausa Google-taggen i GTM och publicera en ny version. Koden kan
även sluta ladda GTM genom att ta bort head-referensen med
`npm run sync:analytics` efter att `renderAnalyticsHead()` ändrats. Cookiepanelen
och samtyckesvalet påverkar inte bokning, priser, Stripe eller kalender.
