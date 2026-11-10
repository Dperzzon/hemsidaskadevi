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

test('filen i repot publicerar de beslutade reglerna (version 2026-11-10)', async () => {
  const rules = await loadRules();
  assert.equal(rules.published, true);
  assert.equal(rules.version, '2026-11-10');
  assert.ok(rules.text.length > 0);
});

test('avbokningspolicyn stämmer med beslutet', async () => {
  const rules = await loadRules();
  assert.match(rules.text, /Begränsad/);
  assert.match(rules.text, /Fullständig återbetalning vid avbokning minst 30 dagar före incheckning/);
  assert.match(rules.text, /Delvis återbetalning vid avbokning 7–30 dagar före incheckning/);
  // Nivån för delvis återbetalning är inte påhittad: den ska vara markerad
  // som "specificeras vid bekräftelse".
  assert.match(rules.text, /specificeras vid bekräftelse/);
});

test('husreglerna stämmer med beslutet', async () => {
  const rules = await loadRules();
  assert.match(rules.text, /Ingen rökning/);
  assert.match(rules.text, /Lås alla dörrar och stäng alla fönster vid avfärd/);
  assert.match(rules.text, /max två husdjur/);
  assert.match(rules.text, /Inga katter/);
});

test('publicRules läcker aldrig mer än version + text', async () => {
  assert.deepEqual(publicRules({ published: false, version: null, text: '' }), { published: false, version: null, text: '' });
  const published = publicRules({ published: true, version: 'v1', text: 'Regler.' });
  assert.deepEqual(published, { published: true, version: 'v1', text: 'Regler.' });
});
