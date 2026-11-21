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

const SYNC_ERROR_LABELS = {
  NOT_CONFIGURED: 'Kalenderadress saknas',
  CONFIG_INVALID: 'Kalenderadressen är ogiltig',
  FETCH_TIMEOUT: 'Timeout vid hämtning',
  FETCH_FAILED: 'Nätverksfel vid hämtning',
  EMPTY_RESPONSE: 'Tomt svar från kalendern',
  INVALID_CONTENT_TYPE: 'Svaret var inte en kalenderfil',
  INVALID_FORMAT: 'Filen är inte en giltig iCal-kalender',
  PARSE_ERROR: 'Kalendern kunde inte tolkas',
  RESPONSE_TOO_LARGE: 'Kalenderfilen var för stor',
  REDIRECT_INVALID: 'Ogiltig omdirigering',
  REDIRECT_UNTRUSTED: 'Omdirigering till otillåtet mål',
  CALENDAR_EMPTY: 'Kalendern är tom trots tidigare bokningar',
  CALENDAR_DROP: 'Onormalt stor minskning av bokningar',
  CALENDAR_RANGE_EMPTY: 'Tidigare blockeringar saknas i intervallet',
  CALENDAR_INCONSISTENT: 'Innehållet ändrades utan att ETag/Last-Modified ändrades',
  CALENDAR_STALE: 'Kalendern returnerar en äldre version',
  CALENDAR_SUSPECT: 'Kalendern kunde inte verifieras',
  CALENDAR_STATUS_UNAVAILABLE: 'Kalenderns säkerhetsstatus kunde inte läsas',
  CALENDAR_CHECK_FAILED: 'Kalenderkontrollen misslyckades'
};

const RESERVATION_REASON_LABELS = {
  orphan: 'Saknar bokning i databasen',
  missing_reference: 'Saknar referens',
  lookup_failed: 'Kunde inte slås upp',
  expired: 'Har gått ut',
  missing_expiry: 'Saknar giltighetstid och är för gammal',
  in_flight: 'Pågående bokning',
  confirmed_but_not_converted: 'Bekräftad men inte omvandlad till BOOKING',
  status_cancelled: 'Avbokad',
  status_declined: 'Avvisad',
  status_expired: 'Utgången',
  status_failed: 'Misslyckad betalning',
  reconciliation: 'Avstämning krävs',
  pending_with_booking_rows: 'Väntande betalning med bokningsrader',
  status_reconciliation: 'Avstämning krävs',
  status_unknown: 'Okänd status – blockeras av säkerhetsskäl',
  reservation_released: 'Reservationen är frigjord',
  reservation_expired: 'Reservationen har gått ut',
  reservation_failed: 'Reservationen misslyckades',
  reservation_cancelled: 'Reservationen är avbokad',
  active_without_expiry: 'Aktiv utan giltighetstid',
  active: 'Aktiv'
};

function syncErrorLabel(code) {
  if (!code) return '';
  if (SYNC_ERROR_LABELS[code]) return SYNC_ERROR_LABELS[code];
  if (/^HTTP_\d{3}$/.test(code)) return `Kalendern svarade HTTP ${code.slice(5)}`;
  return 'Kalenderfel';
}

function syncLevel(status) {
  if (!status) return 'unknown';
  if (status.safetyStatus === 'suspect') return 'error';
  if (status.lastErrorCode) {
    return Number(status.consecutiveFailures ?? 0) >= 3 || !status.lastSuccessAt ? 'error' : 'warning';
  }
  return 'ok';
}

function syncBadge(level) {
  if (level === 'ok') return '<span class="badge badge-confirmed">Fungerar</span>';
  if (level === 'warning') return '<span class="badge badge-warning">Varning</span>';
  if (level === 'error') return '<span class="badge badge-danger">Fel</span>';
  return '<span class="badge badge-neutral">Okänd</span>';
}

