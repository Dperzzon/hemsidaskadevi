# SEO-handlingsplan – Skadevi Herrgård

**Webbplats:** https://www.skadeviherrgard.com
**Repository:** github.com/Dperzzon/hemsidaskadevi
**Produktionsapp:** hemsida-skadevi-prod (Azure App Service)
**Dokument skapat:** 2026-11-17
**Omfattning:** Teknisk SEO, metadata, semantik, strukturerad data, internlänkning, indexering, sitemap, redirects, bild- och prestandaoptimering.

**Designgaranti:** Befintlig visuell design – layout, färger, typsnitt, bildplacering, menyer, animationer, kortdesign, bokningsformulär, priser och erbjudanden – har bevarats oförändrad på desktop och mobil. Arbetet har skett i metadata, HTML-semantik, rubrikstruktur, JSON-LD, redirects, sitemap, robots.txt och icke-visuella prestandaåtgärder.

---

## 1. SEO-problem som identifierades

### Kritiska / hög prioritet
| # | Problem | Plats | Effekt |
|---|---------|-------|--------|
| 1 | Gamla Wix-URL:er (`/service-page/...`, `/product-page/...`, `/team-4`, `/historia`, `/event`, `/firande`, `/kontakt`, `/kopia-på-hem` m.fl.) kunde ge 404 eller felaktig indexering efter flytten från Wix till Azure. | Server / redirectlager | Förlorat länkvärde, onödiga 404:or, dubbla signaler i Google. |
| 2 | Sitemap saknade en komplett, kanonisk och indexerbar URL-uppsättning. | `public/sitemap.xml` | Långsammare upptäckt, risk att gamla Wix-URL:er låg kvar. |
| 3 | Ingen kontroll av att gamla Wix-URL:er inte hamnade i sitemap eller indexerades. | Sitemap / robots | Risk för dubbletter och utspädda signaler. |
| 4 | Betalnings- och resultatsidor saknade konsekvent `noindex`. | `betalning-klar.html`, `betalning-avbruten.html` | Känsliga/irrelevanta sidor kunde indexeras. |
| 5 | Otydlig hantering av apexdomän → `www` och HTTP → HTTPS. | `server/index.js` | Kanonisk domän kunde spridas över flera värdnamn. |

### Metadata och semantik
| # | Problem | Plats | Effekt |
|---|---------|-------|--------|
| 6 | Flera sidor saknade unika, sökintentsanpassade titlar och metabeskrivningar. | Samtliga publika sidor | Sämre klickfrekvens och otydlig relevans i SERP. |
| 7 | Titlar och beskrivningar riskerade att upprepas mellan sidor. | Flera sidor | Google väljer själv rubrik, risk för kannibalisering. |
| 8 | H1 kunde bli sammansatt utan mellanslag vid radbrytning (`<br>`), t.ex. "Herrgårdtill". | Flera sidor | Försämrad läsbarhet och sämre semantisk signal. |
| 9 | Vissa H1 var generiska och saknade tydlig koppling till sidans ämne. | Flera sidor | Otydligt huvudämne för Google. |
| 10 | Internlänkning var inte konsekvent kontrollerad mellan nav, footer och innehåll. | Flera sidor | Viktiga sidor kunde bli svårare att upptäcka. |

### Strukturerad data och delning
| # | Problem | Plats | Effekt |
|---|---------|-------|--------|
| 11 | Strukturerad data saknades eller var ofullständig för verksamheten. | Startsida och undersidor | Ingen tydlig entity-signal för Google. |
| 12 | `BreadcrumbList` saknades på undersidor. | Undersidor | Sämre navigations- och hierarkisignaler. |
| 13 | Open Graph saknades eller var ofullständig. | Flera sidor | Svag förhandsvisning vid delning på LinkedIn/Facebook. |

