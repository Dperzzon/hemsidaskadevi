'use strict';

// Avbokningsvillkor (beslutade 2026-11-10, v3).
//
//   Avbokning minst 30 dagar före incheckning ............ 100 % återbetalning
//   Avbokning 14 dagar till mindre än 30 dagar före ........ 50 % återbetalning
//   Avbokning mindre än 14 dagar före incheckning ..........   0 % återbetalning
//
// Återbetalningsprocenten beräknas på den bekräftade boendesumman enligt
// offerten — tillval debiteras inte i förväg och avbokningsvillkoren
// begränsar inte lagstadgade konsumenträttigheter.

const POLICY = {
  fullRefund: { minDaysBefore: 30, percent: 100 },
  partialRefund: { minDaysBefore: 14, percent: 50 },
  noRefund: { minDaysBefore: 0, percent: 0 },
  basis: 'bekräftad boendesumma enligt offerten',
  pendingDecisions: []
};

// Antal dagar före incheckning (dagsprecision; ISO-datum räknas som
// daggränser, inte klockslag).
function daysBefore(arrival, cancellationDate) {
  const arrivalTime = Date.parse(`${arrival}T00:00:00Z`);
  const cancelledTime = Date.parse(`${cancellationDate}T00:00:00Z`);
  if (!Number.isFinite(arrivalTime) || !Number.isFinite(cancelledTime)) return null;
  return Math.round((arrivalTime - cancelledTime) / 86400000);
}

// Returnerar återbetalningsprocenten för en avbokning, eller null när
// villkoret saknas (ogiltiga datum).
function refundPercent(arrival, cancellationDate) {
  const days = daysBefore(arrival, cancellationDate);
  if (days === null) return null;
  if (days >= POLICY.fullRefund.minDaysBefore) return POLICY.fullRefund.percent;
  if (days >= POLICY.partialRefund.minDaysBefore) return POLICY.partialRefund.percent;
  return POLICY.noRefund.percent;
}

module.exports = { POLICY, daysBefore, refundPercent };
