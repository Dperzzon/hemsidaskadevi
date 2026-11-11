'use strict';

// E-postkonfiguration för bokningsflödet.
//
// Beslutad kontaktadress (Skadevi): skadevigard@gmail.com — mottagare för
// bokningsförfrågningar och reply-to i gästens mottagningsbekräftelse.
//
// Leverantör (beslut 2026-11-11): Resend via Logic App — API-nyckeln ligger i
// Key Vault, aldrig i miljövariabler eller kod. `from` sätts av Logic Appen
// (bokning@skadeviherrgard.com); `deliveryEnabled` ska först sättas true i
// samband med att Resend-konto, domänverifiering och RBAC är godkända.
// Notisernas innehåll sparas redan nu som utkorgsposter i den durabla
// lagringen.

const MAIL = {
  hostRecipient: 'skadevigard@gmail.com',
  replyTo: 'skadevigard@gmail.com',
  from: process.env.BOOKING_MAIL_FROM ?? null,
  deliveryEnabled: false
};

module.exports = { MAIL };
