import { query, getSettings } from '../db.js';
import { chatCompletion } from '../vibe.js';
import { resolveDealId, updateDealFromCandidate, changeDealStage } from './crm.js';
import { debitTokens } from '../billing.js';

// Обработка одного входящего сообщения соискателя.

const CANDIDATE_FIELDS = [
  'full_name', 'age', 'city', 'phone', 'citizenship',
  'desired_position', 'work_duration', 'schedule',
];

// Достаём активный промпт (тип задачи) из настроек.
async function getActivePrompt(settings) {
  if (settings.active_prompt_id) {
    const { rows } = await query('SELECT * FROM prompts WHERE id=$1 AND is_active=TRUE', [settings.active_prompt_id]);
    if (rows[0]) return rows[0];
  }
  const { rows } = await query('SELECT * FROM prompts WHERE is_active=TRUE ORDER BY id LIMIT 1');
  return rows[0] || null;
}

// Вакансии, помеченные «предлагать».
async function getOfferableVacancies() {
  const { rows } = await query(
    `SELECT id, city, category, position, description FROM job_positions WHERE is_offered=TRUE ORDER BY city, sort_order, id`
  );
  return rows;
}

// Последние N сообщений диалога (хронологически).
async function getContext(dialogId, limit) {
  const { rows } = await query(
    `SELECT role, text FROM (
       SELECT role, text, id FROM messages WHERE dialog_id=$1 ORDER BY id DESC LIMIT $2
     ) s ORDER BY id ASC`,
    [dialogId, limit]
  );
  return rows;
}

function vacanciesBlock(positions) {
  if (!positions.length) return 'Сейчас активных вакансий для предложения нет.';
  return positions.map(p => {
    const head = `#${p.id} ${p.position}, город: ${p.city}, категория: ${p.category}`;
    const desc = (p.description || '').slice(0, 800);
    return desc ? `${head}\n${desc}` : head;
  }).join('\n---\n');
}

function buildSystemPrompt(prompt, vacancies, collectFields) {
  const fields = (collectFields && collectFields.length ? collectFields : CANDIDATE_FIELDS).join(', ');
  return `${prompt.system_prompt}

=== ДОСТУПНЫЕ ВАКАНСИИ (предлагай ТОЛЬКО из этого списка) ===
${vacanciesBlock(vacancies)}

=== ФОРМАТ ОТВЕТА ===
Верни СТРОГО JSON-объект без какого-либо текста вокруг, по схеме:
{
  "reply": "текст ответа соискателю (вежливо, по-русски, кратко)",
  "extracted": { ${fields.split(', ').map(f => `"${f}": "значение или пустая строка"`).join(', ')} },
  "suggested_vacancy_ids": [номера вакансий из списка, если уместно предложить],
  "transfer_to_operator": false
}
В "extracted" указывай только то, что соискатель действительно сообщил; не выдумывай. Поля, которых нет, оставляй пустыми.
Установи "transfer_to_operator": true когда по инструкции нужен перевод на оператора.`;
}

