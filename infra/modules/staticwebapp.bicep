targetScope = 'resourceGroup'

@description('Namn på Static Web App-resursen.')
@minLength(2)
@maxLength(60)
param staticWebAppName string

@description('Region för resursen. Innehållet levereras globalt oavsett region.')
param location string

@description('Miljö, används i taggar.')
param environment string

@description('Ägare, används i taggar.')
param owner string

@description('Kostnadsnivå. Free är avgiftsfri men saknar SLA och har lägre kvoter.')
@allowed([
  'Free'
  'Standard'
])
param sku string

@description('Domän som planeras kopplas i portalen; används som tagg.')
param customDomain string

var tags = {
  Owner: owner
  Environment: environment
  ManagedBy: 'GitHub Actions'
  Domain: customDomain
}

// 2024-11-01 är en aktuell stabil API-version med fullständiga Bicep-typdefinitioner
// (nyare versioner saknar ännu typer i den lokala Bicep-kompilatorn).
resource staticWebApp 'Microsoft.Web/staticSites@2024-11-01' = {
  name: staticWebAppName
  location: location
  tags: tags
  sku: {
    name: sku
    tier: sku
  }
  properties: {}
}

output staticWebAppId string = staticWebApp.id
output defaultHostname string = staticWebApp.properties.defaultHostname
