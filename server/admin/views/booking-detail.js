'use strict';

const {
  escapeHtml,
  formatDateKey,
  formatDateRange,
  formatDateTime,
  formatMoney,
  PAYMENT_LABELS,
  todayKey
} = require('../domain');
const {
  PAYMENT_METHODS,
  PAYMENT_METHOD_CODES,
  formatOre,
  sortPayments
} = require('../payments');
const {
  INVOICE_REQUEST_STATUSES,
  INVOICE_REQUEST_TRANSITIONS
} = require('../../booking/invoice-requests');
const {
  statusBadge,
  emailBadge,
  deliveryBadge,
  actionButton,
  historyList,
  pageHeader
} = require('./components');
const { layout } = require('./layout');

function fact(label, value) {
  return `<div class="fact"><span>${escapeHtml(label)}</span><strong>${value}</strong></div>`;
}

function mailVerificationNote(verification) {
  if (!verification) return '';
  const when = verification.checkedAt ? formatDateTime(verification.checkedAt) : '';
  if (verification.status === 'delivered') {
    return `<p class="mail-verification mail-verification-ok">Resend bekräftar leverans. Kontrollerat ${escapeHtml(when)}.</p>`;
  }
  if (verification.status === 'permission_denied') {
    return `<p class="mail-verification">Senaste kontroll ${escapeHtml(when)}: Resend-nyckeln saknar behörighet att läsa leveransstatus. Ingen automatisk leveransverifiering är möjlig.</p>`;
  }
  if (verification.status === 'not_configured') {
    return `<p class="mail-verification">Senaste kontroll ${escapeHtml(when)}: automatisk leveransläsning är inte aktiverad. Statusen är fortfarande ej verifierad.</p>`;
  }
  if (['bounced', 'failed', 'complained'].includes(verification.status)) {
    return `<p class="mail-verification mail-verification-danger">Senaste kontroll ${escapeHtml(when)}: Resend rapporterar ${escapeHtml(verification.status)}.</p>`;
  }
  return `<p class="mail-verification">Senaste kontroll ${escapeHtml(when)}: leveransstatus kunde inte verifieras (${escapeHtml(verification.status || 'okänd')}).</p>`;
}

function emailRow(label, level, verification = null) {
  const review = level.needsReview
    ? `<p class="inline-warning">${escapeHtml(level.verificationText || 'Kräver manuell kontroll')}</p>`
    : `<p class="price-note">${escapeHtml(level.verificationText || 'Ingen leveransstatus tillgänglig.')}</p>`;
  const type = level.mailTypeLabel
    ? `<p class="muted">${escapeHtml(level.mailTypeLabel)} · ${escapeHtml(level.recipientLabel || 'Okänd mottagartyp')}</p>`
    : '';
  const subject = level.subject
    ? `<p class="muted">Ämne: ${escapeHtml(level.subject)}</p>`
    : '';
  const queued = level.queued
    ? '<p class="price-note">Köat. Skickas först när utkorgen är aktiverad.</p>'
    : '';
  const accepted = level.acceptedAt
    ? `<p class="mail-verification">Accepterat av Resend: ${escapeHtml(formatDateTime(level.acceptedAt))}.</p>`
    : '';
  return `<div class="email-row">
    <div><p class="card-kicker">${escapeHtml(label)}</p>
      ${type}${subject}
      <div class="badge-row">${emailBadge(level)}${deliveryBadge(level)}</div>
      ${review}${accepted}${mailVerificationNote(verification)}${queued}
    </div>
    <div class="email-id">${level.resendId
      ? `<span>Resend-ID</span><code>${escapeHtml(level.resendId)}</code>`
      : '<span class="muted">Inget Resend-ID</span>'}</div>
  </div>`;
}

function mailTimeline(event) {
  const steps = Array.isArray(event.timeline) ? event.timeline : [];
  if (!steps.length) return '';
  return `<ol class="mail-timeline">${steps.map((step) => `
    <li class="mail-step mail-step-${escapeHtml(step.state || 'pending')}">
      <span class="mail-step-label">${escapeHtml(step.label)}</span>
      <span class="mail-step-time">${step.at ? escapeHtml(formatDateTime(step.at)) : '–'}</span>
      ${step.detail ? `<span class="mail-step-detail">${escapeHtml(step.detail)}</span>` : ''}
    </li>`).join('')}</ol>`;
}

function mailEventsTable(booking) {
  const events = Array.isArray(booking.mailEvents) ? booking.mailEvents : [];
  if (!events.length) return '<p class="muted">Inga utkorgsposter finns ännu.</p>';
  return `<div class="mail-events">${events.map((event) => `
    <article class="mail-event">
      <header class="mail-event-head">
        <div>
          <p class="card-kicker">${escapeHtml(event.mailTypeLabel)}</p>
          <p class="muted">${escapeHtml(event.recipientLabel || 'Okänd mottagartyp')}${event.subject ? ` · ${escapeHtml(event.subject)}` : ''}</p>
        </div>
        <div class="badge-row">${emailBadge(event)}${deliveryBadge(event)}</div>
      </header>
      <div class="fact-grid mail-facts">
        ${fact('Skapat', escapeHtml(event.createdAt ? formatDateTime(event.createdAt) : '–'))}
        ${fact('Senaste försök', escapeHtml(event.attemptedAt ? formatDateTime(event.attemptedAt) : '–'))}
        ${fact('Försök', escapeHtml(String(event.attemptCount || 0)))}
        ${fact('Resend-ID', event.resendId ? `<code>${escapeHtml(event.resendId)}</code>` : '–')}
      </div>
      <p class="mail-verification ${event.deliveryFailed ? 'mail-verification-danger' : (event.verifiedDelivery ? 'mail-verification-ok' : '')}">${escapeHtml(event.verificationText)}</p>
      ${event.manualReviewReason ? `<p class="inline-warning">${escapeHtml(event.manualReviewReason)}</p>` : ''}
      ${event.deliveryError ? `<p class="price-note">Teknisk felorsak: ${escapeHtml(event.deliveryError)}</p>` : ''}
      ${mailTimeline(event)}
    </article>`).join('')}</div>`;
}

function addonTable(booking) {
  if (!booking.addonLines.length) {
    return '<p class="muted">Inga tillval registrerade i prissnapshotet.</p>';
  }
  return `<div class="table-wrap"><table class="data-table compact">
    <thead><tr><th>Tillval</th><th>Antal</th><th>Styckpris</th><th>Summa</th></tr></thead>
    <tbody>${booking.addonLines.map((line) => `<tr>
      <td data-label="Tillval">${escapeHtml(line.label)}</td>
      <td data-label="Antal">${line.quantity}</td>
      <td data-label="Styckpris">${escapeHtml(formatMoney(line.unitPrice))}</td>
      <td data-label="Summa">${escapeHtml(formatMoney(line.amount))}</td>
    </tr>`).join('')}</tbody>
  </table></div>`;
}

