# Skadevi Gård — Full Strategic Audit & Roadmap

**Date**: 2026-05-22
**Scope**: Website audit, competitive analysis, persona development, content strategy
**Current site**: skadeviherrgard.com (Wix, custom domain)

---

## Part 1: Website Technical & UX Audit

### 1.1 Lighthouse Performance Scores

Lighthouse 12.x audit via headless Chrome, simulated throttling (mobile):

| Metric | Value | Threshold | Status |
|---|---|---|---|
| **FCP** (First Contentful Paint) | 3.9 s | < 1.8 s | ❌ Critical |
| **LCP** (Largest Contentful Paint) | 5.2 s | < 2.5 s | ❌ Critical |
| **TBT** (Total Blocking Time) | 230 ms | < 200 ms | ⚠️ Warning |
| **CLS** (Cumulative Layout Shift) | 0.00 | < 0.1 | ✅ Pass |

**Verdict**: The site fails Core Web Vitals. Google uses these as ranking signals. LCP at 5.2s is more than double the threshold — this alone warrants platform migration.

**Root causes** (from trace analysis):
1. Wix Thunderbolt renderer loads heavy JS before any content renders (~500KB+ of framework JS)
2. No server-side rendering — content is client-side rendered via JS
3. Render-blocking CSS from Wix's CDN (static.parastorage.com)
4. Multiple polyfills loaded synchronously (core-js, focus-within, Intl.Segmenter)
5. Wix dynamic model fetch blocks rendering pipeline

### 1.2 Technical Audit Findings

| Issue | Severity | Impact |
|---|---|---|
| `<html lang="en">` on Swedish content | Critical | Misleads search engines + screen readers |
| No `<meta name="description">` on homepage | Critical | Zero SERP snippet control |
| No Open Graph / Twitter Card tags | High | Social sharing renders as plain URL |
| No Schema.org structured data | High | Missing rich results in SERP (star ratings, FAQ, LocalBusiness) |
| No `rel=canonical` on any page | High | Duplicate content risk |
| No XML sitemap referenced | High | Crawl efficiency reduced |
| Wix template placeholder text on 4+ pages | Critical | "Ashley Jones - Art Director", "Exclusive Services" etc. live on production |
| "Kopia på Hem" (copy of home) in navigation | High | Unprofessional, SEO dilution |
| "Rullgardinsmeny" visible in menu | High | Visible Wix editing artifact |
| 18-item navigation with duplicate/empty pages | High | Cognitive overload, violates 7±2 rule |
| Facebook link goes to search results, not profile | Medium | Broken social trust signal |
| FAQ page entirely Wix placeholder | Critical | High-intent page delivers zero value |
| No cookie consent banner (GDPR) | Critical | Legal compliance risk |
| Utrustning & Service page empty | High | Linked from main nav, delivers nothing |
| ReviewsJet widget loads external JS | Medium | Third-party performance impact |
| 904KB+ truncated HTML response | Medium | Excessive DOM size, Wix runtime overhead |
| Revision #280 — frequent unpublished edits | Medium | Indicates active but incomplete development |

### 1.3 UX Heuristic Audit (Nielsen's 10 Heuristics)

#### H1: Visibility of System Status — FAIL
- No loading indicators between page navigations (Wix SPA transitions without feedback)
- Contact form submission has success state ("Tack för ditt meddelande!") ✅ but no loading state

#### H2: Match Between System and Real World — PARTIAL
- Swedish content on most pages ✅
- Wix template English filler text ("Exclusive Services", "The Art of Restful Design") breaks immersion ❌
- "LEDIGA DATUM" (available dates) button leads to nothing actionable ❌

#### H3: User Control and Freedom — FAIL
- No back-button preservation on anchor-based navigation
- No clear way to return to homepage from deep pages (except logo)
- "BOKA" button goes to Kontakt page, not a booking flow ❌

#### H4: Consistency and Standards — FAIL
- Two separate navigation systems (sticky top nav + hamburger menu) with different items
- Inconsistent URL slugs: `about-1` = Bröllop, `team-4` = Aktiviteter, `services-7` = FAQ
- Mixed page structures: some have hero images, some don't; some have pricing, some don't

#### H5: Error Prevention — PARTIAL
- Contact form has basic field validation ✅
- No inline validation on email/phone format ❌

#### H6: Recognition Rather Than Recall — PARTIAL
- Navigation labels are generally clear ✅
- But 18 items exceeds cognitive capacity ❌

