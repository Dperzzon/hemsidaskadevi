# Driftsättning av hemsidaskadevi på Azure App Service (Sweden Central)

Denna guide beskriver hur du publicerar, uppdaterar och felsöker webbplatsen.
Hela infrastrukturen hanteras via Bicep; all kod driftsätts via GitHub Actions.
Inga hemligheter finns i repot.

## Arkitektur och kostnad

| Resurs | Tjänst | Nivå | Kostnad/månad |
|---|---|---|---|
| `rg-skadevi-prod` | Resource Group (via Bicep) | — | 0 kr |
| `asp-skadevi-prod` | App Service-plan (Linux, Node 22) | Basic B1 | ≈ 130 kr |
| `hemsida-skadevi-prod` | Web App: statisk webbplats + kalender-API | Ingår i planen | 0 kr (extra) |

- **Allt körs i swedencentral** — data lagras och processas i Sverige.
- En enda Node.js-server (`server.js`, inga extra npm-beroenden) serverar
  både statiska filer och `/api/availability`, och återanvänder befintlig
  kalenderlogik i `api/src/` oförändrad.
- B1 saknar deployment slots och har ingen SLA-förbindelse i det
  arkitekturval vi gjort; planen är always-on och kostar enligt
  0,178628 SEK/tim (≈ 130 kr/månad vid 730 h, Azure Retail Prices API).
- Inga extra resurser: ingen SQL, ingen separat Function App, ingen lagring.

## Steg 1: Skapa resurserna i Azure (en gång)

Förutsättningar: Azure CLI inloggad (`az login`) med rätt prenumeration vald
(`az account set --subscription <id>`), och Node.js 22 installerat.
Resursgruppen skapas av mallen — kör inte `az group create` manuellt.

1. Granska vad som skulle skapas (read-only, skapar ingenting):

   ```powershell
   az deployment sub what-if `
     --location swedencentral `
     --name skadevi-prod `
     --template-file .\infra\main.bicep `
     --parameters .\infra\main.bicepparam
   ```

2. Skapa resurserna — deploymenten är idempotent och kan köras om:

   ```powershell
   az deployment sub create `
     --location swedencentral `
     --name skadevi-prod `
     --template-file .\infra\main.bicep `
     --parameters .\infra\main.bicepparam
   ```

Alla namn (RG, plan, webbapp), regioner, SKU, Node-version, taggar och
domänvärden styrs i `infra/main.bicepparam` — inget är hårdkodat i mallarna.

## Steg 2: Aktivera deployment-flödet (en gång, OIDC)

Deployment sker med **OpenID Connect (OIDC)** — Basic Authentication/publish
profile används inte och ska förbli avstängt. Mallen skapar en
user-assigned managed identity (`id-gh-actions-skadevi`) med en federated
identity credential vars subject gäller enbart `Dperzzon/hemsidaskadevi`
och branch `main`. Subject anges i GitHubs **immutable-format** med
owner- och repo-ID (verifierade via GitHub API: owner = 33748032,
repo = 1436769162):

```
repo:Dperzzon@33748032/hemsidaskadevi@1436769162:ref:refs/heads/main
```

Värdet styrs av parametern `githubOidcSubject` i `infra/main.bicepparam`.
Omf id-numren ändras (de gör det normalt aldrig) eller branchen byts,
hämtar du aktuella värden med `https://api.github.com/users/<owner>` respektive
`https://api.github.com/repos/<owner>/<repo>` — eller läser subject-claim ur
en misslyckad GitHub Actions-körning — och uppdaterar parametern.

1. Kör infra-deploymenten (skapar identiteten, se steg 1). Hämta clientId:

   ```powershell
   $out = az deployment sub show `
     --name skadevi-prod `
     --query properties.outputs | ConvertFrom-Json
   $out.githubIdentityClientId.value
   ```

2. Lägg till variablerna i GitHub:
   - `https://github.com/Dperzzon/hemsidaskadevi` → **Settings** →
     **Secrets and variables** → **Actions** → fliken **Variables** →
     **New repository variable**.
   - `AZURE_CLIENT_ID` = clientId från ovan.
   - `AZURE_TENANT_ID` = ditt Entra tenant-ID
     (`az account show --query tenantId -o tsv`).
   - `AZURE_SUBSCRIPTION_ID` = prenumerations-ID
     (`az account show --query id -o tsv`).
   - Ta bort den gamla hemligheten `AZURE_WEBAPP_PUBLISH_PROFILE` (och
     `AZURE_STATIC_WEB_APPS_API_TOKEN` om den finns kvar) — den används inte
     längre.
