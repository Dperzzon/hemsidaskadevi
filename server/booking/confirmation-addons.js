'use strict';

// En gemensam tolkning av bokningens tillval inför bekräftelser, PDF:er och
// adminvisning. Historiska poster kan sakna addonLines trots att addons och
// totalsumman finns kvar. Då rekonstrueras raderna från den sparade
// prisversionen. Om uppgifterna inte kan stämma av säkert returneras
// ok=false och bekräftelsemejlet får inte skickas automatiskt.

const { quote, PRICE_VERSION } = require('./pricing');
const { bufferNightsFor } = require('./buffer-nights');

const ISSUE = Object.freeze({
  ADDON_LINES_MISSING: 'ADDON_LINES_MISSING',
  ADDON_LINES_INCONSISTENT: 'ADDON_LINES_INCONSISTENT',
  ADDON_LINES_MISMATCH: 'ADDON_LINES_MISMATCH',
  ADDON_TOTAL_MISMATCH: 'ADDON_TOTAL_MISMATCH',
  ADDON_SELECTION_WITHOUT_LINES: 'ADDON_SELECTION_WITHOUT_LINES',
  ADDON_LINES_WITHOUT_SELECTION: 'ADDON_LINES_WITHOUT_SELECTION',
  BUFFER_MISMATCH: 'BUFFER_MISMATCH'
});

const WARNING = Object.freeze({
  ADDON_LINES_RECONSTRUCTED: 'ADDON_LINES_RECONSTRUCTED'
});

