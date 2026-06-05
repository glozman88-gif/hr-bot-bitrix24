import { vibeGet, vibePost, vibePatch } from '../vibe.js';
import { query } from '../db.js';

// Обновление CRM-сделки, привязанной к диалогу открытой линии.
//
// Сделку НЕ создаём — она уже создаётся открытой линией Битрикс24 и её id приходит
// в данных чата (chat.entityData2 → DEAL|<id>), которые poller сохраняет в
// conversations.crm_deal_id. Мы только дописываем собранную анкету в существующую сделку.
//
// Формат entity API: поля на ВЕРХНЕМ уровне в camelCase (title, comments, contactId...),
// без обёртки { fields: {...} } и без UPPERCASE.

function normalizePhone(p) {
  return p ? String(p).replace(/[^\d+]/g, '') : '';
}

// Мягкий фолбэк (только ЧТЕНИЕ): найти сделку по телефону, если id не пришёл из чата.
async function findContactByPhone(phone) {
  const norm = normalizePhone(phone);
  if (!norm || norm.replace('+', '').length < 6) return null;
  try {
    const res = await vibePost('/contacts/search', { filter: { phone: norm }, limit: 1 });
    const items = res.data?.items || res.data || [];
    return Array.isArray(items) && items.length ? items[0] : null;
  } catch { return null; }
}
async function findDealByContact(contactId) {
  try {
    const res = await vibePost('/deals/search', { filter: { contactId, closed: 'N' }, sort: { id: 'desc' }, limit: 1 });
    const items = res.data?.items || res.data || [];
    return Array.isArray(items) && items.length ? items[0] : null;
  } catch { return null; }
}

async function saveDealId(dialogId, dealId) {
  await query('UPDATE conversations SET crm_deal_id=$2 WHERE dialog_id=$1', [dialogId, dealId]);
  await query('UPDATE candidates SET crm_deal_id=$2 WHERE dialog_id=$1', [dialogId, dealId]);
}

// Возвращает id сделки или null. НИКОГДА не создаёт новые сущности.
export async function resolveDealId(conversation, candidate, settings) {
  if (conversation.crm_deal_id) return Number(conversation.crm_deal_id);
  if (!settings.crm_update_enabled) return null;
  // Фолбэк: найти существующую сделку по телефону (без создания).
  if (candidate?.phone) {
    const contact = await findContactByPhone(candidate.phone);
    if (contact) {
      const deal = await findDealByContact(contact.id || contact.ID);
      if (deal) {
        const id = Number(deal.id || deal.ID);
        await saveDealId(conversation.dialog_id, id);
        return id;
      }
    }
  }
  return null;
}

// Дописать анкету соискателя в существующую сделку (в поле comments).
export async function updateDealFromCandidate(dealId, candidate, offeredVacancies = []) {
  if (!dealId) return;
  const lines = [];
  const f = candidate.fields || {};
  const push = (label, val) => { if (val) lines.push(`${label}: ${val}`); };
  push('Имя', candidate.full_name);
  push('Телефон', candidate.phone);
  push('Email', candidate.email);
  push('Город', candidate.city);
  push('Желаемая должность', candidate.desired_position);
  push('Опыт', candidate.experience);
  push('Ожидания по зарплате', candidate.salary_expectation);
  push('График', candidate.schedule);
  const std = ['full_name','phone','email','city','desired_position','experience','salary_expectation','schedule'];
  for (const [k, v] of Object.entries(f)) if (!std.includes(k) && v) push(k, v);
  if (offeredVacancies.length) lines.push('Предложенные вакансии: ' + offeredVacancies.map(v => v.title).join('; '));

  const comment = 'Анкета соискателя (HR-бот):\n' + lines.join('\n');
  try {
    await vibePatch(`/deals/${dealId}`, { comments: comment });
  } catch (e) {
    console.warn('[crm] обновление сделки не удалось:', e.message);
  }
}
