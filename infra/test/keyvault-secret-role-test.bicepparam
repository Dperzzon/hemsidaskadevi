using '../modules/keyvault-secret-role.bicep'

// ============================================================================
// FAS B — Key Vault Secrets User för TEST-Logic Appen på ENBART testsekretet.
//
// Förutsättningar:
//   1. Fas A är genomförd: logic-skadevi-bokningsnotis-test finns.
//   2. Testsekretet resend-api-key-test har skapats manuellt i
//      kv-skadevi-prod. Använd ett test-API-nyckelvärde, aldrig
//      produktionsnyckeln resend-api-key.
//
// Skapar endast en rolltilldelning på:
//   .../vaults/kv-skadevi-prod/secrets/resend-api-key-test
//
// Ingen åtkomst till resend-api-key eller airbnb-ical-url.
// ============================================================================

param workflowName = 'logic-skadevi-bokningsnotis-test'
param keyVaultName = 'kv-skadevi-prod'
param keyVaultSecretName = 'resend-api-key-test'