function syncStatusPanel(status) {
  const level = syncLevel(status);
  const conflicts = Array.isArray(status?.conflicts) ? status.conflicts : [];
  const conflictText = conflicts.length
    ? `${conflicts.length} natt(er): ${conflicts.slice(0, 12).join(', ')}${conflicts.length > 12 ? ' …' : ''}`
    : 'Inga upptäckta konflikter';
  return `<section class="panel">
    <h2>Kalenderstatus – Airbnb-import</h2>
    <p><strong>Status:</strong> ${syncBadge(level)}</p>
    <ul class="muted">
      <li>Senaste lyckade hämtning: ${escapeHtml(formatDateTime(status?.lastSuccessAt))}</li>
      <li>Senaste kontrollförsök: ${escapeHtml(formatDateTime(status?.lastCheckAt))}</li>
      <li>Senaste fel: ${status?.lastErrorCode
        ? `${escapeHtml(syncErrorLabel(status.lastErrorCode))} (${escapeHtml(formatDateTime(status.lastErrorAt))})`
        : '—'}</li>
      <li>Misslyckade försök i följd: ${escapeHtml(String(status?.consecutiveFailures ?? 0))}</li>
      <li>Säkerhetsläge: ${status?.safetyStatus === 'suspect'
        ? '<strong>Misstänkt – manuell granskning krävs</strong>'
        : 'Verifierad'}</li>
      <li>Kontrollerat intervall: ${status?.checkedFrom
        ? `${escapeHtml(formatDateKey(status.checkedFrom))} – ${escapeHtml(formatDateKey(status.checkedTo))}`
        : '—'}</li>
      <li>Upptäckta konflikter: ${escapeHtml(conflictText)}</li>
    </ul>
    <p class="muted">Statusen bygger på en exporterad iCal-fil, inte realtidsdata. Även en lyckad hämtning kan
    vara fördröjd hos Airbnb. Vid fel eller osäkerhet stoppas alltid direktbetalning för berörda datum.</p>
  </section>`;
}

function calendarSafetyPanel(status, canWrite) {
  if (status?.safetyStatus !== 'suspect') return '';
  const empty = Number(status.suspectedEventCount ?? 0) <= 0;
  const nights = Array.isArray(status.suspectedSnapshotNights) ? status.suspectedSnapshotNights : [];
  const form = canWrite
    ? `<form class="inline-form" data-admin-form="calendar-safety-approve">
        <input type="text" name="note" maxlength="1000" placeholder="Underlag för godkännandet (obligatoriskt vid tom kalender)">
        ${empty ? `<label class="checkbox"><input type="checkbox" name="confirmEmpty" value="1"> Jag har verifierat att Airbnb-kalendern verkligen är tom och godkänner den som ny baslinje.</label>` : ''}
        <button type="submit" class="btn btn-primary">Godkänn kalenderbilden</button>
        <p class="form-error" data-form-error hidden></p>
      </form>`
    : '<p class="muted">Endast Owner kan godkänna en misstänkt kalenderbild.</p>';
  return `<section class="panel" style="border-left:4px solid #b33;">
    <h2>Kalendersäkerhet – manuell granskning krävs</h2>
    <p><strong>Orsak:</strong> ${escapeHtml(syncErrorLabel(status.safetyReason || status.lastErrorCode))}</p>
    <ul class="muted">
      <li>Sedd sedan: ${escapeHtml(formatDateTime(status.safetySince))}</li>
      <li>Misstänkt kalenderbild: ${escapeHtml(String(status.suspectedEventCount ?? 0))} aktiva event, ${nights.length} blockerade nätter</li>
      <li>Kontrollerat intervall: ${status.suspectedSnapshotFrom
        ? `${escapeHtml(formatDateKey(status.suspectedSnapshotFrom))} – ${escapeHtml(formatDateKey(status.suspectedSnapshotTo))}`
        : '—'}</li>
    </ul>
    <p>Direktbetalning är stoppad för berörda datum tills kalenderbilden har granskats. Godkänn bara om du har verifierat att den nya bilden är korrekt i Airbnb. En tom kalender kräver särskild bekräftelse.</p>
    ${form}
  </section>`;
}

function reservationIssuesPanel(data) {
  const issues = data.reservationIssues ?? [];
  const total = Number(data.reservationIssueCount ?? issues.length);
  if (!issues.length) {
    return `<section class="panel">
      <h2>Kalenderavvikelser</h2>
      <p class="muted">Inga misstänkta kalenderrader hittades.</p>
    </section>`;
  }
  const rows = issues.map((issue) => `<tr>
    <td><strong>${escapeHtml(issue.reference || '—')}</strong></td>
    <td>${escapeHtml(RESERVATION_REASON_LABELS[issue.reason] || issue.reason)}</td>
    <td>${escapeHtml(String(issue.statusCode || '—'))}</td>
    <td>${issue.active === true
      ? '<span class="badge badge-warning">Blockerar fortfarande</span>'
      : '<span class="badge badge-danger">Exporteras inte</span>'}</td>
    <td>${escapeHtml((issue.nights ?? []).join(', ') || '—')}</td>
  </tr>`).join('');
  return `<section class="panel" style="border-left:4px solid #c9a96e;">
    <h2>Kalenderavvikelser</h2>
    <p>${total} avvikelse(r) hittades. Inaktiva rader exporteras inte till Airbnb. Rader som fortfarande blockerar internt måste granskas manuellt innan de tas bort.</p>
    <div class="table-wrap"><table class="data-table">
      <thead><tr><th>Referens</th><th>Orsak</th><th>Status</th><th>Export</th><th>Nätter</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
  </section>`;
}

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

    ${syncStatusPanel(data.syncStatus)}
    ${calendarSafetyPanel(data.syncStatus, canWrite)}
    ${reservationIssuesPanel(data)}

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