function priceSummary(booking) {
  const hasDiscount = Number(booking.discountAmount) > 0;
  const discount = hasDiscount
    ? `<div class="price-row"><span>${escapeHtml(booking.discountLabel || 'Rabatt')}${booking.discountPercent ? ` (${booking.discountPercent} %)` : ''}</span><strong>− ${escapeHtml(formatMoney(booking.discountAmount))}</strong></div>`
    : '';
  const lodgingLabel = hasDiscount ? 'Boendepris efter rabatt' : 'Boendepris';
  const lodgingAmount = booking.lodgingAfterDiscount ?? booking.lodgingBase;
  const agreed = booking.agreedTotal !== null && booking.agreedTotal !== undefined
    ? `<div class="price-row price-adjustment"><span>Avtalat pris (orsak: ${escapeHtml(booking.priceAdjustmentReason || 'saknas')})</span><strong>${escapeHtml(formatMoney(booking.agreedTotal))}</strong></div>
       <p class="price-note">Serverberäknat pris vid skapandet: ${escapeHtml(formatMoney(booking.calculatedTotal))}.</p>`
    : '';
  return `<div class="price-summary">
    ${discount}
    <div class="price-row"><span>${escapeHtml(lodgingLabel)}</span><strong>${escapeHtml(formatMoney(lodgingAmount))}</strong></div>
    <div class="price-row"><span>Summa tillval</span><strong>${escapeHtml(formatMoney(booking.totalAddons))}</strong></div>
    <div class="price-row price-total"><span>Totalpris</span><strong>${escapeHtml(formatMoney(booking.total))}</strong></div>
    ${agreed}
    <p class="price-note">Priser från bokningstillfället${booking.priceVersion ? ` (version ${escapeHtml(booking.priceVersion)})` : ''}. Räknas inte om vid visning.</p>
  </div>`;
}

function addonEditor(booking) {
  const addons = booking.addons ?? {};
  const extrahus = booking.extrahus ?? {};
  const row = (id, label, checked) => `<label class="check-row"><input type="checkbox" name="${id}"${checked ? ' checked' : ''}> <span>${escapeHtml(label)}</span></label>`;
  return `<div class="addon-editor">
    ${row('slutstad', 'Slutstädning', addons.slutstad)}
    ${row('extrahus', 'Extrahus (1 600 kr/natt, max 6 gäster)', addons.extrahus)}
    <label class="field field-inline"><span>Antal extrahusnätter</span><input type="number" min="1" max="${booking.nights}" name="extrahusNights" value="${escapeHtml(String(extrahus.nights || addons.extrahusNights || 1))}"></label>
    <label class="field field-inline"><span>Gäster i extrahuset</span><input type="number" min="1" max="6" name="extrahusGuests" value="${escapeHtml(String(extrahus.guests || addons.extrahusGuests || 1))}"></label>
    ${row('lakan', 'Lakan och handdukar', addons.lakan)}
    <label class="field field-inline"><span>Antal lakan</span><input type="number" min="0" max="28" name="linenCount" value="${escapeHtml(String(addons.linenCount ?? 0))}"></label>
    ${row('ved', 'Ved', addons.ved)}
    ${row('tidigIncheckning', 'Tidig incheckning', addons.tidigIncheckning)}
    ${row('senUtcheckning', 'Sen utcheckning', addons.senUtcheckning)}
    ${booking.bufferNightsMode === 'manual' ? '<label class="check-row"><input type="checkbox" name="enableAutomaticBufferNights"> <span>Aktivera automatiska buffertnätter (kräver behörighet och konfliktkontroll)</span></label>' : ''}
  </div>`;
}

function warningButton(label, attribute, warning, booking, variant = 'secondary') {
  return `<button type="button" class="btn btn-${escapeHtml(variant)} btn-small" ` +
    `${attribute}="${escapeHtml(warning.id)}" ` +
    `data-reference="${escapeHtml(booking.reference)}" ` +
    `data-etag="${escapeHtml(booking.etag || '')}">${escapeHtml(label)}</button>`;
}

function warningActions(warning, booking, isOwner, writesEnabled) {
  if (warning.severity === 'handled') {
    return warning.recheckable && isOwner && writesEnabled
      ? `<div class="warning-actions">${warningButton('Kontrollera igen', 'data-warning-recheck', warning, booking)}</div>`
      : '';
  }
  const buttons = [];
  if (warning.recheckable) {
    if (isOwner && writesEnabled) {
      buttons.push(warningButton('Kontrollera igen', 'data-warning-recheck', warning, booking));
    } else {
      buttons.push(`<a class="btn btn-secondary btn-small" href="/admin/bookings/${encodeURIComponent(booking.reference)}">Kontrollera igen</a>`);
    }
  }
  let lock = '';
  if (warning.dismissible) {
    if (isOwner && writesEnabled) {
      buttons.push(warningButton('Markera som hanterad', 'data-warning-ack', warning, booking, 'primary'));
    } else {
      lock = `<p class="warning-lock">${isOwner
        ? 'Skrivfunktioner är inte aktiverade i denna miljö.'
        : 'Endast Owner kan kontrollera och markera varningar som hanterade.'}</p>`;
    }
  }
  return `<div class="warning-actions">${buttons.join('')}</div>${lock}`;
}

function warningCard(warning, booking, isOwner, writesEnabled) {
  const handled = warning.severity === 'handled';
  const details = [];
  if (warning.details?.checkedAt) {
    details.push(`<p class="warning-meta">Senast kontrollerad: ${escapeHtml(formatDateTime(warning.details.checkedAt))}.</p>`);
  }
  if (handled) {
    if (warning.handledAt) {
      details.push(`<p class="warning-meta">Hanterad av ${escapeHtml(warning.handledBy || 'Owner')} den ${escapeHtml(formatDateTime(warning.handledAt))}.</p>`);
    }
    if (warning.handledReason) {
      details.push(`<p class="warning-reason"><strong>Motivering:</strong> ${escapeHtml(warning.handledReason)}</p>`);
    }
    if (Array.isArray(warning.details?.blockedNights) && warning.details.blockedNights.length) {
      details.push(`<p class="warning-meta">Upptagna nätter: ${escapeHtml(warning.details.blockedNights.join(', '))}.</p>`);
    }
    if (warning.details?.caveat) {
      details.push(`<p class="warning-caveat">${escapeHtml(warning.details.caveat)}</p>`);
    }
  }
  return `<article class="warning-card warning-card-${escapeHtml(warning.severity)}" data-warning-id="${escapeHtml(warning.id)}">
    <h3>${escapeHtml(warning.title)}</h3>
    <p class="warning-what">${escapeHtml(warning.what)}</p>
    <p class="warning-why"><strong>Varför:</strong> ${escapeHtml(warning.why)}</p>
    ${handled
      ? details.join('')
      : `<p class="warning-recommendation"><strong>Rekommendation:</strong> ${escapeHtml(warning.recommendation)}</p>`}
    ${warningActions(warning, booking, isOwner, writesEnabled)}
    <div class="warning-check-result" data-check-result="${escapeHtml(warning.id)}" role="status" aria-live="polite" hidden></div>
  </article>`;
}