// Лениво и безопасно извлекаем JSON из ответа модели.
function parseModelJson(content) {
  if (!content) return null;
  let txt = content.trim();
  // снять markdown-ограждение ```json ... ```
  const fence = txt.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) txt = fence[1].trim();
  // взять первый сбалансированный объект
  const start = txt.indexOf('{');
  if (start === -1) return null;
  let depth = 0, end = -1;
  for (let i = start; i < txt.length; i++) {
    if (txt[i] === '{') depth++;
    else if (txt[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
  }
  if (end === -1) return null;
  try { return JSON.parse(txt.slice(start, end + 1)); } catch { return null; }
}

// Сохранить/обновить профиль соискателя.
async function upsertCandidate(dialogId, dealId, extracted, suggestedIds) {
  const ext = extracted || {};
  const std = {};
  for (const k of CANDIDATE_FIELDS) {
    const v = (ext[k] || '').toString().trim();
    if (v) std[k] = v;
  }
  // нестандартные поля -> в fields
  const extra = {};
  for (const [k, v] of Object.entries(ext)) {
    if (!CANDIDATE_FIELDS.includes(k) && v) extra[k] = v;
  }

  const { rows } = await query('SELECT * FROM candidates WHERE dialog_id=$1', [dialogId]);
  if (!rows.length) {
    await query(
      `INSERT INTO candidates (dialog_id, crm_deal_id, full_name, age, city, phone,
        citizenship, desired_position, work_duration, schedule, fields, offered_vacancy_ids)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [dialogId, dealId, std.full_name, std.age, std.city, std.phone,
       std.citizenship, std.desired_position, std.work_duration, std.schedule,
       JSON.stringify(extra), suggestedIds || []]
    );
  } else {
    const cur = rows[0];
    const merge = (a, b) => (b && b.trim() ? b : a);
    const mergedFields = { ...(cur.fields || {}), ...extra };
    const mergedOffered = Array.from(new Set([...(cur.offered_vacancy_ids || []), ...(suggestedIds || [])]));
    await query(
      `UPDATE candidates SET crm_deal_id=COALESCE($2,crm_deal_id),
        full_name=$3, age=$4, city=$5, phone=$6, citizenship=$7, desired_position=$8,
        work_duration=$9, schedule=$10, fields=$11,
        offered_vacancy_ids=$12, updated_at=now() WHERE dialog_id=$1`,
      [dialogId, dealId,
       merge(cur.full_name, std.full_name), merge(cur.age, std.age),
       merge(cur.city, std.city), merge(cur.phone, std.phone),
       merge(cur.citizenship, std.citizenship), merge(cur.desired_position, std.desired_position),
       merge(cur.work_duration, std.work_duration), merge(cur.schedule, std.schedule),
       JSON.stringify(mergedFields), mergedOffered]
    );
  }
  const { rows: out } = await query('SELECT * FROM candidates WHERE dialog_id=$1', [dialogId]);
  return out[0];
}

// Основная функция: генерирует ответ на сообщение и выполняет побочные эффекты.
// Возвращает { reply } — текст, который надо отправить ботом.
export async function handleUserMessage({ dialogId, text }) {
  const settings = await getSettings();
  const prompt = await getActivePrompt(settings);
  if (!prompt) {
    return { reply: 'Здравствуйте! Бот пока настраивается, ответим чуть позже.' };
  }

  // 1. Сохранить входящее сообщение.
  await query('INSERT INTO messages (dialog_id, role, text) VALUES ($1,$2,$3)', [dialogId, 'user', text]);

  // 2. Контекст последних N сообщений + вакансии.
  const [context, vacancies] = await Promise.all([
    getContext(dialogId, settings.context_window || 30),
    getOfferableVacancies(),
  ]);

  // 3. Сборка сообщений для модели.
  const collectFields = Array.isArray(prompt.collect_fields) ? prompt.collect_fields : [];
  const system = buildSystemPrompt(prompt, vacancies, collectFields);
  const messages = [{ role: 'system', content: system }, ...context.map(m => ({ role: m.role, content: m.text }))];

  // 4. Запрос к «нейрону». Пустая модель => бесплатный BitrixGPT.
  let modelContent = '';
  try {
    const resp = await chatCompletion(messages, {
      model: settings.ai_model || undefined,
      temperature: settings.temperature ?? 0.5,
      maxTokens: settings.max_tokens || 700,
    });
    modelContent = resp.choices?.[0]?.message?.content || '';
    // Учёт токенов.
    const u = resp.usage || {};
    try {
      await query(
        `INSERT INTO token_usage (dialog_id, model, prompt_tokens, completion_tokens, total_tokens)
         VALUES ($1,$2,$3,$4,$5)`,
        [dialogId, resp.model || settings.ai_model || 'bitrix/free',
         u.prompt_tokens || 0, u.completion_tokens || 0,
         u.total_tokens || ((u.prompt_tokens || 0) + (u.completion_tokens || 0))]
      );
      // Списание токенов с баланса.
      await debitTokens(dialogId, u.total_tokens || ((u.prompt_tokens || 0) + (u.completion_tokens || 0)), 'Ответ бота в диалоге');
    } catch (e2) { console.warn('[conversation] не удалось записать usage/списать:', e2.message); }
  } catch (e) {
    console.error('[conversation] ошибка AI Router:', e.message);
    return { reply: 'Извините, технический сбой. Повторите сообщение чуть позже.' };
  }

  const parsed = parseModelJson(modelContent);
  const reply = (parsed?.reply || modelContent || 'Спасибо за сообщение!').toString().trim();
  const extracted = parsed?.extracted || {};
  const suggestedIds = Array.isArray(parsed?.suggested_vacancy_ids)
    ? parsed.suggested_vacancy_ids.map(Number).filter(Boolean) : [];
  const transferToOperator = parsed?.transfer_to_operator === true;

  // 5. Сохранить ответ ассистента.
  await query('INSERT INTO messages (dialog_id, role, text) VALUES ($1,$2,$3)', [dialogId, 'assistant', reply]);

  // 6. Обновить профиль + CRM (best-effort, не блокируем ответ при ошибке).
  try {
    const { rows: convRows } = await query('SELECT * FROM conversations WHERE dialog_id=$1', [dialogId]);
    const conversation = convRows[0] || { dialog_id: dialogId };
    let candidate = await upsertCandidate(dialogId, conversation.crm_deal_id || null, extracted, suggestedIds);

    if (settings.crm_update_enabled) {
      const dealId = await resolveDealId(conversation, candidate, settings);
      if (dealId) {
        const offered = suggestedIds.length
          ? vacancies.filter(v => suggestedIds.includes(v.id))
          : [];
        await updateDealFromCandidate(dealId, candidate, offered);
        if (transferToOperator) {
          await changeDealStage(dealId, 'C7:UC_CW28EB');
        }
      }
    }
  } catch (e) {
    console.warn('[conversation] побочные эффекты (профиль/CRM) с ошибкой:', e.message);
  }

  return { reply };
}

export { parseModelJson };
