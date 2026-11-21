targetScope = 'subscription'

@description('Namn på resursgruppen som skapas och hanteras av mallen.')
@minLength(1)
@maxLength(90)
param resourceGroupName string

@description('Plats för alla resurser.')
param location string

@description('Namn på App Service-planen.')
@minLength(2)
@maxLength(60)
param planName string

@description('App Service-planens SKU-namn.')
param planSkuName string

@description('App Service-planens nivå.')
param planSkuTier string

@description('Namn på webbappen som serverar webbplatsen och kalender-API:et.')
@minLength(2)
@maxLength(60)
param webAppName string

@description('Linux-runtime för Node.js, t.ex. NODE|22-lts.')
param nodeFxVersion string

@description('Miljötagg, t.ex. prod.')
param environment string

@description('Ägartagg.')
param owner string

@description('Domän som planeras kopplas till webbappen.')
param customDomain string

@description('Rotdomän som ska bindas och 301-omdirigeras till customDomain (www). Tomt = rotdomänen hanteras inte. Kräver A-post + TXT asuid i DNS innan bindning.')
param apexDomain string = ''

@description('Namn på Key Vault som lagrar kalenderhemligheten. Hemliga värdet sätts aldrig via Bicep.')
param keyVaultName string

@description('Namn på Key Vault-sekretens för kalenderadressen.')
param keyVaultSecretName string

@description('Domänaktivering sker i separata deployment-steg: "binding" (hostname-binding utan SSL), "certificate" (gratis hanterat certifikat), "tlsBinding" (SNI + thumbprint). "disabled" = ingen domänhantering.')
@allowed([
  'disabled'
  'binding'
  'certificate'
  'tlsBinding'
])
param customDomainStage string = 'disabled'

@description('Namn på den user-assigned managed identity som GitHub Actions använder för OIDC-deployment.')
@minLength(3)
@maxLength(24)
param githubIdentityName string

@description('Exakt OIDC-subject som GitHub skickar (immutable-format med owner-/repo-ID).')
param githubOidcSubject string

@description('Objekt-ID för den användare som ska registrera kalenderhemligheten i Key Vault; får rollen Key Vault Secrets Officer. Tomt = ingen tilldelning. (Ett Entra-objekt-ID är ingen hemlighet och ska därför inte vara @secure() — what-if och ARM kan annars inte utvärdera rollvillkoret.)')
#disable-next-line secure-secrets-in-params
param secretAdminPrincipalId string = ''

@description('Namn på lagringskontot för bokningsförfrågningar (Azure Table Storage, Sweden Central). Tomt = bokningslagring förbereds ännu inte. Sätts först efter Skadevis godkännande.')
param bookingStorageAccountName string = ''

@description('Aktiverar Stripe-webhooken på den publika appen. Standard false: endpointen svarar 503 och ingen betalning registreras.')
param enableStripeWebhook bool = false

@description('Aktiverar bokningsförfrågningar i formuläret. Sätts uttryckligen per miljö så att en infra-deployment inte ändrar driftsläget av misstag.')
param enableBookingRequests bool = false

@description('Köar betalnings-, faktura- och betalningslänksmejl till utkorgen. Logic App måste också vara aktiverad för leverans.')
param enableStripeOutbox bool = false

@description('Aktiverar kortbetalningar på gästens betalningssida. Standard false: endast faktura.')
param enableCardCheckout bool = false

@description('Aktiverar Swish-betalningar på gästens betalningssida. Standard false: endast kort och faktura.')
param enableSwishCheckout bool = false

@description('Aktiverar direktbokning med kort på den publika webbplatsen. Standard false. Kräver ett separat godkänt beslut om Airbnb-risk innan den slås på.')
param enableDirectBooking bool = false

@description('Stripe-läge som visas i admin och används av den publika appen.')
@allowed([
  'test'
  'live'
])
param stripeMode string = 'test'

@description('Tillåter live-nyckel. Standard false: live-nycklar blockeras.')
param allowStripeLive bool = false

@description('SecretUri till Stripes hemliga nyckel i befintligt Key Vault. Ingen hemlighet anges i Git. Tomt = fail-closed.')
param stripeSecretUri string = ''

@description('SecretUri till Stripe-webhookens hemlighet i befintligt Key Vault. Ingen hemlighet anges i Git. Tomt = fail-closed.')
param stripeWebhookSecretUri string = ''

@description('Namn på Key Vault-secret för GA4-transaktions-ID. Värdet sätts aldrig i Git.')
param analyticsTransactionSecretName string = 'analytics-transaction-secret'

