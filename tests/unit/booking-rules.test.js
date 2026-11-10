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

test('filen i repot är opublicerad tills riktiga regler lämnats in', async () => {
  const rules = await loadRules();
  assert.equal(rules.published, false);
  assert.equal(rules.text, '');
});

test('publicRules läcker aldrig mer än version + text', async () => {
  assert.deepEqual(publicRules({ published: false, version: null, text: '' }), { published: false, version: null, text: '' });
  const published = publicRules({ published: true, version: 'v1', text: 'Regler.' });
  assert.deepEqual(published, { published: true, version: 'v1', text: 'Regler.' });
});
