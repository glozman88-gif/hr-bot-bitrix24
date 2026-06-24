// Конфигурация окружения. Значения приходят из .env (записывается при деплое через env-поле).
export const config = {
  port: Number(process.env.PORT || 3000),

  // Базовый URL VibeCode API
  vibeBase: process.env.VIBE_BASE || 'https://vibecode.bitrix24.tech/v1',

  // Персональный API-ключ VibeCode (vibe_api_...). Используется backend-ом для:
  // bot-операций, CRM, AI Router. НЕ попадает в браузер.
  vibeApiKey: process.env.VIBE_API_KEY || '',

  // OAuth-приложение (для встраивания админки в Битрикс24 как placement).
  appKey: process.env.VIBE_APP_KEY || '',
  appId: process.env.APP_ID || '',

  // Публичный адрес приложения (app-XXX.vibecode.bitrix24.tech). Используется как
  // handler для placement и в ссылках. Заполняется после создания сервера.
  appUrl: process.env.APP_URL || '',

  // Подключение к PostgreSQL. БД/пользователь создаются скриптом setup-db.sh (preStart),
  // DATABASE_URL передаётся через env при деплое.
  databaseUrl: process.env.DATABASE_URL || process.env.PG_URL || '',

  // ID зарегистрированного бота. Если задан и в БД ещё пусто — запишется при старте.
  botId: process.env.BOT_ID ? Number(process.env.BOT_ID) : null,

  // Bitrix24 user id администратора биллинга (видит админ-панель пополнения/счетов).
  adminUserId: process.env.ADMIN_USER_ID || '154',

  // Ключи Авито из env (фолбэк/первичная инициализация; основное хранилище — settings).
  avitoClientId: process.env.AVITO_CLIENT_ID || '',
  avitoClientSecret: process.env.AVITO_CLIENT_SECRET || '',

  // T-Bank: сверка оплат через прокси-прослойку (migrator.lidkom.ru/tbank).
  // Нашему приложению нужен только URL прокси + общий секрет + номер счёта;
  // сам TBANK_TOKEN держит прокси.
  tbankProxyUrl: process.env.TBANK_PROXY_URL || '',
  tbankProxySecret: process.env.TBANK_PROXY_SECRET || '',
  tbankAccount: process.env.TBANK_ACCOUNT || '',
  tbankPollIntervalMs: Number(process.env.TBANK_POLL_INTERVAL_MS || 10 * 60 * 1000),

  // Пароль для входа в админ-часть приложения (кнопка в углу).
  adminPanelPassword: process.env.ADMIN_PANEL_PASSWORD || '',

  // Интервал опроса событий бота, мс
  botPollIntervalMs: Number(process.env.BOT_POLL_INTERVAL_MS || 3000),

  // Интервал парсинга Авито, мс (по умолчанию раз в 6 часов)
  avitoIntervalMs: Number(process.env.AVITO_INTERVAL_MS || 6 * 60 * 60 * 1000),

  // Сколько последних сообщений клиента держать в контексте
  contextWindow: Number(process.env.CONTEXT_WINDOW || 30),

  // Режим разработки — отключает фоновые воркеры, если нужно
  disableWorkers: process.env.DISABLE_WORKERS === '1',
};

export function assertConfig() {
  const missing = [];
  if (!config.databaseUrl) missing.push('DATABASE_URL');
  if (missing.length) {
    console.warn('[config] Отсутствуют переменные окружения:', missing.join(', '));
  }
  if (!config.vibeApiKey) {
    console.warn('[config] VIBE_API_KEY не задан — бот и CRM работать не будут до настройки.');
  }
}
