using './logic-app-notify-test-workflow.bicep'

// ============================================================================
// Endast uppdatering av testworkflowet (steg 7M).
//
// Ingen tabell, roll, operatörsroll, secret eller Key Vault-roll skapas.
// Testworkflowet behåller state Disabled och använder mock-URL.
// ============================================================================

param location = 'swedencentral'
param storageAccountName = 'stskadevibokningprod'
param storageEndpoint = 'https://stskadevibokningprod.table.core.windows.net'
param testTableName = 'bookingrequeststest'
param keyVaultName = 'kv-skadevi-prod'
param testSecretName = 'resend-api-key-test'
param resendApiUrl = 'https://mock-resend.invalid/emails'
param mailFrom = 'onboarding@resend.dev'
param mailReplyTo = 'skadevigard@gmail.com'
param hostRecipient = 'skadevigard@gmail.com'
param environmentName = 'test'
param owner = 'Skadevi Herrgård'
