'use strict';

const {
  escapeHtml,
  formatDateKey,
  formatDateRange,
  formatDateTime,
  formatMoney,
  PAYMENT_LABELS
} = require('../domain');
const {
  statusBadge,
  emailBadge,
  deliveryBadge,
  actionChips,
  actionButton,
  historyList,
  pageHeader
} = require('./components');
const { layout } = require('./layout');

function fact(label, value) {
  return `<div class="fact"><span>${escapeHtml(label)}</span><strong>${value}</strong></div>`;
}

function emailRow(label, level) {
  const review = level.needsReview
    ? `<p class="inline-warning">Kräver manuell kontroll</p>`
    : '';
  return `<div class="email-row">
    <div><p class="card-kicker">${escapeHtml(label)}</p>
      <div class="badge-row">${emailBadge(level)}${deliveryBadge(level)}</div>
      ${review}
    </div>
    <div class="email-id">${level.resendId
      ? `<span>Resend-ID</span><code>${escapeHtml(level.resendId)}</code>`
      : '<span class="muted">Inget Resend-ID</span>'}</div>
  </div>`;
}

function addonTable(booking) {
  if (!booking.addonLines.length) {
    return '<p class="muted">Inga tillval registrerade i prissnapshotet.</p>';
  }
  return `<div class="table-wrap"><table class="data-table compact">
    <thead><tr><th>Tillval</th><th>Antal</th><th>Styckpris</th><th>Summa</th></tr></thead>
    <tbody>${booking.addonLines.map((line) => `<tr>
      <td data-label="Tillval">${escapeHtml(line.label)}</td>
      <td data-label="Antal">${line.quantity}</td>
      <td data-label="Styckpris">${escapeHtml(formatMoney(line.unitPrice))}</td>
      <td data-label="Summa">${escapeHtml(formatMoney(line.amount))}</td>
    </tr>`).join('')}</tbody>
  </table></div>`;
}

function priceSummary(booking) {
  const discount = booking.discountAmount > 0
    ? `<div class="price-row"><span>${escapeHtml(booking.discountLabel || 'Rabatt')}${booking.discountPercent ? ` (${booking.discountPercent} %)` : ''}</span><strong>− ${escapeHtml(formatMoney(booking.discountAmount))}</strong></div>`
    : '';
  const agreed = booking.agreedTotal !== null && booking.agreedTotal !== undefined
    ? `<div class="price-row price-adjustment"><span>Avtalat pris (orsak: ${escapeHtml(booking.priceAdjustmentReason || 'saknas')})</span><strong>${escapeHtml(formatMoney(booking.agreedTotal))}</strong></div>
       <p class="price-note">Serverberäknat pris vid skapandet: ${escapeHtml(formatMoney(booking.calculatedTotal))}.</p>`
    : '';
  return `<div class="price-summary">
    <div class="price-row"><span>Boendepris före rabatt</span><strong>${escapeHtml(formatMoney(booking.lodgingBase))}</strong></div>
    ${discount}
    <div class="price-row"><span>Boendepris efter rabatt</span><strong>${escapeHtml(formatMoney(booking.lodgingAfterDiscount))}</strong></div>
    <div class="price-row"><span>Summa tillval</span><strong>${escapeHtml(formatMoney(booking.totalAddons))}</strong></div>
    <div class="price-row price-total"><span>Totalpris</span><strong>${escapeHtml(formatMoney(booking.total))}</strong></div>
    ${agreed}
    <p class="price-note">Priser från bokningstillfället${booking.priceVersion ? ` (version ${escapeHtml(booking.priceVersion)})` : ''}. Räknas inte om vid visning.</p>
  </div>`;
}

function addonEditor(booking) {
  const addons = booking.addons ?? {};
  const row = (id, label, checked) => `<label class="check-row"><input type="checkbox" name="${id}"${checked ? ' checked' : ''}> <span>${escapeHtml(label)}</span></label>`;
  return `<div class="addon-editor">
    ${row('slutstad', 'Slutstädning', addons.slutstad)}
    ${row('lakan', 'Lakan och handdukar', addons.lakan)}
    <label class="field field-inline"><span>Antal lakan</span><input type="number" min="0" max="${booking.guests}" name="linenCount" value="${escapeHtml(String(addons.linenCount ?? 0))}"></label>
    ${row('ved', 'Ved', addons.ved)}
    ${row('tidigIncheckning', 'Tidig incheckning', addons.tidigIncheckning)}
    ${row('senUtcheckning', 'Sen utcheckning', addons.senUtcheckning)}
  </div>`;
}

function paymentOptions(current) {
  return Object.entries(PAYMENT_LABELS).map(([value, label]) =>
    `<option value="${escapeHtml(value)}"${value === current ? ' selected' : ''}>${escapeHtml(label)}</option>`
  ).join('');
}