### Bilder och prestanda
| # | Problem | Plats | Effekt |
|---|---------|-------|--------|
| 14 | Galleribilder och stora bilder kunde laddas onödigt tungt. | `src/js/images.js`, `public/images/gallery/` | Långsammare LCP, särskilt på mobil. |
| 15 | Alt-texter var inte systematiskt kontrollerade. | Samtliga sidor | Sämre tillgänglighet och bild-SEO. |
| 16 | Mobil prestanda var svag på startsidan (Performance 69, TBT ~3 070 ms). | Startsida | Sämre Core Web Vitals. |

### Innehåll och konsekvens
| # | Problem | Plats | Effekt |
|---|---------|-------|--------|
| 17 | `/kontakt` fungerade som en orelaterad bildsida utan tydlig omdirigering. | `src/pages/kontakt.html` | Felaktig sökintention och dold dubblett. |
| 18 | `/lediga-datum` kunde konkurrera med `/boka`. | `src/pages/lediga-datum.html` | Kannibalisering av samma sökintention. |
| 19 | Brandnamnet förekom inkonsekvent ("Skadevi Gård" vs "Skadevi Herrgård"). | Flera sidor | Otydlig entity-signal. |

---

## 2. Vilka problem som åtgärdades

### Åtgärdat i kodbasen
1. **Legacy Wix-redirects** – central redirectmodul `server/seo/legacy-redirects.js` med 301 för kända sidor och 410 för okända Wix-malladresser utan rimlig ersättare. Kopplad i `server/index.js` och `vite.config.mjs`.
2. **Kanonisk domän** – apexdomän 301-omdirigeras till `www.skadeviherrgard.com`; HTTP → HTTPS hanteras av Azure App Service och verifieras i serverlogiken.
3. **Sitemap** – `public/sitemap.xml` innehåller endast 13 aktiva, kanoniska, indexerbara sidor med verkliga `lastmod`-datum. Inga Wix-URL:er, betalningssidor eller privata routes.
4. **Robots.txt** – `public/robots.txt` tillåter publika sidor, blockerar `/api/` och refererar till sitemap.
5. **Noindex och omdirigering** – betalningssidor (`betalning-klar`, `betalning-avbruten`) har `noindex, nofollow`. `/kontakt` och `/lediga-datum` omdirigeras med 301 till `/boka` i serverlogiken; deras HTML är dessutom `noindex, follow` om filerna nås direkt.
6. **Unika titlar och metabeskrivningar** – samtliga 13 indexerbara sidor har unik titel och unik metabeskrivning (verifierat: 0 dubbletter).
7. **H1-konsistens** – `<br>`-radbrytningar har fått mellanslag så att H1 inte längre sammansätter ord. Visuell radbrytning är oförändrad.
8. **Strukturerad data** – JSON-LD med `WebSite`, `LocalBusiness` + `LodgingBusiness` + `EventVenue`, `WebPage`, `BreadcrumbList`, `FAQPage` (på vanliga frågor) samt `ImageObject`.
9. **Open Graph** – `og:title`, `og:description`, `og:image`, `og:url` och Twitter/X-kort på publika sidor med absoluta bildadresser.
10. **Bilder** – alt-texter på 106 bilder (0 saknade alt), lazy loading på bilder under vikningen, webp-thumbnails för galleriet och 800 px-varianter för sektionsbilder.
11. **Internlänkning** – alla centrala sidor nås från nav och startsida; `/boka` och `/priser` länkas från samtliga sidor.
12. **Prestanda** – minskad bildvikt, lazy loading, förkomprimerade assets (brotli), förbättrad TBT och LCP.
13. **Automatiska tester** – `tests/unit/seo.test.js` och `tests/unit/legacy-redirects.test.js` kontrollerar title/description-unikhet, canonical, robots, sitemap, JSON-LD-syntax och redirects.

### Medvetet ej ändrat
- Visuell design, layout, färger, typsnitt, bildkomposition, meny, animationer, kortdesign och bokningsformulär.
- Stripe, Airbnb, Extrahus, adminportal, bokningslogik, priser, Resend, Logic Apps, DNS och Azure-resurser.
- Befintliga fungerande redirects har bevarats.

