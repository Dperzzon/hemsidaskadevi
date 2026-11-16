import http from 'node:http';
import path from 'node:path';
import { createAdminRequestListener } from '../server/admin/index.js';
import { createAuth } from '../server/admin/auth.js';
import { createDemoRepository } from '../server/admin/repository/demo.js';
import { createStripeClient, signStripePayload } from '../server/booking/stripe.js';
import { handleStripeWebhook } from '../server/booking/stripe-webhook.js';
import { handlePaymentPage, handlePaymentAction } from '../server/booking/payment-page.js';
import { createRequestListener } from '../server/index.js';

const NOW = new Date('2026-11-16T12:00:00.000Z');
const WEBHOOK_SECRET = 'whsec_local_test_mode';
const sessions = new Map();

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

function close(server) {
  server.closeAllConnections();
  server.close();
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const stripeMock = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = Buffer.concat(chunks).toString('utf8');
  const url = new URL(req.url, 'http://127.0.0.1');
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'POST' && url.pathname === '/v1/checkout/sessions') {
    if (req.headers.authorization !== 'Bearer sk_test_local') {
      res.statusCode = 401;
      res.end(JSON.stringify({ error: { code: 'invalid_api_key', message: 'bad key' } }));
      return;
    }
    const params = new URLSearchParams(body);
    const amount = Number(params.get('line_items[0][price_data][unit_amount]'));
    const reference = params.get('metadata[reference]');
    const paymentMethod = params.get('payment_method_types[0]');
    assert(Number.isSafeInteger(amount) && amount > 0, 'Mock: ogiltigt belopp');
    assert(reference, 'Mock: referens saknas');
    assert(paymentMethod === 'swish', `Mock: oväntad betalmetod ${paymentMethod}`);
    const id = `cs_test_local_${sessions.size + 1}`;
    const session = {
      id,
      object: 'checkout.session',
      mode: 'payment',
      payment_status: 'unpaid',
      status: 'open',
      amount_total: amount,
      currency: params.get('line_items[0][price_data][currency]') ?? 'sek',
      payment_method_types: ['swish'],
      livemode: false,
      payment_intent: `pi_test_local_${sessions.size + 1}`,
      client_reference_id: reference,
      metadata: { reference },
      url: `https://checkout.stripe.com/c/pay/${id}`,
      expires_at: Math.floor(NOW.getTime() / 1000) + 86400
    };
    sessions.set(id, session);
    res.statusCode = 200;
    res.end(JSON.stringify(session));
    return;
  }

  const expire = /^\/v1\/checkout\/sessions\/([^/]+)\/expire$/.exec(url.pathname);
  if (req.method === 'POST' && expire) {
    const session = sessions.get(decodeURIComponent(expire[1]));
    if (!session) {
      res.statusCode = 404;
      res.end(JSON.stringify({ error: { code: 'resource_missing', message: 'missing' } }));
      return;
    }
    session.status = 'expired';
    res.statusCode = 200;
    res.end(JSON.stringify(session));
    return;
  }

  res.statusCode = 404;
  res.end(JSON.stringify({ error: { code: 'not_found', message: 'not found' } }));
});

const stripeMockServer = await listen(stripeMock);
const mockBase = `http://127.0.0.1:${stripeMockServer.address().port}`;
const repository = createDemoRepository({ now: NOW });
const stripeClient = createStripeClient({
  secretKey: 'sk_test_local',
  apiBase: mockBase,
  fetchImpl: fetch
});

const store = {
  async getByReference(reference) {
    return repository.getRawBooking(reference);
  },
  async getByPaymentTokenHash(tokenHash) {
    const bookings = await repository.allBookings(NOW);
    for (const booking of bookings) {
      const raw = await repository.getRawBooking(booking.reference);
      if (raw?.record?.paymentTokenHash === tokenHash) return raw;
    }
    return null;
  },
  async listCalendarByReference(reference) {
    return repository.listCalendarByReference(reference);
  },
  async listCalendar(from, to) {
    return repository.listCalendar(from, to);
  },
  async updateRequest(record, options) {
    return repository.updateRequest(record, options);
  },
  async appendHistory(entry) {
    return repository.appendHistory(entry);
  },
  async save(entry) {
    return repository.saveOutbox(entry);
  }
};

