targetScope = 'resourceGroup'

// Logic App för e-postnotiser vid bokningsförfrågningar.
//
// VIKTIGT — detta är ett förberett förslag, INTE deployerat:
// - Deployeras i rg-splatcrm-prod (Splat Reality-prenumerationen) där den
//   befintliga Gmail-anslutningen `gmail` redan finns och i produktion
//   används för Send email (V2) i logic-splatcrm-user-invitation-email.
// - Flödet använder ENDAST en Recurrence-trigger (pollning av utkorgen i
//   Azure Table Storage) — ingen inkommande HTTP-trigger/webhook, så det
//   finns ingen publikt oskyddad ingång som kan användas för att skicka mejl.
// - Åtkomst till lagringen sker med Logic Appens system-assigned managed
//   identity via Entra-token (audience https://storage.azure.com/) och rollen
//   Storage Table Data Contributor på tabellen (tilldelas via
//   infra/modules/storage-tables.bicep — kräver att principalId:här skickas dit).
// - Körhistorik: känsliga fält döljs med secureData (inputs/outputs).
//   Ytterligare rekommendation: begränsa läsbehörighet till RG:n (RBAC).

@description('Plats — Logic Apps och Gmail-anslutningen ligger i Sweden Central.')
param location string = 'swedencentral'

@description('Namn på Logic App-flödet.')
param workflowName string = 'logic-skadevi-bokningsnotis'

@description('Resurs-ID för den befintliga Gmail-anslutningen (Microsoft.Web/connections/gmail i rg-splatcrm-prod).')
param gmailConnectionId string

@description('API-ID för Gmail managed connector.')
param gmailApiId string = '/subscriptions/e3bc1637-482a-4065-811f-ea06fb691f3f/providers/Microsoft.Web/locations/swedencentral/managedApis/gmail'

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

var workflowDefinition = loadTextContent('../logicapp/email-notifier.workflow.json')

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
            connectionId: gmailConnectionId
            connectionName: 'gmail'
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
output state string = workflow.properties.state
