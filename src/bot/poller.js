import { config } from '../config.js';
import { query, getSettings } from '../db.js';
import { vibe, vibeGet, vibePost } from '../vibe.js';
import { handleUserMessage } from './conversation.js';
import { isExhausted } from '../billing.js';

// Фоновый поллинг событий бота (eventMode: fetch).
// Хранит курсор в bot_state; платформа тоже хранит свой lastOffset, но локальный
// курсор делает поведение предсказуемым.

let running = false;
let timer = null;

async function getBotId() {
  const { rows } = await query('SELECT bot_id, last_offset FROM bot_state WHERE id=1');
  return rows[0] || {};
}

export async function setBotId(botId) {
  await query('UPDATE bot_state SET bot_id=$1, updated_at=now() WHERE id=1', [botId]);
}

async function saveOffset(offset) {
  await query('UPDATE bot_state SET last_offset=$1, updated_at=now() WHERE id=1', [offset]);
}

// Отметить событие обработанным (дедуп по bx_message_id).
async function alreadyProcessed(bxMessageId) {
  if (!bxMessageId) return false;
  const { rows } = await query('SELECT 1 FROM processed_events WHERE bx_message_id=$1', [bxMessageId]);
  return rows.length > 0;
}
async function markProcessed(bxMessageId) {
  if (!bxMessageId) return;
  await query('INSERT INTO processed_events (bx_message_id) VALUES ($1) ON CONFLICT DO NOTHING', [bxMessageId]);
}

// dialogId в событиях открытых линий приходит не всегда в data.dialogId —
// берём из chat.dialogId или собираем из message.chatId.
function resolveDialogId(data) {
  const chat = data.chat || {};
  const msg = data.message || {};
  return data.dialogId || chat.dialogId
    || (chat.id ? `chat${chat.id}` : null)
    || (msg.chatId ? `chat${msg.chatId}` : null);
}

// Из данных чата открытой линии вытаскиваем привязанную CRM-сделку.
// chat.entityData2 = "LEAD|0|COMPANY|0|CONTACT|3691|DEAL|212673" (пары ТИП|ID).
function crmFromChat(chat) {
  const out = { dealId: null, contactId: null };
  const ed2 = chat.entityData2 || '';
  if (ed2) {
    const parts = ed2.split('|');
    for (let i = 0; i + 1 < parts.length; i += 2) {
      const k = parts[i]; const v = Number(parts[i + 1]);
      if (k === 'DEAL' && v) out.dealId = v;
      if (k === 'CONTACT' && v) out.contactId = v;
    }
  }
  // запасной разбор entityData1 = "Y|DEAL|212673|..."
  if (!out.dealId && chat.entityData1) {
    const p = chat.entityData1.split('|');
    const di = p.indexOf('DEAL');
    if (di >= 0 && Number(p[di + 1])) out.dealId = Number(p[di + 1]);
  }
  return out;
}

// Запомнить/обновить диалог.
async function upsertConversation(data, dialogId) {
  const chat = data.chat || {};
  const msg = data.message || {};
  const { dealId } = crmFromChat(chat);
  await query(
    `INSERT INTO conversations (dialog_id, chat_id, user_id, entity_type, entity_id, crm_deal_id, last_event_at)
     VALUES ($1,$2,$3,$4,$5,$6, now())
     ON CONFLICT (dialog_id) DO UPDATE SET
       chat_id=EXCLUDED.chat_id, user_id=EXCLUDED.user_id,
       entity_type=EXCLUDED.entity_type, entity_id=EXCLUDED.entity_id,
       crm_deal_id=COALESCE(EXCLUDED.crm_deal_id, conversations.crm_deal_id),
       last_event_at=now()`,
    [dialogId, chat.id || msg.chatId || null, msg.authorId || null,
     chat.entityType || '', chat.entityId || '', dealId]
  );
}

