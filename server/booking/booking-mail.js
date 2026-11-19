'use strict';

const { MAIL } = require('./mail');
const {
  computePaymentSummary,
  formatOre
} = require('./payment-ledger');
const {
  escapeHtml,
  formatDate,
  emailShell,
  mailList,
  contactBlockHtml,
  contactBlockText,
  stayLines
} = require('./mail-templates');

function summaryFor(record, summary) {
  if (summary) return summary;
  try {
    return computePaymentSummary(record);
  } catch {
    return {
      totalOre: Math.round(Number(record.total ?? 0) * 100),
      paidOre: Math.round(Number(record.amountPaid ?? 0) * 100),
      remainingOre: Math.round(Number(record.balance ?? record.total ?? 0) * 100),
      overpaidOre: 0,
      paymentStatus: String(record.paymentStatus ?? 'UNPAID'),
      paymentLabel: String(record.paymentStatus ?? 'Ej betald')
    };
  }
}

function paymentRows(record, summary) {
  const rows = [
    `Totalt bokningsbelopp: ${formatOre(summary.totalOre)}`,
    `Betalt belopp: ${formatOre(summary.paidOre)}`,
    `Kvar att betala: ${formatOre(Math.max(0, summary.remainingOre))}`,
    `Betalstatus: ${summary.paymentLabel}`
  ];
  if (summary.overpaidOre > 0) {
    rows.push(`Överbetalt belopp: ${formatOre(summary.overpaidOre)} – kontakta Skadevi Herrgård.`);
  }
  return rows;
}

function receiptKind(record, payment, summary) {
  const paidBefore = Math.max(0, summary.paidOre - Number(payment?.amountOre ?? 0));
  if (summary.paymentStatus === 'PAID') {
    return paidBefore > 0 ? 'Slutbetalning' : 'Full betalning';
  }
  if (summary.paymentStatus === 'PARTIALLY_PAID') {
    return paidBefore > 0 ? 'Delbetalning' : 'Deposition/delbetalning';
  }
  return 'Betalning';
}

function buildBookingConfirmation(record, options = {}) {
  const summary = summaryFor(record, options.summary);
  const details = [
    ...stayLines(record),
    ...paymentRows(record, summary)
  ];
  const confirmedText = 'Din bokning är bekräftad.';
  const paymentText = summary.paymentStatus === 'PAID'
    ? 'Hela bokningsbeloppet är betalt.'
    : `Bokningen är bekräftad men inte fullbetald. Kvar att betala är ${formatOre(Math.max(0, summary.remainingOre))}.`;
  const nextSteps = 'Betalning, ändringar och praktiska frågor hanteras enligt bokningsvillkoren. Kontakta oss gärna om du har frågor inför din vistelse.';
  const text = `${confirmedText}\n\n${details.join('\n')}\n\n${paymentText}\n\n${nextSteps}\n\n${contactBlockText()}`;
  const content = `<p style="margin:0 0 12px;">Hej ${escapeHtml(record.firstName ?? '')},</p>
<p style="margin:0 0 16px;">${escapeHtml(confirmedText)}</p>
<div style="background:#eef7ee;border-left:4px solid #4f7f4f;padding:12px 16px;margin:0 0 20px;"><strong>${escapeHtml(paymentText)}</strong></div>
${mailList(details.map(escapeHtml))}
<p style="margin:0 0 16px;">${escapeHtml(nextSteps)}</p>
<p style="margin:0;">Vänliga hälsningar,<br><strong>Skadevi Herrgård</strong></p>
${contactBlockHtml()}`;
  return {
    mailType: options.mailType ?? 'GUEST_BOOKING_CONFIRMED',
    to: record.email,
    replyTo: MAIL.replyTo,
    subject: `Din bokning är bekräftad (${record.reference})`,
    body: text,
    html: emailShell('Din bokning är bekräftad', content)
  };
}

