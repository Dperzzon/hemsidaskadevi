targetScope = 'resourceGroup'

// ============================================================================
// UPPDATERING AV ENDAST TESTWORKFLOWET (steg 7M).
//
// Denna mall rör endast Logic App logic-skadevi-bokningsnotis-test.
// Den skapar INTE testtabellen, tabellrollen, operatorrollen eller något
// Key Vault-secret. Testtabellen och valvet refereras endast som existing.
//
// Workflowet använder testdefinitionen med mottagarspärr och mock-URL.
// Det skapas/uppdateras alltid i Disabled-läge.
// ============================================================================

@description('Plats — Sweden Central.')
param location string = 'swedencentral'

@description('Befintligt lagringskonto (endast referens).')
param storageAccountName string = 'stskadevibokningprod'

@description('Tabellslutpunkt för lagringskontot.')
param storageEndpoint string = 'https://stskadevibokningprod.table.${environment().suffixes.storage}'

@description('Befintlig testtabell (endast referens).')
param testTableName string = 'bookingrequeststest'

@description('Befintligt Key Vault (endast referens).')
param keyVaultName string = 'kv-skadevi-prod'

@description('Testsekretets namn. Sekretet skapas inte här.')
param testSecretName string = 'resend-api-key-test'

@description('Icke-routbar mock-URL. Ska inte ändras till Resend i denna mall.')
param resendApiUrl string = 'https://mock-resend.invalid/emails'

@description('Testavsändare.')
param mailFrom string = 'onboarding@resend.dev'

@description('Reply-to. Endast en av de fyra tillåtna testmottagarna.')
param mailReplyTo string = 'skadevigard@gmail.com'

@description('Värdmottagare. Endast en av de fyra tillåtna testmottagarna.')
param hostRecipient string = 'skadevigard@gmail.com'

@description('Miljötagg.')
param environmentName string = 'test'

@description('Ägartagg.')
param owner string = 'Skadevi Herrgård'

var testWorkflowName = 'logic-skadevi-bokningsnotis-test'

resource storageAccount 'Microsoft.Storage/storageAccounts@2023-05-01' existing = {
  name: storageAccountName
}

resource tableService 'Microsoft.Storage/storageAccounts/tableServices@2023-05-01' existing = {
  parent: storageAccount
  name: 'default'
}

resource existingTestTable 'Microsoft.Storage/storageAccounts/tableServices/tables@2023-05-01' existing = {
  parent: tableService
  name: testTableName
}

module testLogicApp '../modules/logic-app-notify.bicep' = {
  name: 'logicSkadeviBokningsnotisTestUpdate'
  params: {
    location: location
    workflowName: testWorkflowName
    storageEndpoint: storageEndpoint
    storageAccountName: storageAccountName
    tableName: testTableName
    resendApiUrl: resendApiUrl
    bookingTableResourceId: existingTestTable.id
    keyVaultName: keyVaultName
    keyVaultSecretName: testSecretName
    mailFrom: mailFrom
    mailReplyTo: mailReplyTo
    hostRecipient: hostRecipient
    assignTableRole: false
    workflowDefinition: json(loadTextContent('../logicapp/email-notifier-test.workflow.json'))
    environment: environmentName
    owner: owner
  }
}

output testWorkflowName string = testWorkflowName
output testWorkflowId string = testLogicApp.outputs.workflowId
output testPrincipalId string = testLogicApp.outputs.principalId
output state string = testLogicApp.outputs.state
