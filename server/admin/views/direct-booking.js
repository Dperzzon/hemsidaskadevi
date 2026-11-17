'use strict';

const { layout } = require('./layout');
const {
  pageHeader,
  statusBadge,
  bookingLink,
  stayCell,
  amountCell,
  emptyState
} = require('./components');
const {
  escapeHtml,
  formatDateKey,
  formatDateTime
} = require('../domain');

function approvalRows(approvals) {
  if (!approvals.length) {
    return `<tr><td colspan="5">${emptyState('Ingen historik', 'Inga tidigare manuella direktbokningsgodkännanden finns.')}</td></tr>`;
  }
  return approvals.map((approval) => `<tr>
    <td><strong>${escapeHtml(formatDateKey(approval.from))} – ${escapeHtml(formatDateKey(approval.to))}</strong>
      <div class="muted">${approval.nights.length} nätter</div></td>
    <td>${escapeHtml(approval.approvedBy || '—')}<div class="muted">${escapeHtml(formatDateTime(approval.approvedAt))}</div></td>
    <td>${escapeHtml(approval.note || '—')}</td>
    <td><span class="badge ${approval.status === 'OPEN' ? 'badge-confirmed' : 'badge-cancelled'}">${approval.status === 'OPEN' ? 'Öppen' : 'Stängd'}</span></td>
    <td>${approval.closedAt ? `${escapeHtml(approval.closedBy || '—')}<div class="muted">${escapeHtml(formatDateTime(approval.closedAt))}</div>` : '—'}</td>
  </tr>`).join('');
}

function bookingRows(bookings, emptyTitle, emptyText, extra = () => '', extra2 = null) {
  const colspan = extra2 ? 6 : 5;
  if (!bookings.length) {
    return `<tr><td colspan="${colspan}">${emptyState(emptyTitle, emptyText)}</td></tr>`;
  }
  return bookings.map((booking) => `<tr>
    <td>${bookingLink(booking)}</td>
    <td>${stayCell(booking)}</td>
    <td>${amountCell(booking)}</td>
    <td>${statusBadge(booking)}</td>
    <td>${extra(booking)}</td>
    ${extra2 ? `<td>${extra2(booking)}</td>` : ''}
  </tr>`).join('');
}