function warningSections(booking, isOwner, writesEnabled) {
  const actionWarnings = booking.actionWarnings ?? [];
  const verifyWarnings = booking.verifyWarnings ?? [];
  const handledWarnings = booking.handledWarnings ?? [];
  const sections = [];
  if (actionWarnings.length) {
    sections.push(`<section class="warning-banner warning-banner-action" aria-label="Kräver åtgärd">
      <div class="warning-banner-head"><strong>Kräver åtgärd</strong><span>${actionWarnings.length} olösta problem</span></div>
      ${actionWarnings.map((warning) => warningCard(warning, booking, isOwner, writesEnabled)).join('')}
    </section>`);
  }
  if (verifyWarnings.length) {
    sections.push(`<section class="warning-group warning-group-verify" aria-label="Behöver kontrolleras">
      <div class="warning-group-head"><h2>Behöver kontrolleras</h2><span>${verifyWarnings.length}</span></div>
      ${verifyWarnings.map((warning) => warningCard(warning, booking, isOwner, writesEnabled)).join('')}
    </section>`);
  }
  if (handledWarnings.length) {
    sections.push(`<section class="warning-group warning-group-handled" aria-label="Hanterade varningar">
      <div class="warning-group-head"><h2>Hanterad</h2><span>${handledWarnings.length}</span></div>
      ${handledWarnings.map((warning) => warningCard(warning, booking, isOwner, writesEnabled)).join('')}
    </section>`);
  }
  return sections.join('');
}

function warningHistory(booking) {
  const current = new Set((booking.handledWarnings ?? [])
    .map((warning) => `${warning.id}|${warning.fingerprint}`));
  const stale = (booking.warningAcknowledgements ?? [])
    .filter((ack) => !current.has(`${ack.warningId}|${ack.fingerprint}`));
  if (!stale.length) return '';
  return `<details class="warning-group warning-group-handled warning-history">
    <summary><strong>Tidigare hanterade varningar</strong> (${stale.length})</summary>
    <ul class="warning-history-list">
      ${stale.slice().reverse().map((ack) => `<li>
        <strong>${escapeHtml(ack.title || ack.warningId)}</strong>
        <span>${escapeHtml(ack.actorName || 'Owner')} · ${escapeHtml(formatDateTime(ack.at))}</span>
        <p>${escapeHtml(ack.reason || 'Motivering saknas')}</p>
        <p class="warning-caveat">Gäller inte längre eftersom bokningens uppgifter har ändrats.</p>
      </li>`).join('')}
    </ul>
  </details>`;
}

function overridePanel(booking) {
  if (!booking.airbnbOverride) return '';
  const shownAsHandled = (booking.handledWarnings ?? []).some((warning) => warning.id === 'airbnb.override');
  if (shownAsHandled) return '';
  return `<div class="notice-banner">
    <strong>Godkänt Airbnb-undantag.</strong> ${escapeHtml(booking.airbnbOverrideReason || 'Motivering saknas')} ·
    Godkänd av ${escapeHtml(booking.airbnbOverrideApprovedBy || 'okänd')} ${escapeHtml(formatDateTime(booking.airbnbOverrideApprovedAt))}.
    ${booking.airbnbBlockedNights?.length ? `Upptagna nätter: ${escapeHtml(booking.airbnbBlockedNights.join(', '))}.` : ''}
    Undantaget är ett administrativt godkännande, inte ett bevis på att Airbnb är blockerat.
  </div>`;
}

function documentActions(booking) {
  const reference = encodeURIComponent(booking.reference);
  const quoteHref = `/api/admin/bookings/${reference}/quote.pdf`;
  const confirmationHref = `/api/admin/bookings/${reference}/confirmation.pdf`;
  const confirmation = booking.statusCode === 'CONFIRMED'
    ? `<a class="btn btn-secondary" href="${confirmationHref}" download>Ladda ned bokningsbekräftelse (PDF)</a>`
    : `<p class="muted">Bokningsbekräftelse är endast tillgänglig för bekräftade bokningar.</p>`;
  return `<section class="panel">
    <div class="panel-heading"><div><p class="eyebrow">Dokument</p><h2>Offert och bekräftelse</h2></div></div>
    <div class="button-stack">
      <a class="btn btn-primary" href="${quoteHref}" download>Ladda ned offert (PDF)</a>
      ${confirmation}
    </div>
    <p class="price-note">Dokumenten genereras från bokningens sparade uppgifter och ändrar inte bokningen, statusen eller betalningarna.</p>
  </section>`;
}

function statusActions(booking, outboxEnabled = false) {
  if (booking.isBlock) {
    return `<div class="button-stack">
      <button type="button" class="btn btn-danger" data-block-remove="${escapeHtml(booking.reference)}" data-etag="${escapeHtml(booking.etag)}">Avblockera datum</button>
    </div><p class="notice">Avblockering tar bort alla kalenderrader för blockeringen och loggas.</p>`;
  }
  const buttons = [];
  if (booking.statusCode === 'PENDING') {
    buttons.push(actionButton('Godkänn som preliminär', 'approve', booking, 'primary'));
  }
  if (['PENDING', 'PRELIMINARY'].includes(booking.statusCode)) {
    buttons.push(actionButton('Bekräfta bokning', 'confirm', booking, 'primary', { requiresOwner: true }));
    buttons.push(actionButton('Neka', 'decline', booking, 'ghost', {
      prompt: 'Orsak till nekande', requiresReason: true
    }));
  }
  if (booking.statusCode === 'CONFIRMED') {
    buttons.push(actionButton('Avboka', 'cancel', booking, 'danger', {
      prompt: 'Orsak till avbokning', requiresReason: true, requiresOwner: true
    }));
  }
  if (booking.statusCode === 'RECONCILIATION') {
    buttons.push(actionButton('Bekräfta bokning manuellt', 'confirm', booking, 'primary', { requiresOwner: true }));
    buttons.push(actionButton('Avboka och frigör datum', 'cancel', booking, 'danger', {
      prompt: 'Orsak till avbokning och frigöring av datum', requiresReason: true, requiresOwner: true
    }));
  }
  if (!buttons.length) return '<p class="muted">Ingen statusåtgärd tillgänglig för nuvarande status.</p>';
  const disabled = outboxEnabled ? '' : ' disabled';
  const notice = outboxEnabled
    ? 'Bekräftelsemejl köas till utkorgen. Status Skickad i mejlpanelen betyder att Resend accepterat mejlet, inte att det levererats.'
    : 'Mejlutskick är inte aktiverat i denna miljö. Bokningen kan bekräftas utan att något mejl köas.';
  return `<div class="button-stack">${buttons.join('')}</div>
    <label class="check-row${outboxEnabled ? '' : ' muted'}"><input type="checkbox" id="send-confirmation-email"${disabled}> Skicka bekräftelsemejl till gästen</label>
    <p class="notice">${notice}</p>`;
}

function paymentMethodOptions() {
  return PAYMENT_METHOD_CODES.map((code) =>
    `<option value="${escapeHtml(code)}">${escapeHtml(PAYMENT_METHODS[code])}</option>`
  ).join('');
}

