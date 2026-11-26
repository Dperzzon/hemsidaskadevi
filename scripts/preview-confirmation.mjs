// Förhandsvisar en bokningsbekräftelse utan att köa eller skicka något.
// Användning:
//   node scripts/preview-confirmation.mjs <booking.json> <ut-prefix> [--door-code=125456]
// Filen får innehålla en rå Table Storage-entitet eller en normaliserad post.
// Skriver endast till angivet prefix (använd en gitignorerad katalog).

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { fromEntity } = require('../server/booking/store.js');
const { resolveConfirmationAddons } = require('../server/booking/confirmation-addons.js');
const { buildBookingConfirmation } = require('../server/booking/booking-mail.js');

const input = process.argv[2];
const prefix = process.argv[3];
const doorArg = process.argv.find((arg) => arg.startsWith('--door-code='));
if (!input || !prefix) {
  console.error('Användning: node scripts/preview-confirmation.mjs <booking.json> <ut-prefix> [--door-code=...]');
  process.exit(1);
}

const raw = JSON.parse(fs.readFileSync(input, 'utf8').replace(/^\uFEFF/, ''));
const entity = Array.isArray(raw.items) ? raw.items[0] :
  Array.isArray(raw.value) ? raw.value[0] :
  raw.PartitionKey ? raw : null;
const record = entity ? fromEntity(entity) : raw;
const doorCode = doorArg ? doorArg.slice('--door-code='.length) : process.env.DOOR_CODE;
const resolution = resolveConfirmationAddons(record);
if (!resolution.ok) {
  console.error('Kan inte skapa en säker förhandsvisning:');
  for (const issue of resolution.issues) console.error(`- ${issue.code}: ${issue.message}`);
  process.exit(2);
}
const mail = buildBookingConfirmation(record, { doorCode });
fs.mkdirSync(path.dirname(prefix), { recursive: true });
fs.writeFileSync(`${prefix}.html`, mail.html, 'utf8');
fs.writeFileSync(`${prefix}.txt`, mail.body, 'utf8');
fs.writeFileSync(`${prefix}.json`, JSON.stringify({
  reference: record.reference,
  statusCode: record.statusCode,
  arrival: record.arrival,
  departure: record.departure,
  guests: record.guests,
  addons: record.addons,
  totalAddons: record.totalAddons,
  total: record.total,
  addonLines: resolution.lines,
  addonSource: resolution.source,
  addonWarnings: resolution.warnings,
  addonIssues: resolution.issues,
  doorCodeIncluded: /Dörrkod/.test(mail.html)
}, null, 2), 'utf8');
console.log(`Förhandsvisning skriven: ${prefix}.html och ${prefix}.txt`);
console.log(`Tillval: ${resolution.lines.map((line) => `${line.label} = ${line.amount}`).join(', ')}`);
console.log(`Tillvalssumma: ${resolution.totalAddons} kr, total: ${resolution.total} kr, källa: ${resolution.source}`);