3. Pusha till `main` (eller **Actions** → **Deploy till Azure App Service** →
   **Run workflow**). Workflown kör tester (API, server, kalenderklient),
   loggar in med `azure/login` + OIDC (`id-token: write`), paketerar endast
   publika filer + `server.js` + beroenden i en `build/`-mapp och
   zip-driftsätter med `azure/webapps-deploy@v3`.
4. Kontrollera `https://hemsida-skadevi-prod.azurewebsites.net`.

## Steg 3: Ställ in kalenderhemligheten (en gång)

Kalender-API:et kräver miljövariabeln `AIRBNB_ICAL_URL` — en hemlig
iCal-adress som aldrig får hamna i Git.

Mallen skapar en Key Vault (`kv-skadevi-prod`, standardnivå, RBAC) och
webbappens appinställning `AIRBNB_ICAL_URL` är en **Key Vault-referens** som
läser sekretens `airbnb-ical-url` (utan versionsnummer). Därför:

- Själva hemliga värdet sätts **aldrig** via Bicep, Git eller parameterfiler.
- Upprepade infra-deployments nollställer aldrig hemligheten — referensen är
  statisk och sekretens värde kan roteras utan ny deployment.
- Webappens systemidentitet har rollen "Key Vault Secrets User" på valvet
  (skapas av mallen).

**1a. Ge dig själv skrivbehörighet i valvet.** Med RBAC-aktiverat valvet räcker
inte Contributor — du behöver "Key Vault Secrets Officer". Ange ditt
objekt-ID som parametern `secretAdminPrincipalId` i
`infra/main.bicepparam` (hitta det med
`az ad signed-in-user show --query id -o tsv`) och kör en infra-deployment,
eller tilldela rollen direkt:

```powershell
az role assignment create `
  --assignee <ditt-objekt-id> `
  --role "Key Vault Secrets Officer" `
  --scope "$(az keyvault show --name kv-skadevi-prod --query id -o tsv)"
```

1. Sätt sekretensvärdet (adressen roteras hos leverantören först):

   ```powershell
   az keyvault secret set `
     --vault-name kv-skadevi-prod `
     --name airbnb-ical-url `
     --value '<din hemliga kalenderadress>'
   ```

   Alternativ: Azure-portalen → Key Vault → **Secrets** → **Generate/Import**.
   Värdet ska inte anges i terminalhistorik om du undviker det — portalmetoden
   exponerar det aldrig i skalloggar.

2. RBAC kan ta några minuter att propagera; första hämtningen kan ge
   "okänd tillgänglighet" en kort stund.
3. Verifiera att `/lediga-datum` visar rätt tillgänglighet.

**Obs:** Bicep-appinställningarna ersätter ALLA befintliga appinställningar
vid varje infra-deploy. Lägg därför aldrig till inställningar manuellt i
portalens Environment variables — lägg dem i
`infra/modules/webapp.bicep` (`appSettings`-listan) i stället.
Kod-deployments via GitHub Actions påverkar aldrig appinställningar.

## Steg 4: Koppla domänen www.skadeviherrgard.com

Domänkopplingen är IaC och styrs av parametern `customDomainStage` i
`infra/main.bicepparam` (default `disabled`) — kräver DNS-ändringar hos
domänleverantören, inget ändras automatiskt. Certifikatet är en **egen
Bicep-resurs** (`Microsoft.Web/certificates`) med valideringsmetod
`dns-txt-token`, och bindningen (SNI + thumbprint) skapar TLS-kopplingen.
Microsoft kräver att hostname:t är verifierat och registrerat på App Service
**innan** certifikatet skapas — därför genomförs aktiveringen i separata
deployment-steg:

| Steg | `customDomainStage` | Vad skapas/ändras | Kräver DNS |
|---|---|---|---|
| 1 | `binding` | Hostname-binding **utan SSL** — verifierar och registrerar domänen på webbappen | CNAME |
| 2 | `certificate` | Gratis App Service Managed Certificate (`dns-txt-token`) | TXT `asuid.www` |
| 3 | `tlsBinding` | TLS-bindning med SNI + certifikatets thumbprint | (uppfyllt) |

Sekvens:

1. Verifiera sajten på `*.azurewebsites.net` först (steg 1–3).
2. **DNS-steg 1 — CNAME** hos domänleverantören:

   ```
   www  CNAME  hemsida-skadevi-prod.azurewebsites.net
   ```

3. **Deployment A** — sätt `customDomainStage = 'binding'` i
   `infra/main.bicepparam` och kör what-if + create (kommandon nedan).
   Kontrollera i portalen att domänen visas och är verifierad.
4. **DNS-steg 2 — TXT.** Hämta valideringsvärdet i portalen (Web App →
   **Custom domains** → domänen → `asuid.www = <token>`) eller med
   `az webapp config hostname list`, och lägg till TXT-posten hos
   domänleverantören.
