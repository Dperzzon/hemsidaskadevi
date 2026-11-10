'use strict';

const { parentPort, workerData } = require('node:worker_threads');

// Treat parser warnings as errors: some include calendar content or indicate a fallback.
console.warn = () => { throw new Error('Calendar parser warning'); };
console.error = () => { throw new Error('Calendar parser error'); };

const ical = require('node-ical');
const { Temporal } = require('temporal-polyfill');
const STOCKHOLM = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Stockholm', year: 'numeric', month: '2-digit', day: '2-digit'
});
const DAY = 86400000;

function isValidDate(value) {
  if (!/^\d{8}$/.test(value)) return false;
  const iso = `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
  const millis = Date.parse(`${iso}T00:00:00Z`);
  return Number.isFinite(millis) && new Date(millis).toISOString().slice(0, 10) === iso;
}

function validateCalendar(text) {
  if (typeof text !== 'string' || text.includes('\0')) throw new Error('Invalid calendar');
  const lines = text.replace(/^\uFEFF/, '').replace(/\r?\n[ \t]/g, '').split(/\r?\n/);
  const stack = [];
  const events = [];
  let event;
  let calendars = 0;
  let version = false;
  let productId = false;
  let calendarScale = false;
  const normalized = [];

  for (const line of lines) {
    if (!line) continue;
    const colon = line.indexOf(':');
    if (colon < 1) throw new Error('Invalid content line');
    const header = line.slice(0, colon);
    const value = line.slice(colon + 1);
    const name = header.split(';', 1)[0].toUpperCase();
    const component = value.toUpperCase();
    if (name === 'BEGIN') {
      if (component === 'VCALENDAR') {
        if (stack.length || ++calendars !== 1) throw new Error('Invalid calendar nesting');
      } else if (!stack.length) {
        throw new Error('Component outside calendar');
      }
      if (component !== 'VCALENDAR' &&
          !(
            (stack.at(-1) === 'VCALENDAR' && ['VEVENT', 'VTIMEZONE'].includes(component)) ||
            (stack.at(-1) === 'VTIMEZONE' && ['STANDARD', 'DAYLIGHT'].includes(component)) ||
            (stack.at(-1) === 'VEVENT' && component === 'VALARM')
          )) {
        throw new Error('Unsupported calendar component');
      }
      if (component === 'VEVENT') {
        if (stack.length !== 1 || stack[0] !== 'VCALENDAR') throw new Error('Invalid event');
        event = {
          properties: new Map(), dateTypes: new Map(), rdates: [], startLine: null,
          recurrence: null, range: false, overrides: []
        };
        events.push(event);
      }
      stack.push(component);
    } else if (name === 'END') {
      if (stack.pop() !== component) throw new Error('Unclosed calendar component');
      if (component === 'VEVENT') event = undefined;
    } else {
      if (!stack.length) throw new Error('Content outside calendar');
      if (stack.length === 1 && name === 'VERSION') {
        if (version || value !== '2.0') throw new Error('Invalid version');
        version = true;
      }
      if (stack.length === 1 && name === 'PRODID') {
        if (productId || !value) throw new Error('Invalid product identifier');
        productId = true;
      }
      if (stack.length === 1 && name === 'CALSCALE') {
        if (calendarScale || value.toUpperCase() !== 'GREGORIAN') throw new Error('Unsupported calendar scale');
        calendarScale = true;
      }
      if (event && stack.at(-1) === 'VEVENT') {
        const values = event.properties.get(name) || [];
        values.push(value);
        event.properties.set(name, values);
        if (name === 'RECURRENCE-ID') {
          const ranges = [...header.matchAll(/(?:^|;)RANGE=([^;]+)/gi)];
          if (ranges.length > 1 || (ranges.length && ranges[0][1].toUpperCase() !== 'THISANDFUTURE')) {
            throw new Error('Unsupported recurrence range');
          }
          event.range = ranges.length === 1;
        }
        if (['DTSTART', 'DTEND', 'RECURRENCE-ID', 'EXDATE', 'RDATE'].includes(name)) {
          if ((header.match(/(?:^|;)TZID=/gi) || []).length > 1 ||
              (header.match(/(?:^|;)VALUE=/gi) || []).length > 1) {
            throw new Error('Ambiguous date parameters');
          }
          const tz = header.match(/(?:^|;)TZID=(?:"([^"]+)"|([^;]+))/i);
          if (tz) {
            try {
              new Intl.DateTimeFormat('en', { timeZone: tz[1] || tz[2] }).format(0);
            } catch {
              throw new Error('Unknown timezone');
            }
          }
          const dates = value.split(',');
          const valueType = header.match(/(?:^|;)VALUE=([^;]+)/i)?.[1].toUpperCase();
          if (valueType && !['DATE', 'DATE-TIME'].includes(valueType)) throw new Error('Invalid date type');
          if (!['EXDATE', 'RDATE'].includes(name) && dates.length !== 1) throw new Error('Invalid date count');
          const dateTypes = event.dateTypes.get(name) || [];
          for (const date of dates) {
            const match = /^(\d{8})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(date);
            if (!match || !isValidDate(match[1]) ||
                (match[2] && (+match[2] > 23 || +match[3] > 59 || +match[4] > 59)) ||
                (tz && (!match[2] || match[5])) ||
                (valueType === 'DATE' && match[2]) ||
                (valueType === 'DATE-TIME' && !match[2])) {
              throw new Error('Invalid calendar date');
            }
            dateTypes.push(match[2] ? 'date-time' : 'date');
          }
          event.dateTypes.set(name, dateTypes);
          let dateHeader = header;
          if (!tz && dates.every((date) => /^\d{8}T\d{6}$/.test(date))) {
            dateHeader += ';TZID=Europe/Stockholm';
          }
          if (name === 'RDATE') event.rdates.push({ header: dateHeader, dates });
          if (name === 'DTSTART') event.startLine = `${dateHeader}:${value}`;
          if (name === 'RECURRENCE-ID') event.recurrence = { header: dateHeader, dates };
          normalized.push(`${dateHeader}:${value}`);
          continue;
        }
      }
    }
    normalized.push(line);
  }
  if (calendars !== 1 || stack.length || !version || !productId) throw new Error('Incomplete calendar');

  const masters = new Map();
  const overrides = [];
  for (const item of events) {
    const { properties, dateTypes } = item;
    const one = (key) => (properties.get(key) || []).length === 1;
    if (!one('UID') || !properties.get('UID')[0] ||
        (properties.get('DTSTART') || []).length > 1 ||
        (properties.get('DTEND') || []).length > 1 ||
        (properties.get('DURATION') || []).length > 1 ||
        (properties.has('DTEND') && properties.has('DURATION')) ||
        (properties.get('RRULE') || []).length > 1 ||
        (properties.get('RECURRENCE-ID') || []).length > 1) {
      throw new Error('Ambiguous event');
    }
    const uid = properties.get('UID')[0];
    if (properties.has('RECURRENCE-ID')) {
      if (properties.has('EXRULE') || properties.has('RRULE') || properties.has('RDATE')) {
        throw new Error('Invalid exception recurrence');
      }
      overrides.push({ ...item, uid });
    } else {
      if (masters.has(uid) || !one('DTSTART')) throw new Error('Incomplete event');
      masters.set(uid, item);
    }
    if (!properties.has('DTSTART') &&
        !(properties.has('RECURRENCE-ID') && properties.get('STATUS')?.[0] === 'CANCELLED')) {
      throw new Error('Incomplete event');
    }
    if (dateTypes.has('DTSTART') && dateTypes.has('DTEND') &&
        dateTypes.get('DTSTART')[0] !== dateTypes.get('DTEND')[0]) {
      throw new Error('Inconsistent event date types');
    }
  }
  for (const override of overrides) {
    const master = masters.get(override.uid);
    if (!master || (!master.properties.has('RRULE') && !master.properties.has('RDATE'))) {
      throw new Error('Orphaned exception');
    }
    if (override.dateTypes.get('RECURRENCE-ID')[0] !== master.dateTypes.get('DTSTART')[0] ||
        (override.dateTypes.has('DTSTART') &&
         override.dateTypes.get('DTSTART')[0] !== master.dateTypes.get('DTSTART')[0])) {
      throw new Error('Inconsistent exception date types');
    }
    if (override.range && override.properties.get('STATUS')?.[0] !== 'CANCELLED' &&
        !override.properties.has('DTEND') && !override.properties.has('DURATION')) {
      throw new Error('Incomplete recurrence range');
    }
    master.overrides.push(override);
  }
  for (const { dateTypes } of masters.values()) {
    for (const key of ['EXDATE', 'RDATE']) {
      if ((dateTypes.get(key) || []).some((type) => type !== dateTypes.get('DTSTART')[0])) {
        throw new Error('Inconsistent recurrence date types');
      }
    }
  }
  return { text: `${normalized.join('\r\n')}\r\n`, masters };
}

function localDate(date) {
  return `${String(date.getFullYear()).padStart(4, '0')}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function stockholmDate(date) {
  return STOCKHOLM.format(date);
}

function addDays(date, count) {
  return new Date(Date.parse(`${date}T00:00:00Z`) + count * DAY).toISOString().slice(0, 10);
}

function parseDateProperties(properties) {
  const entries = properties.flatMap(({ header, dates }) =>
    dates.map((date) => ({
      header: header.replace(/^(RDATE|RECURRENCE-ID)/i, 'DTSTART').replace(/;RANGE=[^;]+/ig, ''),
      date
    })));
  if (!entries.length) return [];
  if (entries.length > 2000) throw new Error('Too many recurrence dates');
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Synthetic Dates//EN'];
  entries.forEach(({ header, date }, index) => {
    lines.push('BEGIN:VEVENT', `UID:additional-${index}`, `${header}:${date}`, 'END:VEVENT');
  });
  lines.push('END:VCALENDAR', '');
  const parsed = ical.sync.parseICS(lines.join('\r\n'));
  return entries.map((entry, index) => {
    const date = parsed[`additional-${index}`]?.start;
    if (!(date instanceof Date) || !Number.isFinite(date.getTime())) throw new Error('Invalid recurrence date');
    return date;
  });
}

function additionalDates(source) {
  return parseDateProperties(source.rdates);
}

function recurrenceKey(date, isFullDay) {
  return isFullDay ? localDate(date) : date.toISOString();
}

function excluded(event, date, isFullDay) {
  return Boolean(event.exdate?.[recurrenceKey(date, isFullDay)]);
}

function addExrules(event, source, from, to, extraDates, isFullDay) {
  const rules = source.properties.get('EXRULE') || [];
  if (!rules.length) return;
  const candidates = [from, to, ...extraDates];
  for (const override of new Set(Object.values(event.recurrences || {}))) {
    if (!(override.recurrenceid instanceof Date) || !Number.isFinite(override.recurrenceid.getTime())) {
      throw new Error('Invalid exception date');
    }
    candidates.push(override.recurrenceid);
  }
  const times = candidates.map((date) => date.getTime());
  const earliest = Math.min(...times) - 2 * DAY;
  const latest = Math.max(...times) + 2 * DAY;
  if (!Number.isFinite(earliest) || !Number.isFinite(latest) || latest - earliest > 3660 * DAY) {
    throw new Error('Exclusion range too large');
  }
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Synthetic Rules//EN'];
  rules.forEach((rule, index) => {
    lines.push('BEGIN:VEVENT', `UID:exclusion-${index}`, source.startLine, `RRULE:${rule}`, 'END:VEVENT');
  });
  lines.push('END:VCALENDAR', '');
  const parsed = ical.sync.parseICS(lines.join('\r\n'));
  event.exdate ||= {};
  rules.forEach((rule, index) => {
    const exclusion = parsed[`exclusion-${index}`];
    if (!exclusion?.rrule) throw new Error('Invalid exclusion rule');
    const instances = ical.expandRecurringEvent(exclusion, {
      from: new Date(earliest), to: new Date(latest), expandOngoing: false
    });
    if (instances.length > 10000) throw new Error('Too many exclusion dates');
    for (const instance of instances) {
      event.exdate[recurrenceKey(instance.start, isFullDay)] = instance.start;
    }
  });
}

function explicitInstance(event, date, isFullDay) {
  if (excluded(event, date, isFullDay)) return null;
  const override = event.recurrences?.[recurrenceKey(date, isFullDay)];
  if (override?.status === 'CANCELLED') return null;
  if (override) {
    if (!(override.start instanceof Date) || !(override.end instanceof Date)) {
      throw new Error('Incomplete occurrence exception');
    }
    return { start: override.start, end: override.end, isFullDay, event: override, isOverride: true, originalStart: date };
  }
  let end;
  if (isFullDay) {
    const durationDays = (Date.parse(`${localDate(event.end)}T00:00:00Z`) -
      Date.parse(`${localDate(event.start)}T00:00:00Z`)) / DAY;
    end = new Date(date.getFullYear(), date.getMonth(), date.getDate() + durationDays);
  } else {
    end = new Date(date.getTime() + event.end.getTime() - event.start.getTime());
  }
  return { start: date, end, isFullDay, event, originalStart: date };
}

function localDayNumber(date) {
  return Date.parse(`${localDate(date)}T00:00:00Z`) / DAY;
}

function localDateFromString(value) {
  const [year, month, day] = value.split('-').map(Number);
  const result = new Date(0);
  result.setFullYear(year, month - 1, day);
  result.setHours(0, 0, 0, 0);
  return result;
}

function plainDateTime(date, zone) {
  return Temporal.Instant.fromEpochMilliseconds(date.getTime()).toZonedDateTimeISO(zone).toPlainDateTime();
}

function validateOverrides(event, source, extraDates, isFullDay) {
  if (source.overrides.length > 1000) throw new Error('Too many recurrence exceptions');
  const identifiers = parseDateProperties(source.overrides.map((override) => override.recurrence));
  const result = [];
  const seen = new Set();
  for (let index = 0; index < source.overrides.length; index++) {
    const id = identifiers[index];
    const key = recurrenceKey(id, isFullDay);
    if (seen.has(key)) throw new Error('Duplicate recurrence exception');
    seen.add(key);
    const override = event.recurrences?.[key];
    if (!override) throw new Error('Missing recurrence exception');
    const candidates = [event.start, ...extraDates];
    if (event.rrule) {
      const base = { ...event, exdate: undefined, recurrences: undefined };
      const nearby = ical.expandRecurringEvent(base, {
        from: new Date(id.getTime() - 2 * DAY), to: new Date(id.getTime() + 2 * DAY),
        expandOngoing: false
      });
      candidates.push(...nearby.map((instance) => instance.start));
    }
    if (!candidates.some((candidate) => recurrenceKey(candidate, isFullDay) === key)) {
      throw new Error('Exception is not a recurrence');
    }
    result.push({ id, override, range: source.overrides[index].range });
  }
  return result;
}

function rangeExceptions(event, overrides, isFullDay) {
  const records = [];
  for (const { id, override, range } of overrides) {
    if (!range) continue;
    if (excluded(event, id, isFullDay)) throw new Error('Excluded recurrence range');
    if (override.status === 'CANCELLED') {
      records.push({ id, cancelled: true, margin: 0 });
      continue;
    }
    if (!(override.start instanceof Date) || !(override.end instanceof Date) ||
        !Number.isFinite(override.start.getTime()) || !Number.isFinite(override.end.getTime()) ||
        override.end < override.start) throw new Error('Invalid recurrence range interval');
    const margin = Math.abs(override.start.getTime() - id.getTime()) +
      Math.abs(override.end.getTime() - override.start.getTime()) + 3 * DAY;
    if (margin > 3650 * DAY) throw new Error('Recurrence range too large');
    if (isFullDay) {
      records.push({
        id, margin, days: localDayNumber(override.start) - localDayNumber(id),
        durationDays: localDayNumber(override.end) - localDayNumber(override.start)
      });
    } else {
      const zone = event.start.tz || 'Etc/UTC';
      records.push({
        id, margin, zone,
        shift: plainDateTime(id, zone).until(plainDateTime(override.start, zone), { largestUnit: 'days' }),
        duration: override.end.getTime() - override.start.getTime()
      });
    }
  }
  return records.sort((a, b) => a.id.getTime() - b.id.getTime());
}

function applyRange(instance, records, isFullDay) {
  if (instance.isOverride) return instance;
  const original = instance.originalStart || instance.start;
  let applicable;
  for (const record of records) {
    if (record.id.getTime() <= original.getTime()) applicable = record;
    else break;
  }
  if (!applicable) return instance;
  if (applicable.cancelled) return null;
  if (isFullDay) {
    const first = addDays(localDate(original), applicable.days);
    return {
      ...instance, start: localDateFromString(first),
      end: localDateFromString(addDays(first, applicable.durationDays))
    };
  }
  const shifted = plainDateTime(original, applicable.zone).add(applicable.shift)
    .toZonedDateTime(applicable.zone, { disambiguation: 'compatible' });
  const shiftedStart = new Date(shifted.epochMilliseconds);
  return { ...instance, start: shiftedStart, end: new Date(shiftedStart.getTime() + applicable.duration) };
}

function parseCalendar(text, start, end) {
  const validated = validateCalendar(text);
  const parsed = ical.sync.parseICS(validated.text);
  const events = Object.values(parsed).filter((entry) => entry.type === 'VEVENT');
  if (events.length !== validated.masters.size) throw new Error('Incomplete parsed calendar');
  const blocked = new Set();
  const from = new Date(Date.parse(`${start}T00:00:00Z`) - 2 * DAY);
  const to = new Date(Date.parse(`${end}T00:00:00Z`) + 2 * DAY);

  for (const event of events) {
    const source = validated.masters.get(event.uid);
    if (!source || source.properties.has('RRULE') !== Boolean(event.rrule)) {
      throw new Error('Incomplete parsed event');
    }
    if (!(event.start instanceof Date) || !Number.isFinite(event.start.getTime()) ||
        !(event.end instanceof Date) || !Number.isFinite(event.end.getTime()) ||
        event.end < event.start) {
      throw new Error('Invalid event interval');
    }
    if (event.status === 'CANCELLED') continue;
    const isFullDay = event.datetype === 'date' || Boolean(event.start.dateOnly);
    const extraDates = additionalDates(source);
    const overrides = validateOverrides(event, source, extraDates, isFullDay);
    const ranges = rangeExceptions(event, overrides, isFullDay);
    const margin = Math.max(0, ...ranges.map((record) => record.margin));
    const eventFrom = new Date(from.getTime() - margin);
    const eventTo = new Date(to.getTime() + margin);
    addExrules(event, source, eventFrom, eventTo, extraDates, isFullDay);
    if (ranges.some((record) => excluded(event, record.id, isFullDay))) {
      throw new Error('Excluded recurrence range');
    }
    let instances;
    if (!event.rrule && (extraDates.length || event.exdate)) {
      const dates = [event.start, ...extraDates];
      const keys = new Set(dates.map((date) => recurrenceKey(date, isFullDay)));
      for (const override of new Set(Object.values(event.recurrences || {}))) {
        if (!(override.recurrenceid instanceof Date) ||
            !keys.has(recurrenceKey(override.recurrenceid, isFullDay))) {
          throw new Error('Orphaned recurrence exception');
        }
      }
      instances = dates.map((date) => explicitInstance(event, date, isFullDay)).filter(Boolean);
    } else {
      instances = ical.expandRecurringEvent(event, {
        from: eventFrom, to: eventTo, includeOverrides: true, excludeExdates: true, expandOngoing: true
      });
      instances.push(...extraDates.map((date) => explicitInstance(event, date, isFullDay)).filter(Boolean));
    }
    if (instances.length > 10000) throw new Error('Too many instances');
    for (const occurrence of instances) {
      const instance = applyRange(occurrence, ranges, isFullDay);
      if (!instance) continue;
      if (instance.event.status === 'CANCELLED') continue;
      if (instance.isOverride && instance.event.recurrenceid instanceof Date &&
          excluded(event, instance.event.recurrenceid, isFullDay)) continue;
      if (!(instance.start instanceof Date) || !(instance.end instanceof Date) ||
          !Number.isFinite(instance.start.getTime()) || !Number.isFinite(instance.end.getTime()) ||
          instance.end < instance.start) {
        throw new Error('Invalid occurrence');
      }
      const first = instance.isFullDay ? localDate(instance.start) : stockholmDate(instance.start);
      const last = instance.isFullDay
        ? addDays(localDate(instance.end), -1)
        : stockholmDate(new Date(Math.max(instance.start.getTime(), instance.end.getTime() - 1)));
      if (last < first) throw new Error('Invalid occurrence duration');
      let date = first < start ? start : first;
      while (date <= last && date < end) {
        blocked.add(date);
        date = addDays(date, 1);
      }
    }
  }
  return [...blocked].sort();
}

try {
  parentPort.postMessage({ blocked: parseCalendar(workerData.text, workerData.start, workerData.end) });
} catch {
  parentPort.postMessage({ error: true });
}
