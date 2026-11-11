using './logic-app-notify-test.bicep'

// ============================================================================
// REAL TEST — endast efter uttryckligt godkännande och domänverifiering.
//
// Kräver:
//   - verifierad domän i Resend (skadeviherrgard.com)
//   - resend-api-key-test med en giltig Resend-nyckel med ENDAST Sending access
//   - att testworkflowet uttryckligen aktiveras för testfönstret
//
// Använd aldrig produktionsnyckeln resend-api-key här.
// Använd aldrig riktiga gästadresser; endast Resends testadresser.
//
// Detta är en separat parameterfil. Standardfilen
// infra/test/logic-app-notify-test.bicepparam använder en icke-routbar mock-URL.
// ============================================================================

param location = 'swedencentral'
param storageAccountName = 'stskadevibokningprod'
param storageEndpoint = 'https://stskadevibokningprod.table.core.windows.net'
param testTableName = 'bookingrequeststest'
param keyVaultName = 'kv-skadevi-prod'
param testSecretName = 'resend-api-key-test'
param resendApiUrl = 'https://api.resend.com/emails'
param mailFrom = 'bokning@skadeviherrgard.com'
param mailReplyTo = 'delivered+reply@resend.dev'
param hostRecipient = 'delivered+host@resend.dev'
param testOperatorPrincipalId = ''
param testOperatorPrincipalType = 'User'
param environmentName = 'test'
param owner = 'Skadevi Herrgård'
