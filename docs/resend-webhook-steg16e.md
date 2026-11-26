# Steg 16E – Automatisk Resend-leveransuppföljning

## Syfte

Adminportalen ska automatiskt visa rätt leveransstatus för varje bokningsmejl
utan att ägaren manuellt kontrollerar Resend. Statusen får aldrig bygga på
antaganden: `Skickad`/API-acceptans är inte samma sak som leverans.

Endpoint: `POST https://www.skadeviherrgard.com/api/webhooks/resend`
(körs av den publika appen, samma tabell som adminportalen läser).

## Händelser

Resends dokumenterade händelsenamn används:

| Resend-händelse | Intern status | Adminetikett |
| --- | --- | --- |
| `email.sent` | `accepted` | Accepterat av Resend |
| `email.delivery_delayed` | `delivery_delayed` | Fördröjd leverans |
| `email.delivered` | `delivered` | Levererat |
| `email.bounced` | `bounced` | Studsat |
| `email.failed` | `failed` | Misslyckat |
| `email.complained` | `complained` | Spamklagomål |

Övriga händelser (`email.opened`, `email.clicked`, `email.scheduled`,
`email.suppressed`, domän-/kontakthändelser) kvitteras utan åtgärd.

## Så fungerar flödet

1. Svix-signaturen verifieras mot rå request-body med `svix-id`,
   `svix-timestamp` och `svix-signature` (HMAC-SHA256, 300 s tolerans).
2. `svix-id` används som idempotensnyckel i partitionen `webhookevent`.
3. Mejlet matchas **exakt** via Resend-ID mot utkorgen (`PartitionKey eq 'outbox'`).
4. Endast leveransfält uppdateras, med ETag-skydd. Vid 409 läses posten om och
   patchen appliceras en gång.
5. Händelsetid och senaste händelsetyp sparas (`lastEventAt`, `lastEventType`).
6. En historikpost (`EMAIL_DELIVERY_UPDATED`) skrivs per händelse.
7. Adminportalen härleder status och varningar från utkorgen vid varje läsning.

Webhooken kan aldrig ändra bokningsstatus, betalning, kalender eller
kunduppgifter. Okända Resend-ID:n kvitteras med `200 { matched: false }` så att
Resend inte retryar i onödan. Lagringsfel ger `503` så att Resend försöker igen.

## Statusar i adminportalen

- Väntar på att skickas (`Utkorg`)
- Under behandling (`Skickar`)
- Accepterat av Resend
- Leverans fördröjd
- Levererat till mottagarens mejlserver
- Leverans misslyckades
- Studsat
- Spamklagomål

`Levererat` visas endast när en `email.delivered`-händelse har sparats. API-
acceptans visas som "Accepterat – leverans ej verifierad".

## Varningar

- `email.delivered` tar automatiskt bort varningen "Mejl accepterat – leverans
  ej verifierad" för det mejlet. Övriga mejl påverkas inte.
- `email.bounced`, `email.failed` och `email.complained` ger en tydlig
  åtgärdsvarning med säker felkod (t.ex. `Permanent/General`). Ingen automatisk
  omsändning sker.
- Ett mejl som endast accepterats av Resend varnar först efter
  **60 minuter** (`MAIL_UNVERIFIED_ALERT_MINUTES`). Kortare normal väntetid ger
  ingen varning.

## Säkerhet

- `RESEND_WEBHOOK_ENABLED=1` aktiverar endpointen. Annars svarar den `404`.
- `RESEND_WEBHOOK_SECRET` läses från Azure Key Vault via Bicep-referens.
  Hemligheten finns aldrig i Git, kod eller loggar.
- Resend-ID:n valideras mot ett strikt teckenmönster innan lagringsuppslag.
- Ingen mejladress eller mejltext loggas eller returneras.
- Den befintliga `resend-api-key` (Sending access) används oförändrad och
  behöver ingen läsbehörighet.

## Aktivering (engångssteg)

Kräver en **tillfällig full-access-nyckel** i Resend. Sending-nyckeln räcker
inte för att skapa webhooks.

```powershell
# 1. Skapa en tillfällig full-access-nyckel i Resend-dashboarden.
$env:RESEND_FULL_ACCESS_KEY = '<tillfällig full-access-nyckel>'

# 2. Skapa webhooken (om den inte redan finns) och spara signeringshemligheten
#    som 'resend-webhook-secret' i kv-skadevi-prod. Ingen dubblett skapas.
node scripts/configure-resend-webhook.mjs

# 3. Ta bort den tillfälliga full-access-nyckeln i Resend.

# 4. Verifiera signaturverifieringen mot produktionsendpointen. Testet använder
#    ett okänt Resend-ID och rör ingen bokning. (Kräver att endpointen redan är
#    aktiverad, se steg 6.)
node scripts/verify-resend-webhook.mjs

# 5. Sätt enableResendWebhook = true i infra/main.bicepparam och deploya infra.
az deployment group what-if --resource-group rg-skadevi-prod `
  --template-file .\infra\main.bicep --parameters .\infra\main.bicepparam
az deployment group create --resource-group rg-skadevi-prod `
  --name skadevi-prod --template-file .\infra\main.bicep `
  --parameters .\infra\main.bicepparam

# 6. Publicera appkoden via befintligt GitHub Actions-flöde (deploy.yml).
```

`RESEND_WEBHOOK_ENABLED` sätts av Bicep (`enableResendWebhook`), aldrig manuellt
i portalen. Kör where-if före varje infra-deployment.

## End-to-end-test (efter aktivering)

1. Skicka ett internt testmejl till `skadevigard@gmail.com` via den befintliga
   testutkorgen (inga riktiga kundmejl).
2. Kontrollera att Resend accepterar mejlet och returnerar ett Resend-ID.
3. Kontrollera i adminportalen att status går från "Accepterat – leverans ej
   verifierad" till "Levererat" efter `email.delivered`.
4. Kontrollera att varningen för overifierad leverans försvinner och att
   historiken innehåller `EMAIL_DELIVERY_UPDATED`.
5. Kontrollera att ingen dubblett skapas vid Resend-retry (samma `svix-id`).

## Återställning

Sätt `enableResendWebhook = false` och deploya infra. Endpointen svarar då 404.
Befintliga statusar och historik ligger kvar i tabellen. Stripe-webhooken
påverkas inte.

## Kvarstående begränsningar

- Resend returnerar signeringshemligheten endast när webhooken skapas. Om en
  motsvarande webhook redan finns måste hemligheten hämtas/roteras i
  Resend-dashboarden och läggas i Key Vault manuellt.
- Historiska mejl som skickades före aktiveringen får ingen påhittad
  leveranshändelse. De kan verifieras manuellt i adminportalen.
- "Delivered" betyder leverans till mottagarens mejlserver, inte att mejlet
  hamnat i inkorgen.
