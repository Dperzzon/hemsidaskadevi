'use strict';

// Gemensam e-postprofil för Skadevi Herrgård. Alla kundmejl använder samma
// HTML-ram med inline-stilar och tabellayout för god läsbarhet i mobilklienter.
// Dynamiskt innehåll ska alltid escapas innan det läggs i HTML.

const MAIL_BRAND = Object.freeze({
  gold: '#c9a96e',
  goldDark: '#816941',
  dark: '#333333',
  ink: '#2a2a27',
  background: '#f7f5f0',
  paper: '#ffffff',
  border: '#e0dcd3',
  muted: '#6b665d'
});

const LOGO_URL = 'https://www.skadeviherrgard.com/images/logo.png';
const WEBSITE_URL = 'https://www.skadeviherrgard.com';
const BOOKING_INFO_URL = 'https://www.skadeviherrgard.com/boka';
const PRACTICAL_INFO = Object.freeze(require('../../shared/practical-info.json'));

const CONTACT = Object.freeze({
  name: 'Skadevi Herrgård',
  address: 'Skoklostervägen 16, 746 94 Häggeby',
  phone: '+46 70 273 04 22',
  phoneHref: '+46702730422',
  email: 'skadevigard@gmail.com',
  website: 'www.skadeviherrgard.com'
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

function emailShell(title, contentHtml, options = {}) {
  const preheader = options.preheader ? escapeHtml(options.preheader) : '';
  return `<!doctype html>
<html lang="sv">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<title>${escapeHtml(title)}</title>
<style>
@media only screen and (max-width: 600px) {
  .mail-card { width: 100% !important; }
  .mail-pad { padding: 26px 20px 24px !important; }
  .mail-title { font-size: 22px !important; }
  .mail-logo { width: 82px !important; height: 82px !important; }
}
</style>
</head>
<body style="margin:0;padding:0;background:${MAIL_BRAND.background};-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%;">
${preheader ? `<div style="display:none;font-size:1px;color:${MAIL_BRAND.background};line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;">${preheader}</div>` : ''}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${MAIL_BRAND.background};">
<tr><td align="center" style="padding:28px 12px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="mail-card" style="max-width:600px;background:${MAIL_BRAND.paper};border:1px solid ${MAIL_BRAND.border};border-top:3px solid ${MAIL_BRAND.gold};">
<tr><td class="mail-pad" style="padding:38px 42px 32px;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.65;color:${MAIL_BRAND.dark};">
<div style="text-align:center;">
<img src="${LOGO_URL}" width="96" height="96" alt="Skadevi Herrgård" class="mail-logo" style="display:block;width:96px;height:96px;border:0;outline:none;text-decoration:none;margin:0 auto 12px;">
<div style="font-family:Georgia,'Times New Roman',serif;font-size:12px;letter-spacing:3px;color:${MAIL_BRAND.ink};text-transform:uppercase;">Skadevi Herrgård</div>
<div style="height:2px;width:40px;background:${MAIL_BRAND.gold};margin:14px auto 0;"></div>
</div>
<h1 class="mail-title" style="font-family:Georgia,'Times New Roman',serif;font-size:26px;font-weight:normal;line-height:1.35;color:${MAIL_BRAND.ink};margin:22px 0 10px;text-align:center;">${escapeHtml(title)}</h1>
${contentHtml}
<div style="margin:34px 0 0;padding-top:20px;border-top:1px solid ${MAIL_BRAND.border};text-align:center;font-size:11px;line-height:1.7;color:${MAIL_BRAND.muted};">
<div style="font-family:Georgia,'Times New Roman',serif;font-size:13px;letter-spacing:2px;color:${MAIL_BRAND.ink};text-transform:uppercase;margin-bottom:6px;">Skadevi Herrgård</div>
${escapeHtml(CONTACT.address)}<br>
<a href="tel:${escapeHtml(CONTACT.phoneHref)}" style="color:${MAIL_BRAND.muted};text-decoration:none;">${escapeHtml(CONTACT.phone)}</a> ·
<a href="mailto:${escapeHtml(CONTACT.email)}" style="color:${MAIL_BRAND.muted};text-decoration:none;">${escapeHtml(CONTACT.email)}</a><br>
<a href="${WEBSITE_URL}" style="color:${MAIL_BRAND.muted};text-decoration:none;">${escapeHtml(CONTACT.website)}</a>
<div style="margin-top:10px;">Detta mejl skickades av Skadevi Herrgårds bokningssystem.</div>
</div>
</td></tr></table>
</td></tr></table>
</body>
</html>`;
}

function mailList(rows) {
  return `<ul style="margin:10px 0 18px;padding-left:20px;">${rows
    .map((row) => `<li style="margin:5px 0;">${row}</li>`)
    .join('')}</ul>`;
}

function sectionTitle(title) {
  return `<h2 style="font-family:Georgia,'Times New Roman',serif;font-size:18px;font-weight:normal;color:${MAIL_BRAND.ink};margin:30px 0 4px;">${escapeHtml(title)}</h2>
<div style="height:1px;width:32px;background:${MAIL_BRAND.gold};margin:0 0 10px;"></div>`;
}

function detailRow(label, value) {
  return `<p style="margin:0;padding:10px 0;border-bottom:1px solid ${MAIL_BRAND.border};font-size:15px;line-height:1.55;color:${MAIL_BRAND.dark};">${escapeHtml(label)}: ${escapeHtml(value)}</p>`;
}

function practicalInfoHtml() {
  return `<ul style="margin:10px 0 0;padding-left:18px;font-size:15px;line-height:1.65;color:${MAIL_BRAND.dark};">
<li style="margin:0 0 7px;">Incheckning från kl. ${PRACTICAL_INFO.checkInTime}. Utcheckning senast kl. ${PRACTICAL_INFO.checkOutTime}.</li>
<li style="margin:0 0 7px;">Tidig incheckning från kl. ${PRACTICAL_INFO.earlyCheckInTime} och sen utcheckning till kl. ${PRACTICAL_INFO.lateCheckOutTime} kan arrangeras efter överenskommelse och bekräftas av Skadevi Herrgård.</li>
<li style="margin:0 0 7px;">Gratis parkering finns på gården.</li>
<li style="margin:0 0 7px;">Hundar är välkomna i samråd med värden.</li>
<li style="margin:0;">Besöksadress: ${escapeHtml(CONTACT.address)}.</li>
</ul>`;
}

function practicalInfoText() {
  return [
    'Inför er vistelse:',
    `- Incheckning från kl. ${PRACTICAL_INFO.checkInTime}. Utcheckning senast kl. ${PRACTICAL_INFO.checkOutTime}.`,
    `- Tidig incheckning från kl. ${PRACTICAL_INFO.earlyCheckInTime} och sen utcheckning till kl. ${PRACTICAL_INFO.lateCheckOutTime} kan arrangeras efter överenskommelse och bekräftas av Skadevi Herrgård.`,
    '- Gratis parkering finns på gården.',
    '- Hundar är välkomna i samråd med värden.',
    `- Besöksadress: ${CONTACT.address}.`
  ].join('\n');
}

function contactBlockHtml() {
  return `<div style="margin:26px 0 0;padding:16px 18px;background:${MAIL_BRAND.background};border:1px solid ${MAIL_BRAND.border};">
<p style="margin:0 0 8px;font-family:Georgia,'Times New Roman',serif;font-size:15px;color:${MAIL_BRAND.ink};">Kontakt</p>
<p style="margin:0;font-size:13px;line-height:1.7;color:${MAIL_BRAND.dark};">
${escapeHtml(CONTACT.name)}<br>
E-post: <a href="mailto:${escapeHtml(CONTACT.email)}" style="color:${MAIL_BRAND.dark};text-decoration:none;">${escapeHtml(CONTACT.email)}</a><br>
Telefon: <a href="tel:${escapeHtml(CONTACT.phoneHref)}" style="color:${MAIL_BRAND.dark};text-decoration:none;">${escapeHtml(CONTACT.phone)}</a><br>
Webbplats: <a href="${WEBSITE_URL}" style="color:${MAIL_BRAND.dark};text-decoration:none;">${escapeHtml(CONTACT.website)}</a><br>
Besöksadress: ${escapeHtml(CONTACT.address)}
</p>
</div>`;
}

function contactBlockText() {
  return [
    'Kontakt:',
    CONTACT.name,
    `E-post: ${CONTACT.email}`,
    `Telefon: ${CONTACT.phone}`,
    `Webbplats: ${CONTACT.website}`,
    `Besöksadress: ${CONTACT.address}`
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
  PRACTICAL_INFO,
  LOGO_URL,
  WEBSITE_URL,
  BOOKING_INFO_URL,
  escapeHtml,
  formatDate,
  formatSek,
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
};
