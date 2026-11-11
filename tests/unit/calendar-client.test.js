const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'js', 'calendar.js'), 'utf8');
const datesSource = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'js', 'booking', 'dates.js'), 'utf8');
// calendar.js är en ES-modul som importerar booking/dates.js; i vm-harnessen
//inlineas dates.js (utan export-nyckelord) och importraden tas bort.
const inlineSource = datesSource.replaceAll('export ', '') +
  '\n' + source.replace(/^import .*$/m, '');

function createCalendar(fetch, timer = setTimeout) {
  const handlers = {};
  const container = {
    innerHTML: '',
    attributes: {},
    setAttribute(name, value) { this.attributes[name] = value; },
    querySelectorAll() { return []; }
  };
  const description = { hidden: true };
  const document = {
    addEventListener() {},
    dispatchEvent() {},
    getElementById(id) {
      if (id === 'availability-calendar') return container;
      if (id === 'calendar-description') return description;
      return { addEventListener: (event, handler) => { handlers[id] = handler; } };
    }
  };
  const context = vm.createContext({
    document, fetch, AbortController, URLSearchParams, Date, Set,
    setTimeout: timer, clearTimeout, console: { error() {} }, CustomEvent: function () {}
  });
  vm.runInContext(inlineSource, context);
  return {
    context, container, description, handlers,
    load: () => vm.runInContext('loadAvailability()', context),
    click: (day) => vm.runInContext(`handleDayClick(${JSON.stringify(day)})`, context),
    stateJSON: () => JSON.parse(vm.runInContext('JSON.stringify({ selection: state.selection, message: state.message })', context))
  };
}

function response(data, ok = true) {
  return { ok, json: async () => data };
}

test('successful response displays the requested months and booked dates', async () => {
  const requests = [];
  const calendar = createCalendar(async (url) => {
    requests.push(url);
    const start = new URL(url, 'http://localhost').searchParams.get('start');
    // Blockera första datumet i följande månad så det inte råkar vara ett
    // förflutet datum (som renderas som cal-past, inte cal-booked).
    const startParts = start.split('-').map(Number);
    const blocked = (() => {
      const d = new Date(startParts[0], startParts[1] - 1 + 1, 1);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
    })();
    return response({ blocked: [blocked] });
  });
  await calendar.load();
  const start = new URL(requests[0], 'http://localhost').searchParams.get('start');
  const startParts = start.split('-').map(Number);
  const blocked = (() => {
    const d = new Date(startParts[0], startParts[1] - 1 + 1, 1);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
  })();
  assert.match(calendar.container.innerHTML, new RegExp(`cal-booked[^"]*" data-date="${blocked}"`));
  assert.equal((calendar.container.innerHTML.match(/class="cal-month"/g) || []).length, 2);
  assert.equal(calendar.description.hidden, false);
  assert.equal(calendar.container.attributes['aria-busy'], 'false');
  calendar.handlers['cal-next']();
  await new Promise((resolve) => setImmediate(resolve));
  assert.notEqual(requests[0], requests[1]);
});

for (const [label, fetch] of [
  ['network error', async () => { throw new Error('injected'); }],
  ['HTTP error', async () => response({}, false)],
  ['malformed payload', async () => response({ blocked: ['not-a-date'] })],
  ['invalid date', async () => response({ blocked: ['2026-02-31'] })]
]) {
  test(`${label} never displays available dates`, async () => {
    const calendar = createCalendar(fetch);
    if (label === 'invalid date') {
      vm.runInContext('state.base = { y: 2026, m: 1 }', calendar.context);
    }
    await calendar.load();
    assert.match(calendar.container.innerHTML, /Tillgängligheten är okänd/);
    assert.doesNotMatch(calendar.container.innerHTML, /data-date=|cal-legend/);
    assert.equal(calendar.description.hidden, true);
    assert.equal(calendar.container.attributes['aria-busy'], 'false');
  });
}

test('a valid empty response still displays the calendar', async () => {
  const calendar = createCalendar(async () => response({ blocked: [] }));
  await calendar.load();
  assert.match(calendar.container.innerHTML, /cal-notice-ok/);
  assert.match(calendar.container.innerHTML, /data-date=/);
  assert.equal(calendar.description.hidden, false);
});