5. **Deployment B** — sätt `customDomainStage = 'certificate'` och kör igen.
   Certifikatet valideras och utfärdas (gratis, SNI).
6. **Deployment C** — sätt `customDomainStage = 'tlsBinding'` och kör igen.
   Kontrollera i portalen att domänen är "Ready" och SNI-bindningen grön.
7. Stäng av GitHub Pages i repo-inställningarna (**Settings** → **Pages** →
   Source: None) så att domänen inte pekar mot två publiceringar.

Deployment-kommando för varje steg (samma mall, ändra bara
`customDomainStage`):

```powershell
az deployment sub what-if `
  --location swedencentral `
  --name skadevi-prod `
  --template-file .\infra\main.bicep `
  --parameters .\infra\main.bicepparam

az deployment sub create `
  --location swedencentral `
  --name skadevi-prod `
  --template-file .\infra\main.bicep `
  --parameters .\infra\main.bicepparam
```

Hoppa inte från `disabled` direkt till `certificate`/`tlsBinding` —
hostname:t måste vara verifierat först (stegordningen ovan).

## Uppdatera webbplatsen

- Ändra filer → commit → push till `main`. Workflown testar, paketerar och
  publicerar automatiskt.
- Ändra infrastruktur i `infra/main.bicepparam` och kör `az deployment sub
  what-if` + `create` igen (idempotent).
- Kör tester lokalt innan push:

  ```powershell
  npm ci --ignore-scripts --no-audit --no-fund
  npm ci --ignore-scripts --no-audit --no-fund --prefix api
  npm test --prefix api
  node --test .\tests\server.test.js
  node --test .\tests\calendar-client.test.js
  ```

## Felsökning

| Symptom | Åtgärd |
|---|---|
| Workflow visar "OIDC-konfiguration saknas" | Steg 2: lägg till repo-variablerna `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID`. |
| Login-fel "AADSTS70021/AADSTS700213" | Federated credential saknas eller subject mismatch: subject i Bicep (`githubOidcSubject`) ska vara GitHubs immutable-format, t.ex. `repo:Dperzzon@33748032/hemsidaskadevi@1436769162:ref:refs/heads/main`, och workflow-privilegiet `id-token: write` satt (deploy.yml gör detta). Läs den exakta claimen i felmeddelandet från den misslyckade körningen. |
| Kalendern visar "okänd tillgänglighet" | `AIRBNB_ICAL_URL` saknas/ogiltig — se steg 3. Kontrollera att KV-sekretens `airbnb-ical-url` finns och att webbappens systemidentitet har "Key Vault Secrets User" (kan ta minuter att propagera). |
| Deployment policy-avvisas | Din prenumeration har system-policyn `sys.blockwesteurope`; swedencentral är validerad och fungerar. |
| 404 på `/priser` m.fl. | Kontrollera att `server.js` är med i paketet och att PAGE_ROUTES innehåller sidan. |
| Sajten visar gammalt innehåll | Driftsätt igen via **Run workflow**; B1-cachen är kortlivad. |
| Domänvalideringen fastnar | Kontrollera CNAME + TXT (`asuid.www`) med `nslookup` och vänta på propagering. |
| Appen startar inte | Kudu → Log stream; kontrollera att `PORT`-miljövariabeln respekteras (server.js gör det). |

Användbara kommandon:

```powershell
az webapp show --name hemsida-skadevi-prod --resource-group rg-skadevi-prod
az webapp config appsettings list --name hemsida-skadevi-prod --resource-group rg-skadevi-prod
az webapp log tail --name hemsida-skadevi-prod --resource-group rg-skadevi-prod
```

## Säkerhet

- Basic Authentication är avstängt på webbappen; deployment sker via OIDC
  (federated identity credential kopplad till repo + branch) utan några
  hemligheter i GitHub. Identiteten har "Website Contributor" endast på
  webbappens scope — inte på resursgruppen eller prenumerationen.
- `AIRBNB_ICAL_URL` lagras i Key Vault och refereras med en statisk
  Key Vault-referens; värdet förekommer aldrig i Git, Bicep, parameterfiler,
  dokumentation eller loggar och kan roteras utan ny deployment.
- Appinställningar hanteras endast av Bicep (`appSettings`-listan); manuella
  portaländringar skrivs över vid nästa infra-deploy.
- Webbappen har httpsOnly, TLS 1.2 minimum, HTTP/2, always-on, health check
  och systemidentitet.
- Servern tillåter endast GET/HEAD, whitelistar tillåtna kataloger och
  blockerar path traversal; säkerhetsrubriker sätts på alla svar.
- Inga DNS-poster skapas av mallen; certifikat + bindning styrs av
  `customDomainStage` (stegvis aktivering) och kräver CNAME + TXT hos
  domänleverantören.
