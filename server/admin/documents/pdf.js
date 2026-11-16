'use strict';

// PDF-rendering med PDFKit. Dokumenten är servergenererade, A4-anpassade och
// använder Skadevi Herrgårds befintliga logotyp. Ingen bokningsdata skrivs
// tillbaka och inga publika länkar skapas.

const fs = require('node:fs');
const path = require('node:path');
const PDFDocument = require('pdfkit');
const { formatMoney } = require('../domain');
const { filenameFor, DOCUMENT_KINDS } = require('./model');

const LOGO_PATH = path.join(__dirname, '..', '..', '..', 'public', 'images', 'logo.png');

const COLORS = Object.freeze({
  ink: '#262626',
  muted: '#6F675B',
  gold: '#A8894F',
  line: '#D8CDBB',
  band: '#F4EFE5',
  white: '#FFFFFF'
});

const PAGE = Object.freeze({
  size: 'A4',
  margins: { top: 56, bottom: 82, left: 56, right: 56 }
});

const FONTS = Object.freeze({
  serif: 'Times-Roman',
  serifBold: 'Times-Bold',
  serifItalic: 'Times-Italic',
  sans: 'Helvetica',
  sansBold: 'Helvetica-Bold'
});

function contentWidth(ctx) {
  return ctx.doc.page.width - ctx.doc.page.margins.left - ctx.doc.page.margins.right;
}

function pageBottom(ctx) {
  return ctx.doc.page.height - ctx.doc.page.margins.bottom;
}

function ensureSpace(ctx, height) {
  if (ctx.y + height <= pageBottom(ctx)) return;
  ctx.doc.addPage();
  drawContinuationHeader(ctx);
}

function setY(ctx, y) {
  ctx.y = y;
  ctx.doc.y = y;
}

function drawGoldRule(ctx, y, width = contentWidth(ctx), color = COLORS.gold, thickness = 0.9) {
  ctx.doc.moveTo(ctx.doc.page.margins.left, y)
    .lineTo(ctx.doc.page.margins.left + width, y)
    .lineWidth(thickness)
    .strokeColor(color)
    .stroke();
}

function drawLogo(ctx, x, y, size) {
  if (!fs.existsSync(LOGO_PATH)) return false;
  try {
    ctx.doc.image(LOGO_PATH, x, y, { width: size, height: size });
    return true;
  } catch {
    return false;
  }
}

function drawContinuationHeader(ctx) {
  const left = ctx.doc.page.margins.left;
  const width = contentWidth(ctx);
  drawLogo(ctx, left, 40, 24);
  ctx.doc.font(FONTS.serifBold).fontSize(10).fillColor(COLORS.ink)
    .text('SKADEVI HERRGÅRD', left + 34, 46, { width: width - 34 });
  ctx.doc.font(FONTS.sans).fontSize(7.5).fillColor(COLORS.muted)
    .text(ctx.model.title, left, 46, { width, align: 'right' });
  drawGoldRule(ctx, 76, width, COLORS.line, 0.6);
  setY(ctx, 92);
}

function drawFirstPageHeader(ctx) {
  const left = ctx.doc.page.margins.left;
  const width = contentWidth(ctx);
  drawLogo(ctx, left, 40, 52);
  ctx.doc.font(FONTS.serifBold).fontSize(18).fillColor(COLORS.ink)
    .text('SKADEVI HERRGÅRD', left + 66, 46, { width: width - 66 });
  ctx.doc.font(FONTS.sans).fontSize(8.5).fillColor(COLORS.muted)
    .text('Skadevi Herrgård · Bokningsportal', left + 66, 71, { width: width - 66 });
  ctx.doc.font(FONTS.sans).fontSize(8.5).fillColor(COLORS.muted)
    .text(ctx.model.headerRight, left, 71, { width, align: 'right' });
  drawGoldRule(ctx, 102, width, COLORS.gold, 1.2);
  ctx.doc.font(FONTS.serifBold).fontSize(26).fillColor(COLORS.ink)
    .text(ctx.model.title, left, 112, { width, align: 'left' });
  ctx.doc.font(FONTS.serifItalic).fontSize(10).fillColor(COLORS.muted)
    .text(ctx.model.lead, left, 146, { width, align: 'left' });
  drawGoldRule(ctx, 166, width, COLORS.line, 0.6);
  setY(ctx, 180);
}

