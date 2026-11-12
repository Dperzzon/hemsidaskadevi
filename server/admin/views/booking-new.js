'use strict';

const { escapeHtml, formatDateKey, SOURCE_LABELS, PAYMENT_LABELS } = require('../domain');
const { pageHeader } = require('./components');
const { layout } = require('./layout');

function option(value, label, selected) {
  return `<option value="${escapeHtml(value)}"${value === selected ? ' selected' : ''}>${escapeHtml(label)}</option>`;
}

const SOURCE_ORDER = ['PHONE', 'EMAIL', 'AIRBNB', 'DIRECT', 'OTHER'];
const STATUS_ORDER = [
  ['CONFIRMED', 'Bekräftad (låser datum)'],
  ['PRELIMINARY', 'Preliminär (låser inte datum)'],
  ['PENDING', 'Inväntar godkännande (låser inte datum)']
];
const PAYMENT_ORDER = ['UNPAID', 'DEPOSIT_PAID', 'PARTIALLY_PAID', 'PAID', 'REFUNDED', 'VOID'];

function renderNewBooking(options) {
  const { principal, demo, csrfToken, writesEnabled } = options;
  const today = formatDateKey(new Date().toISOString().slice(0, 10), { long: true });
  const content = `
    ${pageHeader('Ny bokning', 'Registrera en manuell bokning eller blockera datum utan gästuppgifter')}
    <div class="notice-banner">
      <strong>Endast Owner.</strong> Manuella bokningar och datumblockeringar kräver ägarbehörighet.
      Inga mejl skickas till gästen i detta steg. Bekräftade bokningar låser datum direkt.
    </div>

    <form class="panel admin-booking-form" data-admin-form="manual-booking">
      <section class="form-section">
        <div class="panel-heading"><div><p class="eyebrow">Typ</p><h2>Vad ska registreras?</h2></div></div>
        <div class="radio-row">
          <label class="check-row"><input type="radio" name="mode" value="booking" checked> <span>Manuell bokning</span></label>
          <label class="check-row"><input type="radio" name="mode" value="block"> <span>Ren datumblockering</span></label>
        </div>
      </section>

      <section class="form-section" data-booking-only>
        <div class="panel-heading"><div><p class="eyebrow">Gäst</p><h2>Kontaktuppgifter</h2></div></div>
        <div class="form-grid">
          <label class="field"><span>Förnamn *</span><input type="text" name="firstName" maxlength="80" autocomplete="off"></label>
          <label class="field"><span>Efternamn *</span><input type="text" name="lastName" maxlength="80" autocomplete="off"></label>
          <label class="field"><span>E-post *</span><input type="email" name="email" maxlength="120" autocomplete="off"></label>
          <label class="field"><span>Telefon *</span><input type="tel" name="phone" maxlength="32" autocomplete="off"></label>
          <label class="field"><span>Företag</span><input type="text" name="company" maxlength="120" autocomplete="off"></label>
        </div>
      </section>

      <section class="form-section">
        <div class="panel-heading"><div><p class="eyebrow">Vistelse</p><h2>Datum och gäster</h2></div></div>
        <div class="form-grid">
          <label class="field"><span>Incheckning *</span><input type="date" name="arrival" required></label>
          <label class="field"><span>Utcheckning *</span><input type="date" name="departure" required></label>
          <label class="field" data-booking-only><span>Antal gäster *</span><input type="number" name="guests" min="1" max="24" value="2"></label>
          <label class="field" data-booking-only><span>Bokningskälla *</span>
            <select name="bookingSource">${SOURCE_ORDER.map((source) => option(source, SOURCE_LABELS[source], 'PHONE')).join('')}</select>
          </label>
        </div>
        <p class="price-note">Portalens prisregler används för beräkning. Servern räknar alltid om priset vid skapandet. Dagens datum: ${escapeHtml(today)}.</p>
      </section>

      <section class="form-section" data-booking-only>
        <div class="panel-heading"><div><p class="eyebrow">Tillval</p><h2>Alla befintliga tillval</h2></div></div>
        <div class="addon-editor">
          <label class="check-row"><input type="checkbox" name="slutstad"> <span>Slutstädning</span></label>
          <label class="check-row"><input type="checkbox" name="lakan"> <span>Lakan och handdukar</span></label>
          <label class="field field-inline"><span>Antal lakan</span><input type="number" name="linenCount" min="0" max="24" value="0"></label>
          <label class="check-row"><input type="checkbox" name="ved"> <span>Ved</span></label>
          <label class="check-row"><input type="checkbox" name="tidigIncheckning"> <span>Tidig incheckning</span></label>
          <label class="check-row"><input type="checkbox" name="senUtcheckning"> <span>Sen utcheckning</span></label>
        </div>
      </section>

      <section class="form-section" data-booking-only>
        <div class="panel-heading"><div><p class="eyebrow">Pris och betalning</p><h2>Avtalat pris</h2></div></div>
        <div class="form-grid">
          <label class="field"><span>Avtalat totalpris (kr, valfritt)</span><input type="number" name="agreedTotal" min="0" step="1" placeholder="Lämna tomt för ordinarie pris"></label>
          <label class="field"><span>Ändringsorsak vid avtalat pris *</span><input type="text" name="priceAdjustmentReason" maxlength="500" placeholder="Obligatorisk om avtalat pris anges"></label>
          <label class="field"><span>Betalstatus</span><select name="paymentStatus">${PAYMENT_ORDER.map((status) => option(status, PAYMENT_LABELS[status], 'UNPAID')).join('')}</select></label>
          <label class="field"><span>Belopp mottaget (kr)</span><input type="number" name="amountPaid" min="0" step="1" value="0"></label>
          <label class="field"><span>Status vid skapande</span><select name="statusCode">${STATUS_ORDER.map(([value, label]) => option(value, label, 'CONFIRMED')).join('')}</select></label>
        </div>
      </section>

      <section class="form-section">
        <div class="panel-heading"><div><p class="eyebrow">Internt</p><h2>Anteckning</h2></div></div>
        <label class="field"><span>Intern anteckning / orsak till blockering</span><textarea name="latestNote" rows="3" maxlength="2000"></textarea></label>
        <label class="check-row" data-booking-only><input type="checkbox" name="sendGuestEmail" disabled> <span>Skicka bekräftelsemejl till gästen (avstängt i detta steg)</span></label>
      </section>

      <div class="form-actions">
        <button class="btn btn-primary" type="submit">Skapa</button>
        <a class="btn btn-ghost" href="/admin/bookings">Avbryt</a>
        <p class="form-error" data-form-error hidden></p>
      </div>
      <p class="price-note">Bekräftade manuella bokningar kontrolleras mot interna bokningar, manuella block och Airbnb-kalendern innan datum låses. Airbnb iCal är fördröjd och är inte en realtidssynkronisering.</p>
    </form>
  `;
  return layout({ title: 'Ny bokning', active: '/admin/bookings/new', principal, demo, csrfToken, writesEnabled, content });
}

module.exports = { renderNewBooking };
