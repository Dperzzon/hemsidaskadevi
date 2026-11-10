// Gallring av bokningsförfrågningar (GDPR-minimering).
// Tar bort request- och utkorgsposter äldre än angivet antal dagar.
//
// Användning:
//   node scripts/purge-old-bookings.mjs [--days 730] [--confirm]
//
// Utan --confirm listas bara antalet poster som skulle tas bort (torrkörning).
// Lokal lagring (data/) används när AZURE_STORAGE_ACCOUNT_NAME saknas — i
// produktion krävs Managed Identity (App Service) eller AZURE_STORAGE_KEY.

import process from 'node:process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createStore, isConfigured } = require('../server/booking/store');

const args = process.argv.slice(2);
const daysIndex = args.indexOf('--days');
const days = daysIndex !== -1 ? Number(args[daysIndex + 1]) : 730;
const confirm = args.includes('--confirm');

if (!Number.isFinite(days) || days <= 0) {
  console.error('Ogiltigt antal dagar.');
  process.exit(1);
}

const threshold = new Date(Date.now() - days * 86400000).toISOString();
const store = createStore();
const warn = (message) => console.error(message);

if (confirm) {
  const purged = await store.purgeOlderThan(threshold, { warn });
  console.log(`Gallring klar: ${purged} poster äldre än ${threshold} togs bort.`);
} else {
  const pending = await store.listPending().catch(() => []);
  const thresholdRecord = { createdAt: threshold };
  console.log(`Torrkörning: poster äldre än ${threshold} skulle tas bort.`);
  console.log(`Väntande förfrågningar just nu: ${pending.length} (gallras aldrig automatiskt så länge de är väntande).`);
  if (store.type === 'local-jsonl') {
    console.log('Lokal lagring används (utveckling/test).');
  }
  if (!isConfigured()) {
    console.log('AZURE_STORAGE_ACCOUNT_NAME saknas — kör mot lokal fil eller sätt miljön på App Service.');
  }
  void thresholdRecord;
}
