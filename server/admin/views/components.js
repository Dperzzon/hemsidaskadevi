'use strict';

const {
  escapeHtml,
  formatDateKey,
  formatDateRange,
  formatDateTime,
  formatMoney
} = require('../domain');

function statusBadge(booking) {
  return `<span class="status status-${escapeHtml(booking.statusTone)}">` +
    `<span class="status-dot" aria-hidden="true"></span>${escapeHtml(booking.statusShortLabel)}</span>`;
}

function emailBadge(level) {
  return `<span class="badge badge-${escapeHtml(level.apiTone)}">${escapeHtml(level.apiLabel)}</span>`;
}

function deliveryBadge(level) {
  return `<span class="badge badge-${escapeHtml(level.deliveryTone)}">${escapeHtml(level.deliveryLabel)}</span>`;
}

function actionChips(booking) {
  if (!booking.actionReasons?.length) return '<span class="muted">Ingen åtgärd</span>';
  return `<ul class="action-chips">${booking.actionReasons.map((reason) =>
    `<li>${escapeHtml(reason)}</li>`).join('')}</ul>`;
}

function preparedButton(label, action, variant = 'secondary', note = '', requiresRole = '') {
  return `<button type="button" class="btn btn-${escapeHtml(variant)}" ` +
    `data-prepared-action="${escapeHtml(action)}" ` +
    (requiresRole ? `data-requires-role="${escapeHtml(requiresRole)}" ` : '') +
    `title="${escapeHtml(note || 'Förberedd åtgärd – inte aktiv i denna version')}">` +
    `${escapeHtml(label)}</button>`;
}

function actionButton(label, action, booking, variant = 'secondary', options = {}) {
  const attrs = [
    `type="button"`,
    `class="btn btn-${escapeHtml(variant)}"`,
    `data-booking-action="${escapeHtml(action)}"`,
    `data-reference="${escapeHtml(booking.reference)}"`,
    `data-etag="${escapeHtml(booking.etag || '')}"`
  ];
  if (options.prompt) attrs.push(`data-prompt="${escapeHtml(options.prompt)}"`);
  if (options.requiresReason) attrs.push('data-requires-reason="true"');
  if (options.requiresOwner) attrs.push('data-requires-role="Owner"');
  return `<button ${attrs.join(' ')}>${escapeHtml(label)}</button>`;
}

function historyList(entries = []) {
  if (!entries.length) return '<p class="muted">Ingen historik registrerad ännu.</p>';
  const actionLabels = {
    MANUAL_CREATED: 'Manuell bokning skapad',
    AIRBNB_OVERRIDE_APPROVED: 'Airbnb-blockering åsidosatt',
    BLOCK_CREATED: 'Datumblockering skapad',
    BLOCK_REMOVED: 'Datumblockering borttagen',
    NOTE_ADDED: 'Anteckning tillagd',
    PAYMENT_UPDATED: 'Betalstatus uppdaterad',
    ADDONS_UPDATED: 'Tillval uppdaterade',
    approve: 'Godkänd som preliminär',
    preliminary: 'Godkänd som preliminär',
    decline: 'Nekad',
    confirm: 'Bekräftad',
    cancel: 'Avbokad'
  };
  return `<ul class="history-list">${entries.map((entry) => `
    <li>
      <div class="history-top"><strong>${escapeHtml(actionLabels[entry.action] ?? entry.action)}</strong>${datetimeCell(entry.at)}</div>
      <p class="history-meta">${escapeHtml(entry.actorName || 'Okänd')}${entry.fromStatus || entry.toStatus ? ` · ${escapeHtml(entry.fromStatus || '–')} → ${escapeHtml(entry.toStatus || '–')}` : ''}</p>
      ${entry.reason ? `<p class="history-reason">${escapeHtml(entry.reason)}</p>` : ''}
    </li>`).join('')}</ul>`;
}

function metricCard(label, value, detail, tone = '') {
  return `<article class="metric ${tone ? `metric-${escapeHtml(tone)}` : ''}">` +
    `<p class="metric-label">${escapeHtml(label)}</p>` +
    `<p class="metric-value">${escapeHtml(value)}</p>` +
    `<p class="metric-detail">${escapeHtml(detail)}</p></article>`;
}

function pageHeader(title, subtitle, extra = '') {
  return `<header class="page-header"><div>` +
    `<p class="eyebrow">Skadevi Gård · Bokningsportal</p>` +
    `<h1>${escapeHtml(title)}</h1>` +
    (subtitle ? `<p class="page-subtitle">${escapeHtml(subtitle)}</p>` : '') +
    `</div>${extra}</header>`;
}

function bookingLink(booking, className = 'booking-link') {
  return `<a class="${escapeHtml(className)}" href="/admin/bookings/${encodeURIComponent(booking.reference)}">` +
    `${escapeHtml(booking.reference)}</a>`;
}

function guestCell(booking) {
  return `<div class="guest-cell"><strong>${escapeHtml(booking.guestName)}</strong>` +
    `<span>${escapeHtml(booking.email || 'E-post saknas')}</span></div>`;
}

function stayCell(booking) {
  return `<div class="stay-cell"><strong>${escapeHtml(formatDateRange(booking.arrival, booking.departure))}</strong>` +
    `<span>${booking.nights} nätter · ${booking.guests} gäster</span></div>`;
}

function amountCell(booking) {
  return `<div class="amount-cell"><strong>${escapeHtml(formatMoney(booking.total))}</strong>` +
    `<span>${escapeHtml(booking.paymentLabel)}</span></div>`;
}

function dateCell(dateKey) {
  return `<time datetime="${escapeHtml(dateKey)}">${escapeHtml(formatDateKey(dateKey))}</time>`;
}

function datetimeCell(iso) {
  return `<time datetime="${escapeHtml(iso)}">${escapeHtml(formatDateTime(iso))}</time>`;
}

function emptyState(title, text) {
  return `<div class="empty-state"><p class="empty-title">${escapeHtml(title)}</p>` +
    `<p>${escapeHtml(text)}</p></div>`;
}

module.exports = {
  statusBadge,
  emailBadge,
  deliveryBadge,
  actionChips,
  preparedButton,
  actionButton,
  historyList,
  metricCard,
  pageHeader,
  bookingLink,
  guestCell,
  stayCell,
  amountCell,
  dateCell,
  datetimeCell,
  emptyState
};
