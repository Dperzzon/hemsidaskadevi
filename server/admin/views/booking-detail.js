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

function emailRow(label, level) {
  const review = level.needsReview
    ? `<p class="inline-warning">Kräver manuell kontroll</p>`
    : '';
  return `<div class="email-row">
    <div><p class="card-kicker">${escapeHtml(label)}</p>
      <div class="badge-row">${emailBadge(level)}${deliveryBadge(level)}</div>
      ${review}
    </div>
    <div class="email-id">${level.resendId
      ? `<span>Resend-ID</span><code>${escapeHtml(level.resendId)}</code>`
      : '<span class="muted">Inget Resend-ID</span>'}</div>
  </div>`;
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
  const row = (id, label, checked) => `<label class="check-row"><input type="checkbox" name="${id}"${checked ? ' checked' : ''}> <span>${escapeHtml(label)}</span></label>`;
  return `<div class="addon-editor">
    ${row('slutstad', 'Slutstädning', addons.slutstad)}
    ${row('lakan', 'Lakan och handdukar', addons.lakan)}
    <label class="field field-inline"><span>Antal lakan</span><input type="number" min="0" max="${booking.guests}" name="linenCount" value="${escapeHtml(String(addons.linenCount ?? 0))}"></label>
    ${row('ved', 'Ved', addons.ved)}
    ${row('tidigIncheckning', 'Tidig incheckning', addons.tidigIncheckning)}
    ${row('senUtcheckning', 'Sen utcheckning', addons.senUtcheckning)}
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
  if (warning.recheckable && isOwner && writesEnabled) {
    buttons.push(warningButton('Kontrollera igen', 'data-warning-recheck', warning, booking));
  } else {
    buttons.push(`<a class="btn btn-secondary btn-small" href="/admin/bookings/${encodeURIComponent(booking.reference)}">Kontrollera igen</a>`);
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

function statusActions(booking) {
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
  if (!buttons.length) return '<p class="muted">Ingen statusåtgärd tillgänglig för nuvarande status.</p>';
  return `<div class="button-stack">${buttons.join('')}</div>
    <label class="check-row muted"><input type="checkbox" id="send-confirmation-email" disabled> Skicka bekräftelsemejl till gästen</label>
    <p class="notice">E-postutskick är avstängt i detta steg. En bekräftelse skiljs från kvittensen på mottagen förfrågan.</p>`;
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

function paymentPanel(booking, isOwner, writesEnabled, today) {
  const totalOre = Number(booking.totalOre ?? Math.round(Number(booking.total || 0) * 100));
  const paidOre = Number(booking.amountPaidOre ?? Math.round(Number(booking.amountPaid || 0) * 100));
  const remainingOre = Number(booking.remainingOre ?? (totalOre - paidOre));
  const overpaidOre = Number(booking.overpaidOre ?? Math.max(0, -remainingOre));
  const overpaid = overpaidOre > 0;
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
    ${form}
    <div class="panel-heading payment-history-heading"><div><p class="eyebrow">Historik</p><h3>Betalningshistorik</h3></div></div>
    ${paymentHistory(booking, isOwner, writesEnabled)}
  </section>`;
}

function renderBookingDetail(options) {
  const { booking, principal, demo, csrfToken, writesEnabled, history = [], today } = options;
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
            ${fact('Antal gäster', String(booking.guests))}
          </div>
        </section>

        ${booking.isBlock ? '' : `<section class="panel">
          <div class="panel-heading"><div><p class="eyebrow">Pris</p><h2>Tillval och totalsumma</h2></div><span class="snapshot-pill">Sparat prissnapshot</span></div>
          ${addonTable(booking)}
          ${priceSummary(booking)}
        </section>`}

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
            ? statusActions(booking)
            : '<p class="notice">Endast Owner kan ändra status, pris, betalning och blockeringar i denna version.</p>'}
        </section>

        ${booking.isBlock ? '' : paymentPanel(booking, isOwner, writesEnabled, today)}

        <section class="panel">
          <div class="panel-heading"><div><p class="eyebrow">Kommunikation</p><h2>Mejlstatus</h2></div></div>
          ${emailRow('Värdmejl', booking.mailStatus.host)}
          ${emailRow('Gästmejl', booking.mailStatus.guest)}
          <p class="price-note">”Accepterat av Resend” är API-acceptans, inte samma sak som leverans. Inga mejl skickas i detta utvecklingssteg.</p>
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
