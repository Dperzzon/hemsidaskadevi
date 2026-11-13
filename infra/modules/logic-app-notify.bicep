targetScope = 'resourceGroup'

// Logic App för bokningsnotiser via Resend (Skadevi-tenant).
//
// HISTORIK: modulen driftsatte först Logic App i Splat Reality-prenumerationen
// (rg-splatcrm-prod) med Splat:s Gmail-anslutning; därefter en egen Gmail-
// connection i Skadevi-tenant. Båda planerna övergavs: privata Gmail-konton
// begränsar HTTP-actions, och ACS Email pensioneras 2028-09-30. Slutlig lösning
// (beslut 2026-11-11): Resends Email API via HTTP-action, API-nyckel i Key
// Vault, all Azure-åtkomst med Managed Identity.
//
// - Flödet använder ENDAST en Recurrence-trigger (pollning av utkorgen i
//   Azure Table Storage) — ingen inkommande HTTP-trigger/webbhook.
// - Åtkomst till lagringen sker med Logic Appens system-assigned managed
//   identity (audience https://storage.azure.com/) och rollen Storage Table
//   Data Contributor på TABELLEN (tilldelas här, samma tenant).
// - API-nyckeln hämtas per körning direkt från Key Vault med managed identity
//   (audience https://vault.azure.net). Rollen Key Vault Secrets User scopas
//   till ENBART sekretessen resend-api-key och tilldelas i den separata fas B-
//   modulen (keyvault-secret-role.bicep) efter att sekretet skapats manuellt.
//   Nyckeln finns ALDRIG i Bicep, GitHub eller kod.
// - Logic App skapas i Disabled-läge och aktiveras först efter att Resend-
//   kontot, API-nyckeln och domänverifieringen (DNS) är klara och godkända.
// - Körhistorik: känsliga fält döljs med secureData (inputs/outputs) på alla
//   HTTP-actions.

@description('Plats — Sweden Central enligt beslut.')
param location string = 'swedencentral'

@description('Namn på Logic App-flödet.')
param workflowName string = 'logic-skadevi-bokningsnotis'

@description('Slutpunkt för Skadevis bokningstabell, t.ex. https://konto.table.core.windows.net.')
param storageEndpoint string

@description('Namn på bokningslagringskontot (befintligt, deployat av storage-tables-modulen).')
param storageAccountName string

@description('Namn på bokningstabellen som flödet läser/skriver. Produktion: bookingrequests. Test: bookingrequeststest.')
param tableName string = 'bookingrequests'

@description('Resend-API-slutpunkt. Produktion: https://api.resend.com/emails. Test kan peka på en mock-endpoint.')
param resendApiUrl string = 'https://api.resend.com/emails'

@description('Sätt till false i testwrappern när tabellrollen skapas separat mot en nyskapad testtabell.')
param assignTableRole bool = true

@description('Workflowdefinition. Produktion använder standardfilen; testwrappern kan skicka en testdefinition med mottagarspärr.')
param workflowDefinition object = json(loadTextContent('../logicapp/email-notifier.workflow.json'))

@description('Fullständigt resurs-ID till bokningstabellen (används för deterministiskt rolltilldelningsnamn).')
param bookingTableResourceId string

@description('Namn på befintligt Key Vault som ska lagra Resend-API-nyckeln.')
param keyVaultName string

@description('Namn på sekretens med Resend-API-nyckeln (värdet sätts ALDRIG via Bicep).')
param keyVaultSecretName string = 'resend-api-key'

@description('Avsändaradress (kräver verifierad domän hos Resend).')
param mailFrom string = 'bokning@skadeviherrgard.com'

@description('Reply-to-adress för gästbekräftelser.')
param mailReplyTo string = 'skadevigard@gmail.com'

@description('Mottagare för bokningsnotiser till värden.')
param hostRecipient string = 'skadevigard@gmail.com'

