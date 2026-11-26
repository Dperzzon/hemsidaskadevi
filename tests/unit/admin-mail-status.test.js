'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeBooking,
  normalizeEmailStatus,
  normalizeMailLevel
} = require('../../server/admin/domain');
const { deriveWarnings, WARNING } = require('../../server/admin/warnings');
const { renderBookingDetail } = require('../../server/admin/views/booking-detail');

const ACCEPTED_TEXT = 'Accepterat av Resend – slutlig leverans ej verifierad.';

function booking(overrides = {}) {
  return normalizeBooking({
    idempotencyKey: 'mail-test-1',
    RowKey: 'mail-test-1',
    reference: 'SK-2026-MAIL1',
    status: 'Bekräftad',
    statusCode: 'CONFIRMED',
    arrival: '2030-05-10',
    departure: '2030-05-13',
    nights: 3,
    guests: 4,
    total: 1000,
    lodgingBase: 1000,
    paymentStatus: 'PAID',
    amountPaid: 1000,
    bookingSource: 'WEB',
    createdAt: '2026-11-01T00:00:00.000Z',
    confirmedAt: '2026-11-26T09:00:00.000Z',
    ...overrides
  });
}

function outboxRow(overrides = {}) {
  return {
    reference: 'SK-2026-MAIL1',
    mailType: 'GUEST_BOOKING_CONFIRMED',
    mailSubject: 'Din bokning är bekräftad',
    status: 'Skickad',
    deliveryStatus: 'Accepterad av Resend – leverans ej verifierad',
    resendId: 'resend-1',
    attemptCount: 1,
    attemptedAt: '2026-11-26T09:01:00.000Z',
    sentAt: '2026-11-26T09:01:05.000Z',
    createdAt: '2026-11-26T09:00:00.000Z',
    ...overrides
  };
}

test('accepterat men ej leveransverifierat mejl visar exakt ärlig status', () => {
  const level = normalizeMailLevel(outboxRow());
  assert.equal(level.apiLabel, 'Accepterat av Resend');
  assert.equal(level.deliveryLabel, 'Accepterat – leverans ej verifierad');
  assert.equal(level.deliveryUnverified, true);
  assert.equal(level.verifiedDelivery, false);
  assert.equal(level.verificationText, ACCEPTED_TEXT);
  assert.equal(level.recipientLabel, 'Gäst');
  assert.equal(level.subject, 'Din bokning är bekräftad');
  assert.equal(level.resendId, 'resend-1');
  assert.equal(level.timeline.find((step) => step.key === 'accepted').state, 'done');
  assert.equal(level.timeline.find((step) => step.key === 'delivered').state, 'unknown');
});

test('levererat mejl visas som levererat först när leveranshändelse finns', () => {
  const level = normalizeMailLevel(outboxRow({
    deliveryStatus: 'delivered',
    deliveredAt: '2026-11-26T09:02:00.000Z',
    lastEventType: 'email.delivered',
    lastEventAt: '2026-11-26T09:02:00.000Z'
  }));
  assert.equal(level.deliveryLabel, 'Levererat');
  assert.equal(level.verifiedDelivery, true);
  assert.equal(level.deliveryUnverified, false);
  assert.match(level.verificationText, /Levererat till mottagarens mejlserver/);
  assert.equal(level.timeline.find((step) => step.key === 'delivered').state, 'done');
});

test('studsat mejl visas som leveransfel och kräver manuell kontroll', () => {
  const level = normalizeMailLevel(outboxRow({
    deliveryStatus: 'bounced',
    bouncedAt: '2026-11-26T09:02:00.000Z',
    deliveryError: 'Permanent/General',
    lastEventType: 'email.bounced'
  }));
  assert.equal(level.deliveryLabel, 'Studsat');
  assert.equal(level.deliveryFailed, true);
  assert.equal(level.verifiedDelivery, false);
  assert.match(level.verificationText, /misslyckades/);
  assert.equal(level.timeline.find((step) => step.key === 'failed').state, 'danger');
});

