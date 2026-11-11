'use strict';

// Enhetstester för Azure DNS-förberedelsen (steg 6A/6B).
//
// Säkerställer:
//  - endast AKTUELL inboundIpAddress används som apex A-post (en IP)
//  - www CNAME pekar på rätt azurewebsites.net-adress
//  - TXT-verifiering (asuid/asuid.www) använder appens verificationId
//  - Resend-posterna är villkorade och avstängda som standard
//  - DNS-zonen skapas ALDRIG av den vanliga app-deploymenten
//  - den separata DNS-workflowen rör bara DNS-mallen
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { checkDnsTemplate, loadTemplate, labelOf, parseBicepParamFile } = require('../../scripts/dns-template-check');

const root = path.join(__dirname, '..', '..');
const { template, paramText } = loadTemplate(root);
const resources = template.resources;
const params = parseBicepParamFile(paramText);

test('DNS-mallen består endast av publika DNS-resurser och klarar säkerhetskontrollen', () => {
  const result = checkDnsTemplate(template, paramText);
  assert.deepEqual(result.problems, [], 'DNS-mallens säkerhetskontroll ska vara grön');
  assert.ok(resources.length >= 5);
  for (const resource of resources) {
    assert.ok(resource.type.startsWith('Microsoft.Network/dnsZones'), `ovälkommen resurstyp: ${resource.type}`);
  }
  const serialized = JSON.stringify(template);
  for (const forbidden of [
    'Microsoft.Web/', 'Microsoft.KeyVault/', 'Microsoft.Storage/',
    'Microsoft.Logic/', 'Microsoft.ManagedIdentity/', 'Microsoft.Authorization/'
  ]) {
    assert.ok(!serialized.includes(forbidden), `DNS-mallen får inte referera ${forbidden}`);
  }
});

test('apex A-post använder endast aktuell inboundIpAddress (51.12.73.240)', () => {
  const result = checkDnsTemplate(template, paramText);
  assert.deepEqual(result.apexIps, ['51.12.73.240'], 'endast aktuell inbound-IP får användas');
  assert.ok(!result.apexIps.includes('51.12.31.27'), 'possibleInboundIpAddresses får inte användas');
  assert.deepEqual(params.apexIpAddresses, ['51.12.73.240']);
});

test('www CNAME pekar på webbappens azurewebsites.net-adress med migrering-TTL', () => {
  const result = checkDnsTemplate(template, paramText);
  assert.equal(result.cname, 'hemsida-skadevi-prod.azurewebsites.net');
  assert.equal(params.webAppHostName, 'hemsida-skadevi-prod.azurewebsites.net');
  const www = resources.find((r) => r.type === 'Microsoft.Network/dnsZones/CNAME' && labelOf(r) === 'www');
  assert.ok(www);
  assert.equal(params.ttl, 300);
});

test('TXT-verifiering använder appens customDomainVerificationId för apex och www', () => {
  const result = checkDnsTemplate(template, paramText);
  assert.deepEqual(result.txtLabels.filter((n) => n === 'asuid' || n === 'asuid.www').sort(), ['asuid', 'asuid.www']);
  assert.equal(params.customDomainVerificationId, '6F5AF8BB0F29ABC9E13FBBBEB0DBFB5EDF9A30315C6FB2BAE9EB8F7C0977C78C');
});

test('Resend-poster finns förberedda men är villkorade och avstängda som standard', () => {
  assert.equal(params.enableResend, false);
  assert.equal(params.resendDkimValue, '', 'inget påhittat DKIM-värde får finnas');

  const dkim = resources.find((r) => labelOf(r) === 'resend._domainkey');
  const spf = resources.find((r) => labelOf(r) === 'send' && r.type.endsWith('/TXT'));
  const mx = resources.find((r) => labelOf(r) === 'send' && r.type.endsWith('/MX'));
  assert.ok(dkim && spf && mx, 'Resend-posterna ska vara förberedda i mallen');
  for (const record of [dkim, spf, mx]) {
    assert.ok(record.condition, `${record.name} måste vara villkorad`);
    assert.match(record.condition, /enableResend/);
  }
});

test('DNS-zonen skapas aldrig av den vanliga app-deploymenten', () => {
  const mainBicep = fs.readFileSync(path.join(root, 'infra', 'main.bicep'), 'utf8');
  const mainParams = fs.readFileSync(path.join(root, 'infra', 'main.bicepparam'), 'utf8');
  const deploy = fs.readFileSync(path.join(root, '.github', 'workflows', 'deploy.yml'), 'utf8');
  for (const [name, text] of [['main.bicep', mainBicep], ['main.bicepparam', mainParams], ['deploy.yml', deploy]]) {
    assert.ok(!text.includes('dns-skadeviherrgard'), `${name} får inte referera DNS-mallen`);
  }
  assert.ok(!mainBicep.includes('Microsoft.Network/dnsZones'), 'main.bicep får inte skapa DNS-zoner');
});

test('den separata DNS-workflowen kräver manuellt godkännande och rör bara DNS', () => {
  const workflow = fs.readFileSync(path.join(root, '.github', 'workflows', 'deploy-dns.yml'), 'utf8');
  assert.match(workflow, /workflow_dispatch/);
  assert.match(workflow, /environment: azure-dns-prod/);
  assert.match(workflow, /infra\/dns-skadeviherrgard\.bicep/);
  assert.ok(!workflow.includes('infra/main.bicep'), 'DNS-workflowen får aldrig deploya main.bicep');
  assert.ok(!/on:\s*\r?\n\s*push:/.test(workflow), 'DNS-workflowen får inte triggas på push');
});
