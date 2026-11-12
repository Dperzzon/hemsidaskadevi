'use strict';

const {
  escapeHtml,
  addDays,
  formatDateRange,
  todayKey
} = require('../domain');
const { pageHeader } = require('./components');
const { layout } = require('./layout');

const WEEKDAYS = ['Mån', 'Tis', 'Ons', 'Tor', 'Fre', 'Lör', 'Sön'];

function shiftMonth(from, delta) {
  const year = Number(from.slice(0, 4));
  const month = Number(from.slice(5, 7));
  const date = new Date(Date.UTC(year, month - 1 + delta, 1));
  return date.toISOString().slice(0, 10);
}

function monthLabel(from) {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'UTC', month: 'long', year: 'numeric'
  }).format(new Date(`${from}T00:00:00Z`));
}

function badgeClass(item) {
  if (item.type === 'BOOKING') return 'cal-chip cal-chip-booking';
  if (item.type === 'MANUAL') return 'cal-chip cal-chip-block';
  if (item.statusCode === 'PENDING') return 'cal-chip cal-chip-pending';
  if (item.statusCode === 'PRELIMINARY') return 'cal-chip cal-chip-preliminary';
  if (item.statusCode === 'CONFIRMED') return 'cal-chip cal-chip-booking';
  return 'cal-chip cal-chip-neutral';
}

function chipLabel(item) {
  if (item.type === 'MANUAL') return `Block ${item.reference}`;
  if (item.type === 'BOOKING') return item.reference;
  return `${item.reference} · ${item.statusShortLabel ?? item.statusCode}`;
}

function renderCalendar(options) {
  const { data, principal, demo, csrfToken, writesEnabled, from } = options;
  const monthStart = `${from.slice(0, 7)}-01`;
  const year = Number(monthStart.slice(0, 4));
  const month = Number(monthStart.slice(5, 7));
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const firstWeekday = (new Date(`${monthStart}T00:00:00Z`).getUTCDay() + 6) % 7;
  const byNight = new Map();
  for (const row of data.nights) {
    if (!byNight.has(row.night)) byNight.set(row.night, []);
    byNight.get(row.night).push({ ...row, type: row.type || 'BOOKING' });
  }
  for (const booking of data.overlays) {
    let night = booking.arrival;
    while (night < booking.departure) {
      if (!byNight.has(night)) byNight.set(night, []);
      byNight.get(night).push(booking);
      night = addDays(night, 1);
    }
  }
  for (const booking of data.bookings ?? []) {
    if (booking.statusCode !== 'CONFIRMED') continue;
    let night = booking.arrival;
    while (night < booking.departure) {
      const rows = byNight.get(night) ?? [];
      if (!rows.some((row) => row.type === 'BOOKING' && row.reference === booking.reference)) {
        if (!byNight.has(night)) byNight.set(night, []);
        byNight.get(night).push({ ...booking, type: 'MISSING_CALENDAR' });
      }
      night = addDays(night, 1);
    }
  }

  const cells = [];
  for (let index = 0; index < firstWeekday; index++) {
    cells.push('<div class="cal-day cal-day-empty" aria-hidden="true"></div>');
  }
  for (let day = 1; day <= daysInMonth; day++) {
    const dateKey = `${monthStart.slice(0, 8)}${String(day).padStart(2, '0')}`;
    const items = byNight.get(dateKey) ?? [];
    const isToday = dateKey === todayKey();
    cells.push(`<div class="cal-day${isToday ? ' cal-day-today' : ''}">
      <div class="cal-day-head"><span>${day}</span><span class="cal-date">${escapeHtml(dateKey.slice(5))}</span></div>
      ${items.map((item) => `<span class="${badgeClass(item)}" title="${escapeHtml(chipLabel(item))}">${escapeHtml(chipLabel(item))}</span>`).join('')}
    </div>`);
  }
  while (cells.length % 7 !== 0) cells.push('<div class="cal-day cal-day-empty" aria-hidden="true"></div>');

  const nextFrom = shiftMonth(monthStart, 1);
  const prevFrom = shiftMonth(monthStart, -1);
  const content = `
    ${pageHeader('Kalender', `${monthLabel(monthStart)} · interna bokningar, manuella block och mjuka förfrågningar`)}
    <div class="calendar-toolbar">
      <a class="btn btn-ghost" href="/admin/calendar?from=${prevFrom}">← Föregående</a>
      <a class="btn btn-ghost" href="/admin/calendar?from=${escapeHtml(todayKey().slice(0, 8))}01">Denna månad</a>
      <a class="btn btn-ghost" href="/admin/calendar?from=${nextFrom}">Nästa →</a>
      <div class="cal-legend">
        <span class="cal-chip cal-chip-booking">Bekräftad</span>
        <span class="cal-chip cal-chip-block">Manuellt block</span>
        <span class="cal-chip cal-chip-pending">Förfrågan</span>
        <span class="cal-chip cal-chip-preliminary">Preliminär</span>
      </div>
    </div>
    <div class="notice-banner">
      <strong>Airbnb iCal är fördröjd.</strong> Kalendern visar Airbnb-data som hämtas vid behov; det är inte en realtidssynkronisering.
    </div>
    <section class="panel">
      <div class="cal-grid" role="grid" aria-label="Månadskalender">
        ${WEEKDAYS.map((day) => `<div class="cal-weekday" role="columnheader">${day}</div>`).join('')}
        ${cells.join('')}
      </div>
    </section>

    <section class="panel">
      <div class="panel-heading"><div><p class="eyebrow">Blockering</p><h2>Blockera datum utan gästuppgifter</h2></div></div>
      ${principal.roles?.includes('Owner') ? `<form class="form-grid" data-admin-form="block">
        <label class="field"><span>Från och med natt *</span><input type="date" name="arrival" required></label>
        <label class="field"><span>Till och med före avresa *</span><input type="date" name="departure" required></label>
        <label class="field field-wide"><span>Orsak / anteckning</span><input type="text" name="latestNote" maxlength="500"></label>
        <div class="form-actions"><button class="btn btn-primary" type="submit">Blockera datum</button><p class="form-error" data-form-error hidden></p></div>
      </form>` : '<p class="notice">Endast Owner kan blockera datum.</p>'}
    </section>

    <section class="panel">
      <div class="panel-heading"><div><p class="eyebrow">Överlapp</p><h2>Förfrågningar och preliminära bokningar</h2></div></div>
      ${data.overlays.length ? `<div class="table-wrap"><table class="data-table compact">
        <thead><tr><th>Referens</th><th>Status</th><th>Vistelse</th><th>Gäst</th></tr></thead>
        <tbody>${data.overlays.map((booking) => `<tr>
          <td><a class="text-link" href="/admin/bookings/${encodeURIComponent(booking.reference)}">${escapeHtml(booking.reference)}</a></td>
          <td>${escapeHtml(booking.statusLabel)}</td>
          <td>${escapeHtml(formatDateRange(booking.arrival, booking.departure))}</td>
          <td>${escapeHtml(booking.guestName)}</td>
        </tr>`).join('')}</tbody></table></div>`
        : '<p class="muted">Inga mjuka förfrågningar i perioden.</p>'}
    </section>
  `;
  return layout({ title: 'Kalender', active: '/admin/calendar', principal, demo, csrfToken, writesEnabled, content });
}

module.exports = { renderCalendar, monthLabel, shiftMonth };