---

## 3. Viktiga sökord per sida

| Sida | Huvudämne | Primära sökord | Sekundära sökord |
|------|-----------|----------------|------------------|
| `/` | Hyr hela herrgården | hyra herrgård nära Stockholm, herrgård att hyra | herrgård Uppland, herrgård med övernattning, Skokloster |
| `/foretag` | Konferens & kickoff | konferens med övernattning, konferensgård nära Arlanda, företagskickoff | ledningsgruppsmöte herrgård, konferens nära Stockholm, Uppsala, Västerås |
| `/brollop` | Bröllop med övernattning | bröllopslokal med övernattning, herrgårdsbröllop nära Stockholm | bröllopslokal Uppland, privat bröllopslokal |
| `/fest` | Fest med boende | festlokal med boende, hyra herrgård för fest | möhippa, svensexa, dop, jubileum, Uppland |
| `/semester` | Privat herrgård för familj och vänner | hyra herrgård för familj och vänner, hyra stort hus för familj och vänner | herrgård för större sällskap, semester nära Mälaren |
| `/boende` | Privat boende i Skokloster | hyra privat herrgård i Skokloster, herrgård med övernattning | 7 sovrum, 23 bäddar, exklusivt boende i Skokloster |
| `/aktiviteter` | Aktiviteter på herrgården | aktiviteter herrgård, tennis, badtunna | utflykt Skoklosters slott, femkamp, biljard |
| `/mat-dryck` | Mat & dryck | catering herrgård, laga mat tillsammans | Sjökrogen Skokloster, herrgårdskök |
| `/priser` | Priser för att hyra herrgård | priser hyra herrgård | bröllopspaket, övernattning 23 gäster |
| `/om-oss` | Herrgårdens historia | Skadevi Herrgård historia, herrgård från 1927 | Häggeby, Uppland, Rebecka och Daniel Persson |
| `/vanliga-fragor` | Bokning och praktiska frågor | vanliga frågor hyra herrgård | bokning, städning, husdjur, in- och utcheckning |
| `/digital-visning` | Digital 3D-visning | digital visning herrgård, 3D-visning | virtuell rundtur |
| `/boka` | Direktbokning | boka Skadevi Herrgård, lediga datum | boka herrgård online |

**Sidorna är avsiktligt avgränsade:** varje sida har ett eget huvudämne och ingen sida konkurrerar med en annan om exakt samma sökintention. `/kontakt` och `/lediga-datum` omdirigeras med 301 till `/boka` och finns därför inte med i sitemap.

---

## 4. Nya sidtitlar och metabeskrivningar

