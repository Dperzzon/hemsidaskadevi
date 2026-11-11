'use strict';

// Syntetisk demodata för den lokala bokningsportalen. Alla referenser börjar
// med DEMO- och alla poster är märkta isDemo. Modulen läser aldrig Azure och
// skriver aldrig något. Den används bara när servern startas med --demo.

const { quote } = require('../booking/pricing');
const { todayKey, addDays, toIsoAt } = require('./domain');

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function makeDemoBooking(config) {
  const {
    reference, statusCode, status, createdOffset, arrivalOffset, nights,
    guests, firstName, lastName, email, phone, company = '', message = '',
    addons = {}, source = 'WEB', paymentStatus = 'UNPAID', amountPaid = 0,
    latestNote = '', actionFlags = {}, overlaps = [], emailStatus,
    airbnbBlockedAt = ''
  } = config;
  const today = todayKey();
  const arrival = addDays(today, arrivalOffset);
  const departure = addDays(arrival, nights);
  const pricing = quote({ arrival, departure, guests, addons });
  const createdAt = toIsoAt(addDays(today, createdOffset), 9 + (Math.abs(createdOffset) % 6), 15);
  const updatedAt = toIsoAt(addDays(today, Math.max(createdOffset, -1)), 15, 40);
  const paid = paymentStatus === 'PAID' ? pricing.total : amountPaid;
  const balance = paymentStatus === 'PAID' || paymentStatus === 'REFUNDED'
    ? 0
    : Math.max(0, pricing.total - paid);
  return {
    isDemo: true,
    idempotencyKey: `demo-${reference.toLowerCase()}`,
    reference,
    statusCode,
    status,
    arrival,
    departure,
    nights,
    guests,
    firstName,
    lastName,
    email,
    phone,
    company,
    message,
    bookingSource: source,
    addons,
    lodgingBase: pricing.lodgingBase,
    peakNights: pricing.peakNights,
    peakBase: pricing.peakBase,
    nightlyBreakdown: pricing.nightlyBreakdown,
    discount: pricing.discount,
    discountAmount: pricing.discountAmount,
    lodgingAfterDiscount: pricing.lodgingAfterDiscount,
    addonLines: pricing.addonLines,
    totalAddons: pricing.addonsTotal,
    total: pricing.total,
    priceVersion: pricing.priceVersion,
    rulesVersion: '2026-11-10-v3',
    paymentStatus,
    amountPaid: paid,
    balance,
    latestNote,
    actionFlags,
    overlaps,
    airbnbBlockedAt,
    emailStatus,
    createdAt,
    updatedAt
  };
}

