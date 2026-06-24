import express from 'express';
import { fileURLToPath } from 'url';
import fs from 'fs';
import path from 'path';
import { config, assertConfig } from './src/config.js';
import { migrate } from './src/db.js';
import { adminRouter } from './src/admin/api.js';
import { startPoller, setBotId } from './src/bot/poller.js';
import { query } from './src/db.js';
import { startAvitoScheduler } from './src/avito/scheduler.js';
import { startHHScheduler } from './src/hh/scheduler.js';
import { startTbankScheduler } from './src/billing/tbank.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '2mb' }));

// Healthcheck для деплоя (healthPath=/health).
app.get('/health', (req, res) => res.json({ ok: true, ts: Date.now() }));

// Публичная мини-конфигурация для SPA (без секретов).
app.get('/public-config', (req, res) => {
  res.json({ appUrl: config.appUrl, hasApiKey: !!config.vibeApiKey });
});

// Админ-API (защищён BFF-аутентификацией).
app.use('/api', adminRouter);

// Статика SPA (index отдаём сами — с инжекцией токена сессии).
app.use(express.static(path.join(__dirname, 'public'), { index: false }));

// Отдаём SPA с захваченным токеном сессии.
// На ПЕРВОЙ загрузке gateway инжектит X-Vibe-Authorization (cookie ещё валидна в цепочке
// редиректа placement). Вшиваем токен в HTML → SPA шлёт его в заголовке X-App-Session на
// каждый /api запрос, не завися от сторонних cookie (которые браузер режет в iframe Б24).
const INDEX_HTML = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
function serveSpa(req, res) {
  const xva = req.get('x-vibe-authorization') || '';
  const token = xva.replace(/^Bearer\s+/i, '').trim();
  const inject = `<script>window.__VIBE_SESSION=${JSON.stringify(token)};</script>`;
  res.set('Cache-Control', 'no-store');
  res.type('html').send(INDEX_HTML.replace('</head>', inject + '</head>'));
}
app.get('/', serveSpa);
app.get('*', serveSpa);

async function main() {
  assertConfig();
  try {
    await migrate();
    // Если BOT_ID задан через env, а в БД ещё пусто — записываем.
    if (config.botId) {
      const { rows } = await query('SELECT bot_id FROM bot_state WHERE id=1');
      if (!rows[0]?.bot_id) { await setBotId(config.botId); console.log('[server] bot_id установлен из env:', config.botId); }
    }
    // Засев ключей Авито из env, если в настройках ещё пусто.
    if (config.avitoClientId && config.avitoClientSecret) {
      const { rows } = await query('SELECT avito_client_id FROM settings WHERE id=1');
      if (!rows[0]?.avito_client_id) {
        await query('UPDATE settings SET avito_client_id=$1, avito_client_secret=$2 WHERE id=1',
          [config.avitoClientId, config.avitoClientSecret]);
        console.log('[server] ключи Авито установлены из env');
      }
    }
  } catch (e) {
    console.error('[server] миграция БД не удалась:', e.message);
  }

  app.listen(config.port, () => {
    console.log(`[server] слушаю на :${config.port}`);
  });

  // Фоновые воркеры.
  startPoller();
  startAvitoScheduler();
  startHHScheduler();
  startTbankScheduler();
}

main().catch((e) => {
  console.error('[server] фатальная ошибка запуска:', e);
  process.exit(1);
});