async function handleMessageEvent(data) {
  const msg = data.message || {};
  const text = (msg.text || '').trim();
  const dialogId = resolveDialogId(data);
  // Не отвечаем на сообщения самого бота (эхо).
  const botUserId = data.bot?.id;
  if (msg.authorId && botUserId && Number(msg.authorId) === Number(botUserId)) return;
  if (!dialogId || !text) { console.warn('[poller] пропуск: dialogId или текст пустые', { dialogId, hasText: !!text }); return; }
  if (msg.isSystem) return;
  if (await alreadyProcessed(msg.id)) return;

  await upsertConversation(data, dialogId);
  await markProcessed(msg.id);

  const settings = await getSettings();
  if (!settings.bot_enabled) return;

  const botState = await getBotId();
  if (!botState.bot_id) {
    console.warn('[poller] bot_id не задан, пропускаю ответ');
    return;
  }

  // Баланс исчерпан — бот не отвечает (экономим токены) и выходит из сессии,
  // чтобы открытая линия перевела диалог на очередь операторов.
  if (await isExhausted()) {
    console.warn(`[poller] баланс исчерпан — передаю диалог ${dialogId} операторам`);
    try {
      await vibe('DELETE', `/bots/${botState.bot_id}/chats/${dialogId}/users`, { body: { userId: Number(botState.bot_id) } });
    } catch (e) {
      console.warn('[poller] не удалось вывести бота из сессии:', e.message);
    }
    return;
  }

  console.log(`[poller] обрабатываю dialogId=${dialogId} text="${text.slice(0,50)}"`);

  let reply;
  try {
    ({ reply } = await handleUserMessage({ dialogId, text }));
  } catch (e) {
    console.error('[poller] handleUserMessage упал:', e.message, e.stack?.split('\n')[1] || '');
    return;
  }
  console.log(`[poller] сгенерирован ответ (${(reply||'').length} симв.): "${(reply||'').slice(0,80)}"`);
  if (!reply) return;

  try {
    const r = await vibePost(`/bots/${botState.bot_id}/messages`, {
      dialogId,
      fields: { message: reply },
    });
    console.log(`[poller] ответ отправлен в ${dialogId}, msgId=${r.data?.id}`);
  } catch (e) {
    console.error('[poller] не удалось отправить ответ:', e.message);
  }
}

async function pollOnce() {
  const botState = await getBotId();
  if (!botState.bot_id) return; // бот ещё не зарегистрирован

  const res = await vibeGet(`/bots/${botState.bot_id}/events`, { query: { limit: 50 } });
  const data = res.data || {};
  const events = data.events || [];
  if (events.length) {
    console.log(`[poller] получено событий: ${events.length} →`,
      events.map(e => `${e.type}(${e.data?.dialogId || ''})`).join(', '));
  }
  for (const ev of events) {
    try {
      if (ev.type === 'ONIMBOTV2MESSAGEADD') {
        const d = ev.data || {};
        await handleMessageEvent(d);
      } else if (ev.type === 'ONIMBOTV2JOINCHAT') {
        console.log(`[poller] JOINCHAT dialog=${ev.data?.dialogId} entity=${ev.data?.chat?.entityType}`);
      }
    } catch (e) {
      console.error(`[poller] ошибка обработки события ${ev.type}:`, e.message);
    }
  }
  if (typeof data.nextOffset === 'number') {
    await saveOffset(data.nextOffset);
  }
  return data.hasMore;
}

export function startPoller() {
  if (running || config.disableWorkers) return;
  running = true;
  console.log('[poller] запуск, интервал', config.botPollIntervalMs, 'мс');

  const loop = async () => {
    try {
      // Дренируем очередь, пока есть hasMore (но не зацикливаемся бесконечно).
      let guard = 0;
      let hasMore = true;
      while (hasMore && guard++ < 10) {
        hasMore = await pollOnce();
      }
    } catch (e) {
      if (e.code === 'GATEWAY_HTML') {
        // временный таймаут gateway — молча ждём следующий тик
      } else {
        console.error('[poller] ошибка цикла:', e.message);
      }
    } finally {
      timer = setTimeout(loop, config.botPollIntervalMs);
    }
  };
  loop();
}

export function stopPoller() {
  running = false;
  if (timer) clearTimeout(timer);
}
