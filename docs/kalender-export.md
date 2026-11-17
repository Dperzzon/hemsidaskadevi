# Kalenderintegration: import, export och övervakning

Detta dokument beskriver steg 9W. Det kompletterar `docs/direktbokning.md` och
`docs/driftsattning.md`.

## Airbnb till Skadevi (import)

- Kalendern hämtas med en ny HTTPS-förfrågan inför varje direktbokningsförsök.
- Förfrågan och svaret markeras som icke-cachebara. Ingen cachad kalender
  används någonsin som bevis för tillgänglighet.
- Timeout är 5 sekunder. Högst två försök görs, endast vid nätverksfel,
  timeout, HTTP 429 och HTTP 5xx. Andra HTTP-fel försöks inte igen.
- HTTP-status, innehållstyp och att filen börjar med `BEGIN:VCALENDAR`
  kontrolleras innan den tolkas.
- Heldagsbokningar, tidszoner, avbokningar, undantag och återkommande händelser
  hanteras av den befintliga tolken i `server/calendar/calendar-worker.js`.
- En lyckad hämtning är fortfarande bara en exporterad fil. Airbnb kan ha en
  fördröjning. Systemet påstår därför aldrig att synken är i realtid.

## Fail-safe

Om kalendern inte kan hämtas, svarar med fel, har fel format eller inte kan
tolkas, stoppas direktbetalning för berörda datum. API:t svarar 503 med
`manualReview: true` och gästen hänvisas till en vanlig bokningsförfrågan.
Ett synkfel tolkas aldrig som att datumen är lediga.

## Ledtidsgräns nära ankomst

`DIRECT_BOOKING_MIN_LEAD_HOURS` är en konfigurerbar säkerhetsgräns. Standard är
`0` (avstängd). När den aktiveras, till exempel till `24` eller `48`, nekas
direktbetalning för ankomster som ligger närmare i tid än gränsen. Gästen kan
fortfarande skicka en bokningsförfrågan. Gränsen jämförs mot midnatt svensk tid
på ankomstdagen.

Innan gränsen slås på i produktion ska effekten följas upp: hur många
direktbokningar som i stället blir manuella förfrågningar och om det påverkar
konverteringen.

## Skadevi till Airbnb (export)

Den publika exporten ligger på:

```
/kalender/<hemlig-token>.ics
```

Samma innehåll finns även på `/api/calendar/export/<hemlig-token>.ics`.
Token läses från `CALENDAR_EXPORT_TOKEN`, som i Azure är en Key Vault-referens
till sekretet `calendar-export-token`. Token:

- är minst 24 tecken och genereras slumpmässigt,
- jämförs i konstant tid,
- loggas aldrig och visas aldrig i den publika frontend-koden,
- kan bytas genom att rotera Key Vault-sekretet; därefter måste den nya
  adressen importeras i Airbnb.

Exporterat innehåll:

- bekräftade bokningar,
- manuella datumblockeringar,
- aktiva betalningsreservationer (tillfälliga nattlås).

Varje natt blir en neutral händelse med rubriken **Upptaget**. Exporten
innehåller aldrig namn, telefonnummer, e-post, betalningsuppgifter eller
bokningsreferenser i klartext. `UID` är en hash och `DTEND` är exklusivt, så
avresedagen blir ledig.

Airbnb-importerade blockeringar lagras inte i den interna kalendern. Rader med
källa `AIRBNB`/`ICAL` filtreras dessutom bort, vilket förhindrar synkloopar.

### Importera i Airbnb

1. Hämta den hemliga adressen från Key Vault (se nedan).
2. Airbnb → **Kalender** → önskat boende → **Tillgänglighet** →
   **Kalenderanslutning** / **Importera kalender**.
3. Klistra in hela URL:en och namnge kalendern, till exempel
   **Skadevi direktbokning**.
4. Spara. Airbnb hämtar kalendern med sina egna intervall; ändringar syns
   därför inte omedelbart.

Hämta adressen utan att skriva ut token i en vanlig logg eller rapport:

```powershell
$token = az keyvault secret show --vault-name kv-skadevi-prod `
  --name calendar-export-token --query value -o tsv
"https://www.skadeviherrgard.com/kalender/$token.ics"
```

## Synkstatus i adminportalen

Under **Direktbokning** visas:

- senaste lyckade Airbnb-hämtning,
- senaste kontrollförsök,
- status: Fungerar / Varning / Fel / Okänd,
- senaste felorsak,
- antal misslyckade försök i följd,
- upptäckta konflikter mellan importerade Airbnb-blockeringar och interna
  bokningar.

Statusen sparas i Azure Table Storage i partitionen `calendarsync` och
innehåller endast tekniska metadata. Den hemliga kalenderadressen och tokens
sparas aldrig där.

## Automatisk övervakning

Den publika appen kör en lättviktskontroll var 15:e minut
(`CALENDAR_SYNC_MONITOR_MINUTES`). Den använder befintlig App Service och
befintlig Table Storage — inga nya Azure-resurser skapas. Kontrollen:

- hämtar och validerar kalendern,
- jämför importerade blockeringar mot interna bokningar,
- uppdaterar synkstatus.

Inga mejl skickas. Resend och befintliga mejlflöden förblir avstängda.
Felstatus visas i adminportalen i stället.
