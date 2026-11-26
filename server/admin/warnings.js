'use strict';

// Återanvändbar varningsmotor för bokningsportalen. Modulen är ren och gör
// inga I/O-anrop: den härleder administrativa varningar från en normaliserad
// bokning och eventuell kalenderkontext. Kvitteringar sparas på bokningen och
// gäller endast exakt samma varningsfingeravtryck. En kvittering ändrar aldrig
// bokningens status, datum eller kalenderlås.

const DAY = 86400000;

// Ett mejl som endast accepterats av Resend får inte larma direkt. Normal
// leverans sker oftast inom några sekunder, men tillfälliga köer hos
// mottagaren kan ta några minuter. Först efter denna tid krävs uppmärksamhet.
const MAIL_UNVERIFIED_ALERT_MINUTES = 60;

const WARNING = {
  AIRBNB_UNVERIFIED: 'airbnb.unverified',
  AIRBNB_UNAVAILABLE: 'airbnb.unavailable',
  AIRBNB_VERIFICATION_STALE: 'airbnb.verification_stale',
  AIRBNB_AVAILABLE: 'airbnb.available',
  AIRBNB_PARTIAL: 'airbnb.partial',
  AIRBNB_CONFLICT: 'airbnb.conflict',
  AIRBNB_VERIFIED: 'airbnb.verified',
  AIRBNB_OVERRIDE: 'airbnb.override',
  AIRBNB_OVERRIDE_STALE: 'airbnb.override_stale',
  AIRBNB_IMPORT_PENDING: 'airbnb.import_pending',
  AIRBNB_MANUAL_VERIFIED: 'airbnb.manual_verified',
  INTERNAL_CALENDAR_CONFLICT: 'internal.calendar_conflict',
  INTERNAL_BOOKING_CONFLICT: 'internal.booking_conflict',
  INTERNAL_CALENDAR_MISSING: 'internal.calendar_missing',
  INTERNAL_CALENDAR_UNAVAILABLE: 'internal.calendar_unavailable',
  CALENDAR_FLAG: 'calendar.flagged',
  OVERLAP: 'request.overlap',
  MAIL_REVIEW: 'mail.review',
  MAIL_PENDING: 'mail.pending',
  MAIL_FAILED: 'mail.failed',
  MAIL_UNVERIFIED: 'mail.unverified',
  PAYMENT_MISSING: 'payment.missing',
  RECONCILIATION: 'payment.reconciliation',
  REFUND_PENDING: 'payment.refund_pending',
  ADDON_DATA_CONFLICT: 'addon.data_conflict',
  REQUEST_STALE: 'request.stale'
};

const SEVERITY = {
  ACTION: 'action',
  VERIFY: 'verify',
  HANDLED: 'handled'
};

// dismissible styr om Owner får kvittera varningen. Interna konflikter och
// ekonomiska brister är medvetet inte kvitteringsbara.
const POLICIES = {
  [WARNING.AIRBNB_UNVERIFIED]: { type: 'AIRBNB', severity: SEVERITY.VERIFY, dismissible: true, recheckable: true },
  [WARNING.AIRBNB_UNAVAILABLE]: { type: 'AIRBNB', severity: SEVERITY.VERIFY, dismissible: true, recheckable: true },
  [WARNING.AIRBNB_VERIFICATION_STALE]: { type: 'AIRBNB', severity: SEVERITY.VERIFY, dismissible: true, recheckable: true },
  [WARNING.AIRBNB_AVAILABLE]: { type: 'AIRBNB', severity: SEVERITY.ACTION, dismissible: true, recheckable: true },
  [WARNING.AIRBNB_PARTIAL]: { type: 'AIRBNB', severity: SEVERITY.ACTION, dismissible: true, recheckable: true },
  [WARNING.AIRBNB_CONFLICT]: { type: 'AIRBNB', severity: SEVERITY.ACTION, dismissible: true, recheckable: true },
  [WARNING.AIRBNB_VERIFIED]: { type: 'AIRBNB', severity: SEVERITY.HANDLED, dismissible: false, recheckable: true },
  [WARNING.AIRBNB_OVERRIDE]: { type: 'AIRBNB', severity: SEVERITY.HANDLED, dismissible: false, recheckable: true },
  [WARNING.AIRBNB_OVERRIDE_STALE]: { type: 'AIRBNB', severity: SEVERITY.ACTION, dismissible: true, recheckable: true },
  [WARNING.AIRBNB_IMPORT_PENDING]: { type: 'AIRBNB', severity: SEVERITY.VERIFY, dismissible: true, recheckable: true },
  [WARNING.AIRBNB_MANUAL_VERIFIED]: { type: 'AIRBNB', severity: SEVERITY.HANDLED, dismissible: false, recheckable: true },
  [WARNING.INTERNAL_CALENDAR_CONFLICT]: { type: 'INTERNAL_CALENDAR', severity: SEVERITY.ACTION, dismissible: false, recheckable: false },
  [WARNING.INTERNAL_BOOKING_CONFLICT]: { type: 'INTERNAL_BOOKING', severity: SEVERITY.ACTION, dismissible: false, recheckable: false },
  [WARNING.INTERNAL_CALENDAR_MISSING]: { type: 'INTERNAL_CALENDAR', severity: SEVERITY.ACTION, dismissible: false, recheckable: false },
  [WARNING.INTERNAL_CALENDAR_UNAVAILABLE]: { type: 'INTERNAL_CALENDAR', severity: SEVERITY.VERIFY, dismissible: false, recheckable: false },
  [WARNING.CALENDAR_FLAG]: { type: 'INTERNAL_CALENDAR', severity: SEVERITY.ACTION, dismissible: false, recheckable: false },
  [WARNING.OVERLAP]: { type: 'INTERNAL_BOOKING', severity: SEVERITY.ACTION, dismissible: false, recheckable: false },
  [WARNING.MAIL_REVIEW]: { type: 'MAIL', severity: SEVERITY.VERIFY, dismissible: true, recheckable: true },
  [WARNING.MAIL_PENDING]: { type: 'MAIL', severity: SEVERITY.VERIFY, dismissible: true, recheckable: true },
  [WARNING.MAIL_FAILED]: { type: 'MAIL', severity: SEVERITY.ACTION, dismissible: true, recheckable: true },
  [WARNING.MAIL_UNVERIFIED]: { type: 'MAIL', severity: SEVERITY.VERIFY, dismissible: true, recheckable: true },
  [WARNING.PAYMENT_MISSING]: { type: 'PAYMENT', severity: SEVERITY.ACTION, dismissible: false, recheckable: false },
  [WARNING.RECONCILIATION]: { type: 'PAYMENT', severity: SEVERITY.ACTION, dismissible: false, recheckable: false },
  [WARNING.REFUND_PENDING]: { type: 'PAYMENT', severity: SEVERITY.ACTION, dismissible: false, recheckable: false },
  [WARNING.ADDON_DATA_CONFLICT]: { type: 'ADDON', severity: SEVERITY.ACTION, dismissible: false, recheckable: false },
  [WARNING.REQUEST_STALE]: { type: 'REQUEST', severity: SEVERITY.ACTION, dismissible: false, recheckable: false }
};

