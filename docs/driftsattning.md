# Driftsättning av hemsidaskadevi på Azure Static Web Apps

Denna guide beskriver hur du publicerar, uppdaterar och felsöker webbplatsen.
Alla Azure-resurser skapas via Bicep och all kod driftsätts via GitHub Actions.
Inga hemligheter finns i repot.

## Arkitektur och kostnad

| Resurs | Tjänst | Nivå | Kostnad/månad |
|---|---|---|---|
| `hemsida-skadevi-prod` | Azure Static Web Apps | Free | 0 kr |
| Hanterat API (`api/`) | Azure Functions (ingår i SWA) | Ingår i Free | 0 kr |

- Static Web Apps Free innehåller både statisk frontend och det hanterade
  kalender-API:et. Ingen Function App, SQL, lagring eller App Service behövs.
- Free-nivån saknar SLA och har kvoter (t.ex. 100 GB bandbredd/månad och
  0,5 GB API-storlekskvot), vilket är mer än tillräckligt för denna sajt.
  Kontrollera aktuella kvoter på Microsofts sida för Static Web Apps.
- Innehållet betjänas globalt via Static Web Apps; regionen styr bara var
  API:et och staging-miljöer körs.
- Region: Azure-providern `Microsoft.Web/staticSites` registrerar endast
  regionerna Central US, East US 2, West US 2, West Europe och East Asia.
  **Sweden Central stöds inte** för Static Web Apps och rekommendationen är
  därför `westeurope` (Nederländerna), som är närmast befintliga region i
  Europa. Det är dock enbart ägaren som avgör slutligt val — ändra
  `location` i `infra/main.bicepparam` innan driftsättning.

## Steg 1: Skapa resurserna i Azure (en gång)

Förutsättningar: Azure CLI inloggad (`az login`) med en prenumeration vald
(`az account set --subscription <namn>`), och Node.js 22 installerat.

1. Skapa resursgruppen (om den inte finns):

   ```powershell
   az group create --name rg-skadevi-prod --location swedencentral
   ```

2. Granska vad som skulle skapas (read-only, skapar ingenting):

   ```powershell
   az deployment group what-if `
     --resource-group rg-skadevi-prod `
     --template-file .\infra\main.bicep `
     --parameters .\infra\main.bicepparam
   ```

3. Skapa resurserna:

   ```powershell
   az deployment group create `
     --resource-group rg-skadevi-prod `
     --template-file .\infra\main.bicep `
     --parameters .\infra\main.bicepparam
   ```

Namn, region och taggar styrs i `infra/main.bicepparam`. Eftersom Static
Web Apps inte stöds i `swedencentral`, ändra `location` till `westeurope`
i `infra/main.bicepparam` innan du kör — inget annat behöver ändras.
(`swedencentral` kan behållas som plats för resursgruppen, som är oberoende
av Static Web App-resursens region.)

## Steg 2: Aktivera deployment-flödet (en gång)

1. Hämta deployment-token från Azure-portalen:
   - Öppna Static Web App **hemsida-skadevi-prod** → **Översikt** →
     **Hantera deployment-token** → kopiera token.
   - Alternativ via CLI (ersätt `<id>` med utdatan `staticWebAppId` från
     steg 1):

     ```powershell
     az rest --method POST `
       --url "https://management.azure.com/<id>/listSecrets?api-version=2024-11-01"
     ```

2. Lägg till hemligheten i GitHub (öppna endast din egen terminal/webbläsare):
   - Öppna `https://github.com/Dperzzon/hemsidaskadevi` → **Settings** →
     **Secrets and variables** → **Actions** → **New repository secret**.
   - Name: `AZURE_STATIC_WEB_APPS_API_TOKEN`
   - Secret: den kopierade tokenen.

3. Pusha sedan till `main` (eller kör workflown manuellt: **Actions** →
   **Deploy till Azure Static Web Apps** → **Run workflow**). Workflown
   kör först testerna, paketerar sedan endast publika webbfiler
   (index.html, 404.html, css, js, pages, images, robots.txt, sitemap.xml,
   staticwebapp.config.json) i en `build/`-mapp och driftsätter den tillsammans
   med API:et:
   - Frontend: endast publika filer — `infra/`, `.github/`, `docs/`, `tests/`,
     README och api-källkod publiceras aldrig.
   - API: `api/`-mappen som hanterad Functions-miljö (Node.js 22).

