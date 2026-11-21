'use strict';

// Kalenderbuffertar för tidig incheckning och sen utcheckning.
//
// En buffertnatt är INTE en debiterad övernattning. Den finns bara för att
// hindra en annan gäst från att boka natten före ankomst (tidig incheckning)
// eller natten på avresedatumet (sen utcheckning). Buffertnätterna lagras som
// vanliga kalenderrader med samma bokningsreferens som bokningen, men med
// kind='BUFFER', så att de aldrig påverkar antal nätter eller pris.
//
// Äldre bokningar saknar bufferNightsMode och behandlas därför som 'manual'.
// Den nya implementationen får aldrig lägga till buffertar på en sådan bokning
// automatiskt. Nya bokningar sätter uttryckligen 'auto'.

const DAY = 86400000;

function validDateKey(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const timestamp = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value;
}

function addDays(dateKey, count) {
  return new Date(Date.parse(`${dateKey}T00:00:00Z`) + count * DAY).toISOString().slice(0, 10);
}

function nightKeys(arrival, departure) {
  if (!validDateKey(arrival) || !validDateKey(departure) || departure <= arrival) return [];
  const nights = [];
  for (let night = arrival; night < departure && nights.length < 100; night = addDays(night, 1)) {
    nights.push(night);
  }
  return nights;
}

function todayKey(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Stockholm', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(now);
}

function automaticBufferNights(record) {
  if (!record || record.bufferNightsMode !== 'auto') return [];
  if (!validDateKey(record.arrival) || !validDateKey(record.departure)) return [];
  const addons = record.addons && typeof record.addons === 'object' ? record.addons : {};
  const nights = [];
  if (addons.tidigIncheckning === true) nights.push(addDays(record.arrival, -1));
  if (addons.senUtcheckning === true) nights.push(record.departure);
  return [...new Set(nights)].filter(validDateKey).sort();
}

// Returnerar de extra nätter som ska låsas för en bokning. Uttryckligen
// manuella/legacy-bokningar får inga automatiska buffertar.
function bufferNightsFor(record) {
  return automaticBufferNights(record);
}

// Alla nätter som bokningen äger i huvudbyggnadens kalender.
function lockedNightsFor(record) {
  if (!record) return [];
  return [...new Set([
    ...nightKeys(record.arrival, record.departure),
    ...bufferNightsFor(record)
  ])].sort();
}

function lockedRange(record) {
  const nights = lockedNightsFor(record);
  if (!nights.length) return null;
  return { from: nights[0], to: addDays(nights[nights.length - 1], 1), nights };
}

function bufferAddonsFor(record) {
  const nights = bufferNightsFor(record);
  const addons = record?.addons ?? {};
  return {
    tidigIncheckning: addons.tidigIncheckning === true
      ? addDays(record.arrival, -1)
      : '',
    senUtcheckning: addons.senUtcheckning === true ? record.departure : '',
    nights
  };
}

module.exports = {
  validDateKey,
  addDays,
  nightKeys,
  todayKey,
  bufferNightsFor,
  lockedNightsFor,
  lockedRange,
  bufferAddonsFor
};
