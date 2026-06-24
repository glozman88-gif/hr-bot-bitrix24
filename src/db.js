import pg from 'pg';
import { config } from './config.js';

const { Pool } = pg;

export const pool = new Pool({
  connectionString: config.databaseUrl,
  max: 10,
  idleTimeoutMillis: 30000,
});

pool.on('error', (err) => {
  console.error('[db] неожиданная ошибка пула:', err.message);
});

export async function query(text, params) {
  return pool.query(text, params);
}

// Схема. Идемпотентные CREATE ... IF NOT EXISTS — безопасно гонять при каждом старте.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (
  id            INT PRIMARY KEY DEFAULT 1,
  bot_enabled   BOOLEAN NOT NULL DEFAULT TRUE,
  -- Модель «нейрона». Пусто => бесплатный BitrixGPT (model не передаётся в AI Router).
  ai_model      TEXT NOT NULL DEFAULT '',
  -- BYOK: провайдер и пометка, что ключ зарегистрирован в AI Router (сам ключ не храним).
  byok_provider TEXT NOT NULL DEFAULT '',
  byok_configured BOOLEAN NOT NULL DEFAULT FALSE,
  -- Идентификатор активного промпта по умолчанию (тип задачи)
  active_prompt_id INT,
  -- Привязка сбора данных в CRM: тип сущности (deal|lead) и режим
  crm_entity_type TEXT NOT NULL DEFAULT 'deal',
  crm_update_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  -- Источники Авито (массив объектов { url, label })
  avito_sources JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- Температура и лимит токенов для генерации
  temperature   REAL NOT NULL DEFAULT 0.5,
  max_tokens    INT NOT NULL DEFAULT 700,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- Промпты под разные типы задач. Один может быть активным «по умолчанию».
