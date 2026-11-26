using './admin-webapp.bicep'

// ============================================================================
// AKTIVERINGSMALL – deployas INTE i steg 8L.
//
// Används för validate/what-if och senare vid godkänd aktivering:
//   az deployment group what-if -g rg-skadevi-prod \
//     -f infra/admin-webapp.bicep \
//     -p infra/admin-webapp-activation.bicepparam
//
// Innehåller ingen hemlighet. AIRBNB_ICAL_URL sätts som Key Vault-referens,
// inte som ett värde. Secretvärdet ligger kvar i Key Vault.
// ============================================================================

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
param enableBookingWrites = true
param airbnbIcalSecretUri = 'https://kv-skadevi-prod.vault.azure.net/secrets/airbnb-ical-url/'
param doorCodeSecretUri = 'https://kv-skadevi-prod.vault.azure.net/secrets/door-code/'