| Sida | Titel | Metabeskrivning |
|------|-------|-----------------|
| `/` | Hyr herrgård nära Stockholm \| Skadevi Herrgård | Hyr hela Skadevi Herrgård nära Stockholm, Uppsala och Arlanda. 23 bäddar, tennisbana, badtunna och pergola för konferens, bröllop, fest och semester. |
| `/foretag` | Konferens & kickoff med övernattning \| Skadevi Herrgård | Konferens, kickoff och ledningsgruppsmöten med övernattning i egen herrgård. 23 bäddar, projektor och bioduk, 25 min från Arlanda. |
| `/brollop` | Bröllopslokal med övernattning i Uppland \| Skadevi Herrgård | Fira bröllop med övernattning på en privat herrgård i Uppland. Pergola för 40 gäster, 23 bäddar och plats för vigsel, middag och dans. |
| `/fest` | Festlokal med boende i Uppland \| Skadevi Herrgård | Festlokal med boende i Uppland för möhippa, svensexa, födelsedag, dop och jubileum. Hyr hela herrgården med pergola och 23 bäddar. |
| `/semester` | Hyr herrgård för familj och vänner \| Skadevi Herrgård | Semester i egen herrgård nära Mälaren och Skokloster. Tennis, badtunna, lekplats och plats för familj och vänner. Se lediga datum. |
| `/boende` | Hyra privat herrgård i Skokloster \| Skadevi Herrgård | Hyr en privat herrgård i Skokloster med 7 sovrum och 23 bäddar, fullt utrustat kök, biljard och stora sällskapsytor. Hela gården blir er. |
| `/aktiviteter` | Aktiviteter på Skadevi Herrgård – tennis & badtunna | Tennis, femkamp, biljard, badtunna och utflykter till Skoklosters slott. Upptäck aktiviteterna på Skadevi Herrgård nära Mälaren. |
| `/mat-dryck` | Catering & mat i herrgårdsköket \| Skadevi Herrgård | Laga mat tillsammans i herrgårdens kök eller beställ catering från Sjökrogen Skokloster med 10 % gästrabatt. Se utrustning och matställen. |
| `/priser` | Priser för att hyra herrgård \| Skadevi Herrgård | Se priser för att hyra hela Skadevi Herrgård: semester, företag och event. Övernattning för 23 gäster, tillval och färdiga bröllopspaket. |
| `/om-oss` | Om Skadevi Herrgård – herrgården från 1927 | Skadevi Herrgård i Häggeby har anor från medeltiden och en huvudbyggnad från 1927. Läs om gården, miljön och ägarna Rebecka och Daniel Persson. |
| `/vanliga-fragor` | Vanliga frågor om att hyra herrgården \| Skadevi Herrgård | Svar om bokning, priser, in- och utcheckning, städning, husdjur och vägen till Skadevi Herrgård i Häggeby nära Skokloster. |
| `/digital-visning` | Digital visning av Skadevi Herrgård i 3D | Upptäck Skadevi Herrgård i en interaktiv 3D-visning. Vandra genom rum, sovrum och trädgård innan du bokar din vistelse. |
| `/boka` | Boka Skadevi Herrgård – se lediga datum | Boka Skadevi Herrgård: välj datum, se totalpris och betala med kort eller skicka en bokningsförfrågan. Se lediga datum i kalendern. |

**Icke-indexerbara sidor (avsiktligt):**
- `/betalning-klar` – `noindex, nofollow`
- `/betalning-avbruten` – `noindex, nofollow`
- `/kontakt` – 301 till `/boka` i serverlogiken (HTML-filen är dessutom `noindex, follow`)
- `/lediga-datum` – 301 till `/boka` i serverlogiken (HTML-filen är dessutom `noindex, follow`)
- `/404` – `noindex, follow`

---

## 5. Gamla Wix-URL:er och deras redirects

Källa: `server/seo/legacy-redirects.js`. Statuskoder verifierade med serveranrop.

### 301 – verklig ersättningssida finns
| Gammal URL | Ny URL | Status |
|------------|--------|--------|
| `/about-1` | `/brollop` | 301 |
| `/team-4` | `/aktiviteter` | 301 |
| `/services-7` | `/vanliga-fragor` | 301 |
| `/dopochbabyshower` | `/fest` | 301 |
| `/copy-of-dop-babyshower` | `/fest` | 301 |
| `/firande` | `/fest` | 301 |
| `/event` | `/fest` | 301 |
| `/historia` | `/om-oss` | 301 |
| `/faciliteter` | `/boende` | 301 |
| `/matochdryck` | `/mat-dryck` | 301 |
| `/the-suite` | `/boende` | 301 |
| `/bilder` | `/` (aktuellt bildgalleri på startsidan) | 301 |
| `/book-online` | `/boka` | 301 |
| `/kopla-pa-hem` | `/` (Search Console-dubblett av startsidan) | 301 |
| `/kopia-pa-hem` | `/` (ASCII-variant av samma dubblett) | 301 |
| `/kopia-på-hem` | `/` | 301 |
| `/kopia-på-utrustning-service` | `/digital-visning` | 301 |