function parseObject(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function finite(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function sameAmount(a, b) {
  return Math.abs(Number(a) - Number(b)) < 0.005;
}

function normalizeLine(line = {}) {
  return {
    id: String(line.id ?? ''),
    label: String(line.label ?? 'Tillval').trim() || 'Tillval',
    quantity: finite(line.quantity) ?? 1,
    unitPrice: finite(line.unitPrice),
    amount: finite(line.amount)
  };
}

function storedAddonLines(record = {}) {
  const pricing = parseObject(record.pricing);
  const source = Array.isArray(record.addonLines)
    ? record.addonLines
    : Array.isArray(pricing?.addonLines)
      ? pricing.addonLines
      : [];
  return source.map(normalizeLine).filter((line) => line.label);
}

function selectedAddon(addons = {}) {
  return addons.slutstad === true ||
    addons.ved === true ||
    addons.tidigIncheckning === true ||
    addons.senUtcheckning === true ||
    addons.extrahus === true ||
    addons.lakan === true;
}

function lineIssues(lines = []) {
  const issues = [];
  for (const line of lines) {
    if (!Number.isFinite(line.quantity) || line.quantity < 0) {
      issues.push(`${line.label}: ogiltigt antal`);
    }
    if (!Number.isFinite(line.amount) || line.amount < 0) {
      issues.push(`${line.label}: ogiltigt belopp`);
    }
    if (Number.isFinite(line.unitPrice) && Number.isFinite(line.quantity) &&
        Number.isFinite(line.amount) && !sameAmount(line.unitPrice * line.quantity, line.amount)) {
      issues.push(`${line.label}: antal × pris stämmer inte med beloppet`);
    }
  }
  return issues;
}

function linesTotal(lines = []) {
  return lines.reduce((sum, line) => sum + (Number.isFinite(line.amount) ? line.amount : 0), 0);
}

function sameLines(left = [], right = []) {
  if (left.length !== right.length) return false;
  const byId = (lines) => new Map(lines.map((line) => [line.id || line.label, line]));
  const a = byId(left);
  const b = byId(right);
  if (a.size !== b.size) return false;
  for (const [key, line] of a) {
    const other = b.get(key);
    if (!other) return false;
    if (!sameAmount(line.quantity, other.quantity)) return false;
    if (!sameAmount(line.amount, other.amount)) return false;
    if (Number.isFinite(line.unitPrice) && Number.isFinite(other.unitPrice) &&
        !sameAmount(line.unitPrice, other.unitPrice)) return false;
  }
  return true;
}

function expectedPricing(record = {}) {
  const addons = parseObject(record.addons);
  if (!addons) return null;
  if (!record.arrival || !record.departure) return null;
  const version = String(record.priceVersion ?? '').trim();
  if (version && version !== PRICE_VERSION) return null;
  try {
    return quote({
      arrival: String(record.arrival),
      departure: String(record.departure),
      guests: Number(record.guests) || 0,
      addons
    });
  } catch {
    return null;
  }
}

function totalMatches(record, addonAmount, total) {
  if (total === null || total === undefined) return true;
  const agreed = finite(record.agreedTotal);
  if (agreed !== null) return sameAmount(total, agreed);
  const hasLodging = finite(record.lodgingAfterDiscount) !== null || finite(record.lodgingBase) !== null;
  if (!hasLodging) return true;
  const lodging = finite(record.lodgingAfterDiscount) ?? finite(record.lodgingBase) ?? 0;
  return sameAmount(total, lodging + addonAmount);
}

function resolveConfirmationAddons(record = {}, options = {}) {
  const addons = parseObject(record.addons) ?? {};
  const stored = storedAddonLines(record);
  const hasSelection = selectedAddon(addons) || stored.length > 0;
  const totalAddonsRaw = record.totalAddons;
  const hasSavedAddonsTotal = totalAddonsRaw !== undefined && totalAddonsRaw !== null &&
    String(totalAddonsRaw).trim() !== '';
  const savedAddonsTotal = hasSavedAddonsTotal ? Number(totalAddonsRaw) : null;
  const total = finite(record.total);
  const issues = [];
  const warnings = [];
  let lines = [];
  let source = 'none';

  if (!hasSelection) {
    if (stored.length) {
      issues.push({
        code: ISSUE.ADDON_LINES_WITHOUT_SELECTION,
        message: 'Bokningen saknar tillvalsval men har sparade tillvalsrader.'
      });
    }
    if (hasSavedAddonsTotal && !sameAmount(savedAddonsTotal, 0)) {
      issues.push({
        code: ISSUE.ADDON_TOTAL_MISMATCH,
        message: 'Bokningen saknar tillvalsval men har en tillvalssumma.'
      });
    }
    if (issues.length === 0) {
      return { ok: true, lines: [], totalAddons: 0, total, issues, warnings, source };
    }
    return { ok: false, lines: [], totalAddons: savedAddonsTotal ?? 0, total, issues, warnings, source };
  }

  const expected = expectedPricing(record);
  const storedSum = linesTotal(stored);
  const arithmetic = lineIssues(stored);
  const storedTotalOk = !hasSavedAddonsTotal || sameAmount(storedSum, savedAddonsTotal);
  const storedTotalMatchesBooking = totalMatches(record, storedSum, total);

  if (stored.length) {
    lines = stored;
    source = 'stored';
    if (arithmetic.length) {
      issues.push({
        code: ISSUE.ADDON_LINES_INCONSISTENT,
        message: `Tillvalsraderna är inkonsekventa: ${arithmetic.join('; ')}.`
      });
    } else if (!storedTotalOk) {
      issues.push({
        code: ISSUE.ADDON_TOTAL_MISMATCH,
        message: 'Tillvalsradernas summa stämmer inte med bokningens sparade tillvalssumma.'
      });
    } else if (!storedTotalMatchesBooking) {
      issues.push({
        code: ISSUE.ADDON_TOTAL_MISMATCH,
        message: 'Bokningens totalpris stämmer inte med boende plus tillval.'
      });
    } else if (expected && stored.every((line) => line.id) && !sameLines(stored, expected.addonLines)) {
      issues.push({
        code: ISSUE.ADDON_LINES_MISMATCH,
        message: 'Sparade tillvalsrader stämmer inte med bokningens tillvalsval och prisunderlag.'
      });
    } else {
      lines = stored;
      source = 'stored';
    }
  } else if (expected) {
    lines = expected.addonLines;
    source = 'recomputed';
    warnings.push({
      code: WARNING.ADDON_LINES_RECONSTRUCTED,
      message: 'Saknade tillvalsrader rekonstruerades från bokningens sparade tillvalsval och prisversion.'
    });
    const expectedTotalOk = hasSavedAddonsTotal
      ? sameAmount(expected.addonsTotal, savedAddonsTotal)
      : true;
    if (!expectedTotalOk) {
      issues.push({
        code: ISSUE.ADDON_TOTAL_MISMATCH,
        message: 'Det finns tillvalsval men den sparade tillvalssumman stämmer inte med prisunderlaget.'
      });
    } else if (!totalMatches(record, expected.addonsTotal, total)) {
      issues.push({
        code: ISSUE.ADDON_TOTAL_MISMATCH,
        message: 'Bokningens totalpris stämmer inte med boende plus tillval.'
      });
    }
  } else {
    issues.push({
      code: ISSUE.ADDON_LINES_MISSING,
      message: 'Bokningen har tillvalsval men saknar tillvalsrader som kan verifieras.'
    });
  }

  if (lines.length) {
    const sum = linesTotal(lines);
    if (hasSavedAddonsTotal && !sameAmount(sum, savedAddonsTotal)) {
      issues.push({
        code: ISSUE.ADDON_TOTAL_MISMATCH,
        message: 'Tillvalsradernas summa stämmer inte med bokningens sparade tillvalssumma.'
      });
    }
    if (!totalMatches(record, sum, total)) {
      issues.push({
        code: ISSUE.ADDON_TOTAL_MISMATCH,
        message: 'Bokningens totalpris stämmer inte med boende plus tillval.'
      });
    }
  }

  if (options.checkBuffers !== false && record.bufferNightsMode === 'auto' &&
      record.arrival && record.departure) {
    const expectedBuffers = bufferNightsFor({ ...record, addons });
    const actualBuffers = Array.isArray(record.bufferNights)
      ? [...new Set(record.bufferNights.map(String))].sort()
      : [];
    if (expectedBuffers.join('|') !== actualBuffers.join('|')) {
      issues.push({
        code: ISSUE.BUFFER_MISMATCH,
        message: 'Kalenderbuffertarna stämmer inte med vald tidig incheckning och sen utcheckning.'
      });
    }
  }

  return {
    ok: issues.length === 0,
    lines,
    totalAddons: hasSavedAddonsTotal ? savedAddonsTotal : linesTotal(lines),
    total,
    issues: [...new Map(issues.map((issue) => [`${issue.code}|${issue.message}`, issue])).values()],
    warnings,
    source
  };
}

function confirmationDataError(resolution) {
  const message = resolution.issues.map((issue) => issue.message).join(' ');
  const error = new Error(`Bokningsbekräftelsen kan inte skapas säkert. ${message}`.trim());
  error.code = 'CONFIRMATION_DATA_CONFLICT';
  error.issues = resolution.issues;
  error.resolution = resolution;
  return error;
}

module.exports = {
  ISSUE,
  WARNING,
  resolveConfirmationAddons,
  confirmationDataError
};
