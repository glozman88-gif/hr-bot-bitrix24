// Акт оказанных услуг (закрывающий документ) для главного кабинета.
// Два сценария: по одному платежу (одна строка) и за период по партнёру
// (перечень оказанных услуг). Подпись Исполнителя вшивается изображением.

const PDFDocument = require('pdfkit');
const path = require('path');
const fs = require('fs');
const { amountInWords } = require('./invoice.cjs');

const FONT_REGULAR = path.join(__dirname, '..', 'fonts', 'DejaVuSans.ttf');
const FONT_BOLD = path.join(__dirname, '..', 'fonts', 'DejaVuSans-Bold.ttf');
const HAS_TTF = fs.existsSync(FONT_REGULAR) && fs.existsSync(FONT_BOLD);
const LOGO = path.join(__dirname, '..', 'public', 'brand', 'logo-lidkom.png');
const HAS_LOGO = fs.existsSync(LOGO);

const BRAND = '#1f4f8b';
const BRAND_DARK = '#152c4d';

// act: { number, date, customer:{name,inn}, items:[{name,qty,price,sum}], total,
//        periodFrom?, periodTo? }
// signatureBuffer: Buffer | null — PNG/JPG подписи Исполнителя.
async function generateActPdf({ recipient, act, signatureBuffer }) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'A4', margin: 36, bufferPages: true });
      const chunks = [];
      doc.on('data', (c) => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      if (HAS_TTF) {
        doc.registerFont('regular', FONT_REGULAR);
        doc.registerFont('bold', FONT_BOLD);
      } else {
        doc.registerFont('regular', 'Helvetica');
        doc.registerFont('bold', 'Helvetica-Bold');
      }

      const W = doc.page.width - doc.page.margins.left - doc.page.margins.right;
      const left = doc.page.margins.left;
      let y = doc.page.margins.top;

      // ===== Шапка =====
      if (HAS_LOGO) doc.image(LOGO, left, y, { height: 40, fit: [180, 40] });
      doc.font('regular').fontSize(9).fillColor('#666')
        .text(`Дата: ${formatDate(act.date)}`, left + W - 200, y + 6, { width: 200, align: 'right' });
      y += 50;
      doc.rect(left, y, W, 2).fill(BRAND);
      y += 10;

      // ===== Заголовок =====
      doc.font('bold').fontSize(15).fillColor(BRAND_DARK).text(
        `Акт № ${act.number} от ${formatDate(act.date)}`,
        left, y, { width: W, align: 'center' });
      y += 20;
      doc.font('regular').fontSize(11).fillColor('#000').text(
        'оказанных услуг', left, y, { width: W, align: 'center' });
      y += 16;
      if (act.periodFrom && act.periodTo) {
        doc.font('regular').fontSize(9).fillColor('#666').text(
          `за период с ${formatDate(act.periodFrom)} по ${formatDate(act.periodTo)}`,
          left, y, { width: W, align: 'center' });
        y += 14;
      }
      y += 4;

      // ===== Стороны =====
      doc.font('bold').fontSize(10).fillColor('#000').text('Исполнитель', left, y);
      y += 14;
      y = drawKeyValueBlock(doc, left, y, W, [
        ['Наименование', recipient.fullName],
        ['ИНН', recipient.inn],
        ['Расчётный счёт', recipient.bankAccount],
        ['Банк', `${recipient.bankName} · БИК ${recipient.bik}`],
      ]);
      y += 6;
      doc.font('bold').fontSize(10).fillColor('#000').text('Заказчик', left, y);
      y += 14;
      y = drawKeyValueBlock(doc, left, y, W, [
        ['Наименование', act.customer?.name || '—'],
        ['ИНН', act.customer?.inn || '—'],
      ]);
      y += 12;

      // ===== Таблица услуг =====
      const colW = { idx: 30, name: 312, qty: 50, price: 80, sum: 80 };
      const tableW = colW.idx + colW.name + colW.qty + colW.price + colW.sum;
      doc.rect(left, y, tableW, 22).fill(BRAND);
      doc.font('bold').fontSize(9).fillColor('#fff');
      let cx = left;
      for (const [text, w, align] of [
        ['№', colW.idx, 'center'], ['Наименование услуги', colW.name, 'left'],
        ['Кол-во', colW.qty, 'center'], ['Цена, руб.', colW.price, 'right'], ['Сумма, руб.', colW.sum, 'right'],
      ]) { doc.text(text, cx + 4, y + 6, { width: w - 8, align }); cx += w; }
      y += 22;

      doc.font('regular').fontSize(9).fillColor('#000');
      (act.items || []).forEach((it, i) => {
        if (y > doc.page.height - doc.page.margins.bottom - 120) { doc.addPage(); y = doc.page.margins.top; }
        const nameH = doc.heightOfString(it.name, { width: colW.name - 8 });
        const rowH = Math.max(20, nameH + 8);
        doc.rect(left, y, tableW, rowH).strokeColor('#cccccc').lineWidth(0.5).stroke();
        cx = left;
        const cells = [
          [String(i + 1), colW.idx, 'center'],
          [it.name, colW.name, 'left'],
          [String(it.qty != null ? it.qty : 1), colW.qty, 'center'],
          [formatRub(it.price != null ? it.price : it.sum), colW.price, 'right'],
          [formatRub(it.sum), colW.sum, 'right'],
        ];
        for (const [text, w, align] of cells) { doc.text(text, cx + 4, y + 5, { width: w - 8, align }); cx += w; }
        y += rowH;
      });

      // Итого
      y += 4;
      doc.font('bold').fontSize(10).fillColor('#000');
      const itogoX = left + colW.idx + colW.name + colW.qty;
      doc.text('Итого:', itogoX + 4, y, { width: colW.price - 8, align: 'right' });
      doc.text(formatRub(act.total), itogoX + colW.price + 4, y, { width: colW.sum - 8, align: 'right' });
      y += 18;
      doc.font('regular').fontSize(9).fillColor('#444')
        .text(`Всего оказано услуг на сумму: ${formatRub(act.total)} руб. (${amountInWords(act.total)})`,
          left, y, { width: W });
      y += 14;
      doc.fontSize(9).fillColor('#666').text(recipient.vat || 'Без НДС', left, y);
      y += 16;

      // ===== Заключительный текст =====
      doc.font('regular').fontSize(9).fillColor('#000').text(
        'Вышеперечисленные услуги оказаны полностью и в срок. Заказчик претензий по объёму, ' +
        'качеству и срокам оказания услуг не имеет.', left, y, { width: W });
      y += 36;

      // ===== Подписи =====
      if (y > doc.page.height - doc.page.margins.bottom - 110) { doc.addPage(); y = doc.page.margins.top; }
      const colGap = 30;
      const sigColW = (W - colGap) / 2;
      const rightX = left + sigColW + colGap;
      const baseY = y;

      doc.font('bold').fontSize(10).fillColor('#000').text('Исполнитель', left, baseY, { width: sigColW });
      doc.font('bold').fontSize(10).fillColor('#000').text('Заказчик', rightX, baseY, { width: sigColW });
      // Подпись Исполнителя — картинкой над линией подписи.
      if (signatureBuffer) {
        try { doc.image(signatureBuffer, left, baseY + 16, { fit: [150, 50] }); } catch (e) { /* битая картинка */ }
      }
      const lineY = baseY + 70;
      doc.moveTo(left, lineY).lineTo(left + sigColW - 10, lineY).strokeColor('#888').lineWidth(0.7).stroke();
      doc.moveTo(rightX, lineY).lineTo(rightX + sigColW - 10, lineY).strokeColor('#888').lineWidth(0.7).stroke();
      doc.font('regular').fontSize(8).fillColor('#666')
        .text('подпись / расшифровка', left, lineY + 3, { width: sigColW })
        .text('подпись / расшифровка', rightX, lineY + 3, { width: sigColW });
      doc.font('regular').fontSize(9).fillColor('#000')
        .text(recipient.shortName || recipient.fullName, left, lineY + 16, { width: sigColW })
        .text(act.customer?.name || '', rightX, lineY + 16, { width: sigColW });

      doc.end();
    } catch (err) { reject(err); }
  });
}

function drawKeyValueBlock(doc, x, y, width, rows) {
  const labelW = 130;
  for (const [label, value] of rows) {
    doc.font('regular').fontSize(9).fillColor('#666').text(label + ':', x, y + 1, { width: labelW });
    doc.font('regular').fontSize(10).fillColor('#000').text(value || '—', x + labelW, y, { width: width - labelW });
    const h = Math.max(14, doc.heightOfString(value || '—', { width: width - labelW }) + 2);
    y += h;
  }
  return y;
}

function formatDate(d) {
  if (!d) return new Date().toLocaleDateString('ru-RU');
  const x = new Date(d);
  if (isNaN(x)) return String(d);
  return x.toLocaleDateString('ru-RU');
}
function formatRub(n) {
  const v = Math.round((parseFloat(n) || 0) * 100) / 100;
  return v.toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

module.exports = { generateActPdf };
