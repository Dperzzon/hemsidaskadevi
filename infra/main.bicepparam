using './main.bicep'

// Ändra värden här för att styra resursgrupp, plan, webbapp och taggar.
param resourceGroupName = 'rg-skadevi-prod'

param location = 'swedencentral'

param planName = 'asp-skadevi-prod'

param planSkuName = 'B1'

param planSkuTier = 'Basic'

param webAppName = 'hemsida-skadevi-prod'

param nodeFxVersion = 'NODE|22-lts'

param environment = 'prod'

param owner = 'Skadevi Herrgård'

param customDomain = 'www.skadeviherrgard.com'

// Måste vara globalt unikt i Azure. Byt om namnet är upptaget.
param keyVaultName = 'kv-skadevi-prod'

param keyVaultSecretName = 'airbnb-ical-url'

// Domänaktivering i separata deployment-steg (se docs/driftsattning.md, steg 4):
//   'disabled'     – ingen domänhantering (första driftsättningen)
//   'binding'      – hostname-binding utan SSL (kräver CNAME i DNS)
//   'certificate'  – skapar gratis hanterat certifikat (kräver TXT asuid.www)
//   'tlsBinding'   – TLS-bindning med SNI + thumbprint
param customDomainStage = 'disabled'

// Objekt-ID för din användare så att du får rollen "Key Vault Secrets
// Officer" på kv-skadevi-prod och kan registrera/rotera kalenderhemligheten.
// (Hittade ditt ID med: az ad signed-in-user show --query id -o tsv)
param secretAdminPrincipalId = '3e197323-a929-40b0-a164-c8cb5b33b521'
