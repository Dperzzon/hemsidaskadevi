targetScope = 'resourceGroup'

// Logic App + Gmail-anslutning för bokningsnotiser (Skadevi-tenant).
//
// HISTORIK: modulen driftsatte först Logic App i Splat Reality-prenumerationen
// (rg-splatcrm-prod) som refererade Splat:s befintliga Gmail-anslutning.
// Kors-tenant-RBAC visade sig omöjlig (Splat-tenant b845a04b-… ≠ Skadevi-tenant
// 7169feeb-…; Azure RBAC kan inte tilldela roller till principals från en annan
// tenant, och Entra-only-lagring avvisar token från annan tenant). Modulen är
// därför anpassad att driftsättas i SKADEVIS prenumeration/tenant
// (rg-skadevi-prod) och skapar en EGEN Gmail API-connection här.
//
// - Flödet använder ENDAST en Recurrence-trigger (pollning av utkorgen i
//   Azure Table Storage) — ingen inkommande HTTP-trigger/webbhook.
// - Åtkomst till lagringen sker med Logic Appens system-assigned managed
//   identity via Entra-token (audience https://storage.azure.com/) och rollen
//   Storage Table Data Contributor på tabellen (tilldelas via
//   infra/modules/storage-tables.bicep med den principalId som modulen
//   ger som output — samma tenant som lagringen).
// - Gmail-anslutningen skapas här men OAuth-autentiseringen (inloggning som
//   skadevigard@gmail.com) görs i portalen efter deployment — anslutningen är
//   oautentiserad tills dess och Logic App ska förbli Disabled tills
//   anslutningen är auktoriserad (se docs/bokningsflode.md).
// - Körhistorik: känsliga fält döljs med secureData (inputs/outputs).

@description('Plats — Sweden Central enligt beslut.')
param location string = 'swedencentral'

@description('Namn på Logic App-flödet.')
param workflowName string = 'logic-skadevi-bokningsnotis'

@description('Namn på den nya Gmail API-anslutningen i Skadevis prenumeration.')
param gmailConnectionName string = 'gmail-skadevi-bokning'

@description('Visningsnamn för Gmail-anslutningen.')
param gmailDisplayName string = 'Skadevi bokningsnotiser (skadevigard@gmail.com)'

@description('Resurs-ID för Gmail managed connector i Skadevis prenumeration (subscription-scoped provider).')
param gmailApiId string

@description('Slutpunkt för Skadevis bokningstabell, t.ex. https://konto.table.core.windows.net.')
param storageEndpoint string

@description('Namn på bokningstabellen.')
param tableName string = 'bookingrequests'

@description('Miljötagg.')
param environment string = 'prod'

@description('Ägartagg.')
param owner string = 'Skadevi Herrgård'

var tags = {
  Owner: owner
  Environment: environment
  ManagedBy: 'Bicep (Skadevi)'
}

// Logic Apps kräver att definitionen är ett JSON-objekt i resource-payloaden —
// loadTextContent() ger en sträng, json() tolkar den till objekt.
var workflowDefinition = json(loadTextContent('../logicapp/email-notifier.workflow.json'))

// Ny Gmail API-connection i Skadevis tenant. OAuth-autentisering (inloggning
// som skadevigard@gmail.com) sker i portalen efter deployment; inga
// autentiseringsuppgifter läggs i kod eller Bicep.
resource gmailConnection 'Microsoft.Web/connections@2016-06-01' = {
  name: gmailConnectionName
  location: location
  tags: tags
  properties: {
    displayName: gmailDisplayName
    api: {
      id: gmailApiId
    }
    parameterValues: {}
  }
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
    definition: workflowDefinition
    parameters: {
      '$connections': {
        value: {
          gmail: {
            connectionId: gmailConnection.id
            connectionName: gmailConnectionName
            id: gmailApiId
          }
        }
      }
      'storageEndpoint': {
        value: storageEndpoint
      }
      'tableName': {
        value: tableName
      }
    }
  }
}

output workflowId string = workflow.id
output principalId string = workflow.identity.principalId
output connectionResourceId string = gmailConnection.id
output state string = workflow.properties.state
