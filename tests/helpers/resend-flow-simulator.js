'use strict';

// Steg 7O: lokal kontraktssimulator för Resend-utkorgen.
//
// VIKTIGT: Detta är INTE Azure Logic Apps-runtime. Simulatorn efterliknar
// testworkflowets utkorgslogik (mottagarspärr, 24h/maxförsök, ETag-anspråk,
// idempotensnyckel och HTTP-återförsök) och använder konstanter från den
// faktiska testdefinitionen. Riktig Azure-körning verifieras först i ett
// separat E2E-test.

const fs = require('node:fs');
const path = require('node:path');

const workflowPath = path.join(__dirname, '..', '..', 'infra', 'logicapp', 'email-notifier-test.workflow.json');

function loadTestWorkflow() {
  return JSON.parse(fs.readFileSync(workflowPath, 'utf8'));
}

function extractWorkflowContract(workflow = loadTestWorkflow()) {
  const loop = workflow.actions.Om_det_finns_poster.actions.Behandla_varje_post.actions;
  const guard = loop.Tillaten_mottagare;
  if (!guard) throw new Error('Testworkflowet saknar Tillaten_mottagare');
  const allowedRecipients = [...guard.expression.matchAll(/'([^']+@[^']+)'/g)].map((m) => m[1]);
  const maxAttempts = workflow.parameters.maxAttempts.defaultValue;
  const send = guard.actions.Osaker_dubbelutskick.else.actions.Skicka_mejl_resend;
  const retryPolicy = send.inputs.retryPolicy;
  const idempotencyHeader = Object.keys(send.inputs.headers)
    .find((name) => name.toLowerCase() === 'idempotency-key');
  if (!retryPolicy) throw new Error('Testworkflowet saknar retryPolicy');
  if (!idempotencyHeader) throw new Error('Testworkflowet saknar Idempotency-Key');
  return {
    allowedRecipients,
    maxAttempts,
    retryPolicy,
    idempotencyHeader,
    send,
    workflow
  };
}

function normalizeRecipient(value) {
  return String(value ?? '').trim().toLowerCase();
}

function createOutboxRow(overrides = {}) {
  const version = overrides._version ?? 1;
  return {
    PartitionKey: 'outbox',
    RowKey: 'outbox-TEST-SKADEVI-001-host',
    status: 'Utkorg',
    attemptCount: 0,
    attemptedAt: '',
    mailTo: 'skadevigard@gmail.com',
    mailReplyTo: 'skadevigard@gmail.com',
    mailSubject: '[TEST] Ny bokningsförfrågan TEST-SKADEVI-001',
    mailHtml: '<p>Test</p>',
    mailText: 'Test',
    etag: `W/"${version}"`,
    _version: version,
    ...overrides
  };
}

function patchRow(row, body) {
  Object.assign(row, body);
  row._version = (row._version ?? 1) + 1;
  row.etag = `W/"${row._version}"`;
}

function isRetryable(status) {
  return status === 408 || status === 429 || status >= 500;
}

function isEligible(row, maxAttempts) {
  return row.status === 'Skickar'
    || (['Utkorg', 'Misslyckad'].includes(row.status) && row.attemptCount < maxAttempts);
}

