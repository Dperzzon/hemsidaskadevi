'use strict';

const {
  STATUS_META,
  escapeHtml
} = require('../domain');
const {
  statusBadge,
  actionChips,
  pageHeader,
  bookingLink,
  guestCell,
  stayCell,
  amountCell,
  emptyState
} = require('./components');
const { layout } = require('./layout');

function option(value, label, selected) {
  return `<option value="${escapeHtml(value)}"${selected === value ? ' selected' : ''}>${escapeHtml(label)}</option>`;
}

function renderBookings(options) {
  const { bookings, filters, principal, demo, csrfToken, totalCount } = options;
  const statusOptions = [
    option('ALL', 'Alla statusar', filters.status || 'ALL'),
    ...Object.values(STATUS_META).map((meta) => option(meta.code, meta.label, filters.status))
  ].join('');
  const sortOptions = [
    option('arrival', 'Ankomst', filters.sort || 'arrival'),
    option('created', 'Skapad tid', filters.sort),
    option('amount', 'Belopp', filters.sort)
  ].join('');
  const dirOptions = [
    option('asc', 'Stigande', filters.dir || 'asc'),
    option('desc', 'Fallande', filters.dir)
  ].join('');

  const rows = bookings.length
    ? `<div class="table-wrap"><table class="data-table">
        <thead><tr>
          <th>Referens</th><th>Gäst</th><th>Vistelse</th><th>Gäster</th>
          <th>Belopp</th><th>Status</th><th>Åtgärd</th><th></th>
        </tr></thead>
        <tbody>${bookings.map((booking) => `
          <tr class="${booking.hasAction ? 'has-action' : ''}">
            <td data-label="Referens">${bookingLink(booking)}<span class="cell-sub">${escapeHtml(booking.bookingSourceLabel)}</span></td>
            <td data-label="Gäst">${guestCell(booking)}</td>
            <td data-label="Vistelse">${stayCell(booking)}</td>
            <td data-label="Gäster">${booking.guests}</td>
            <td data-label="Belopp">${amountCell(booking)}</td>
            <td data-label="Status">${statusBadge(booking)}</td>
            <td data-label="Åtgärd">${booking.hasAction ? actionChips(booking) : '<span class="muted">—</span>'}</td>
            <td class="cell-actions"><a class="text-link" href="/admin/bookings/${encodeURIComponent(booking.reference)}">Öppna</a></td>
          </tr>`).join('')}</tbody>
      </table></div>`
    : emptyState('Inga bokningar matchar', 'Prova att rensa filtren eller söka på ett annat namn, datum eller referens.');

  const content = `
    ${pageHeader('Bokningar', `${totalCount} bokningar och förfrågningar i portalen`)}
    <section class="panel filter-panel">
      <form class="filter-form" method="get" action="/admin/bookings" role="search">
        <label class="field field-search">
          <span>Sök</span>
          <input type="search" name="q" value="${escapeHtml(filters.q || '')}" placeholder="Namn, datum eller referens" autocomplete="off">
        </label>
        <label class="field">
          <span>Status</span>
          <select name="status">${statusOptions}</select>
        </label>
        <label class="field">
          <span>Från datum</span>
          <input type="date" name="from" value="${escapeHtml(filters.from || '')}">
        </label>
        <label class="field">
          <span>Till datum</span>
          <input type="date" name="to" value="${escapeHtml(filters.to || '')}">
        </label>
        <label class="field">
          <span>Sortera</span>
          <select name="sort">${sortOptions}</select>
        </label>
        <label class="field">
          <span>Riktning</span>
          <select name="dir">${dirOptions}</select>
        </label>
        <div class="filter-actions">
          <button class="btn btn-primary" type="submit">Filtrera</button>
          <a class="btn btn-ghost" href="/admin/bookings">Rensa</a>
        </div>
      </form>
    </section>

    <div class="list-summary">
      <p><strong>${bookings.length}</strong> visade av ${totalCount}</p>
      <p class="muted">Status, datum och belopp är hämtade från bokningens sparade prissnapshot.</p>
    </div>
    ${rows}
  `;
  return layout({ title: 'Bokningar', active: '/admin/bookings', principal, demo, csrfToken, content });
}

module.exports = { renderBookings };
