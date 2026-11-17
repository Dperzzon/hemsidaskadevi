import { formatSek, ADDONS, addonLines, sumAddons, discountNote, quote, NIGHT_RATES, LINEN_MAX, EXTRAHUS_MAX_GUESTS } from './booking/pricing.js';

// Bokningsflödet: formulär, tillval, prisöversikt, bokningsregler och inskick.
// Formuläret görs synligt när kalendern skickar 'booking:selection' med en
// komplett period. Vid byte av datum uppdateras bara datum, tillgänglighet och
// pris — gästens ifyllda uppgifter och tillval ligger kvar.

const els = {};

const q = (id) => document.getElementById(id);

// Analys är sekundär: ett fel här får aldrig påverka bokningen.
let bookingStartedTracked = false;
function trackAnalytics(name, params) {
  try {
    window.SkadeviAnalytics?.track?.(name, params);
  } catch {
    /* ignoreras */
  }
}

function formatDay(key) {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Europe/Stockholm', day: 'numeric', month: 'long', year: 'numeric'
  }).format(new Date(`${key}T00:00:00Z`));
}

function idempotencyKey() {
  let key = sessionStorage.getItem('booking-idempotency-key');
  if (!key) {
    key = crypto.randomUUID();
    sessionStorage.setItem('booking-idempotency-key', key);
  }
  return key;
}

function resetIdempotencyKey() {
  sessionStorage.removeItem('booking-idempotency-key');
  idempotencyKey();
}

// --- Sammanfattning och prisöversikt ---

function updateSummary({ arrival = null, departure = null, nights = 0 }) {
  const complete = Boolean(arrival && departure && nights > 0);
  els.summaryArrival.textContent = arrival ? formatDay(arrival) : '–';
  els.summaryDeparture.textContent = complete ? formatDay(departure) : '–';
  els.summaryNights.textContent = complete ? `${nights} ${nights === 1 ? 'natt' : 'nätter'}` : '–';
  // Endast ankomst/avresa får ändras vid datumbyte — aldrig gästens uppgifter.
  els.arrival.value = arrival ?? '';
  els.departure.value = complete ? departure : '';
  els.nights.value = complete ? String(nights) : '';
}

function selectedAddons() {
  return {
    slutstad: els.slutstad.checked,
    extrahus: els.extrahus.checked,
    extrahusNights: els.extrahus.checked ? Number(els.extrahusNights.value) : 0,
    extrahusGuests: els.extrahus.checked ? Number(els.extrahusGuests.value) : 0,
    lakan: els.lakan.checked,
    linenCount: els.lakan.checked ? Number(els.linenCount.value) : 0,
    ved: els.ved.checked,
    tidigIncheckning: els.tidigIncheckning.checked,
    senUtcheckning: els.senUtcheckning.checked
  };
}