function paymentHistory(booking, isOwner, writesEnabled) {
  const payments = sortPayments(booking.payments ?? []);
  const corrected = new Set(payments
    .filter((payment) => payment.type === 'CORRECTION')
    .map((payment) => payment.correctsPaymentId));
  const rows = [];
  if (Number(booking.openingBalanceOre) > 0) {
    rows.push(`<li class="payment-entry payment-opening">
      <div class="payment-entry-top"><strong>${escapeHtml(formatOre(booking.openingBalanceOre))}</strong><span>Ingående saldo</span></div>
      <p class="payment-entry-meta">Registrerat mottaget belopp från tidigare betalningsuppgift.</p>
      <p class="payment-entry-actor">Ingen separat betalningspost finns. Beloppet räknas inte dubbelt.</p>
    </li>`);
  }
  for (const payment of payments) {
    const correction = payment.type === 'CORRECTION';
    const canCorrect = isOwner && writesEnabled && !correction && !corrected.has(payment.id);
    const reference = payment.reference
      ? `<p class="payment-entry-meta">Referens: ${escapeHtml(payment.reference)}</p>`
      : '';
    const note = payment.note
      ? `<p class="payment-entry-meta">${escapeHtml(payment.note)}</p>`
      : '';
    const reason = correction
      ? `<p class="payment-correction"><strong>Motivering:</strong> ${escapeHtml(payment.reason || 'Motivering saknas')}</p>`
      : '';
    rows.push(`<li class="payment-entry${correction ? ' payment-correction-row' : ''}">
      <div class="payment-entry-top">
        <strong>${escapeHtml(formatOre(payment.amountOre))}</strong>
        <span>${escapeHtml(formatDateKey(payment.paymentDate))}</span>
      </div>
      <p class="payment-entry-meta">${escapeHtml(payment.methodLabel)}</p>
      ${reference}${note}${reason}
      <p class="payment-entry-actor">Registrerad av ${escapeHtml(payment.createdBy || 'Okänd')} · ${escapeHtml(formatDateTime(payment.createdAt))}</p>
      ${canCorrect ? `<button type="button" class="btn btn-ghost btn-small" data-payment-correct="${escapeHtml(payment.id)}" data-reference="${escapeHtml(booking.reference)}" data-etag="${escapeHtml(booking.etag || '')}">Rättelse</button>` : ''}
    </li>`);
  }
  if (!rows.length) return '<p class="muted">Inga betalningar registrerade ännu.</p>';
  return `<ul class="payment-history">${rows.join('')}</ul>`;
}

function stripePaymentSection(booking, isOwner, writesEnabled, stripeEnabled, stripeMode, swishEnabled) {
  const link = booking.paymentLink ?? { status: 'NONE', statusLabel: 'Ingen länk' };
  const remainingOre = Number(booking.remainingOre ?? 0);
  const confirmed = booking.statusCode === 'CONFIRMED';
  const canCreate = isOwner && writesEnabled && stripeEnabled && confirmed && remainingOre > 0;
  const active = link.status === 'OPEN';
  const createButton = canCreate
    ? `<button type="button" class="btn btn-primary" data-stripe-payment-link data-reference="${escapeHtml(booking.reference)}" data-etag="${escapeHtml(booking.etag || '')}">${active ? 'Skapa ny länk' : 'Skapa betalningslänk'}</button>`
    : '';
  const revokeButton = active && isOwner && writesEnabled
    ? `<button type="button" class="btn btn-ghost" data-revoke-payment-link data-reference="${escapeHtml(booking.reference)}" data-etag="${escapeHtml(booking.etag || '')}">Återkalla länk</button>`
    : '';
  const linkBlock = link.status === 'NONE'
    ? '<p class="muted">Ingen betalningssida är skapad.</p>'
    : `<div class="notice">
        <strong>${escapeHtml(link.statusLabel)}</strong>
        <p>Utestående: ${escapeHtml(formatOre(remainingOre))}</p>
        ${link.expiresAt ? `<p>Gäller till: ${escapeHtml(formatDateTime(link.expiresAt))}</p>` : ''}
        ${link.createdAt ? `<p class="payment-entry-actor">Skapad av ${escapeHtml(link.createdBy || 'Okänd')} ${escapeHtml(formatDateTime(link.createdAt))}</p>` : ''}
        ${link.revokedAt ? `<p class="payment-entry-actor">Återkallad ${escapeHtml(formatDateTime(link.revokedAt))}</p>` : ''}
        ${active ? '<p class="price-note">Av säkerhetsskäl visas inte själva länken igen. Skapa en ny länk om den behöver skickas på nytt; den gamla blir då ogiltig.</p>' : ''}
      </div>`;
  let notice = '';
  if (!stripeEnabled) {
    notice = '<p class="notice">Betalningslänkar är inte aktiverade i denna miljö.</p>';
  } else if (!confirmed) {
    notice = '<p class="notice">Betalningslänk kan endast skapas för en bekräftad bokning.</p>';
  } else if (remainingOre <= 0) {
    notice = '<p class="notice">Bokningen är fullbetald. Ingen ny betalningslänk behövs.</p>';
  }
  const modeNote = stripeEnabled && stripeMode === 'test'
    ? '<p class="price-note">Kortbetalning är i Stripe testläge. Inga riktiga betalningar genomförs.</p>'
    : stripeEnabled && stripeMode === 'live'
      ? '<p class="inline-warning">Kortbetalning är i live-läge. Betalningar kan dras på riktigt.</p>'
      : '';
  const swishNote = swishEnabled
    ? '<p class="price-note">Swish är aktiverat som kompletterande betalmetod.</p>'
    : '<p class="price-note">Swish är avstängt. Det kan aktiveras senare med STRIPE_SWISH_ENABLED=1.</p>';
  return `<div class="panel-heading payment-history-heading"><div><p class="eyebrow">Kort</p><h3>Betalningssida</h3></div></div>
    ${linkBlock}
    ${notice}
    ${(createButton || revokeButton) ? `<div class="button-row">${createButton}${revokeButton}</div>` : ''}
    ${modeNote}
    ${swishNote}`;
}