#### H7: Flexibility and Efficiency of Use — FAIL
- No search functionality
- No filtering of available dates
- No "quick book" pathway for returning customers
- No keyboard shortcuts or power-user features

#### H8: Aesthetic and Minimalist Design — PARTIAL
- Photography is good quality ✅
- But Wix template artifacts and inconsistent spacing reduce perceived quality ❌
- Color palette is inconsistent across pages

#### H9: Help Users Recognize, Diagnose, and Recover from Errors — FAIL
- No custom 404 page
- Form errors use default browser styling
- No FAQ content to preempt common questions

#### H10: Help and Documentation — FAIL
- FAQ page is empty Wix template
- No chat widget
- Contact info buried in footer

### 1.4 Content Audit

| Page | Content Status | Quality |
|---|---|---|
| Hem (Home) | Good baseline content, clear value props | 7/10 |
| Event | Good overview, clear subcategories | 7/10 |
| Bröllop | **Excellent** — detailed, inventory list, pricing, wedding packages | 9/10 |
| Företag | **Excellent** — detailed facilities, activities, nearby excursions | 9/10 |
| Semester | Thin — mostly placeholder images, minimal text | 3/10 |
| Fest | **Empty** — only a single stock photo | 0/10 |
| Lokal (Dop/Babyshower) | Good starter content | 6/10 |
| Mottagning | **Empty** — no content | 0/10 |
| Boende | **Excellent** — detailed room layout, kitchen inventory | 9/10 |
| Bilder | Photo gallery only, no captions or context | 5/10 |
| Aktiviteter | **Excellent** — comprehensive local guide with categories | 9/10 |
| Mat & Dryck | Good — clear food options, partner mention | 7/10 |
| Utrustning & Service | **Empty** | 0/10 |
| Om oss / Historia | **Excellent** — rich historical narrative | 8/10 |
| Kontakt | Good — form + map + contact info | 7/10 |
| Vanliga frågor | **Completely empty** — Wix template filler | 0/10 |
| Digital Tour | **Empty** — no content | 0/10 |

**Content vulnerability**: 5 of 17 pages (~29%) have no real content. These are linked from the main navigation, creating dead ends.

### 1.5 SEO Audit

| Factor | Current | Recommended |
|---|---|---|
| Title tag | Not visible (Wix dynamic) | "Skadevi Gård | Hyr privat herrgård nära Stockholm — konferens, bröllop & semester" |
| Meta description | Missing | "Hyr en hel privat herrgård 45 min från Stockholm. Perfekt för konferens, bröllop, fest & semester. Tennisbana, badtunna, 23 bäddar. Från 9 000 kr/natt." |
| H1 | "Privat Herrgård Till Konferens & Bröllop" | Good, but should include location |
| Hreflang | Missing entirely | Add `sv-SE` |
| Structured Data | None | Add: LocalBusiness, FAQPage (when FAQ exists), Product, BreadcrumbList, Review |
| Image alt text | Mostly on Wix auto-generated | Needs manual review for keyword relevance |
| Internal linking | Weak — no contextual cross-links | Link "Boende" from "Företag", link "Aktiviteter" from "Semester" |
| URL structure | Inconsistent slugs (`about-1`, `team-4`, `services-7`) | Use semantic slugs: `/brollop`, `/aktiviteter`, `/vanliga-fragor` |
| robots.txt | Wix default | Acceptable for Wix, needs custom on new platform |
| Page speed | LCP 5.2s | Needs >60% improvement |

### 1.6 Priority Remediation Matrix (ICE Scored)

| # | Issue | Impact (1-10) | Confidence (1-10) | Ease (1-10) | ICE Score | Action |
|---|---|---|---|---|---|---|
| 1 | Platform migration off Wix | 10 | 9 | 3 | 270 | Build new site |
| 2 | Fix lang attribute + meta description | 8 | 10 | 10 | 800 | Quick fix |
| 3 | Remove template placeholder content | 9 | 10 | 8 | 720 | Content cleanup |
| 4 | Add Schema.org structured data | 8 | 10 | 7 | 560 | Implementation |
| 5 | Fix navigation (remove duplicates, reorder) | 7 | 10 | 7 | 490 | IA restructure |
| 6 | Populate FAQ page | 9 | 9 | 6 | 486 | Content creation |
| 7 | Add Open Graph / Twitter Cards | 6 | 10 | 9 | 540 | Quick implementation |
| 8 | Populate empty pages (Fest, Utrustning, etc.) | 8 | 9 | 5 | 360 | Content creation |
| 9 | Fix social media links | 5 | 10 | 10 | 500 | Quick fix |
| 10 | Add proper booking flow / calendar | 9 | 8 | 3 | 216 | Feature development |

