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

@description('Förberedd aktiveringsbrytare. false = Reader och skrivspärrar. true = Contributor, Key Vault Secrets User på airbnb-ical-url, AIRBNB_ICAL_URL som Key Vault-referens samt ADMIN_WRITES_ENABLED=1. Deployas inte i detta steg.')
param enableBookingWrites bool = false

@description('Key Vault som innehåller Airbnb-kalenderns hemliga adress.')
param keyVaultName string = 'kv-skadevi-prod'

@description('Namn på Key Vault-secretet med Airbnb iCal-adressen. Värdet får aldrig läggas i Git.')
param airbnbSecretName string = 'airbnb-ical-url'

@description('Fullständig SecretUri till airbnb-ical-url, utan versionsnummer. Sätts först vid aktivering och innehåller ingen hemlighet i sig.')
param airbnbIcalSecretUri string = ''

@description('Tenantverifierat rolldefinitions-ID för Storage Table Data Contributor (0a9a7e1f-... i Skadevis tenant).')
param tableDataContributorRoleId string = '0a9a7e1f-b9d0-4cc4-a60d-0319b160aaa3'

@description('Rolldefinitions-ID för Key Vault Secrets User.')
#disable-next-line secure-secrets-in-params
param keyVaultSecretsUserRoleId string = '4633458b-17de-408a-b874-0445c86b69e6'

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

resource keyVault 'Microsoft.KeyVault/vaults@2023-07-01' existing = {
  name: keyVaultName
}

resource airbnbSecret 'Microsoft.KeyVault/vaults/secrets@2023-07-01' existing = {
  parent: keyVault
  name: airbnbSecretName
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
      appSettings: concat([
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
        {
          name: 'ADMIN_PORT'
          value: '8080'
        }
        {
          name: 'WEBSITES_PORT'
          value: '8080'
        }
        {
          name: 'ADMIN_WRITES_ENABLED'
          value: enableBookingWrites ? '1' : '0'
        }
        {
          name: 'ADMIN_MAIL_OUTBOX_ENABLED'
          value: '0'
        }
        {
          name: 'ADMIN_REQUIRE_AIRBNB_CHECK'
          value: '1'
        }
      ], enableBookingWrites && !empty(airbnbIcalSecretUri) ? [
        {
          name: 'AIRBNB_ICAL_URL'
          value: '@Microsoft.KeyVault(SecretUri=${airbnbIcalSecretUri})'
        }
      ] : [])
    }
  }
}

// I normalläget endast läsroll på den enskilda tabellen. När
// enableBookingWrites=true ersätts den av Contributor, som omfattar läsning.
// Roll-ID = inbyggda "Storage Table Data Reader".
resource tableReader 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!enableBookingWrites) {
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

// Aktiveringsläge: Contributor på exakt bokningstabellen. Contributor omfattar
// läsning, därför tas den separata Reader-tilldelningen bort i samma läge.
resource tableContributor 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (enableBookingWrites) {
  name: guid(adminApp.id, bookingTable.id, 'storage-table-data-contributor')
  scope: bookingTable
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', tableDataContributorRoleId)
    principalId: adminApp.identity.principalId
    principalType: 'ServicePrincipal'
  }
}

// Endast getSecret på det enskilda secretet airbnb-ical-url, inte hela valvet.
resource airbnbSecretUser 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (enableBookingWrites) {
  name: guid(airbnbSecret.id, 'admin-kv-secret-user')
  scope: airbnbSecret
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', keyVaultSecretsUserRoleId)
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
output tableReaderRoleAssignmentId string = enableBookingWrites ? '' : tableReader.id
output tableContributorRoleAssignmentId string = enableBookingWrites ? tableContributor.id : ''
output airbnbSecretUserRoleAssignmentId string = enableBookingWrites ? airbnbSecretUser.id : ''
output githubDeployPrincipalId string = githubDeployPrincipalId
