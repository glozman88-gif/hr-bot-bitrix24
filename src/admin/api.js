import { Router } from 'express';
import { query, getSettings } from '../db.js';
import { authMiddleware } from './auth.js';
import { runAvitoSync, getLastAvitoRun } from '../avito/scheduler.js';
import { runHHSync, getLastHHRun } from '../hh/scheduler.js';
import { fetchAvitoItemDescription } from '../avito/parser.js';
import { vibeGet, vibePost } from '../vibe.js';
import { config } from '../config.js';
import { getBillingState, topupTokens, createInvoice, payInvoice, cancelInvoice, setBillingSettings, getAccount, tokensToRub, generateInvoicePdfBuffer } from '../billing.js';
import { runTbankSync, getTbankStatus } from '../billing/tbank.js';

export const adminRouter = Router();
adminRouter.use(authMiddleware);

const wrap = (fn) => (req, res) => fn(req, res).catch((e) => {
  console.error('[admin]', req.method, req.path, e.message);
  res.status(500).json({ error: 'INTERNAL', message: e.message });
});

// Админ биллинга — только заданный Bitrix-пользователь (по умолч. 154) или ops-токен.
function isAdminReq(req) {
  const u = req.user || {};
  if (u.viaToken) return true;
  // Пароль админ-части (кнопка в углу): заголовок X-Admin-Pass.
  if (config.adminPanelPassword && req.get('x-admin-pass') === config.adminPanelPassword) return true;
  const id = String(u.id ?? u.userId ?? u.ID ?? '');
  return id === String(config.adminUserId);
}
function requireAdmin(req, res, next) {
  if (isAdminReq(req)) return next();
  res.status(403).json({ error: 'FORBIDDEN', message: 'Доступно только администратору' });
}

// ── Текущий пользователь ──
adminRouter.get('/me', wrap(async (req, res) => {
  res.json({ user: req.user, isAdmin: isAdminReq(req) });
}));

// ── Вход в админ-часть по паролю (кнопка в углу) ──
adminRouter.post('/admin-login', wrap(async (req, res) => {
  if (!config.adminPanelPassword) return res.status(400).json({ error: 'Пароль админ-части не настроен' });
  if ((req.body?.password || '') === config.adminPanelPassword) return res.json({ ok: true });
  res.status(403).json({ error: 'Неверный пароль' });
}));

// ── Настройки ──
adminRouter.get('/settings', wrap(async (req, res) => {
  const s = await getSettings();
  const { rows: botState } = await query('SELECT bot_id FROM bot_state WHERE id=1');
  // Не отдаём секрет в браузер — только признак, что он задан.
  s.avito_secret_set = !!s.avito_client_secret;
  delete s.avito_client_secret;
  s.hh_secret_set = !!s.hh_client_secret;
  delete s.hh_client_secret;
  res.json({ settings: s, bot: botState[0] });
}));

adminRouter.put('/settings', wrap(async (req, res) => {
  const b = req.body || {};
  const allowed = [
    'bot_enabled', 'ai_model', 'byok_provider', 'active_prompt_id',
    'crm_entity_type', 'crm_update_enabled', 'temperature', 'max_tokens',
    'avito_client_id', 'avito_client_secret', 'avito_only_vacancies', 'hh_employer_id', 'hh_client_id', 'hh_client_secret',
  ];
  // Пустой секрет из формы не должен затирать сохранённый.
  if ('avito_client_secret' in b && !b.avito_client_secret) delete b.avito_client_secret;
  if ('hh_client_secret' in b && !b.hh_client_secret) delete b.hh_client_secret;
  const sets = [];
  const vals = [];
  let i = 1;
  for (const k of allowed) {
    if (k in b) { sets.push(`${k}=$${i++}`); vals.push(b[k]); }
  }
  if ('avito_sources' in b) { sets.push(`avito_sources=$${i++}`); vals.push(JSON.stringify(b.avito_sources)); }
  if (!sets.length) return res.json({ ok: true });
  sets.push('updated_at=now()');
  await query(`UPDATE settings SET ${sets.join(', ')} WHERE id=1`, vals);
  res.json({ ok: true, settings: await getSettings() });
}));

