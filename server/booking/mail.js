'use strict';

// E-postkonfiguration för bokningsflödet.
//
// Beslutad kontaktadress (Skadevi): skadevigard@gmail.com — mottagare för
// bokningsförfrågningar och reply-to i gästens mottagningsbekräftelse.
//
// BESLUTSPUNKT (kvarstår): den verkliga e-postleveransen är avstängd tills
// leverantör (t.ex. SendGrid/Azure Communication Services/SMTP) och avsändare
// är godkända. `from` kan kompletteras via miljön utan att hemligheter läggs
// i koden; `deliveryEnabled` ska först sättas true i samband med att
// leverantören kopplas in. Notisernas innehåll sparas redan nu som
// utkorgsposter i den durabla lagringen.

const MAIL = {
  hostRecipient: 'skadevigard@gmail.com',
  replyTo: 'skadevigard@gmail.com',
  from: process.env.BOOKING_MAIL_FROM ?? null,
  deliveryEnabled: false
};

module.exports = { MAIL };
