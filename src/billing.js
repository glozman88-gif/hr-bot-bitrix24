import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import path from 'path';
import fs from 'fs';
import { query } from './db.js';

const require = createRequire(import.meta.url);

// Биллинг (single-tenant, баланс в токенах).
// Списываем фактические токены за каждый ответ бота; пополнение — вручную или оплатой счёта.
// Цена (₽ за 1000 токенов) — для отображения в деньгах и суммы счёта.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let RECIPIENT = {};
try {
  RECIPIENT = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'recipient.json'), 'utf8'));
} catch { RECIPIENT = {}; }

// Тариф «Доктор Грунт» как старт (₽ за 1000 токенов). Реальную цену задаём в админке.
export const DEFAULT_PRICE_PER_1K = 16.633;

export async function getAccount() {
  const { rows } = await query('SELECT * FROM billing_account WHERE id=1');
  return rows[0];
}

export function tokensToRub(tokens, pricePer1k) {
  const p = Number(pricePer1k || 0);
  return Math.round((Number(tokens || 0) / 1000) * p * 100) / 100;
}

// Списание токенов за диалог. tokens > 0.
export async function debitTokens(dialogId, tokens, description) {
  const t = Math.max(0, Math.round(Number(tokens) || 0));
  if (!t) return null;
  const { rows } = await query(
    'UPDATE billing_account SET balance_tokens = balance_tokens - $1, updated_at=now() WHERE id=1 RETURNING balance_tokens',
    [t]
  );
  const after = rows[0].balance_tokens;
  await query(
    `INSERT INTO billing_transactions (kind, tokens, description, dialog_id, balance_after)
     VALUES ('debit', $1, $2, $3, $4)`,
    [-t, description || 'Списание за диалог', dialogId || null, after]
  );
  return after;
}

// Ручное пополнение (положительные токены).
export async function topupTokens(tokens, description, kind = 'topup') {
  const t = Math.round(Number(tokens) || 0);
  if (!t) return null;
  const { rows } = await query(
    'UPDATE billing_account SET balance_tokens = balance_tokens + $1, updated_at=now() WHERE id=1 RETURNING balance_tokens',
    [t]
  );
  const after = rows[0].balance_tokens;
  await query(
    `INSERT INTO billing_transactions (kind, tokens, description, balance_after)
     VALUES ($1, $2, $3, $4)`,
    [kind, t, description || 'Пополнение', after]
  );
  return after;
}

// Лимит обещанного платежа, ₽.
export const PROMISED_MAX_RUB = 10000;

// Есть ли неоплаченный обещанный платёж (тогда новый выписать нельзя).
export async function getOutstandingPromised() {
  const { rows } = await query(
    "SELECT * FROM invoices WHERE is_promised=TRUE AND status='issued' ORDER BY created_at DESC LIMIT 1"
  );
  return rows[0] || null;
}

export async function createInvoice({ tokens, amountRub, note, payerName, payerInn, isPromised }) {
  const acc = await getAccount();
  const price = Number(acc.token_price_rub || 0);
  let tok = Math.round(Number(tokens) || 0);
  let amount = amountRub != null && amountRub !== '' ? Number(amountRub) : null;
  // Двусторонний пересчёт по тарифу: что не задано — считаем из другого.
  if (tok && amount == null) amount = tokensToRub(tok, price);
  else if (!tok && amount != null && price > 0) tok = Math.round((amount / price) * 1000);

  if (isPromised) {
    if (await getOutstandingPromised()) {
      throw new Error('Уже есть неоплаченный обещанный платёж — новый можно выписать только после его оплаты');
    }
    if (Number(amount) > PROMISED_MAX_RUB) {
      throw new Error(`Обещанный платёж не может быть больше ${PROMISED_MAX_RUB} ₽`);
    }
  }

  const { rows } = await query(
    `INSERT INTO invoices (number, tokens, amount_rub, status, note, payer_name, payer_inn, is_promised)
     VALUES ($1,$2,$3,'issued',$4,$5,$6,$7) RETURNING *`,
    [null, tok, amount, note || null, payerName || null, payerInn || null, !!isPromised]
  );
  const inv = rows[0];
  const number = `HR-${String(inv.id).padStart(4, '0')}`;
  await query('UPDATE invoices SET number=$1 WHERE id=$2', [number, inv.id]);
  inv.number = number;

  // Обещанный платёж зачисляет токены на баланс СРАЗУ (до оплаты).
  if (isPromised) {
    await topupTokens(tok, `Обещанный платёж ${number}`, 'promised');
  }
  return inv;
}

// Сгенерировать PDF закрывающего акта (только для оплаченного счёта).
export async function generateActPdfBuffer(id) {
  const { rows } = await query('SELECT * FROM invoices WHERE id=$1', [id]);
  const inv = rows[0];
  if (!inv) throw new Error('Счёт не найден');
  if (inv.status !== 'paid') throw new Error('Акт доступен только для оплаченного счёта');
  const amount = Number(inv.amount_rub || 0);
  const { generateActPdf } = require('../billing/act.cjs');
  return generateActPdf({
    recipient: RECIPIENT,
    act: {
      number: `A-${String(inv.id).padStart(4, '0')}`,
      date: inv.paid_at || inv.created_at,
      customer: { name: inv.payer_name || '', inn: inv.payer_inn || '' },
      items: [{
        name: 'Услуги по поддержке работы приложения',
        qty: 1, price: amount, sum: amount,
      }],
      total: amount,
    },
    signatureBuffer: null,
  });
}