function renderDirectBooking({ data, principal, demo, csrfToken, writesEnabled }) {
  const isOwner = principal.roles?.includes('Owner');
  const canWrite = isOwner && writesEnabled;
  const automaticEnabled = data.automaticEnabled === true;
  const approvals = data.approvals ?? [];
  const reservations = data.reservations ?? [];
  const confirmed = data.confirmed ?? [];
  const reconciliation = data.reconciliation ?? [];

  const toggleForm = canWrite
    ? `<form class="inline-form" data-admin-form="direct-booking-toggle">
        <input type="hidden" name="enabled" value="${automaticEnabled ? '0' : '1'}">
        <input type="text" name="note" maxlength="500" placeholder="Orsak (frivillig)">
        <button type="submit" class="btn ${automaticEnabled ? 'btn-danger' : 'btn-primary'}">
          ${automaticEnabled ? 'Stäng av automatisk direktbokning' : 'Slå på automatisk direktbokning'}
        </button>
        <p class="form-error" data-form-error hidden></p>
      </form>`
    : `<p class="muted">${isOwner
      ? 'Skrivfunktioner är inte aktiverade i denna miljö.'
      : 'Endast Owner kan slå av eller på automatisk direktbokning. Du har läsbehörighet.'}</p>`;

  const content = `
    ${pageHeader('Direktbokning', 'Automatisk kortbetalning för lediga datum')}
    <div class="metric-grid">
      <article class="metric"><p class="metric-label">Automatisk direktbokning</p><p class="metric-value">${automaticEnabled ? 'På' : 'Av'}</p><p class="metric-detail">${automaticEnabled ? 'lediga datum kan bokas med kort' : 'endast bokningsförfrågan'}</p></article>
      <article class="metric"><p class="metric-label">Aktiva reservationer</p><p class="metric-value">${reservations.length}</p><p class="metric-detail">väntar på betalning</p></article>
      <article class="metric"><p class="metric-label">Bekräftade direktbokningar</p><p class="metric-value">${confirmed.length}</p><p class="metric-detail">betalda via Stripe</p></article>
      <article class="metric"><p class="metric-label">Avstämning</p><p class="metric-value">${reconciliation.length}</p><p class="metric-detail">kräver Owner-åtgärd</p></article>
    </div>

    <section class="panel">
      <h2>Automatisk direktbokning</h2>
      <p>Alla datum som är lediga i den interna kalendern och i senast hämtade Airbnb-kalender kan erbjudas
      för direktbetalning. Owner behöver inte längre blockera och öppna datum manuellt.</p>
      <p><strong>Status:</strong> ${automaticEnabled ? 'På' : 'Av'}${data.setting?.updatedAt
        ? ` · senast ändrad av ${escapeHtml(data.setting.updatedBy || '—')} ${escapeHtml(formatDateTime(data.setting.updatedAt))}`
        : ''}</p>
      ${data.setting?.note ? `<p class="muted">Anteckning: ${escapeHtml(data.setting.note)}</p>` : ''}
      ${toggleForm}
    </section>

    <section class="panel">
      <h2>Airbnb-synkroniseringens begränsning</h2>
      <p>Airbnb iCal är inte en realtidskälla och kan vara fördröjd. Ett färskt iCal-svar garanterar
      inte Airbnbs tillgänglighet i realtid. Systemet hämtar iCal inför varje Checkout-försök och stoppar
      direktbetalning om kalendern inte kan läsas, om en natt är upptagen eller om tillgängligheten är osäker.</p>
      <p>Den kvarstående risken är att en extern Airbnb-bokning kan ske på en natt som iCal ännu inte har
      uppdaterat. Om kalenderintegrationen visar problem kan du stänga av automatisk direktbokning ovan.</p>
      <p><a class="btn btn-outline" href="/admin/calendar">Till kalendern för manuella datumblockeringar</a></p>
    </section>

    <section class="panel">
      <h2>Aktiva betalningsreservationer</h2>
      <div class="table-wrap"><table class="data-table">
        <thead><tr><th>Referens</th><th>Vistelse</th><th>Belopp</th><th>Status</th><th>Reservation</th></tr></thead>
        <tbody>${bookingRows(reservations, 'Inga aktiva reservationer', 'Inga gäster väntar på betalning just nu.', (booking) =>
          escapeHtml(booking.reservation?.expiresAt ? `Giltig till ${formatDateTime(booking.reservation.expiresAt)}` : '—'))}</tbody>
      </table></div>
    </section>

    <section class="panel">
      <h2>Bekräftade direktbokningar</h2>
      <div class="table-wrap"><table class="data-table">
        <thead><tr><th>Referens</th><th>Vistelse</th><th>Belopp</th><th>Status</th><th>Stripe</th><th>Godkännande</th></tr></thead>
        <tbody>${bookingRows(confirmed, 'Inga bekräftade direktbokningar', 'Inga direktbokningar har bekräftats ännu.', (booking) =>
          escapeHtml(booking.stripeSessionId || '—'), (booking) =>
          escapeHtml(booking.directBookingApprovalId || '—'))}</tbody>
      </table></div>
    </section>

    <section class="panel">
      <h2>Avstämningsärenden</h2>
      <div class="table-wrap"><table class="data-table">
        <thead><tr><th>Referens</th><th>Vistelse</th><th>Belopp</th><th>Status</th><th>Orsak</th></tr></thead>
        <tbody>${bookingRows(reconciliation, 'Inga avstämningsärenden', 'Inga betalningar kräver manuell avstämning.', (booking) =>
          escapeHtml(booking.reconciliation?.reason || '—'))}</tbody>
      </table></div>
    </section>

    <section class="panel">
      <h2>Historik: tidigare manuella godkännanden</h2>
      <p class="muted">Dessa godkännanden krävs inte längre för direktbokning. Historiken bevaras för spårbarhet
      och påverkar inte automatisk direktbokning.</p>
      <div class="table-wrap"><table class="data-table">
        <thead><tr><th>Datum</th><th>Godkänd av</th><th>Underlag</th><th>Status</th><th>Stängd av</th></tr></thead>
        <tbody>${approvalRows(approvals)}</tbody>
      </table></div>
    </section>
  `;

  return layout({
    title: 'Direktbokning',
    active: '/admin/direct-booking',
    principal,
    demo,
    csrfToken,
    writesEnabled,
    content
  });
}

module.exports = { renderDirectBooking };
