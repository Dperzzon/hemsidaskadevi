// Prislogik för bokningsflödet (klientsidan).
//
// Endast verifierade tillvalspriser används (oktober 2026, uppgivna av Skadevi):
//   Slutstädning (exklusive kök) 2 500 kr, lakan/handdukar 200 kr per person,
//   ved 350 kr, tidig incheckning 500 kr, sen utcheckning 500 kr.
// Nattpriser, rabatter och högtidsperioder läses från shared/pricing-config.json
// — samma konfigurationskälla som serverns auktoritativa beräkning
// (server/booking/pricing.js). Klientens totalpris är en beräknad offert;
// servern räknar alltid om priset vid bokningsförfrågan.
//
// Prioritetsordning per natt: godkänt högtidspris (12 000 kr) > helgpris
// (fredag/lördag 10 000 kr) > vardags-/söndagspris (7 000 kr). Högtidspriset
// ERSÄTTER ordinarie nattpris och gäller endast godkända perioder — förslag
// påverkar inte priset. Avresedagen är inte en debiterad natt.

import config from '../../../shared/pricing-config.json' with { type: 'json' };
import { eachNight } from './dates.js';

export const PRICE_CONFIG = config;
export const PRICE_VERSION = config.version;

// Tillval (priser från den gemensamma konfigurationen).
export const ADDONS = [
  {
    id: 'slutstad',
    label: 'Slutstädning (exklusive kök)',
    price: config.addons.slutstad,
    unit: 'engångspris',
    note: 'Ett engångspris per vistelse. Köket ingår inte i städningen.',
    request: false
  },
  {
    id: 'lakan',
    label: 'Hyra lakan och handdukar',
    price: config.addons.lakan,
    unit: 'per person',
    note: 'Ange hur många personer som behöver lakan och handdukar.',
    request: false,
    perPerson: true
  },
  {
    id: 'ved',
    label: 'Köpa ved',
    price: config.addons.ved,
    unit: 'engångspris',
    note: 'Ett engångspris per beställning.',
    request: false
  },
  {
    id: 'tidigIncheckning',
    label: 'Tidig incheckning',
    price: config.addons.tidigIncheckning,
    unit: 'engångspris',
    note: 'Ordinarie incheckning är kl. 14.00. Med tidig incheckning kan ni checka in redan kl. 09.00. Önskemål som behöver bekräftas av Skadevi Herrgård — bekräftas inte enbart genom betalning eller inskickad bokningsförfrågan.',
    request: true
  },
  {
    id: 'senUtcheckning',
    label: 'Sen utcheckning',
    price: config.addons.senUtcheckning,
    unit: 'engångspris',
    note: 'Ordinarie utcheckning är kl. 11.00. Med sen utcheckning kan ni stanna till kl. 16.00. Önskemål som behöver bekräftas av Skadevi Herrgård — bekräftas inte enbart genom betalning eller inskickad bokningsförfrågan.',
    request: true
  }
];

export const DISCOUNTS = config.discounts;

export const NIGHT_RATES = config.nightRates;

// 0 = söndag … 6 = lördag (nattens startdatum avgör priset).
export function weekdayOf(dateKey) {
  const timestamp = Date.parse(`${dateKey}T12:00:00Z`);
  return new Date(timestamp).getUTCDay();
}

export function peakPeriodFor(dateKey) {
  for (const period of config.peakPeriods) {
    if (!period.approved) continue;
    if (dateKey >= period.start && dateKey <= period.end) return period;
  }
  return null;
}

// Priset för en enskild natt enligt prioriteringsordningen ovan.
export function nightRate(dateKey) {
  const peak = peakPeriodFor(dateKey);
  if (peak) return { rate: config.nightRates.peak, type: 'peak', periodId: peak.id, periodLabel: peak.label };
  const weekday = weekdayOf(dateKey);
  if (weekday === 5) return { rate: config.nightRates.friday, type: 'friday' };
  if (weekday === 6) return { rate: config.nightRates.saturday, type: 'saturday' };
  return { rate: config.nightRates.weekday, type: 'weekday' };
}

