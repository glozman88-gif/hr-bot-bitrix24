import { config } from '../config.js';
import { query, getSettings } from '../db.js';
import { parseAvitoListUrl, fetchAvitoItemDescription } from './parser.js';
import { getAvitoToken, listAvitoVacancies } from './avito-api.js';

let timer = null;
let lastRun = { at: null, ok: false, found: 0, upserted: 0, errors: [] };

export function getLastAvitoRun() {
  return lastRun;
}

// Сохранить (upsert) вакансию. Новые вакансии по умолчанию НЕ предлагаются (is_offered=false),
// чтобы рекрутёр сам отметил галочками нужные.
async function upsertVacancy(v) {
  const res = await query(
    `INSERT INTO vacancies (source, external_id, title, description, url, salary, location, company, raw, is_active, parsed_at, updated_at)
     VALUES ('avito',$1,$2,$3,$4,$5,$6,$7,$8,TRUE, now(), now())
     ON CONFLICT (source, external_id) DO UPDATE SET
       title=EXCLUDED.title,
       description=CASE WHEN EXCLUDED.description <> '' THEN EXCLUDED.description ELSE vacancies.description END,
       url=EXCLUDED.url, salary=EXCLUDED.salary, location=EXCLUDED.location,
       company=EXCLUDED.company, raw=EXCLUDED.raw, is_active=TRUE,
       parsed_at=now(), updated_at=now()
     RETURNING (xmax = 0) AS inserted`,
    [v.external_id, v.title, v.description || '', v.url, v.salary, v.location, v.company, JSON.stringify(v.raw || {})]
  );
  return res.rows[0]?.inserted;
}

// Один прогон синхронизации вакансий.
// Приоритет — официальный API Авито (если заданы client_id/secret). Иначе — URL-скрейп (фолбэк).
export async function runAvitoSync({ withDescriptions = true } = {}) {
  const settings = await getSettings();
  const result = { at: new Date().toISOString(), ok: true, found: 0, upserted: 0, errors: [], mode: '' };
  const seenExternalIds = new Set();

  // Ключи: из настроек, иначе из env (config) как фолбэк.
  const clientId = settings.avito_client_id || config.avitoClientId;
  const clientSecret = settings.avito_client_secret || config.avitoClientSecret;
  const hasApi = clientId && clientSecret;
  if (hasApi) {
    result.mode = 'api';
    try {
      const token = await getAvitoToken(clientId, clientSecret);
      const items = await listAvitoVacancies(token, { onlyVacancies: settings.avito_only_vacancies !== false });
      result.found = items.length;
      for (const v of items) {
        if (!v.external_id || !v.title) continue;
        seenExternalIds.add(v.external_id);
        const inserted = await upsertVacancy(v);
        if (inserted) result.upserted++;
      }
    } catch (e) {
      result.ok = false;
      result.errors.push(`API: ${e.message}`);
    }
  } else {
    result.mode = 'scrape';
    const sources = Array.isArray(settings.avito_sources) ? settings.avito_sources : [];
    if (!sources.length) {
      result.ok = false;
      result.errors.push('Не заданы ни ключи API Авито (client_id/secret), ни URL-источники');
      lastRun = result;
      return result;
    }
    for (const src of sources) {
      const url = typeof src === 'string' ? src : src.url;
      if (!url) continue;
      try {
        const listings = await parseAvitoListUrl(url);
        result.found += listings.length;
        for (const v of listings) {
          seenExternalIds.add(v.external_id);
          if (withDescriptions && (!v.description || v.description.length < 30) && v.url) {
            v.description = await fetchAvitoItemDescription(v.url);
            await new Promise(r => setTimeout(r, 800));
          }
          const inserted = await upsertVacancy(v);
          if (inserted) result.upserted++;
        }
      } catch (e) {
        result.ok = false;
        result.errors.push(`${url}: ${e.message}`);
      }
    }
  }

  // Пометить пропавшие avito-вакансии неактивными (но не удаляем — сохраняем историю).
  if (seenExternalIds.size) {
    await query(
      `UPDATE vacancies SET is_active=FALSE, updated_at=now()
       WHERE source='avito' AND is_active=TRUE AND NOT (external_id = ANY($1))`,
      [Array.from(seenExternalIds)]
    );
  }

  lastRun = result;
  console.log(`[avito] синхронизация (${result.mode}): найдено ${result.found}, новых ${result.upserted}, ok=${result.ok}${result.errors.length ? ', ошибки: ' + result.errors.join(' | ') : ''}`);
  return result;
}

export function startAvitoScheduler() {
  if (config.disableWorkers) return;
  console.log('[avito] планировщик, интервал', Math.round(config.avitoIntervalMs / 60000), 'мин');
  const loop = async () => {
    try {
      const settings = await getSettings();
      const hasApi = (settings.avito_client_id || config.avitoClientId) && (settings.avito_client_secret || config.avitoClientSecret);
      const hasUrls = Array.isArray(settings.avito_sources) && settings.avito_sources.length;
      if (hasApi || hasUrls) {
        await runAvitoSync();
      }
    } catch (e) {
      console.error('[avito] ошибка планировщика:', e.message);
    } finally {
      timer = setTimeout(loop, config.avitoIntervalMs);
    }
  };
  // Первый прогон через минуту после старта, чтобы не блокировать запуск.
  timer = setTimeout(loop, 60 * 1000);
}

export function stopAvitoScheduler() {
  if (timer) clearTimeout(timer);
}