---

## Part 2: Competitive Deep-Dive

### 2.1 Competitive Landscape Map

```
                    HIGH PRICE / LUXURY
                          │
          Häringe Slott   │   Rosersbergs Slottshotell
          (from ~2,500kr  │   (from ~1,500kr/room)
           /room)         │
                          │
   HOTEL MODEL ──────────┼────────── EXCLUSIVE RENTAL MODEL
   (per-room booking)    │          (whole property)
                          │
          Näsby Slott     │   ★ SKADEVI GÅRD ★
          (from ~1,200kr  │   (9,000-15,000kr/night
           /room)         │    entire property)
                          │
          Hesselby Slott  │
          (from ~1,000kr  │
           /room)         │
                          │
                    LOW PRICE / ACCESSIBLE
```

### 2.2 Competitor Profiles

#### A. Rosersbergs Slottshotell — *Direct competitor for corporate*

| Factor | Details |
|---|---|
| **Location** | Rosersberg, 10 min from Arlanda |
| **Model** | Hotel + conference (64 rooms, per-room booking) |
| **Corporate focus** | Conferences up to 100 people, "Takeover" option available |
| **Weddings** | Yes — drop-in vigsel events |
| **Restaurant** | French-inspired, award-winning kitchen |
| **USP** | Royal castle (Karl XIV Johan's summer residence), Svanen eco-label |
| **Network** | Part of Stockholm Meeting Selection (12 properties) |
| **Pricing** | From ~1,500 SEK/room/night; conference packages on request |
| **Website quality** | WordPress, professional, schema markup, good SEO |
| **Instagram** | Active, professional content, 5K+ followers |
| **Threat to Skadevi** | HIGH — same Arlanda proximity, royal brand, larger capacity, established sales org |

#### B. Häringe Slott — *Direct competitor for high-end weddings*

| Factor | Details |
|---|---|
| **Location** | Västerhaninge, 25 min south of Stockholm |
| **Model** | Hotel + restaurant + events |
| **Capacity** | Hotel rooms (per-room), events for larger groups |
| **USP** | 17th-century stone castle, "Häringe is yours, Baby" (Axel Wenner-Gren), pool, nature reserve adjacent |
| **Website quality** | Drupal, professional photography, excellent content marketing |
| **Pricing** | Premium — hotel rooms from ~2,500 SEK/night |
| **Threat to Skadevi** | MEDIUM — different price tier (luxury), but competes for the Stockholm wedding market |

#### C. Näsby Slott — *Direct competitor for boutique experience*

| Factor | Details |
|---|---|
| **Location** | Täby, 15 min from Stockholm City |
| **Model** | Boutique hotel + conference + wellness |
| **USP** | "Festernas slott" (The party castle), 1920s vibe, wellness with sauna/pool, 4 restaurants on-site, bakery |
| **Website quality** | Excellent — WordPress, rich content, events calendar, newsletter, Instagram integrated |
| **Social** | Active Instagram, strong brand voice |
| **Corporate** | "Takeover" option for exclusive use, coworking spaces |
| **Threat to Skadevi** | MEDIUM-HIGH — better polished, professional, but different model (hotel vs exclusive rental) |

#### D. Hesselby Slott — *Niche competitor (music angle)*

| Factor | Details |
|---|---|
| **Location** | Hässelby, western Stockholm |
| **Model** | Hotel + conference + music venue |
| **USP** | "Sveriges musikslott" — artist-themed rooms (Avicii, Zara Larsson, etc.), live music events, pottery studio |
| **Threat to Skadevi** | LOW-MEDIUM — different niche, but competes for Stockholm corporate events |

#### E. Skytteholm — *Niche competitor (spa/nature)*

| Factor | Details |
|---|---|
| **Location** | Ekerö, 35 min from Stockholm |
| **Model** | Hotel + conference + Nordic Spa + golf |
| **USP** | Nature-immersive spa, Mälaren waterfront, golf course |
| **Threat to Skadevi** | LOW — different focus (spa/golf), no exclusive whole-property rental |

### 2.3 Competitive Gap Analysis — Skadevi's Position

| Capability | Skadevi | Rosersberg | Häringe | Näsby | Hesselby | Skytteholm |
|---|---|---|---|---|---|---|
| **Exclusive whole-property rental** | ✅ YES | ⚠️ "Takeover" | ❌ No | ⚠️ "Takeover" | ⚠️ "Abonnera" | ⚠️ "Takeover" |
| **Arlanda <30 min** | ✅ 25 min | ✅ 10 min | ❌ 60 min | ❌ 30 min | ❌ 35 min | ❌ 50 min |
| **Below 15,000 SEK/night total** | ✅ Yes | ❌ Per-room | ❌ Per-room | ❌ Per-room | ❌ Per-room | ❌ Per-room |
| **Self-catering option** | ✅ Yes | ❌ Restaurant only | ❌ Restaurant only | ❌ Restaurant only | ❌ Restaurant only | ❌ Restaurant only |
| **Tennis court** | ✅ Yes | ❌ | ❌ | ❌ | ❌ | ❌ |
| **Wedding packages** | ✅ 8 themes | ❌ | ✅ Yes | ✅ Yes | ✅ Yes | ✅ Yes |
| **Child-friendly (playground)** | ✅ Yes | ❌ | ❌ | ❌ | ❌ | ❌ |
| **3D virtual tour** | ✅ Yes | ❌ | ❌ | ❌ | ❌ | ❌ |
| **Professional website** | ❌ Wix | ✅ WP | ✅ Drupal | ✅ WP | ✅ WP | ✅ WP |
| **Active social media** | ⚠️ Low | ✅ Strong | ✅ Good | ✅ Strong | ✅ Good | ✅ Strong |
| **Spa / wellness** | 🚧 Coming | ❌ | ❌ | ✅ Yes | ❌ | ✅ Yes |
| **Eco-certification** | ❌ | ✅ Svanen | ✅ Svanen | ✅ Svanen | ✅ Svanen | ✅ Svanen |

### 2.4 Skadevi's Unique Competitive Moat

No single competitor offers the combination of:
1. **Exclusive whole-property rental at accessible pricing** (the "Takeover" options at competitors are premium-priced corporate add-ons, not the core model)
2. **Self-catering flexibility** — every competitor forces their restaurant/catering
3. **Family-friendly at scale** — playground, toys, baby items, dog-friendly
4. **Sports facilities** — private tennis, billiards, soon sauna+gym
5. **Central Swedish location** — equidistant from 5 cities + Arlanda

**The gap Skadevi fills**: "A private manor experience at Airbnb pricing with hotel-grade amenities"

### 2.5 Competitive Threats to Monitor

1. **Stockholm Meeting Selection network** — their 12-property portfolio gives them massive cross-selling power and corporate sales infrastructure Skadevi can't match individually
2. **Airbnb Luxe /高端 private rentals** — the "luxury whole-home rental" market on Airbnb is growing; professional hosts with multiple properties could enter
3. **Rosersberg's Arlanda proximity** — at 10 min (vs Skadevi's 25 min), they win on airport convenience for international corporate groups

