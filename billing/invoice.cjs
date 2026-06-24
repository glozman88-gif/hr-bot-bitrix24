// Счёт-оферта на пополнение Баланса токенов «Доктор Грунт».
// Состав PDF:
//   стр. 1  — Шапка с логотипом, реквизиты получателя, плательщик, таблица услуги,
//             QR для оплаты, условия оферты, без подписей.
//   стр. 2+ — Приложение № 1: Договор оказания услуг (текст из offer-text.js).

const PDFDocument = require('pdfkit');
const QRCode = require('qrcode');
const path = require('path');
const fs = require('fs');
const { OFFER_PAGE1_TERMS, CONTRACT_SECTIONS } = require('./offer-text.cjs');

const FONT_REGULAR = path.join(__dirname, '..', 'fonts', 'DejaVuSans.ttf');
const FONT_BOLD = path.join(__dirname, '..', 'fonts', 'DejaVuSans-Bold.ttf');
const HAS_TTF = fs.existsSync(FONT_REGULAR) && fs.existsSync(FONT_BOLD);

// Счёт выставляется от вендора (Lidkom.ru), а не от Доктор Грунт.
// Доктор Грунт — это сервис конечному клиенту; платит вендору.
const LOGO = path.join(__dirname, '..', 'public', 'brand', 'logo-lidkom.png');
const HAS_LOGO = fs.existsSync(LOGO);

// Фирменные цвета счёта (нейтральные деловые — без брендового зелёного, чтобы
// не путать со стилем заключения Доктор Грунт).
const BRAND = '#1f4f8b';      // деловой синий
const BRAND_DARK = '#152c4d'; // тёмно-синий акцент

// Российский QR для платежа — формат ST00012 (ГОСТ Р 56042-2014).
function makePaymentQrPayload(recipient, invoice) {
  const sumKop = Math.round((invoice.amountRub || 0) * 100);
  const purpose = `Пополнение баланса по счету N ${invoice.number} от ${formatDate(invoice.date)}. ИНН плательщика ${invoice.payerInn || ''}. Без НДС.`;
  // Только латиница в полях | разделяет; внутри значения кириллица допустима в UTF-8.
  const fields = {
    Name: recipient.fullName,
    PersonalAcc: recipient.bankAccount,
    BankName: recipient.bankName,
    BIC: recipient.bik,
    CorrespAcc: recipient.corrAccount,
    Sum: String(sumKop),
    Purpose: purpose,
    PayeeINN: recipient.inn,
    KPP: '',
  };
  const parts = ['ST00012'];
  for (const [k, v] of Object.entries(fields)) {
    if (v) parts.push(`${k}=${String(v).replace(/[|]/g, ' ')}`);
  }
  return parts.join('|');
}