@description('Tabellnamn för bokningsdata. Namnet är ingen hemlighet.')
param bookingTableName string = 'bookingrequests'

@description('Intervall i minuter för schemalagd Stripe-avstämning.')
@minValue(1)
@maxValue(60)
param stripeReconcileIntervalMinutes int = 5

@description('Objekt-ID (principalId) för Logic Appens system-assigned managed identity. Lämnas tom: Logic Appens tabellroll tilldelas i logic-app-notify-modulen (samma tenant). Parametern finns kvar endast för bakåtkompatibilitet med storage-tables-modulen.')
#disable-next-line secure-secrets-in-params
param logicAppPrincipalId string = ''

var commonTags = {
  Owner: owner
  Environment: environment
  ManagedBy: 'GitHub Actions'
  Domain: customDomain
}

resource rg 'Microsoft.Resources/resourceGroups@2024-11-01' = {
  name: resourceGroupName
  location: location
  tags: commonTags
}

module webapp 'modules/webapp.bicep' = {
  name: 'webapp'
  scope: rg
  params: {
    location: location
    planName: planName
    planSkuName: planSkuName
    planSkuTier: planSkuTier
    webAppName: webAppName
    nodeFxVersion: nodeFxVersion
    environment: environment
    owner: owner
    customDomain: customDomain
    apexDomain: apexDomain
    customDomainStage: customDomainStage
    keyVaultName: keyVaultName
    keyVaultSecretName: keyVaultSecretName
    secretAdminPrincipalId: secretAdminPrincipalId
    bookingStorageAccountName: bookingStorageAccountName
    enableStripeWebhook: enableStripeWebhook
    enableBookingRequests: enableBookingRequests
    enableStripeOutbox: enableStripeOutbox
    enableCardCheckout: enableCardCheckout
    enableSwishCheckout: enableSwishCheckout
    enableDirectBooking: enableDirectBooking
    stripeMode: stripeMode
    allowStripeLive: allowStripeLive
    stripeSecretUri: stripeSecretUri
    stripeWebhookSecretUri: stripeWebhookSecretUri
    analyticsTransactionSecretName: analyticsTransactionSecretName
    bookingTableName: bookingTableName
    stripeReconcileIntervalMinutes: stripeReconcileIntervalMinutes
  }
}

// Permanent lagring för bokningsförfrågningar (Azure Table Storage).
// Skapas bara när bookingStorageAccountName är angivet — inga nya resurser
// skapas utan Skadevis uttryckliga godkännande. Logic Appens identitet skapas
// i logicAppNotify-modulen (samma tenant) och får sin tabellroll där.
module bookingStorage 'modules/storage-tables.bicep' = if (!empty(bookingStorageAccountName)) {
  name: 'booking-storage'
  scope: rg
  params: {
    storageAccountName: bookingStorageAccountName
    location: location
    environment: environment
    owner: owner
    webAppPrincipalId: webapp.outputs.webAppPrincipalId
    logicAppPrincipalId: logicAppPrincipalId
  }
}

// Logic App för bokningsnotiser (Resend via HTTP, API-nyckel i Key Vault).
// Skapas bara när bokningslagringen är beslutad — samma villkor som
// bookingStorage. Deployas i Disabled-läge; aktivering kräver godkännande.
module logicAppNotify 'modules/logic-app-notify.bicep' = if (!empty(bookingStorageAccountName)) {
  name: 'logic-app-notify'
  scope: rg
  params: {
    location: location
    storageAccountName: bookingStorageAccountName
    storageEndpoint: 'https://${bookingStorageAccountName}.table.core.windows.net'
    bookingTableResourceId: subscriptionResourceId('Microsoft.Storage/storageAccounts', bookingStorageAccountName, 'tableServices', 'default', 'tables', 'bookingrequests')
    keyVaultName: keyVaultName
    environment: environment
    owner: owner
  }
}

module githubOidc 'modules/github-oidc.bicep' = {
  name: 'github-oidc'
  scope: rg
  params: {
    identityName: githubIdentityName
    githubOidcSubject: githubOidcSubject
    webAppId: webapp.outputs.webAppId
    environment: environment
    owner: owner
  }
}

output resourceGroupName string = rg.name
output githubIdentityClientId string = githubOidc.outputs.clientId
output githubIdentityPrincipalId string = githubOidc.outputs.principalId
output webAppId string = webapp.outputs.webAppId
output webAppDefaultHostname string = webapp.outputs.defaultHostname
output webAppPrincipalId string = webapp.outputs.webAppPrincipalId
