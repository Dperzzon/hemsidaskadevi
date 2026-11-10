targetScope = 'resourceGroup'

@description('Lagringskonto för permanent lagring av bokningsförfrågningar (Azure Table Storage). Skapas i Sweden Central. OBS: modulen förbereder infrastrukturen — den körs inte förrän Skadevi godkänt (skriptet deploy_bicep är avstängt i workflow).')
@minLength(3)
@maxLength(24)
param storageAccountName string

@description('Plats (fast Sverige Central enligt beslut).')
param location string = 'swedencentral'

@description('Namn på tabellen för bokningsförfrågningar.')
param tableName string = 'bookingrequests'

@description('Miljötagg.')
param environment string = 'prod'

@description('Ägartagg.')
param owner string = 'Skadevi Herrgård'

@description('Objekt-ID (principalId) för webbappens system-assigned managed identity — får Storage Table Data Contributor på tabellen. Ett Entra-objekt-ID är ingen hemlighet och ska därför inte vara @secure() (what-if/ARM kan annars inte utvärdera rollvillkoret).')
#disable-next-line secure-secrets-in-params
param webAppPrincipalId string = ''

@description('Objekt-ID (principalId) för Logic Appens system-assigned managed identity — får Storage Table Data Contributor på tabellen.')
#disable-next-line secure-secrets-in-params
param logicAppPrincipalId string = ''

@description('Dagar som bokningsförfrågningar sparas innan gallring (GDPR-minimering).')
@allowed([
  24
  36
  60
])
param retentionDays int = 24

var tags = {
  Owner: owner
  Environment: environment
  ManagedBy: 'Bicep (Skadevi)'
}

// Lagringskonto för bokningsdata. Table Storage är billigast för enkel
// entitetslagring med låg volym. Offentlig slutpunkt tillåts (krävs för
// Entra-autentiserad dataplansåtkomst från App Service/Logic Apps), men
// nyckelåtkomst stängs av: all åtkomst sker med Managed Identity + RBAC.
resource storageAccount 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: storageAccountName
  location: location
  tags: tags
  sku: {
    name: 'Standard_LRS' // billigast; bokningsdata är viktiga men små — LRS räcker, se docs för backuprutin
  }
  kind: 'StorageV2'
  properties: {
    httpsTrafficOnly: true
    minimumTlsVersion: 'TLS1_2'
    allowSharedKeyAccess: false // tvingar Entra/Managed Identity — inga kontonycklar
    publicNetworkAccess: 'Enabled' // dataplansåtkomst via Entra; RBAC krävs i alla fall
    networkAcls: {
      defaultAction: 'Allow' // skyddet är RBAC + Entra, inte nätverks-IP-listor (App Service har svävande utgående IP:er)
    }
  }
}

resource tableService 'Microsoft.Storage/storageAccounts/tableServices@2023-05-01' = {
  parent: storageAccount
  name: 'default'
}

resource bookingsTable 'Microsoft.Storage/storageAccounts/tableServices/tables@2023-05-01' = {
  parent: tableService
  name: tableName
}

// RBAC med minsta möjliga behörighet: dataplansrollen "Storage Table Data
// Contributor" (0a9a7301-4a41-4b5c-82ff-4aeefea27a5a), tilldelad på TABELLNIVÅ
// (endast den här tabellen — inte hela kontot, inte management-plan).
resource webAppTableContributor 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(webAppPrincipalId)) {
  name: guid(bookingsTable.id, 'webapp-table-contributor')
  scope: bookingsTable
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '0a9a7301-4a41-4b5c-82ff-4aeefea27a5a')
    principalId: webAppPrincipalId
    principalType: 'ServicePrincipal'
  }
}

resource logicAppTableContributor 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(logicAppPrincipalId)) {
  name: guid(bookingsTable.id, 'logicapp-table-contributor')
  scope: bookingsTable
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '0a9a7301-4a41-4b5c-82ff-4aeefea27a5a')
    principalId: logicAppPrincipalId
    principalType: 'ServicePrincipal'
  }
}

output storageAccountId string = storageAccount.id
output storageAccountName string = storageAccount.name
output tableEndpoint string = 'https://${storageAccount.name}.table.core.windows.net/${tableName}'
output tableResourceId string = bookingsTable.id
output retentionDays int = retentionDays
