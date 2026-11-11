'use strict';

const {
  escapeHtml,
  formatDateKey,
  formatDateRange,
  formatMoney
} = require('../domain');
const {
  statusBadge,
  actionChips,
  preparedButton,
  metricCard,
  pageHeader,
  bookingLink,
  guestCell,
  stayCell,
  amountCell,
  emptyState
} = require('./components');
const { layout } = require('./layout');

function longDate(now) {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Europe/Stockholm',
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric'
  }).format(now);
}

function nextStayCard(title, booking, dateKey, type) {
  if (!booking) {
    return `<article class="next-card next-card-empty"><p class="card-kicker">${escapeHtml(title)}</p>` +
      `<p class="next-empty">Ingen kommande ${type}.</p></article>`;
  }
  return `<article class="next-card">` +
    `<p class="card-kicker">${escapeHtml(title)}</p>` +
    `<p class="next-date">${escapeHtml(formatDateKey(dateKey, { long: true }))}</p>` +
    `<p class="next-guest">${escapeHtml(booking.guestName)}</p>` +
    `<p class="next-meta">${escapeHtml(formatDateRange(booking.arrival, booking.departure))} · ${booking.nights} nätter · ${booking.guests} gäster</p>` +
    `<div class="next-footer">${statusBadge(booking)}${bookingLink(booking, 'text-link')}</div>` +
    `</article>`;
}

function requestCard(booking) {
  return `<article class="request-card">` +
    `<div class="request-top"><div><p class="card-kicker">Ny förfrågan</p>` +
    `<h3>${escapeHtml(booking.guestName)}</h3>` +
    `<p class="request-ref">${bookingLink(booking)}</p></div>${statusBadge(booking)}</div>` +
    `<div class="request-facts">` +
    `<div><span>Vistelse</span><strong>${escapeHtml(formatDateRange(booking.arrival, booking.departure))}</strong></div>` +
    `<div><span>Gäster</span><strong>${booking.guests}</strong></div>` +
    `<div><span>Nätter</span><strong>${booking.nights}</strong></div>` +
    `<div><span>Totalt</span><strong>${escapeHtml(formatMoney(booking.total))}</strong></div>` +
    `</div>` +
    `<div class="request-actions">` +
    preparedButton('Godkänn', 'approve', 'primary', 'Förberedd – statusändringar är avstängda') +
    preparedButton('Neka', 'decline', 'ghost', 'Förberedd – statusändringar är avstängda') +
    `<a class="btn btn-secondary" href="/admin/bookings/${encodeURIComponent(booking.reference)}">Öppna</a>` +
    `</div></article>`;
}

function renderDashboard(options) {
  const { data, principal, demo, csrfToken, now = new Date() } = options;
  const actions = data.actions.length
    ? `<div class="action-list">${data.actions.map((booking) => `
      <article class="action-row">
        <div class="action-main">
          <div class="action-title">${bookingLink(booking)} ${statusBadge(booking)}</div>
          <p>${escapeHtml(booking.guestName)} · ${escapeHtml(formatDateRange(booking.arrival, booking.departure))}</p>
          ${actionChips(booking)}
        </div>
        <a class="btn btn-secondary btn-small" href="/admin/bookings/${encodeURIComponent(booking.reference)}">Granska</a>
      </article>`).join('')}</div>`
    : emptyState('Inget kräver åtgärd just nu', 'Nya förfrågningar och bekräftade bokningar ser bra ut.');

  const newRequests = data.newRequests.length
    ? `<div class="request-grid">${data.newRequests.map((booking) => requestCard(booking)).join('')}</div>`
    : emptyState('Inga nya förfrågningar', 'När en gäst skickar en förfrågan visas den här.');

  const upcoming = data.upcoming.length
    ? `<div class="table-wrap"><table class="data-table compact">
        <thead><tr><th>Ankomst</th><th>Gäst</th><th>Vistelse</th><th>Gäster</th><th>Belopp</th><th>Status</th><th></th></tr></thead>
        <tbody>${data.upcoming.slice(0, 6).map((booking) => `
          <tr>
            <td data-label="Ankomst">${escapeHtml(formatDateKey(booking.arrival))}</td>
            <td data-label="Gäst">${guestCell(booking)}</td>
            <td data-label="Vistelse">${stayCell(booking)}</td>
            <td data-label="Gäster">${booking.guests}</td>
            <td data-label="Belopp">${amountCell(booking)}</td>
            <td data-label="Status">${statusBadge(booking)}</td>
            <td class="cell-actions"><a class="text-link" href="/admin/bookings/${encodeURIComponent(booking.reference)}">Öppna</a></td>
          </tr>`).join('')}</tbody>
      </table></div>`
    : emptyState('Inga kommande bokningar', 'Bekräftade bokningar med framtida ankomst visas här.');

  const content = `
    ${pageHeader('Översikt', longDate(now),
      `<a class="btn btn-secondary" href="/admin/bookings">Visa alla bokningar</a>`)}
    <section class="metric-grid" aria-label="Nyckeltal">
      ${metricCard('Nya förfrågningar', String(data.newRequestCount), 'Väntar på beslut', 'pending')}
      ${metricCard('Kommande bokningar', String(data.upcomingCount), `${data.upcomingGuests} gäster`, 'confirmed')}
      ${metricCard('Bokningsvärde', formatMoney(data.upcomingValue), 'Bekräftat, kommande', 'money')}
      ${metricCard('Kräver åtgärd', String(data.actionCount), 'Din uppmärksamhet', data.actionCount ? 'warning' : '')}
    </section>

    <section class="two-column">
      <div class="panel">
        <div class="panel-heading"><div><p class="eyebrow">Kalender</p><h2>Närmast i tiden</h2></div></div>
        <div class="next-grid">
          ${nextStayCard('Närmaste incheckning', data.nextCheckIn, data.nextCheckIn?.arrival, 'incheckning')}
          ${nextStayCard('Närmaste utcheckning', data.nextCheckOut, data.nextCheckOut?.departure, 'utcheckning')}
        </div>
      </div>
      <div class="panel panel-actions">
        <div class="panel-heading"><div><p class="eyebrow">Prioritet</p><h2>Kräver åtgärd</h2></div><span class="count-pill">${data.actionCount}</span></div>
        ${actions}
      </div>
    </section>

    <section class="panel">
      <div class="panel-heading"><div><p class="eyebrow">Inkorgen</p><h2>Nya bokningsförfrågningar</h2></div><a class="text-link" href="/admin/bookings?status=PENDING">Visa alla</a></div>
      ${newRequests}
    </section>

    <section class="panel">
      <div class="panel-heading"><div><p class="eyebrow">Framåt</p><h2>Kommande bokningar</h2></div><a class="text-link" href="/admin/bookings?status=CONFIRMED">Visa alla</a></div>
      ${upcoming}
    </section>
  `;
  return layout({ title: 'Översikt', active: '/admin', principal, demo, csrfToken, content });
}

module.exports = { renderDashboard };
