using './modules/logic-app-notify.bicep'

// ============================================================================
// Isolerad deployment av Logic App för bokningsnotiser (steg 7C).
//
// Skapar ENDAST:
//   1. Logic App logic-skadevi-bokningsnotis (state: Disabled)
//   2. Storage Table Data Contributor för appens managed identity på
//      bokningstabellen (tabellnivå)
//   3. Key Vault Secrets User för appens managed identity på kv-skadevi-prod
//
// Rör INTE App Service, lagringskontot, Key Vault-konfigurationen eller DNS.
// Inga hemligheter skapas och inga mejl skickas.
//
// Kör alltid validate + what-if före en eventuell deployment:
//   az deployment group validate -g rg-skadevi-prod `
//     --template-file infra/modules/logic-app-notify.bicep `
//     --parameters infra/logic-app-notify.bicepparam
//   az deployment group what-if -g rg-skadevi-prod `
//     --template-file infra/modules/logic-app-notify.bicep `
//     --parameters infra/logic-app-notify.bicepparam
//
// Avbryt om what-if visar Modify eller Delete på befintliga resurser.
// ============================================================================

param location = 'swedencentral'
param workflowName = 'logic-skadevi-bokningsnotis'
param storageAccountName = 'stskadevibokningprod'
param storageEndpoint = 'https://stskadevibokningprod.table.core.windows.net'
param bookingTableResourceId = '/subscriptions/7c9799f7-c50b-4450-8abd-159481748821/resourceGroups/rg-skadevi-prod/providers/Microsoft.Storage/storageAccounts/stskadevibokningprod/tableServices/default/tables/bookingrequests'
param keyVaultName = 'kv-skadevi-prod'
param keyVaultSecretName = 'resend-api-key'
param mailFrom = 'bokning@skadeviherrgard.com'
param mailReplyTo = 'skadevigard@gmail.com'
param hostRecipient = 'skadevigard@gmail.com'
param environment = 'prod'
param owner = 'Skadevi Herrgård'
