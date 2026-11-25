'use strict';

const { MAIL } = require('./mail');
const {
  computePaymentSummary,
  formatOre
} = require('./payment-ledger');
const {
  MAIL_BRAND,
  escapeHtml,
  formatDate,
  emailShell,
  mailList,
  sectionTitle,
  detailRow,
  practicalInfoHtml,
  practicalInfoText,
  contactBlockHtml,
  contactBlockText,
  addonLines,
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
  const firstName = String(record.firstName ?? '').trim();
  const greeting = firstName ? `Hej ${firstName},` : 'Hej,';
  const headline = 'Din bokning på Skadevi Herrgård är bekräftad';
  const intro = 'Din bokning är bekräftad. Vi ser fram emot att välkomna er till Skadevi Herrgård. Här hittar ni en sammanställning av er bokning och information inför er vistelse.';

  const stayRows = [
    ['Bokningsreferens', String(record.reference ?? '')],
    ['Ankomst', formatDate(record.arrival)],
    ['Avresa', formatDate(record.departure)],
    ['Antal nätter', String(record.nights ?? '')],
    ['Antal gäster', String(record.guests ?? '')]
  ];
  if (record.extrahus?.enabled) {
    stayRows.push(['Extrahus', `${record.extrahus.nights} nätter, ${record.extrahus.guests} gäster`]);
  }
  stayRows.push(['Tillval', addonLines(record).join(', ')]);

  const paymentRowsData = [
    ['Totalt bokningsbelopp inklusive moms', formatOre(summary.totalOre)],
    ['Betalt belopp', formatOre(summary.paidOre)],
    ['Kvar att betala', formatOre(Math.max(0, summary.remainingOre))],
    ['Betalstatus', summary.paymentLabel]
  ];
  if (summary.overpaidOre > 0) {
    paymentRowsData.push(['Överbetalt belopp', `${formatOre(summary.overpaidOre)} – kontakta Skadevi Herrgård`]);
  }

  const isPaid = summary.paymentStatus === 'PAID';
  const paymentText = isPaid
    ? 'Hela bokningsbeloppet är betalt.'
    : `Bokningen är bekräftad men inte fullbetald. Kvar att betala är ${formatOre(Math.max(0, summary.remainingOre))}.`;
  const calloutBackground = isPaid ? '#eef7ee' : '#fff8e6';
  const calloutBorder = isPaid ? '#4f7f4f' : MAIL_BRAND.gold;

  const content = `<p style="margin:0 0 6px;text-align:center;font-size:15px;color:${MAIL_BRAND.muted};">${escapeHtml(greeting)}</p>
<p style="margin:0 0 18px;text-align:center;font-size:15px;line-height:1.7;">${escapeHtml(intro)}</p>
${sectionTitle('Er bokning')}
${stayRows.map(([label, value]) => detailRow(label, value)).join('')}
${sectionTitle('Betalning')}
${paymentRowsData.map(([label, value]) => detailRow(label, value)).join('')}
<div style="background:${calloutBackground};border-left:3px solid ${calloutBorder};padding:14px 16px;margin:16px 0 0;font-size:15px;line-height:1.55;"><strong>${escapeHtml(paymentText)}</strong></div>
${sectionTitle('Inför er vistelse')}
${practicalInfoHtml()}
<p style="margin:24px 0 0;font-size:15px;">Har ni frågor inför er vistelse är ni alltid välkomna att kontakta oss.</p>
<p style="margin:18px 0 0;font-size:15px;">Vänliga hälsningar,<br><strong style="font-family:Georgia,'Times New Roman',serif;font-weight:normal;font-size:17px;">Skadevi Herrgård</strong></p>
${contactBlockHtml()}`;

  const text = [
    greeting,
    '',
    headline,
    '',
    intro,
    '',
    'Er bokning',
    ...stayRows.map(([label, value]) => `${label}: ${value}`),
    '',
    'Betalning',
    ...paymentRowsData.map(([label, value]) => `${label}: ${value}`),
    '',
    paymentText,
    '',
    practicalInfoText(),
    '',
    'Har ni frågor inför er vistelse är ni alltid välkomna att kontakta oss.',
    '',
    'Vänliga hälsningar,',
    'Skadevi Herrgård',
    '',
    contactBlockText()
  ].join('\n');

  return {
    mailType: options.mailType ?? 'GUEST_BOOKING_CONFIRMED',
    to: record.email,
    replyTo: MAIL.replyTo,
    subject: `Din bokning på Skadevi Herrgård är bekräftad (${record.reference})`,
    body: text,
    html: emailShell(headline, content, {
      preheader: `Bokningsbekräftelse ${record.reference} – Skadevi Herrgård`
    })
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
    `Gäst: ${record.guestName ?? `${record.firstName ?? ''} ${record.lastName ?? ''}`.trim()}`,
    ...stayLines(record),
    `Betalning mottagen via ${methodText} (Stripe Checkout).`,
    `Betalningstyp: ${kind}`,
    `Belopp: ${formatOre(payment.amountOre)}`,
    `Totalt bokningsbelopp: ${formatOre(safeSummary.totalOre)}`,
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

function buildAddonVerificationMail(record, code, options = {}) {
  const minutes = Number(options.expiresMinutes ?? 10);
  const subject = 'Din verifieringskod för tillval – Skadevi Herrgård';
  const intro = 'Använd koden nedan för att visa din befintliga bokning och köpa tillval.';
  const warn = `Koden gäller i ${minutes} minuter och kan bara användas en gång. Om du inte begärt koden kan du bortse från detta mejl.`;
  const text = [
    `Hej ${record.firstName ?? ''},`.trim(),
    '',
    intro,
    '',
    `Verifieringskod: ${code}`,
    '',
    warn,
    '',
    contactBlockText()
  ].join('\n');
  const html = emailShell('Verifiera din bokning', `<p style="margin:0 0 12px;">Hej ${escapeHtml(record.firstName ?? '')},</p>
<p style="margin:0 0 16px;">${escapeHtml(intro)}</p>
<div style="background:${MAIL_BRAND.background};border:1px solid ${MAIL_BRAND.border};padding:20px;text-align:center;margin:0 0 18px;">
<div style="font-family:Georgia,'Times New Roman',serif;font-size:34px;letter-spacing:8px;color:${MAIL_BRAND.ink};">${escapeHtml(code)}</div>
</div>
<p style="margin:0 0 16px;font-size:13px;color:${MAIL_BRAND.muted};">${escapeHtml(warn)}</p>
<p style="margin:0;">Vänliga hälsningar,<br><strong>Skadevi Herrgård</strong></p>${contactBlockHtml()}`);
  return {
    mailType: 'GUEST_ADDON_VERIFICATION_CODE',
    to: record.email,
    replyTo: MAIL.replyTo,
    subject,
    body: text,
    html
  };
}

function buildAddonConfirmation(record, order) {
  const firstName = String(record.firstName ?? '').trim();
  const greeting = firstName ? `Hej ${firstName},` : 'Hej,';
  const lines = Array.isArray(order.lines) ? order.lines : [];
  const lineText = lines.length
    ? lines.map((line) => `${line.label}${line.quantity > 1 ? ` × ${line.quantity}` : ''}: ${formatOre(line.amountOre ?? Math.round(Number(line.amount ?? 0) * 100))}`)
    : ['Inga nya tillval'];
  const totalText = formatOre(order.totalOre ?? Math.round(Number(order.total ?? 0) * 100));
  const stayRows = [
    ['Bokningsreferens', String(record.reference ?? '')],
    ['Ankomst', formatDate(record.arrival)],
    ['Avresa', formatDate(record.departure)],
    ['Antal gäster', String(record.guests ?? '')]
  ];
  const paymentText = 'Betalningen för tillvalen är genomförd med kort via Stripe. Boendebetalningen och de ursprungliga bokningsuppgifterna är oförändrade.';
  const content = `<p style="margin:0 0 18px;text-align:center;font-size:15px;line-height:1.7;">Tack! Vi har lagt till följande tillval på din befintliga bokning.</p>
${sectionTitle('Er bokning')}
${stayRows.map(([label, value]) => detailRow(label, value)).join('')}
${sectionTitle('Nya tillval')}
${mailList(lineText.map(escapeHtml))}
${detailRow('Summa för detta köp', totalText)}
${detailRow('Betalstatus', 'Betald')}
${sectionTitle('Bokningens samtliga tillval')}
${mailList(addonLines(record).map(escapeHtml))}
<div style="background:#eef7ee;border-left:3px solid #4f7f4f;padding:14px 16px;margin:16px 0 0;font-size:15px;line-height:1.55;"><strong>${escapeHtml(paymentText)}</strong></div>
<p style="margin:20px 0 0;font-size:13px;color:${MAIL_BRAND.muted};">Villkor för tillvalsköpet: version ${escapeHtml(order.termsVersion ?? '')}.</p>
${contactBlockHtml()}`;
  const text = [
    greeting,
    '',
    'Tack! Vi har lagt till följande tillval på din befintliga bokning.',
    '',
    'Er bokning',
    ...stayRows.map(([label, value]) => `${label}: ${value}`),
    '',
    'Nya tillval',
    ...lineText,
    `Summa för detta köp: ${totalText}`,
    'Betalstatus: Betald',
    '',
    'Bokningens samtliga tillval',
    ...addonLines(record),
    '',
    paymentText,
    '',
    `Villkor för tillvalsköpet: version ${order.termsVersion ?? ''}.`,
    '',
    contactBlockText()
  ].join('\n');
  return {
    mailType: 'GUEST_ADDON_PURCHASE_CONFIRMATION',
    to: record.email,
    replyTo: MAIL.replyTo,
    subject: `Bekräftelse på tillval till din bokning (${record.reference})`,
    body: text,
    html: emailShell('Bekräftelse på tillval till din bokning', content, {
      preheader: `Tillvalsbekräftelse ${record.reference} – Skadevi Herrgård`
    })
  };
}

function buildAddonHostNotification(record, order) {
  const lines = [
    `Referens: ${record.reference}`,
    `Gäst: ${record.guestName ?? `${record.firstName ?? ''} ${record.lastName ?? ''}`.trim()}`,
    `E-post: ${record.email}`,
    `Tillvalsorder: ${order.orderId}`,
    ...stayLines(record),
    'Nya köpta tillval:',
    ...(Array.isArray(order.lines) ? order.lines.map((line) => `${line.label}: ${formatOre(line.amountOre ?? Math.round(Number(line.amount ?? 0) * 100))}`) : []),
    `Summa för köpet: ${formatOre(order.totalOre)}`,
    `Bokningens totalbelopp efter köpet: ${formatOre(Math.round(Number(record.total ?? 0) * 100))}`,
    `Stripe-session: ${order.sessionId ?? ''}`,
    `Villkorsversion: ${order.termsVersion ?? ''}`
  ];
  return {
    mailType: 'HOST_ADDON_PURCHASE',
    to: MAIL.hostRecipient,
    replyTo: MAIL.replyTo,
    subject: `Nytt tillvalsköp ${record.reference} – ${formatOre(order.totalOre)}`,
    body: `${lines.join('\n')}\n\n${contactBlockText()}`,
    html: emailShell(`Nytt tillvalsköp – ${record.reference}`, `<div style="background:#eef7ee;border-left:4px solid #4f7f4f;padding:12px 16px;margin:0 0 18px;"><strong>Betald tillvalsorder ${escapeHtml(order.orderId)}</strong></div>${mailList(lines.map(escapeHtml))}${contactBlockHtml()}`)
  };
}

function buildAddonRequestNotifications(record, request) {
  const lines = [
    `Referens: ${record.reference}`,
    `Förfrågan: ${request.requestId}`,
    `Gäst: ${record.guestName ?? `${record.firstName ?? ''} ${record.lastName ?? ''}`.trim()}`,
    `E-post: ${record.email}`,
    ...stayLines(record),
    'Önskade tillval:',
    ...(Array.isArray(request.lines) ? request.lines.map((line) => line.label) : []),
    request.message ? `Meddelande: ${request.message}` : '',
    'Ingen betalning har skett. Skadevi bekräftar tillgänglighet och pris manuellt.'
  ].filter(Boolean);
  const guestIntro = 'Vi har tagit emot din förfrågan om ytterligare tillval. Inget har debiterats. Skadevi Herrgård återkommer med besked om tillgänglighet och pris.';
  return {
    host: {
      mailType: 'HOST_ADDON_REQUEST',
      to: MAIL.hostRecipient,
      replyTo: MAIL.replyTo,
      subject: `Tillvalsförfrågan ${record.reference}`,
      body: `${lines.join('\n')}\n\n${contactBlockText()}`,
      html: emailShell(`Tillvalsförfrågan – ${record.reference}`, `${mailList(lines.map(escapeHtml))}${contactBlockHtml()}`)
    },
    guest: {
      mailType: 'GUEST_ADDON_REQUEST_RECEIVED',
      to: record.email,
      replyTo: MAIL.replyTo,
      subject: `Vi har tagit emot din tillvalsförfrågan (${record.reference})`,
      body: `${guestIntro}\n\n${contactBlockText()}`,
      html: emailShell('Tillvalsförfrågan mottagen', `<p style="margin:0 0 12px;">Hej ${escapeHtml(record.firstName ?? '')},</p>
<p style="margin:0 0 16px;">${escapeHtml(guestIntro)}</p>
<p style="margin:0 0 16px;">Det gäller: ${escapeHtml((request.lines ?? []).map((line) => line.label).join(', '))}</p>
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
  buildInvoiceNotifications,
  buildAddonVerificationMail,
  buildAddonConfirmation,
  buildAddonHostNotification,
  buildAddonRequestNotifications
};