test('loading and timeout never display available dates', async () => {
  const calendar = createCalendar(
    (url, options) => new Promise((resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(new Error('timeout')));
    }),
    (callback) => setTimeout(callback, 5)
  );
  const pending = calendar.load();
  assert.match(calendar.container.innerHTML, /Kalendern hämtas/);
  assert.doesNotMatch(calendar.container.innerHTML, /data-date=|cal-legend/);
  assert.equal(calendar.description.hidden, true);
  assert.equal(calendar.container.attributes['aria-busy'], 'true');
  await pending;
  assert.match(calendar.container.innerHTML, /Tillgängligheten är okänd/);
  assert.doesNotMatch(calendar.container.innerHTML, /data-date=|cal-legend/);
});

test('ett gammalt svar skriver inte över ett nyare (race)', async () => {
  const pending = [];
  const calendar = createCalendar((url) => new Promise((resolve) => {
    pending.push({ url, resolve: () => resolve(response({ blocked: [new URL(url, 'http://localhost').searchParams.get('start')] })) });
  }));
  vm.runInContext('state.base = { y: 2026, m: 10 }', calendar.context);
  const first = calendar.load();
  vm.runInContext('state.base = { y: 2026, m: 11 }', calendar.context);
  const second = calendar.load();
  await new Promise((resolve) => setImmediate(resolve));
  // Det NYARE anropet (december) slutförs först; det äldre (november) kommer
  // sist och får inte skriva över kalendern.
  pending[1].resolve();
  await second;
  assert.match(calendar.container.innerHTML, /December 2026/);
  pending[0].resolve();
  await first;
  assert.match(calendar.container.innerHTML, /December 2026/);
  assert.doesNotMatch(calendar.container.innerHTML, /November 2026/);
});

// --- Datumvalets tillstånd (buggfix: nytt datum ska ersätta tidigare val) ---

function dayKey(offset = 0) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Stockholm', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(new Date(Date.now() + offset * 86400000));
}

test('nytt ledigt datum ersätter en komplett period med ny ankomst', () => {
  const calendar = createCalendar(async () => response({ blocked: [] }));
  const arrival = dayKey(10);
  const departure = dayKey(14);
  const next = dayKey(20);
  vm.runInContext(`state.selection = { arrival: '${arrival}', departure: '${departure}' }`, calendar.context);

  calendar.click(next);

  const state = calendar.stateJSON();
  assert.equal(state.selection.arrival, next);
  assert.equal(state.selection.departure, null);
  assert.equal(state.message.error, false);
});

test('ogiltig period behålls aldrig och nästa klick börjar om', () => {
  const calendar = createCalendar(async () => response({ blocked: [] }));
  const arrival = dayKey(10);
  const blockedNight = dayKey(12);
  vm.runInContext(
    `state.selection = { arrival: '${arrival}', departure: null }; state.blocked = new Set(['${blockedNight}'])`,
    calendar.context
  );

  calendar.click(dayKey(15));

  let state = calendar.stateJSON();
  assert.equal(state.selection.arrival, null);
  assert.equal(state.selection.departure, null);
  assert.equal(state.message.error, true);
  assert.match(state.message.text, /innehåller bokade nätter/);

  const restart = dayKey(20);
  calendar.click(restart);
  state = calendar.stateJSON();
  assert.equal(state.selection.arrival, restart);
  assert.equal(state.selection.departure, null);
  assert.equal(state.message.error, false);
});

test('giltigt senare datum blir avresa när bara ankomst är vald', () => {
  const calendar = createCalendar(async () => response({ blocked: [] }));
  const arrival = dayKey(10);
  const departure = dayKey(12);
  vm.runInContext(`state.selection = { arrival: '${arrival}', departure: null }`, calendar.context);

  calendar.click(departure);

  const state = calendar.stateJSON();
  assert.equal(state.selection.arrival, arrival);
  assert.equal(state.selection.departure, departure);
  assert.equal(state.message.error, false);
});
