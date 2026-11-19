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

// Rotdomänen binds i samma steg som www och 301-omdirigeras i servern till www.
// Tomt värde = rotdomänen hanteras inte (nuvarande läge tills DNS/cert är klart).
param apexDomain = 'skadeviherrgard.com'

// Måste vara globalt unikt i Azure. Byt om namnet är upptaget.
param keyVaultName = 'kv-skadevi-prod'

param keyVaultSecretName = 'airbnb-ical-url'

// Domänaktivering i separata deployment-steg (se docs/driftsattning.md, steg 4):
//   'disabled'     – ingen domänhantering (första driftsättningen)
//   'binding'      – hostname-binding utan SSL (kräver CNAME i DNS)
//   'certificate'  – skapar gratis hanterat certifikat (kräver TXT asuid.www)
//   'tlsBinding'   – TLS-bindning med SNI + thumbprint
param customDomainStage = 'disabled'

// User-assigned managed identity för GitHub Actions OIDC-deployment.
param githubIdentityName = 'id-gh-actions-skadevi'

// OIDC-subject i GitHubs immutable-format (verifierat via GitHub API:
// owner Dperzzon = 33748032, repo hemsidaskadevi = 1436769162). Gäller
// enbart detta repo och denna branch.
param githubOidcSubject = 'repo:Dperzzon@33748032/hemsidaskadevi@1436769162:ref:refs/heads/main'

// Objekt-ID för din användare så att du får rollen "Key Vault Secrets
// Officer" på kv-skadevi-prod och kan registrera/rotera kalenderhemligheten.
// (Hittade ditt ID med: az ad signed-in-user show --query id -o tsv)
param secretAdminPrincipalId = '3e197323-a929-40b0-a164-c8cb5b33b521'

// Table Storage för bokningsförfrågningar — deployad och verifierad 2026-11-11
// (steg 3). Namnet deklareras nu så att framtida infra-deployments hanterar
// lagringen idempotent (Nochange). Kör alltid what-if först.
param bookingStorageAccountName = 'stskadevibokningprod'

// Stripe Live är aktiverat för kortbetalningar. Swish är fortsatt avstängt.
// Hemligheterna ligger i Key Vault och refereras utan versionsnummer.
param enableStripeWebhook = true

// Matchar det verifierade produktionsläget 2026-11-19. Värdet ska ändras
// medvetet, inte som bieffekt av en infra-deployment.
param enableBookingRequests = true

// Utkorgen för betalningsmejl är fortsatt avstängd. Aktiveras först efter
// kontrollerad test och separat godkännande.
param enableStripeOutbox = false

param enableCardCheckout = true

param enableSwishCheckout = false

// Direktbokning är aktiverad som funktion, men ALLA datum är stängda som
// standard. Owner måste uttryckligen öppna ett datumintervall i adminportalen
// och bekräfta Airbnb-blockeringen. Inga datum öppnas automatiskt.
param enableDirectBooking = true

param stripeMode = 'live'

param allowStripeLive = true

param stripeSecretUri = 'https://kv-skadevi-prod.vault.azure.net/secrets/stripe-secret-key'

param stripeWebhookSecretUri = 'https://kv-skadevi-prod.vault.azure.net/secrets/stripe-webhook-secret'