async function generateInvoicePdf({ recipient, invoice }) {
  const qrPayload = makePaymentQrPayload(recipient, invoice);
  const qrDataUrl = await QRCode.toDataURL(qrPayload, { errorCorrectionLevel: 'M', margin: 1, width: 220 });
  const qrBuffer = Buffer.from(qrDataUrl.split(',')[1], 'base64');

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

      // ===== Шапка с логотипом =====
      if (HAS_LOGO) {
        doc.image(LOGO, left, y, { height: 40, fit: [180, 40] });
      }
      doc.font('regular').fontSize(9).fillColor('#666')
        .text(`Дата: ${formatDate(invoice.date)}`, left + W - 200, y + 6, { width: 200, align: 'right' });
      y += 50;

      // Зелёная разделительная полоса
      doc.rect(left, y, W, 2).fill(BRAND);
      y += 10;

      // ===== Заголовок =====
      doc.font('bold').fontSize(15).fillColor(BRAND_DARK).text(
        `Счёт-оферта № ${invoice.number} от ${formatDate(invoice.date)}`,
        left, y, { width: W, align: 'center' }
      );
      y += 22;

      // ===== Получатель =====
      doc.font('bold').fontSize(10).fillColor('#000').text('Получатель', left, y);
      y += 14;
      const recipBlock = [
        ['Наименование',   recipient.fullName],
        ['ИНН',            recipient.inn],
        ['Банк',           recipient.bankName],
        ['БИК',            recipient.bik],
        ['Корр. счёт',     recipient.corrAccount],
        ['Расчётный счёт', recipient.bankAccount],
      ];
      y = drawKeyValueBlock(doc, left, y, W, recipBlock);
      y += 6;

      // ===== Плательщик =====
      doc.font('bold').fontSize(10).fillColor('#000').text('Плательщик', left, y);
      y += 14;
      const payerBlock = [
        ['Наименование', invoice.payerName || '—'],
        ['ИНН',          invoice.payerInn  || '—'],
      ];
      y = drawKeyValueBlock(doc, left, y, W, payerBlock);
      y += 12;

      // ===== Таблица позиции =====
      const tableY = y;
      const colW = { idx: 30, name: 332, qty: 50, price: 70, sum: 70 };
      doc.rect(left, tableY, colW.idx + colW.name + colW.qty + colW.price + colW.sum, 22).fill(BRAND);
      doc.font('bold').fontSize(9).fillColor('#fff');
      let cx = left;
      const headers = [
        ['№',            colW.idx,   'center'],
        ['Услуга',       colW.name,  'left'],
        ['Кол-во',       colW.qty,   'center'],
        ['Цена, ₽',      colW.price, 'right'],
        ['Сумма, ₽',     colW.sum,   'right'],
      ];
      for (const [text, w, align] of headers) {
        doc.text(text, cx + 4, tableY + 6, { width: w - 8, align });
        cx += w;
      }
      doc.font('regular').fontSize(10).fillColor('#000');
      const rowY = tableY + 22;
      const rowHeight = 38;
      const totalSum = formatRub(invoice.amountRub);
      doc.rect(left, rowY, colW.idx + colW.name + colW.qty + colW.price + colW.sum, rowHeight)
        .strokeColor('#cccccc').lineWidth(0.5).stroke();
      cx = left;
      const cells = [
        ['1',                                                                                colW.idx,   'center'],
        ['Услуги по поддержке работы приложения', colW.name, 'left'],
        ['1',                                                                                colW.qty,   'center'],
        [totalSum,                                                                           colW.price, 'right'],
        [totalSum,                                                                           colW.sum,   'right'],
      ];
      for (const [text, w, align] of cells) {
        doc.text(text, cx + 4, rowY + 6, { width: w - 8, height: rowHeight - 12, align });
        cx += w;
      }
      const itogoY = rowY + rowHeight + 2;
      doc.font('bold').fontSize(10).fillColor('#000');
      const itogoX = left + colW.idx + colW.name + colW.qty;
      doc.text('Итого:', itogoX + 4, itogoY + 4, { width: colW.price - 8, align: 'right' });
      doc.text(totalSum, itogoX + colW.price + 4, itogoY + 4, { width: colW.sum - 8, align: 'right' });

      y = itogoY + 24;
      doc.font('regular').fontSize(10).fillColor('#000')
        .text(`Всего к оплате: ${totalSum}`, left, y, { width: W, align: 'right' });
      y += 14;
      doc.fontSize(9).fillColor('#444')
        .text(`(${amountInWords(invoice.amountRub)})`, left, y, { width: W, align: 'right' });
      y += 14;
      doc.fontSize(9).fillColor('#666')
        .text(recipient.vat || 'Без НДС', left, y, { width: W, align: 'right' });
      y += 18;

      // ===== QR + Условия оферты (две колонки) =====
      const qrSize = 130;
      const qrX = left;
      const qrY = y;
      doc.rect(qrX - 4, qrY - 4, qrSize + 8, qrSize + 22).strokeColor(BRAND).lineWidth(1).stroke();
      doc.image(qrBuffer, qrX, qrY, { fit: [qrSize, qrSize] });
      doc.font('bold').fontSize(8).fillColor(BRAND_DARK)
        .text('QR для оплаты в банке', qrX, qrY + qrSize + 4, { width: qrSize, align: 'center' });

      const termsX = qrX + qrSize + 18;
      const termsW = W - (qrSize + 22);
      doc.font('bold').fontSize(10).fillColor(BRAND_DARK).text('Условия Счёта-оферты', termsX, qrY);
      doc.font('regular').fontSize(8).fillColor('#000');
      let ty = qrY + 14;
      OFFER_PAGE1_TERMS.forEach((p, i) => {
        ty = drawJustifiedParagraph(doc, `${i + 1}. ${p}`, termsX, ty, termsW, 8, 1.35);
        ty += 2;
      });
      y = Math.max(qrY + qrSize + 22, ty + 8);

      // ===== Назначение платежа =====
      if (y > doc.page.height - doc.page.margins.bottom - 60) { doc.addPage(); y = doc.page.margins.top; }
      doc.font('bold').fontSize(10).fillColor('#000').text('Назначение платежа', left, y);
      y += 14;
      doc.font('regular').fontSize(9).fillColor('#000').text(invoice.purpose, left, y, { width: W });
      y += 12;
      doc.font('regular').fontSize(8).fillColor('#888')
        .text('⚠️ В назначении платежа обязательно укажите ИНН вашей организации (или ИП), иначе автоматическое сопоставление платежа со счётом не произойдёт.',
          left, y, { width: W });

      // ===== Приложение № 1: Договор =====
      doc.addPage();
      y = doc.page.margins.top;
      doc.font('bold').fontSize(13).fillColor(BRAND_DARK).text(
        `Приложение № 1 к Счёту-оферте № ${invoice.number} от ${formatDate(invoice.date)}`,
        left, y, { width: W, align: 'center' }
      );
      y += 18;
      doc.font('bold').fontSize(15).fillColor('#000').text(
        'ДОГОВОР ОКАЗАНИЯ УСЛУГ',
        left, y, { width: W, align: 'center' }
      );
      y += 18;
      doc.rect(left, y, W, 1).fill(BRAND);
      y += 10;

      doc.font('regular').fontSize(9).fillColor('#000');
      for (const [title, items] of CONTRACT_SECTIONS) {
        if (y > doc.page.height - doc.page.margins.bottom - 60) { doc.addPage(); y = doc.page.margins.top; }
        doc.font('bold').fontSize(10).fillColor(BRAND_DARK).text(title, left, y, { width: W });
        y += 14;
        for (const raw of items) {
          const text = raw
            .replace('{number}', invoice.number)
            .replace('{date}', formatDate(invoice.date))
            .replace(/<\/?b>|<\/?u>/g, ''); // убираем HTML-теги (для простоты)
          if (y > doc.page.height - doc.page.margins.bottom - 24) { doc.addPage(); y = doc.page.margins.top; }
          doc.font('regular').fontSize(9).fillColor('#000');
          y = drawJustifiedParagraph(doc, text, left, y, W, 9, 1.4);
          y += 3;
        }
        y += 6;
      }

      // ===== Подпись Исполнителя на последней странице =====
      const sigY = doc.page.height - doc.page.margins.bottom - 70;
      if (y < sigY) y = sigY;
      doc.rect(left, y, W, 1).fill(BRAND);
      y += 10;
      doc.font('bold').fontSize(10).fillColor('#000').text('Исполнитель:', left, y);
      y += 14;
      doc.font('regular').fontSize(9).fillColor('#000').text(recipient.fullName, left, y);
      y += 12;
      doc.text(`ИНН ${recipient.inn} · Расчётный счёт ${recipient.bankAccount}`, left, y);
      y += 12;
      doc.text(`${recipient.bankName} · БИК ${recipient.bik}`, left, y);

      doc.end();
    } catch (err) {
      reject(err);
    }
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

