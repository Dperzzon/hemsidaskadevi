targetScope = 'subscription'

@description('Namn på resursgruppen som skapas och hanteras av mallen.')
@minLength(1)
@maxLength(90)
param resourceGroupName string

@description('Plats för resursgruppen (fristående från Static Web Apps regioner).')
param resourceGroupLocation string

@description('Namn på Static Web App-resursen.')
@minLength(2)
@maxLength(60)
param staticWebAppName string

@description('Region för Static Web App. Stöds endast i vissa regioner; se docs/driftsattning.md.')
param staticWebAppLocation string

@description('Miljötagg, t.ex. prod.')
param environment string

@description('Ägartagg.')
param owner string

@description('Kostnadsnivå för Static Web Apps. Free är avgiftsfri men saknar SLA.')
@allowed([
  'Free'
  'Standard'
])
param sku string

@description('Domän som planeras kopplas till Static Web App. Används som tagg; själva domänkopplingen görs i portalen efter DNS-ändring.')
param customDomain string

var commonTags = {
  Owner: owner
  Environment: environment
  ManagedBy: 'GitHub Actions'
  Domain: customDomain
}

resource rg 'Microsoft.Resources/resourceGroups@2024-11-01' = {
  name: resourceGroupName
  location: resourceGroupLocation
  tags: commonTags
}

module staticWebApp 'modules/staticwebapp.bicep' = {
  name: 'staticwebapp'
  scope: rg
  params: {
    staticWebAppName: staticWebAppName
    location: staticWebAppLocation
    environment: environment
    owner: owner
    sku: sku
    customDomain: customDomain
  }
}

output resourceGroupName string = rg.name
output staticWebAppId string = staticWebApp.outputs.staticWebAppId
output staticWebAppDefaultHostname string = staticWebApp.outputs.defaultHostname