// Сгенерировать PDF счёта-оферты (буфер). Лениво грузим CJS-модуль pdfkit.
export async function generateInvoicePdfBuffer(id) {
  const { rows } = await query('SELECT * FROM invoices WHERE id=$1', [id]);
  const inv = rows[0];
  if (!inv) throw new Error('Счёт не найден');
  const { generateInvoicePdf } = require('../billing/invoice.cjs');
  return generateInvoicePdf({
    recipient: RECIPIENT,
    invoice: {
      number: inv.number || `HR-${String(inv.id).padStart(4, '0')}`,
      date: inv.created_at,
      amountRub: Number(inv.amount_rub || 0),
      payerName: inv.payer_name || '',
      payerInn: inv.payer_inn || '',
      purpose: RECIPIENT.purpose || 'Пополнение баланса токенов HR-бота. Без НДС.',
      tokens: Number(inv.tokens || 0),
    },
  });
}

export async function payInvoice(id) {
  const { rows } = await query('SELECT * FROM invoices WHERE id=$1', [id]);
  const inv = rows[0];
  if (!inv) throw new Error('Счёт не найден');
  if (inv.status === 'paid') return inv;
  await query('UPDATE invoices SET status=\'paid\', paid_at=now() WHERE id=$1', [id]);
  // Обещанный платёж уже зачислил токены при выписке — повторно не зачисляем.
  if (!inv.is_promised) {
    await topupTokens(inv.tokens, `Оплата счёта ${inv.number}`, 'invoice_paid');
  } else {
    // Фиксируем факт оплаты обещанного в выписке (без изменения баланса).
    const acc = await getAccount();
    await query(
      `INSERT INTO billing_transactions (kind, tokens, description, balance_after)
       VALUES ('promised_settled', 0, $1, $2)`,
      [`Оплачен обещанный платёж ${inv.number}`, acc.balance_tokens]
    );
  }
  return { ...inv, status: 'paid' };
}

// Баланс исчерпан — бота надо приостановить.
export async function isExhausted() {
  const acc = await getAccount();
  return Number(acc.balance_tokens) <= 0;
}

export async function cancelInvoice(id) {
  await query('UPDATE invoices SET status=\'cancelled\' WHERE id=$1', [id]);
  return { ok: true };
}

export async function listTransactions(limit = 100) {
  const { rows } = await query(
    'SELECT * FROM billing_transactions ORDER BY created_at DESC LIMIT $1', [limit]
  );
  return rows;
}

// Выписка с фильтрами: direction (credit|debit|all), период (from/to ISO-даты).
export async function getTransactionsFiltered({ direction = 'all', from = null, to = null, limit = 500 } = {}) {
  const where = [];
  const vals = [];
  let i = 1;
  if (direction === 'credit') where.push('tokens > 0');
  else if (direction === 'debit') where.push('tokens < 0');
  if (from) { where.push(`created_at >= $${i++}`); vals.push(from); }
  if (to) { where.push(`created_at < ($${i++}::date + INTERVAL '1 day')`); vals.push(to); }
  vals.push(limit);
  const sql = `SELECT * FROM billing_transactions
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY created_at DESC LIMIT $${i}`;
  const { rows } = await query(sql, vals);
  return rows;
}

export async function listInvoices() {
  const { rows } = await query('SELECT * FROM invoices ORDER BY created_at DESC LIMIT 200');
  return rows;
}

// Найти неоплаченный счёт по сумме и ИНН плательщика (для авто-сверки оплат T-Bank).
export async function findPendingByAmountAndInn(amountRub, payerInn) {
  const inn = String(payerInn || '').replace(/\D/g, '');
  const amount = Math.round(Number(amountRub) * 100) / 100;
  // Сначала точное совпадение по ИНН+сумме, иначе — только по сумме (если ИНН пуст).
  let r = await query(
    `SELECT * FROM invoices WHERE status='issued' AND ROUND(amount_rub,2)=$1
       AND ($2='' OR payer_inn=$2) ORDER BY created_at ASC LIMIT 1`,
    [amount, inn]
  );
  if (r.rows[0]) return r.rows[0];
  return null;
}

export async function setBillingSettings({ token_price_rub, block_on_zero }) {
  const sets = [];
  const vals = [];
  let i = 1;
  if (token_price_rub !== undefined) { sets.push(`token_price_rub=$${i++}`); vals.push(Number(token_price_rub)); }
  if (block_on_zero !== undefined) { sets.push(`block_on_zero=$${i++}`); vals.push(!!block_on_zero); }
  if (!sets.length) return getAccount();
  sets.push('updated_at=now()');
  await query(`UPDATE billing_account SET ${sets.join(', ')} WHERE id=1`, vals);
  return getAccount();
}

// Полное состояние для кабинета.
export async function getBillingState() {
  const acc = await getAccount();
  const price = Number(acc.token_price_rub || 0);
  const [tx, invs, promised] = await Promise.all([listTransactions(100), listInvoices(), getOutstandingPromised()]);
  return {
    balanceTokens: Number(acc.balance_tokens),
    balanceRub: tokensToRub(acc.balance_tokens, price),
    pricePer1k: price,
    exhausted: Number(acc.balance_tokens) <= 0,
    hasOutstandingPromised: !!promised,
    promisedMaxRub: PROMISED_MAX_RUB,
    transactions: tx,
    invoices: invs,
    pending: invs.filter(i => i.status === 'issued'),
    recipient: RECIPIENT,
  };
}

export { RECIPIENT };