function drawJustifiedParagraph(doc, text, x, y, width, fontSize, lineGap) {
  const h = doc.heightOfString(text, { width, align: 'justify', lineGap: (lineGap - 1) * fontSize });
  doc.text(text, x, y, { width, align: 'justify', lineGap: (lineGap - 1) * fontSize });
  return y + h;
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

function amountInWords(rub) {
  const r = Math.floor(rub);
  const k = Math.round((rub - r) * 100);
  return `${rublesInWords(r)} ${k.toString().padStart(2, '0')} коп.`;
}
function rublesInWords(n) {
  if (!n) return 'Ноль рублей';
  const ones = ['', 'один', 'два', 'три', 'четыре', 'пять', 'шесть', 'семь', 'восемь', 'девять'];
  const onesF = ['', 'одна', 'две', 'три', 'четыре', 'пять', 'шесть', 'семь', 'восемь', 'девять'];
  const teens = ['десять','одиннадцать','двенадцать','тринадцать','четырнадцать','пятнадцать','шестнадцать','семнадцать','восемнадцать','девятнадцать'];
  const tens = ['', '', 'двадцать', 'тридцать', 'сорок', 'пятьдесят', 'шестьдесят', 'семьдесят', 'восемьдесят', 'девяносто'];
  const hund = ['', 'сто', 'двести', 'триста', 'четыреста', 'пятьсот', 'шестьсот', 'семьсот', 'восемьсот', 'девятьсот'];
  function group(num, fem) {
    const oArr = fem ? onesF : ones;
    const h = Math.floor(num / 100);
    const t = Math.floor((num % 100) / 10);
    const o = num % 10;
    const out = [];
    if (h) out.push(hund[h]);
    if (t === 1) out.push(teens[o]);
    else { if (t) out.push(tens[t]); if (o) out.push(oArr[o]); }
    return out.join(' ');
  }
  function formOf(num, [one, few, many]) {
    const m100 = num % 100;
    if (m100 >= 11 && m100 <= 14) return many;
    const m10 = num % 10;
    if (m10 === 1) return one;
    if (m10 >= 2 && m10 <= 4) return few;
    return many;
  }
  const mln = Math.floor(n / 1_000_000);
  const ths = Math.floor((n % 1_000_000) / 1000);
  const rub = n % 1000;
  const parts = [];
  if (mln) parts.push(group(mln) + ' ' + formOf(mln, ['миллион','миллиона','миллионов']));
  if (ths) parts.push(group(ths, true) + ' ' + formOf(ths, ['тысяча','тысячи','тысяч']));
  if (rub) parts.push(group(rub));
  parts.push(formOf(n, ['рубль','рубля','рублей']));
  return capitalize(parts.join(' '));
}
function capitalize(s) { return s ? s[0].toUpperCase() + s.slice(1) : s; }

module.exports = { generateInvoicePdf, amountInWords, makePaymentQrPayload };
