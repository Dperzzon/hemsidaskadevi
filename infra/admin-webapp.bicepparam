using './admin-webapp.bicep'

param adminAppName = 'hemsida-skadevi-admin-prod'
param planName = 'asp-skadevi-prod'
param location = 'swedencentral'
param nodeFxVersion = 'NODE|22-lts'
param storageAccountName = 'stskadevibokningprod'
param bookingTableName = 'bookingrequests'
param environment = 'prod'
param owner = 'Skadevi'
param adminTrustEasyAuth = '1'
param githubDeployPrincipalId = 'ee380faf-83af-489d-82bb-ea48eab13ad5'
// Matchar verifierat produktionsläge 2026-11-19. Ändras endast medvetet.
param enableBookingWrites = true
// Utkorgen fÃ¶r adminmejl Ã¤r fortsatt avstÃ¤ngd.
param enableMailOutbox = true
param enableStripePayments = true
param stripeMode = 'live'
param stripeSwishEnabled = false
param publicBaseUrl = 'https://www.skadeviherrgard.com'
param doorCodeSecretUri = 'https://kv-skadevi-prod.vault.azure.net/secrets/door-code/'
