targetScope = 'resourceGroup'

// Förberedd, fristående mall för adminportalen. Den deployas INTE av
// infra/main.bicep och skapar inga resurser förrän den körs uttryckligen.
// Easy Auth, Entra-appregistrering, approller, MFA och custom domain görs
// manuellt enligt docs/bokningsportal.md. Inga hemligheter finns här.

@description('Namn på den separata adminwebbappen.')
param adminAppName string = 'hemsida-skadevi-admin-prod'

@description('Befintlig App Service-plan i samma resursgrupp.')
param planName string = 'asp-skadevi-prod'

@description('Plats för appen. Sweden Central är vald för att ligga nära befintlig drift.')
param location string = 'swedencentral'

@description('Linux-runtime för Node.js.')
param nodeFxVersion string = 'NODE|22-lts'

@description('Lagringskonto som adminportalen läser ifrån.')
param storageAccountName string = 'stskadevibokningprod'

@description('Bokningstabellen som adminportalen läser ifrån.')
param bookingTableName string = 'bookingrequests'

@description('Miljötagg.')
param environment string = 'prod'

@description('Ägartagg.')
param owner string = 'Skadevi'

@description('Principal-ID för GitHub Actions OIDC-identiteten. Tomt = ingen deployroll. Rollen begränsas till den nya adminappen.')
param githubDeployPrincipalId string = ''

@description('Sätts till 1 först när App Service Authentication är aktiverad och verifierad. Appen fail-closed utan denna.')
param adminTrustEasyAuth string = '1'

var tags = {
  Owner: owner
  Environment: environment
  ManagedBy: 'Manual/Bicep'
  Component: 'booking-admin'
}

resource plan 'Microsoft.Web/serverFarms@2024-11-01' existing = {
  name: planName
}

resource bookingTable 'Microsoft.Storage/storageAccounts/tableServices/tables@2023-01-01' existing = {
  name: '${storageAccountName}/default/${bookingTableName}'
}

resource adminApp 'Microsoft.Web/sites@2024-11-01' = {
  name: adminAppName
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
      healthCheckPath: '/healthz'
      appSettings: [
        {
          name: 'NODE_ENV'
          value: 'production'
        }
        {
          name: 'ADMIN_DATA_SOURCE'
          value: 'table'
        }
        {
          name: 'AZURE_STORAGE_ACCOUNT_NAME'
          value: storageAccountName
        }
        {
          name: 'AZURE_TABLE_NAME'
          value: bookingTableName
        }
        {
          name: 'ADMIN_TRUST_EASY_AUTH'
          value: adminTrustEasyAuth
        }
      ]
    }
  }
}

// Endast läsroll på den enskilda tabellen. Ingen Contributor, ingen roll på
// lagringskontot eller resursgruppen, och ingen Key Vault-åtkomst.
// Roll-ID = inbyggda "Storage Table Data Reader".
resource tableReader 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(adminApp.id, bookingTable.id, 'storage-table-data-reader')
  scope: bookingTable
  properties: {
    roleDefinitionId: subscriptionResourceId(
      'Microsoft.Authorization/roleDefinitions',
      '76199698-9eea-4c19-bc75-cec21354c6b6'
    )
    principalId: adminApp.identity.principalId
    principalType: 'ServicePrincipal'
  }
}

// Ger GitHub Actions-identiteten rätt att deploya endast till den nya
// adminappen. Den publika appens befintliga roll och workflow påverkas inte.
// Roll-ID = inbyggda "Website Contributor".
resource githubDeployRoleAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(githubDeployPrincipalId)) {
  name: guid(adminApp.id, githubDeployPrincipalId, 'website-contributor')
  scope: adminApp
  properties: {
    roleDefinitionId: subscriptionResourceId(
      'Microsoft.Authorization/roleDefinitions',
      'de139f84-1756-47ae-9be6-808fbbe84772'
    )
    principalId: githubDeployPrincipalId
    principalType: 'ServicePrincipal'
  }
}

output adminAppId string = adminApp.id
output adminAppDefaultHostname string = adminApp.properties.defaultHostName
output adminAppPrincipalId string = adminApp.identity.principalId
output tableReaderRoleAssignmentId string = tableReader.id
output githubDeployPrincipalId string = githubDeployPrincipalId