function statusActions(booking) {
  if (booking.isBlock) {
    return `<div class="button-stack">
      <button type="button" class="btn btn-danger" data-block-remove="${escapeHtml(booking.reference)}" data-etag="${escapeHtml(booking.etag)}">Avblockera datum</button>
    </div><p class="notice">Avblockering tar bort alla kalenderrader för blockeringen och loggas.</p>`;
  }
  const buttons = [];
  if (booking.statusCode === 'PENDING') {
    buttons.push(actionButton('Godkänn som preliminär', 'approve', booking, 'primary'));
  }
  if (['PENDING', 'PRELIMINARY'].includes(booking.statusCode)) {
    buttons.push(actionButton('Bekräfta bokning', 'confirm', booking, 'primary', { requiresOwner: true }));
    buttons.push(actionButton('Neka', 'decline', booking, 'ghost', {
      prompt: 'Orsak till nekande', requiresReason: true
    }));
  }
  if (booking.statusCode === 'CONFIRMED') {
    buttons.push(actionButton('Avboka', 'cancel', booking, 'danger', {
      prompt: 'Orsak till avbokning', requiresReason: true, requiresOwner: true
    }));
  }
  if (!buttons.length) return '<p class="muted">Ingen statusåtgärd tillgänglig för nuvarande status.</p>';
  return `<div class="button-stack">${buttons.join('')}</div>
    <label class="check-row muted"><input type="checkbox" id="send-confirmation-email" disabled> Skicka bekräftelsemejl till gästen</label>
    <p class="notice">E-postutskick är avstängt i detta steg. En bekräftelse skiljs från kvittensen på mottagen förfrågan.</p>`;
}