### Wix-malladresser
- `/service-page/...` och `/product-page/...` matchas mot nyckelord i sluggen (brollop, konferens, fest, boende, mat, aktivitet, pris, kontakt, boka, historia, faq, visning).
- Känd ämnesmässig matchning → **301** till närmast relevanta sida.
- Okänd slug utan rimlig ersättare → **410 Gone** (inte omdirigerad till startsidan, för att undvika felaktiga signaler).
- Search Console-rapporterade `/product-page/foretagsevent-upp-till-24-pers-2` → **301** till `/foretag` (företagsevent har sin motsvarighet där).

### Principer
- Inga massredirects till startsidan eller `/boka`.
- Inga redirect-kedjor eller loopar.
- Befintliga fungerande redirects bevarade.
- Gamla Wix-URL:er förekommer inte i sitemap eller i byggd `dist`.

---

## 6. Strukturerad data som implementerades

### Startsida (`src/index.html`)
JSON-LD `@graph` med:
- **WebSite** – `url`, `name`, `inLanguage: sv-SE`.
- **LocalBusiness + LodgingBusiness + EventVenue** – `name`, `alternateName` ("Skadevi Gård"), `description`, `url`, `logo`, `image`, `telephone: +46702730422`, `email: skadevigard@gmail.com`, `address` (Skoklostervägen 16, 746 94 Häggeby, Sverige), `geo`, verifierade uppgifter och `sameAs` där verifierade profiler finns.
- **WebPage** – kopplad till `#website` och `#business`.

### Undersidor
- **WebPage** med `name`, `description`, `isPartOf`, `inLanguage`, `primaryImageOfPage`.
- **BreadcrumbList** med `ListItem` (position, name, item) på alla indexerbara undersidor.
- **FAQPage** med `Question` och `Answer` på `/vanliga-fragor`.

### Validering
- JSON-LD-syntax kontrollerad via `tests/unit/seo.test.js` och manuell JSON-parse.
- Inga påhittade betyg, recensioner, priser eller erbjudanden i markup.
- Ingen `VacationRental`-markup har lagts in (kräver särskild behörighet och tekniska krav).

---

## 7. Prestanda före och efter

**Mätmetod:** Lighthouse (labbdata, mobil emulering) mot byggd sajt. Värden är inte fältdata (CrUX) och ska inte tolkas som verkliga användarmätningar.

| Sida | Mätning | Performance | SEO | Accessibility | Best Practices | FCP | LCP | TBT | CLS |
|------|---------|-------------|-----|---------------|----------------|-----|-----|-----|-----|
| Startsida | Före | 69 | 92 | 100 | 100 | 1.0 s | 2.1 s | 3 070 ms | 0 |
| Startsida | Efter | **96** | **100** | 100 | 100 | 0.9 s | 2.1 s | **190 ms** | 0 |
| Företag | Före | 89 | 100 | 100 | 100 | 1.0 s | 3.8 s | 20 ms | 0 |
| Företag | Efter | 89 | 100 | 100 | 100 | 0.9 s | 3.8 s | 0 ms | 0 |
| Boka | Före | 91 | 100 | 100 | 96 | 0.9 s | 2.4 s | 310 ms | 0.015 |
| Boka | Efter | **96** | 100 | 100 | 96 | 1.0 s | 2.5 s | **150 ms** | 0 |

**Råfiler:** `manual-granskning/seo-before/*.json` och `manual-granskning/seo-after/*.json`.

### Åtgärder som gav effekt
- Webp-thumbnails för galleriet (11 st) och 800 px-varianter för sektionsbilder.
- Lazy loading på bilder under vikningen; `fetchpriority="high"` på hero.
- Förkomprimerade assets (brotli).
- Minskad bildvikt och färre tunga resurser vid första rendering.
- Oförändrad design och layout.