---

## Part 3: Persona Development

### Persona A: "Ledningsgrupp-Lars" (Corporate Decision-Maker)

| Attribute | Detail |
|---|---|
| **Name** | Lars, 48 |
| **Role** | VP / Head of Department, medium-large Swedish company |
| **Company** | Tech, consulting, or industrial (e.g., Microsoft, Telia, Intersport pattern) |
| **Location** | Stockholm, Uppsala, or Västerås office |
| **Budget** | 15,000-25,000 SEK total for 1-2 night offsite |
| **Decision power** | Has budget authority for team events up to ~30,000 SEK |
| **Goals** | Annual strategy offsite, quarterly leadership alignment, team kickoff |
| **Pain points** | "Conference hotels feel sterile and corporate." "Everyone commutes home after — there's no real bonding." "Hard to find a place where we can work AND relax." |
| **JTBD** | "When I need to get my leadership team out of the office to align on strategy AND build real relationships, I hire a private venue where we can work seriously during the day and bond over dinner, billiards, and the hot tub at night — all without anyone commuting home." |
| **Channel** | Google search ("konferens nära Stockholm", "kickoff herrgård", "ledningsgruppsmöte"), LinkedIn, word of mouth, corporate procurement |
| **Key objections** | "Is it professional enough for our board?" "Do they have proper AV equipment?" "Can they handle dietary requirements?" |
| **Conversion trigger** | Seeing the Jabra puck + projector + whiteboard listed (work credibility) AND the hot tub + billiards (social credibility) in the same place |

### Persona B: "Brudpar-Bianca" (Wedding Couple)