function drawMeta(ctx) {
  const left = ctx.doc.page.margins.left;
  const width = contentWidth(ctx);
  const half = (width - 24) / 2;
  const rows = ctx.model.kind === DOCUMENT_KINDS.QUOTE
    ? [
      ['Utfärdandedatum', ctx.model.issuedDate],
      ['Bokningsreferens', ctx.model.reference]
    ]
    : [
      ['Utfärdandedatum', ctx.model.issuedDate],
      ['Bokningsnummer', ctx.model.reference]
    ];
  const height = 30;
  ensureSpace(ctx, height);
  for (let index = 0; index < rows.length; index++) {
    const x = left + index * (half + 24);
    ctx.doc.font(FONTS.sansBold).fontSize(7.5).fillColor(COLORS.gold)
      .text(rows[index][0].toUpperCase(), x, ctx.y, { width: half });
    ctx.doc.font(FONTS.serif).fontSize(11).fillColor(COLORS.ink)
      .text(rows[index][1], x, ctx.y + 11, { width: half });
  }
  setY(ctx, ctx.y + height);
}

function drawSectionTitle(ctx, title) {
  ensureSpace(ctx, 40);
  setY(ctx, ctx.y + 8);
  ctx.doc.font(FONTS.sansBold).fontSize(8).fillColor(COLORS.gold)
    .text(title.toUpperCase(), ctx.doc.page.margins.left, ctx.y, {
      width: contentWidth(ctx)
    });
  const lineY = ctx.y + 13;
  drawGoldRule(ctx, lineY, contentWidth(ctx), COLORS.line, 0.6);
  setY(ctx, lineY + 10);
}

function drawParagraph(ctx, text, options = {}) {
  const value = String(text ?? '');
  if (!value.trim()) {
    setY(ctx, ctx.y + 6);
    return;
  }
  const width = options.width ?? contentWidth(ctx);
  const x = options.x ?? ctx.doc.page.margins.left;
  const font = options.font ?? FONTS.serif;
  const size = options.size ?? 10.5;
  const color = options.color ?? COLORS.ink;
  const lineGap = options.lineGap ?? 2;
  ctx.doc.font(font).fontSize(size);
  const height = ctx.doc.heightOfString(value, { width, lineGap, align: options.align ?? 'left' });
  ensureSpace(ctx, height + 2);
  ctx.doc.fillColor(color).text(value, x, ctx.y, {
    width,
    lineGap,
    align: options.align ?? 'left'
  });
  setY(ctx, ctx.y + height + (options.after ?? 0));
}

function drawFactGrid(ctx, facts) {
  const left = ctx.doc.page.margins.left;
  const width = contentWidth(ctx);
  const gap = 24;
  const colWidth = (width - gap) / 2;
  for (let index = 0; index < facts.length; index += 2) {
    const pair = [facts[index], facts[index + 1]];
    const heights = pair.map((fact) => {
      if (!fact) return 0;
      ctx.doc.font(FONTS.serif).fontSize(10.5);
      return ctx.doc.heightOfString(String(fact[1] ?? '—'), { width: colWidth }) + 15;
    });
    const rowHeight = Math.max(24, ...heights);
    ensureSpace(ctx, rowHeight);
    for (let column = 0; column < pair.length; column++) {
      const fact = pair[column];
      if (!fact) continue;
      const x = left + column * (colWidth + gap);
      ctx.doc.font(FONTS.sansBold).fontSize(7.5).fillColor(COLORS.muted)
        .text(String(fact[0]).toUpperCase(), x, ctx.y, { width: colWidth });
      ctx.doc.font(FONTS.serif).fontSize(10.5).fillColor(COLORS.ink)
        .text(String(fact[1] ?? '—'), x, ctx.y + 11, { width: colWidth, lineGap: 1 });
    }
    setY(ctx, ctx.y + rowHeight);
  }
}

