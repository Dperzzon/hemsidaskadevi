const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'js', 'calendar.js'), 'utf8');

function createCalendar(fetch, timer = setTimeout) {
  const handlers = {};
  const container = {
    innerHTML: '',
    attributes: {},
    setAttribute(name, value) { this.attributes[name] = value; }
  };
  const description = { hidden: true };
  const document = {
    addEventListener() {},
    getElementById(id) {
      if (id === 'availability-calendar') return container;
      if (id === 'calendar-description') return description;
      return { addEventListener: (event, handler) => { handlers[id] = handler; } };
    }
  };
  const context = vm.createContext({
    document, fetch, AbortController, URLSearchParams, Date, Set,
    setTimeout: timer, clearTimeout, console: { error() {} }
  });
  vm.runInContext(source, context);
  return {
    context, container, description, handlers,
    load: () => vm.runInContext('loadAvailability()', context)
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
    return response({ blocked: [start] });
  });
  await calendar.load();
  const start = new URL(requests[0], 'http://localhost').searchParams.get('start');
  assert.match(calendar.container.innerHTML, new RegExp(`cal-booked[^"]*" data-date="${start}"`));
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