| Attribute | Detail |
|---|---|
| **Name** | Bianca & Erik, both 31 |
| **Location** | Stockholm (Södermalm/Kungsholmen) |
| **Budget** | 80,000-150,000 SEK total wedding budget |
| **Decision power** | Joint decision with partner |
| **Guest count** | 35-50 people |
| **Goals** | "A wedding that feels like US — not a wedding factory." Weekend-long celebration where closest friends and family stay together. |
| **Pain points** | "Every venue we've looked at kicks us out by 1 AM." "We want to self-cater some meals but venues force their expensive packages." "We want our friends to stay over, not drive home." |
| **JTBD** | "When we want our wedding to feel personal, intimate, and span an entire weekend with our closest 40 people, we hire a private manor where we can do things our way — self-cater some meals, book catering for the big dinner, have lawn games, ceremony in the orchard, and everyone stays under one roof." |
| **Channel** | Instagram, Pinterest, Google ("bröllop herrgård Stockholm", "privat bröllopslokal"), wedding blogs, Förlovningsgrupper på Facebook |
| **Key objections** | "Is it too far for guests?" "What if it rains?" (pergola + indoor space = answer) "Can we see it before booking?" (3D tour = answer) |
| **Conversion trigger** | The 3D virtual tour + the wedding inventory list + the fact they can self-cater = solves the three biggest purchase anxieties |

### Persona C: "Festfixar-Frida" (Celebration Organizer)

| Attribute | Detail |
|---|---|
| **Name** | Frida, 34 |
| **Role** | Best friend / maid of honor / family organizer |
| **Occasion** | Planning a 40th birthday, bachelorette party, or family reunion |
| **Group size** | 15-25 people |
| **Budget** | 1,500-3,000 SEK per person for the weekend |
| **Goals** | "Create an unforgettable weekend where everyone is together, not scattered across hotels." |
| **Pain points** | "Splitting costs across 20 people is a nightmare." "Most places are too small for our whole group." "Restaurants can't seat 20 people comfortably." |
| **JTBD** | "When I'm planning a milestone celebration for our group of 20, I hire a private place big enough for everyone to sleep over, with a great kitchen where we can cook together, and activities so nobody gets bored." |
| **Channel** | Google ("fira födelsedag herrgård", "möhippa nära Stockholm"), word of mouth, Airbnb |
| **Conversion trigger** | The 170 sqm pergola + long tables for 60 + kitchen inventory list = "we can actually host everyone here" |

### Persona D: "Semester-Sofia" (Family Vacation Planner)

| Attribute | Detail |
|---|---|
| **Name** | Sofia, 41 |
| **Family** | 2 adults, 3 kids (ages 4-11), often with grandparents or another family |
| **Location** | Stockholm suburb |
| **Budget** | 9,000-12,000 SEK for 2-3 night stay (split between families) |
| **Goals** | "A summer or autumn break where both kids and adults have fun — without flying anywhere." |
| **Pain points** | "Hotels mean separate rooms and no shared space." "Vacation rentals are either tiny cabins or massive expensive villas." "Kids get bored without activities." |
| **JTBD** | "When we want a countryside getaway with another family where the kids can run free and the adults can relax, we hire a place with a playground, tennis court, and hot tub — close enough to Stockholm that the drive doesn't ruin the weekend." |
| **Channel** | Google ("semester nära Stockholm barnvänligt", "hyra herrgård familj"), Facebook family groups, Instagram |
| **Key objections** | "Is it safe for small kids?" (stairs, water, etc.) "What if weather is bad?" |
| **Conversion trigger** | Commercial-grade playground with safety surfaces + indoor toys + SUP boards + nearby beach = all-weather family appeal |

### Persona E: "Event-Erik" (Corporate Event Planner / PA)

| Attribute | Detail |
|---|---|
| **Name** | Erik (different Erik), 37 |
| **Role** | Executive Assistant / Office Manager at a 100-500 person company |
| **Location** | Stockholm, Uppsala, or Västerås |
| **Budget** | Company card, typically 20,000-40,000 SEK per event |
| **Volume** | Plans 3-6 company events per year (kickoff, summer party, julbord, etc.) |
| **Goals** | "Find a venue that makes me look good to the leadership team." Zero logistics headaches. |
| **Pain points** | "I spend hours emailing venues for quotes." "Half the places I find are booked 6 months out." "The CEO wants something 'different' this year." |
| **JTBD** | "When my CEO says 'find us something different for the kickoff this year,' I need a venue that impresses, handles the logistics, and makes me look like I discovered a hidden gem." |
| **Channel** | Google ("konferens Stockholm alternativ", "unik kickoff"), venue aggregators (Svenska Möten), direct referrals |
| **Conversion trigger** | Microsoft/Telia/Intersport testimonials ("If it's good enough for them...") + clear pricing + easy booking form |

