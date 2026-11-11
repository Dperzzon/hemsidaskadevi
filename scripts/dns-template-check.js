'use strict';

// Gemensam kontroll av DNS-mallen (infra/dns-skadeviherrgard.json) inklusive
// upplÃ¶sning av parametervÃ¤rden frÃ¥n template-defaults och .bicepparam.
//
// AnvÃ¤nds av scripts/verify-dns-template.js (CLI) och enhetstesterna.

const fs = require('node:fs');

// Kompilerade resursnamn Ã¤r ARM-uttryck, t.ex.
// "[format('{0}/{1}', parameters('zoneName'), 'www')]" â€” etiketten Ã¤r sista
// strÃ¤ngliteralen.
function labelOf(resource) {
  const match = String(resource.name).match(/'([^']+)'\)\]$/);
  return match ? match[1] : '';
}

function parseBicepParamFile(text) {
  const values = {};
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    const single = /^param\s+([A-Za-z0-9_]+)\s*=\s*(.+)$/.exec(line);
    if (!single) continue;
    const name = single[1];
    let raw = single[2];
    if (raw.startsWith('[')) {
      // Bicep-array: elementen stÃ¥r pÃ¥ egna rader mellan [ och ].
      let block = raw;
      while (!block.includes(']') && i + 1 < lines.length) {
        i += 1;
        block += `\n${lines[i]}`;
      }
      const inner = block.slice(block.indexOf('[') + 1, block.lastIndexOf(']'));
      const items = [...inner.matchAll(/'([^']*)'|(-?\d+(?:\.\d+)?)|(true|false)/g)]
        .map((m) => (m[1] !== undefined ? m[1] : m[2] !== undefined ? Number(m[2]) : m[3] === 'true'));
      values[name] = items;
      continue;
    }
    const str = /^'(.*)'$/.exec(raw);
    if (str) {
      values[name] = str[1];
    } else if (raw === 'true' || raw === 'false') {
      values[name] = raw === 'true';
    } else if (/^-?\d+$/.test(raw)) {
      values[name] = Number(raw);
    }
  }
  return values;
}

function buildParamMap(template, paramFileText) {
  const values = {};
  for (const [name, definition] of Object.entries(template.parameters ?? {})) {
    if (definition?.defaultValue !== undefined) values[name] = definition.defaultValue;
  }
  if (paramFileText) Object.assign(values, parseBicepParamFile(paramFileText));
  return values;
}

function resolveValue(value, params) {
  if (typeof value === 'string') {
    const match = /^\[parameters\('([^']+)'\)\]$/.exec(value);
    return match ? params[match[1]] : value;
  }
  if (Array.isArray(value)) return value.map((item) => resolveValue(item, params));
  return value;
}

// ARecords kan vara en lista av {ipv4Address} (konkret) eller en parameterlista med strängar.
function toIpList(records) {
  return (records ?? []).map((record) => (typeof record === 'string' ? record : record.ipv4Address));
}

// A-records kompileras till en copy-loop nar listan ar parametriserad.
function apexIps(properties, params) {
  if (properties?.copy) {
    const serialized = JSON.stringify(properties.copy[0]?.input ?? {});
    const match = /parameters\('([^']+)'\)/.exec(serialized);
    return match ? toIpList(params[match[1]]) : [];
  }
  return toIpList(resolveValue(properties?.ARecords ?? [], params));
}

function checkDnsTemplate(template, paramFileText) {
  const params = buildParamMap(template, paramFileText);
  const resources = template.resources ?? [];
  const problems = [];

  const forbiddenTypes = [
    'Microsoft.Web/',
    'Microsoft.KeyVault/',
    'Microsoft.Storage/',
    'Microsoft.Logic/',
    'Microsoft.ManagedIdentity/',
    'Microsoft.Authorization/',
    'Microsoft.Communication/'
  ];

  for (const resource of resources) {
    if (!String(resource.type ?? '').startsWith('Microsoft.Network/dnsZones')) {
      problems.push(`OvÃ¤lkommen resurstyp i DNS-mallen: ${resource.type}`);
    }
    const serialized = JSON.stringify(resource);
    for (const forbidden of forbiddenTypes) {
      if (serialized.includes(forbidden)) {
        problems.push(`DNS-mallen refererar fÃ¶rbjuden resurs ${forbidden} (${resource.type})`);
      }
    }
  }

  if (!resources.some((r) => r.type === 'Microsoft.Network/dnsZones')) {
    problems.push('Ingen dnsZones-resurs hittades.');
  }

  const apex = resources.find((r) => r.type === 'Microsoft.Network/dnsZones/A' && labelOf(r) === '@');
  if (!apex) {
    problems.push('Apex A-post saknas.');
  } else {
    const ips = apexIps(apex.properties, params);
    if (ips.length !== 1) {
      problems.push(`Apex ska ha exakt en A-post (aktuell inbound-IP), hittade ${ips.length}: ${ips.join(', ')}`);
    }
    if (ips[0] !== '51.12.73.240') {
      problems.push(`Apex A-post Ã¤r ${ips[0]}, fÃ¶rvÃ¤ntat 51.12.73.240 (aktuell inboundIpAddress).`);
    }
  }

  const www = resources.find((r) => r.type === 'Microsoft.Network/dnsZones/CNAME' && labelOf(r) === 'www');
  const cname = www ? resolveValue(www.properties?.CNAMERecord?.cname, params) : undefined;
  if (cname !== 'hemsida-skadevi-prod.azurewebsites.net') {
    problems.push(`www CNAME pekar inte pÃ¥ hemsida-skadevi-prod.azurewebsites.net (${cname}).`);
  }

  const txtLabels = resources.filter((r) => r.type === 'Microsoft.Network/dnsZones/TXT').map(labelOf);
  for (const required of ['asuid', 'asuid.www']) {
    if (!txtLabels.includes(required)) problems.push(`TXT ${required} saknas.`);
  }

  const verificationId = resolveValue(
    resources.find((r) => labelOf(r) === 'asuid')?.properties?.TXTRecords?.[0]?.value?.[0],
    params
  );
  if (verificationId !== '6F5AF8BB0F29ABC9E13FBBBEB0DBFB5EDF9A30315C6FB2BAE9EB8F7C0977C78C') {
    problems.push(`TXT-verifieringen anvÃ¤nder ovÃ¤ntat vÃ¤rde (${verificationId}).`);
  }

  return {
    problems,
    params,
    resources,
    apexIps: apex ? apexIps(apex.properties, params) : [],
    cname,
    txtLabels
  };
}

function loadTemplate(repoRoot) {
  const path = require('node:path');
  const template = JSON.parse(fs.readFileSync(path.join(repoRoot, 'infra', 'dns-skadeviherrgard.json'), 'utf8'));
  const paramText = fs.readFileSync(path.join(repoRoot, 'infra', 'dns-skadeviherrgard.bicepparam'), 'utf8');
  return { template, paramText };
}

module.exports = { labelOf, parseBicepParamFile, buildParamMap, resolveValue, checkDnsTemplate, loadTemplate };