// Bästa (största) rabatt som gäller för antalet nätter, eller null. Rabatterna
// ersätter varandra och staplas aldrig (28 nätter ger månadsrabatten 69 %).
export function bestDiscount(nights) {
  let best = null;
  for (const discount of DISCOUNTS) {
    if (nights >= discount.minNights && (!best || discount.percent > best.percent)) {
      best = discount;
    }
  }
  return best;
}

// Rabatten gäller den sammanlagda boendesumman (inklusive högtidsnätter) före
// tillval. Om peakExemptFromDiscounts sätts till true i konfigurationen
// undantas godkända högtidsnätter i stället — undantaget förberett men inte
// aktiverat.
function applyDiscountToLodging(lodgingBase, peakBase, discount) {
  if (!discount) return { discountedBase: lodgingBase, discountAmount: 0 };
  const exempt = Boolean(config.peakExemptFromDiscounts) && peakBase > 0;
  const eligible = lodgingBase - (exempt ? peakBase : 0);
  const discountedBase = Math.round(eligible * (1 - discount.percent / 100)) + (exempt ? peakBase : 0);
  return { discountedBase, discountAmount: lodgingBase - discountedBase };
}

// Tillvalsrader. Lakan/handdukar beräknas på antalet personer som faktiskt
// behöver tjänsten (0 till antal gäster), övriga tillval per vistelse.
export function addonLines(selection) {
  const lines = [];
  for (const addon of ADDONS) {
    if (!selection[addon.id]) continue;
    const quantity = addon.perPerson
      ? Math.min(Math.max(0, Number(selection.linenCount) || 0), Math.max(0, Number(selection.guests) || 0))
      : 1;
    lines.push({
      id: addon.id,
      label: addon.perPerson
        ? `${addon.label} (${quantity} pers × ${formatSek(addon.price)})`
        : addon.label,
      amount: addon.price * quantity,
      request: addon.request,
      note: addon.note
    });
  }
  return lines;
}

export function sumAddons(lines) {
  return lines.reduce((total, line) => total + line.amount, 0);
}

// Full offert för en vistelse (identisk med serverns quote()). Returnerar
// { incomplete: true } om förutsättningarna saknas — inget missvisande
// totalpris får visas.
export function quote({ arrival, departure, addons = {}, guests = 0 }) {
  if (!arrival || !departure) return { incomplete: true };
  const nights = eachNight(arrival, departure).length;
  if (nights < 1) return { incomplete: true };
  const breakdown = eachNight(arrival, departure).map((date) => {
    const { rate, type, periodId, periodLabel } = nightRate(date);
    return { date, type, rate, periodId: periodId ?? null, periodLabel: periodLabel ?? null };
  });
  const lodgingBase = breakdown.reduce((sum, night) => sum + night.rate, 0);
  const peakNights = breakdown.filter((night) => night.type === 'peak');
  const peakBase = peakNights.reduce((sum, night) => sum + night.rate, 0);
  const discount = bestDiscount(nights);
  const { discountedBase, discountAmount } = applyDiscountToLodging(lodgingBase, peakBase, discount);
  const discountInfo = discount && discountAmount > 0
    ? { id: discount.id, label: discount.label, percent: discount.percent, amount: discountAmount }
    : null;
  const linenCount = Math.min(Math.max(0, Number(addons.linenCount) || 0), Math.max(0, Number(guests) || 0));
  const addonResult = addonLines({ ...addons, linenCount, guests }).map((line) => ({
    id: line.id, label: line.label, amount: line.amount, request: line.request
  }));
  const addonsTotal = addonResult.reduce((total, line) => total + line.amount, 0);
  return {
    nights,
    nightlyBreakdown: breakdown,
    lodgingBase,
    peakNights: peakNights.length,
    peakBase,
    discount: discountInfo,
    discountAmount,
    lodgingAfterDiscount: discountedBase,
    addonLines: addonResult,
    addonsTotal,
    total: discountedBase + addonsTotal,
    priceVersion: PRICE_VERSION
  };
}

export function formatSek(amount) {
  return `${new Intl.NumberFormat('sv-SE').format(amount)} kr`;
}

// Tekst för UI: rabatten gäller boendepriset i offerten.
export function discountNote(nights) {
  const discount = bestDiscount(nights);
  if (!discount) return null;
  return `${discount.label} ${discount.percent} % gäller för vistelser på ${discount.minNights} nätter eller fler och dras av från boendepriset i offerten.`;
}
