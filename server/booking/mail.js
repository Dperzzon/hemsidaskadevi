'use strict';

// E-postkonfiguration för bokningsflödet.
//
// Beslutad kontaktadress (Skadevi): skadevigard@gmail.com — mottagare för
// bokningsförfrågningar och reply-to i gästens mottagningsbekräftelse.
//
// Leverantör: Resend via Logic App — API-nyckeln ligger i Key Vault, aldrig i
// miljövariabler eller kod. Avsändaren sätts av Logic Appen
// (bokning@skadeviherrgard.com). Utskick aktiveras uttryckligen med
// STRIPE_OUTBOX_ENABLED, ADMIN_MAIL_OUTBOX_ENABLED samt Logic Appens state och
// outboxActivationSince. Notisernas innehåll sparas som utkorgsposter i den
// durabla lagringen.

const MAIL = {
  hostRecipient: 'skadevigard@gmail.com',
  replyTo: 'skadevigard@gmail.com'
};

module.exports = { MAIL };