CREATE TABLE IF NOT EXISTS prompts (
  id          SERIAL PRIMARY KEY,
  task_type   TEXT NOT NULL,              -- напр. screening, faq, booking
  name        TEXT NOT NULL,
  system_prompt TEXT NOT NULL,
  -- Какие поля бот должен собрать (список ключей) — используется в extraction
  collect_fields JSONB NOT NULL DEFAULT '[]'::jsonb,
  is_active   BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Вакансии (источник — Авито-парсер или ручное добавление).
CREATE TABLE IF NOT EXISTS vacancies (
  id          SERIAL PRIMARY KEY,
  source      TEXT NOT NULL DEFAULT 'avito',  -- avito | manual
  external_id TEXT,                            -- id объявления на Авито (для дедупликации)
  title       TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  url         TEXT,
  salary      TEXT,
  location    TEXT,
  company     TEXT,
  raw         JSONB,
  -- Галочка «предлагать эту вакансию соискателям»
  is_offered  BOOLEAN NOT NULL DEFAULT FALSE,
  -- Объявление ещё активно на источнике
  is_active   BOOLEAN NOT NULL DEFAULT TRUE,
  parsed_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (source, external_id)
);
CREATE INDEX IF NOT EXISTS idx_vacancies_offered ON vacancies (is_offered, is_active);

-- Диалоги (по dialogId открытой линии).
CREATE TABLE IF NOT EXISTS conversations (
  dialog_id   TEXT PRIMARY KEY,
  chat_id     BIGINT,
  user_id     BIGINT,
  entity_type TEXT,         -- LINES, CRM, ''
  entity_id   TEXT,
  crm_deal_id BIGINT,       -- резолвленная сделка
  candidate_id INT,
  last_event_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Сообщения для контекста (последние N на диалог).
CREATE TABLE IF NOT EXISTS messages (
  id          SERIAL PRIMARY KEY,
  dialog_id   TEXT NOT NULL,
  role        TEXT NOT NULL,           -- user | assistant
  text        TEXT NOT NULL,
  bx_message_id BIGINT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_messages_dialog ON messages (dialog_id, id DESC);

-- Профиль соискателя (собранная первичная информация).
CREATE TABLE IF NOT EXISTS candidates (
  id          SERIAL PRIMARY KEY,
  dialog_id   TEXT UNIQUE,
  crm_deal_id BIGINT,
  full_name   TEXT,
  phone       TEXT,
  email       TEXT,
  desired_position TEXT,
  experience  TEXT,
  city        TEXT,
  salary_expectation TEXT,
  schedule    TEXT,
  -- Все собранные поля целиком (включая нестандартные)
  fields      JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- Вакансии, которые бот предложил
  offered_vacancy_ids INT[] NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Учёт расхода токенов AI на каждый ответ бота.
CREATE TABLE IF NOT EXISTS token_usage (
  id          SERIAL PRIMARY KEY,
  dialog_id   TEXT NOT NULL,
  model       TEXT,
  prompt_tokens     INT NOT NULL DEFAULT 0,
  completion_tokens INT NOT NULL DEFAULT 0,
  total_tokens      INT NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_token_usage_dialog ON token_usage (dialog_id);

-- Биллинг: один баланс на компанию (single-tenant), в токенах.
CREATE TABLE IF NOT EXISTS billing_account (
  id              INT PRIMARY KEY DEFAULT 1,
  balance_tokens  BIGINT NOT NULL DEFAULT 0,
  -- Цена для пересчёта в деньги (₽ за 1000 токенов). 0 — не задана.
  token_price_rub NUMERIC(12,4) NOT NULL DEFAULT 0,
  -- Останавливать бота при нулевом/отрицательном балансе.
  block_on_zero   BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO billing_account (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- Выписка: движения по балансу (списания за диалоги, пополнения, корректировки).
CREATE TABLE IF NOT EXISTS billing_transactions (
  id            SERIAL PRIMARY KEY,
  kind          TEXT NOT NULL,            -- debit | topup | invoice_paid | adjust
  tokens        BIGINT NOT NULL,          -- + пополнение, - списание
  description   TEXT,
  dialog_id     TEXT,
  balance_after BIGINT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_btx_created ON billing_transactions (created_at DESC);

-- Счета (на пополнение баланса токенами).
CREATE TABLE IF NOT EXISTS invoices (
  id          SERIAL PRIMARY KEY,
  number      TEXT,
  tokens      BIGINT NOT NULL,
  amount_rub  NUMERIC(12,2),
  status      TEXT NOT NULL DEFAULT 'issued',   -- issued | paid | cancelled
  note        TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  paid_at     TIMESTAMPTZ
);

-- Лог обработанных событий бота (для дедупликации по bx_message_id).
CREATE TABLE IF NOT EXISTS processed_events (
  bx_message_id BIGINT PRIMARY KEY,
  processed_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Курсор polling-а бота (на случай, если хотим хранить локально).
CREATE TABLE IF NOT EXISTS job_positions (
  id          SERIAL PRIMARY KEY,
  city        TEXT NOT NULL,
  category    TEXT NOT NULL,
  position    TEXT NOT NULL,
  is_offered  BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS bot_state (
  id          INT PRIMARY KEY DEFAULT 1,
  bot_id      BIGINT,
  last_offset BIGINT NOT NULL DEFAULT 0,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO bot_state (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
`;

const DEFAULT_PROMPT = `Ты — вежливый HR-ассистент компании, который общается с соискателями в чате открытой линии.
Твои задачи:
1. Поприветствовать соискателя и узнать, какая работа его интересует.
2. Собрать первичную информацию: имя, город, желаемая должность, опыт работы, ожидания по зарплате, удобный график, контактный телефон.
3. Предложить подходящие вакансии из списка ниже (только из него, ничего не выдумывай).
4. Отвечать кратко, дружелюбно, по-русски. Один вопрос за раз, не перегружай.
Если соискатель спрашивает о вакансии — дай детали из описания. Если данных в списке нет — честно скажи, что уточнишь у рекрутёра.`;

// Догоняющие миграции для уже существующих БД (идемпотентно).
const ALTERS = `
ALTER TABLE settings ADD COLUMN IF NOT EXISTS avito_client_id     TEXT NOT NULL DEFAULT '';
ALTER TABLE settings ADD COLUMN IF NOT EXISTS avito_client_secret TEXT NOT NULL DEFAULT '';
ALTER TABLE settings ADD COLUMN IF NOT EXISTS avito_user_id       TEXT NOT NULL DEFAULT '';
ALTER TABLE settings ADD COLUMN IF NOT EXISTS avito_only_vacancies BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS payer_name TEXT;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS payer_inn  TEXT;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS is_promised BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE settings ADD COLUMN IF NOT EXISTS hh_employer_id TEXT NOT NULL DEFAULT '';
ALTER TABLE settings ADD COLUMN IF NOT EXISTS hh_client_id TEXT NOT NULL DEFAULT '';
ALTER TABLE settings ADD COLUMN IF NOT EXISTS hh_client_secret TEXT NOT NULL DEFAULT '';
`;

export async function migrate() {
  await pool.query(SCHEMA);
  await pool.query(ALTERS);
  // Тариф по умолчанию: 1 ₽ за 1000 токенов (10 млн токенов = 10 000 ₽).
  await pool.query("UPDATE billing_account SET token_price_rub=1.0 WHERE id=1 AND token_price_rub=0")
  // Заполняем job_positions если пусто
  const { rowCount } = await pool.query('SELECT 1 FROM job_positions LIMIT 1');
  if (rowCount === 0) {
    const seeds = [
      // Ижевск — полный набор
      ['Ижевск','Рестораны ROSTIC\'S','Сотрудник ресторана',1,1],
      ['Ижевск','Рестораны ROSTIC\'S','Сотрудник зала',1,2],
      ['Ижевск','Рестораны ROSTIC\'S','Грузчик',1,3],
      ['Ижевск','Бильярд-клуб «Кино»','Повар',1,4],
      ['Ижевск','Офис компании','Офисные вакансии',1,5],
      ['Ижевск','Руководящие должности','Руководящие должности',1,6],
      // Остальные города — только рестораны
      ...['Глазов','Воткинск','Сарапул','Пермь','Наб. Челны','Нижнекамск','Альметьевск','Киров','Кирово-Чепецк'].flatMap((city,ci) => [
        [city,'Рестораны ROSTIC\'S','Сотрудник ресторана',1,ci*10+1],
        [city,'Рестораны ROSTIC\'S','Сотрудник зала',1,ci*10+2],
        [city,'Рестораны ROSTIC\'S','Грузчик',1,ci*10+3],
        [city,'Рестораны ROSTIC\'S','Руководящие должности',1,ci*10+4],
      ]),
    ];
    for (const [city,category,position,is_offered,sort_order] of seeds) {
      await pool.query(
        'INSERT INTO job_positions(city,category,position,is_offered,sort_order) VALUES($1,$2,$3,$4,$5)',
        [city,category,position,is_offered===1,sort_order]
      );
    }
    console.log('[db] job_positions seeded');
  }
;
  // Засеять дефолтный промпт, если промптов ещё нет.
  const { rows } = await pool.query('SELECT COUNT(*)::int AS c FROM prompts');
  if (rows[0].c === 0) {
    const ins = await pool.query(
      `INSERT INTO prompts (task_type, name, system_prompt, collect_fields, is_active)
       VALUES ($1,$2,$3,$4,TRUE) RETURNING id`,
      [
        'screening',
        'Первичный скрининг соискателя',
        DEFAULT_PROMPT,
        JSON.stringify([
          'full_name', 'phone', 'city', 'desired_position',
          'experience', 'salary_expectation', 'schedule',
        ]),
      ]
    );
    await pool.query('UPDATE settings SET active_prompt_id=$1 WHERE id=1', [ins.rows[0].id]);
  }
  console.log('[db] миграция выполнена');
}

export async function getSettings() {
  const { rows } = await pool.query('SELECT * FROM settings WHERE id=1');
  return rows[0];
}
