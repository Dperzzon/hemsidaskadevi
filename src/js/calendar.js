import { stockholmTodayKey, nightsBetween, validateArrival, validateRange } from './booking/dates.js';

const MONTH_NAMES = ['Januari', 'Februari', 'Mars', 'April', 'Maj', 'Juni', 'Juli', 'Augusti', 'September', 'Oktober', 'November', 'December'];
const WEEKDAYS = ['Mån', 'Tis', 'Ons', 'Tor', 'Fre', 'Lör', 'Sön'];

const state = {
  blocked: new Set(),
  status: 'loading',
  base: (() => { const d = new Date(); return { y: d.getFullYear(), m: d.getMonth() }; })(),
  selection: { arrival: null, departure: null },
  message: { text: 'Klicka på ett ledigt datum för att välja ankomstdatum.', error: false }
};

// Räknare som gör att svar från en äldre förfrågan aldrig skriver över en
// nyare (t.ex. när användaren bläddrar snabbt mellan månader).
let requestToken = 0;

function ymd(y, m, d) {
  return `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function shiftMonth(y, m, offset) {
  const date = new Date(y, m + offset, 1);
  return { y: date.getFullYear(), m: date.getMonth() };
}

function formatDay(key) {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Europe/Stockholm', day: 'numeric', month: 'long', year: 'numeric'
  }).format(new Date(`${key}T00:00:00Z`));
}

async function loadAvailability() {
  const token = ++requestToken;
  state.status = 'loading';
  render();
  const start = ymd(state.base.y, state.base.m, 1);
  const following = shiftMonth(state.base.y, state.base.m, 2);
  const end = ymd(following.y, following.m, 1);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 18000);
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
    if (token !== requestToken) return;
    // Union av hämtade månader: en bokad natt är bokad oavsett vilken månad
    // som visas just nu (serversidan kontrollerar alltid på nytt vid inskick).
    state.blocked = new Set([...state.blocked, ...data.blocked]);
    state.status = 'ok';
  } catch {
    if (token !== requestToken) return;
    state.blocked.clear();
    state.status = 'error';
    console.error('Kalenderns tillgänglighet kunde inte hämtas.');
  } finally {
    clearTimeout(timeout);
  }
  if (token !== requestToken) return;
  render();
}

function monthGrid(y, m) {
  const first = new Date(y, m, 1);
  const daysInMonth = new Date(y, m + 1, 0).getDate();
  const leadingBlanks = (first.getDay() + 6) % 7;
  const todayKey = stockholmTodayKey();
  const cells = [];
  for (let i = 0; i < leadingBlanks; i++) cells.push({ blank: true });
  for (let d = 1; d <= daysInMonth; d++) {
    const key = ymd(y, m, d);
    cells.push({
      day: d,
      key,
      blocked: state.blocked.has(key),
      past: key < todayKey,
      today: key === todayKey
    });
  }
  return cells;
}

function selectionClasses(key) {
  const { arrival, departure } = state.selection;
  const classes = [];
  if (arrival && departure && key > arrival && key < departure) classes.push('cal-in-range');
  if (key === arrival) classes.push('cal-arrival');
  if (departure && key === departure) classes.push('cal-departure');
  return classes;
}

function dayStatus(cell) {
  if (cell.past) return 'förflutet datum';
  if (cell.blocked) {
    if (state.selection.arrival && !state.selection.departure && cell.key > state.selection.arrival) {
      return 'bokat — möjligt avresedatum om alla nätter fram till dess är lediga';
    }
    return 'bokat eller ej tillgängligt';
  }
  if (state.selection.arrival === cell.key) return 'valt ankomstdatum';
  if (state.selection.departure === cell.key) return 'valt avresedatum';
  if (selectionClasses(cell.key).includes('cal-in-range')) return 'vald vistelseperiod';
  return 'ledigt';
}

function renderMonth(y, m) {
  const title = `${MONTH_NAMES[m]} ${y}`;
  const days = monthGrid(y, m).map((cell) => {
    if (cell.blank) return '<span class="cal-day cal-blank"></span>';
    const classes = ['cal-day'];
    if (cell.past) classes.push('cal-past');
    else if (cell.blocked && !(state.selection.arrival && !state.selection.departure && cell.key > state.selection.arrival)) classes.push('cal-booked');
    else classes.push('cal-selectable');
    if (cell.today) classes.push('cal-today');
    classes.push(...selectionClasses(cell.key));
    const selectable = !cell.past && (!cell.blocked || (state.selection.arrival && !state.selection.departure && cell.key > state.selection.arrival));
    const tabindex = selectable ? ' tabindex="0"' : '';
    return `<span class="${classes.join(' ')}" data-date="${cell.key}" role="button"${tabindex} aria-pressed="false" aria-label="${cell.day} ${title}, ${dayStatus(cell)}">${cell.day}</span>`;
  }).join('');
  return `
    <div class="cal-month">
      <h3>${title}</h3>
      <div class="cal-weekdays">${WEEKDAYS.map((d) => `<span>${d}</span>`).join('')}</div>
      <div class="cal-grid">${days}</div>
    </div>`;
}

function selectionNotice() {
  const { arrival, departure } = state.selection;
  if (!arrival) return { text: 'Klicka på ett ledigt datum för att välja ankomstdatum.', error: false };
  if (!departure) return { text: `Ankomst ${formatDay(arrival)}. Klicka på avresedatumet — det får även vara ett grått datum.`, error: false };
  const nights = nightsBetween(arrival, departure);
  return { text: `${formatDay(arrival)} – ${formatDay(departure)} · ${nights} ${nights === 1 ? 'natt' : 'nätter'}. Fyll i bokningsförfrågan nedan.`, error: false };
}

function setSelection(arrival, departure) {
  state.selection = { arrival, departure };
  state.message = selectionNotice();
}

function openBookingForm() {
  const { arrival, departure } = state.selection;
  document.dispatchEvent(new CustomEvent('booking:dates', {
    detail: { arrival, departure, nights: nightsBetween(arrival, departure) }
  }));
}

function handleDayClick(day) {
  const { arrival } = state.selection;
  const blocked = state.blocked;

  if (!arrival) {
    const check = validateArrival(day, blocked, stockholmTodayKey());
    if (!check.ok) {
      state.message = check.reason === 'past'
        ? { text: 'Det datumet har redan varit. Välj ett datum framåt i tiden.', error: true }
        : { text: 'Det datumet är bokat. Välj ett av de guldfärgade datumen.', error: true };
      return;
    }
    setSelection(day, null);
    return;
  }

  if (day === arrival) {
    setSelection(null, null);
    return;
  }

  if (day < arrival) {
    const check = validateArrival(day, blocked, stockholmTodayKey());
    if (!check.ok) {
      state.message = check.reason === 'past'
        ? { text: 'Det datumet har redan varit. Välj ett datum framåt i tiden.', error: true }
        : { text: 'Det datumet är bokat. Välj ett av de guldfärgade datumen.', error: true };
      return;
    }
    setSelection(day, null);
    return;
  }

  const check = validateRange(arrival, day, blocked);
  if (!check.ok) {
    state.message = {
      text: `Perioden innehåller bokade nätter (först den ${formatDay(check.firstBlocked)}). Välj ett annat avresedatum, eller klicka på ett ledigt datum för att börja om.`,
      error: true
    };
    return;
  }
  setSelection(arrival, day);
  openBookingForm();
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
    ok: 'Guldfärgade datum är lediga — grå datum är bokade eller ej tillgängliga.'
  }[state.status];
  if (state.status !== 'ok') {
    container.innerHTML = `<p class="cal-notice cal-notice-${state.status}">${notice}</p>`;
    return;
  }
  const { y, m } = state.base;
  const next = shiftMonth(y, m, 1);
  container.innerHTML = `
    <p class="cal-notice cal-notice-ok">${notice}</p>
    <p class="cal-selection${state.message.error ? ' cal-selection-error' : ''}" aria-live="polite">${state.message.text}</p>
    <div class="cal-nav">
      <button type="button" class="cal-nav-btn" id="cal-prev" aria-label="Föregående månader">&#8592;</button>
      <button type="button" class="cal-nav-btn" id="cal-next" aria-label="Nästa månader">&#8594;</button>
    </div>
    <div class="cal-months">
      ${renderMonth(y, m)}
      ${renderMonth(next.y, next.m)}
    </div>
    <div class="cal-legend"><span class="cal-legend-item"><span class="cal-legend-dot cal-legend-free"></span>Ledigt</span><span class="cal-legend-item"><span class="cal-legend-dot cal-legend-booked"></span>Bokat / ej tillgängligt</span><span class="cal-legend-item"><span class="cal-legend-dot cal-legend-range"></span>Er vistelse</span></div>`;
  document.getElementById('cal-prev').addEventListener('click', () => {
    state.base = shiftMonth(y, m, -1);
    loadAvailability();
  });
  document.getElementById('cal-next').addEventListener('click', () => {
    state.base = shiftMonth(y, m, 1);
    loadAvailability();
  });
  container.querySelectorAll('.cal-day[data-date]').forEach((day) => {
    const key = day.getAttribute('data-date');
    const select = () => {
      handleDayClick(key);
      render();
      // Behåll fokus på samma datum efter omritning när det är möjligt.
      const again = container.querySelector(`.cal-day[data-date="${key}"]`);
      if (again && again.classList.contains('cal-selectable')) again.focus();
    };
    day.addEventListener('click', select);
    day.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        select();
      } else {
        navigateByKeyboard(event, day, container);
      }
    });
  });
}

// Piltangenter flyttar fokus mellan dagarna (vänster/höger ±1 dag,
// upp/ner ±1 vecka) inom de månader som visas.
function navigateByKeyboard(event, day, container) {
  const moves = { ArrowLeft: 1, ArrowRight: -1, ArrowUp: 7, ArrowDown: -7 };
  const move = moves[event.key];
  if (!move) return;
  const days = [...container.querySelectorAll('.cal-day[data-date]')];
  const index = days.indexOf(day);
  const target = days[index - move];
  if (!target) return;
  event.preventDefault();
  target.focus();
}

// Extern begäran om att börja om (t.ex. via "Ändra datum" i formuläret).
document.addEventListener('booking:invalidate', () => {
  setSelection(null, null);
  render();
});

document.addEventListener('DOMContentLoaded', loadAvailability);
