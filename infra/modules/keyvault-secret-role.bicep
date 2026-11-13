targetScope = 'resourceGroup'

// FAS B — Key Vault Secrets User på ENBART sekretessen resend-api-key.
//
// Förutsättningar:
//   1. Fas A har skapat Logic App logic-skadevi-bokningsnotis.
//   2. Sekretet resend-api-key har skapats manuellt i Key Vault.
//
// Modulen skapar endast en rolltilldelning på sekretesscope. Den skapar eller
// ändrar inte Logic Appen, valvet, sekretessvärdet eller någon annan resurs.
// Rolltilldelningen kan inte skapas förrän sekretesresursen finns, eftersom
// den är en extension-resurs på sekretesscopet.

@description('Namn på befintlig Logic App vars managed identity får rollen.')
param workflowName string = 'logic-skadevi-bokningsnotis'

@description('Namn på befintligt Key Vault.')
param keyVaultName string = 'kv-skadevi-prod'

@description('Namn på det befintliga sekretet med Resend-API-nyckeln.')
param keyVaultSecretName string = 'resend-api-key'

@description('Rolldefinitions-ID för Key Vault Secrets User i SKADEVIS tenant (dataActions: secrets/getSecret + readMetadata).')
#disable-next-line secure-secrets-in-params
param keyVaultSecretsUserRoleId string = '4633458b-17de-408a-b874-0445c86b69e6'

resource workflow 'Microsoft.Logic/workflows@2019-05-01' existing = {
  name: workflowName
}

resource keyVault 'Microsoft.KeyVault/vaults@2023-07-01' existing = {
  name: keyVaultName
}

resource resendSecret 'Microsoft.KeyVault/vaults/secrets@2023-07-01' existing = {
  parent: keyVault
  name: keyVaultSecretName
}

// Minsta möjliga scope: endast det enskilda sekretet, inte hela valvet.
resource kvSecretsUser 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(resendSecret.id, 'logicapp-kv-secret-user')
  scope: resendSecret
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', keyVaultSecretsUserRoleId)
    principalId: workflow.identity.principalId
    principalType: 'ServicePrincipal'
  }
}

output roleAssignmentId string = kvSecretsUser.id
output secretScope string = resendSecret.id
output principalId string = workflow.identity.principalId