function invoiceRequestCard(booking, request, isOwner, writesEnabled) {
  const transitions = INVOICE_REQUEST_TRANSITIONS[request.status] ?? [];
  const options = transitions
    .map((status) => `<option value="${escapeHtml(status)}">${escapeHtml(INVOICE_REQUEST_STATUSES[status])}</option>`)
    .join('');
  const statusForm = isOwner && writesEnabled && options
    ? `<form data-admin-form="invoice-status" data-reference="${escapeHtml(booking.reference)}" data-request-id="${escapeHtml(request.id)}" data-etag="${escapeHtml(booking.etag || '')}">
        <div class="form-grid">
          <label class="booking-field">Ny status
            <select name="status">${options}</select>
          </label>
          <label class="booking-field">Orsak (krävs vid makulering)
            <input type="text" name="reason" maxlength="500">
          </label>
        </div>
        <div class="button-row"><button type="submit" class="btn btn-secondary btn-small">Uppdatera fakturabegäran</button></div>
      </form>`
    : '';
  return `<div class="notice">
      <strong>${escapeHtml(request.statusLabel)}</strong>
      <p>Belopp: ${escapeHtml(formatOre(request.amountOre))} · Begärd ${escapeHtml(formatDateTime(request.createdAt))}</p>
      <div class="fact-grid">
        ${fact('Faktureras till', escapeHtml(request.invoiceName || '—'))}
        ${fact('Organisationsnummer', escapeHtml(request.invoiceOrgNumber || '—'))}
        ${fact('Adress', escapeHtml([request.invoiceAddress, request.invoicePostalCode, request.invoiceCity].filter(Boolean).join(', ') || '—'))}
        ${fact('E-post', escapeHtml(request.invoiceEmail || '—'))}
        ${fact('Referens', escapeHtml(request.invoiceReference || '—'))}
      </div>
      ${request.invoiceNotes ? `<p class="prose">${escapeHtml(request.invoiceNotes)}</p>` : ''}
      ${request.reason ? `<p class="payment-entry-actor">Senaste orsak: ${escapeHtml(request.reason)}</p>` : ''}
      ${statusForm}
    </div>`;
}

function invoicePanel(booking, isOwner, writesEnabled) {
  const requests = Array.isArray(booking.invoiceRequests) ? booking.invoiceRequests : [];
  return `<section class="panel">
    <div class="panel-heading"><div><p class="eyebrow">Faktura</p><h2>Fakturabegäranden</h2></div></div>
    ${requests.length
      ? requests.map((request) => invoiceRequestCard(booking, request, isOwner, writesEnabled)).join('')
      : '<p class="muted">Inga fakturabegäranden.</p>'}
    <p class="price-note">En fakturabegäran markerar aldrig bokningen som betald. Ingen faktura skickas automatiskt i detta steg.</p>
  </section>`;
}

function paymentPanel(booking, isOwner, writesEnabled, today, stripeEnabled, stripeMode, swishEnabled) {
  const totalOre = Number(booking.totalOre ?? Math.round(Number(booking.total || 0) * 100));
  const paidOre = Number(booking.amountPaidOre ?? Math.round(Number(booking.amountPaid || 0) * 100));
  const remainingOre = Number(booking.remainingOre ?? (totalOre - paidOre));
  const overpaidOre = Number(booking.overpaidOre ?? Math.max(0, -remainingOre));
  const overpaid = overpaidOre > 0;
  const stripeReference = booking.stripeSessionId || booking.stripePaymentIntentId || '';
  const reconciliation = booking.reconciliation;
  const form = isOwner && writesEnabled
    ? `<details class="payment-register">
        <summary class="btn btn-primary">Registrera betalning</summary>
        <form data-admin-form="payment-record" data-reference="${escapeHtml(booking.reference)}" data-etag="${escapeHtml(booking.etag || '')}">
          <label class="field"><span>Belopp i kronor</span><input type="number" name="amount" min="0.01" step="0.01" required placeholder="Till exempel 5000"></label>
          <label class="field"><span>Betalningsdatum</span><input type="date" name="paymentDate" value="${escapeHtml(today || todayKey())}" required></label>
          <label class="field"><span>Betalningssätt</span><select name="method" required>${paymentMethodOptions()}</select></label>
          <label class="field"><span>Referens eller anteckning (valfritt)</span><input type="text" name="reference" maxlength="500" placeholder="Till exempel bankreferens"></label>
          <div class="button-row"><button class="btn btn-primary" type="submit">Registrera betalning</button></div>
          <p class="form-error" data-form-error hidden></p>
          <p class="price-note">Betalningen läggs till i historiken och ändrar inte bokningens avtalade totalpris, status eller kalenderlåsning.</p>
        </form>
      </details>`
    : `<p class="notice">${isOwner
      ? 'Skrivfunktioner är inte aktiverade i denna miljö.'
      : 'Endast Owner kan registrera eller rätta betalningar. Du kan läsa betalningshistoriken.'}</p>`;
  return `<section class="panel">
    <div class="panel-heading"><div><p class="eyebrow">Ekonomi</p><h2>Betalning</h2></div></div>
    <div class="payment-summary">
      <div class="price-row"><span>Totalpris</span><strong>${escapeHtml(formatOre(totalOre))}</strong></div>
      <div class="price-row"><span>Totalt betalt</span><strong>${escapeHtml(formatOre(paidOre))}</strong></div>
      <div class="price-row"><span>Återstår</span><strong>${escapeHtml(formatOre(Math.max(0, remainingOre)))}</strong></div>
      ${overpaid ? `<div class="price-row payment-overpaid"><span>Överbetalning</span><strong>${escapeHtml(formatOre(overpaidOre))}</strong></div>` : ''}
      <div class="price-row"><span>Betalstatus</span><strong>${escapeHtml(booking.paymentLabel || PAYMENT_LABELS[booking.paymentStatus] || 'Okänd')}</strong></div>
    </div>
    ${stripeReference ? `<p class="payment-entry-meta">Stripe-transaktion: ${escapeHtml(stripeReference)}</p>` : ''}
    ${reconciliation ? `<div class="warning-banner warning-banner-action">
      <div class="warning-banner-head"><strong>Avstämning krävs</strong><span>${escapeHtml(formatDateTime(reconciliation.at))}</span></div>
      <p>${escapeHtml(reconciliation.reason || 'Betalningen är mottagen men bokningen kunde inte bekräftas säkert.')}</p>
      <p class="payment-entry-meta">Stripe-session: ${escapeHtml(reconciliation.sessionId || '—')} · Belopp: ${escapeHtml(formatOre(reconciliation.amountOre))}</p>
    </div>` : ''}
    ${form}
    ${stripePaymentSection(booking, isOwner, writesEnabled, stripeEnabled, stripeMode, swishEnabled)}
    <div class="panel-heading payment-history-heading"><div><p class="eyebrow">Historik</p><h3>Betalningshistorik</h3></div></div>
    ${paymentHistory(booking, isOwner, writesEnabled)}
  </section>`;
}