@description('Säker startgräns: endast utkorgsposter skapade vid/efter denna ISO-tid får skickas. Framtida värde = ingen automatisk sändning.')
param outboxActivationSince string = '9999-12-31T23:59:59Z'

@description('Rolldefinitions-ID för Storage Table Data Contributor i SKADEVIS tenant (verifierat 2026-11-11 — avviker från välkänd global GUID).')
param tableDataContributorRoleId string = '0a9a7e1f-b9d0-4cc4-a60d-0319b160aaa3'

@description('Miljötagg.')
param environment string = 'prod'

@description('Ägartagg.')
param owner string = 'Skadevi Herrgård'

var tags = {
  Owner: owner
  Environment: environment
  ManagedBy: 'Bicep (Skadevi)'
}

// Logic Apps kräver att definitionen är ett JSON-objekt i resource-payloaden.
// Produktion använder standardparametern; testwrappern skickar testdefinitionen.
var resolvedWorkflowDefinition = workflowDefinition

// Befintligt Key Vault (skapad av webapp-modulen) refereras — skapas inte här.
resource keyVault 'Microsoft.KeyVault/vaults@2023-07-01' existing = {
  name: keyVaultName
}

// Befintlig bokningstabell (skapad av storage-tables-modulen) refereras så att
// rolltilldelningen kan scope:as till tabellen.
resource bookingStorageAccount 'Microsoft.Storage/storageAccounts@2023-05-01' existing = {
  name: storageAccountName
}

resource bookingTableService 'Microsoft.Storage/storageAccounts/tableServices@2023-05-01' existing = {
  parent: bookingStorageAccount
  name: 'default'
}

resource bookingsTable 'Microsoft.Storage/storageAccounts/tableServices/tables@2023-05-01' existing = {
  parent: bookingTableService
  name: tableName
}

resource workflow 'Microsoft.Logic/workflows@2019-05-01' = {
  name: workflowName
  location: location
  tags: tags
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    state: 'Disabled' // aktiveras först efter verifiering (godkännande krävs)
    definition: resolvedWorkflowDefinition
    parameters: {
      storageEndpoint: {
        value: storageEndpoint
      }
      tableName: {
        value: tableName
      }
      resendApiUrl: {
        value: resendApiUrl
      }
      mailFrom: {
        value: mailFrom
      }
      mailReplyTo: {
        value: mailReplyTo
      }
      hostRecipient: {
        value: hostRecipient
      }
      outboxActivationSince: {
        value: outboxActivationSince
      }
      keyVaultSecretUri: {
        value: '${keyVault.properties.vaultUri}secrets/${keyVaultSecretName}?api-version=7.4'
      }
    }
  }
}

// Lägsta möjliga behörighet: Storage Table Data Contributor endast på
// bokningstabellen. Roll-GUID är tenantverifierad (se param-kommentar).
// Tabellen deployas inte i denna modul (den ägs av storage-tables-modulen),
// så scope sätts till tabellens resurs-ID. I testwrappern sätts
// assignTableRole=false och rollen skapas i stället mot den nyskapade testtabellen.
resource tableContributor 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (assignTableRole) {
  name: guid(bookingTableResourceId, 'logicapp-table-contributor')
  scope: bookingsTable
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', tableDataContributorRoleId)
    principalId: workflow.identity.principalId
    principalType: 'ServicePrincipal'
  }
}

// Key Vault Secrets User skapas INTE här. Den scopas till det enskilda
// sekretet resend-api-key i den separata fas B-modulen
// (keyvault-secret-role.bicep), efter att sekretet skapats manuellt.

output workflowId string = workflow.id
output principalId string = workflow.identity.principalId
output state string = workflow.properties.state
output tableName string = tableName
output tableRoleAssigned bool = assignTableRole
output keyVaultSecretUri string = '${keyVault.properties.vaultUri}secrets/${keyVaultSecretName}'
