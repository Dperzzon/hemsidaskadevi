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

function approvalRows(approvals, canWrite) {
  if (!approvals.length) {
    return `<tr><td colspan="6">${emptyState('Inga datum öppna', 'Alla datum är stängda för direktbokning.')}</td></tr>`;
  }
  return approvals.map((approval) => {
    const open = approval.status === 'OPEN';
    const closeForm = canWrite && open
      ? `<form class="inline-form" data-admin-form="direct-booking-close" data-approval-id="${escapeHtml(approval.approvalId)}">
          <input type="text" name="note" maxlength="200" placeholder="Orsak (frivillig)">
          <button type="submit" class="btn btn-small btn-danger">Stäng</button>
          <p class="form-error" data-form-error hidden></p>
        </form>`
      : '';
    return `<tr>
      <td><strong>${escapeHtml(formatDateKey(approval.from))} – ${escapeHtml(formatDateKey(approval.to))}</strong>
        <div class="muted">${approval.nights.length} nätter</div></td>
      <td>${escapeHtml(approval.approvedBy || '—')}<div class="muted">${escapeHtml(formatDateTime(approval.approvedAt))}</div></td>
      <td>${escapeHtml(approval.note || '—')}</td>
      <td><span class="badge ${open ? 'badge-confirmed' : 'badge-cancelled'}">${open ? 'Öppen' : 'Stängd'}</span></td>
      <td>${open ? '—' : `${escapeHtml(approval.closedBy || '—')}<div class="muted">${escapeHtml(formatDateTime(approval.closedAt))}</div>`}</td>
      <td>${closeForm}</td>
    </tr>`;
  }).join('');
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
  const approvals = data.approvals ?? [];
  const openApprovals = approvals.filter((approval) => approval.status === 'OPEN');
  const closedApprovals = approvals.filter((approval) => approval.status !== 'OPEN');
  const reservations = data.reservations ?? [];
  const confirmed = data.confirmed ?? [];
  const reconciliation = data.reconciliation ?? [];

  const openForm = canWrite
    ? `<form class="panel" data-admin-form="direct-booking-open">
        <h2>Öppna datum för direktbokning</h2>
        <p class="muted">Alla datum är stängda som standard. Ett intervall får bara öppnas när du har blockerat
        datumen i Airbnb för att reserveras åt hemsidan och bekräftar att det inte finns någon Airbnb-gästbokning
        eller annan extern bokning. Systemet kontrollerar att Airbnb iCal visar samtliga nätter som blockerade.</p>
        <div class="form-grid">
          <label>Från<input type="date" name="from" required></label>
          <label>Till<input type="date" name="to" required></label>
        </div>
        <label>Anteckning / underlag<textarea name="note" maxlength="1000" rows="3"
          placeholder="T.ex. Airbnb-blockering skapad 2026-11-17, ingen extern bokning."></textarea></label>
        <fieldset class="check-list">
          <legend>Bekräftelser</legend>
          <label><input type="checkbox" name="confirmAirbnbBlocked" required>
            Datumen är blockerade i Airbnb för att reserveras åt hemsidan.</label>
          <label><input type="checkbox" name="confirmNoAirbnbGuest" required>
            Det finns ingen Airbnb-gästbokning för dessa datum.</label>
          <label><input type="checkbox" name="confirmNoExternal" required>
            Det finns ingen annan extern bokning för dessa datum.</label>
          <label><input type="checkbox" name="confirmMayOffer" required>
            Datumen får erbjudas för direktbetalning på hemsidan.</label>
        </fieldset>
        <p class="form-error" data-form-error hidden></p>
        <button type="submit" class="btn btn-primary">Öppna för direktbokning</button>
      </form>`
    : `<div class="panel"><h2>Öppna datum för direktbokning</h2>
        <p class="muted">${isOwner
          ? 'Skrivfunktioner är inte aktiverade i denna miljö.'
          : 'Endast Owner kan öppna eller stänga datum för direktbokning. Du har läsbehörighet.'}</p></div>`;

  const content = `
    ${pageHeader('Direktbokning', 'Owner-styrda datum för kortbetalning på hemsidan')}
    <div class="metric-grid">
      <article class="metric"><p class="metric-label">Öppna datum</p><p class="metric-value">${openApprovals.length}</p><p class="metric-detail">godkända intervall</p></article>
      <article class="metric"><p class="metric-label">Aktiva reservationer</p><p class="metric-value">${reservations.length}</p><p class="metric-detail">väntar på betalning</p></article>
      <article class="metric"><p class="metric-label">Bekräftade direktbokningar</p><p class="metric-value">${confirmed.length}</p><p class="metric-detail">betalda via Stripe</p></article>
      <article class="metric"><p class="metric-label">Avstämning</p><p class="metric-value">${reconciliation.length}</p><p class="metric-detail">kräver Owner-åtgärd</p></article>
    </div>
    ${openForm}
    <section class="panel">
      <h2>Öppna godkännanden</h2>
      <div class="table-wrap"><table class="data-table">
        <thead><tr><th>Datum</th><th>Godkänd av</th><th>Underlag</th><th>Status</th><th>Stängd av</th><th>Åtgärd</th></tr></thead>
        <tbody>${approvalRows(openApprovals, canWrite)}</tbody>
      </table></div>
    </section>
    <section class="panel">
      <h2>Stängda godkännanden</h2>
      <div class="table-wrap"><table class="data-table">
        <thead><tr><th>Datum</th><th>Godkänd av</th><th>Underlag</th><th>Status</th><th>Stängd av</th><th>Åtgärd</th></tr></thead>
        <tbody>${approvalRows(closedApprovals, canWrite)}</tbody>
      </table></div>
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
    <p class="muted">Direktbokning ändrar aldrig Airbnb automatiskt. En Airbnb-blockering i iCal är ett underlag,
    inte ett kvitto på att bokningen är gjord i Airbnb. Owners godkännande och auditloggen bevaras.</p>
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