function updatePrices() {
  const selection = selectedAddons();
  const guests = Number(els.guests.value) || 0;
  // Full prisoffert: boende (nattpriser, högtidspriser, rabatter) + tillval.
  // Servern räknar alltid om priset vid inskick — klientens siffra är en
  // beräknad offert, inte det slutliga priset.
  const q = quote({ arrival: els.arrival.value, departure: els.departure.value, addons: selection, guests });
  if (q.incomplete) {
    // Saknas datum kan inget missvisande totalpris visas.
    els.priceList.innerHTML = '<li class="price-line price-line-empty"><span>Välj ankomst- och avresedatum för prisberäkning</span><span>–</span></li>';
    els.priceTotalRow.hidden = true;
    els.discountNote.hidden = true;
    return;
  }
  const lines = [];
  lines.push(`
    <li class="price-line">
      <span>Boende (${q.nights} ${q.nights === 1 ? 'natt' : 'nätter'})</span>
      <span>${formatSek(q.lodgingBase)}</span>
    </li>`);
  if (q.peakNights > 0) {
    lines.push(`
      <li class="price-line price-line-sub">
        <span>varav ${q.peakNights} ${q.peakNights === 1 ? 'natt' : 'nätter'} med högtidspris (${formatSek(NIGHT_RATES.peak)}/natt)</span>
        <span>${formatSek(q.peakBase)}</span>
      </li>`);
  }
  if (q.discount) {
    lines.push(`
      <li class="price-line price-line-discount">
        <span>${q.discount.label} ${q.discount.percent} %</span>
        <span>&minus; ${formatSek(q.discountAmount)}</span>
      </li>
      <li class="price-line price-line-sub">
        <span>Boendepris efter rabatt</span>
        <span>${formatSek(q.lodgingAfterDiscount)}</span>
      </li>`);
  }
  const addonRows = addonLines({
    ...selection, guests,
    arrival: els.arrival.value,
    departure: els.departure.value
  });
  for (const line of addonRows) {
    lines.push(`
      <li class="price-line${line.request ? ' price-line-request' : ''}">
        <span>${line.label}${line.request ? ' <em>(önskemål — bekräftas av Skadevi)</em>' : ''}</span>
        <span>${formatSek(line.amount)}</span>
      </li>`);
  }
  if (addonRows.length === 0) {
    lines.push('<li class="price-line price-line-empty"><span>Inga tillval valda</span><span>0 kr</span></li>');
  }
  lines.push(`
    <li class="price-line price-line-sub">
      <span>Summa tillval</span>
      <span>${formatSek(q.addonsTotal)}</span>
    </li>`);
  els.priceList.innerHTML = lines.join('');
  els.priceTotal.textContent = formatSek(q.total);
  els.priceTotalRow.hidden = false;
  const note = discountNote(q.nights);
  els.discountNote.textContent = note ?? '';
  els.discountNote.hidden = !note;
}

function totalGuests() {
  const main = Number(els.guests.value) || 0;
  const extrahus = els.extrahus.checked ? Number(els.extrahusGuests.value) || 0 : 0;
  return main + extrahus;
}

function linenLimit() {
  return Math.max(0, Math.min(LINEN_MAX, totalGuests()));
}