const paymentOptions = {
  store,
  stripeEnabled: true,
  stripeClient,
  publicBaseUrl: 'https://www.skadeviherrgard.com',
  outboxEnabled: true,
  now: NOW
};

const adminListener = createAdminRequestListener({
  auth: createAuth({ demo: true }),
  repository,
  demo: true,
  now: NOW,
  writesEnabled: true,
  requireAirbnbCheck: false,
  stripeEnabled: true,
  stripeMode: 'test',
  publicBaseUrl: 'https://www.skadeviherrgard.com',
  outboxEnabled: true
});
const adminServer = await listen(http.createServer(adminListener));
const adminBase = `http://127.0.0.1:${adminServer.address().port}`;

const publicServer = await listen(http.createServer(createRequestListener({
  root: path.resolve('dist'),
  stripeWebhookHandler: (request, context) => handleStripeWebhook(request, context, {
    enabled: true,
    webhookSecret: WEBHOOK_SECRET,
    store,
    outboxEnabled: true,
    now: NOW
  }),
  paymentPageHandler: (request, context) => handlePaymentPage(request, context, paymentOptions),
  paymentActionHandler: (request, context) => handlePaymentAction(request, context, paymentOptions)
})));
const publicBase = `http://127.0.0.1:${publicServer.address().port}`;

async function createBooking(csrf, email, dates = { arrival: '2027-04-10', departure: '2027-04-13' }) {
  const response = await fetch(`${adminBase}/api/admin/bookings`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-CSRF-Token': csrf,
      'Idempotency-Key': `stripe-test-mode-booking-${Math.random()}`
    },
    body: JSON.stringify({
      mode: 'booking',
      firstName: 'Test',
      lastName: 'Betalning',
      email,
      phone: '+46 70 000 00 00',
      arrival: dates.arrival,
      departure: dates.departure,
      guests: 4,
      bookingSource: 'PHONE',
      statusCode: 'CONFIRMED',
      addons: { slutstad: false, lakan: false, linenCount: 0, ved: false, tidigIncheckning: false, senUtcheckning: false },
      paymentStatus: 'UNPAID',
      amountPaid: 0,
      latestNote: 'Swish testläge'
    })
  });
  const booking = await response.json();
  assert(response.status === 201, `Bokning misslyckades: ${response.status} ${JSON.stringify(booking)}`);
  return booking.reference;
}

async function createPaymentLink(csrf, reference) {
  const response = await fetch(`${adminBase}/api/admin/bookings/${reference}/payment-link`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-CSRF-Token': csrf,
      'Idempotency-Key': `stripe-test-mode-link-${Math.random()}`
    },
    body: '{}'
  });
  const link = await response.json();
  assert(response.status === 201, `Betalningslänk misslyckades: ${response.status} ${JSON.stringify(link)}`);
  assert(link.paymentLink.mode === 'test', 'Betalningslänken är inte i testläge');
  assert(link.paymentLink.url.includes('/betala/'), 'Betalningssida saknas');
  return link;
}