function drawAddonTable(ctx) {
  const left = ctx.doc.page.margins.left;
  const width = contentWidth(ctx);
  const columns = [
    { key: 'label', label: 'Tillval', width: width - 45 - 95 - 103, align: 'left' },
    { key: 'quantity', label: 'Antal', width: 45, align: 'right' },
    { key: 'unitPrice', label: 'À-pris', width: 95, align: 'right' },
    { key: 'amount', label: 'Summa', width: 103, align: 'right' }
  ];

  function header() {
    const height = 20;
    ensureSpace(ctx, height + 18);
    ctx.doc.rect(left, ctx.y - 3, width, height).fill(COLORS.band);
    let x = left + 8;
    for (const column of columns) {
      ctx.doc.font(FONTS.sansBold).fontSize(7.5).fillColor(COLORS.muted)
        .text(column.label.toUpperCase(), x, ctx.y + 4, {
          width: column.width - 12,
          align: column.align
        });
      x += column.width;
    }
    setY(ctx, ctx.y + height);
  }

  header();
  for (const line of ctx.model.addons) {
    ctx.doc.font(FONTS.serif).fontSize(10);
    const labelHeight = ctx.doc.heightOfString(line.label, { width: columns[0].width - 12 });
    const rowHeight = Math.max(18, labelHeight + 8);
    if (ctx.y + rowHeight > pageBottom(ctx)) {
      ctx.doc.addPage();
      drawContinuationHeader(ctx);
      header();
    }
    let x = left + 8;
    const values = [
      line.label,
      String(line.quantity),
      formatMoney(line.unitPrice),
      formatMoney(line.amount)
    ];
    for (let index = 0; index < columns.length; index++) {
      const column = columns[index];
      ctx.doc.font(index === 0 ? FONTS.serif : FONTS.serif).fontSize(10).fillColor(COLORS.ink)
        .text(values[index], x, ctx.y + 3, {
          width: column.width - 12,
          align: column.align,
          lineGap: 1
        });
      x += column.width;
    }
    setY(ctx, ctx.y + rowHeight);
    ctx.doc.moveTo(left, ctx.y - 3).lineTo(left + width, ctx.y - 3)
      .lineWidth(0.4).strokeColor(COLORS.line).stroke();
  }
  setY(ctx, ctx.y + 4);
}

function drawPriceTable(ctx) {
  const left = ctx.doc.page.margins.left;
  const width = contentWidth(ctx);
  const amountWidth = 150;
  const labelWidth = width - amountWidth;
  for (const row of ctx.model.price.rows) {
    ctx.doc.font(row.total ? FONTS.serifBold : FONTS.serif).fontSize(row.total ? 13 : 10.5);
    const labelHeight = ctx.doc.heightOfString(row.label, { width: labelWidth });
    let noteHeight = 0;
    if (row.note) {
      ctx.doc.font(FONTS.sans).fontSize(8.5);
      noteHeight = ctx.doc.heightOfString(row.note, { width: labelWidth }) + 2;
    }
    const rowHeight = Math.max(20, labelHeight + noteHeight + 8);
    ensureSpace(ctx, rowHeight);
    if (row.total) {
      ctx.doc.rect(left - 8, ctx.y - 5, width + 16, rowHeight).fill(COLORS.band);
    }
    ctx.doc.font(row.total ? FONTS.serifBold : FONTS.serif)
      .fontSize(row.total ? 13 : 10.5).fillColor(COLORS.ink)
      .text(row.label, left, ctx.y, { width: labelWidth });
    if (row.note) {
      ctx.doc.font(FONTS.sans).fontSize(8.5).fillColor(COLORS.muted)
        .text(row.note, left, ctx.y + labelHeight + 2, { width: labelWidth, lineGap: 1 });
    }
    ctx.doc.font(row.total ? FONTS.serifBold : FONTS.serif)
      .fontSize(row.total ? 13 : 10.5).fillColor(COLORS.ink)
      .text(formatMoney(row.amount), left + labelWidth, ctx.y, {
        width: amountWidth,
        align: 'right'
      });
    setY(ctx, ctx.y + rowHeight);
  }
  setY(ctx, ctx.y + 2);
}

