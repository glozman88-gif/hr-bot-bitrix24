// Мониторинг баланса токенов + алерты.
//
// ⚠️ ВОССТАНОВЛЕНО ПО ЛОГАМ. Оригинальный monitor.js второго разработчика был случайно
// перезаписан при деплое (исходник не сохранился). Это функциональный эквивалент по
// поведению из journalctl: порог 500 000 токенов, проверка каждые 30 мин, ежедневные
// алерты в 8:00 и 16:00 МСК в chat162297 + ЛС пользователям 154 и 90835.
// Если у второго разработчика сохранилась оригинальная версия — заменить этой.

import { config } from '../config.js';
import { getAccount } from '../billing.js';
import { vibePost } from '../vibe.js';
import { query } from '../db.js';

const THRESHOLD = Number(process.env.BALANCE_ALERT_THRESHOLD || 500000);
const ALERT_CHAT = process.env.BALANCE_ALERT_CHAT || 'chat162297';
const ALERT_USERS = (process.env.BALANCE_ALERT_USERS || '154,90835')
  .split(',').map((s) => s.trim()).filter(Boolean);
const CHECK_INTERVAL_MS = 30 * 60 * 1000;

let belowAlerted = false;  // дедуп порогового алерта (повторно шлём только после восстановления)
let timer = null;

function fmt(n) { return Number(n || 0).toLocaleString('ru'); }

async function botSend(dialogId, message) {
  const { rows } = await query('SELECT bot_id FROM bot_state WHERE id=1');
  const botId = rows[0]?.bot_id;
  if (!botId) return;
  try {
    await vibePost(`/bots/${botId}/messages`, { dialogId: String(dialogId), fields: { message } });
  } catch (e) { console.warn('[monitor] не удалось отправить:', e.message); }
}

async function broadcast(message) {
  await botSend(ALERT_CHAT, message);
  for (const u of ALERT_USERS) await botSend(u, message);
}

// Проверка порога (раз в 30 мин).
async function checkThreshold() {
  const acc = await getAccount();
  const bal = Number(acc.balance_tokens);
  if (bal < THRESHOLD) {
    if (!belowAlerted) {
      await broadcast(`⚠️ Баланс токенов ниже порога: ${fmt(bal)} (порог ${fmt(THRESHOLD)}). Пополните баланс.`);
      console.log(`[monitor] порог баланса, отправлено в ${ALERT_CHAT}`);
      console.log(`[monitor] уведомления отправлены: ${ALERT_USERS.join(', ')}, баланс=${fmt(bal)}`);
      belowAlerted = true;
    }
  } else {
    belowAlerted = false;
  }
}

// Ежедневный отчёт о балансе.
async function dailyReport() {
  const acc = await getAccount();
  const bal = Number(acc.balance_tokens);
  await broadcast(`Баланс токенов: ${fmt(bal)}.`);
  console.log(`[monitor] сообщение в ${ALERT_CHAT}, баланс=${fmt(bal)}`);
}

// Запланировать ежедневный алерт на hourMsk:00 МСК (МСК = UTC+3).
function scheduleDailyMsk(hourMsk) {
  const utcHour = (hourMsk - 3 + 24) % 24;
  const now = new Date();
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), utcHour, 0, 0, 0));
  if (next.getTime() <= now.getTime()) next.setUTCDate(next.getUTCDate() + 1);
  const delay = next.getTime() - now.getTime();
  console.log(`[monitor] алерт ${hourMsk}:00 МСК запланирован на ${next.toISOString()}`);
  setTimeout(function fire() {
    dailyReport().catch((e) => console.warn('[monitor] ежедневный алерт:', e.message));
    setTimeout(fire, 24 * 60 * 60 * 1000);
  }, delay);
}

export function startBalanceMonitor() {
  if (config.disableWorkers) return;
  console.log(`[monitor] мониторинг баланса, порог ${fmt(THRESHOLD)} токенов, интервал 30 мин`);
  console.log(`[monitor] мониторинг, порог ${fmt(THRESHOLD)} ток., алерты 8:00 и 16:00 МСК`);
  const loop = () => { checkThreshold().catch((e) => console.warn('[monitor] проверка:', e.message)).finally(() => { timer = setTimeout(loop, CHECK_INTERVAL_MS); }); };
  setTimeout(loop, 60 * 1000);
  scheduleDailyMsk(8);
  scheduleDailyMsk(16);
}
export function stopBalanceMonitor() { if (timer) clearTimeout(timer); }