// ── Доступные модели «нейрона» (для выбора платной / BYOK) ──
adminRouter.get('/ai/models', wrap(async (req, res) => {
  const me = await vibeGet('/me');
  const detail = me.data?.ai?.modelsDetail || me.data?.ai?.models || [];
  const usable = me.data?.ai?.defaultUsable || [];
  res.json({
    defaultModel: me.data?.ai?.defaultModel,
    byokAvailable: me.data?.ai?.byok?.available,
    usable,
    models: detail,
  });
}));

// ── Промпты (типы задач) ──
adminRouter.get('/prompts', wrap(async (req, res) => {
  const { rows } = await query('SELECT * FROM prompts ORDER BY id');
  res.json({ prompts: rows });
}));

adminRouter.post('/prompts', wrap(async (req, res) => {
  const { task_type, name, system_prompt, collect_fields, is_active } = req.body || {};
  if (!name || !system_prompt) return res.status(400).json({ error: 'name и system_prompt обязательны' });
  const { rows } = await query(
    `INSERT INTO prompts (task_type, name, system_prompt, collect_fields, is_active)
     VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [task_type || 'custom', name, system_prompt, JSON.stringify(collect_fields || []), is_active !== false]
  );
  res.json({ prompt: rows[0] });
}));

adminRouter.put('/prompts/:id', wrap(async (req, res) => {
  const { task_type, name, system_prompt, collect_fields, is_active } = req.body || {};
  const { rows } = await query(
    `UPDATE prompts SET task_type=COALESCE($2,task_type), name=COALESCE($3,name),
       system_prompt=COALESCE($4,system_prompt),
       collect_fields=COALESCE($5,collect_fields), is_active=COALESCE($6,is_active),
       updated_at=now() WHERE id=$1 RETURNING *`,
    [req.params.id, task_type, name, system_prompt,
     collect_fields ? JSON.stringify(collect_fields) : null,
     typeof is_active === 'boolean' ? is_active : null]
  );
  if (!rows.length) return res.status(404).json({ error: 'not found' });
  res.json({ prompt: rows[0] });
}));

adminRouter.delete('/prompts/:id', wrap(async (req, res) => {
  await query('DELETE FROM prompts WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
}));

// ── Вакансии ──
adminRouter.get('/vacancies', wrap(async (req, res) => {
  const { offered, active, q, source, source_ne } = req.query;
  const where = [];
  const vals = [];
  let i = 1;
  if (offered === 'true') where.push('is_offered=TRUE');
  if (active === 'true') where.push('is_active=TRUE');
  if (q) { where.push(`(title ILIKE $${i} OR description ILIKE $${i})`); vals.push(`%${q}%`); i++; }
  if (source) { where.push(`source=$${i++}`); vals.push(source); }
  if (source_ne) { where.push(`source!=$${i++}`); vals.push(source_ne); }
  const sql = `SELECT id, source, external_id, title, salary, location, company, url,
    is_offered, is_active, parsed_at, length(description) AS desc_len
    FROM vacancies ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY is_offered DESC, updated_at DESC LIMIT 500`;
  const { rows } = await query(sql, vals);
  res.json({ vacancies: rows });
}));

adminRouter.get('/vacancies/:id', wrap(async (req, res) => {
  const { rows } = await query('SELECT * FROM vacancies WHERE id=$1', [req.params.id]);
  if (!rows.length) return res.status(404).json({ error: 'not found' });
  res.json({ vacancy: rows[0] });
}));

// Переключить галочку «предлагать».
adminRouter.patch('/vacancies/:id', wrap(async (req, res) => {
  const { is_offered, title, description, salary, location, company, is_active } = req.body || {};
  const { rows } = await query(
    `UPDATE vacancies SET
       is_offered=COALESCE($2,is_offered), title=COALESCE($3,title),
       description=COALESCE($4,description), salary=COALESCE($5,salary),
       location=COALESCE($6,location), company=COALESCE($7,company),
       is_active=COALESCE($8,is_active), updated_at=now()
     WHERE id=$1 RETURNING *`,
    [req.params.id,
     typeof is_offered === 'boolean' ? is_offered : null,
     title ?? null, description ?? null, salary ?? null, location ?? null,
     company ?? null, typeof is_active === 'boolean' ? is_active : null]
  );
  if (!rows.length) return res.status(404).json({ error: 'not found' });
  res.json({ vacancy: rows[0] });
}));

// Массовое переключение галочек.
adminRouter.post('/vacancies/bulk-offer', wrap(async (req, res) => {
  const { ids, is_offered } = req.body || {};
  if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'ids обязательны' });
  await query('UPDATE vacancies SET is_offered=$2, updated_at=now() WHERE id = ANY($1)', [ids, !!is_offered]);
  res.json({ ok: true, count: ids.length });
}));

// Ручное добавление вакансии (фолбэк, если Авито недоступен).
adminRouter.post('/vacancies', wrap(async (req, res) => {
  const { title, description, salary, location, company, url, is_offered } = req.body || {};
  if (!title) return res.status(400).json({ error: 'title обязателен' });
  const { rows } = await query(
    `INSERT INTO vacancies (source, external_id, title, description, salary, location, company, url, is_offered, is_active)
     VALUES ('manual', $1, $2, $3, $4, $5, $6, $7, $8, TRUE) RETURNING *`,
    ['m' + Date.now(), title, description || '', salary || '', location || '', company || '', url || '', !!is_offered]
  );
  res.json({ vacancy: rows[0] });
}));

adminRouter.delete('/vacancies/:id', wrap(async (req, res) => {
  await query('DELETE FROM vacancies WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
}));

// ── Авито: статус и ручной запуск парсинга ──
adminRouter.get('/avito/status', wrap(async (req, res) => {
  res.json({ lastRun: getLastAvitoRun() });
}));

adminRouter.post('/avito/sync', wrap(async (req, res) => {
  const result = await runAvitoSync({ withDescriptions: req.body?.withDescriptions !== false });
  res.json({ result });
}));

// ── HH.ru: статус и ручной запуск синхронизации ──
adminRouter.get('/hh/status', wrap(async (req, res) => {
  res.json({ lastRun: getLastHHRun() });
}));

adminRouter.post('/hh/sync', wrap(async (req, res) => {
  const result = await runHHSync();
  res.json({ result });
}));

// ── Кандидаты (собранные анкеты) ──
adminRouter.get('/candidates', wrap(async (req, res) => {
  const { rows } = await query(
    `SELECT c.*, conv.entity_type, conv.last_event_at,
       (SELECT count(*) FROM messages m WHERE m.dialog_id=c.dialog_id) AS msg_count
     FROM candidates c
     LEFT JOIN conversations conv ON conv.dialog_id=c.dialog_id
     ORDER BY c.updated_at DESC LIMIT 300`
  );
  res.json({ candidates: rows });
}));

adminRouter.get('/candidates/:dialogId/messages', wrap(async (req, res) => {
  const { rows } = await query(
    'SELECT role, text, created_at FROM messages WHERE dialog_id=$1 ORDER BY id ASC',
    [req.params.dialogId]
  );
  res.json({ messages: rows });
}));

// ── Публикация приложения в Битрикс24 (встраивание в левое меню) ──
// Требует, чтобы приложение было предварительно авторизовано пользователем на портале
// (откройте authorizeUrl). Затем публикация привязывает placement.
adminRouter.get('/app/status', wrap(async (req, res) => {
  if (!config.appId || !config.appKey) return res.json({ configured: false });
  let app = null;
  try { const r = await vibeGet(`/apps/${config.appId}`); app = r.data || r; } catch (e) { /* ignore */ }
  const authorizeUrl = `https://vibecode.bitrix24.tech/v1/oauth/authorize?app_key=${encodeURIComponent(config.appKey)}&state=${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
  res.json({
    configured: true,
    appId: config.appId,
    appUrl: app?.appUrl || config.appUrl,
    placements: app?.placements || [],
    authorizeUrl,
  });
}));

adminRouter.post('/app/publish', wrap(async (req, res) => {
  if (!config.appId) return res.status(400).json({ error: 'APP_ID не настроен' });
  const placements = Array.isArray(req.body?.placements) && req.body.placements.length
    ? req.body.placements : ['LEFT_MENU'];
  try {
    const r = await vibePost(`/apps/${config.appId}/publish`, { placements });
    res.json({ ok: true, app: r.data || r });
  } catch (e) {
    // Частый случай: приложение ещё не авторизовано пользователем на портале.
    res.status(400).json({ error: e.code || 'PUBLISH_FAILED', message: e.message });
  }
}));

// ── Placement: встраивание приложения в интерфейс Битрикс24 ──
// Использует OAuth-ключ приложения (config.appKey) + сессионный токен текущего
// пользователя (req.vibeBearer), который инжектит gateway.
function placementOpts() {
  return { apiKey: config.appKey, bearer: undefined };
}
adminRouter.get('/placement/available', wrap(async (req, res) => {
  if (!config.appKey) return res.json({ available: [], note: 'OAuth-приложение не настроено (VIBE_APP_KEY).' });
  const r = await vibeGet('/placements/available', { apiKey: config.appKey, bearer: req.vibeBearer });
  res.json(r.data || r);
}));
adminRouter.get('/placement', wrap(async (req, res) => {
  if (!config.appKey) return res.json({ placements: [] });
  const r = await vibeGet('/placements', { apiKey: config.appKey, bearer: req.vibeBearer });
  res.json(r.data || r);
}));
adminRouter.post('/placement/bind', wrap(async (req, res) => {
  if (!config.appKey) return res.status(400).json({ error: 'VIBE_APP_KEY не настроен' });
  const { placement, title, options } = req.body || {};
  const handler = (config.appUrl || '').replace(/\/$/, '') + '/';
  const body = { placement: placement || 'LEFT_MENU', handler, title: title || 'HR-бот' };
  if (options) body.options = options;
  const r = await vibePost('/placements/bind', body, { apiKey: config.appKey, bearer: req.vibeBearer });
  res.json(r.data || r);
}));
adminRouter.post('/placement/unbind', wrap(async (req, res) => {
  if (!config.appKey) return res.status(400).json({ error: 'VIBE_APP_KEY не настроен' });
  const r = await vibePost('/placements/unbind', { placement: req.body?.placement }, { apiKey: config.appKey, bearer: req.vibeBearer });
  res.json(r.data || r);
}));

// ── Биллинг: баланс, выписка, счета ──
adminRouter.get('/billing/state', wrap(async (req, res) => {
  const state = await getBillingState();
  state.isAdmin = isAdminReq(req);
  state.tbank = getTbankStatus();
  res.json(state);
}));

// ── T-Bank: статус сверки и ручная проверка оплат (если авто не прошло) ──
adminRouter.get('/billing/tbank-status', wrap(async (req, res) => {
  res.json(getTbankStatus());
}));
adminRouter.post('/billing/check-payments', requireAdmin, wrap(async (req, res) => {
  const result = await runTbankSync({ lookbackDays: Number(req.body?.lookbackDays) || 14 });
  res.json({ ok: true, result });
}));
adminRouter.post('/billing/topup', requireAdmin, wrap(async (req, res) => {
  const tokens = Number(req.body?.tokens);
  if (!tokens) return res.status(400).json({ error: 'Укажите количество токенов' });
  const balance = await topupTokens(tokens, req.body?.note || 'Ручное пополнение');
  res.json({ ok: true, balance });
}));
adminRouter.post('/billing/invoice', requireAdmin, wrap(async (req, res) => {
  const { tokens, amountRub, note, payerName, payerInn, isPromised } = req.body || {};
  if (!Number(tokens) && !Number(amountRub)) return res.status(400).json({ error: 'Укажите токены или сумму' });
  if (!payerName || !String(payerName).trim()) return res.status(400).json({ error: 'Укажите юридическое лицо (плательщика)' });
  const innClean = String(payerInn || '').replace(/\D/g, '');
  if (!(innClean.length === 10 || innClean.length === 12)) return res.status(400).json({ error: 'Укажите корректный ИНН (10 или 12 цифр)' });
  try {
    const inv = await createInvoice({ tokens, amountRub, note, payerName: String(payerName).trim(), payerInn: innClean, isPromised: !!isPromised });
    res.json({ ok: true, invoice: inv });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
}));
adminRouter.get('/billing/invoice/:id/pdf', wrap(async (req, res) => {
  const buf = await generateInvoicePdfBuffer(Number(req.params.id));
  res.set('Content-Type', 'application/pdf');
  res.set('Content-Disposition', `inline; filename="invoice-${req.params.id}.pdf"`);
  res.send(buf);
}));
adminRouter.post('/billing/invoice/:id/pay', requireAdmin, wrap(async (req, res) => {
  res.json({ ok: true, invoice: await payInvoice(Number(req.params.id)) });
}));
adminRouter.post('/billing/invoice/:id/cancel', requireAdmin, wrap(async (req, res) => {
  res.json(await cancelInvoice(Number(req.params.id)));
}));
adminRouter.put('/billing/settings', requireAdmin, wrap(async (req, res) => {
  const acc = await setBillingSettings(req.body || {});
  res.json({ ok: true, account: acc });
}));

// ── Расход токенов ──
adminRouter.get('/usage', wrap(async (req, res) => {
  const totals = await query(
    `SELECT COALESCE(SUM(total_tokens),0)::int AS total,
            COALESCE(SUM(prompt_tokens),0)::int AS prompt,
            COALESCE(SUM(completion_tokens),0)::int AS completion,
            COUNT(*)::int AS calls,
            COUNT(DISTINCT dialog_id)::int AS dialogs
     FROM token_usage`
  );
  const perDialog = await query(
    `SELECT dialog_id,
            COUNT(*)::int AS calls,
            SUM(total_tokens)::int AS total_tokens,
            SUM(prompt_tokens)::int AS prompt_tokens,
            SUM(completion_tokens)::int AS completion_tokens,
            MAX(created_at) AS last_at
     FROM token_usage GROUP BY dialog_id ORDER BY MAX(created_at) DESC LIMIT 200`
  );
  const t = totals.rows[0];
  const avgPerDialog = t.dialogs ? Math.round(t.total / t.dialogs) : 0;
  const avgPerCall = t.calls ? Math.round(t.total / t.calls) : 0;
  const acc = await getAccount();
  const price = Number(acc?.token_price_rub || 0);
  res.json({
    totals: t, avgPerDialog, avgPerCall,
    pricePer1k: price,
    avgPerDialogRub: tokensToRub(avgPerDialog, price),
    avgPerCallRub: tokensToRub(avgPerCall, price),
    totalRub: tokensToRub(t.total, price),
    perDialog: perDialog.rows,
  });
}));

// ── Дашборд: краткая статистика ──
adminRouter.get('/stats', wrap(async (req, res) => {
  const [v, c, m] = await Promise.all([
    query(`SELECT count(*)::int total, count(*) FILTER (WHERE is_offered)::int offered, count(*) FILTER (WHERE is_active)::int active FROM vacancies`),
    query(`SELECT count(*)::int total FROM candidates`),
    query(`SELECT count(DISTINCT dialog_id)::int dialogs FROM messages`),
  ]);
  res.json({
    vacancies: v.rows[0],
    candidates: c.rows[0].total,
    dialogs: m.rows[0].dialogs,
    avito: getLastAvitoRun(),
    hh: getLastHHRun(),
  });
}));


// ── Ручные вакансии (job_positions) ──────────────────────────────────────────
adminRouter.get('/positions', wrap(async (req, res) => {
  const { rows } = await query(
    'SELECT id,city,category,position,description,is_offered,sort_order FROM job_positions ORDER BY city, sort_order, id'
  );
  res.json({ positions: rows });
}));

adminRouter.patch('/positions/:id', wrap(async (req, res) => {
  const { id } = req.params;
  const { is_offered } = req.body;
  const { rows } = await query(
    'UPDATE job_positions SET is_offered=$1 WHERE id=$2 RETURNING *',
    [is_offered, id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'NOT_FOUND' });
  res.json({ position: rows[0] });
}));

adminRouter.post('/positions/bulk-offer', wrap(async (req, res) => {
  const { ids, is_offered } = req.body;
  if (!Array.isArray(ids) || !ids.length) return res.json({ updated: 0 });
  await query(
    `UPDATE job_positions SET is_offered=$1 WHERE id = ANY($2::int[])`,
    [is_offered, ids]
  );
  res.json({ updated: ids.length });
}));