### Persona Summary — Priority Matrix

| Persona | Lifetime Value | Decision Cycle | Volume Potential | Content Needs |
|---|---|---|---|---|
| A: Lars (Corporate leader) | High (repeat) | 1-3 months | Medium | Social proof, AV specs, location |
| B: Bianca (Wedding) | Highest (packages) | 6-18 months | Low-Medium | Photos, inventory, packages, themes |
| C: Frida (Celebration) | Medium | 1-4 months | Medium | Group photos, kitchen/capacity |
| D: Sofia (Family) | Low-Medium | 2-8 weeks | High (summer) | Activities, safety, nearby |
| E: Erik (Event planner) | High (repeat, volume) | 2-8 weeks | Medium | Pricing clarity, availability, testimonials |

**Primary focus**: Personas A + B (highest revenue per booking)
**Volume driver**: Personas C + D (fills gaps between corporate/wedding bookings)
**Efficiency play**: Persona E (repeat business, professional procurement)

---

## Part 4: Content Strategy & Information Architecture

### 4.1 Brand Positioning Statement

**Current** (implicit): "Privat Herrgård Till Konferens & Bröllop"

**Proposed**: 
> **"Skadevi Gård — Hela herrgården. Helt er. Helt prisvärt."**
> *(The whole manor. Entirely yours. Completely affordable.)*

**Brand narrative**: The Norse goddess Skade (skiing, winter, hunting) gave this place its name over 1,000 years ago. Today, Skadevi Gård is where modern tribes — leadership teams, wedding parties, families — gather to create their own legends. A 1927 manor on a 400-year-old estate, 25 minutes from Arlanda, priced so that the revenue builds a better experience for the next guests.

### 4.2 Tone of Voice

| Dimension | Guideline |
|---|---|
| **Language** | Swedish (primary), English (secondary, for international guests) |
| **Tone** | Warm, personal, confident — not corporate, not rustic-kitschy |
| **Personality** | "The generous host who's thought of everything" |
| **Avoid** | Hotel-jargon ("bespoke experience", "curated journey"), over-promising, fake urgency |
| **Embrace** | Specificity ("Two Belgian waffle irons", "Jabra puck", "350 kr for firewood"), humor (the football section on Aktiviteter page is a great example), humility |

### 4.3 Keyword Strategy

#### Primary Keywords (Commercial Intent)

| Swedish | English variant | Monthly volume (est.) |
|---|---|---|
| hyra herrgård Stockholm | rent manor Stockholm | Medium |
| konferens herrgård nära Stockholm | conference manor near Stockholm | Medium |
| bröllop herrgård Stockholm | wedding manor Stockholm | Medium-High |
| privat herrgård uthyrning | private manor rental | Low-Medium |
| kickoff herrgård | kickoff manor | Low-Medium |
| festlokal stor sällskap Stockholm | party venue large group Stockholm | Medium |
| semester boende nära Stockholm barnvänligt | family vacation near Stockholm | Medium |

#### Secondary Keywords (Informational Intent)

| Swedish | Intent |
|---|---|
| vad kostar hyra herrgård | Price research |
| bröllop budget Stockholm | Budget-conscious wedding planning |
| konferens med övernattning Stockholm | Overnight conference |
| teambuilding aktiviteter nära Stockholm | Corporate activity planning |
| slottsvandring Skokloster | Local tourism |

#### Local SEO Keywords

| Swedish |
|---|
| boende nära Arlanda |
| konferens Uppsala Stockholm mellan |
| herrgård Häggeby Skokloster |
| hyra lokal Håbo kommun |
| festlokal Enköping Uppsala Västerås |

### 4.4 Proposed Site Architecture

