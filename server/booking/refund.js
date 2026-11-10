'use strict';

// Avbokningsvillkor (beslutade 2026-11-10).
//
//   Avbokning minst 30 dagar före incheckning ............ 100 % återbetalning
//   Avbokning 7 dagar till mindre än 30 dagar före ........  50 % återbetalning
//   Avbokning mindre än 7 dagar före incheckning .......... EJ ÄNNU BESLUTAT
//
// Nivån vid avbokning mindre än 7 dagar före incheckning ska inte hittas på:
// den flaggas (PENDING_DECISIONS) och återbetalningen specificeras vid
// bekräftelse. Återbetalningsprocenten beräknas på den bekräftade
// boendesumman enligt offerten — tillval debiteras inte i förväg och
// avbokningsvillkoren begränsar inte lagstadgade konsumenträttigheter.

const POLICY = {
  fullRefund: { minDaysBefore: 30, percent: 100 },
  partialRefund: { minDaysBefore: 7, percent: 50 },
  basis: 'bekräftad boendesumma enligt offerten',
  pendingDecisions: ['avbokning-mindre-an-7-dagar']
};

// Antal dagar före incheckning (dagsprecision, europeiska tider räknas som
// datorer hanterar ISO-datum — daggränser, inte klockslag).
function daysBefore(arrival, cancellationDate) {
  const arrivalTime = Date.parse(`${arrival}T00:00:00Z`);
  const cancelledTime = Date.parse(`${cancellationDate}T00:00:00Z`);
  if (!Number.isFinite(arrivalTime) || !Number.isFinite(cancelledTime)) return null;
  return Math.round((arrivalTime - cancelledTime) / 86400000);
}

// Returnerar återbetalningsprocenten för en avbokning, eller null när villkoret
// ännu inte är beslutat (mindre än 7 dagar före incheckning).
function refundPercent(arrival, cancellationDate) {
  const days = daysBefore(arrival, cancellationDate);
  if (days === null) return null;
  if (days >= POLICY.fullRefund.minDaysBefore) return POLICY.fullRefund.percent;
  if (days >= POLICY.partialRefund.minDaysBefore) return POLICY.partialRefund.percent;
  return null;
}

module.exports = { POLICY, daysBefore, refundPercent };
