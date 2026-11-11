'use strict';

// Serverns auktoritativa prisberäkning för bokningsförfrågningar.
//
// Affärsregler och priser läses från shared/pricing-config.json — samma
// konfigurationskälla som klientens prisberäkning (src/js/booking/pricing.js).
// Servern räknar alltid om priset när en förfrågan tas emot och litar aldrig
// på belopp från klienten.
//
// Prioritetsordning per natt: godkänt högtidspris (12 000 kr) > helgpris
// (fredag/lördag 10 000 kr) > vardags-/söndagspris (7 000 kr). Högtidspriset
// ERSÄTTER det ordinarie nattpriset och gäller endast för perioder som är
// godkända ("approved": true) i konfigurationen — förslag påverkar inte
// priset. Avresedagen är inte en debiterad natt.

const CONFIG = require('../../shared/pricing-config.json');

const PRICE_VERSION = CONFIG.version;

// Kalenderdag-precisa hjälpare (YYYY-MM-DD). Dagnumret beräknas med civilt
// räknesätt — ingen delning av millisekunder, så sommartidsomställningar,
// skottår, månads- och årsskiften hanteras korrekt.
function dayNumber(key) {
  const year = Number(key.slice(0, 4));
  const month = Number(key.slice(5, 7));
  const day = Number(key.slice(8, 10));
  const shiftedMonth = month < 3 ? month + 12 : month;
  const shiftedYear = month < 3 ? year - 1 : year;
  const era = Math.floor(shiftedYear / 400);
  const yearOfEra = shiftedYear - era * 400;
  return Math.floor((153 * shiftedMonth - 457) / 5) + day - 1 + 365 * yearOfEra +
    Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100) + era * 146097 - 719468;
  // 1970-01-01 (torsdag) ger dagnumret 0 — dagnumren följer civil_from_days.
}

