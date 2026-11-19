'use strict';

// Gemensam e-postprofil för Skadevi Herrgård. Alla kundmejl använder samma
// HTML-ram med inline-stilar och tabellayout för god läsbarhet i mobilklienter.
// Dynamiskt innehåll ska alltid escapas innan det läggs i HTML.

const MAIL_BRAND = Object.freeze({
  gold: '#c9a96e',
  dark: '#333333',
  background: '#f7f5f0',
  border: '#e0dcd3',
  muted: '#6b665d'
});

const CONTACT = Object.freeze({
  name: 'Skadevi Herrgård',
  address: 'Skoklostervägen 16, 746 94 Häggeby',
  phone: '+46 70 273 04 22',
  phoneHref: '+46702730422',
  email: 'skadevigard@gmail.com'
});

function escapeHtml(value) {
  if (value === undefined || value === null) return '';
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function formatDate(value) {
  const text = String(value ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  const date = new Date(`${text}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return text;
  try {
    return new Intl.DateTimeFormat('sv-SE', {
      timeZone: 'UTC',
      year: 'numeric',
      month: 'long',
      day: 'numeric'
    }).format(date);
  } catch {
    return text;
  }
}

function formatSek(value) {
  const number = Number(value ?? 0);
  if (!Number.isFinite(number)) return '0 kr';
  return `${new Intl.NumberFormat('sv-SE', { maximumFractionDigits: 0 }).format(number)} kr`;
}

function emailShell(title, contentHtml) {
  return `<!doctype html><html lang="sv"><body style="margin:0;padding:0;background:${MAIL_BRAND.background};">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${MAIL_BRAND.background};">
<tr><td align="center" style="padding:24px 12px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:640px;background:#ffffff;border:1px solid ${MAIL_BRAND.border};border-top:4px solid ${MAIL_BRAND.gold};">
<tr><td style="padding:26px 28px;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.65;color:${MAIL_BRAND.dark};">
<div style="font-family:Georgia,'Times New Roman',serif;font-size:23px;letter-spacing:1px;color:${MAIL_BRAND.dark};">Skadevi Herrgård</div>
<div style="height:2px;width:56px;background:${MAIL_BRAND.gold};margin:12px 0 22px;"></div>
<h1 style="font-family:Georgia,'Times New Roman',serif;font-size:20px;font-weight:normal;color:${MAIL_BRAND.dark};margin:0 0 18px;">${escapeHtml(title)}</h1>
${contentHtml}
<p style="margin:26px 0 0;padding-top:16px;border-top:1px solid ${MAIL_BRAND.border};font-size:12px;color:${MAIL_BRAND.muted};">Detta mejl skickades av Skadevi Herrgårds bokningssystem.</p>
</td></tr></table>
</td></tr></table>
</body></html>`;
}

function mailList(rows) {
  return `<ul style="margin:10px 0 18px;padding-left:20px;">${rows
    .map((row) => `<li style="margin:5px 0;">${row}</li>`)
    .join('')}</ul>`;
}

function contactBlockHtml() {
  return `<div style="margin:22px 0 0;padding:14px 16px;background:${MAIL_BRAND.background};border:1px solid ${MAIL_BRAND.border};">
<p style="margin:0 0 6px;"><strong>Kontakt</strong></p>
<p style="margin:0;">${escapeHtml(CONTACT.name)}<br>${escapeHtml(CONTACT.address)}<br>
<a href="tel:${escapeHtml(CONTACT.phoneHref)}" style="color:${MAIL_BRAND.dark};">${escapeHtml(CONTACT.phone)}</a><br>
<a href="mailto:${escapeHtml(CONTACT.email)}" style="color:${MAIL_BRAND.dark};">${escapeHtml(CONTACT.email)}</a></p>
</div>`;
}

function contactBlockText() {
  return [
    'Kontakt:',
    CONTACT.name,
    CONTACT.address,
    `Telefon: ${CONTACT.phone}`,
    `E-post: ${CONTACT.email}`
  ].join('\n');
}

function addonLines(record = {}) {
  const rows = Array.isArray(record.addonLines) ? record.addonLines : [];
  if (!rows.length) return ['Inga tillval'];
  return rows.map((line) => {
    const quantity = Number(line?.quantity);
    const amount = formatSek(line?.amount);
    const label = String(line?.label ?? 'Tillval');
    return quantity > 1 ? `${label}: ${quantity} ×, ${amount}` : `${label}: ${amount}`;
  });
}

function stayLines(record = {}) {
  const lines = [
    `Bokningsreferens: ${record.reference}`,
    `Ankomst: ${formatDate(record.arrival)}`,
    `Avresa: ${formatDate(record.departure)}`,
    `Antal nätter: ${record.nights ?? ''}`,
    `Antal gäster: ${record.guests ?? ''}`
  ];
  if (record.extrahus?.enabled) {
    lines.push(`Extrahus: ${record.extrahus.nights} nätter, ${record.extrahus.guests} gäster`);
  }
  lines.push('Tillval:');
  lines.push(...addonLines(record));
  return lines;
}

module.exports = {
  MAIL_BRAND,
  CONTACT,
  escapeHtml,
  formatDate,
  formatSek,
  emailShell,
  mailList,
  contactBlockHtml,
  contactBlockText,
  addonLines,
  stayLines
};
