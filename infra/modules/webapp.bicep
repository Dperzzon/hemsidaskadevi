targetScope = 'resourceGroup'

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

@description('Namn på webbappen.')
@minLength(2)
@maxLength(60)
param webAppName string

@description('Linux-runtime för Node.js.')
param nodeFxVersion string

@description('Miljötagg.')
param environment string

@description('Ägartagg.')
param owner string

@description('Namn på Key Vault som lagrar kalenderhemligheten. Själva hemliga värdet sätts ALDRIG via Bicep.')
@minLength(3)
@maxLength(24)
param keyVaultName string

@description('Namn på Key Vault-sekretens för kalenderadressen.')
param keyVaultSecretName string

@description('Domän som planeras kopplas; används som tagg och i domänstegen.')
param customDomain string

@description('Domänaktivering sker i separata deployment-steg: "binding" (hostname utan SSL), "certificate" (gratis hanterat certifikat, kräver verifierad binding), "tlsBinding" (SNI + thumbprint).')
@allowed([
  'disabled'
  'binding'
  'certificate'
  'tlsBinding'
])
param customDomainStage string = 'disabled'

@description('Objekt-ID för användare som ska få rollen Key Vault Secrets Officer (registrera/rotera kalenderhemligheten). Tomt = ingen rolltilldelning. (Ett Entra-objekt-ID är ingen hemlighet; @secure() förhindrar utvärdering i what-if.)')
#disable-next-line secure-secrets-in-params
param secretAdminPrincipalId string = ''

@description('Namn på lagringskontot för bokningsförfrågningar. Tomt = ingen bokningslagring aktiverad ännu (se infra/modules/storage-tables.bicep).')
param bookingStorageAccountName string = ''

var tags = {
  Owner: owner
  Environment: environment
  ManagedBy: 'GitHub Actions'
  Domain: customDomain
}

// Appinställningar som hanteras fullständigt av Bicep. LISTAN ERSÄTTER ALLA
// befintliga inställningar vid varje infra-deploy — lägg därför ALDRIG till
// inställningar manuellt i portalen; lägg dem här i stället.
// AIRBNB_ICAL_URL är en Key Vault-referens (utan versionsnummer) så att
// hemligheten kan roteras i Key Vault utan ny deployment, och så att
// upprepade deployments aldrig nollställer den.
var appSettings = [
  {
    name: 'NODE_ENV'
    value: 'production'
  }
  {
    name: 'AIRBNB_ICAL_URL'
    value: '@Microsoft.KeyVault(SecretUri=${keyVault.properties.vaultUri}secrets/${keyVaultSecretName})'
  }
  {
    // Totalstängning: bokningsinskick aktiveras först när hela kedjan är
    // verifierad och godkänd — ändra till '1' via Bicep, aldrig manuellt.
    name: 'BOOKING_REQUESTS_ENABLED'
    value: '0'
  }
  if (!empty(bookingStorageAccountName)) {
    name: 'AZURE_STORAGE_ACCOUNT_NAME'
    value: bookingStorageAccountName
  }
]

resource keyVault 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: keyVaultName
  location: location
  tags: tags
  properties: {
    tenantId: subscription().tenantId
    sku: {
      family: 'A'
      name: 'standard'
    }
    enableRbacAuthorization: true
    enableSoftDelete: true
    accessPolicies: []
  }
}

resource plan 'Microsoft.Web/serverFarms@2024-11-01' = {
  name: planName
  location: location
  tags: tags
  sku: {
    name: planSkuName
    tier: planSkuTier
    capacity: 1
  }
  properties: {
    reserved: true
    perSiteScaling: false
  }
}

resource webApp 'Microsoft.Web/sites@2024-11-01' = {
  name: webAppName
  location: location
  tags: tags
  kind: 'app,linux'
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    serverFarmId: plan.id
    httpsOnly: true
    siteConfig: {
      linuxFxVersion: nodeFxVersion
      alwaysOn: true
      http20Enabled: true
      minTlsVersion: '1.2'
      ftpsState: 'Disabled'
      healthCheckPath: '/robots.txt'
      appSettings: appSettings
    }
  }
}

// Ger webbappens systemidentitet läsbehörighet till Key Vault-hemligheter.
// (Roll-ID = inbyggda rollen "Key Vault Secrets User".)
resource keyVaultSecretsUser 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(keyVault.id, 'key-vault-secrets-user')
  scope: keyVault
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '4633458b-17de-408a-b874-0445c86b69e6')
    principalId: webApp.identity.principalId
    principalType: 'ServicePrincipal'
  }
}

// Ger den angivna användaren rätt att registrera/rotera kalenderhemligheten.
// (Roll-ID = inbyggda rollen "Key Vault Secrets Officer".)
resource keyVaultSecretsOfficer 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(secretAdminPrincipalId)) {
  name: guid(keyVault.id, 'key-vault-secrets-officer')
  scope: keyVault
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'b86a8fe4-44ce-4948-aee5-eccb2c155cd7')
    principalId: secretAdminPrincipalId
    principalType: 'User'
  }
}

// Steg 2: hostname-binding UTAN SSL — verifierar och registrerar domänen
// på webbappen. Kräver CNAME (och TXT vid apex) i DNS sedan tidigare.
resource domainBinding 'Microsoft.Web/sites/hostNameBindings@2024-11-01' = if (customDomainStage != 'disabled') {
  parent: webApp
  name: customDomain
  properties: {
    hostNameType: 'Verified'
    sslState: customDomainStage == 'tlsBinding' ? 'SniEnabled' : 'Disabled'
    thumbprint: customDomainStage == 'tlsBinding' ? managedCertificate!.properties.thumbprint : null
  }
}

// Steg 3: gratis App Service Managed Certificate. Kräver att hostname-
// bindningen är verifierad (steg 'binding' i ett tidigare deployment) och
// att TXT-posten asuid.<domän> finns i DNS. Följ därför steg-ordningen —
// hoppa inte direkt till 'certificate' eller 'tlsBinding' från 'disabled'.
resource managedCertificate 'Microsoft.Web/certificates@2024-11-01' = if (customDomainStage == 'certificate' || customDomainStage == 'tlsBinding') {
  name: '${webAppName}-managed-cert'
  location: location
  tags: tags
  properties: {
    serverFarmId: plan.id
    canonicalName: customDomain
    domainValidationMethod: 'dns-txt-token'
  }
}

output webAppId string = webApp.id
output defaultHostname string = webApp.properties.defaultHostName
output keyVaultName string = keyVault.name
output webAppPrincipalId string = webApp.identity.principalId