test('aktuell utkorgspost vinner över en gammal sparad emailStatus', () => {
  const status = normalizeEmailStatus({
    emailStatus: {
      host: { status: 'Kräver manuell kontroll', deliveryStatus: 'unknown', resendId: 'gammal-host' },
      guest: { status: 'Kräver manuell kontroll', deliveryStatus: 'unknown', resendId: 'gammal-guest' }
    }
  }, [
    outboxRow({
      mailType: 'GUEST_BOOKING_CONFIRMED',
      status: 'Skickad',
      deliveryStatus: 'delivered',
      deliveredAt: '2026-11-26T09:02:00.000Z',
      sentAt: '2026-11-26T09:01:05.000Z'
    })
  ]);
  assert.equal(status.guest.deliveryLabel, 'Levererat');
  assert.equal(status.guest.verifiedDelivery, true);
  assert.equal(status.host.apiLabel, 'Kräver manuell kontroll');
});

test('mejlväntan, leveransfel och accepterad men overifierad leverans ger olika varningar', () => {
  const pending = deriveWarnings(booking({
    emailStatus: {
      host: { mailType: 'HOST_NEW_REQUEST', status: 'Utkorg', deliveryStatus: 'Ej skickad', createdAt: '2026-11-26T09:00:00.000Z' },
      guest: { mailType: 'GUEST_REQUEST_ACK', status: 'Skickar', deliveryStatus: 'Ej skickad', createdAt: '2026-11-26T09:00:00.000Z' }
    }
  }));
  assert.ok(pending.some((warning) => warning.id === WARNING.MAIL_PENDING));

  const failed = deriveWarnings(booking({
    emailStatus: {
      guest: { mailType: 'GUEST_BOOKING_CONFIRMED', status: 'Skickad', deliveryStatus: 'bounced', resendId: 'r1', sentAt: '2026-11-26T09:01:00.000Z', createdAt: '2026-11-26T09:00:00.000Z' }
    }
  }));
  assert.ok(failed.some((warning) => warning.id === WARNING.MAIL_FAILED));

  const unverified = deriveWarnings(booking({
    emailStatus: {
      guest: { mailType: 'GUEST_BOOKING_CONFIRMED', status: 'Skickad', deliveryStatus: 'Accepterad av Resend – leverans ej verifierad', resendId: 'r1', sentAt: '2026-11-26T09:01:00.000Z', createdAt: '2026-11-26T09:00:00.000Z' }
    }
  }));
  const warning = unverified.find((item) => item.id === WARNING.MAIL_UNVERIFIED);
  assert.ok(warning);
  assert.equal(warning.severity, 'verify');
  assert.match(warning.recommendation, /leveranswebhook/);
});

test('kort väntetid efter Resend-acceptans ger ingen varning – först efter tidsgränsen', () => {
  const recent = deriveWarnings(booking({
    emailStatus: {
      guest: {
        mailType: 'GUEST_BOOKING_CONFIRMED',
        status: 'Skickad',
        deliveryStatus: 'accepted',
        resendId: 'r-recent',
        sentAt: '2026-11-26T09:50:00.000Z',
        createdAt: '2026-11-26T09:49:00.000Z'
      }
    }
  }), { now: new Date('2026-11-26T10:00:00.000Z') });
  assert.equal(recent.some((item) => item.id === WARNING.MAIL_UNVERIFIED), false);

  const old = deriveWarnings(booking({
    emailStatus: {
      guest: {
        mailType: 'GUEST_BOOKING_CONFIRMED',
        status: 'Skickad',
        deliveryStatus: 'accepted',
        resendId: 'r-old',
        sentAt: '2026-11-26T08:30:00.000Z',
        createdAt: '2026-11-26T08:29:00.000Z'
      }
    }
  }), { now: new Date('2026-11-26T10:00:00.000Z') });
  const warning = old.find((item) => item.id === WARNING.MAIL_UNVERIFIED);
  assert.ok(warning);
  assert.equal(warning.details.alertAfterMinutes, 60);
});