function renderBookingDetail(options) {
  const { booking, principal, demo, csrfToken, writesEnabled, history = [] } = options;
  const isOwner = principal.roles?.includes('Owner');
  const content = `
    <div class="detail-header">
      <a class="back-link" href="/admin/bookings">← Alla bokningar</a>
      ${pageHeader(booking.reference, `${booking.guestName} · ${formatDateRange(booking.arrival, booking.departure)}`, statusBadge(booking))}
      <div class="detail-meta">
        <span>Källa: ${escapeHtml(booking.bookingSourceLabel)}</span>
        <span>Skapad: ${formatDateTime(booking.createdAt)}</span>
        <span>Uppdaterad: ${formatDateTime(booking.updatedAt)}</span>
        <span>Version: ${booking.version}</span>
        ${booking.isDemo ? '<span class="demo-tag">Syntetisk demo</span>' : ''}
      </div>
    </div>

    ${booking.actionReasons.length ? `<div class="attention-banner"><strong>Kräver åtgärd</strong>${actionChips(booking)}</div>` : ''}
    ${booking.airbnbOverride ? `<div class="notice-banner">
      <strong>Airbnb-blockering åsidosatt.</strong> ${escapeHtml(booking.airbnbOverrideReason || 'Motivering saknas')} ·
      Godkänd av ${escapeHtml(booking.airbnbOverrideApprovedBy || 'okänd')} ${formatDateTime(booking.airbnbOverrideApprovedAt)}.
      ${booking.airbnbBlockedNights.length ? `Upptagna nätter: ${escapeHtml(booking.airbnbBlockedNights.join(', '))}.` : ''}
    </div>` : ''}

    <div class="detail-layout">
      <div class="detail-main">
        ${booking.isBlock ? `<section class="panel">
          <div class="panel-heading"><div><p class="eyebrow">Kalender</p><h2>Datumblockering</h2></div></div>
          <div class="fact-grid">
            ${fact('Från', escapeHtml(formatDateKey(booking.arrival, { long: true })))}
            ${fact('Till', escapeHtml(formatDateKey(booking.departure, { long: true })))}
            ${fact('Nätter', String(booking.nights))}
            ${fact('Orsak', escapeHtml(booking.latestNote || 'Ingen angiven'))}
          </div>
        </section>` : `<section class="panel">
          <div class="panel-heading"><div><p class="eyebrow">Gäst</p><h2>Kontaktuppgifter</h2></div></div>
          <div class="fact-grid">
            ${fact('Namn', escapeHtml(booking.guestName))}
            ${fact('E-post', `<a class="text-link" href="mailto:${escapeHtml(booking.email)}">${escapeHtml(booking.email || '—')}</a>`)}
            ${fact('Telefon', `<a class="text-link" href="tel:${escapeHtml(booking.phone.replaceAll(' ', ''))}">${escapeHtml(booking.phone || '—')}</a>`)}
            ${fact('Företag', escapeHtml(booking.company || '—'))}
          </div>
        </section>`}

        <section class="panel">
          <div class="panel-heading"><div><p class="eyebrow">Vistelse</p><h2>Datum och sällskap</h2></div></div>
          <div class="fact-grid">
            ${fact('Ankomst', `<time datetime="${escapeHtml(booking.arrival)}">${escapeHtml(formatDateKey(booking.arrival, { long: true }))}</time>`)}
            ${fact('Avresa', `<time datetime="${escapeHtml(booking.departure)}">${escapeHtml(formatDateKey(booking.departure, { long: true }))}</time>`)}
            ${fact('Antal nätter', String(booking.nights))}
            ${fact('Antal gäster', String(booking.guests))}
          </div>
        </section>

        ${booking.isBlock ? '' : `<section class="panel">
          <div class="panel-heading"><div><p class="eyebrow">Pris</p><h2>Tillval och totalsumma</h2></div><span class="snapshot-pill">Sparat prissnapshot</span></div>
          ${addonTable(booking)}
          ${priceSummary(booking)}
        </section>`}

        ${booking.message ? `<section class="panel">
          <div class="panel-heading"><div><p class="eyebrow">Gästen skrev</p><h2>Särskilda önskemål</h2></div></div>
          <p class="prose">${escapeHtml(booking.message)}</p>
        </section>` : ''}

        <section class="panel">
          <div class="panel-heading"><div><p class="eyebrow">Internt</p><h2>Administrativa anteckningar</h2></div></div>
          ${booking.latestNote
            ? `<p class="prose note-text">${escapeHtml(booking.latestNote)}</p>`
            : '<p class="muted">Inga administrativa anteckningar ännu.</p>'}
          <form data-admin-form="note" data-reference="${escapeHtml(booking.reference)}" data-etag="${escapeHtml(booking.etag)}">
            <label class="field field-note">
              <span>Ny anteckning</span>
              <textarea name="note" rows="3" maxlength="2000" required placeholder="Skriv en intern anteckning"></textarea>
            </label>
            <div class="button-row"><button class="btn btn-secondary" type="submit">Spara anteckning</button></div>
          </form>
        </section>

        ${booking.isBlock ? '' : `<section class="panel">
          <div class="panel-heading"><div><p class="eyebrow">Pris</p><h2>Uppdatera tillval</h2></div></div>
          <form data-admin-form="addons" data-reference="${escapeHtml(booking.reference)}" data-etag="${escapeHtml(booking.etag)}">
            ${addonEditor(booking)}
            <label class="field"><span>Ändringsorsak (obligatorisk)</span><input type="text" name="reason" maxlength="500" required></label>
            <div class="button-row"><button class="btn btn-secondary" type="submit">Spara tillval och ny prisberäkning</button></div>
            <p class="price-note">Originalpriset bevaras i en separat prissnapshot. Priset räknas bara om vid denna uttryckliga ändring.</p>
          </form>
        </section>`}

        <section class="panel">
          <div class="panel-heading"><div><p class="eyebrow">Historik</p><h2>Auditlogg</h2></div></div>
          ${historyList(history)}
        </section>
      </div>

      <aside class="detail-side">
        <section class="panel action-panel">
          <div class="panel-heading"><div><p class="eyebrow">Bokning</p><h2>Åtgärder</h2></div></div>
          ${isOwner
            ? statusActions(booking)
            : '<p class="notice">Endast Owner kan ändra status, pris, betalning och blockeringar i denna version.</p>'}
        </section>

        ${booking.isBlock ? '' : `<section class="panel">
          <div class="panel-heading"><div><p class="eyebrow">Ekonomi</p><h2>Betalning</h2></div></div>
          <div class="payment-summary">
            <div class="price-row"><span>Status</span><strong>${escapeHtml(booking.paymentLabel)}</strong></div>
            <div class="price-row"><span>Totalt</span><strong>${escapeHtml(formatMoney(booking.total))}</strong></div>
            <div class="price-row"><span>Betalt</span><strong>${escapeHtml(formatMoney(booking.amountPaid))}</strong></div>
            <div class="price-row"><span>Kvar</span><strong>${escapeHtml(formatMoney(booking.balance))}</strong></div>
          </div>
          <form data-admin-form="payment" data-reference="${escapeHtml(booking.reference)}" data-etag="${escapeHtml(booking.etag)}">
            <label class="field"><span>Betalstatus</span><select name="paymentStatus">${paymentOptions(booking.paymentStatus)}</select></label>
            <label class="field"><span>Belopp mottaget (kr)</span><input type="number" name="amountPaid" min="0" step="1" value="${escapeHtml(String(booking.amountPaid))}"></label>
            <label class="field"><span>Orsak / kommentar</span><input type="text" name="reason" maxlength="500"></label>
            <div class="button-row"><button class="btn btn-secondary" type="submit">Registrera betalstatus</button></div>
          </form>
        </section>`}

        <section class="panel">
          <div class="panel-heading"><div><p class="eyebrow">Kommunikation</p><h2>Mejlstatus</h2></div></div>
          ${emailRow('Värdmejl', booking.mailStatus.host)}
          ${emailRow('Gästmejl', booking.mailStatus.guest)}
          <p class="price-note">”Accepterat av Resend” är API-acceptans, inte samma sak som leverans. Inga mejl skickas i detta utvecklingssteg.</p>
        </section>

        <section class="panel">
          <div class="panel-heading"><div><p class="eyebrow">Status</p><h2>Bokningsstatus</h2></div></div>
          <p class="status-large">${statusBadge(booking)}</p>
          <p class="muted">${escapeHtml(booking.statusLabel)}</p>
          <p class="price-note">Bekräftade bokningar och manuella block låser datum. Förfrågningar och preliminära bokningar blockerar inte.</p>
        </section>
      </aside>
    </div>
  `;
  return layout({ title: booking.reference, active: '/admin/bookings', principal, demo, csrfToken, writesEnabled, content });
}

module.exports = { renderBookingDetail };
