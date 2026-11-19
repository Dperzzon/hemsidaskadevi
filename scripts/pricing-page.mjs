// Byggtidsersättning av prisuppgifter på /priser.
//
// Alla ordinarie priser, rabatter och tillval på prissidan hämtas från samma
// centrala konfiguration som bokningsmotorn använder
// (shared/pricing-config.json). Vite ersätter {{pris.*}}-tokens när sidan
// byggs, så det räcker att ändra priset på ett ställe. Bröllopskonceptets
// priser är avsiktligt separata och påverkas inte.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function loadPricingConfig() {
  return JSON.parse(readFileSync(path.join(root, 'shared', 'pricing-config.json'), 'utf8'));
}

function sek(amount) {
  return `${new Intl.NumberFormat('sv-SE').format(amount)} kr`;
}

function discount(config, id) {
  return config.discounts.find((entry) => entry.id === id) ?? { percent: '', minNights: '' };
}

export function pricingTokens(config = loadPricingConfig()) {
  const vecka = discount(config, 'veckorabatt');
  const manad = discount(config, 'manadsrabatt');
  return {
    'pris.vardag': sek(config.nightRates.weekday),
    'pris.fredag': sek(config.nightRates.friday),
    'pris.lordag': sek(config.nightRates.saturday),
    'pris.peak': sek(config.nightRates.peak),
    'rabatt.vecka.procent': String(vecka.percent),
    'rabatt.vecka.natter': String(vecka.minNights),
    'rabatt.manad.procent': String(manad.percent),
    'rabatt.manad.natter': String(manad.minNights),
    'tillval.slutstad': sek(config.addons.slutstad),
    'tillval.lakan': sek(config.addons.lakan),
    'tillval.lakanMax': String(config.addons.linenMax),
    'tillval.ved': sek(config.addons.ved),
    'tillval.extrahus': sek(config.addons.extrahus),
    'tillval.extrahusMax': String(config.addons.extrahusMaxGuests),
    'tillval.tidig': sek(config.addons.tidigIncheckning),
    'tillval.sen': sek(config.addons.senUtcheckning)
  };
}

export function applyPricingTokens(html, config = loadPricingConfig()) {
  const tokens = pricingTokens(config);
  return html.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (match, key) =>
    Object.hasOwn(tokens, key) ? tokens[key] : match
  );
}