function drawNoticeBox(ctx, lines, options = {}) {
  const left = ctx.doc.page.margins.left;
  const width = contentWidth(ctx);
  const padding = 12;
  const textWidth = width - padding * 2;
  ctx.doc.font(FONTS.serif).fontSize(options.size ?? 10);
  const heights = lines.map((line) => ctx.doc.heightOfString(line, { width: textWidth, lineGap: 1.5 }));
  const boxHeight = heights.reduce((sum, height) => sum + height, 0) + padding * 2 + 4;
  ensureSpace(ctx, boxHeight + 6);
  ctx.doc.rect(left, ctx.y, width, boxHeight).fill(COLORS.band);
  ctx.doc.rect(left, ctx.y, 3, boxHeight).fill(COLORS.gold);
  let y = ctx.y + padding;
  for (let index = 0; index < lines.length; index++) {
    ctx.doc.font(index === 0 ? FONTS.serifBold : FONTS.serif)
      .fontSize(index === 0 ? (options.size ?? 10) + 0.5 : (options.size ?? 10))
      .fillColor(index === 0 ? COLORS.ink : COLORS.muted)
      .text(lines[index], left + padding, y, { width: textWidth, lineGap: 1.5 });
    y += heights[index] + 2;
  }
  setY(ctx, ctx.y + boxHeight + 8);
}

function drawTerms(ctx) {
  if (!ctx.model.terms) {
    drawParagraph(ctx, 'Boknings- och avbokningsvillkor kunde inte läsas in. Kontakta Skadevi Herrgård för gällande villkor.', {
      size: 9.5,
      color: COLORS.muted
    });
    return;
  }
  const paragraphs = ctx.model.terms.split(/\n{2,}/).map((part) => part.trim()).filter(Boolean);
  for (const paragraph of paragraphs) {
    const lines = paragraph.split('\n');
    for (const line of lines) {
      drawParagraph(ctx, line, { size: 9.5, lineGap: 1.5, after: 1 });
    }
    setY(ctx, ctx.y + 4);
  }
  if (ctx.model.termsVersion) {
    drawParagraph(ctx, `Villkorsversion: ${ctx.model.termsVersion}`, {
      size: 8,
      color: COLORS.muted,
      font: FONTS.sans
    });
  }
}

function drawContact(ctx) {
  const contact = ctx.model.contact;
  drawFactGrid(ctx, [
    ['Adress', `${contact.address}, ${contact.postal}`],
    ['Telefon', contact.phone],
    ['E-post', contact.email],
    ['Webbplats', contact.website]
  ]);
}