function buildPaymentNotifications(record, payment, summary, options = {}) {
  const safeSummary = summaryFor(record, summary);
  const kind = receiptKind(record, payment, safeSummary);
  const methodText = payment.method === 'SWISH' ? 'Swish' : payment.method === 'CARD' ? 'kort' : 'betalning';
  const confirmed = record.statusCode === 'CONFIRMED';
  const statusText = confirmed
    ? 'Bokningen är bekräftad sedan tidigare. Detta mejl bekräftar endast betalningen.'
    : 'Betalningen är registrerad på din bokning. Kontakta oss om du har frågor om bokningens status.';
  const fullPaidText = safeSummary.paymentStatus === 'PAID'
    ? (confirmed ? 'Hela bokningsbeloppet är nu betalt.' : 'Hela bokningsbeloppet är registrerat som betalt.')
    : `Detta är en ${kind.toLowerCase()}. Bokningen är inte fullbetald; kvar att betala är ${formatOre(Math.max(0, safeSummary.remainingOre))}.`;
  const details = [
    ...stayLines(record),
    ...paymentRows(record, safeSummary)
  ];
  const guestLines = [
    `Vi har tagit emot din ${methodText === 'betalning' ? 'betalning' : `${methodText}betalning`} på ${formatOre(payment.amountOre)}.`,
    `Betalningstyp: ${kind}`,
    ...details,
    fullPaidText,
    statusText
  ];
  const hostLines = [
    `Referens: ${record.reference}`,
    `Betalning mottagen via ${methodText} (Stripe Checkout).`,
    `Betalningstyp: ${kind}`,
    `Belopp: ${formatOre(payment.amountOre)}`,
    `Totalt betalt: ${formatOre(safeSummary.paidOre)}`,
    `Återstår: ${formatOre(Math.max(0, safeSummary.remainingOre))}`,
    `Betalstatus: ${safeSummary.paymentLabel}`,
    `Bokningsstatus: ${record.statusCode ?? ''}`,
    ...(options.reviewRequired ? [`VARNING: ${options.reviewRequired}`] : [])
  ];
  const guestIntro = `<p style="margin:0 0 12px;">Hej ${escapeHtml(record.firstName ?? '')},</p>
<p style="margin:0 0 16px;">Tack! Vi har registrerat din betalning.</p>
<div style="background:#fff8e6;border-left:4px solid #c9a96e;padding:12px 16px;margin:0 0 20px;"><strong>${escapeHtml(fullPaidText)}</strong><br>${escapeHtml(statusText)}</div>`;
  const hostContent = `${options.reviewRequired ? `<div style="background:#fff0f0;border-left:4px solid #b33;padding:12px 16px;margin:0 0 18px;"><strong>VARNING:</strong> ${escapeHtml(options.reviewRequired)}</div>` : ''}${mailList(hostLines.map(escapeHtml))}`;
  return {
    host: {
      mailType: 'HOST_PAYMENT_RECEIVED',
      to: MAIL.hostRecipient,
      replyTo: MAIL.replyTo,
      subject: `Betalning mottagen ${record.reference}${options.reviewRequired ? ' – kontroll krävs' : ''}`,
      body: `${hostLines.join('\n')}\n\n${contactBlockText()}`,
      html: emailShell(`Betalning mottagen – ${record.reference}`, hostContent)
    },
    guest: {
      mailType: 'GUEST_PAYMENT_RECEIPT',
      to: record.email,
      replyTo: MAIL.replyTo,
      subject: `Betalning mottagen (${record.reference})`,
      body: `${guestLines.join('\n')}\n\n${contactBlockText()}`,
      html: emailShell('Betalning mottagen', `${guestIntro}${mailList(guestLines.map(escapeHtml))}
<p style="margin:0;">Vänliga hälsningar,<br><strong>Skadevi Herrgård</strong></p>${contactBlockHtml()}`)
    }
  };
}

function buildPaymentLinkNotification(record, url, amountOre, expiresAt) {
  const lines = [
    ...stayLines(record),
    `Belopp att betala: ${formatOre(amountOre)}`,
    expiresAt ? `Betalningslänken gäller till: ${formatDate(String(expiresAt).slice(0, 10))}` : ''
  ].filter(Boolean);
  const intro = 'Din bokning är bekräftad. Använd betalningslänken nedan för att betala enligt överenskommelse.';
  const outro = 'Betalningslänken är personlig. Om länken har gått ut eller om beloppet inte stämmer, kontakta oss för en ny länk.';
  return {
    mailType: 'GUEST_PAYMENT_LINK',
    to: record.email,
    replyTo: MAIL.replyTo,
    subject: `Betalningslänk för din bokning (${record.reference})`,
    body: `${intro}\n\n${lines.join('\n')}\n\nBetala här: ${url}\n\n${outro}\n\n${contactBlockText()}`,
    html: emailShell('Betalningslänk för din bokning', `<p style="margin:0 0 12px;">Hej ${escapeHtml(record.firstName ?? '')},</p>
<p style="margin:0 0 16px;">${escapeHtml(intro)}</p>
${mailList(lines.map(escapeHtml))}
<p style="margin:0 0 18px;"><a href="${escapeHtml(url)}" style="display:inline-block;background:#c9a96e;color:#ffffff;text-decoration:none;padding:12px 20px;border-radius:2px;">Till betalningen</a></p>
<p style="margin:0 0 16px;">${escapeHtml(outro)}</p>
<p style="margin:0;">Vänliga hälsningar,<br><strong>Skadevi Herrgård</strong></p>${contactBlockHtml()}`)
  };
}

