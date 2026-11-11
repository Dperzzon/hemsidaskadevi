'use strict';

const {
  escapeHtml,
  formatDateKey,
  formatDateRange,
  formatDateTime,
  formatMoney
} = require('../domain');
const {
  statusBadge,
  emailBadge,
  deliveryBadge,
  actionChips,
  preparedButton,
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
  return `<div class="price-summary">
    <div class="price-row"><span>Boendepris före rabatt</span><strong>${escapeHtml(formatMoney(booking.lodgingBase))}</strong></div>
    ${discount}
    <div class="price-row"><span>Boendepris efter rabatt</span><strong>${escapeHtml(formatMoney(booking.lodgingAfterDiscount))}</strong></div>
    <div class="price-row"><span>Summa tillval</span><strong>${escapeHtml(formatMoney(booking.totalAddons))}</strong></div>
    <div class="price-row price-total"><span>Totalpris</span><strong>${escapeHtml(formatMoney(booking.total))}</strong></div>
    <p class="price-note">Priser från bokningstillfället${booking.priceVersion ? ` (version ${escapeHtml(booking.priceVersion)})` : ''}. Räknas inte om med dagens prisregler.</p>
  </div>`;
}

function renderBookingDetail(options) {
  const { booking, principal, demo, csrfToken } = options;
  const content = `
    <div class="detail-header">
      <a class="back-link" href="/admin/bookings">← Alla bokningar</a>
      ${pageHeader(booking.reference, `${booking.guestName} · ${formatDateRange(booking.arrival, booking.departure)}`, statusBadge(booking))}
      <div class="detail-meta">
        <span>Källa: ${escapeHtml(booking.bookingSourceLabel)}</span>
        <span>Skapad: ${formatDateTime(booking.createdAt)}</span>
        <span>Uppdaterad: ${formatDateTime(booking.updatedAt)}</span>
        ${booking.isDemo ? '<span class="demo-tag">Syntetisk demo</span>' : ''}
      </div>
    </div>

    ${booking.actionReasons.length ? `<div class="attention-banner"><strong>Kräver åtgärd</strong>${actionChips(booking)}</div>` : ''}

    <div class="detail-layout">
      <div class="detail-main">
        <section class="panel">
          <div class="panel-heading"><div><p class="eyebrow">Gäst</p><h2>Kontaktuppgifter</h2></div></div>
          <div class="fact-grid">
            ${fact('Namn', escapeHtml(booking.guestName))}
            ${fact('E-post', `<a class="text-link" href="mailto:${escapeHtml(booking.email)}">${escapeHtml(booking.email || '—')}</a>`)}
            ${fact('Telefon', `<a class="text-link" href="tel:${escapeHtml(booking.phone.replaceAll(' ', ''))}">${escapeHtml(booking.phone || '—')}</a>`)}
            ${fact('Företag', escapeHtml(booking.company || '—'))}
          </div>
        </section>

        <section class="panel">
          <div class="panel-heading"><div><p class="eyebrow">Vistelse</p><h2>Datum och sällskap</h2></div></div>
          <div class="fact-grid">
            ${fact('Ankomst', `<time datetime="${escapeHtml(booking.arrival)}">${escapeHtml(formatDateKey(booking.arrival, { long: true }))}</time>`)}
            ${fact('Avresa', `<time datetime="${escapeHtml(booking.departure)}">${escapeHtml(formatDateKey(booking.departure, { long: true }))}</time>`)}
            ${fact('Antal nätter', String(booking.nights))}
            ${fact('Antal gäster', String(booking.guests))}
          </div>
        </section>

        <section class="panel">
          <div class="panel-heading"><div><p class="eyebrow">Pris</p><h2>Tillval och totalsumma</h2></div><span class="snapshot-pill">Sparat prissnapshot</span></div>
          ${addonTable(booking)}
          ${priceSummary(booking)}
        </section>

        <section class="panel">
          <div class="panel-heading"><div><p class="eyebrow">Gästen skrev</p><h2>Särskilda önskemål</h2></div></div>
          ${booking.message
            ? `<p class="prose">${escapeHtml(booking.message)}</p>`
            : '<p class="muted">Inget meddelande från gästen.</p>'}
        </section>

        <section class="panel">
          <div class="panel-heading"><div><p class="eyebrow">Internt</p><h2>Administrativa anteckningar</h2></div></div>
          ${booking.latestNote
            ? `<p class="prose note-text">${escapeHtml(booking.latestNote)}</p>`
            : '<p class="muted">Inga administrativa anteckningar ännu.</p>'}
          <label class="field field-note">
            <span>Ny anteckning (förberedd – inte aktiv)</span>
            <textarea rows="3" placeholder="Anteckningen sparas först när skrivstödet aktiveras." disabled></textarea>
          </label>
          <div class="button-row">${preparedButton('Spara anteckning', 'note', 'secondary', 'Förberedd – anteckningar är avstängda')}</div>
        </section>
      </div>

      <aside class="detail-side">
        <section class="panel action-panel">
          <div class="panel-heading"><div><p class="eyebrow">Bokning</p><h2>Åtgärder</h2></div></div>
          <p class="muted">Knapparna är förberedda men inte kopplade till skarpa ändringar i denna version.</p>
          <div class="button-stack">
            ${preparedButton('Godkänn (preliminär)', 'approve', 'primary', 'Förberedd – ingen statusändring görs')}
            ${preparedButton('Bekräfta bokning', 'confirm', 'primary', 'Kräver ägarbehörighet – förberedd', 'Owner')}
            ${preparedButton('Neka', 'decline', 'ghost', 'Förberedd – ingen statusändring görs')}
            ${preparedButton('Ändra status', 'status', 'secondary', 'Kräver ägarbehörighet – förberedd', 'Owner')}
          </div>
          <p class="notice">Ingen åtgärd skickar mejl eller ändrar en riktig bokning.</p>
        </section>

        <section class="panel">
          <div class="panel-heading"><div><p class="eyebrow">Ekonomi</p><h2>Betalning</h2></div></div>
          <div class="payment-summary">
            <div class="price-row"><span>Status</span><strong>${escapeHtml(booking.paymentLabel)}</strong></div>
            <div class="price-row"><span>Totalt</span><strong>${escapeHtml(formatMoney(booking.total))}</strong></div>
            <div class="price-row"><span>Betalt</span><strong>${escapeHtml(formatMoney(booking.amountPaid))}</strong></div>
            <div class="price-row"><span>Kvar</span><strong>${escapeHtml(formatMoney(booking.balance))}</strong></div>
          </div>
          <p class="price-note">Manuellt underlag. Betalintegration byggs inte i denna version.</p>
          ${preparedButton('Registrera betalning', 'payment', 'secondary', 'Kräver ägarbehörighet – förberedd', 'Owner')}
        </section>

        <section class="panel">
          <div class="panel-heading"><div><p class="eyebrow">Kommunikation</p><h2>Mejlstatus</h2></div></div>
          ${emailRow('Värdmejl', booking.mailStatus.host)}
          ${emailRow('Gästmejl', booking.mailStatus.guest)}
          <p class="price-note">”Accepterat av Resend” är API-acceptans, inte samma sak som leverans.</p>
          <div class="button-row">${preparedButton('Skicka om mejl', 'resend', 'secondary', 'Förberedd – inget mejl skickas')}</div>
        </section>

        <section class="panel">
          <div class="panel-heading"><div><p class="eyebrow">Status</p><h2>Bokningsstatus</h2></div></div>
          <p class="status-large">${statusBadge(booking)}</p>
          <p class="muted">${escapeHtml(booking.statusLabel)}</p>
          <p class="price-note">Alla framtida ändringar kräver explicit åtgärd och loggas med användare och tid.</p>
        </section>
      </aside>
    </div>
  `;
  return layout({ title: booking.reference, active: '/admin/bookings', principal, demo, csrfToken, content });
}

module.exports = { renderBookingDetail };
