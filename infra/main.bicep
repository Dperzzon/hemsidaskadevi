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

@description('Objekt-ID för den användare som ska registrera kalenderhemligheten i Key Vault; får rollen Key Vault Secrets Officer. Tomt = ingen tilldelning. (Ett Entra-objekt-ID är ingen hemlighet och ska därför inte vara @secure() — what-if och ARM kan annars inte utvärdera rollvillkoret.)')
#disable-next-line secure-secrets-in-params
param secretAdminPrincipalId string = ''

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
    customDomainStage: customDomainStage
    keyVaultName: keyVaultName
    keyVaultSecretName: keyVaultSecretName
    secretAdminPrincipalId: secretAdminPrincipalId
  }
}

output resourceGroupName string = rg.name
output webAppId string = webapp.outputs.webAppId
output webAppDefaultHostname string = webapp.outputs.defaultHostname
