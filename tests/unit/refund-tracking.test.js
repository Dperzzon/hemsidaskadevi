'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  calculateRefund,
  applyManualRefund,
  mergeStripeRefunds
} = require('../../server/booking/refunds');
const { recordRefund, requestReconciliation } = require('../../server/admin/refund-service');

const NOW = new Date('2026-11-21T12:00:00Z');

function record(overrides = {}) {
  return {
    reference: 'SK-REFUND-1',
    statusCode: 'CANCELLED',
    arrival: '2026-12-30',
    departure: '2027-01-02',
    total: 10000,
    totalAddons: 2000,
    lodgingAfterDiscount: 8000,
    cancelledAt: '2026-11-01T10:00:00Z',
    payments: [{
      id: 'pay-1',
      type: 'PAYMENT',
      method: 'CARD',
      amountOre: 1000000,
      currency: 'SEK',
      paidAt: '2026-11-01T10:00:00Z',
      createdAt: '2026-11-01T10:00:00Z',
      stripeSessionId: 'cs_1',
      stripePaymentIntentId: 'pi_1'
    }],
    ...overrides
  };
}

function memoryRepo(initial) {
  const state = { record: JSON.parse(JSON.stringify(initial)), etag: 'e1', history: [] };
  return {
    state,
    async getRawBooking() { return { record: JSON.parse(JSON.stringify(state.record)), etag: state.etag }; },
    async getByReference() { return this.getRawBooking(); },
    async updateRequest(next, { ifMatch }) {
      if (ifMatch && ifMatch !== state.etag) {
        const error = new Error('ETag');
        error.status = 409;
        throw error;
      }
      state.record = JSON.parse(JSON.stringify(next));
      state.etag = `e${Number(state.etag.slice(1)) + 1}`;
      return { record: JSON.parse(JSON.stringify(state.record)), etag: state.etag };
    },
    async appendHistory(entry) { state.history.push(entry); }
  };
}

test('återbetalning beräknas på boendesumman, inte på tillval', () => {
  const summary = calculateRefund(record(), { now: NOW });
  assert.equal(summary.basisOre, 800000);
  assert.equal(summary.percent, 100);
  assert.equal(summary.calculatedOre, 800000);
  assert.equal(summary.remainingOre, 800000);
  assert.equal(summary.status, 'READY');
});

test('50 procent och 0 procent följer avbokningspolicyn', () => {
  const partial = calculateRefund(record({ cancelledAt: '2026-12-10T10:00:00Z' }), { now: NOW });
  assert.equal(partial.percent, 50);
  assert.equal(partial.calculatedOre, 400000);
  const none = calculateRefund(record({ cancelledAt: '2026-12-20T10:00:00Z' }), { now: NOW });
  assert.equal(none.percent, 0);
  assert.equal(none.calculatedOre, 0);
  assert.equal(none.status, 'NOT_DUE');
});

test('återbetalning kan aldrig överstiga betalt belopp', () => {
  const summary = calculateRefund(record({
    total: 9000,
    totalAddons: 0,
    lodgingAfterDiscount: 9000,
    payments: [{
      id: 'p', type: 'PAYMENT', method: 'CARD', amountOre: 100000,
      createdAt: NOW.toISOString(), paidAt: NOW.toISOString()
    }]
  }), { now: NOW });
  assert.equal(summary.calculatedOre, 100000);
});

test('manuell återbetalning är idempotent och stoppar dubbelåterbetalning', () => {
  const current = record();
  const first = applyManualRefund(current, {
    status: 'COMPLETED',
    amountOre: 400000,
    stripeRefundId: 're_1',
    idempotencyKey: 'refund-key-1'
  }, { now: NOW, actor: { name: 'Owner' } });
  assert.equal(first.ok, true);
  const withRefund = { ...current, refunds: first.refunds };
  const duplicate = applyManualRefund(withRefund, {
    status: 'COMPLETED',
    amountOre: 400000,
    stripeRefundId: 're_1',
    idempotencyKey: 'refund-key-1'
  }, { now: NOW, actor: { name: 'Owner' } });
  assert.equal(duplicate.duplicate, true);
  const tooMuch = applyManualRefund(withRefund, {
    status: 'COMPLETED',
    amountOre: 500000,
    stripeRefundId: 're_2',
    idempotencyKey: 'refund-key-2'
  }, { now: NOW, actor: { name: 'Owner' } });
  assert.equal(tooMuch.ok, false);
  assert.equal(tooMuch.code, 'REFUND_EXCEEDS_REMAINING');
});

test('Stripe-återbetalning blir auktoritativ och markerar genomförd', () => {
  const merged = mergeStripeRefunds(record(), [{
    id: 're_stripe_1',
    amount: 400000,
    status: 'succeeded',
    created: Math.floor(NOW.getTime() / 1000)
  }], NOW);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].status, 'COMPLETED');
  assert.equal(merged[0].source, 'STRIPE');
  const summary = calculateRefund({ ...record(), refunds: merged }, { now: NOW });
  assert.equal(summary.completedOre, 400000);
  assert.equal(summary.remainingOre, 400000);
  assert.equal(summary.status, 'PARTIAL');
});

test('admin registrerar återbetalning med Owner-skydd och idempotens', async () => {
  const repo = memoryRepo(record());
  const owner = { id: 'u1', name: 'Owner', roles: ['Owner'] };
  const input = {
    status: 'COMPLETED',
    amountOre: 400000,
    stripeRefundId: 're_admin_1',
    confirm: true,
    idempotencyKey: 'admin-refund-1'
  };
  const first = await recordRefund(repo, owner, 'SK-REFUND-1', input, { now: NOW, idempotencyKey: 'admin-refund-1' }, {});
  assert.equal(first.status, 201);
  const duplicate = await recordRefund(repo, owner, 'SK-REFUND-1', input, { now: NOW, idempotencyKey: 'admin-refund-1' }, {});
  assert.equal(duplicate.status, 200);
  assert.equal(duplicate.jsonBody.duplicate, true);
  assert.equal(repo.state.record.refunds.length, 1);
  const denied = await recordRefund(repo, { id: 'u2', roles: [] }, 'SK-REFUND-1', input, { now: NOW, idempotencyKey: 'x' }, {});
  assert.equal(denied.status, 403);
});

test('admin kan begära avstämning men inte för en bekräftad bokning', async () => {
  const repo = memoryRepo({ ...record(), statusCode: 'PENDING_PAYMENT' });
  const owner = { id: 'u1', name: 'Owner', roles: ['Owner'] };
  const requested = await requestReconciliation(repo, owner, 'SK-REFUND-1', { reason: 'Kontroll' }, { now: NOW }, {});
  assert.equal(requested.status, 202);
  assert.equal(repo.state.record.reconciliationRequest.status, 'REQUESTED');
  const notApplicable = await requestReconciliation(memoryRepo(record({ statusCode: 'CONFIRMED' })), owner, 'SK-REFUND-1', {}, { now: NOW }, {});
  assert.equal(notApplicable.status, 422);
});
