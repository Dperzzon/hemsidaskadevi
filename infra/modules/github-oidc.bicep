targetScope = 'resourceGroup'

@description('Namn på den user-assigned managed identity som GitHub Actions loggar in med via OIDC.')
@minLength(3)
@maxLength(24)
param identityName string

@description('GitHub-repo som identiteten ska gälla, t.ex. Dperzzon/hemsidaskadevi.')
param githubRepository string

@description('GitHub-branch som identiteten ska gälla, t.ex. main.')
param githubBranch string

@description('Fullständigt resurs-ID för webbappen som deploymenten ska gälla (från webapp-modulen).')
param webAppId string

@description('Miljötagg.')
param environment string

@description('Ägartagg.')
param owner string

var tags = {
  Owner: owner
  Environment: environment
  ManagedBy: 'GitHub Actions'
}

// User-assigned managed identity som GitHub Actions autentiserar mot
// via OpenID Connect (OIDC). Inga klienthemligheter lagras i GitHub.
resource identity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: identityName
  location: resourceGroup().location
  tags: tags
}

// Federated identity credential som binder token-utbytet till just detta
// repo och denna branch. Audiences och issuer är GitHub Actions standard.
resource federatedCredential 'Microsoft.ManagedIdentity/userAssignedIdentities/federatedIdentityCredentials@2023-01-31' = {
  parent: identity
  name: 'github-actions-deploy-main'
  properties: {
    issuer: 'https://token.actions.githubusercontent.com'
    subject: 'repo:${githubRepository}:ref:refs/heads/${githubBranch}'
    audiences: [
      'api://AzureADTokenExchange'
    ]
  }
}

// Referens till den befintliga webbappen (skapad av webapp-modulen).
resource webApp 'Microsoft.Web/sites@2024-11-01' existing = {
  name: split(webAppId, '/')[8]
}

// Minsta nödvändiga behörighet: inbyggda rollen "Website Contributor"
// tilldelad ENBART på webbappens scope (inte resursgruppen), så att
// identiteten bara kan driftsätta appens innehåll och konfiguration.
resource websiteContributor 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(webAppId, 'github-actions-website-contributor')
  scope: webApp
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'de139f84-2a0f-47da-9568-0b16bc8e7c43')
    principalId: identity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

output clientId string = identity.properties.clientId
output principalId string = identity.properties.principalId