4. Kontrollera att workflown blir grön och att `defaultHostname`
   (t.ex. `https://hemsida-skadevi-prod.azurestaticapps.net`) svarar.

## Steg 3: Ställ in kalenderhemligheten (en gång)

Kalender-API:et kräver miljövariabeln `AIRBNB_ICAL_URL` — en hemlig
iCal-adress som aldrig får hamna i Git, klientkod eller loggar.

1. Roterar du adressen, gör det först hos kalenderleverantören.
2. I Azure-portalen: Static Web App → **Environment variables** → lägg till:
   - Name: `AIRBNB_ICAL_URL`
   - Value: kalenderadressen
   - Markera som hemlig (Secret) om portalen erbjuder det.
3. Deploya om (push till `main` eller **Run workflow**) och verifiera
   att kalendern på `/lediga-datum` visar rätt tillgänglighet.

## Steg 4: Koppla domänen www.skadeviherrgard.com

Följ först steg 1–3 och verifiera sajten på `*.azurestaticapps.net`
**innan** DNS ändras. Gör därefter så här (ändra inga DNS-poster förrän
nu — det krävs för att validera domänen):

1. Azure-portalen: Static Web App → **Custom domains** → **Add** →
   `www.skadeviherrgard.com`.
2. Portalen visar vilken CNAME-post som krävs. Skapa i ditt
   domänleverantörs-panelen en CNAME:

   ```
   www  CNAME  <defaultHostname>.azurestaticapps.net
   ```

3. Vänta tills domänen valideras (minuter till timmar). TLS-certifikat
   utfärdas automatiskt kostnadsfritt.
4. Valfritt: lägg till en redirect från apex-domänen
   `skadeviherrgard.com` till `www` (SWA Free hanterar www bäst; apex
   kan kräva ALIAS/ANAME hos leverantören).
5. Se till att GitHub Pages stängs av i repo-inställningarna
   (**Settings** → **Pages** → Source: None) så att domänen inte pekar
   mot två publiceringar.

## Uppdatera webbplatsen

- Ändra filer → commit → push till `main`. Workflown bygger, testar och
  publicerar automatiskt.
- Ändra resursnamn, region eller taggar i `infra/main.bicepparam` och kör
  `az deployment group what-if` + `create` igen.
- Kör tester lokalt innan push:

  ```powershell
  Set-Location .\api
  npm ci --ignore-scripts --no-audit --no-fund
  npm test
  Set-Location ..
  node --test .\tests\calendar-client.test.js
  ```

## Felsökning

| Symptom | Åtgärd |
|---|---|
| Workflow visar "deployment-token saknas" | Steg 2: lägg till GitHub-hemligheten `AZURE_STATIC_WEB_APPS_API_TOKEN`. |
| Deploy fastnar/failar i build | Kontrollera Node-version 22 i `api/package.json` och att `staticwebapp.config.json` är giltig JSON. |
| Kalendern visar "okänd tillgänglighet" | `AIRBNB_ICAL_URL` saknas eller är ogiltig — kontrollera Environment variables och verifiera adressen hos leverantören (utan att exponera den). |
| `/priser` m.fl. ger 404 | Kontrollera att `staticwebapp.config.json` innehåller routen och att den driftsatts. |
| Domänvalideringen fastnar | Kontrollera CNAME-posten med `nslookup www.skadeviherrgard.com` och vänta på DNS-propagering. |
| Sajten visar gammalt innehåll | Tvinga uppdatering (Ctrl+F5); SWA cachar assets kortvarigt. |
| Fel om region/location vid skapande | Static Web Apps stöder inte alla regioner — sätt `location` till `westeurope` i `infra/main.bicepparam`. |

Användbara kommandon:

```powershell
az staticwebapp show --name hemsida-skadevi-prod --resource-group rg-skadevi-prod
az staticwebapp environment list --name hemsida-skadevi-prod --resource-group rg-skadevi-prod
az staticwebapp appsettings list --name hemsida-skadevi-prod --resource-group rg-skadevi-prod
```

## Säkerhet

- Deployment-token lagras endast i GitHub-hemligheter.
- `AIRBNB_ICAL_URL` lagras endast i Azure-appinställningar, aldrig i Git.
- Workflown har `permissions: contents: read` och kör testerna innan
  driftsättning.
- Inga DNS-poster eller Azure-resurser skapas av denna mall utöver den
  enskilda Static Web App-resursen.
