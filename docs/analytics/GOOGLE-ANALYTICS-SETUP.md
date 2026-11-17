# Google Analytics 4 via Google Tag Manager – Skadevi Herrgård

Detta dokument beskriver den tekniska installationen på
`https://www.skadeviherrgard.com` och de manuella steg som återstår i Google
Tag Manager och Google Analytics 4.

## Status

| Del | Status |
| --- | --- |
| GTM-container `GTM-T5BNLGR7` i alla publika sidor | **Installerad i koden** |
| Samtyckeshantering och Consent Mode v2 | **Installerad i koden** |
| dataLayer-händelser för bokning och betalning | **Installerad i koden** |
| GA4 Measurement ID `G-NBQB2HKDYF` | **Måste skapas och publiceras som Google tag i GTM** |
| Insamling av data | **Inte verifierad förrän GTM-containern har publicerats** |

Koden laddar **inte** GA4 direkt med `gtag.js`. GA4 ska endast konfigureras som
en **Google tag** inuti GTM-containern. Detta förhindrar dubbla sidvisningar och
dubbla konverteringar.

## ID:n

| Tjänst | ID |
| --- | --- |
| Google Tag Manager-container | `GTM-T5BNLGR7` |
| GA4 Measurement ID | `G-NBQB2HKDYF` |

## Filer och ansvar

| Fil | Ansvar |
| --- | --- |
| `shared/analytics.js` | Genererar den gemensamma head-referensen till analysskriptet och säkrar serverrenderad köpdata. |
| `public/js/analytics.js` | Consent Mode v2, GTM-laddning, cookiepanel, säker dataLayer-kö, köpdeduplicering och avlyssning av betalningsformulär. |
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
| `purchase` | Endast på serverrenderad sida där Stripe-sessionen är verifierad som betald, beloppet matchar bokningen och bokningen har status `CONFIRMED`. | `transaction_id`, `value`, `currency: 'SEK'` |

### Skickas aldrig

Namn, e-postadress, telefonnummer, kortuppgifter, personnummer, betalningslänkar,
hemliga tokenvärden eller andra känsliga bokningsuppgifter. Detta säkras både av
servern (endast godkända fält skrivs till purchase-data) och av klientens
whitelist-baserade filter.

## Transaktioner, intäkter och deduplicering

`transaction_id` är bokningens referens (samma värde som gästen ser).
`value` är det serververifierade beloppet i SEK som Stripe-sessionen faktiskt
har debiterat, delat med 100. `currency` är alltid `SEK`.

Mätmodell: **ett köp per bokningsreferens**.

- En deposition och en senare slutbetalning använder samma `transaction_id`.
  GA4 deduplicerar därför köpet och webbplatsen registrerar inte två fullständiga
  bokningsköp.
- `value` avser den verifierade betalning som först registreras. Om en senare
  delbetalning görs med samma referens behåller GA4 den första transaktionen.
  Detta är avsiktligt för att undvika dubbelräkning, men innebär att delbetalningar
  inte summeras i GA4:s intäktsrapport.
- Klienten har även ett lokalt skydd (`localStorage`-nyckeln
  `skadevi-purchase-<referens>`) som hindrar samma webbläsare från att skicka
  samma köp vid omladdning.

**Begränsning:** klientbaserad deduplicering kan inte garantera exakt en
registrering över alla enheter, webbläsare, privata fönster eller rensad
lagring. GA4:s deduplicering på `transaction_id` är det primära skyddet.
Avstämning mot Stripe och bokningssystemet ska alltid vara ekonomisk sanning.

## Manuella steg i Google Tag Manager

1. Öppna `https://tagmanager.google.com/` och välj containern **GTM-T5BNLGR7**.
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
8. Ladda om bekräftelsesidan: samma `transaction_id` ska inte ge ett nytt köp.

### GA4 DebugView

1. Öppna GA4 → **Admin → DebugView**.
2. Gör samma flöde med GTM Preview aktivt.
3. Kontrollera att händelserna kommer in med rätt parametrar och att inga
   personuppgifter syns.
4. Kontrollera att inga händelser kommer in före samtycke.

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
- att `purchase` endast renderas för verifierad, bekräftad betalning.

E2E-testet `tests/e2e/analytics.spec.js` verifierar att GTM inte laddas före
samtycke, att accepterat samtycke laddar GTM exakt en gång, att nekat samtycke
respekteras och att personuppgifter filtreras bort från dataLayer.

## Felsökning

| Problem | Kontroll |
| --- | --- |
| Ingen data i GA4 | Är GTM-containern publicerad? Är samtycke accepterat? Är Google-taggen aktiv? |
| Dubbla sidvisningar | Leta efter en extra GA4-konfiguration eller `page_view`-tagg i GTM. |
| Inga bokningshändelser | Kontrollera Custom Event-triggers och att händelsenamnen matchar exakt. |
| `purchase` saknas | Kräver verifierad betald Stripe-session och `CONFIRMED`; kontrollera även att `transaction_id` och `value` mappats. |
| CSP-fel i konsolen | Endast `googletagmanager.com` och Google Analytics-domäner får användas; lägg inte till andra leverantörer utan beslut. |
| Cookiepanelen syns inte | Kontrollera att `/js/analytics.js` laddas och att inget gammalt samtyckesval ligger i `localStorage`. |

## Rollback

Ta bort eller pausa Google-taggen i GTM och publicera en ny version. Koden kan
även sluta ladda GTM genom att ta bort head-referensen med
`npm run sync:analytics` efter att `renderAnalyticsHead()` ändrats. Cookiepanelen
och samtyckesvalet påverkar inte bokning, priser, Stripe eller kalender.
