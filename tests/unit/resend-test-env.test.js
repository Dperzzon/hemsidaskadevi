'use strict';

// Steg 7J: verifierar att testmiljön är isolerad från produktion.
// Testet läser de kompilerade ARM-mallarna och parameterfilerna.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..', '..');
const testTemplate = JSON.parse(fs.readFileSync(path.join(root, 'infra', 'test', 'logic-app-notify-test.json'), 'utf8'));
const prodModule = JSON.parse(fs.readFileSync(path.join(root, 'infra', 'modules', 'logic-app-notify.json'), 'utf8'));
const testParams = fs.readFileSync(path.join(root, 'infra', 'test', 'logic-app-notify-test.bicepparam'), 'utf8');
const realTestParams = fs.readFileSync(path.join(root, 'infra', 'test', 'logic-app-notify-test-real.bicepparam'), 'utf8');
const testPhaseBParams = fs.readFileSync(path.join(root, 'infra', 'test', 'keyvault-secret-role-test.bicepparam'), 'utf8');

const nested = testTemplate.resources.find((resource) => resource.type === 'Microsoft.Resources/deployments');
const testTable = testTemplate.resources.find((resource) => resource.type === 'Microsoft.Storage/storageAccounts/tableServices/tables');
const testRoles = testTemplate.resources.filter((resource) => resource.type === 'Microsoft.Authorization/roleAssignments');
const nestedWorkflow = nested.properties.template.resources.find((resource) => resource.type === 'Microsoft.Logic/workflows');
const nestedTableRole = nested.properties.template.resources.find((resource) => resource.type === 'Microsoft.Authorization/roleAssignments');

test('testmallen skapar endast testtabell, testworkflow och roller på testtabellen', () => {
  assert.equal(testTemplate.resources.length, 4);
  assert.deepEqual(testTemplate.resources.map((resource) => resource.type).sort(), [
    'Microsoft.Authorization/roleAssignments',
    'Microsoft.Authorization/roleAssignments',
    'Microsoft.Resources/deployments',
    'Microsoft.Storage/storageAccounts/tableServices/tables'
  ]);
  for (const forbidden of ['Microsoft.Web/sites', 'Microsoft.KeyVault/vaults', 'Microsoft.Network/dnsZones']) {
    assert.ok(!testTemplate.resources.some((resource) => resource.type === forbidden), `${forbidden} får inte skapas`);
  }
  assert.ok(String(testTable.name).includes("parameters('testTableName')"));
  for (const role of testRoles) {
    const scope = String(role.scope);
    assert.ok(scope.includes("parameters('testTableName')"), 'rollen måste scope:as till testtabellen');
    assert.ok(!scope.includes("'bookingrequests'"), 'rollen får inte scope:as till produktionstabellen');
  }
});

test('testtabellen och testsekretet är låsta till testvärden', () => {
  assert.deepEqual(testTemplate.parameters.testTableName.allowedValues, ['bookingrequeststest']);
  assert.deepEqual(testTemplate.parameters.testSecretName.allowedValues, ['resend-api-key-test']);
  assert.equal(testTemplate.parameters.testTableName.defaultValue, 'bookingrequeststest');
  assert.equal(testTemplate.parameters.testSecretName.defaultValue, 'resend-api-key-test');
  assert.ok(testParams.includes("param testTableName = 'bookingrequeststest'"));
  assert.ok(testParams.includes("param testSecretName = 'resend-api-key-test'"));
});

test('mocktestet använder icke-routbar mock-URL som standard – aldrig produktions-URL', () => {
  assert.equal(testTemplate.parameters.resendApiUrl.defaultValue, 'https://mock-resend.invalid/emails');
  assert.ok(testParams.includes("param resendApiUrl = 'https://mock-resend.invalid/emails'"));
  assert.ok(!testParams.includes("param resendApiUrl = 'https://api.resend.com/emails'"));
  assert.equal(prodModule.parameters.resendApiUrl.defaultValue, 'https://api.resend.com/emails');
});

test('den separata real-testfilen är explicit och använder testadresser', () => {
  assert.ok(realTestParams.includes("param resendApiUrl = 'https://api.resend.com/emails'"));
  assert.ok(realTestParams.includes("param testSecretName = 'resend-api-key-test'"));
  assert.ok(realTestParams.includes("param mailFrom = 'bokning@skadeviherrgard.com'"));
  assert.ok(realTestParams.includes("param hostRecipient = 'delivered+host@resend.dev'"));
  assert.ok(!realTestParams.includes("param testSecretName = 'resend-api-key'"));
});

test('testworkflowet pekar på testtabellen, testsekretet och mockbar Resend-URL', () => {
  assert.equal(nested.properties.parameters.assignTableRole.value, false);
  assert.ok(String(nested.properties.parameters.tableName.value).includes("parameters('testTableName')"));
  assert.ok(String(nested.properties.parameters.keyVaultSecretName.value).includes("parameters('testSecretName')"));
  assert.ok(String(nested.properties.parameters.workflowName.value).includes('testWorkflowName'));
  assert.ok(String(nested.properties.parameters.resendApiUrl.value).includes("parameters('resendApiUrl')"));
  assert.ok(String(nested.properties.parameters.mailFrom.value).includes("parameters('mailFrom')"));
  assert.ok(String(nested.properties.parameters.hostRecipient.value).includes("parameters('hostRecipient')"));
  assert.equal(nestedWorkflow.properties.state, 'Disabled');
  assert.ok(String(nestedWorkflow.properties.parameters.tableName.value).includes("parameters('tableName')"));
  assert.equal(nestedTableRole.condition, "[parameters('assignTableRole')]");
});

test('testoperatörens roll är villkorad och endast på testtabellen', () => {
  const operatorRole = testRoles.find((role) => String(role.condition).includes("parameters('testOperatorPrincipalId')"));
  assert.ok(operatorRole);
  assert.equal(operatorRole.condition, "[not(empty(parameters('testOperatorPrincipalId')))]");
  assert.ok(String(operatorRole.scope).includes("parameters('testTableName')"));
});

test('produktionsmodulens defaults är oförändrade', () => {
  assert.equal(prodModule.parameters.tableName.defaultValue, 'bookingrequests');
  assert.equal(prodModule.parameters.resendApiUrl.defaultValue, 'https://api.resend.com/emails');
  assert.equal(prodModule.parameters.assignTableRole.defaultValue, true);
  const prodTableRole = prodModule.resources.find((resource) => resource.type === 'Microsoft.Authorization/roleAssignments');
  assert.equal(prodTableRole.condition, "[parameters('assignTableRole')]");
  assert.ok(String(prodTableRole.scope).includes('tableServices/tables'));
});

test('testfas B använder endast testsekretet – aldrig produktionsnyckeln', () => {
  assert.ok(testPhaseBParams.includes("using '../modules/keyvault-secret-role.bicep'"));
  assert.ok(testPhaseBParams.includes("param workflowName = 'logic-skadevi-bokningsnotis-test'"));
  assert.ok(testPhaseBParams.includes("param keyVaultSecretName = 'resend-api-key-test'"));
  assert.ok(!testPhaseBParams.includes("param keyVaultSecretName = 'resend-api-key'"));
  assert.ok(!/^\s*param\s+keyVaultSecretName\s*=\s*'airbnb-ical-url'/m.test(testPhaseBParams));
  assert.ok(!JSON.stringify(testTemplate).includes('airbnb-ical-url'));
});
