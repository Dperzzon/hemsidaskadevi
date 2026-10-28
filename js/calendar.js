const AIRBNB_ICAL_URL = 'https://www.airbnb.se/calendar/ical/42379787.ics?t=21aca5b4efbe43c88f3307ffbcd96ed0';
const CORS_PROXIES = [
  { url: (target) => `https://api.allorigins.win/raw?url=${encodeURIComponent(target)}`, json: false },
  { url: (target) => `https://api.allorigins.win/get?url=${encodeURIComponent(target)}`, json: true },
  { url: (target) => `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(target)}`, json: false },
  { url: (target) => `https://corsproxy.io/?url=${encodeURIComponent(target)}`, json: false },
  { url: (target) => target, json: false }
];

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

function parseICal(text) {
  const blocked = new Set();
  const events = text.match(/BEGIN:VEVENT[\s\S]*?END:VEVENT/g) || [];
  events.forEach((event) => {
    const startMatch = event.match(/DTSTART(?:;[^:\n]*)?:\s*(\d{8})/);
    const endMatch = event.match(/DTEND(?:;[^:\n]*)?:\s*(\d{8})/);
    if (!startMatch) return;
    const start = startMatch[1];
    const end = endMatch ? endMatch[1] : start;
    const cursor = new Date(`${start.slice(0, 4)}-${start.slice(4, 6)}-${start.slice(6, 8)}T00:00:00Z`);
    const endDate = new Date(`${end.slice(0, 4)}-${end.slice(4, 6)}-${end.slice(6, 8)}T00:00:00Z`);
    while (cursor < endDate) {
      blocked.add(ymd(cursor.getUTCFullYear(), cursor.getUTCMonth(), cursor.getUTCDate()));
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
  });
  return blocked;
}

async function loadAvailability() {
  if (AIRBNB_ICAL_URL.includes('KLISTRA_IN')) {
    state.status = 'unconfigured';
    render();
    return;
  }
  for (const proxy of CORS_PROXIES) {
    try {
      const response = await fetch(proxy.url(AIRBNB_ICAL_URL));
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      let text = await response.text();
      if (proxy.json) text = JSON.parse(text).contents || '';
      if (!text.includes('VCALENDAR')) throw new Error('Ogiltigt kalenderflöde');
      state.blocked = parseICal(text);
      state.status = 'ok';
      break;
    } catch (err) {
      state.status = 'error';
    }
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
  const cells = monthGrid(y, m);
  const days = cells.map((cell) => {
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
  const notice = {
    loading: 'Kalendern hämtas …',
    unconfigured: 'Kalendern visar för tillfället alla datum som tillgängliga. Kontakta oss för bekräftad tillgänglighet.',
    error: 'Kalendern kunde inte läsas just nu. Kontakta oss så bekräftar vi tillgängligheten.',
    ok: 'Gröna datum är bokade eller ej tillgängliga.'
  }[state.status];
  const y = state.base.y;
  const m = state.base.m;
  const next = { y: m === 11 ? y + 1 : y, m: (m + 1) % 12 };
  container.innerHTML = `
    <p class="cal-notice cal-notice-${state.status}">${notice}</p>
    <div class="cal-nav">
      <button type="button" class="cal-nav-btn" id="cal-prev" aria-label="Föregående månader">&#8592;</button>
      <button type="button" class="cal-nav-btn" id="cal-next" aria-label="Nästa månader">&#8594;</button>
    </div>
    <div class="cal-months">
      ${renderMonth(y, m)}
      ${renderMonth(next.y, next.m)}
    </div>`;
  document.getElementById('cal-prev').addEventListener('click', () => {
    state.base = state.base.m === 0 ? { y: y - 1, m: 11 } : { y, m: m - 1 };
    render();
  });
  document.getElementById('cal-next').addEventListener('click', () => {
    state.base = state.base.m === 11 ? { y: y + 1, m: 0 } : { y, m: m + 1 };
    render();
  });
}

document.addEventListener('DOMContentLoaded', () => {
  render();
  loadAvailability();
});
