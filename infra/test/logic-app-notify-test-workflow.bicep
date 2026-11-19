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

@description('Befintlig testtabell (endast referens). Får aldrig vara bookingrequests.')
@allowed([
  'bookingrequeststest'
])
param testTableName string = 'bookingrequeststest'

@description('Befintligt Key Vault (endast referens).')
param keyVaultName string = 'kv-skadevi-prod'

@description('Testsekretets namn. Sekretet skapas inte här. Får aldrig vara resend-api-key.')
@allowed([
  'resend-api-key-test'
])
param testSecretName string = 'resend-api-key-test'

@description('Resend-slutpunkt. Används endast när allowRealResend=true; annars tvingas icke-routbar mock-URL.')
param resendApiUrl string = 'https://mock-resend.invalid/emails'

@description('Sätt endast till true i en separat, uttryckligen godkänd real-testparametrering. Standard är false.')
param allowRealResend bool = false

@description('Säker startgräns för testutkorgen. Framtida värde = ingen sändning.')
param outboxActivationSince string = '9999-12-31T23:59:59Z'

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

// Extra skyddsräcke: även om en riktig URL anges av misstag används mock-URL
// ända tills allowRealResend uttryckligen sätts till true.
var effectiveResendApiUrl = allowRealResend ? resendApiUrl : 'https://mock-resend.invalid/emails'

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
    resendApiUrl: effectiveResendApiUrl
    outboxActivationSince: outboxActivationSince
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