function refundPanel(booking, isOwner, writesEnabled) {
  const summary = booking.refundSummary ?? { refunds: [], calculatedOre: 0, remainingOre: 0, statusLabel: 'Ingen uppgift' };
  const refunds = Array.isArray(summary.refunds) ? summary.refunds : [];
  const rows = refunds.length
    ? refunds.map((refund) => `<tr>
        <td data-label="Status">${escapeHtml(refund.status === 'COMPLETED' ? 'Genomförd' : refund.status === 'PROCESSING' ? 'Pågår' : 'Misslyckades')}</td>
        <td data-label="Belopp">${escapeHtml(formatOre(refund.amountOre))}</td>
        <td data-label="Stripe Refund-ID"><code>${escapeHtml(refund.stripeRefundId || '—')}</code></td>
        <td data-label="Källa">${escapeHtml(refund.source === 'STRIPE' ? 'Stripe' : 'Manuell')}</td>
        <td data-label="Datum">${escapeHtml(refund.completedAt ? formatDateTime(refund.completedAt) : refund.createdAt ? formatDateTime(refund.createdAt) : '—')}</td>
      </tr>`).join('')
    : '<tr><td colspan="5" class="muted">Inga återbetalningar registrerade.</td></tr>';
  return `<section class="panel">
    <div class="panel-heading"><div><p class="eyebrow">Ekonomi</p><h2>Återbetalning</h2></div><span class="snapshot-pill">${escapeHtml(summary.statusLabel)}</span></div>
    <div class="fact-grid">
      ${fact('Registrerat betalt', escapeHtml(formatOre(summary.paidOre)))}
      ${fact('Underlag enligt policy', escapeHtml(formatOre(summary.basisOre)))}
      ${fact('Policysats', summary.percent === null ? '—' : `${summary.percent} %`)}
      ${fact('Beräknad återbetalning', escapeHtml(formatOre(summary.calculatedOre)))}
      ${fact('Genomfört', escapeHtml(formatOre(summary.completedOre)))}
      ${fact('Pågår', escapeHtml(formatOre(summary.processingOre)))}
      ${fact('Kvar att hantera', escapeHtml(formatOre(summary.remainingOre)))}
    </div>
    <div class="table-wrap"><table class="data-table compact">
      <thead><tr><th>Status</th><th>Belopp</th><th>Stripe Refund-ID</th><th>Källa</th><th>Datum</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
    ${summary.remainingOre > 0
      ? '<p class="notice">Återbetalning behöver hanteras. Ingen återbetalning utförs automatiskt av portalen.</p>'
      : summary.calculatedOre > 0
        ? '<p class="price-note">Beräknat återbetalningsbelopp är fullt hanterat enligt registrerade poster.</p>'
        : '<p class="price-note">Policyn ger ingen återbetalning för detta datum.</p>'}
    ${summary.policyVersion ? `<p class="price-note">Policy ${escapeHtml(summary.policyVersion)} · ${escapeHtml(summary.basis || '')} · avbokningsdatum ${escapeHtml(summary.cancellationDate || '')}</p>` : ''}
    ${isOwner && writesEnabled ? `
      <form data-admin-form="refund-record" data-reference="${escapeHtml(booking.reference)}" data-etag="${escapeHtml(booking.etag)}">
        <div class="form-grid">
          <label class="field"><span>Status</span><select name="status" required>
            <option value="PROCESSING">Pågår</option>
            <option value="COMPLETED">Genomförd</option>
            <option value="FAILED">Misslyckades</option>
          </select></label>
          <label class="field"><span>Belopp i kronor</span><input type="number" min="0.01" step="0.01" name="amount" required></label>
          <label class="field"><span>Stripe Refund-ID (krävs för genomförd)</span><input type="text" name="stripeRefundId" maxlength="120" placeholder="re_..."></label>
        </div>
        <label class="field"><span>Orsak</span><input type="text" name="reason" maxlength="500"></label>
        <label class="field"><span>Intern anteckning</span><input type="text" name="note" maxlength="1000"></label>
        <label class="check-row"><input type="checkbox" name="confirm" required> Jag bekräftar att uppgifterna avser en faktisk eller påbörjad återbetalning.</label>
        <input type="hidden" name="idempotencyKey" value="">
        <div class="button-row">
          <button class="btn btn-secondary" type="submit">Registrera återbetalning</button>
          <button class="btn btn-ghost" type="button" data-sync-refunds="${escapeHtml(booking.reference)}">Hämta från Stripe</button>
        </div>
        <p class="price-note">Portalen utför ingen återbetalning. Registreringen är ett spårbarhetsskydd; genomför återbetalningen i Stripe först.</p>
      </form>` : '<p class="price-note">Endast Owner kan registrera återbetalningar.</p>'}
    ${booking.refundSyncRequested ? '<p class="notice">Synk mot Stripe är begärd och körs inom några minuter.</p>' : ''}
    ${booking.refundSyncError ? `<p class="inline-warning">${escapeHtml(booking.refundSyncError)}</p>` : ''}
    ${booking.refundSyncedAt ? `<p class="price-note">Senast synkad från Stripe: ${escapeHtml(formatDateTime(booking.refundSyncedAt))}</p>` : ''}
  </section>`;
}

function reconciliationPanel(booking, isOwner, writesEnabled) {
  if (!['PENDING_PAYMENT', 'RECONCILIATION'].includes(booking.statusCode)) return '';
  const review = booking.paymentReview;
  return `<section class="panel">
    <div class="panel-heading"><div><p class="eyebrow">Betalning</p><h2>Avstämning mot Stripe</h2></div></div>
    ${review ? `<p class="prose">${escapeHtml(review.message || review.reason || 'Kontroll krävs.')}</p>
      <p class="price-note">Kontrollerad: ${escapeHtml(review.checkedAt ? formatDateTime(review.checkedAt) : '—')}${review.sessionId ? ` · Session ${escapeHtml(review.sessionId)}` : ''}</p>` : '<p class="muted">Ingen Stripe-kontroll har sparats ännu.</p>'}
    ${booking.reconciliationRequest?.status === 'REQUESTED'
      ? '<p class="notice">Avstämning är begärd och körs automatiskt inom några minuter.</p>'
      : ''}
    ${isOwner && writesEnabled
      ? `<div class="button-row"><button class="btn btn-secondary" type="button" data-request-reconciliation="${escapeHtml(booking.reference)}">Kontrollera betalning mot Stripe</button></div>
         <p class="price-note">Systemet kontrollerar den faktiska Stripe-sessionen. En betald session återupptar den säkra bekräftelseprocessen med Airbnb-kontroll. En avstämningsbokning bekräftas aldrig automatiskt.</p>`
      : ''}
  </section>`;
}

function addonStatusLabel(status) {
  const labels = {
    PENDING_PAYMENT: 'Väntar på betalning',
    PAID: 'Betald',
    RECONCILIATION: 'Avstämning krävs',
    EXPIRED: 'Utgången',
    FAILED: 'Misslyckad',
    CANCELED: 'Avbokad'
  };
  return labels[String(status ?? '').toUpperCase()] ?? (status || 'Okänd');
}

function addonStatusTone(status) {
  const code = String(status ?? '').toUpperCase();
  if (code === 'PAID') return 'confirmed';
  if (code === 'RECONCILIATION') return 'warning';
  if (code === 'EXPIRED' || code === 'FAILED' || code === 'CANCELED') return 'danger';
  return 'preliminary';
}

