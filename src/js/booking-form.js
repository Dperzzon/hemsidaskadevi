import { formatSek, ADDONS, addonLines, sumAddons } from './booking/pricing.js';

// Bokningsflödet: formulär, tillval, prisöversikt, bokningsregler och inskick.
// Formuläret görs synligt när kalendern skickar 'booking:dates'.

const els = {};

const q = (id) => document.getElementById(id);

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

function updateSummary({ arrival, departure, nights }) {
  els.summaryArrival.textContent = formatDay(arrival);
  els.summaryDeparture.textContent = formatDay(departure);
  els.summaryNights.textContent = `${nights} ${nights === 1 ? 'natt' : 'nätter'}`;
  els.arrival.value = arrival;
  els.departure.value = departure;
  els.nights.value = String(nights);
}

function selectedAddons() {
  return {
    slutstad: els.slutstad.checked,
    lakan: els.lakan.checked,
    linenCount: els.lakan.checked ? Number(els.linenCount.value) : 0,
    ved: els.ved.checked,
    tidigIncheckning: els.tidigIncheckning.checked,
    senUtcheckning: els.senUtcheckning.checked
  };
}

function updatePrices() {
  const lines = addonLines(selectedAddons());
  const total = sumAddons(lines);
  els.priceList.innerHTML = lines.map((line) => `
    <li class="price-line${line.request ? ' price-line-request' : ''}">
      <span>${line.label}${line.request ? ' <em>(önskemål — bekräftas av Skadevi)</em>' : ''}</span>
      <span>${formatSek(line.amount)}</span>
    </li>`).join('') ||
    '<li class="price-line price-line-empty"><span>Inga tillval valda</span><span>0 kr</span></li>';
  els.priceTotal.textContent = formatSek(total);
  els.priceTotalRow.hidden = lines.length === 0;
}

function syncLinenCount() {
  if (!els.lakan.checked) {
    els.linenCount.disabled = true;
    return;
  }
  els.linenCount.disabled = false;
  if (!els.linenCount.value || Number(els.linenCount.value) < 1) {
    els.linenCount.value = els.guests.value || '1';
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
  check(els.guests, Number.isInteger(guests) && guests >= 1 && guests <= 24, 'Ange antal gäster (1–24).');
  if (els.lakan.checked) {
    const linen = Number(els.linenCount.value);
    check(els.linenCount, Number.isInteger(linen) && linen >= 1 && linen <= 40, 'Ange hur många personer som behöver lakan och handdukar.');
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
      els.submit.disabled = false;
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
  els.submit.disabled = true;
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

function setSending(sending) {
  els.submit.disabled = sending;
  els.submit.textContent = sending ? 'Skickar …' : 'Skicka bokningsförfrågan';
}

async function submitBooking(event) {
  event.preventDefault();
  if (els.submit.disabled) return;
  if (!validateForm()) return;
  setSending(true);
  els.formError.hidden = true;
  const payload = {
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
    totalAddons: sumAddons(addonLines(selectedAddons())),
    rulesVersion: els.rules?.version ?? '',
    consentRules: els.consentRules.checked,
    consentContact: els.consentContact.checked
  };
  try {
    const response = await fetch('/api/booking-requests', {
      method: 'POST',
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey() },
      body: JSON.stringify(payload)
    });
    const data = await response.json().catch(() => ({}));
    if (response.ok && data.reference) {
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
      const fieldMap = {
        arrival: els.arrival, departure: els.departure,
        firstName: els.firstName, lastName: els.lastName,
        email: els.email, phone: els.phone, guests: els.guests,
        linenCount: els.linenCount, consentRules: els.consentRules
      };
      let first = null;
      for (const [name, message] of Object.entries(data.fields)) {
        const input = fieldMap[name];
        if (input) {
          setError(input, message);
          if (!first) first = input;
        }
      }
      if (first) first.focus();
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

function openForm(detail) {
  updateSummary(detail);
  els.section.hidden = false;
  els.confirmation.hidden = true;
  els.form.hidden = false;
  els.summary.hidden = false;
  updatePrices();
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  els.section.scrollIntoView({ behavior: reducedMotion ? 'auto' : 'smooth', block: 'start' });
  els.heading.focus({ preventScroll: true });
}

function changeDates() {
  els.section.hidden = true;
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
    lakan: q('addon-lakan'),
    linenCount: q('linen-count'),
    ved: q('addon-ved'),
    tidigIncheckning: q('addon-tidig-incheckning'),
    senUtcheckning: q('addon-sen-utcheckning'),
    priceList: q('price-list'),
    priceTotal: q('price-total'),
    priceTotalRow: q('price-total-row'),
    consentRules: q('consent-rules'),
    consentContact: q('consent-contact'),
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
  els.form.addEventListener('submit', submitBooking);
  document.addEventListener('booking:dates', (event) => openForm(event.detail));
  document.addEventListener('booking:invalidate', () => {
    setSelectionPlaceholder();
  });
  q('booking-change-dates')?.addEventListener('click', changeDates);
  for (const addon of ADDONS) {
    const checkbox = els[addon.id];
    checkbox?.addEventListener('change', () => {
      if (addon.perPerson) syncLinenCount();
      updatePrices();
    });
  }
  els.guests.addEventListener('change', () => {
    if (els.lakan.checked && !els.linenCount.dataset.userSet) {
      els.linenCount.value = els.guests.value;
      updatePrices();
    }
  });
  els.linenCount.addEventListener('input', () => {
    els.linenCount.dataset.userSet = 'true';
    updatePrices();
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
  loadRules();
}

function setSelectionPlaceholder() {
  els.formError.hidden = true;
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
