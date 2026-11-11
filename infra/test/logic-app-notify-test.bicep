targetScope = 'resourceGroup'

// ============================================================================
// ISOLERAD TESTMILJÖ för Resend-flödet (steg 7J).
//
// Skapar ENDAST:
//   1. Testtabellen bookingrequeststest i befintligt lagringskonto
//   2. Logic App logic-skadevi-bokningsnotis-test (state: Disabled)
//   3. Storage Table Data Contributor för test-Logic Appens managed identity
//      på ENBART bookingrequeststest
//   4. Valfri Storage Table Data Contributor för en testoperatör på ENBART
//      bookingrequeststest (krävs för att seeda testposter lokalt)
//
// Key Vault-rollen för testsekretet resend-api-key-test skapas separat i fas B
// med infra/test/keyvault-secret-role-test.bicepparam.
//
// Produktionstabellen bookingrequests, produktionsworkflowet, produktions-
// sekretet resend-api-key och DNS rörs aldrig.
// ============================================================================

@description('Plats — Sweden Central.')
param location string = 'swedencentral'

@description('Befintligt lagringskonto. Testtabellen isoleras i samma konto för lägst kostnad.')
param storageAccountName string = 'stskadevibokningprod'

@description('Tabellslutpunkt för lagringskontot.')
param storageEndpoint string = 'https://stskadevibokningprod.table.${environment().suffixes.storage}'

@description('Testtabellens namn. Får aldrig vara bookingrequests.')
@allowed([
  'bookingrequeststest'
])
param testTableName string = 'bookingrequeststest'

@description('Befintligt Key Vault för testsekretet.')
param keyVaultName string = 'kv-skadevi-prod'

@description('Testsekretets namn. Får aldrig vara resend-api-key.')
@allowed([
  'resend-api-key-test'
])
param testSecretName string = 'resend-api-key-test'

@description('Resend-slutpunkt. Default är en icke-routbar mock-URL. Riktig Resend-URL får endast användas i ett separat, godkänt realt test med giltig testnyckel.')
param resendApiUrl string = 'https://mock-resend.invalid/emails'

@description('Testavsändare. onboarding@resend.dev får endast skicka till Resend-kontots ägarmejl före domänverifiering.')
param mailFrom string = 'onboarding@resend.dev'

@description('Reply-to för testmejl. Använd endast testadress eller kontrollerad testbrevlåda.')
param mailReplyTo string = 'delivered+reply@resend.dev'

@description('Mottagare för testmejl till värden. Använd endast testadress eller kontrollerad testbrevlåda.')
param hostRecipient string = 'delivered+host@resend.dev'

@description('Objekt-ID för testoperatören som ska kunna seeda testtabellen lokalt. Lämna tom för att inte skapa rollen.')
param testOperatorPrincipalId string = ''

@description('Principaltyp för testoperatören (User, Group eller ServicePrincipal).')
param testOperatorPrincipalType string = 'User'

@description('Rolldefinitions-ID för Storage Table Data Contributor i SKADEVIS tenant.')
param tableDataContributorRoleId string = '0a9a7e1f-b9d0-4cc4-a60d-0319b160aaa3'

@description('Miljötagg.')
param environmentName string = 'test'

@description('Ägartagg.')
param owner string = 'Skadevi Herrgård'

var testWorkflowName = 'logic-skadevi-bokningsnotis-test'

// Skyddsräcken: parametrarna är låsta till testvärden ovan. Produktions-
// tabellen och produktionssekretet kan därför inte väljas av misstag.

resource storageAccount 'Microsoft.Storage/storageAccounts@2023-05-01' existing = {
  name: storageAccountName
}

resource tableService 'Microsoft.Storage/storageAccounts/tableServices@2023-05-01' existing = {
  parent: storageAccount
  name: 'default'
}

// Ny isolerad testtabell. Produktionstabellen bookingrequests refereras inte.
resource testTable 'Microsoft.Storage/storageAccounts/tableServices/tables@2023-05-01' = {
  parent: tableService
  name: testTableName
}

// Testworkflowet återanvänder samma beprövade flödesdefinition men pekar på
// testtabellen, testsekretet och en test-/mock-URL. assignTableRole=false:
// tabellrollen skapas nedan mot den nya testtabellen i stället.
module testLogicApp '../modules/logic-app-notify.bicep' = {
  name: 'logicSkadeviBokningsnotisTest'
  params: {
    location: location
    workflowName: testWorkflowName
    storageEndpoint: storageEndpoint
    storageAccountName: storageAccountName
    tableName: testTableName
    resendApiUrl: resendApiUrl
    bookingTableResourceId: testTable.id
    keyVaultName: keyVaultName
    keyVaultSecretName: testSecretName
    mailFrom: mailFrom
    mailReplyTo: mailReplyTo
    hostRecipient: hostRecipient
    assignTableRole: false
    environment: environmentName
    owner: owner
  }
}

// Endast testtabellen. Ingen roll på bookingrequests.
resource testTableRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(testTable.id, 'logicapp-test-table-contributor')
  scope: testTable
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', tableDataContributorRoleId)
    principalId: testLogicApp.outputs.principalId
    principalType: 'ServicePrincipal'
  }
}

// Valfri roll för lokal seedning. Endast på testtabellen, aldrig produktion.
resource operatorTableRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(testOperatorPrincipalId)) {
  name: guid(testTable.id, 'test-operator-table-contributor')
  scope: testTable
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', tableDataContributorRoleId)
    principalId: testOperatorPrincipalId
    principalType: testOperatorPrincipalType
  }
}

output testWorkflowName string = testWorkflowName
output testWorkflowId string = testLogicApp.outputs.workflowId
output testPrincipalId string = testLogicApp.outputs.principalId
output testTableId string = testTable.id
output testTableName string = testTable.name
output testSecretName string = testSecretName
output testTableRoleId string = testTableRole.id