function isUncertainOrStale(row, maxAttempts, nowMs) {
  if (row.status === 'Skickar' && row.attemptCount >= maxAttempts) return true;
  if (row.attemptCount > 0 && row.attemptedAt) {
    const attemptedMs = Date.parse(row.attemptedAt);
    if (Number.isFinite(attemptedMs) && attemptedMs < nowMs - 24 * 60 * 60 * 1000) return true;
  }
  return false;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function assertLocalUrl(url) {
  const parsed = new URL(url);
  if (!['127.0.0.1', 'localhost'].includes(parsed.hostname)) {
    throw new Error(`Blockerad icke-lokal HTTP-adress: ${parsed.hostname}`);
  }
  return parsed;
}

async function processPoll(outbox, options = {}) {
  const contract = options.contract ?? extractWorkflowContract();
  const allowed = new Set(contract.allowedRecipients.map(normalizeRecipient));
  const fetchImpl = options.fetchImpl ?? fetch;
  const guardedFetch = (url, init) => {
    assertLocalUrl(url);
    return fetchImpl(url, init);
  };
  const now = options.now ?? (() => new Date().toISOString());
  const nowIso = now();
  const nowMs = Date.parse(nowIso);
  const secretValue = options.secretValue ?? 'test-mock-key';
  const result = {
    sent: [],
    failed: [],
    manual: [],
    blocked: [],
    stale: [],
    attempts: []
  };

  for (const row of outbox) {
    if (!isEligible(row, contract.maxAttempts)) continue;

    if (!allowed.has(normalizeRecipient(row.mailTo))) {
      patchRow(row, {
        status: 'Kräver manuell kontroll',
        failedAt: now(),
        deliveryStatus: 'Blockerad av testmottagarspärr',
        manualReviewReason: 'Testworkflow: mottagaren är inte tillåten'
      });
      result.blocked.push(row);
      result.manual.push(row);
      continue;
    }

    if (isUncertainOrStale(row, contract.maxAttempts, nowMs)) {
      patchRow(row, {
        status: 'Kräver manuell kontroll',
        failedAt: now(),
        deliveryStatus: 'Osäker leveransstatus',
        manualReviewReason: 'Osäker leverans eller försök äldre än 24 timmar'
      });
      result.manual.push(row);
      continue;
    }

    // Simulerad Key Vault-hämtning: ingen Azure-trafik, endast ett testvärde.
    if (!secretValue) continue;

    const expectedEtag = row.etag;
    if (options.beforeClaim) options.beforeClaim(row);
    if (row.etag !== expectedEtag) {
      result.stale.push(row);
      continue;
    }
    patchRow(row, {
      status: 'Skickar',
      attemptedAt: now(),
      attemptCount: row.attemptCount + 1
    });

    const body = {
      from: options.mailFrom ?? 'onboarding@resend.dev',
      to: row.mailTo,
      reply_to: row.mailReplyTo || options.mailReplyTo || 'skadevigard@gmail.com',
      subject: row.mailSubject,
      html: row.mailHtml,
      text: row.mailText
    };
    const headers = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${secretValue}`,
      [contract.idempotencyHeader]: row.RowKey
    };

    let response = null;
    const totalAttempts = contract.retryPolicy.count + 1;
    for (let attempt = 1; attempt <= totalAttempts; attempt += 1) {
      try {
        response = await guardedFetch(options.resendApiUrl, {
          method: 'POST',
          headers,
          body: JSON.stringify(body)
        });
        result.attempts.push({
          rowKey: row.RowKey,
          attempt,
          status: response.status,
          idempotencyKey: row.RowKey
        });
        if (!isRetryable(response.status) || attempt === totalAttempts) break;
      } catch (error) {
        response = null;
        result.attempts.push({
          rowKey: row.RowKey,
          attempt,
          status: error.name === 'AbortError' ? 'timeout' : 'network-error',
          idempotencyKey: row.RowKey
        });
        if (attempt === totalAttempts) break;
      }
      if (options.retryDelayMs) await sleep(options.retryDelayMs);
    }

    if (response && response.status === 200) {
      const payload = await response.json();
      patchRow(row, {
        status: 'Skickad',
        sentAt: now(),
        resendId: payload.id,
        deliveryStatus: 'Inväntar leveranskontroll'
      });
      result.sent.push(row);
    } else if (response && response.status === 409) {
      patchRow(row, {
        status: 'Kräver manuell kontroll',
        failedAt: now(),
        deliveryStatus: 'Idempotenskonflikt hos Resend (409)',
        manualReviewReason: 'HTTP 409 från Resend: samma Idempotency-Key med avvikande innehåll'
      });
      result.manual.push(row);
    } else {
      const isManual = row.attemptCount >= contract.maxAttempts;
      patchRow(row, {
        status: isManual ? 'Kräver manuell kontroll' : 'Misslyckad',
        failedAt: now(),
        deliveryStatus: 'Skick misslyckades',
        manualReviewReason: isManual ? 'Alla återförsök förbrukade utan bekräftat resultat' : ''
      });
      result.failed.push(row);
      if (isManual) result.manual.push(row);
    }
  }

  return result;
}

module.exports = {
  loadTestWorkflow,
  extractWorkflowContract,
  createOutboxRow,
  processPoll,
  normalizeRecipient,
  isRetryable,
  assertLocalUrl
};