function buildDemoBookings() {
  const year = todayKey().slice(0, 4);
  return [
    makeDemoBooking({
      reference: `DEMO-${year}-A1`,
      statusCode: 'PENDING',
      status: 'Inväntar godkännande',
      createdOffset: -3,
      arrivalOffset: 12,
      nights: 4,
      guests: 6,
      firstName: 'Anna',
      lastName: 'Andersson',
      email: 'anna.andersson@example.se',
      phone: '+46 70 123 45 67',
      company: 'Nordvind AB',
      message: 'Vi kommer sent på fredagen och önskar tidig incheckning om det är möjligt. En i sällskapet är vegetarian.',
      addons: { slutstad: true, lakan: true, linenCount: 6, ved: true, tidigIncheckning: true, senUtcheckning: false },
      source: 'WEB',
      emailStatus: {
        host: { status: 'Skickad', deliveryStatus: 'delivered', resendId: 'demo-resend-a1-host' },
        guest: { status: 'Skickad', deliveryStatus: 'delivered', resendId: 'demo-resend-a1-guest' }
      }
    }),
    makeDemoBooking({
      reference: `DEMO-${year}-B2`,
      statusCode: 'PENDING',
      status: 'Inväntar godkännande',
      createdOffset: -1,
      arrivalOffset: 20,
      nights: 3,
      guests: 12,
      firstName: 'Erik',
      lastName: 'Svensson',
      email: 'erik.svensson@example.se',
      phone: '+46 73 987 65 43',
      company: 'Svensson & Söner',
      message: 'Företagsintern kickoff med övernattning. Vi behöver faktura och hjälp med frukost.',
      addons: { slutstad: true, lakan: true, linenCount: 12, ved: false, tidigIncheckning: false, senUtcheckning: true },
      source: 'WEB',
      actionFlags: { overlap: true },
      overlaps: [`DEMO-${year}-E5 (överlappande förfrågan)`],
      emailStatus: {
        host: { status: 'Skickad', deliveryStatus: 'Inväntar leveranskontroll', resendId: 'demo-resend-b2-host' },
        guest: { status: 'Skickad', deliveryStatus: 'delivered', resendId: 'demo-resend-b2-guest' }
      }
    }),
    makeDemoBooking({
      reference: `DEMO-${year}-C3`,
      statusCode: 'PRELIMINARY',
      status: 'Preliminär',
      createdOffset: -6,
      arrivalOffset: 30,
      nights: 2,
      guests: 4,
      firstName: 'Lisa',
      lastName: 'Berg',
      email: 'lisa.berg@example.se',
      phone: '+46 72 555 12 34',
      message: 'Vi vill gärna boka fredag–söndag och avvaktar besked om slutstädning.',
      addons: { slutstad: false, lakan: true, linenCount: 4, ved: true, tidigIncheckning: false, senUtcheckning: false },
      source: 'PHONE',
      paymentStatus: 'DEPOSIT_PAID',
      amountPaid: 5000,
      latestNote: 'Preliminär tills gästen bekräftar antal lakan.',
      emailStatus: {
        host: { status: 'Kräver manuell kontroll', deliveryStatus: 'unknown', resendId: 'demo-resend-c3-host' },
        guest: { status: 'Skickad', deliveryStatus: 'delivered', resendId: 'demo-resend-c3-guest' }
      }
    }),
    makeDemoBooking({
      reference: `DEMO-${year}-D4`,
      statusCode: 'CONFIRMED',
      status: 'Bekräftad',
      createdOffset: -10,
      arrivalOffset: 5,
      nights: 3,
      guests: 8,
      firstName: 'Maria',
      lastName: 'Nilsson',
      email: 'maria.nilsson@example.se',
      phone: '+46 70 444 33 22',
      company: 'Nilsson Event',
      message: 'Familjefirande med barn. Vi behöver barnstolar och extra ved.',
      addons: { slutstad: true, lakan: true, linenCount: 8, ved: true, tidigIncheckning: false, senUtcheckning: false },
      source: 'WEB',
      paymentStatus: 'PAID',
      amountPaid: 0,
      actionFlags: { airbnbBlocked: false },
      emailStatus: {
        host: { status: 'Skickad', deliveryStatus: 'delivered', resendId: 'demo-resend-d4-host' },
        guest: { status: 'Skickad', deliveryStatus: 'delivered', resendId: 'demo-resend-d4-guest' }
      }
    }),
    makeDemoBooking({
      reference: `DEMO-${year}-E5`,
      statusCode: 'CONFIRMED',
      status: 'Bekräftad',
      createdOffset: -8,
      arrivalOffset: 8,
      nights: 2,
      guests: 2,
      firstName: 'Johan',
      lastName: 'Lind',
      email: 'johan.lind@example.se',
      phone: '+46 76 222 11 00',
      message: 'Weekend för två. Ingen särskild önskan.',
      addons: { slutstad: false, lakan: false, linenCount: 0, ved: false, tidigIncheckning: false, senUtcheckning: false },
      source: 'AIRBNB',
      paymentStatus: 'PAID',
      amountPaid: 0,
      airbnbBlockedAt: toIsoAt(addDays(todayKey(), -2), 10, 0),
      emailStatus: {
        host: { status: 'Skickad', deliveryStatus: 'delivered', resendId: 'demo-resend-e5-host' },
        guest: { status: 'Skickad', deliveryStatus: 'delivered', resendId: 'demo-resend-e5-guest' }
      }
    }),
    makeDemoBooking({
      reference: `DEMO-${year}-F6`,
      statusCode: 'CONFIRMED',
      status: 'Bekräftad',
      createdOffset: -14,
      arrivalOffset: 15,
      nights: 7,
      guests: 12,
      firstName: 'Sara',
      lastName: 'Ek',
      email: 'sara.ek@example.se',
      phone: '+46 70 888 77 66',
      company: 'Ek Rekrytering',
      message: 'Veckolång konferens. Fakturera företaget, tack.',
      addons: { slutstad: true, lakan: true, linenCount: 12, ved: true, tidigIncheckning: true, senUtcheckning: true },
      source: 'EMAIL',
      paymentStatus: 'PARTIALLY_PAID',
      amountPaid: 40000,
      latestNote: 'Deposition mottagen. Resten faktureras efter vistelsen.',
      actionFlags: { airbnbBlocked: true },
      airbnbBlockedAt: toIsoAt(addDays(todayKey(), -4), 11, 30),
      emailStatus: {
        host: { status: 'Skickad', deliveryStatus: 'delivered', resendId: 'demo-resend-f6-host' },
        guest: { status: 'Skickad', deliveryStatus: 'delivered', resendId: 'demo-resend-f6-guest' }
      }
    }),
    makeDemoBooking({
      reference: `DEMO-${year}-G7`,
      statusCode: 'DECLINED',
      status: 'Nekad',
      createdOffset: -20,
      arrivalOffset: 25,
      nights: 2,
      guests: 4,
      firstName: 'Oskar',
      lastName: 'Holm',
      email: 'oskar.holm@example.se',
      phone: '+46 70 111 22 33',
      message: 'Frågade om hund var tillåten.',
      addons: { slutstad: false, lakan: false, linenCount: 0, ved: false, tidigIncheckning: false, senUtcheckning: false },
      source: 'WEB',
      emailStatus: {
        host: { status: 'Skickad', deliveryStatus: 'delivered', resendId: 'demo-resend-g7-host' },
        guest: { status: 'Skickad', deliveryStatus: 'delivered', resendId: 'demo-resend-g7-guest' }
      }
    }),
    makeDemoBooking({
      reference: `DEMO-${year}-H8`,
      statusCode: 'CANCELLED',
      status: 'Avbokad',
      createdOffset: -30,
      arrivalOffset: 18,
      nights: 3,
      guests: 6,
      firstName: 'Eva',
      lastName: 'Dahl',
      email: 'eva.dahl@example.se',
      phone: '+46 73 333 44 55',
      message: 'Avbokad på grund av ändrade planer.',
      addons: { slutstad: true, lakan: true, linenCount: 6, ved: false, tidigIncheckning: false, senUtcheckning: false },
      source: 'WEB',
      paymentStatus: 'REFUNDED',
      amountPaid: 0,
      latestNote: 'Avbokad enligt reglerna; ingen återbetalning.',
      actionFlags: { airbnbBlocked: true },
      airbnbBlockedAt: toIsoAt(addDays(todayKey(), -12), 9, 0),
      emailStatus: {
        host: { status: 'Skickad', deliveryStatus: 'delivered', resendId: 'demo-resend-h8-host' },
        guest: { status: 'Skickad', deliveryStatus: 'delivered', resendId: 'demo-resend-h8-guest' }
      }
    })
  ];
}

const DEMO_BOOKINGS = deepFreeze(buildDemoBookings());

module.exports = { DEMO_BOOKINGS, buildDemoBookings };
