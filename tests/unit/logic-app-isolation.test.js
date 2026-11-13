'use strict';

// Steg 7C/7D: säkerhetskontroller för den isolerade, tvåfasiga
// Logic App-deploymenten. Testet läser de kompilerade ARM-mallarna och
// flödesdefinitionen och säkerställer att:
//   - fas A endast skapar Logic Appen + tabellrollen
//   - fas B endast skapar Key Vault Secrets User på det enskilda sekretet
//   - ingen rolltilldelning scopas till hela Key Vault
//   - flödet är avstängt, saknar hemligheter och inte kan skapa bokningar.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..', '..');
const phaseATemplate = JSON.parse(fs.readFileSync(path.join(root, 'infra', 'modules', 'logic-app-notify.json'), 'utf8'));
const phaseBTemplate = JSON.parse(fs.readFileSync(path.join(root, 'infra', 'modules', 'keyvault-secret-role.json'), 'utf8'));
const workflow = JSON.parse(fs.readFileSync(path.join(root, 'infra', 'logicapp', 'email-notifier.workflow.json'), 'utf8'));
const phaseAParamsText = fs.readFileSync(path.join(root, 'infra', 'logic-app-notify.bicepparam'), 'utf8');
const phaseBParamsText = fs.readFileSync(path.join(root, 'infra', 'keyvault-secret-role.bicepparam'), 'utf8');

const workflowResource = phaseATemplate.resources.find((resource) => resource.type === 'Microsoft.Logic/workflows');
const phaseATableRole = phaseATemplate.resources.find((resource) => resource.type === 'Microsoft.Authorization/roleAssignments');
const phaseBRole = phaseBTemplate.resources.find((resource) => resource.type === 'Microsoft.Authorization/roleAssignments');

function collectActions(actions, collected = []) {
  for (const [name, action] of Object.entries(actions ?? {})) {
    collected.push({ name, ...action });
    collectActions(action.actions, collected);
    collectActions(action.else?.actions, collected);
  }
  return collected;
}

const allActions = collectActions(workflow.actions);
const httpActions = allActions.filter((action) => action.type === 'Http');

test('fas A deklarerar endast Logic App + tabellroll', () => {
  assert.equal(phaseATemplate.resources.length, 2);
  assert.deepEqual(phaseATemplate.resources.map((resource) => resource.type).sort(), [
    'Microsoft.Authorization/roleAssignments',
    'Microsoft.Logic/workflows'
  ]);
  for (const forbidden of [
    'Microsoft.Web/sites',
    'Microsoft.Storage/storageAccounts',
    'Microsoft.KeyVault/vaults',
    'Microsoft.Network/dnsZones'
  ]) {
    assert.ok(!phaseATemplate.resources.some((resource) => resource.type === forbidden), `${forbidden} får inte skapas`);
  }
  assert.ok(String(phaseATableRole.scope).includes('tableServices/tables'));
});

test('fas B deklarerar endast Key Vault-rollen på det enskilda sekretet', () => {
  assert.equal(phaseBTemplate.resources.length, 1);
  assert.equal(phaseBRole.type, 'Microsoft.Authorization/roleAssignments');
  assert.ok(String(phaseBRole.scope).startsWith("[resourceId('Microsoft.KeyVault/vaults/secrets'"));
  assert.ok(String(phaseBRole.scope).includes("parameters('keyVaultSecretName')"));
  assert.equal(phaseBTemplate.parameters.keyVaultSecretName.defaultValue, 'resend-api-key');
  assert.equal(phaseBTemplate.parameters.keyVaultSecretsUserRoleId.defaultValue, '4633458b-17de-408a-b874-0445c86b69e6');
  assert.ok(String(phaseBRole.properties.principalId).includes('identity.principalId'));
});

test('ingen rolltilldelning scopas till hela Key Vault eller andra resurser', () => {
  const allRoleAssignments = [
    ...phaseATemplate.resources.filter((resource) => resource.type === 'Microsoft.Authorization/roleAssignments'),
    ...phaseBTemplate.resources.filter((resource) => resource.type === 'Microsoft.Authorization/roleAssignments')
  ];
  assert.equal(allRoleAssignments.length, 2, 'endast tabellrollen och sekretessrollen ska finnas');
  for (const role of allRoleAssignments) {
    assert.ok(
      !String(role.scope).includes("[resourceId('Microsoft.KeyVault/vaults', parameters('keyVaultName'))]"),
      'rolltilldelning på hela valvet är förbjuden'
    );
  }
});