### Kvarstående prestandanotering
- Företagssidans LCP ligger kvar på 3.8 s (samma före/efter) – hero-bilden är tung. Rekommenderas som framtida optimering (se punkt 12).
- `src=""` på JS-laddade bilder kan ge en extra förfrågan i vissa webbläsare; åtgärdas försiktigt i framtiden utan att ändra bildflödet.

---

## 8. Vad ägaren behöver göra i Google Search Console

1. **Verifiera egenskapen** `https://www.skadeviherrgard.com` (domän- eller URL-prefix-egenskap).
2. **Skicka in sitemap** `https://www.skadeviherrgard.com/sitemap.xml` under *Sitemaps*.
3. **Begär indexering** för de 13 indexerbara sidorna via *URL-inspektion* → *Begär indexering* (särskilt startsida, `/foretag`, `/brollop`, `/boende`, `/boka`).
4. **Kontrollera sidor-rapporten** efter 1–2 veckor:
   - Inga gamla Wix-URL:er med 404/410 som får trafik utan rimlig redirect.
   - Inga oavsiktliga `noindex` på publika sidor.
   - Inga dubbletter eller felaktiga canonical-värden.
5. **Kontrollera Core Web Vitals** när fältdata finns (CrUX) – jämför med labbdata ovan.
6. **Kontrollera förfrågningsstatistik** för de prioriterade sökintentionerna och justera innehåll där det behövs.

---

## 9. Vad ägaren behöver göra i Google Business Profile

1. **Verifiera/anspråkta profilen** för Skadevi Herrgård med adressen Skoklostervägen 16, 746 94 Häggeby, Sverige.
2. **Kontrollera NAP-konsekvens** (namn, adress, telefon) mot webbplatsen:
   - Telefon: +46 70 273 04 22
   - E-post: skadevigard@gmail.com
3. **Lägg in rätt kategori** (t.ex. eventlokal/konferensanläggning/uthyrning av semesterboende) och verifiera att den matchar verksamheten.
4. **Ladda upp representativa bilder** (herrgården, pergola, rum, tennisbana, badtunna) med beskrivande filnamn.
5. **Länka till rätt landningssida** – startsida eller `/boka` beroende på primär intention.
6. **Öppettider och tjänster** – ange endast verifierade uppgifter.
7. **Be om recensioner** från verkliga gäster – publicera aldrig påhittade omdömen.
8. **Publicera uppdateringar** inför säsong och evenemang.

---

## 10. Rekommendationer för relevanta externa länkar

Bygg länkar genom verkligt värde, inte köpta eller massproducerade. Förslag:
- **Lokala turism- och besökssajter** i Uppland/Skokloster-området.
- **Bröllops- och eventguider** med redaktionell granskning.
- **Konferens- och mötesguider** för Stockholm/Uppsala/Arlanda-regionen.
- **Lokala näringslivs- och företagsnätverk** i Enköping, Bålsta och Uppsala.
- **Samarbetspartners** (catering, aktivitetsarrangörer, lokala leverantörer) med relevanta länkar.
- **Branschorganisationer** för hotell/boende/event där medlemskap är verifierat.

Undvik:
- Länkkataloger utan redaktionell kvalitet.
- Betalda länkpaket.
- Länkar från orelaterade sajter.
- Länkblock i sidfoten som upprepas på varje sida.

---

## 11. Eventuella innehålls- och informationsluckor