function drawDocumentBody(ctx) {
  drawSectionTitle(ctx, 'Gäst och kontaktuppgifter');
  const guestFacts = [
    ['Namn', ctx.model.guest.name],
    ['E-post', ctx.model.guest.email || '—'],
    ['Telefon', ctx.model.guest.phone || '—']
  ];
  if (ctx.model.guest.company) guestFacts.splice(1, 0, ['Företag', ctx.model.guest.company]);
  drawFactGrid(ctx, guestFacts);

  drawSectionTitle(ctx, 'Vistelse');
  drawFactGrid(ctx, [
    ['Incheckning', ctx.model.stay.arrivalText],
    ['Utcheckning', ctx.model.stay.departureText],
    ['Antal nätter', String(ctx.model.stay.nights)],
    ['Antal gäster', String(ctx.model.stay.guests)]
  ]);

  drawSectionTitle(ctx, 'Priser');
  if (ctx.model.addons.length) {
    drawAddonTable(ctx);
  } else {
    drawParagraph(ctx, 'Inga tillval registrerade i bokningens prissnapshot.', {
      size: 9.5,
      color: COLORS.muted,
      font: FONTS.sans
    });
  }
  drawPriceTable(ctx);
  for (const note of ctx.model.price.notes) {
    drawParagraph(ctx, note, { size: 8.5, color: COLORS.muted, font: FONTS.sans, after: 2 });
  }

  if (ctx.model.kind === DOCUMENT_KINDS.CONFIRMATION) {
    drawSectionTitle(ctx, 'Betalningar');
    drawFactGrid(ctx, ctx.model.payments.rows.map((row) => [row.label, row.value]));
  }

  drawSectionTitle(ctx, 'Boknings- och avbokningsvillkor');
  drawTerms(ctx);

  drawSectionTitle(ctx, 'Kontakt');
  drawContact(ctx);

  setY(ctx, ctx.y + 6);
  drawNoticeBox(ctx, ctx.model.disclaimer);
  drawParagraph(ctx, ctx.model.closing, {
    size: 11,
    font: FONTS.serifItalic,
    color: COLORS.ink,
    after: 4
  });
}

function drawFooters(doc, model) {
  const range = doc.bufferedPageRange();
  for (let index = 0; index < range.count; index++) {
    doc.switchToPage(range.start + index);
    const oldBottom = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    const y = doc.page.height - 42;
    doc.moveTo(doc.page.margins.left, y - 10)
      .lineTo(doc.page.width - doc.page.margins.right, y - 10)
      .lineWidth(0.5).strokeColor(COLORS.line).stroke();
    doc.font(FONTS.sans).fontSize(7.5).fillColor(COLORS.muted)
      .text(`Skadevi Herrgård · ${model.documentNumber}`, doc.page.margins.left, y, {
        width: doc.page.width - doc.page.margins.left - doc.page.margins.right - 120,
        lineBreak: false
      });
    doc.font(FONTS.sans).fontSize(7.5).fillColor(COLORS.muted)
      .text(`Sida ${index + 1} av ${range.count}`, doc.page.width - doc.page.margins.right - 110, y, {
        width: 110,
        align: 'right',
        lineBreak: false
      });
    doc.page.margins.bottom = oldBottom;
  }
  doc.flushPages();
}

function renderPdf(model, options = {}) {
  const doc = new PDFDocument({
    size: PAGE.size,
    margins: PAGE.margins,
    bufferPages: true,
    compress: options.compress !== false,
    info: {
      Title: `${model.title} ${model.documentNumber}`,
      Author: 'Skadevi Herrgård',
      Subject: model.kind === DOCUMENT_KINDS.QUOTE
        ? 'Offert för vistelse'
        : 'Bokningsbekräftelse',
      Keywords: `Skadevi Herrgård, ${model.documentNumber}`,
      CreationDate: options.now ?? new Date()
    }
  });
  const chunks = [];
  doc.on('data', (chunk) => chunks.push(chunk));
  const finished = new Promise((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });

  const ctx = { doc, model, y: PAGE.margins.top };
  drawFirstPageHeader(ctx);
  drawMeta(ctx);
  drawDocumentBody(ctx);
  drawFooters(doc, model);
  doc.end();
  return finished;
}

async function renderDocument(kind, booking, options = {}) {
  const { buildDocument } = require('./model');
  const model = await buildDocument(kind, booking, options);
  const buffer = await renderPdf(model, options);
  return {
    kind,
    model,
    buffer,
    filename: filenameFor(kind, booking.reference),
    contentType: 'application/pdf'
  };
}

module.exports = {
  renderPdf,
  renderDocument,
  LOGO_PATH,
  COLORS,
  PAGE
};
