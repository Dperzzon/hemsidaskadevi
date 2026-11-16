'use strict';

// Dokumentmodell för offert och bokningsbekräftelse. Modellen är read-only:
// den bygger presentationsdata från bokningens sparade prissnapshot och ändrar
// aldrig bokningen, statusen, betalningar eller kalendern.

const {
  formatDateKey,
  formatMoney,
  todayKey,
  PAYMENT_LABELS
} = require('../domain');
const { loadRules } = require('../../booking/rules');

const DOCUMENT_KINDS = Object.freeze({
  QUOTE: 'quote',
  CONFIRMATION: 'confirmation'
});

const CONTACT = Object.freeze({
  name: 'Skadevi Herrgård',
  address: 'Skoklostervägen 16',
  postal: '746 94 Häggeby',
  phone: '+46 70 273 04 22',
  email: 'skadevigard@gmail.com',
  website: 'www.skadeviherrgard.com'
});

class DocumentError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'DocumentError';
    this.status = status;
    this.code = code;
  }
}

function cleanText(value, limit = 4000) {
  if (value === undefined || value === null) return '';
  return String(value)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .trim()
    .slice(0, limit);
}

function safeReference(reference) {
  const safe = cleanText(reference, 120)
    .replace(/[^A-Za-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return safe || 'BOKNING';
}

function filenameFor(kind, reference) {
  const safe = safeReference(reference);
  return kind === DOCUMENT_KINDS.QUOTE
    ? `Skadevi-Offert-${safe}.pdf`
    : `Skadevi-Bokningsbekraftelse-${safe}.pdf`;
}

function quoteNumber(reference) {
  return `OFF-${safeReference(reference)}`;
}

function numberOrZero(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function discountText(booking) {
  const label = cleanText(booking.discountLabel, 120) || 'Rabatt';
  const percent = numberOrZero(booking.discountPercent);
  return percent > 0 ? `${label} (${percent} %)` : label;
}

function priceModel(booking) {
  const discountAmount = numberOrZero(booking.discountAmount);
  const hasDiscount = discountAmount > 0;
  const lodgingAmount = hasDiscount
    ? numberOrZero(booking.lodgingAfterDiscount ?? booking.lodgingBase)
    : numberOrZero(booking.lodgingBase);
  const addonsTotal = numberOrZero(booking.totalAddons);
  const total = numberOrZero(booking.total);
  const agreedTotal = booking.agreedTotal === null || booking.agreedTotal === undefined
    ? null
    : numberOrZero(booking.agreedTotal);

  const rows = [{
    label: hasDiscount ? 'Boendepris efter rabatt' : 'Boendepris',
    amount: lodgingAmount,
    kind: 'lodging'
  }];
  if (hasDiscount) {
    rows.push({
      label: discountText(booking),
      amount: discountAmount,
      kind: 'discount',
      note: 'Redan avdragen från boendepriset – dras inte av igen.'
    });
  }
  rows.push({ label: 'Summa tillval', amount: addonsTotal, kind: 'addons' });
  rows.push({ label: 'Totalpris (inkl. moms)', amount: total, kind: 'total', total: true });

  const notes = [];
  if (agreedTotal !== null) {
    const reason = cleanText(booking.priceAdjustmentReason, 300);
    notes.push(
      `Avtalat pris enligt överenskommelse${reason ? ` (${reason})` : ''}. ` +
      `Beräknat pris enligt bokningens prissnapshot: ${formatMoney(booking.calculatedTotal)}.`
    );
  }
  const arithmetic = lodgingAmount + addonsTotal;
  if (agreedTotal === null && total !== arithmetic) {
    notes.push(
      'Totalpriset är hämtat från bokningens sparade prissnapshot och räknas inte om vid dokumentgenerering.'
    );
  }
  notes.push(
    'Beloppen anges i svenska kronor enligt bokningens sparade prisunderlag. ' +
    'Moms ingår i totalpriset; ingen momssats eller momsfördelning anges eftersom underlaget inte innehåller det.'
  );

  return {
    hasDiscount,
    lodgingAmount,
    addonsTotal,
    total,
    agreedTotal,
    rows,
    notes
  };
}

function paymentModel(booking) {
  const hasOre = Number.isFinite(Number(booking.totalOre));
  const total = hasOre ? Number(booking.totalOre) / 100 : numberOrZero(booking.total);
  const amountPaid = Number.isFinite(Number(booking.amountPaidOre))
    ? Number(booking.amountPaidOre) / 100
    : numberOrZero(booking.amountPaid);
  const remaining = Number.isFinite(Number(booking.remainingOre))
    ? Number(booking.remainingOre) / 100
    : numberOrZero(booking.balance);
  const overpaidAmount = remaining < 0 ? -remaining : 0;
  const balance = Math.max(0, remaining);
  const status = String(booking.paymentStatus || 'UNKNOWN').toUpperCase();
  const statusLabel = booking.paymentLabel ?? PAYMENT_LABELS[booking.paymentStatus] ?? 'Okänd';
  const rows = [
    { label: 'Totalpris', value: formatMoney(total) },
    { label: 'Totalt mottagna betalningar', value: formatMoney(amountPaid) },
    { label: 'Återstående belopp', value: formatMoney(balance) }
  ];
  if (overpaidAmount > 0) {
    rows.push({ label: 'Överbetalning', value: formatMoney(overpaidAmount) });
  }
  rows.push({ label: 'Betalstatus', value: statusLabel });
  return {
    status,
    statusLabel,
    total,
    amountPaid,
    balance,
    overpaidAmount,
    rows
  };
}

function guestModel(booking) {
  return {
    name: cleanText(booking.guestName, 200) || 'Gäst',
    company: cleanText(booking.company, 200),
    email: cleanText(booking.email, 200),
    phone: cleanText(booking.phone, 80)
  };
}

function stayModel(booking) {
  return {
    arrival: cleanText(booking.arrival, 10),
    departure: cleanText(booking.departure, 10),
    arrivalText: formatDateKey(booking.arrival, { long: true }),
    departureText: formatDateKey(booking.departure, { long: true }),
    nights: numberOrZero(booking.nights),
    guests: numberOrZero(booking.guests)
  };
}

function addonLines(booking) {
  const lines = Array.isArray(booking.addonLines) ? booking.addonLines : [];
  return lines.map((line) => ({
    label: cleanText(line.label, 200) || 'Tillval',
    quantity: numberOrZero(line.quantity),
    unitPrice: numberOrZero(line.unitPrice),
    amount: numberOrZero(line.amount)
  }));
}

function termsText(rules) {
  if (!rules || rules.published !== true) return '';
  return cleanText(rules.text, 12000);
}

function baseModel(booking, kind, options = {}) {
  if (booking.isBlock) {
    throw new DocumentError(422, 'DOCUMENT_NOT_AVAILABLE', 'Datumblockeringar har inga gäst- eller prisuppgifter och kan inte få ett dokument.');
  }
  const now = options.now ?? new Date();
  const issuedDateKey = todayKey(now);
  const rules = options.rules ?? null;
  return {
    kind,
    reference: cleanText(booking.reference, 120),
    documentNumber: kind === DOCUMENT_KINDS.QUOTE
      ? quoteNumber(booking.reference)
      : cleanText(booking.reference, 120),
    issuedDate: formatDateKey(issuedDateKey, { long: true }),
    issuedDateKey,
    guest: guestModel(booking),
    stay: stayModel(booking),
    addons: addonLines(booking),
    price: priceModel(booking),
    payments: paymentModel(booking),
    terms: termsText(rules),
    termsVersion: rules?.version ? cleanText(rules.version, 80) : '',
    contact: CONTACT,
    bookingSource: cleanText(booking.bookingSourceLabel, 120),
    statusCode: cleanText(booking.statusCode, 40),
    confirmedAt: cleanText(booking.confirmedAt, 40),
    isDemo: booking.isDemo === true
  };
}

function buildQuoteModel(booking, options = {}) {
  const model = baseModel(booking, DOCUMENT_KINDS.QUOTE, options);
  model.title = 'OFFERT';
  model.headerRight = `Offertnummer: ${model.documentNumber}`;
  model.lead = 'Offert för vistelse på Skadevi Herrgård.';
  model.disclaimer = [
    'Detta är en offert och inte en bekräftad bokning.',
    'Bokningen är inte bekräftad förrän Skadevi Herrgård har bekräftat den skriftligt. ' +
    'Offerten låser inte datumen och påverkar inte bokningens status.'
  ];
  model.closing = 'Vi ser fram emot att välkomna er till Skadevi Herrgård.';
  return model;
}

function buildConfirmationModel(booking, options = {}) {
  if (booking.statusCode !== 'CONFIRMED') {
    throw new DocumentError(
      409,
      'CONFIRMATION_REQUIRES_CONFIRMED',
      'Bokningsbekräftelse kan endast skapas för bokningar med status CONFIRMED.'
    );
  }
  const model = baseModel(booking, DOCUMENT_KINDS.CONFIRMATION, options);
  model.title = 'BOKNINGSBEKRÄFTELSE';
  model.headerRight = `Bokningsnummer: ${model.documentNumber}`;
  model.lead = 'Er bokning på Skadevi Herrgård är bekräftad.';
  model.disclaimer = [
    'Bokningen är bekräftad.',
    'Betalningsuppgifterna nedan är hämtade från bokningen och ändras inte av detta dokument.'
  ];
  model.closing = 'Varmt välkomna till Skadevi Herrgård.';
  return model;
}

async function loadDocumentRules(options = {}) {
  if (options.rules) return options.rules;
  return loadRules(options);
}

async function buildDocument(kind, booking, options = {}) {
  const rules = await loadDocumentRules(options);
  const enriched = { ...options, rules };
  if (kind === DOCUMENT_KINDS.QUOTE) return buildQuoteModel(booking, enriched);
  if (kind === DOCUMENT_KINDS.CONFIRMATION) return buildConfirmationModel(booking, enriched);
  throw new DocumentError(404, 'UNKNOWN_DOCUMENT', 'Okänd dokumenttyp.');
}

module.exports = {
  DOCUMENT_KINDS,
  CONTACT,
  DocumentError,
  cleanText,
  safeReference,
  filenameFor,
  quoteNumber,
  priceModel,
  paymentModel,
  buildQuoteModel,
  buildConfirmationModel,
  buildDocument,
  loadDocumentRules
};