```
HOME
├── EVENT
│   ├── Bröllop (Weddings)
│   ├── Fest & Firande (Parties & Celebrations)
│   │   ├── Möhippa & Svensexa
│   │   ├── Födelsedag & Jubileum
│   │   └── Dop, Babyshower & Konfirmation
│   └── Mottagning & Högtider (Receptions & Holidays)
├── FÖRETAG (Corporate)
│   ├── Konferens & Kickoff
│   ├── Ledningsgruppsmöten
│   └── Sommarfest & Julbord
├── SEMESTER (Vacation)
│   ├── Familjesemester
│   └── Helgvistelse (Weekend Getaway)
├── BOENDE (Accommodation)
│   ├── Sovrum & Faciliteter
│   └── Kök & Utrustning
├── MAT & DRYCK (Food & Drink)
├── AKTIVITETER (Activities)
│   ├── På Gården (On-Site)
│   └── I Närområdet (Nearby)
├── BILDER (Gallery)
├── DIGITAL VISNING (3D Tour)
├── PRISER (Pricing)
├── OM OSS (About)
│   └── Historia (History)
├── VANLIGA FRÅGOR (FAQ)
└── KONTAKT & BOKA (Contact & Book)
```

**Key changes from current**:
- **Merged "Lokal" + "Mottagning" + "Fest"** into clearer subcategories under Event
- **Added "Priser"** as top-level page (currently buried on homepage, high buyer intent)
- **Moved "Boka"** to combine with Kontakt (booking = contact, no separate system yet)
- **Removed**: "Kopia på Hem", "Rullgardinsmeny" (Wix artifacts)
- **Split "Semester"** into two sub-pages for SEO targeting
- **Max 7 top-level nav items** (down from 18+)

### 4.5 Content Plan — Priority Pages

#### Tier 1: Must Have (launch-critical)

| Page | Word Count | Key Content | Schema |
|---|---|---|---|
| **Home** | 300-500 | Hero with USP, 3 customer paths (corporate/wedding/vacation), social proof (Microsoft), pricing anchor, CTA | LocalBusiness, Organization |
| **Bröllop** | 800-1,200 | (Already excellent — migrate, refine) | FAQ (wedding-specific), Product |
| **Företag** | 800-1,200 | (Already excellent — migrate, refine) | FAQ, Product |
| **Boende** | 600-800 | (Already excellent — migrate, add floor plan graphic) | — |
| **Priser** | 400-600 | Clear pricing table: Semester / Företag / Event, add-ons, wedding packages | Product (with pricing) |
| **Kontakt & Boka** | 200-300 | Contact form, phone, email, map, availability calendar embed | LocalBusiness |

#### Tier 2: High Impact

| Page | Current Status | Action |
|---|---|---|
| **Aktiviteter** | Excellent content | Migrate, restructure with accordion/categories, add map |
| **Vanliga frågor** | Empty | **Create from scratch** — 15-20 questions covering: booking process, payment, cancellation, check-in/out, what's included, what to bring, cleaning, pets, accessibility, nearby transport, dietary, noise/sound limits, badtunna instructions, tennis booking, COVID/illness policy |
| **Om oss / Historia** | Excellent history | Migrate, add owner photos + story (Rebecka & Daniel), add timeline graphic |
| **Mat & Dryck** | Good starter | Expand with sample menus, Sjökrogen partnership details, self-catering guide |
| **Fest & Firande** | Empty | Create content for each subtype: möhippa, svensexa, födelsedag, jubileum, dop, babyshower |

#### Tier 3: Nice to Have (post-launch)

- **Blog / Inspirationssida**: "5 anledningar att ha kickoff på herrgård", "Så planerar ni ett budgetbröllop", "Vad finns att göra i Skokloster?"
- **Case studies**: Deep-dive on a corporate client experience, a wedding story
- **Säsongssidor**: "Julbord på Skadevi", "Midsommar på herrgården", "Nyår"
- **English landing page**: For international corporate clients flying into Arlanda

### 4.6 Content Migration Priorities (ICE Scored)

| Content Asset | Impact | Confidence | Ease | ICE | Action |
|---|---|---|---|---|---|
| Bröllop page (existing) | 10 | 10 | 9 | 900 | Migrate + enhance with schema |
| Företag page (existing) | 10 | 10 | 9 | 900 | Migrate + enhance with schema |
| FAQ page (new) | 10 | 9 | 7 | 630 | Write from scratch, prioritize booking/payment Qs |
| Boende page (existing) | 9 | 10 | 9 | 810 | Migrate, add floor plan visual |
| Pricing page (new dedicated) | 9 | 10 | 9 | 810 | Extract from homepage + event page, make clear |
| Fest page (empty → new) | 8 | 9 | 6 | 432 | Write for each subtype |
| Aktiviteter page (existing) | 7 | 10 | 8 | 560 | Migrate, restructure UI, add map component |
| Historia page (existing) | 6 | 10 | 10 | 600 | Migrate, add timeline, add owner section |
| Blog (new) | 7 | 7 | 5 | 245 | 3-4 posts for launch, then monthly |
| Virtual tour page | 6 | 8 | 10 | 480 | Embed Splat Reality iframe, write instructions |

