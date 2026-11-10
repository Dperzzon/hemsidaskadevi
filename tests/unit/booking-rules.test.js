// Enhetstester för bokningsreglernas laddning (server/booking/rules.js).
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadRules, publicRules } = require('../../server/booking/rules');

test('injektade publicerade regler godtas', async () => {
  const rules = await loadRules({ rules: { published: true, version: '2026-11-10', text: 'Regler.' } });
  assert.equal(rules.published, true);
  assert.equal(rules.version, '2026-11-10');
});

test('injektade ofullständiga regler behandlas som opublicerade', async () => {
  for (const rules of [
    { published: true, version: '', text: 'Regler.' },
    { published: true, version: '2026-11-10', text: '   ' },
    { published: false, version: '2026-11-10', text: 'Regler.' }
  ]) {
    const result = await loadRules({ rules });
    assert.equal(result.published, false);
  }
});

test('filen i repot publicerar de beslutade reglerna (version 2026-11-10-v2)', async () => {
  const rules = await loadRules();
  assert.equal(rules.published, true);
  assert.equal(rules.version, '2026-11-10-v2');
  assert.ok(rules.text.length > 0);
});

test('avbokningspolicyn stämmer med beslutet (100/50 %, dagsgränser)', async () => {
  const rules = await loadRules();
  assert.match(rules.text, /Begränsad/);
  assert.match(rules.text, /Avbokning minst 30 dagar före incheckning: 100 % återbetalning/);
  assert.match(rules.text, /Avbokning från 7 dagar till mindre än 30 dagar före incheckning: 50 % återbetalning/);
  // Beräkningsgrund ska vara tydlig och lagstadgade rättigheter inte åsidosättas.
  assert.match(rules.text, /beräknas på den bekräftade boendesumman enligt offerten/);
  assert.match(rules.text, /inte era lagstadgade konsumenträttigheter/);
  // Villkoret under 7 dagar är ännu inte beslutat och ska flaggas, inte hittas på.
  assert.match(rules.text, /specificeras vid bekräftelse/);
  assert.ok(rules.pendingDecisions.includes('avbokning-mindre-an-7-dagar'));
  assert.deepEqual(rules.cancellationPolicy.tiers, [
    { minDaysBefore: 30, percent: 100 },
    { minDaysBefore: 7, percent: 50 }
  ]);
});

test('husreglerna stämmer med beslutet', async () => {
  const rules = await loadRules();
  assert.match(rules.text, /Ingen rökning/);
  assert.match(rules.text, /Lås alla dörrar och stäng alla fönster vid avfärd/);
  assert.match(rules.text, /max två husdjur/);
  assert.match(rules.text, /Inga katter/);
});

test('regelversionen ändras när villkoren ändras (versionshantering bevaras)', async () => {
  const rules = await loadRules();
  // Tidigare version var 2026-11-10; den nya texten kräver en ny version.
  assert.notEqual(rules.version, '2026-11-10');
});

test('publicRules läcker aldrig mer än version + text', async () => {
  assert.deepEqual(publicRules({ published: false, version: null, text: '' }), { published: false, version: null, text: '' });
  const published = publicRules({ published: true, version: 'v1', text: 'Regler.' });
  assert.deepEqual(published, { published: true, version: 'v1', text: 'Regler.' });
});
