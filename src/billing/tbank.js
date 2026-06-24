import { config } from '../config.js';
import { query } from '../db.js';
import { findPendingByAmountAndInn, payInvoice } from '../billing.js';

// Сверка оплат через T-Bank-прокси (migrator.lidkom.ru/tbank).
// Тянем банковскую выписку, находим входящие платежи на наш счёт и сопоставляем
// с неоплаченными счетами по сумме + ИНН плательщика → отмечаем счёт оплаченным.
// Прокси сам подписывает запрос реальным TBANK_TOKEN; мы шлём только x-proxy-secret.

let lastRun = { at: null, ok: false, matched: 0, scanned: 0, errors: [] };
let timer = null;

export function getTbankStatus() {
  return {
    configured: !!(config.tbankProxyUrl && config.tbankProxySecret && config.tbankAccount),
    account: config.tbankAccount,
    lastRun,
  };
}

function ymd(d) {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

async function fetchStatement(fromDate, tillDate) {
  const url = `${config.tbankProxyUrl.replace(/\/$/, '')}/bank-statement`
    + `?accountNumber=${encodeURIComponent(config.tbankAccount)}&from=${fromDate}&till=${tillDate}`;
  const res = await fetch(url, { headers: { 'x-proxy-secret': config.tbankProxySecret, Accept: 'application/json' } });
  const text = await res.text();
  if (!res.ok) throw new Error(`T-Bank прокси HTTP ${res.status}: ${text.slice(0, 200)}`);
  try { return JSON.parse(text); } catch { throw new Error('T-Bank: не JSON: ' + text.slice(0, 150)); }
}

// Входящие на наш счёт (recipientAccount == наш, payer != наш, не собственный перевод).
function extractIncoming(statement) {
  const ops = statement?.operation || statement?.operations || [];
  if (!Array.isArray(ops)) return [];
  const acc = String(config.tbankAccount).trim();
  return ops
    .filter((o) => {
      const recipient = String(o.recipientAccount || '').trim();
      const payer = String(o.payerAccount || '').trim();
      if (!(acc && recipient === acc && payer !== acc)) return false;
      const pInn = String(o.payerInn || '').replace(/\D/g, '');
      const rInn = String(o.recipientInn || '').replace(/\D/g, '');
      if (pInn && rInn && pInn === rInn) return false; // собственный перевод
      return true;
    })
    .map((o) => ({
      operationId: String(o.operationId || o.id || o.recordNumber || ''),
      amountRub: parseFloat(o.amount || o.sum || 0),
      payerInn: String(o.payerInn || '').replace(/\D/g, ''),
      payerName: o.payerName || '',
      purpose: o.paymentPurpose || o.purpose || '',
    }))
    .filter((o) => o.operationId && o.amountRub > 0);
}

async function alreadyProcessed(opId) {
  const { rows } = await query('SELECT 1 FROM bank_ops_processed WHERE operation_id=$1', [opId]);
  return rows.length > 0;
}
async function markProcessed(op, invoiceId, matched) {
  await query(
    `INSERT INTO bank_ops_processed (operation_id, invoice_id, amount_rub, payer_inn, matched)
     VALUES ($1,$2,$3,$4,$5) ON CONFLICT (operation_id) DO NOTHING`,
    [op.operationId, invoiceId || null, op.amountRub, op.payerInn, !!matched]
  );
}

// Один прогон сверки. lookbackDays — за сколько дней тянуть выписку.
export async function runTbankSync({ lookbackDays = 7 } = {}) {
  const result = { at: new Date().toISOString(), ok: true, matched: 0, scanned: 0, ignored: 0, errors: [] };
  if (!(config.tbankProxyUrl && config.tbankProxySecret && config.tbankAccount)) {
    result.ok = false; result.errors.push('T-Bank прокси не настроен (TBANK_PROXY_URL/SECRET/ACCOUNT)');
    lastRun = result; return result;
  }
  let statement;
  try {
    const till = new Date();
    const from = new Date(Date.now() - lookbackDays * 86400000);
    statement = await fetchStatement(ymd(from), ymd(till));
  } catch (e) {
    result.ok = false; result.errors.push(e.message); lastRun = result; return result;
  }
  const incoming = extractIncoming(statement);
  result.scanned = incoming.length;
  for (const op of incoming) {
    try {
      if (await alreadyProcessed(op.operationId)) continue;
      const inv = await findPendingByAmountAndInn(op.amountRub, op.payerInn);
      if (inv) {
        await payInvoice(inv.id);
        await markProcessed(op, inv.id, true);
        result.matched++;
        console.log(`[tbank] оплата ${op.amountRub}₽ от ИНН ${op.payerInn} → счёт ${inv.number} оплачен`);
      } else {
        // Не нашли счёт — помечаем обработанной, чтобы не сверять повторно, но без оплаты.
        await markProcessed(op, null, false);
        result.ignored++;
      }
    } catch (e) {
      result.errors.push(`${op.operationId}: ${e.message}`);
    }
  }
  lastRun = result;
  console.log(`[tbank] сверка: входящих ${result.scanned}, оплачено счетов ${result.matched}, без счёта ${result.ignored}${result.errors.length ? ', ошибок ' + result.errors.length : ''}`);
  return result;
}

export function startTbankScheduler() {
  if (config.disableWorkers) return;
  if (!(config.tbankProxyUrl && config.tbankProxySecret && config.tbankAccount)) {
    console.log('[tbank] сверка отключена — нет настроек прокси');
    return;
  }
  console.log('[tbank] планировщик сверки, интервал', Math.round(config.tbankPollIntervalMs / 60000), 'мин');
  const loop = async () => {
    try { await runTbankSync(); } catch (e) { console.error('[tbank] ошибка планировщика:', e.message); }
    finally { timer = setTimeout(loop, config.tbankPollIntervalMs); }
  };
  timer = setTimeout(loop, 90 * 1000); // первый прогон через 90с после старта
}
export function stopTbankScheduler() { if (timer) clearTimeout(timer); }