### 4.7 Schema Markup Implementation Plan

```json
// Homepage: Organization + LocalBusiness
{
  "@type": "LocalBusiness",
  "name": "Skadevi Gård",
  "address": { "streetAddress": "Skoklostervägen 16", "addressLocality": "Häggeby", "postalCode": "746 94", "addressCountry": "SE" },
  "telephone": "+46702730422",
  "email": "skadevigard@gmail.com",
  "priceRange": "9000-15000 SEK",
  "image": "https://www.skadeviherrgard.com/logo.png",
  "sameAs": ["https://instagram.com/skadevigard", "https://facebook.com/...", "https://linkedin.com/company/skadevi-herrgård"]
}

// Bröllop: FAQ + Product
// Företag: FAQ + Product
// Vanliga frågor: FAQPage (when created)
// Reviews/testimonials: Review (when structured)
```

### 4.8 Social Media Content Strategy

| Platform | Frequency | Content Mix |
|---|---|---|
| **Instagram** | 3-4x/week | 50% property/seasonal beauty shots, 25% guest experience/testimonial, 15% behind-the-scenes (renovations, owners), 10% local area (Skokloster, nature) |
| **LinkedIn** | 2x/week | Corporate-focused: meeting setups, conference testimonials, "why offsite works" thought leadership, team building tips |
| **Facebook** | 2x/week | Cross-post from Instagram, family/celebration-focused, local community engagement |
| **Pinterest** | Weekly | Wedding boards, Swedish manor aesthetic, party planning inspiration |

**Hashtag strategy**: #skadevigård #herrgård #privatkonferens #bröllop2026 #kickoff #slottsliv (and location tags)

---

## Part 5: Implementation Roadmap

### Phase 1: Triage (Week 1-2, on current Wix site)

1. Fix `lang="sv"` on all pages
2. Add meta descriptions to all pages
3. Delete/hide template placeholder pages
4. Delete "Kopia på Hem" and fix navigation
5. Fix Facebook link
6. Add Open Graph tags (Wix supports this in SEO settings)

### Phase 2: Content Creation (Week 2-4)

1. Write FAQ content (15-20 questions)
2. Write Fest/Firande page content
3. Write Semester page content (currently thin)
4. Write Utrustning & Service page content
5. Collect, organize, and caption photo gallery

### Phase 3: New Website Build (Week 3-8)

1. Select tech stack (recommendation: **Astro** for static + performance, or **WordPress** if frequent content updates needed)
2. Implement proposed IA (Section 4.4)
3. Migrate all Tier 1 content
4. Implement Schema.org structured data
5. Set up analytics (GA4 + Microsoft Clarity for heatmaps)
6. Implement booking/availability calendar integration
7. Core Web Vitals optimization target: LCP < 2.5s, FCP < 1.8s

### Phase 4: Launch & Optimize (Week 8-12)

1. 301 redirects from old Wix URLs to new URLs
2. Submit XML sitemap to Google Search Console
3. Set up Google Business Profile optimization
4. Begin Instagram/LinkedIn content cadence
5. A/B test homepage CTA placement and copy
6. Monitor Core Web Vitals in GA4

### Phase 5: Ongoing (Month 3+)

1. Monthly blog content (SEO)
2. Seasonal page refreshes (summer, Christmas, New Year)
3. Collect and publish video testimonials
4. Explore listing on Svenska Möten / venue aggregators
5. Photography refresh (professional shoot covering all seasons)

---

## Appendix: Key URL Mapping (Old → New)

| Old Wix URL | New URL |
|---|---|
| `/about-1` | `/brollop` |
| `/team-4` | `/aktiviteter` |
| `/services-7` | `/vanliga-fragor` |
| `/dopochbabyshower` | `/event/dop-babyshower` |
| `/copy-of-dop-babyshower` | `/event/mottagning` |
| `/firande` | `/event/fest` |
| `/kopia-på-hem` | 301 → `/` |
| `/kopia-på-utrustning-service` | `/digital-visning` |
| `/historia` | `/om-oss` |
| `/faciliteter` | `/boende#utrustning` or dedicated page |
| `/matochdryck` | `/mat-dryck` |
| `/the-suite` (old site) | `/boende` |