Följande uppgifter har **inte** lagts in eftersom de inte kunde verifieras i projektet eller på den publicerade webbplatsen. Ägaren bör verifiera och komplettera:
1. **Exakt gästkapacitet** för olika evenemangstyper (bröllop, konferens, fest) – nu används 23 bäddar och pergola för 40 gäster.
2. **Antal sovrum** – 7 sovrum anges på `/boende`; säkerställ att det stämmer med alla sidor.
3. **Restider** – "25 min från Arlanda" används; verifiera och komplettera med restider från Stockholm, Uppsala och Västerås.
4. **Aktiviteter och tjänster** – verifiera vilka aktiviteter som faktiskt erbjuds och om de är inkluderade eller tillval.
5. **Tillgänglighet** – eventuell information om rullstolsanpassning och tillgängliga rum saknas.
6. **Parkeringsmöjligheter** – antal platser och förutsättningar.
7. **Priser och paket** – säkerställ att `/priser` och bokningssystemet visar samma villkor.
8. **Recensioner och omdömen** – inga påhittade omdömen används; verkliga omdömen kan lyftas in när de finns.
9. **Certifieringar och medlemskap** – endast verifierade uppgifter.
10. **Bildgalleri** – `/kontakt` fungerar som bildsida men är noindex; överväg att göra ett tydligt, indexerbart galleri om det är affärsmässigt relevant.

**Motsägelser:** `brollop.html` angav tidigare "24 bäddar" medan övriga sidor anger 23. Detta är enhetligat till 23 bäddar i denna omgång.

---

## 12. Prioriterade framtida förbättringar

1. **Företagssidans LCP** – optimera hero-bilden (t.ex. mindre variant, bättre komprimering) för att sänka LCP från 3.8 s.
2. **Bildadresser i `src=""`** – ersätt med en liten platshållare eller `srcset` för att undvika extra förfrågan, utan att ändra bildflödet.
3. **Per-sida Open Graph-bilder** – använd representativa bilder per sida i stället för en gemensam `og-startsida.jpg`.
4. **Fältdata (CrUX)** – följ upp verkliga Core Web Vitals när data finns.
5. **Innehållsfördjupning** – komplettera med verifierade uppgifter om kapacitet, restider och aktiviteter.
6. **Internlänkar i brödtext** – lägg naturliga länkar mellan relaterade sidor (t.ex. `/boende` → `/priser` → `/boka`).
7. **Bild- och videogalleri** – överväg ett indexerbart galleri med beskrivande alt-texter.
8. **Schema-utökning** – överväg `Event`-markup för planerade evenemang när verifierade datum finns.
9. **Lokala landningssidor** – endast om innehållet är genuint och hjälpsamt; undvik massproducerade geografiska sidor.
10. **Prestandabudget i CI** – lägg till Lighthouse-kontroll i CI för att fånga regressioner.

---

## Åtgärder som kräver kontoinloggning eller manuellt godkännande

Dessa kan **inte** göras i kodbasen och kräver ägarens konto eller godkännande:

- [ ] Verifiera webbplatsen i Google Search Console och skicka in sitemap.
- [ ] Begära indexering av prioriterade sidor i Search Console.
- [ ] Verifiera/anspråkta Google Business Profile och uppdatera NAP, kategorier och bilder.
- [ ] Kontrollera och uppdatera verifierade uppgifter (kapacitet, restider, aktiviteter, priser).
- [ ] Publicera/deploya ändringarna till Azure App Service `hemsida-skadevi-prod` (sker via push till `main` och GitHub Actions).
- [ ] Granska fältdata (CrUX) när den finns tillgänglig.
- [ ] Bygga externa länkar och kontakta relevanta lokala/branschspecifika sajter.
- [ ] Eventuell justering av DNS – ska inte göras utan separat godkännande.
- [ ] Eventuella ändringar i Stripe Live, Airbnb, Extrahus, Resend eller Logic Apps – utanför detta arbete.

---

## Verifiering och tester

- `npm run lint` – godkänd.
- `npm test` – 442 tester, 0 fel.
- `node --test tests/unit/seo.test.js tests/unit/legacy-redirects.test.js` – 12 tester, 0 fel.
- `npm run build` – godkänd; `dist/sitemap.xml` och `dist/robots.txt` finns; inga Wix-URL:er i `dist`.
- Metadata: 0 dubbletter av titlar och metabeskrivningar.
- Bilder: 106 bilder, 0 saknade alt-texter.
- JSON-LD: giltig syntax på samtliga kontrollerade sidor.
- Visuell jämförelse: design oförändrad (desktop och mobil).