function addonOrdersPanel(orders = [], requests = []) {
  const orderRows = (Array.isArray(orders) ? orders : []).map((order) => {
    const lines = Array.isArray(order.lines) ? order.lines : [];
    const emailStatus = order.emailStatus && typeof order.emailStatus === 'object'
      ? [order.emailStatus.guest, order.emailStatus.host].filter(Boolean).join(' / ')
      : '';
    return `<article class="addon-admin-card">
      <div class="addon-admin-head">
        <div>
          <p class="eyebrow">Tillvalsorder</p>
          <h3><code>${escapeHtml(order.orderId ?? '')}</code></h3>
        </div>
        <span class="badge badge-${addonStatusTone(order.status)}">${escapeHtml(addonStatusLabel(order.status))}</span>
      </div>
      <div class="fact-grid">
        ${fact('Skapad', escapeHtml(formatDateTime(order.createdAt)))}
        ${fact('Belopp', escapeHtml(formatOre(Number(order.totalOre) || Math.round(Number(order.total || 0) * 100))))}
        ${order.paidAt ? fact('Betald', escapeHtml(formatDateTime(order.paidAt))) : ''}
        ${order.sessionId ? fact('Stripe-session', `<code>${escapeHtml(order.sessionId)}</code>`) : ''}
        ${order.paymentId ? fact('Betalningspost', `<code>${escapeHtml(order.paymentId)}</code>`) : ''}
        ${order.termsVersion ? fact('Villkorsversion', escapeHtml(order.termsVersion)) : ''}
        ${Array.isArray(order.bufferNights) && order.bufferNights.length
          ? fact('Buffertnätter', order.bufferNights.map((night) => escapeHtml(formatDateKey(night))).join(', '))
          : ''}
        ${emailStatus ? fact('Mejl', escapeHtml(emailStatus)) : ''}
      </div>
      ${lines.length ? `<ul class="addon-admin-lines">${lines.map((line) =>
        `<li><span>${escapeHtml(line.label)}${Number(line.quantity) > 1 ? ` × ${Number(line.quantity)}` : ''}</span><strong>${escapeHtml(formatOre(Number(line.amountOre) || Math.round(Number(line.amount || 0) * 100)))}</strong></li>`
      ).join('')}</ul>` : ''}
      ${order.reconciliation ? `<p class="inline-warning">Avstämning: ${escapeHtml(order.reconciliation.reason ?? '')} ${order.reconciliation.code ? `(${escapeHtml(order.reconciliation.code)})` : ''}</p>` : ''}
      ${order.status === 'PENDING_PAYMENT' && order.checkoutUrl ? `<p class="price-note">Pågående Checkout skapad ${escapeHtml(formatDateTime(order.createdAt))}. Sessionen giltig till ${escapeHtml(formatDateTime(order.expiresAt))}.</p>` : ''}
    </article>`;
  });

  const requestRows = (Array.isArray(requests) ? requests : []).map((request) => `<article class="addon-admin-card">
    <div class="addon-admin-head">
      <div><p class="eyebrow">Tillvalsförfrågan</p><h3><code>${escapeHtml(request.requestId ?? '')}</code></h3></div>
      <span class="badge badge-${request.status === 'PENDING' ? 'preliminary' : 'neutral'}">${escapeHtml(request.status === 'PENDING' ? 'Väntar på svar' : request.status ?? '')}</span>
    </div>
    <div class="fact-grid">${fact('Skapad', escapeHtml(formatDateTime(request.createdAt)))}</div>
    <ul class="addon-admin-lines">${(Array.isArray(request.lines) ? request.lines : []).map((line) =>
      `<li><span>${escapeHtml(line.label)}</span></li>`
    ).join('')}</ul>
    ${request.message ? `<p class="prose">${escapeHtml(request.message)}</p>` : ''}
    <p class="price-note">Ingen betalning har skett. Huvudbokningens status ändras inte av förfrågan.</p>
  </article>`);

  if (!orderRows.length && !requestRows.length) {
    return `<section class="panel">
      <div class="panel-heading"><div><p class="eyebrow">Ekonomi</p><h2>Tillvalsköp och förfrågningar</h2></div></div>
      <p class="muted">Inga tillvalsordrar eller tillvalsförfrågningar finns registrerade för bokningen.</p>
    </section>`;
  }
  return `<section class="panel">
    <div class="panel-heading"><div><p class="eyebrow">Ekonomi</p><h2>Tillvalsköp och förfrågningar</h2></div><span class="snapshot-pill">Separata från boendebetalningen</span></div>
    <p class="price-note">Tillvalsordrar är egna Stripe-betalningar. De påverkar bokningens addonOrders och betalningshistorik men ändrar aldrig boendedatum eller det ursprungliga boendepriset.</p>
    ${orderRows.join('')}
    ${requestRows.join('')}
  </section>`;
}

