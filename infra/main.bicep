targetScope = 'resourceGroup'

@description('Namn på den nya Azure Static Web App-resursen.')
@minLength(1)
@maxLength(60)
param staticWebAppName string

@description('Azure-region som stöder Static Web Apps.')
param location string = 'westeurope'

@description('Resurstaggar.')
param tags object = {}

resource staticWebApp 'Microsoft.Web/staticSites@2024-11-01' = {
  name: staticWebAppName
  location: location
  tags: tags
  sku: {
    name: 'Free'
    tier: 'Free'
  }
  properties: {}
}

output staticWebAppId string = staticWebApp.id
output defaultHostname string = staticWebApp.properties.defaultHostname