test('leveranshändelse tar bort varningen om overifierad leverans automatiskt', () => {
  const record = booking({
    emailStatus: {
      guest: {
        mailType: 'GUEST_BOOKING_CONFIRMED',
        status: 'Skickad',
        deliveryStatus: 'delivered',
        resendId: 'r-delivered',
        sentAt: '2026-11-26T08:50:00.000Z',
        deliveredAt: '2026-11-26T09:10:00.000Z',
        lastEventType: 'email.delivered',
        createdAt: '2026-11-26T08:49:00.000Z'
      }
    }
  });
  assert.equal(record.mailStatus.guest.deliveryLabel, 'Levererat');
  const warnings = deriveWarnings(record, { now: new Date('2026-11-26T10:00:00.000Z') });
  assert.equal(warnings.some((item) => item.id === WARNING.MAIL_UNVERIFIED), false);
  assert.equal(warnings.some((item) => item.id === WARNING.MAIL_FAILED), false);
});

test('detaljvyn visar tidslinje och aldrig Levererat vid enbart API-acceptans', () => {
  const record = normalizeBooking({
    idempotencyKey: 'mail-test-view',
    RowKey: 'mail-test-view',
    reference: 'SK-2026-MAIL2',
    status: 'Bekräftad',
    statusCode: 'CONFIRMED',
    arrival: '2030-05-10',
    departure: '2030-05-11',
    nights: 1,
    guests: 2,
    total: 1000,
    lodgingBase: 1000,
    paymentStatus: 'PAID',
    amountPaid: 1000,
    bookingSource: 'WEB',
    createdAt: '2026-11-01T00:00:00.000Z'
  }, {
    outbox: [outboxRow({
      reference: 'SK-2026-MAIL2',
      mailSubject: 'Din bokning är bekräftad',
      resendId: 'resend-view-1'
    })]
  });
  const html = renderBookingDetail({
    booking: record,
    principal: { name: 'Test', roles: ['Owner'], email: 'test@example.se', isDemo: true },
    demo: true,
    csrfToken: 'csrf'
  });
  assert.match(html, /mail-timeline/);
  assert.match(html, /Accepterat av Resend – slutlig leverans ej verifierad\./);
  assert.match(html, /Slutlig leverans ej verifierad/);
  assert.doesNotMatch(html, /<span class="badge badge-confirmed">Levererat<\/span>/);
});

test('Airbnb-varningen skiljer på väntande import och saknad blockering', () => {
  const nights = ['2030-05-10', '2030-05-11', '2030-05-12'];
  const verification = {
    status: 'available',
    blockedNights: [],
    checkedAt: '2026-11-26T09:30:00.000Z',
    checkedBy: 'Owner',
    source: 'ical',
    fingerprint: 'SK-2026-MAIL1|2030-05-10|2030-05-13|WEB'
  };
  const calendarRows = nights.map((night) => ({ night, reference: 'SK-2026-MAIL1' }));

  const recent = deriveWarnings(booking({ airbnbVerification: verification }), {
    now: new Date('2026-11-26T10:00:00.000Z'),
    calendarRows
  });
  const pending = recent.find((warning) => warning.id === WARNING.AIRBNB_IMPORT_PENDING);
  assert.ok(pending);
  assert.equal(pending.severity, 'verify');
  assert.match(pending.what, /interna kalender och \.ics-export innehåller bokningen/);
  assert.match(pending.why, /fördröjning/);
  assert.match(pending.recommendation, /exportadressen/);

  const old = deriveWarnings(booking({
    confirmedAt: '2026-11-20T09:00:00.000Z',
    airbnbVerification: verification
  }), {
    now: new Date('2026-11-26T10:00:00.000Z'),
    calendarRows
  });
  const missing = old.find((warning) => warning.id === WARNING.AIRBNB_AVAILABLE);
  assert.ok(missing);
  assert.equal(missing.severity, 'action');
  assert.match(missing.why, /inte visa om Airbnb har importerat/);
  assert.match(missing.recommendation, /rätt exportadress/);
});
