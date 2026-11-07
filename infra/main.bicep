targetScope = 'resourceGroup'

@description('Namn på Static Web App-resursen.')
@minLength(2)
@maxLength(60)
param staticWebAppName string

@description('Azure-region. Innehållet betjänas globalt oavsett vald region. Om en region inte accepteras vid skapande, byt till westeurope.')
param location string = 'swedencentral'

@description('Kostnadsnivå. Free är avgiftsfri men saknar SLA och har lägre kvoter.')
@allowed([
  'Free'
  'Standard'
])
param skuTier string = 'Free'

@description('Taggar för ägarskap, miljö och styrning.')
param tags object = {
  Owner: 'Skadevi Herrgård'
  Environment: 'prod'
  ManagedBy: 'GitHub Actions'
}

resource staticWebApp 'Microsoft.Web/staticSites@2024-11-01' = {
  name: staticWebAppName
  location: location
  tags: tags
  sku: {
    name: skuTier
    tier: skuTier
  }
  properties: {}
}

output staticWebAppId string = staticWebApp.id
output defaultHostname string = staticWebApp.properties.defaultHostname
output resourceGroupName string = resourceGroup().name