function renderBookingDetail(options) {
  const { booking, principal, demo, csrfToken, writesEnabled, history = [], today, stripeEnabled = false, stripeMode = 'disabled', stripeSwishEnabled = false, outboxEnabled = false, addonOrders = [], addonRequests = [] } = options;
  const isOwner = principal.roles?.includes('Owner');
  const content = `
    <div class="detail-header">
      <a class="back-link" href="/admin/bookings">← Alla bokningar</a>
      ${pageHeader(booking.reference, `${booking.guestName} · ${formatDateRange(booking.arrival, booking.departure)}`, statusBadge(booking))}
      <div class="detail-meta">
        <span>Källa: ${escapeHtml(booking.bookingSourceLabel)}</span>
        <span>Skapad: ${formatDateTime(booking.createdAt)}</span>
        <span>Uppdaterad: ${formatDateTime(booking.updatedAt)}</span>
        <span>Version: ${booking.version}</span>
        ${booking.isDemo ? '<span class="demo-tag">Syntetisk demo</span>' : ''}
      </div>
    </div>

    ${warningSections(booking, isOwner, writesEnabled)}
    ${overridePanel(booking)}
    ${warningHistory(booking)}

    <div class="detail-layout">
      <div class="detail-main">
        ${booking.isBlock ? `<section class="panel">
          <div class="panel-heading"><div><p class="eyebrow">Kalender</p><h2>Datumblockering</h2></div></div>
          <div class="fact-grid">
            ${fact('Från', escapeHtml(formatDateKey(booking.arrival, { long: true })))}
            ${fact('Till', escapeHtml(formatDateKey(booking.departure, { long: true })))}
            ${fact('Nätter', String(booking.nights))}
            ${fact('Orsak', escapeHtml(booking.latestNote || 'Ingen angiven'))}
          </div>
        </section>` : `<section class="panel">
          <div class="panel-heading"><div><p class="eyebrow">Gäst</p><h2>Kontaktuppgifter</h2></div></div>
          <div class="fact-grid">
            ${fact('Namn', escapeHtml(booking.guestName))}
            ${fact('E-post', `<a class="text-link" href="mailto:${escapeHtml(booking.email)}">${escapeHtml(booking.email || '—')}</a>`)}
            ${fact('Telefon', `<a class="text-link" href="tel:${escapeHtml(booking.phone.replaceAll(' ', ''))}">${escapeHtml(booking.phone || '—')}</a>`)}
            ${fact('Företag', escapeHtml(booking.company || '—'))}
          </div>
        </section>`}

        <section class="panel">
          <div class="panel-heading"><div><p class="eyebrow">Vistelse</p><h2>Datum och sällskap</h2></div></div>
          <div class="fact-grid">
            ${fact('Ankomst', `<time datetime="${escapeHtml(booking.arrival)}">${escapeHtml(formatDateKey(booking.arrival, { long: true }))}</time>`)}
            ${fact('Avresa', `<time datetime="${escapeHtml(booking.departure)}">${escapeHtml(formatDateKey(booking.departure, { long: true }))}</time>`)}
            ${fact('Antal nätter', String(booking.nights))}
            ${fact('Antal gäster (herrgård)', String(booking.guests))}
            ${booking.extrahus?.enabled
              ? fact('Extrahus', `${booking.extrahus.nights} nätter · ${escapeHtml(booking.extrahus.arrival)}–${escapeHtml(booking.extrahus.departure)} · ${booking.extrahus.guests} gäster`)
              : ''}
            ${fact('Totalt antal gäster', String(booking.totalGuests || booking.guests))}
            ${booking.bufferNights?.length
              ? fact('Kalenderbuffertar', booking.bufferNights.map((night) => escapeHtml(formatDateKey(night))).join(', '))
              : ''}
          </div>
        </section>

        ${booking.isBlock ? '' : `<section class="panel">
          <div class="panel-heading"><div><p class="eyebrow">Pris</p><h2>Tillval och totalsumma</h2></div><span class="snapshot-pill">Sparat prissnapshot</span></div>
          ${addonTable(booking)}
          ${priceSummary(booking)}
        </section>`}

        ${booking.isBlock ? '' : addonOrdersPanel(addonOrders, addonRequests)}

        ${booking.message ? `<section class="panel">
          <div class="panel-heading"><div><p class="eyebrow">Gästen skrev</p><h2>Särskilda önskemål</h2></div></div>
          <p class="prose">${escapeHtml(booking.message)}</p>
        </section>` : ''}

        <section class="panel">
          <div class="panel-heading"><div><p class="eyebrow">Internt</p><h2>Administrativa anteckningar</h2></div></div>
          ${booking.latestNote
            ? `<p class="prose note-text">${escapeHtml(booking.latestNote)}</p>`
            : '<p class="muted">Inga administrativa anteckningar ännu.</p>'}
          <form data-admin-form="note" data-reference="${escapeHtml(booking.reference)}" data-etag="${escapeHtml(booking.etag)}">
            <label class="field field-note">
              <span>Ny anteckning</span>
              <textarea name="note" rows="3" maxlength="2000" required placeholder="Skriv en intern anteckning"></textarea>
            </label>
            <div class="button-row"><button class="btn btn-secondary" type="submit">Spara anteckning</button></div>
          </form>
        </section>

        ${booking.isBlock ? '' : `<section class="panel">
          <div class="panel-heading"><div><p class="eyebrow">Pris</p><h2>Uppdatera tillval</h2></div></div>
          <form data-admin-form="addons" data-reference="${escapeHtml(booking.reference)}" data-etag="${escapeHtml(booking.etag)}">
            ${addonEditor(booking)}
            <label class="field"><span>Ändringsorsak (obligatorisk)</span><input type="text" name="reason" maxlength="500" required></label>
            <div class="button-row"><button class="btn btn-secondary" type="submit">Spara tillval och ny prisberäkning</button></div>
            <p class="price-note">Originalpriset bevaras i en separat prissnapshot. Priset räknas bara om vid denna uttryckliga ändring.</p>
          </form>
        </section>`}

        <section class="panel">
          <div class="panel-heading"><div><p class="eyebrow">Historik</p><h2>Auditlogg</h2></div></div>
          ${historyList(history)}
        </section>
      </div>

      <aside class="detail-side">
        ${booking.isBlock ? '' : documentActions(booking)}

        <section class="panel action-panel">
          <div class="panel-heading"><div><p class="eyebrow">Bokning</p><h2>Åtgärder</h2></div></div>
          ${isOwner
            ? statusActions(booking, outboxEnabled)
            : '<p class="notice">Endast Owner kan ändra status, pris, betalning och blockeringar i denna version.</p>'}
        </section>

        ${booking.isBlock ? '' : paymentPanel(booking, isOwner, writesEnabled, today, stripeEnabled, stripeMode, stripeSwishEnabled)}

        ${booking.isBlock ? '' : reconciliationPanel(booking, isOwner, writesEnabled)}

        ${booking.isBlock ? '' : refundPanel(booking, isOwner, writesEnabled)}

        ${booking.isBlock ? '' : invoicePanel(booking, isOwner, writesEnabled)}

        <section class="panel">
          <div class="panel-heading"><div><p class="eyebrow">Kommunikation</p><h2>Mejlstatus</h2></div></div>
          ${emailRow('Värdmejl', booking.mailStatus.host, booking.mailVerification?.host)}
          ${emailRow('Gästmejl', booking.mailStatus.guest, booking.mailVerification?.guest)}
          ${mailEventsTable(booking)}
          ${booking.statusCode === 'CONFIRMED' && booking.emailObligation &&
            [booking.emailObligation.guest?.status, booking.emailObligation.host?.status]
              .some((status) => status === 'PENDING' || status === 'FAILED')
            ? `<div class="button-row"><button class="btn btn-secondary" type="button" data-retry-notifications="${escapeHtml(booking.reference)}">Köa bekräftelsemejl igen</button></div>
               <p class="notice">Minst en bekräftelse saknar spårbar utkorgspost. Knappen köar om med samma idempotensnyckel och skapar inga dubbletter.</p>`
            : ''}
          <p class="price-note">”Accepterat av Resend” betyder att API:et tog emot mejlet, inte att det levererats till mottagaren. Leveransspårning via Resend-webhook är förberedd i koden men inte aktiverad i produktion. Tills den aktiveras visas slutlig leverans som ej verifierad.</p>
          <details class="mail-manual-help">
            <summary>Manuell leveranskontroll i Resend</summary>
            <ol class="mail-help-list">
              <li>Öppna Resend → Emails och sök på Resend-ID:t ovan.</li>
              <li>Kontrollera händelsen <code>Delivered</code> och tiden för leverans.</li>
              <li>Om leveransen är bekräftad: använd ”Markera som hanterad” på mejlvarningen och skriv in vad du såg i Resend.</li>
              <li>Automatisk kontroll kräver att API-nyckeln får läsa mejlstatus samt att leveranswebhook aktiveras. Detta är inte aktiverat och ändras inte av portalen.</li>
            </ol>
          </details>
        </section>

        <section class="panel">
          <div class="panel-heading"><div><p class="eyebrow">Status</p><h2>Bokningsstatus</h2></div></div>
          <p class="status-large">${statusBadge(booking)}</p>
          <p class="muted">${escapeHtml(booking.statusLabel)}</p>
          <p class="price-note">Bekräftade bokningar och manuella block låser datum. Förfrågningar och preliminära bokningar blockerar inte.</p>
        </section>
      </aside>
    </div>
  `;
  return layout({ title: booking.reference, active: '/admin/bookings', principal, demo, csrfToken, writesEnabled, content });
}

module.exports = { renderBookingDetail };