function keyFromDayNumber(dayNumber) {
  // civil_from_days (Howard Hinnant) — returnerar kalenderdatum som nyckel.
  const z = dayNumber + 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const year = yoe + era * 400;
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const month = mp < 10 ? mp + 3 : mp - 9;
  const day = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const actualYear = month <= 2 ? year + 1 : year;
  return `${actualYear}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function nightsBetween(arrival, departure) {
  if (!arrival || !departure) return 0;
  return dayNumber(departure) - dayNumber(arrival);
}

// Nätterna [arrival, departure) — avresedagen är ingen natt.
function nightKeys(arrival, departure) {
  const nights = [];
  for (let day = dayNumber(arrival); day < dayNumber(departure); day++) {
    nights.push(keyFromDayNumber(day));
  }
  return nights;
}

// 0 = söndag … 6 = lördag (nattens startdatum avgör priset).
function weekdayOf(dateKey) {
  return (dayNumber(dateKey) + 4) % 7; // dag 0 = 1970-01-01 (torsdag)
}

function peakFor(dateKey) {
  for (const period of CONFIG.peakPeriods) {
    if (!period.approved) continue;
    if (dateKey >= period.start && dateKey <= period.end) return period;
  }
  return null;
}

// Priset för en enskild natt enligt prioriteringsordningen ovan.
function nightRate(dateKey) {
  const peak = peakFor(dateKey);
  if (peak) return { rate: CONFIG.nightRates.peak, type: 'peak', periodId: peak.id, periodLabel: peak.label };
  const weekday = weekdayOf(dateKey);
  if (weekday === 5) return { rate: CONFIG.nightRates.friday, type: 'friday' };
  if (weekday === 6) return { rate: CONFIG.nightRates.saturday, type: 'saturday' };
  return { rate: CONFIG.nightRates.weekday, type: 'weekday' };
}

// Bästa (största) rabatt som gäller för antalet nätter, eller null. Rabatterna
// ersätter varandra och staplas aldrig.
function bestDiscount(nights) {
  let best = null;
  for (const discount of CONFIG.discounts) {
    if (nights >= discount.minNights && (!best || discount.percent > best.percent)) {
      best = discount;
    }
  }
  return best;
}

// Beräknar den rabatterade boendesumman. Som huvudregel gäller rabatten hela
// boendesumman inklusive högtidsnätter; om peakExemptFromDiscounts sätts
// till true i konfigurationen undantas godkända högtidsnätter i stället
// (undantaget förberett men inte aktiverat).
function applyDiscountToLodging(lodgingBase, peakBase, discount, exemptFlag) {
  if (!discount) return { discountedBase: lodgingBase, discountAmount: 0 };
  const exempt = Boolean(exemptFlag) && peakBase > 0;
  const eligible = lodgingBase - (exempt ? peakBase : 0);
  const discountedBase = Math.round(eligible * (1 - discount.percent / 100)) + (exempt ? peakBase : 0);
  return { discountedBase, discountAmount: lodgingBase - discountedBase };
}

// Tillvalskostnader. Lakan/handdukar prisas per person som faktiskt behöver
// tjänsten (0 till antal gäster), övriga tillval per vistelse.
function addonTotals(addons, guests, linenCount) {
  const prices = CONFIG.addons;
  linenCount = Math.min(Math.max(0, Number(linenCount) || 0), Math.max(0, Number(guests) || 0));
  const lines = [];
  if (addons.slutstad) lines.push({ id: 'slutstad', label: 'Slutstädning (exklusive kök)', quantity: 1, unitPrice: prices.slutstad, amount: prices.slutstad });
  if (addons.lakan) lines.push({ id: 'lakan', label: 'Lakan och handdukar', quantity: linenCount, unitPrice: prices.lakan, amount: prices.lakan * linenCount });
  if (addons.ved) lines.push({ id: 'ved', label: 'Ved', quantity: 1, unitPrice: prices.ved, amount: prices.ved });
  if (addons.tidigIncheckning) lines.push({ id: 'tidigIncheckning', label: 'Tidig incheckning', quantity: 1, unitPrice: prices.tidigIncheckning, amount: prices.tidigIncheckning });
  if (addons.senUtcheckning) lines.push({ id: 'senUtcheckning', label: 'Sen utcheckning', quantity: 1, unitPrice: prices.senUtcheckning, amount: prices.senUtcheckning });
  const total = lines.reduce((sum, line) => sum + line.amount, 0);
  return { lines, total };
}

// Full offert: { nights, nightlyBreakdown, lodgingBase, peakNights, peakBase,
// discount, discountAmount, lodgingAfterDiscount, addonLines, addonsTotal, total }.
function quote({ arrival, departure, addons = {}, guests = 0 }) {
  const nights = nightsBetween(arrival, departure);
  if (!Number.isFinite(nights) || nights < 1) {
    return { nights: Math.max(0, nights || 0), incomplete: true };
  }
  const breakdown = nightKeys(arrival, departure).map((date) => {
    const { rate, type, periodId, periodLabel } = nightRate(date);
    return { date, type, rate, periodId: periodId ?? null, periodLabel: periodLabel ?? null };
  });
  const lodgingBase = breakdown.reduce((sum, night) => sum + night.rate, 0);
  const peakNights = breakdown.filter((night) => night.type === 'peak');
  const peakBase = peakNights.reduce((sum, night) => sum + night.rate, 0);
  const discount = bestDiscount(nights);
  const { discountedBase, discountAmount } = applyDiscountToLodging(
    lodgingBase, peakBase, discount, CONFIG.peakExemptFromDiscounts
  );
  const discountInfo = discount && discountAmount > 0
    ? { id: discount.id, label: discount.label, percent: discount.percent, amount: discountAmount }
    : null;
  const linenCount = Math.min(Math.max(0, Number(addons.linenCount) || 0), Math.max(0, Number(guests) || 0));
  const addonResult = addonTotals(addons, guests, linenCount);
  return {
    nights,
    nightlyBreakdown: breakdown,
    lodgingBase,
    peakNights: peakNights.length,
    peakBase,
    discount: discountInfo,
    discountAmount,
    lodgingAfterDiscount: discountedBase,
    addonLines: addonResult.lines,
    addonsTotal: addonResult.total,
    total: discountedBase + addonResult.total,
    priceVersion: PRICE_VERSION
  };
}

module.exports = {
  PRICE_VERSION, CONFIG, nightRate, bestDiscount, nightsBetween, nightKeys, quote,
  addonTotals, applyDiscountToLodging, dayNumber, keyFromDayNumber, weekdayOf
};
