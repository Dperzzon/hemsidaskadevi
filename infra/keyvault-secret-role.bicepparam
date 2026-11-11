using './modules/keyvault-secret-role.bicep'

// ============================================================================
// FAS B — Key Vault Secrets User på ENBART sekretessen resend-api-key.
//
// FÖRUTSÄTTNINGAR:
//   1. Fas A är genomförd: Logic App logic-skadevi-bokningsnotis finns.
//   2. Sekretet resend-api-key har skapats manuellt i kv-skadevi-prod.
//
// Skapar ENDAST en rolltilldelning:
//   Key Vault Secrets User på
//   /subscriptions/.../vaults/kv-skadevi-prod/secrets/resend-api-key
//
// Logic App, tabellroll, Key Vault, sekretessvärde och DNS ändras inte.
//
// Kör alltid validate + what-if före en eventuell deployment:
//   az deployment group validate -g rg-skadevi-prod `
//     --template-file infra/modules/keyvault-secret-role.bicep `
//     --parameters infra/keyvault-secret-role.bicepparam
//   az deployment group what-if -g rg-skadevi-prod `
//     --template-file infra/modules/keyvault-secret-role.bicep `
//     --parameters infra/keyvault-secret-role.bicepparam
//
// Avbryt om what-if visar Modify eller Delete på befintliga resurser.
// ============================================================================

param workflowName = 'logic-skadevi-bokningsnotis'
param keyVaultName = 'kv-skadevi-prod'
param keyVaultSecretName = 'resend-api-key'
