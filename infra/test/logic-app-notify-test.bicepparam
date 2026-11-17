using './logic-app-notify-test.bicep'

// ============================================================================
// FAS A — isolerad testmiljö för Resend (steg 7J).
//
// Skapar testtabellen bookingrequeststest, test-Logic App i Disabled-läge
// och tabellrollen på ENBART testtabellen. Key Vault-rollen för testsekretet
// skapas separat i fas B efter att resend-api-key-test har skapats manuellt.
//
// Defaults är säkra före domänverifiering:
//   - from: onboarding@resend.dev (får endast skicka till kontots ägarmejl)
//   - host/reply-to: skadevigard@gmail.com (kontrollerad brevlåda)
//
// Efter domänverifiering kan man overrida till Resends testadresser:
//   delivered+host@resend.dev, delivered+guest@resend.dev
//
// För fel-/timeouttester: overrida resendApiUrl till en mock-endpoint.
// Använd aldrig produktionssekretet resend-api-key i testmiljön.
// ============================================================================

param location = 'swedencentral'
param storageAccountName = 'stskadevibokningprod'
param storageEndpoint = 'https://stskadevibokningprod.table.core.windows.net'
param testTableName = 'bookingrequeststest'
param keyVaultName = 'kv-skadevi-prod'
param testSecretName = 'resend-api-key-test'
// Mock-URL: icke-routbar reservdomän. Används för mock-/fel-/timeouttester
// utan riktigt Resend-konto. Riktig Resend-URL får endast användas via
// infra/test/logic-app-notify-test-real.bicepparam efter uttryckligt godkännande.
param resendApiUrl = 'https://mock-resend.invalid/emails'
param mailFrom = 'onboarding@resend.dev'
param mailReplyTo = 'skadevigard@gmail.com'
param hostRecipient = 'skadevigard@gmail.com'
param testOperatorPrincipalId = ''
param testOperatorPrincipalType = 'User'
param environmentName = 'test'
param owner = 'Skadevi Herrgård'
