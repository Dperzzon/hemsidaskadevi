// Rena datumfunktioner för bokningsflödet (tidszonssäkra, dag-precisa).
// Alla datum är dagnycklar "YYYY-MM-DD" i Europe/Stockholm — samma semantik
// som serverns tillgänglighets-API (blockerade nätter, hotelllogik: avresedagen
// är inte en bokad natt och får sammanfalla med nästa boknings ankomstdag).

const DAY = 86400000;

export function nightsBetween(arrival, departure) {
  if (!arrival || !departure) return 0;
  return Math.round((Date.parse(`${departure}T00:00:00Z`) - Date.parse(`${arrival}T00:00:00Z`)) / DAY);
}

// Nätterna i en vistelse [arrival, departure) — avresedagen är ingen natt.
export function eachNight(arrival, departure) {
  const nights = [];
  let date = arrival;
  while (date < departure) {
    nights.push(date);
    date = new Date(Date.parse(`${date}T00:00:00Z`) + DAY).toISOString().slice(0, 10);
  }
  return nights;
}

// Dagens datum i Sverige enligt uppgiven tid (eller nu).
export function stockholmTodayKey(now = new Date(), timeZone = 'Europe/Stockholm') {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(now);
}

// Kan datumet användas som ankomstdatum?
export function validateArrival(key, blocked, todayKey) {
  if (key < todayKey) return { ok: false, reason: 'past' };
  if (blocked.has(key)) return { ok: false, reason: 'booked' };
  return { ok: true };
}

// Kan [arrival, departure) användas som vistelse? Avresedagen själv får vara
// bokad (den är ingen natt), men alla nätter måste vara lediga.
export function validateRange(arrival, departure, blocked) {
  if (!arrival || !departure || departure <= arrival) return { ok: false, reason: 'incomplete' };
  for (const night of eachNight(arrival, departure)) {
    if (blocked.has(night)) return { ok: false, reason: 'booked-night', firstBlocked: night };
  }
  return { ok: true };
}