function buildCancellationNotification(record, options = {}) {
  const summary = summaryFor(record, options.summary);
  const lines = [
    ...stayLines(record),
    `Registrerat betalt belopp: ${formatOre(summary.paidOre)}`,
    summary.remainingOre > 0 ? `Kvarvarande belopp enligt bokningen: ${formatOre(summary.remainingOre)}` : ''
  ].filter(Boolean);
  const intro = 'Din bokning är avbokad.';
  const refund = 'Eventuell återbetalning hanteras enligt bokningsvillkoren. Kontakta oss om du har frågor om avbokningen eller återbetalningen.';
  return {
    mailType: 'GUEST_BOOKING_CANCELLED',
    to: record.email,
    replyTo: MAIL.replyTo,
    subject: `Din bokning är avbokad (${record.reference})`,
    body: `${intro}\n\n${lines.join('\n')}\n\n${refund}\n\n${contactBlockText()}`,
    html: emailShell('Din bokning är avbokad', `<p style="margin:0 0 12px;">Hej ${escapeHtml(record.firstName ?? '')},</p>
<p style="margin:0 0 16px;">${escapeHtml(intro)}</p>
${mailList(lines.map(escapeHtml))}
<p style="margin:0 0 16px;">${escapeHtml(refund)}</p>
<p style="margin:0;">Vänliga hälsningar,<br><strong>Skadevi Herrgård</strong></p>${contactBlockHtml()}`)
  };
}

function buildPaymentFailedNotification(record) {
  const lines = stayLines(record);
  const intro = 'Betalningen slutfördes inte. Din bokning är inte bekräftad och inga datum är bokade.';
  const info = 'Ingen betalning har registrerats hos Skadevi Herrgård för denna betalningssession. Kontakta oss om du vill försöka boka igen.';
  return {
    mailType: 'GUEST_PAYMENT_FAILED',
    to: record.email,
    replyTo: MAIL.replyTo,
    subject: `Betalningen slutfördes inte (${record.reference})`,
    body: `${intro}\n\n${lines.join('\n')}\n\n${info}\n\n${contactBlockText()}`,
    html: emailShell('Betalningen slutfördes inte', `<p style="margin:0 0 12px;">Hej ${escapeHtml(record.firstName ?? '')},</p>
<div style="background:#fff0f0;border-left:4px solid #b33;padding:12px 16px;margin:0 0 20px;"><strong>${escapeHtml(intro)}</strong></div>
${mailList(lines.map(escapeHtml))}
<p style="margin:0 0 16px;">${escapeHtml(info)}</p>
<p style="margin:0;">Vänliga hälsningar,<br><strong>Skadevi Herrgård</strong></p>${contactBlockHtml()}`)
  };
}

function buildInvoiceNotifications(record, request) {
  const amount = formatOre(request.amountOre);
  const details = [
    `Referens: ${record.reference}`,
    `Belopp: ${amount}`,
    `Faktureras till: ${request.invoiceName}`,
    request.invoiceOrgNumber ? `Organisationsnummer: ${request.invoiceOrgNumber}` : '',
    `Adress: ${request.invoiceAddress}, ${request.invoicePostalCode} ${request.invoiceCity}`,
    `E-post: ${request.invoiceEmail}`,
    request.invoiceReference ? `Er referens: ${request.invoiceReference}` : '',
    request.invoiceNotes ? `Övrigt: ${request.invoiceNotes}` : ''
  ].filter(Boolean);
  return {
    host: {
      mailType: 'HOST_INVOICE_REQUEST',
      to: MAIL.hostRecipient,
      replyTo: MAIL.replyTo,
      subject: `Fakturabegäran ${record.reference}`,
      body: `${details.join('\n')}\n\n${contactBlockText()}`,
      html: emailShell(`Fakturabegäran – ${record.reference}`, `${mailList(details.map(escapeHtml))}
<p style="margin:0 0 16px;">Fakturabegäran avser ${escapeHtml(amount)} för bokning ${escapeHtml(record.reference)}.</p>${contactBlockHtml()}`)
    },
    guest: {
      mailType: 'GUEST_INVOICE_REQUEST_RECEIVED',
      to: request.invoiceEmail,
      replyTo: MAIL.replyTo,
      subject: `Fakturabegäran mottagen (${record.reference})`,
      body: `Vi har tagit emot din fakturabegäran för ${record.reference} på ${amount}. Skadevi hanterar den manuellt. Ingen faktura skickas automatiskt.\n\n${contactBlockText()}`,
      html: emailShell('Fakturabegäran mottagen', `<p style="margin:0 0 12px;">Hej ${escapeHtml(request.invoiceName)},</p>
<p style="margin:0 0 16px;">Vi har tagit emot din fakturabegäran för <strong>${escapeHtml(record.reference)}</strong> på <strong>${escapeHtml(amount)}</strong>.</p>
<p style="margin:0 0 16px;">Skadevi hanterar den manuellt. Ingen faktura skickas automatiskt.</p>
<p style="margin:0;">Vänliga hälsningar,<br><strong>Skadevi Herrgård</strong></p>${contactBlockHtml()}`)
    }
  };
}

module.exports = {
  summaryFor,
  receiptKind,
  buildBookingConfirmation,
  buildPaymentNotifications,
  buildPaymentLinkNotification,
  buildCancellationNotification,
  buildPaymentFailedNotification,
  buildInvoiceNotifications
};
