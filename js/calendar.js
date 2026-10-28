const MONTH_NAMES = ['Januari', 'Februari', 'Mars', 'April', 'Maj', 'Juni', 'Juli', 'Augusti', 'September', 'Oktober', 'November', 'December'];
const WEEKDAYS = ['Mån', 'Tis', 'Ons', 'Tor', 'Fre', 'Lör', 'Sön'];

const state = {
  blocked: new Set(),
  status: 'loading',
  base: (() => { const d = new Date(); return { y: d.getFullYear(), m: d.getMonth() }; })()
};

function ymd(y, m, d) {
  return `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function shiftMonth(y, m, offset) {
  const date = new Date(y, m + offset, 1);
  return { y: date.getFullYear(), m: date.getMonth() };
}

async function loadAvailability() {
  state.status = 'loading';
  render();
  const start = ymd(state.base.y, state.base.m, 1);
  const following = shiftMonth(state.base.y, state.base.m, 2);
  const end = ymd(following.y, following.m, 1);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const query = new URLSearchParams({ start, end });
    const response = await fetch(`/api/availability?${query}`, {
      cache: 'no-store',
      signal: controller.signal
    });
    if (!response.ok) throw new Error('Kalender-API svarade med fel');
    const data = await response.json();
    if (!data || !Array.isArray(data.blocked) || !data.blocked.every((date) =>
      typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date) &&
      date >= start && date < end &&
      !Number.isNaN(Date.parse(`${date}T00:00:00Z`)) &&
      new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) === date
    )) {
      throw new Error('Kalender-API returnerade ett ogiltigt svar');
    }
    state.blocked = new Set(data.blocked);
    state.status = 'ok';
  } catch (error) {
    state.blocked.clear();
    state.status = 'error';
    console.error('Kalenderns tillgänglighet kunde inte hämtas.');
  } finally {
    clearTimeout(timeout);
  }
  render();
}

function monthGrid(y, m) {
  const first = new Date(y, m, 1);
  const daysInMonth = new Date(y, m + 1, 0).getDate();
  const leadingBlanks = (first.getDay() + 6) % 7;
  const today = new Date();
  const todayKey = ymd(today.getFullYear(), today.getMonth(), today.getDate());
  const cells = [];
  for (let i = 0; i < leadingBlanks; i++) cells.push({ blank: true });
  for (let d = 1; d <= daysInMonth; d++) {
    const key = ymd(y, m, d);
    cells.push({
      day: d,
      key,
      blocked: state.blocked.has(key) || key < todayKey,
      today: key === todayKey
    });
  }
  return cells;
}

function renderMonth(y, m) {
  const title = `${MONTH_NAMES[m]} ${y}`;
  const days = monthGrid(y, m).map((cell) => {
    if (cell.blank) return '<span class="cal-day cal-blank"></span>';
    const classes = ['cal-day'];
    if (cell.blocked) classes.push('cal-booked');
    if (cell.today) classes.push('cal-today');
    return `<span class="${classes.join(' ')}" data-date="${cell.key}">${cell.day}</span>`;
  }).join('');
  return `
    <div class="cal-month">
      <h3>${title}</h3>
      <div class="cal-weekdays">${WEEKDAYS.map((d) => `<span>${d}</span>`).join('')}</div>
      <div class="cal-grid">${days}</div>
    </div>`;
}

function render() {
  const container = document.getElementById('availability-calendar');
  if (!container) return;
  const description = document.getElementById('calendar-description');
  if (description) description.hidden = state.status !== 'ok';
  container.setAttribute('aria-busy', String(state.status === 'loading'));
  const notice = {
    loading: 'Kalendern hämtas …',
    error: 'Kalendern kunde inte läsas just nu. Tillgängligheten är okänd. Kontakta oss så bekräftar vi tillgängligheten.',
    ok: 'Gröna datum är bokade eller ej tillgängliga.'
  }[state.status];
  if (state.status !== 'ok') {
    container.innerHTML = `<p class="cal-notice cal-notice-${state.status}">${notice}</p>`;
    return;
  }
  const { y, m } = state.base;
  const next = shiftMonth(y, m, 1);
  container.innerHTML = `
    <p class="cal-notice cal-notice-ok">${notice}</p>
    <div class="cal-nav">
      <button type="button" class="cal-nav-btn" id="cal-prev" aria-label="Föregående månader">&#8592;</button>
      <button type="button" class="cal-nav-btn" id="cal-next" aria-label="Nästa månader">&#8594;</button>
    </div>
    <div class="cal-months">
      ${renderMonth(y, m)}
      ${renderMonth(next.y, next.m)}
    </div>
    <div class="cal-legend"><span class="cal-legend-item"><span class="cal-legend-dot cal-legend-free"></span>Ledigt</span><span class="cal-legend-item"><span class="cal-legend-dot cal-legend-booked"></span>Bokat / ej tillgängligt</span></div>`;
  document.getElementById('cal-prev').addEventListener('click', () => {
    state.base = shiftMonth(y, m, -1);
    loadAvailability();
  });
  document.getElementById('cal-next').addEventListener('click', () => {
    state.base = shiftMonth(y, m, 1);
    loadAvailability();
  });
}

document.addEventListener('DOMContentLoaded', loadAvailability);
