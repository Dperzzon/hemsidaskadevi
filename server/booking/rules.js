'use strict';

// Bokningsregler (Airbnb "House Rules") för Skadevi Herrgård.
//
// BESLUTSPUNKT: Regeltexten ska vara exakt samma som på Skadevi Herrgårds
// Airbnb-annons. Texten publiceras i server/booking/house-rules.json:
//   { "published": true, "version": "2026-11-10", "text": "1. ...\n2. ..." }
// Så länge "published" inte är true nekas bokningsförfrågningar av API:et
// och skick-knappen i klienten är avstängd. Texten innehåller inga hemligheter
// och visas publikt i /api/booking-rules när den väl är publicerad.

const fs = require('node:fs/promises');
const path = require('node:path');

const RULES_PATH = path.join(__dirname, 'house-rules.json');

// Läser och validerar regelfilen. Returnerar alltid ett objekt med
// { published, version, text }; ogiltig fil behandlas som "ej publicerad".
// Strukturerade fält (cancellationPolicy, pendingDecisions) följer med internt
// för administration/test — publicRules exponerar aldrig mer än version+text.
function normalizeRules(parsed) {
  if (parsed && parsed.published === true && typeof parsed.version === 'string' &&
      parsed.version.trim() && typeof parsed.text === 'string' && parsed.text.trim()) {
    return {
      published: true,
      version: parsed.version.trim(),
      text: parsed.text,
      pendingDecisions: Array.isArray(parsed.pendingDecisions) ? parsed.pendingDecisions : [],
      cancellationPolicy: parsed.cancellationPolicy ?? null
    };
  }
  return { published: false, version: null, text: '', pendingDecisions: [], cancellationPolicy: null };
}

async function loadRules(options = {}) {
  if (options.rules) {
    return normalizeRules(options.rules);
  }
  try {
    const raw = await fs.readFile(RULES_PATH, 'utf8');
    return normalizeRules(JSON.parse(raw));
  } catch {
    // Saknad eller ogiltig fil: reglerna är inte publicerade.
    return { published: false, version: null, text: '', pendingDecisions: [], cancellationPolicy: null };
  }
}

// Det offentliga svarformatet: aldrig mer än version + text.
function publicRules(rules) {
  if (!rules.published) return { published: false, version: null, text: '' };
  return { published: true, version: rules.version, text: rules.text };
}

module.exports = { loadRules, publicRules, RULES_PATH };
