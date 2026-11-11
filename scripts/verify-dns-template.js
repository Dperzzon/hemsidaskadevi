#!/usr/bin/env node
'use strict';

// CLI: verifierar att DNS-mallen endast innehåller publika DNS-resurser och att
// apex/www/verifieringsposter har förväntade värden.
const path = require('node:path');
const { checkDnsTemplate, loadTemplate } = require('./dns-template-check');

const repoRoot = path.join(__dirname, '..');
const { template, paramText } = loadTemplate(repoRoot);
const result = checkDnsTemplate(template, paramText);

if (result.problems.length > 0) {
  for (const problem of result.problems) console.error(`FEL: ${problem}`);
  console.error(`DNS-mallen är INTE säker att driftsätta (${result.problems.length} problem).`);
  process.exit(1);
}

console.log(`DNS-mallen OK: ${result.resources.length} resurser, alla Microsoft.Network/dnsZones.`);
console.log('Apex A:', result.apexIps.join(', '));
console.log('www CNAME:', result.cname);