test('fas A och fas B ger tillsammans exakt tre resurser', () => {
  assert.equal(phaseATemplate.resources.length + phaseBTemplate.resources.length, 3);
});

test('Logic App skapas i Disabled-läge med systemidentitet', () => {
  assert.equal(workflowResource.properties.state, 'Disabled');
  assert.equal(workflowResource.identity.type, 'SystemAssigned');
  assert.equal(workflowResource.name, "[parameters('workflowName')]");
});

test('tabellrollen använder tenantverifierad roll och tabellscope', () => {
  assert.ok(phaseATableRole.properties.roleDefinitionId.includes("parameters('tableDataContributorRoleId')"));
  assert.equal(phaseATemplate.parameters.tableDataContributorRoleId.defaultValue, '0a9a7e1f-b9d0-4cc4-a60d-0319b160aaa3');
  assert.ok(String(phaseATableRole.properties.principalId).includes('identity.principalId'));
});

test('endast Recurrence-trigger och HTTP/If/Foreach – inga connectors eller webhooks', () => {
  assert.deepEqual(Object.keys(workflow.triggers), ['Recurrence']);
  assert.equal(workflow.triggers.Recurrence.type, 'Recurrence');
  assert.ok(allActions.every((action) => ['Http', 'If', 'Foreach'].includes(action.type)));
  const raw = JSON.stringify(workflow);
  assert.ok(!raw.includes('ApiConnection'));
  assert.ok(!raw.includes('OpenApiConnection'));
  assert.ok(!raw.includes('"Request"'));
});

test('API-nyckeln är inte hårdkodad och hämtas från Key Vault', () => {
  const raw = JSON.stringify(workflow);
  assert.ok(!/re_[A-Za-z0-9]{8,}/.test(raw), 'Resend-nyckel får inte finnas i flödet');
  const send = allActions.find((action) => action.name === 'Skicka_mejl_resend');
  assert.ok(send.inputs.headers.Authorization.includes("body('Hamta_api_nyckel')"));
});

test('all känslig HTTP-data skyddas i körhistoriken', () => {
  assert.ok(httpActions.length > 0);
  for (const action of httpActions) {
    assert.deepEqual(
      action.runtimeConfiguration?.secureData?.properties,
      ['inputs', 'outputs'],
      `${action.name} saknar secureData`
    );
  }
});

test('flödet kan inte skapa bokningar eller röra andra Azure-tjänster', () => {
  const uris = httpActions.map((action) => action.inputs.uri);
  assert.ok(!uris.some((uri) => uri.includes('/api/booking-requests')), 'får inte anropa boknings-API:t');
  for (const uri of uris) {
    assert.ok(
      uri.includes("parameters('storageEndpoint')")
        || uri.includes("parameters('resendApiUrl')")
        || uri.includes("parameters('keyVaultSecretUri')"),
      `oväntad mål-URI: ${uri}`
    );
  }
  assert.ok(!JSON.stringify(phaseATemplate).includes('BOOKING_REQUESTS_ENABLED'));
});

test('parameterfilerna är låsta till Skadevis prod-resurser och innehåller inga hemligheter', () => {
  assert.ok(phaseAParamsText.includes("using './modules/logic-app-notify.bicep'"));
  assert.ok(phaseAParamsText.includes("param keyVaultName = 'kv-skadevi-prod'"));
  assert.ok(phaseAParamsText.includes("param keyVaultSecretName = 'resend-api-key'"));
  assert.ok(phaseAParamsText.includes("param storageAccountName = 'stskadevibokningprod'"));
  assert.ok(phaseBParamsText.includes("using './modules/keyvault-secret-role.bicep'"));
  assert.ok(phaseBParamsText.includes("param keyVaultName = 'kv-skadevi-prod'"));
  assert.ok(phaseBParamsText.includes("param keyVaultSecretName = 'resend-api-key'"));
  for (const text of [phaseAParamsText, phaseBParamsText]) {
    assert.ok(!/secret\s*=\s*['"][^'"]+['"]/i.test(text), 'parameterfilen får inte innehålla hemliga värden');
  }
});