function validDateKey(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const timestamp = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value;
}

function addDays(dateKey, days) {
  const date = new Date(`${dateKey}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function nightKeys(arrival, departure) {
  if (!validDateKey(arrival) || !validDateKey(departure)) return [];
  const nights = [];
  let date = arrival;
  while (date < departure) {
    nights.push(date);
    date = addDays(date, 1);
  }
  return nights;
}

function todayKey(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Stockholm',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(now);
}

function stayFingerprint(booking = {}) {
  return [
    String(booking.reference ?? ''),
    String(booking.arrival ?? ''),
    String(booking.departure ?? ''),
    String(booking.bookingSource ?? '')
  ].join('|');
}

function warningFingerprint(booking, id, extra = '') {
  return [
    stayFingerprint(booking),
    String(booking.statusCode ?? ''),
    String(id ?? ''),
    String(extra ?? '')
  ].join('|');
}

function nightsText(nights) {
  if (!nights.length) return 'inga nätter';
  if (nights.length === 1) return nights[0];
  return `${nights.length} nätter (${nights[0]} – ${nights[nights.length - 1]})`;
}

function normalizeAcknowledgements(booking = {}) {
  const rows = Array.isArray(booking.warningAcknowledgements) ? booking.warningAcknowledgements : [];
  return rows
    .filter((row) => row && typeof row === 'object' && row.warningId && row.fingerprint)
    .map((row) => ({
      warningId: String(row.warningId),
      fingerprint: String(row.fingerprint),
      type: String(row.type ?? ''),
      title: String(row.title ?? ''),
      reason: String(row.reason ?? ''),
      actorId: String(row.actorId ?? ''),
      actorName: String(row.actorName ?? ''),
      at: String(row.at ?? ''),
      method: String(row.method ?? ''),
      evidenceKey: String(row.evidenceKey ?? ''),
      stayFingerprint: String(row.stayFingerprint ?? ''),
      nights: Array.isArray(row.nights) ? row.nights.map(String) : [],
      mailKey: String(row.mailKey ?? ''),
      mailType: String(row.mailType ?? ''),
      resendId: String(row.resendId ?? ''),
      verifiedEvent: String(row.verifiedEvent ?? '')
    }));
}

function latestManualAirbnbAck(booking = {}) {
  const acks = normalizeAcknowledgements(booking)
    .filter((ack) => ack.method === 'MANUAL_AIRBNB');
  let found = null;
  for (const ack of acks) {
    if (ack.stayFingerprint !== stayFingerprint(booking)) continue;
    if (!found || String(ack.at) > String(found.at)) found = ack;
  }
  return found;
}

function manualMailKeys(booking = {}) {
  const keys = new Map();
  for (const ack of normalizeAcknowledgements(booking)) {
    if (ack.method !== 'MANUAL_RESEND') continue;
    const key = `${ack.mailKey}|${ack.resendId}`;
    if (!ack.resendId) continue;
    const existing = keys.get(key);
    if (!existing || String(ack.at) > String(existing.at)) keys.set(key, ack);
  }
  return keys;
}

function mailManuallyVerified(booking, key, level) {
  if (!level?.resendId) return null;
  const acks = manualMailKeys(booking);
  return acks.get(`${key}|${level.resendId}`) ?? null;
}

function normalizeVerification(booking = {}) {
  const value = booking.airbnbVerification;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const status = ['blocked', 'available', 'partial', 'unavailable'].includes(value.status)
    ? value.status
    : 'unavailable';
  return {
    status,
    blockedNights: Array.isArray(value.blockedNights)
      ? value.blockedNights.filter((night) => validDateKey(night))
      : [],
    checkedAt: String(value.checkedAt ?? ''),
    checkedBy: String(value.checkedBy ?? ''),
    fingerprint: String(value.fingerprint ?? ''),
    source: String(value.source ?? ''),
    error: String(value.error ?? '')
  };
}

function latestAck(acks, warning) {
  let found = null;
  for (const ack of acks) {
    if (ack.warningId !== warning.id || ack.fingerprint !== warning.fingerprint) continue;
    if (!found || String(ack.at) > String(found.at)) found = ack;
  }
  return found;
}

function createWarning(id, fields = {}) {
  const policy = POLICIES[id] ?? {
    type: 'OTHER',
    severity: SEVERITY.ACTION,
    dismissible: false,
    recheckable: false
  };
  return {
    id,
    type: policy.type,
    severity: policy.severity,
    title: fields.title ?? id,
    what: fields.what ?? '',
    why: fields.why ?? '',
    recommendation: fields.recommendation ?? '',
    dismissible: policy.dismissible,
    recheckable: policy.recheckable,
    fingerprint: fields.fingerprint ?? '',
    details: fields.details ?? {},
    handledBy: fields.handledBy ?? '',
    handledAt: fields.handledAt ?? '',
    handledReason: fields.handledReason ?? '',
    acknowledged: fields.acknowledged === true
  };
}

function overrideCoversStay(booking, nights) {
  if (!booking.airbnbOverride) return false;
  const approved = Array.isArray(booking.airbnbBlockedNights) ? booking.airbnbBlockedNights : [];
  const fingerprint = String(booking.airbnbOverrideFingerprint ?? '');
  if (fingerprint) return fingerprint === stayFingerprint(booking);
  if (approved.length) {
    // Äldre poster saknar fingeravtryck. Då krävs att minst en godkänd natt
    // fortfarande ligger inom vistelsen; annars har datumen uppenbart ändrats.
    return approved.some((night) => nights.includes(night));
  }
  // En uttryckligen godkänd override utan sparade nätter är fortfarande ett
  // Owner-godkännande. Det visas som hanterat, aldrig som verifierat blockerat.
  return Boolean(booking.airbnbOverrideApprovedAt || booking.airbnbOverrideReason ||
    booking.airbnbOverrideApprovedBy);
}

function confirmedAgeHours(booking, now) {
  const confirmed = Date.parse(String(booking.confirmedAt || booking.updatedAt || booking.createdAt || ''));
  if (!Number.isFinite(confirmed)) return null;
  return (now.getTime() - confirmed) / 3600000;
}

function internalNightsCovered(booking, nights, calendarRows) {
  if (!Array.isArray(calendarRows)) return null;
  const owned = new Set(calendarRows
    .filter((row) => row.reference === booking.reference)
    .map((row) => String(row.night ?? row.RowKey ?? '')));
  return nights.every((night) => owned.has(night));
}

function manualAirbnbWarning(booking, nights, ack) {
  const verifiedNights = Array.isArray(ack.nights) && ack.nights.length ? ack.nights : nights;
  return createWarning(WARNING.AIRBNB_MANUAL_VERIFIED, {
    title: 'Airbnb manuellt verifierad av Owner',
    what: `Owner har manuellt kontrollerat att ${nightsText(verifiedNights)} är blockerade i Airbnb-gränssnittet.`,
    why: 'Detta är en manuell kontroll i Airbnb, inte en automatisk verifiering av Airbnbs exporterade kalender. Exporten kan sakna manuellt importerade blockeringar.',
    recommendation: 'Om datumen ändras eller en ny kalenderkonflikt uppstår skapas en ny varning. Använd automatisk kontroll om du vill försöka verifiera exporten igen.',
    fingerprint: warningFingerprint(booking, WARNING.AIRBNB_MANUAL_VERIFIED, verifiedNights.join(',')),
    details: {
      nights: verifiedNights,
      verifiedAt: ack.at,
      verifiedBy: ack.actorName,
      note: ack.reason,
      caveat: 'Manuellt verifierad i Airbnb. Inte automatiskt verifierad via Airbnbs export.'
    },
    handledBy: ack.actorName,
    handledAt: ack.at,
    handledReason: ack.reason
  });
}

function airbnbWarnings(booking, options = {}) {
  if (booking.statusCode !== 'CONFIRMED') return [];
  const nights = nightKeys(booking.arrival, booking.departure);
  if (!nights.length) return [];
  const lockedNights = [...new Set([
    ...nights,
    ...(Array.isArray(booking.bufferNights) ? booking.bufferNights.filter(validDateKey) : [])
  ])].sort();
  const verification = normalizeVerification(booking);
  const now = options.now instanceof Date ? options.now : new Date();
  const internalCovered = internalNightsCovered(booking, nights, options.calendarRows);
  const ageHours = confirmedAgeHours(booking, now);
  const manualAck = latestManualAirbnbAck(booking);

  if (verification) {
    if (verification.fingerprint && verification.fingerprint !== stayFingerprint(booking)) {
      return [createWarning(WARNING.AIRBNB_VERIFICATION_STALE, {
        title: 'Airbnb-kontrollen gäller inte längre',
        what: 'Bokningens datum har ändrats sedan Airbnb-kalendern kontrollerades.',
        why: 'Ett sparat verifieringsresultat gäller bara de datum som faktiskt kontrollerades.',
        recommendation: 'Kontrollera de nya datumen i Airbnb och spara en ny kontroll.',
        fingerprint: warningFingerprint(booking, WARNING.AIRBNB_VERIFICATION_STALE, verification.checkedAt),
        details: { checkedAt: verification.checkedAt }
      })];
    }
    if (verification.status === 'unavailable') {
      if (manualAck) return [manualAirbnbWarning(booking, nights, manualAck)];
      return [createWarning(WARNING.AIRBNB_UNAVAILABLE, {
        title: 'Kalenderstatus kan inte verifieras',
        what: 'Airbnb-blockeringen är okänd eftersom Airbnbs exporterade kalender inte kunde hämtas eller tolkas.',
        why: 'Ett misslyckat dataläsningsförsök är inte samma sak som ett verifierat OK. Det säger heller inget om Airbnb har importerat Skadevis export.',
        recommendation: 'Försök igen om en stund. Kontrollera Airbnb manuellt innan du markerar varningen som hanterad.',
        fingerprint: warningFingerprint(booking, WARNING.AIRBNB_UNAVAILABLE, 'unavailable'),
        details: { nights: lockedNights, checkedAt: verification.checkedAt, error: verification.error }
      })];
    }
    if (verification.status === 'blocked') {
      const covered = verification.blockedNights.length >= nights.length &&
        nights.every((night) => verification.blockedNights.includes(night));
      if (covered) {
        return [createWarning(WARNING.AIRBNB_VERIFIED, {
          title: 'Airbnb-blockeringen är verifierad',
          what: `Airbnb-kalendern visar att ${nightsText(nights)} är blockerade.`,
          why: 'Kontrollen sparades på bokningen och gäller samma datum.',
          recommendation: 'Ingen åtgärd krävs. Kontrollera igen om datumen ändras.',
          fingerprint: warningFingerprint(booking, WARNING.AIRBNB_VERIFIED, verification.checkedAt),
          details: { blockedNights: verification.blockedNights, checkedAt: verification.checkedAt },
          handledBy: verification.checkedBy,
          handledAt: verification.checkedAt
        })];
      }
    }
    const blocked = verification.blockedNights.filter((night) => nights.includes(night));
    if (verification.status === 'partial' || (verification.status === 'blocked' && blocked.length)) {
      return [createWarning(WARNING.AIRBNB_PARTIAL, {
        title: 'Airbnb-blockeringen är ofullständig',
        what: `${blocked.length} av ${nights.length} nätter är blockerade i Airbnb.`,
        why: 'En del av vistelsen är blockerad men inte alla nätter. Det finns risk för dubbelbokning.',
        recommendation: 'Blockera de återstående nätterna i Airbnb och kontrollera igen.',
        fingerprint: warningFingerprint(booking, WARNING.AIRBNB_PARTIAL, blocked.join(',')),
        details: { blockedNights: blocked, checkedAt: verification.checkedAt }
      })];
    }
    if (internalCovered === true && ageHours !== null && ageHours < 24) {
      if (manualAck) return [manualAirbnbWarning(booking, nights, manualAck)];
      return [createWarning(WARNING.AIRBNB_IMPORT_PENDING, {
        title: 'Airbnb-uppdatering väntar',
        what: `Skadevis interna kalender och .ics-export innehåller bokningen, men Airbnbs exporterade kalender visar ännu ingen blockering för ${nightsText(nights)}.`,
        why: 'Airbnb hämtar importerade kalendrar med fördröjning. Det kan också bero på att fel eller en gammal exportadress är importerad. Airbnbs exporterade kalender kan inte bevisa att importen lyckats.',
        recommendation: 'Kontrollera att den aktuella exportadressen är importerad i Airbnb och att datumen är blockerade där. Blockera manuellt om det är brådskande. Markera först som hanterad när du har sett blockeringen i Airbnb.',
        fingerprint: warningFingerprint(booking, WARNING.AIRBNB_IMPORT_PENDING, nights.join(',')),
        details: { blockedNights: [], nights: lockedNights, checkedAt: verification.checkedAt, confirmedAgeHours: ageHours }
      })];
    }
    if (manualAck) return [manualAirbnbWarning(booking, nights, manualAck)];
    return [createWarning(WARNING.AIRBNB_AVAILABLE, {
      title: 'Airbnb-blockering saknas',
      what: `Airbnb-kalendern visar att inga av bokningens ${nights.length} nätter är blockerade.`,
      why: 'Bokningen är bekräftad internt, men Airbnbs exporterade kalender visar ingen blockering. Den kan inte visa om Airbnb har importerat Skadevis export. Orsaken kan vara utebliven import, fördröjd hämtning eller fel/gammal kalenderadress.',
      recommendation: 'Kontrollera att rätt exportadress är importerad i Airbnb och blockera datumen manuellt om de inte redan är blockerade. Markera som hanterad först när du har säkerställt att datumen är blockerade i Airbnb.',
      fingerprint: warningFingerprint(booking, WARNING.AIRBNB_AVAILABLE, nights.join(',')),
      details: { blockedNights: [], nights: lockedNights, checkedAt: verification.checkedAt, internalCovered, confirmedAgeHours: ageHours }
    })];
  }

  if (booking.airbnbBlockedAt || booking.actionFlags?.airbnbBlocked) {
    return [createWarning(WARNING.AIRBNB_VERIFIED, {
      title: 'Airbnb-blockering registrerad',
      what: 'En Airbnb-blockering är registrerad på bokningen.',
      why: 'Bokningen har ett sparat datum för Airbnb-blockering.',
      recommendation: 'Kontrollera igen om du vill verifiera att blockeringen fortfarande gäller.',
      fingerprint: warningFingerprint(booking, WARNING.AIRBNB_VERIFIED, booking.airbnbBlockedAt),
      details: { checkedAt: booking.airbnbBlockedAt },
      handledAt: booking.airbnbBlockedAt,
      handledBy: ''
    })];
  }

  if (booking.airbnbOverride) {
    if (overrideCoversStay(booking, nights)) {
      const approved = (booking.airbnbBlockedNights || []).filter((night) => nights.includes(night));
      return [createWarning(WARNING.AIRBNB_OVERRIDE, {
        title: 'Airbnb-konflikt godkänd av Owner',
        what: `Owner har godkänt Airbnb-konflikten för ${nightsText(approved.length ? approved : nights)}.`,
        why: 'Undantaget är sparat på bokningen och gäller samma datum. Det är ett administrativt godkännande, inte ett bevis på att Airbnb är blockerat.',
        recommendation: 'Ingen åtgärd krävs om samma konflikt fortfarande gäller. Kontrollera igen om datumen ändras.',
        fingerprint: warningFingerprint(booking, WARNING.AIRBNB_OVERRIDE, approved.join(',')),
        details: {
          blockedNights: approved,
          caveat: 'Godkännandet ersätter inte en verifierad Airbnb-blockering.'
        },
        handledBy: booking.airbnbOverrideApprovedBy,
        handledAt: booking.airbnbOverrideApprovedAt,
        handledReason: booking.airbnbOverrideReason
      })];
    }
    return [createWarning(WARNING.AIRBNB_OVERRIDE_STALE, {
      title: 'Airbnb-undantaget gäller inte längre',
      what: 'Bokningens datum eller det godkända konfliktunderlaget har ändrats sedan Owner godkände undantaget.',
      why: 'Ett tidigare godkännande gäller bara den situation som godkändes. Nya datum kräver en ny bedömning.',
      recommendation: 'Kontrollera de nya datumen i Airbnb och markera varningen som hanterad eller registrera ett nytt undantag.',
      fingerprint: warningFingerprint(booking, WARNING.AIRBNB_OVERRIDE_STALE, (booking.airbnbBlockedNights || []).join(',')),
      details: { blockedNights: booking.airbnbBlockedNights || [] }
    })];
  }

  const recorded = Array.isArray(booking.airbnbBlockedNights)
    ? booking.airbnbBlockedNights.filter((night) => validDateKey(night))
    : [];
  if (recorded.length) {
    return [createWarning(WARNING.AIRBNB_CONFLICT, {
      title: 'Airbnb har en identifierad konflikt',
      what: `Airbnb-kalendern har tidigare rapporterat upptagna nätter: ${recorded.join(', ')}.`,
      why: 'En konflikt är registrerad men saknar ett giltigt Owner-godkännande för bokningens datum.',
      recommendation: 'Kontrollera datumen i Airbnb. Om det är din egen blockering kan du markera varningen som hanterad.',
      fingerprint: warningFingerprint(booking, WARNING.AIRBNB_CONFLICT, recorded.join(',')),
      details: { blockedNights: recorded }
    })];
  }

  if (manualAck) return [manualAirbnbWarning(booking, nights, manualAck)];
  return [createWarning(WARNING.AIRBNB_UNVERIFIED, {
    title: 'Airbnb-blockering kunde inte verifieras',
    what: 'Det finns ingen verifierad uppgift om att bokningens datum är blockerade i Airbnb.',
    why: 'Bokningen är bekräftad, men Airbnb-kalendern har inte kontrollerats eller så saknas ett sparat verifieringsresultat.',
    recommendation: 'Kontrollera att datumen är blockerade i Airbnb. Om du redan har gjort det kan du markera varningen som hanterad.',
    fingerprint: warningFingerprint(booking, WARNING.AIRBNB_UNVERIFIED, ''),
    details: { nights: lockedNights }
  })];
}

function internalWarnings(booking, options = {}) {
  const warnings = [];
  const calendarConflicts = Array.isArray(options.calendarConflicts) ? options.calendarConflicts : [];
  const internalConflicts = Array.isArray(options.internalConflicts) ? options.internalConflicts : [];
  const calendarRows = Array.isArray(options.calendarRows) ? options.calendarRows : null;

  if (options.calendarUnavailable === true || options.internalUnavailable === true) {
    warnings.push(createWarning(WARNING.INTERNAL_CALENDAR_UNAVAILABLE, {
      title: 'Intern kalender kunde inte läsas',
      what: 'Det gick inte att kontrollera den interna kalendern eller andra bokningar för bokningens datum.',
      why: 'Kalenderstatus är okänd. Ett misslyckat dataläsningsförsök får inte tolkas som att inga konflikter finns.',
      recommendation: 'Försök igen om en stund. Kontrollera kalendern manuellt innan du fattar beslut.',
      fingerprint: warningFingerprint(booking, WARNING.INTERNAL_CALENDAR_UNAVAILABLE, '')
    }));
  }

  if (calendarConflicts.length) {
    const nights = calendarConflicts.map((row) => row.night ?? row.RowKey ?? '').filter(Boolean);
    const references = [...new Set(calendarConflicts.map((row) => row.reference).filter(Boolean))];
    warnings.push(createWarning(WARNING.INTERNAL_CALENDAR_CONFLICT, {
      title: 'Intern kalenderkonflikt',
      what: `Datumen är redan låsta i den interna kalendern: ${nightsText(nights)}.`,
      why: 'En annan bokning eller blockering äger samma nätter. Intern dubbelbokning får aldrig döljas genom kvittering.',
      recommendation: 'Avboka eller ändra den ena bokningen. Varningen kan inte markeras som hanterad.',
      fingerprint: warningFingerprint(booking, WARNING.INTERNAL_CALENDAR_CONFLICT, `${nights.join(',')}|${references.join(',')}`),
      details: { nights, references }
    }));
  }

  if (internalConflicts.length) {
    const references = internalConflicts.map((other) => other.reference).filter(Boolean);
    warnings.push(createWarning(WARNING.INTERNAL_BOOKING_CONFLICT, {
      title: 'Intern dubbelbokning',
      what: `Bokningen överlappar en annan bekräftad bokning eller blockering: ${references.join(', ')}.`,
      why: 'Två bokningar kan inte äga samma nätter. Intern dubbelbokning får aldrig döljas genom kvittering.',
      recommendation: 'Avboka eller ändra den ena bokningen. Varningen kan inte markeras som hanterad.',
      fingerprint: warningFingerprint(booking, WARNING.INTERNAL_BOOKING_CONFLICT, references.join(',')),
      details: { references }
    }));
  }

  if (calendarRows && booking.statusCode === 'CONFIRMED') {
    const nights = nightKeys(booking.arrival, booking.departure);
    const own = new Set(calendarRows
      .filter((row) => row.reference === booking.reference)
      .map((row) => row.night ?? row.RowKey));
    const missing = nights.filter((night) => !own.has(night));
    if (missing.length) {
      warnings.push(createWarning(WARNING.INTERNAL_CALENDAR_MISSING, {
        title: 'Intern kalenderlåsning saknas',
        what: `Bokningen är bekräftad men ${nightsText(missing)} saknar intern kalenderrad.`,
        why: 'Utan kalenderlås kan samma datum bokas igen internt.',
        recommendation: 'Kontrollera bokningen och återställ kalenderlåset. Varningen kan inte markeras som hanterad.',
        fingerprint: warningFingerprint(booking, WARNING.INTERNAL_CALENDAR_MISSING, missing.join(',')),
        details: { nights: missing }
      }));
    }
  }

  if (booking.actionFlags?.conflict) {
    warnings.push(createWarning(WARNING.CALENDAR_FLAG, {
      title: 'Kalenderkonflikt har flaggats',
      what: 'Bokningen är markerad med en kalenderkonflikt.',
      why: 'En flagga på bokningen indikerar att datum kan krocka med annan bokning.',
      recommendation: 'Granska kalendern och åtgärda konflikten. Varningen kan inte markeras som hanterad.',
      fingerprint: warningFingerprint(booking, WARNING.CALENDAR_FLAG, '')
    }));
  }

  if (booking.actionFlags?.overlap || (Array.isArray(booking.overlaps) && booking.overlaps.length)) {
    const overlaps = Array.isArray(booking.overlaps) ? booking.overlaps : [];
    warnings.push(createWarning(WARNING.OVERLAP, {
      title: 'Överlappar annan förfrågan eller bokning',
      what: overlaps.length ? overlaps.join(', ') : 'Bokningen överlappar en annan förfrågan eller bokning.',
      why: 'Överlappande datum kan leda till dubbelbokning om båda bokningarna bekräftas.',
      recommendation: 'Granska båda posterna och avslå eller ändra den ena. Varningen kan inte markeras som hanterad.',
      fingerprint: warningFingerprint(booking, WARNING.OVERLAP, overlaps.join(','))
    }));
  }

  return warnings;
}

function mailWarnings(booking, options = {}) {
  const levels = [
    { key: 'host', kind: 'värdmejl', level: booking.mailStatus?.host },
    { key: 'guest', kind: 'gästmejl', level: booking.mailStatus?.guest }
  ].filter((item) => item.level);
  if (!levels.length) return [];

  const now = options.now instanceof Date ? options.now : new Date();
  const alertMinutes = Number.isFinite(Number(options.unverifiedAlertMinutes))
    ? Math.max(0, Number(options.unverifiedAlertMinutes))
    : MAIL_UNVERIFIED_ALERT_MINUTES;
  const acceptedAgeMinutes = (level) => {
    const reference = Date.parse(String(
      level.acceptedAt || level.lastEventAt || level.updatedAt || level.createdAt || ''
    ));
    // Saknas en trovärdig tid kan färskheten inte styrkas. Då krävs kontroll
    // hellre än att en gammal overifierad leverans döljs.
    if (!Number.isFinite(reference)) return Infinity;
    return (now.getTime() - reference) / 60000;
  };

  const verificationFor = (key) => booking.mailVerification?.[key] ?? null;
  const deliveredViaApi = (key) => verificationFor(key)?.status === 'delivered';
  const failedViaApi = (key) =>
    ['bounced', 'failed', 'complained'].includes(verificationFor(key)?.status);
  const manualFor = (key, level) => mailManuallyVerified(booking, key, level);

  const pending = levels.filter(({ key, level }) =>
    !manualFor(key, level) &&
    (level.pending || level.status === 'Utkorg' || level.status === 'Skickar'));
  const failed = levels.filter(({ key, level }) =>
    level.deliveryFailed ||
    level.status === 'Misslyckad' ||
    level.status === 'Kräver manuell kontroll' ||
    level.deliveryTone === 'danger' ||
    failedViaApi(key)
  );
  const unverified = levels.filter(({ key, level }) =>
    !failed.some((item) => item.level === level) &&
    level.deliveryUnverified &&
    !deliveredViaApi(key) &&
    !manualFor(key, level) &&
    !pending.some((item) => item.level === level) &&
    acceptedAgeMinutes(level) >= alertMinutes
  );

  if (failed.length) {
    const parts = failed.map(({ kind, level }) =>
      `${kind}: ${level.deliveryLabel}${level.deliveryError ? ` (${level.deliveryError})` : ''}`);
    return [createWarning(WARNING.MAIL_FAILED, {
      title: 'Mejlleverans misslyckades',
      what: `Ett eller flera mejl har studsat, misslyckats eller kräver manuell kontroll (${parts.join(', ')}).`,
      why: 'API-acceptans är inte samma sak som leverans. Ett studsat eller misslyckat mejl kan innebära att mottagaren inte fått informationen.',
      recommendation: 'Kontrollera mejlet i Resend och hantera det manuellt. Skicka inte om innan du har kontrollerat att det inte redan levererats.',
      fingerprint: warningFingerprint(booking, WARNING.MAIL_FAILED, parts.join(','))
    })];
  }

  if (pending.length) {
    const parts = pending.map(({ kind, level }) => `${kind}: ${level.apiLabel}`);
    return [createWarning(WARNING.MAIL_PENDING, {
      title: 'Mejl väntar på att skickas',
      what: `Mejlstatus är fortfarande köad eller under behandling (${parts.join(', ')}).`,
      why: 'Utkorgen eller Logic App har inte slutfört utskicket. En gammal status kan också bli kvar om bearbetningen avbröts.',
      recommendation: 'Kontrollera utkorgen och Logic Appens senaste körningar. Skicka inte om ett mejl som redan accepterats av Resend.',
      fingerprint: warningFingerprint(booking, WARNING.MAIL_PENDING, parts.join(','))
    })];
  }

  if (unverified.length) {
    const parts = unverified.map(({ kind, level }) => `${kind}: ${level.deliveryLabel}`);
    return [createWarning(WARNING.MAIL_UNVERIFIED, {
      title: 'Mejl accepterat – leverans ej verifierad',
      what: `Resend har accepterat mejlet men ingen leveranshändelse finns (${parts.join(', ')}).`,
      why: 'API-acceptans är inte samma sak som leverans till mottagarens mejlserver. Slutlig placering i inkorgen kan normalt inte verifieras.',
      recommendation: 'Kontrollera leveransen i Resend eller be mottagaren bekräfta. Aktivera leveranswebhook för automatisk uppföljning när det är godkänt.',
      details: { alertAfterMinutes: alertMinutes },
      fingerprint: warningFingerprint(booking, WARNING.MAIL_UNVERIFIED, parts.join(','))
    })];
  }

  return [];
}

function operationalWarnings(booking, now, options = {}) {
  const warnings = [];
  const today = todayKey(now);
  const created = booking.createdAt ? new Date(booking.createdAt) : null;
  const ageDays = created && Number.isFinite(created.getTime())
    ? Math.floor((now.getTime() - created.getTime()) / DAY)
    : 0;

  if (booking.statusCode === 'PENDING' && ageDays >= 2) {
    warnings.push(createWarning(WARNING.REQUEST_STALE, {
      title: 'Förfrågan väntar på beslut',
      what: `Förfrågan har väntat i ${ageDays} dagar.`,
      why: 'En väntande förfrågan blockerar inga datum och kan bli inaktuell.',
      recommendation: 'Godkänn eller neka förfrågan. Varningen kan inte markeras som hanterad.',
      fingerprint: warningFingerprint(booking, WARNING.REQUEST_STALE, booking.createdAt)
    }));
  }

  warnings.push(...mailWarnings(booking, { ...options, now }));

  if (booking.statusCode === 'CONFIRMED' && booking.addonValidation?.ok === false) {
    const issues = Array.isArray(booking.addonValidation.issues) ? booking.addonValidation.issues : [];
    const summary = issues.map((issue) => issue.message).filter(Boolean).join(' ');
    warnings.push(createWarning(WARNING.ADDON_DATA_CONFLICT, {
      title: 'Tillvalsuppgifterna behöver granskas',
      what: summary || 'Bokningen har tillvalsuppgifter som inte stämmer med sparat prisunderlag eller kalenderbuffertar.',
      why: 'Ett bekräftelsemejl med felaktiga eller saknade tillval får inte skickas automatiskt.',
      recommendation: 'Rätta tillvalsuppgifterna och skicka bekräftelsen först efter kontroll. Varningen kan inte markeras som hanterad.',
      fingerprint: warningFingerprint(booking, WARNING.ADDON_DATA_CONFLICT, issues.map((issue) => issue.code).join(','))
    }));
  }

  if (booking.statusCode === 'RECONCILIATION') {
    warnings.push(createWarning(WARNING.RECONCILIATION, {
      title: 'Betalning kräver avstämning',
      what: booking.reconciliation?.reason || 'En betalning är mottagen men bokningen kunde inte bekräftas säkert.',
      why: 'Stripe-transaktionen är genomförd. Bokningen får inte visas som bekräftad förrän betalning och datumlåsning har stämts av.',
      recommendation: 'Kontrollera Stripe-transaktionen och kalendern. Bekräfta bokningen manuellt eller återbetala betalningen.',
      fingerprint: warningFingerprint(booking, WARNING.RECONCILIATION,
        `${booking.reconciliation?.sessionId ?? ''}|${booking.reconciliation?.at ?? ''}`)
    }));
  }

  if (booking.statusCode === 'CONFIRMED' && booking.paymentStatus === 'UNPAID' &&
      booking.arrival >= today && Number(booking.total) > 0) {
    warnings.push(createWarning(WARNING.PAYMENT_MISSING, {
      title: 'Betalning saknas',
      what: 'Bokningen är bekräftad men ingen betalning är registrerad.',
      why: 'Bekräftade bokningar med framtida ankomst och ett totalpris ska ha en registrerad betalstatus.',
      recommendation: 'Registrera betalning eller ändra betalstatus. Varningen kan inte markeras som hanterad.',
      fingerprint: warningFingerprint(booking, WARNING.PAYMENT_MISSING, `${booking.paymentStatus}|${booking.total}|${booking.arrival}`)
    }));
  }

  if (booking.statusCode === 'CANCELLED' && booking.refundSummary &&
      booking.refundSummary.remainingOre > 0 && booking.refundSummary.calculatedOre > 0) {
    warnings.push(createWarning(WARNING.REFUND_PENDING, {
      title: 'Återbetalning kvarstår',
      what: `Beräknad återbetalning är ${booking.refundSummary.calculatedOre} öre och ${booking.refundSummary.remainingOre} öre återstår att hantera.`,
      why: 'Avbokningspolicyn kan ge kunden rätt till återbetalning. Portalen utför ingen återbetalning automatiskt.',
      recommendation: 'Genomför återbetalningen i Stripe och registrera den sedan under Återbetalning. Varningen kan inte kvitteras.',
      fingerprint: warningFingerprint(booking, WARNING.REFUND_PENDING,
        `${booking.refundSummary.calculatedOre}|${booking.refundSummary.remainingOre}|${booking.statusCode}`)
    }));
  }

  return warnings;
}

function applyAcknowledgements(warnings, booking) {
  const acks = normalizeAcknowledgements(booking);
  if (!acks.length) return warnings;
  return warnings.map((warning) => {
    if (warning.severity === SEVERITY.HANDLED || !warning.dismissible) return warning;
    const ack = latestAck(acks, warning);
    if (!ack) return warning;
    return {
      ...warning,
      severity: SEVERITY.HANDLED,
      acknowledged: true,
      handledBy: ack.actorName || 'Owner',
      handledAt: ack.at,
      handledReason: ack.reason
    };
  });
}

function deriveWarnings(booking = {}, options = {}) {
  const now = options.now ?? new Date();
  const warnings = [
    ...internalWarnings(booking, options),
    ...airbnbWarnings(booking, options),
    ...operationalWarnings(booking, now, options)
  ];
  const seen = new Set();
  const unique = warnings.filter((warning) => {
    if (seen.has(warning.id)) return false;
    seen.add(warning.id);
    return true;
  });
  return applyAcknowledgements(unique, booking);
}

function applyWarnings(booking, options = {}) {
  const warnings = deriveWarnings(booking, options);
  booking.warnings = warnings;
  booking.actionWarnings = warnings.filter((warning) => warning.severity === SEVERITY.ACTION);
  booking.verifyWarnings = warnings.filter((warning) => warning.severity === SEVERITY.VERIFY);
  booking.handledWarnings = warnings.filter((warning) => warning.severity === SEVERITY.HANDLED);
  booking.unresolvedWarnings = warnings.filter((warning) => warning.severity !== SEVERITY.HANDLED);
  booking.actionReasons = booking.unresolvedWarnings.map((warning) => warning.title);
  booking.hasAction = booking.actionReasons.length > 0;
  return booking;
}

function findWarning(warnings, id) {
  return (Array.isArray(warnings) ? warnings : []).find((warning) => warning.id === id) ?? null;
}

module.exports = {
  WARNING,
  SEVERITY,
  POLICIES,
  stayFingerprint,
  warningFingerprint,
  nightKeys,
  normalizeAcknowledgements,
  normalizeVerification,
  deriveWarnings,
  applyWarnings,
  findWarning,
  MAIL_UNVERIFIED_ALERT_MINUTES
};
