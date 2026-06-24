import { config } from '../config.js';
import { query, getSettings } from '../db.js';
import { parseHHEmployerVacancies } from './parser.js';

let timer = null;
let lastRun = { at: null, ok: false, found: 0, upserted: 0, errors: [] };

export function getLastHHRun() {
  return lastRun;
}

async function upsertHHVacancy(v) {
  const res = await query(
    `INSERT INTO vacancies (source, external_id, title, description, url, salary, location, company, raw, is_active, is_offered, parsed_at, updated_at)
     VALUES ('hh',$1,$2,$3,$4,$5,$6,$7,$8,TRUE,TRUE,now(),now())
     ON CONFLICT (source, external_id) DO UPDATE SET
       title=EXCLUDED.title,
       description=CASE WHEN EXCLUDED.description <> '' THEN EXCLUDED.description ELSE vacancies.description END,
       url=EXCLUDED.url, salary=EXCLUDED.salary, location=EXCLUDED.location,
       company=EXCLUDED.company, raw=EXCLUDED.raw, is_active=TRUE,
       parsed_at=now(), updated_at=now()
     RETURNING (xmax = 0) AS inserted`,
    [v.external_id, v.title, v.description || '', v.url || '',
     v.salary || '', v.location || '', v.company || '', JSON.stringify(v.raw || {})]
  );
  return res.rows[0]?.inserted;
}

export async function runHHSync() {
  const settings = await getSettings();
  const employerId = settings.hh_employer_id;
  const result = { at: new Date().toISOString(), ok: true, found: 0, upserted: 0, errors: [], mode: 'scrape' };

  if (!employerId) {
    result.ok = false;
    result.errors.push('hh_employer_id не задан в настройках');
    lastRun = result;
    return result;
  }

  const seenIds = new Set();
  try {
    const items = await parseHHEmployerVacancies(employerId);
    result.found = items.length;
    for (const v of items) {
      if (!v.external_id || !v.title) continue;
      seenIds.add(v.external_id);
      const inserted = await upsertHHVacancy(v);
      if (inserted) result.upserted++;
    }
  } catch (e) {
    result.ok = false;
    result.errors.push(e.message);
  }

  // Помечаем пропавшие вакансии неактивными
  if (seenIds.size) {
    await query(
      `UPDATE vacancies SET is_active=FALSE, updated_at=now()
       WHERE source='hh' AND is_active=TRUE AND NOT (external_id = ANY($1))`,
      [Array.from(seenIds)]
    );
  }

  lastRun = result;
  console.log(`[hh] синхронизация (${result.mode}): найдено ${result.found}, новых ${result.upserted}, ok=${result.ok}${result.errors.length ? ', ошибки: ' + result.errors.join(' | ') : ''}`);
  return result;
}

export function startHHScheduler() {
  if (config.disableWorkers) return;
  console.log('[hh] планировщик, интервал', Math.round(config.avitoIntervalMs / 60000), 'мин');
  const loop = async () => {
    try {
      const settings = await getSettings();
      if (settings.hh_employer_id) await runHHSync();
    } catch (e) {
      console.error('[hh] ошибка планировщика:', e.message);
    } finally {
      timer = setTimeout(loop, config.avitoIntervalMs);
    }
  };
  timer = setTimeout(loop, 90 * 1000);
}

export function stopHHScheduler() {
  if (timer) clearTimeout(timer);
}