try {
  const sessionResponse = await fetch(`${adminBase}/api/admin/session`);
  const { csrfToken } = await sessionResponse.json();
  assert(csrfToken, 'CSRF-token saknas');

  const reference = await createBooking(csrfToken, 'swish-test@example.se');
  const link = await createPaymentLink(csrfToken, reference);
  const token = link.paymentLink.url.split('/betala/')[1];
  assert(token && token.length === 43, 'Token har fel format');

  const page = await fetch(`${publicBase}/betala/${token}`);
  const pageHtml = await page.text();
  assert(page.status === 200, `Betalningssida misslyckades: ${page.status}`);
  assert(pageHtml.includes('Betala med Swish'), 'Swish-knapp saknas');
  assert(pageHtml.includes('Begär faktura'), 'Fakturaval saknas');
  assert(!/Klarna|kortbetalning/i.test(pageHtml), 'Otillåtet betalningssätt visas');

  const swish = await fetch(`${publicBase}/api/payments/${token}/swish`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: '',
    redirect: 'manual'
  });
  assert(swish.status === 303, `Swish-start misslyckades: ${swish.status}`);
  const checkoutUrl = swish.headers.get('location');
  assert(checkoutUrl?.includes('cs_test_local_'), 'Mockad Checkout-URL saknas');

  const sessionId = checkoutUrl.split('/').pop();
  const checkoutSession = sessions.get(sessionId);
  assert(checkoutSession, 'Mockad Stripe-session saknas');
  assert(checkoutSession.payment_method_types[0] === 'swish', 'Sessionen är inte Swish-only');

  const event = {
    id: 'evt_local_paid_1',
    type: 'checkout.session.completed',
    livemode: false,
    data: {
      object: {
        ...checkoutSession,
        status: 'complete',
        payment_status: 'paid'
      }
    }
  };
  const payload = JSON.stringify(event);
  const signature = signStripePayload(payload, WEBHOOK_SECRET, Math.floor(NOW.getTime() / 1000));

  const webhookResponse = await fetch(`${publicBase}/api/stripe/webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Stripe-Signature': signature },
    body: payload
  });
  assert(webhookResponse.status === 200, `Webhook misslyckades: ${webhookResponse.status}`);
  const webhookBody = await webhookResponse.json();
  assert(webhookBody.received === true, 'Webhook bekräftade inte mottagandet');

  const stored = await repository.getRawBooking(reference);
  assert(stored.record.paymentStatus === 'PAID', 'Betalstatus uppdaterades inte');
  assert(stored.record.payments.length === 1, 'Betalningspost saknas');
  assert(stored.record.payments[0].method === 'SWISH', 'Betalningen registrerades inte som SWISH');
  assert(stored.record.payments[0].stripeSessionId === sessionId, 'Fel Stripe-session sparades');
  assert(stored.record.paymentRequest.status === 'PAID', 'Betalningsbegäran markerades inte betald');

  const duplicateResponse = await fetch(`${publicBase}/api/stripe/webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Stripe-Signature': signature },
    body: payload
  });
  assert(duplicateResponse.status === 200, 'Dubblett-webhook misslyckades');
  const afterDuplicate = await repository.getRawBooking(reference);
  assert(afterDuplicate.record.payments.length === 1, 'Dubblett skapade en extra betalning');

  const invoiceReference = await createBooking(csrfToken, 'faktura-test@example.se', {
    arrival: '2027-06-10',
    departure: '2027-06-13'
  });
  const invoiceLink = await createPaymentLink(csrfToken, invoiceReference);
  const invoiceToken = invoiceLink.paymentLink.url.split('/betala/')[1];
  const invoiceForm = new URLSearchParams({
    requestId: '66666666-6666-4666-8666-666666666666',
    invoiceName: 'Testbolaget AB',
    invoiceOrgNumber: '556677-8899',
    invoiceAddress: 'Storgatan 6',
    invoicePostalCode: '541 30',
    invoiceCity: 'Skövde',
    invoiceEmail: 'faktura@example.se',
    invoiceReference: 'PO-9B',
    invoiceNotes: 'Test av fakturabegäran'
  });
  const invoiceResponse = await fetch(`${publicBase}/api/payments/${invoiceToken}/invoice-request`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: invoiceForm.toString(),
    redirect: 'manual'
  });
  assert(invoiceResponse.status === 303, `Fakturabegäran misslyckades: ${invoiceResponse.status}`);
  const invoiceStored = await repository.getRawBooking(invoiceReference);
  assert(invoiceStored.record.invoiceRequests.length === 1, 'Fakturabegäran saknas');
  assert(invoiceStored.record.invoiceRequests[0].status === 'REQUESTED', 'Fel fakturastatus');
  assert(invoiceStored.record.paymentStatus === 'UNPAID', 'Faktura markerade betalning');

  console.log('Stripe Swish + faktura testläge E2E OK');
  console.log(`  bokning: ${reference}`);
  console.log(`  checkout-session: ${sessionId}`);
  console.log(`  betalmetod: ${stored.record.payments[0].method}`);
  console.log(`  betalstatus: ${stored.record.paymentStatus}`);
  console.log(`  fakturabegäran: ${invoiceStored.record.invoiceRequests[0].status}`);
  console.log('  inga riktiga debiteringar gjordes');
} finally {
  close(adminServer);
  close(publicServer);
  close(stripeMockServer);
}
