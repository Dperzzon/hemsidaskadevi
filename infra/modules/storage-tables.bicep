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

@description('Objekt-ID (principalId) för Logic Appens system-assigned managed identity — ska ligga i SAMMA Entra-tenant som lagringen (Skadevi-tenant 7169feeb-…). Kors-tenant fungerar inte: Entra-only-lagring avvisar token från annan tenant, och Azure RBAC kan inte tilldela principals från en annan tenant. Får Storage Table Data Contributor på tabellen.')
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
    supportsHttpsTrafficOnly: true
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
// Contributor", tilldelad på TABELLNIVÅ (endast den här tabellen — inte hela
// kontot, inte management-plan).
// OBS: rollens välkända globala GUID (0a9a7301-4a41-4b5c-82ff-4aeefea27a5a)
// finns INTE i Skadevis tenant (deployment "booking-storage" 2026-11-11:
// RoleDefinitionDoesNotExist). Tenantens faktiska definition-ID är
// 0a9a7e1f-b9d0-4cc4-a60d-0319b160aaa3 (az role definition list, roleName
// "Storage Table Data Contributor") och används därför här.
var tableDataContributorRoleId = '0a9a7e1f-b9d0-4cc4-a60d-0319b160aaa3'

resource webAppTableContributor 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(webAppPrincipalId)) {
  name: guid(bookingsTable.id, 'webapp-table-contributor')
  scope: bookingsTable
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', tableDataContributorRoleId)
    principalId: webAppPrincipalId
    principalType: 'ServicePrincipal'
  }
}

resource logicAppTableContributor 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(logicAppPrincipalId)) {
  name: guid(bookingsTable.id, 'logicapp-table-contributor')
  scope: bookingsTable
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', tableDataContributorRoleId)
    principalId: logicAppPrincipalId
    principalType: 'ServicePrincipal'
  }
}

output storageAccountId string = storageAccount.id
output storageAccountName string = storageAccount.name
output tableEndpoint string = 'https://${storageAccount.name}.table.core.windows.net/${tableName}'
output tableResourceId string = bookingsTable.id
output retentionDays int = retentionDays