function addDays(dateKey, days) {
  return new Date(Date.parse(`${dateKey}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
}

function syncExtrahus({ resetNights = false } = {}) {
  const enabled = els.extrahus.checked;
  els.extrahusNights.disabled = !enabled;
  els.extrahusGuests.disabled = !enabled;
  if (!enabled) {
    els.extrahusDates.hidden = true;
    return;
  }
  const nights = Number(els.nights.value) || 0;
  els.extrahusNights.max = String(Math.max(1, nights));
  let count = Number(els.extrahusNights.value);
  if (resetNights || !Number.isInteger(count) || count < 1 || count > nights) {
    count = nights > 0 ? nights : 1;
    els.extrahusNights.value = String(count);
  }
  let guests = Number(els.extrahusGuests.value);
  if (!Number.isInteger(guests) || guests < 1) guests = 1;
  if (guests > EXTRAHUS_MAX_GUESTS) guests = EXTRAHUS_MAX_GUESTS;
  els.extrahusGuests.value = String(guests);
  const arrival = els.arrival.value;
  if (arrival && count > 0) {
    els.extrahusDates.textContent = `Extrahuset gäller ${count} ${count === 1 ? 'natt' : 'nätter'}: ${formatDay(arrival)} – ${formatDay(addDays(arrival, count))}. Det är de första nätterna av huvudvistelsen.`;
    els.extrahusDates.hidden = false;
  } else {
    els.extrahusDates.hidden = true;
  }
}

function syncLinenCount() {
  const limit = linenLimit();
  els.linenCount.max = String(limit);
  if (!els.lakan.checked) {
    els.linenCount.disabled = true;
    return;
  }
  els.linenCount.disabled = false;
  const current = Number(els.linenCount.value);
  if (!els.linenCount.value || !Number.isFinite(current) || current < 0 || current > limit) {
    els.linenCount.value = String(limit);
  }
  updatePrices();
}

// --- Validering ---

function setError(input, message) {
  const field = input.closest('.booking-field');
  const error = field?.querySelector('.field-error');
  if (message) {
    input.setAttribute('aria-invalid', 'true');
    if (error) error.textContent = message;
    if (field) field.classList.add('has-error');
  } else {
    input.removeAttribute('aria-invalid');
    if (error) error.textContent = '';
    if (field) field.classList.remove('has-error');
  }
}

function validateForm() {
  let firstInvalid = null;
  const check = (input, condition, message) => {
    setError(input, condition ? '' : message);
    if (!condition && !firstInvalid) firstInvalid = input;
  };
  const trimmed = (input) => input.value.trim();
  check(els.firstName, trimmed(els.firstName).length >= 1 && trimmed(els.firstName).length <= 80, 'Ange ditt förnamn.');
  check(els.lastName, trimmed(els.lastName).length >= 1 && trimmed(els.lastName).length <= 80, 'Ange ditt efternamn.');
  check(els.email, /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(trimmed(els.email)), 'Ange en giltig e-postadress.');
  check(els.phone, /^\+?[0-9 ()-]{5,32}$/.test(trimmed(els.phone)), 'Ange ett giltigt telefonnummer.');
  const guests = Number(els.guests.value);
  check(els.guests, Number.isInteger(guests) && guests >= 1 && guests <= 24, 'Ange antal gäster i herrgården (1–24).');
  const nights = Number(els.nights.value);
  if (els.extrahus.checked) {
    const extrahusNights = Number(els.extrahusNights.value);
    check(els.extrahusNights, Number.isInteger(extrahusNights) && extrahusNights >= 1 && extrahusNights <= nights,
      `Ange antal nätter för extrahuset (1–${Math.max(1, nights)}).`);
    const extrahusGuests = Number(els.extrahusGuests.value);
    check(els.extrahusGuests, Number.isInteger(extrahusGuests) && extrahusGuests >= 1 && extrahusGuests <= EXTRAHUS_MAX_GUESTS,
      `Ange antal gäster i extrahuset (1–${EXTRAHUS_MAX_GUESTS}).`);
  } else {
    setError(els.extrahusNights, '');
    setError(els.extrahusGuests, '');
  }
  if (els.lakan.checked) {
    const linen = Number(els.linenCount.value);
    const limit = linenLimit();
    check(els.linenCount, Number.isInteger(linen) && linen >= 0 && linen <= limit,
      `Ange hur många personer som behöver lakan och handdukar (0–${limit}).`);
  } else {
    setError(els.linenCount, '');
  }
  check(els.company, trimmed(els.company).length <= 120, 'Företagsnamnet är för långt.');
  check(els.message, trimmed(els.message).length <= 2000, 'Meddelandet är för långt (högst 2 000 tecken).');
  check(els.consentRules, els.consentRules.checked, 'Du behöver godkänna bokningsreglerna.');
  if (firstInvalid) {
    firstInvalid.focus();
    return false;
  }
  return true;
}

// --- Bokningsregler ---

async function loadRules() {
  try {
    const response = await fetch('/api/booking-rules', { cache: 'no-store' });
    if (!response.ok) throw new Error('rules unavailable');
    const rules = await response.json();
    if (rules.published && typeof rules.text === 'string' && rules.text.trim()) {
      els.rules = rules;
      els.rulesDialogBody.textContent = rules.text;
      els.rulesNotice.hidden = true;
      updateSubmitState();
      els.submitNotice.hidden = true;
    } else {
      disableSubmission('Bokningsreglerna publiceras inom kort. Bokningsförfrågningar kan ännu inte skickas via formuläret — kontakta oss gärna direkt.');
    }
  } catch {
    disableSubmission('Bokningsreglerna kunde inte läsas just nu. Försök ladda om sidan eller kontakta oss direkt.');
  }
}

function disableSubmission(message) {
  els.rules = null;
  els.rulesDialogBody.textContent = '';
  els.rulesNotice.hidden = false;
  updateSubmitState();
  els.submitNotice.textContent = message;
  els.submitNotice.hidden = false;
}

function openRulesDialog(event) {
  if (event) {
    // Klick på länken i etiketten får inte växla kryssrutan.
    event.preventDefault();
    event.stopPropagation();
  }
  els.rulesDialog.showModal();
}

// --- Inskick ---

function selectedPaymentMethod() {
  return els.paymentCard?.checked ? 'card' : 'request';
}

function updateSubmitLabel() {
  if (!els.submit) return;
  els.submit.textContent = selectedPaymentMethod() === 'card'
    ? 'Betala med kort och bekräfta bokningen'
    : 'Skicka bokningsförfrågan';
}

function updateSubmitState() {
  if (!els.submit) return;
  if (els.availabilityChecking) {
    els.submit.disabled = true;
    els.submit.textContent = 'Kontrollerar tillgänglighet …';
    return;
  }
  if (!els.rules) {
    els.submit.disabled = true;
    return;
  }
  els.submit.disabled = false;
  updateSubmitLabel();
}

function availabilityMessage() {
  if (els.extrahus?.checked) {
    return 'Extrahusets tillgänglighet kan inte verifieras automatiskt. Skicka en bokningsförfrågan så bekräftar vi extrahuset manuellt innan bokningen blir giltig.';
  }
  if (els.availabilityChecking) {
    return 'Kontrollerar tillgänglighet …';
  }
  if (!els.directBookingEnabled) {
    return 'Direktbetalning är inte tillgänglig just nu. Skicka gärna en bokningsförfrågan.';
  }
  if (els.directBookingAvailable) {
    return 'Datumen är tillgängliga enligt senaste kalenderkontrollen. Betala med kort för att bekräfta bokningen direkt.';
  }
  const reason = els.directBookingReason;
  if ([
    'AIRBNB_UNAVAILABLE',
    'DIRECT_BOOKING_UNAVAILABLE',
    'INTERNAL_UNAVAILABLE',
    'AUTO_DIRECT_BOOKING_DISABLED',
    'DIRECT_BOOKING_DISABLED'
  ].includes(reason)) {
    return 'Vi kan inte bekräfta tillgängligheten just nu. Skicka gärna en bokningsförfrågan.';
  }
  return 'Datumen är inte tillgängliga. Välj andra datum.';
}

function updatePaymentOptions() {
  const extrahusSelected = els.extrahus?.checked === true;
  const available = els.directBookingEnabled === true && els.directBookingAvailable === true && !extrahusSelected;
  if (els.paymentCardOption) els.paymentCardOption.hidden = !available;
  if (!available && els.paymentCard?.checked) {
    els.paymentRequest.checked = true;
  }
  if (available && !els.paymentCard?.checked && !els.paymentRequest?.checked) {
    els.paymentCard.checked = true;
  }
  if (els.paymentNote) {
    els.paymentNote.textContent = availabilityMessage();
  }
  updateSubmitLabel();
}

let availabilityRequestId = 0;

async function checkDirectBookingAvailability(arrival, departure) {
  const requestId = ++availabilityRequestId;
  if (!els.directBookingEnabled) {
    els.availabilityChecking = false;
    els.directBookingAvailable = false;
    els.directBookingReason = 'DIRECT_BOOKING_DISABLED';
    updatePaymentOptions();
    return;
  }
  els.availabilityChecking = true;
  els.directBookingAvailable = false;
  updatePaymentOptions();
  updateSubmitState();
  try {
    const params = new URLSearchParams({ start: arrival, end: departure });
    const response = await fetch(`/api/direct-booking/availability?${params}`, { cache: 'no-store' });
    const data = await response.json().catch(() => ({}));
    if (requestId !== availabilityRequestId) return;
    els.directBookingAvailable = response.ok && data.directBooking === true;
    els.directBookingReason = data.code || '';
  } catch {
    if (requestId !== availabilityRequestId) return;
    els.directBookingAvailable = false;
    els.directBookingReason = 'UNAVAILABLE';
  } finally {
    if (requestId !== availabilityRequestId) return;
    els.availabilityChecking = false;
    updatePaymentOptions();
    updateSubmitState();
  }
}

function setSending(sending) {
  els.submit.disabled = sending;
  if (sending) {
    els.submit.textContent = selectedPaymentMethod() === 'card' ? 'Startar betalning …' : 'Skickar …';
  } else {
    updateSubmitState();
  }
}

async function loadBookingConfig() {
  try {
    const response = await fetch('/api/booking-config', { cache: 'no-store' });
    if (!response.ok) return;
    const config = await response.json();
    els.directBookingEnabled = config.directBookingEnabled === true;
    els.directBookingAvailable = false;
    updatePaymentOptions();
    if (els.arrival.value && els.departure.value) {
      checkDirectBookingAvailability(els.arrival.value, els.departure.value);
    }
  } catch {
    // Utan konfiguration visas endast det säkra förfrågningsflödet.
    els.directBookingEnabled = false;
    els.directBookingAvailable = false;
    updatePaymentOptions();
  }
}

function buildPayload() {
  return {
    arrival: els.arrival.value,
    departure: els.departure.value,
    firstName: els.firstName.value.trim(),
    lastName: els.lastName.value.trim(),
    email: els.email.value.trim(),
    phone: els.phone.value.trim(),
    guests: Number(els.guests.value),
    company: els.company.value.trim(),
    message: els.message.value.trim(),
    addons: selectedAddons(),
    // Info till servern — servern beräknar alltid om och ignorerar belopp.
    totalAddons: sumAddons(addonLines({
      ...selectedAddons(),
      guests: Number(els.guests.value) || 0,
      arrival: els.arrival.value,
      departure: els.departure.value
    })),
    rulesVersion: els.rules?.version ?? '',
    consentRules: els.consentRules.checked,
    consentContact: els.consentContact.checked
  };
}

function applyFieldErrors(fields) {
  const fieldMap = {
    arrival: els.arrival, departure: els.departure,
    firstName: els.firstName, lastName: els.lastName,
    email: els.email, phone: els.phone, guests: els.guests,
    extrahusNights: els.extrahusNights, extrahusGuests: els.extrahusGuests,
    linenCount: els.linenCount, consentRules: els.consentRules
  };
  let first = null;
  for (const [name, message] of Object.entries(fields)) {
    const input = fieldMap[name];
    if (input) {
      setError(input, message);
      if (!first) first = input;
    }
  }
  if (first) first.focus();
}

async function submitBooking(event) {
  event.preventDefault();
  if (els.submit.disabled) return;
  if (!validateForm()) return;
  els.formError.hidden = true;
  if (els.manualReview) els.manualReview.hidden = true;
  const payload = buildPayload();
  if (selectedPaymentMethod() === 'card') {
    await submitDirectBooking(payload);
  } else {
    await submitRequest(payload);
  }
}

async function submitRequest(payload) {
  setSending(true);
  try {
    const response = await fetch('/api/booking-requests', {
      method: 'POST',
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey() },
      body: JSON.stringify(payload)
    });
    const data = await response.json().catch(() => ({}));
    if (response.ok && data.reference) {
      trackAnalytics('booking_request_submitted', {
        booking_nights: Number(els.nights?.value) || undefined,
        booking_type: 'request'
      });
      showConfirmation(data);
      resetIdempotencyKey();
      return;
    }
    if (response.status === 409) {
      showFormError(data.error || 'Några av de valda nätterna är inte längre tillgängliga. Vänligen välj andra datum i kalendern.');
      document.dispatchEvent(new CustomEvent('booking:invalidate'));
      return;
    }
    if (response.status === 400 && data.fields) {
      applyFieldErrors(data.fields);
      showFormError(data.error || 'Kontrollera uppgifterna i formuläret.');
      return;
    }
    showFormError(data.error || 'Förfrågan kunde inte skickas just nu. Vänligen försök igen om en stund eller kontakta oss direkt.');
  } catch {
    showFormError('Något gick fel när förfrågan skickades. Kontrollera din internetanslutning och försök igen.');
  } finally {
    setSending(false);
  }
}

async function submitDirectBooking(payload) {
  setSending(true);
  try {
    const response = await fetch('/api/direct-booking', {
      method: 'POST',
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey() },
      body: JSON.stringify(payload)
    });
    const data = await response.json().catch(() => ({}));
    if (response.ok && data.checkoutUrl) {
      trackAnalytics('begin_checkout', {
        value: Number(data.totalOre) > 0 ? Number(data.totalOre) / 100 : undefined,
        currency: 'SEK',
        payment_method: 'card'
      });
      window.location.assign(data.checkoutUrl);
      return;
    }
    if (data.manualReview) {
      if (els.manualReview) {
        els.manualReview.textContent = data.error ||
          'Vi behöver kontrollera tillgängligheten manuellt. Skicka gärna en bokningsförfrågan.';
        els.manualReview.hidden = false;
        els.manualReview.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }
      return;
    }
    if (response.status === 409) {
      if (data.retryable) resetIdempotencyKey();
      showFormError(data.error || 'Några av de valda nätterna är inte längre tillgängliga. Välj andra datum i kalendern.');
      document.dispatchEvent(new CustomEvent('booking:invalidate'));
      return;
    }
    if (response.status === 400 && data.fields) {
      applyFieldErrors(data.fields);
      showFormError(data.error || 'Kontrollera uppgifterna i formuläret.');
      return;
    }
    showFormError(data.error || 'Betalningen kunde inte startas just nu. Försök igen eller skicka en bokningsförfrågan.');
  } catch {
    showFormError('Något gick fel när betalningen skulle startas. Kontrollera din internetanslutning och försök igen.');
  } finally {
    setSending(false);
  }
}

function showFormError(message) {
  els.formError.textContent = message;
  els.formError.hidden = false;
  els.formError.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function showConfirmation(data) {
  els.form.hidden = true;
  els.summary.hidden = true;
  els.confirmation.hidden = false;
  els.confirmationReference.textContent = data.reference;
  els.confirmation.focus();
}

function handleSelection(detail) {
  const { arrival = null, departure = null, nights = 0 } = detail ?? {};
  const complete = Boolean(arrival && departure && nights > 0);
  const wasOpen = !els.section.hidden && !els.form.hidden;
  const previousArrival = els.arrival.value;
  const previousDeparture = els.departure.value;
  updateSummary({ arrival, departure, nights });
  syncExtrahus();
  els.formError.hidden = true;
  if (els.manualReview) els.manualReview.hidden = true;
  if (complete && (arrival !== previousArrival || departure !== previousDeparture)) {
    resetIdempotencyKey();
    if (!bookingStartedTracked) {
      bookingStartedTracked = true;
      trackAnalytics('booking_started', { booking_nights: nights });
    }
  }

  if (!complete) {
    // Ett påbörjat datumval får aldrig visa kvarvarande totalpris för den
    // tidigare perioden. Formuläret (och alla ifyllda uppgifter) ligger kvar
    // öppet om det redan var öppet — bara datum och pris nollställs.
    els.directBookingAvailable = false;
    updatePaymentOptions();
    if (!wasOpen) return;
    updatePrices();
    return;
  }

  els.section.hidden = false;
  els.confirmation.hidden = true;
  els.form.hidden = false;
  els.summary.hidden = false;
  updatePrices();
  checkDirectBookingAvailability(arrival, departure);

  if (!wasOpen) {
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    els.section.scrollIntoView({ behavior: reducedMotion ? 'auto' : 'smooth', block: 'start' });
    els.heading.focus({ preventScroll: true });
  }
}

function changeDates() {
  els.section.hidden = true;
  els.directBookingAvailable = false;
  updatePaymentOptions();
  resetIdempotencyKey();
  document.dispatchEvent(new CustomEvent('booking:invalidate'));
  const calendar = document.querySelector('.calendar-section');
  calendar?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  document.querySelector('.cal-selection')?.setAttribute('tabindex', '-1');
  document.querySelector('.cal-selection')?.focus({ preventScroll: true });
}

function queryAll() {
  return {
    section: q('booking-section'),
    heading: q('booking-title'),
    summary: q('booking-summary'),
    summaryArrival: q('summary-arrival'),
    summaryDeparture: q('summary-departure'),
    summaryNights: q('summary-nights'),
    form: q('booking-form'),
    arrival: q('field-arrival'),
    departure: q('field-departure'),
    nights: q('field-nights'),
    firstName: q('field-firstname'),
    lastName: q('field-lastname'),
    email: q('field-email'),
    phone: q('field-phone'),
    guests: q('field-guests'),
    company: q('field-company'),
    message: q('field-message'),
    slutstad: q('addon-slutstad'),
    extrahus: q('addon-extrahus'),
    extrahusNights: q('extrahus-nights'),
    extrahusGuests: q('extrahus-guests'),
    extrahusDates: q('extrahus-dates'),
    lakan: q('addon-lakan'),
    linenCount: q('linen-count'),
    ved: q('addon-ved'),
    tidigIncheckning: q('addon-tidig-incheckning'),
    senUtcheckning: q('addon-sen-utcheckning'),
    priceList: q('price-list'),
    priceTotal: q('price-total'),
    priceTotalRow: q('price-total-row'),
    discountNote: q('discount-note'),
    consentRules: q('consent-rules'),
    consentContact: q('consent-contact'),
    paymentRequest: q('payment-request'),
    paymentCard: q('payment-card'),
    paymentCardOption: q('payment-card-option'),
    paymentNote: q('payment-note'),
    manualReview: q('manual-review'),
    submit: q('booking-submit'),
    submitNotice: q('submit-notice'),
    formError: q('form-error'),
    confirmation: q('booking-confirmation'),
    confirmationReference: q('confirmation-reference'),
    rulesDialog: q('booking-rules-dialog'),
    rulesDialogBody: q('rules-dialog-body'),
    rulesNotice: q('rules-dialog-notice')
  };
}

function init() {
  Object.assign(els, queryAll());
  if (!els.section) return;
  els.linenCount.max = String(linenLimit());
  syncExtrahus();
  els.form.addEventListener('submit', submitBooking);
  document.addEventListener('booking:selection', (event) => handleSelection(event.detail));
  document.addEventListener('booking:invalidate', () => {
    setSelectionPlaceholder();
  });
  q('booking-change-dates')?.addEventListener('click', changeDates);
  for (const addon of ADDONS) {
    const checkbox = els[addon.id];
    checkbox?.addEventListener('change', () => {
      if (addon.perPerson) syncLinenCount();
      if (addon.perNight) {
        syncExtrahus({ resetNights: els.extrahus.checked });
        updatePaymentOptions();
      }
      updatePrices();
    });
  }
  els.guests.addEventListener('change', () => {
    const limit = linenLimit();
    els.linenCount.max = String(limit);
    if (!els.lakan.checked) return;
    if (!els.linenCount.dataset.userSet || Number(els.linenCount.value) > limit) {
      els.linenCount.value = String(limit);
    }
    updatePrices();
  });
  els.linenCount.addEventListener('input', () => {
    els.linenCount.dataset.userSet = 'true';
    const limit = linenLimit();
    const current = Number(els.linenCount.value);
    if (els.linenCount.value !== '' && Number.isFinite(current) && current > limit) {
      els.linenCount.value = String(limit);
    }
    updatePrices();
  });
  els.extrahusNights.addEventListener('input', () => {
    syncExtrahus();
    updatePrices();
  });
  els.extrahusGuests.addEventListener('input', () => {
    syncExtrahus();
    syncLinenCount();
  });
  els.consentRules.addEventListener('change', () => {
    if (els.consentRules.checked) {
      setError(els.consentRules, '');
      if (els.rules) els.consentRules.dataset.rulesVersion = els.rules.version;
    }
  });
  q('open-rules')?.addEventListener('click', openRulesDialog, false);
  // Klick på "bokningsregler" i etiketttexten: hindra kryssrutans växling.
  q('open-rules-label')?.addEventListener('click', openRulesDialog, false);
  q('close-rules')?.addEventListener('click', () => els.rulesDialog.close());
  for (const radio of [els.paymentRequest, els.paymentCard]) {
    radio?.addEventListener('change', () => {
      els.formError.hidden = true;
      if (els.manualReview) els.manualReview.hidden = true;
      resetIdempotencyKey();
      updateSubmitLabel();
    });
  }
  loadRules();
  loadBookingConfig();
}

function setSelectionPlaceholder() {
  els.formError.hidden = true;
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
