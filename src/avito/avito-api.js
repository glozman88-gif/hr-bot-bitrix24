// Официальный API Авито (api.avito.ru, developers.avito.ru).
// Авторизация: OAuth client_credentials (client_id/client_secret из кабинета: Профиль → Настройки → API).
// Токен живёт ~24ч, кэшируем в памяти.
//
// Источники вакансий (объединяем для максимума данных):
//  - GET /core/v1/items        → id, title, price, url, address, category, status
//  - GET /job/v2/vacancies     → title, profession, companyName, businessArea, city, link (без id и без цены)
// Полного текста описания API не отдаёт — собираем описание из доступных полей + ссылка на Авито.

const BASE = 'https://api.avito.ru';
let tokenCache = { key: '', token: '', exp: 0 };

export async function getAvitoToken(clientId, clientSecret) {
  const cacheKey = clientId + ':' + clientSecret;
  if (tokenCache.key === cacheKey && tokenCache.token && tokenCache.exp > Date.now() + 60000) {
    return tokenCache.token;
  }
  const body = new URLSearchParams({
    grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret,
  });
  const res = await fetch(`${BASE}/token/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { throw new Error(`Авито /token: не JSON (HTTP ${res.status})`); }
  if (!res.ok || !json.access_token) {
    throw new Error(`Авито авторизация не удалась (HTTP ${res.status}): ${json.error_description || json.error || text.slice(0, 120)}`);
  }
  tokenCache = { key: cacheKey, token: json.access_token, exp: Date.now() + (Number(json.expires_in || 3600) * 1000) };
  return json.access_token;
}

async function apiGet(token, path) {
  const res = await fetch(`${BASE}${path}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { throw new Error(`Авито ${path}: не JSON (HTTP ${res.status})`); }
  if (!res.ok) {
    const msg = json.error?.message || json.error_description || json.message || text.slice(0, 160);
    throw new Error(`Авито ${path} → HTTP ${res.status}: ${msg}`);
  }
  return json;
}

// id объявления из ссылки вида .../vakansii/...._8163013824
function idFromLink(link) {
  const m = String(link || '').match(/_(\d+)(?:[/?#]|$)/);
  return m ? m[1] : '';
}

// Профильные данные вакансий из job/v2 → map по external_id.
async function fetchJobVacancies(token, maxPages = 20) {
  const map = new Map();
  for (let page = 1; page <= maxPages; page++) {
    let data;
    try { data = await apiGet(token, `/job/v2/vacancies?per_page=100&page=${page}`); }
    catch { break; }
    const arr = data.vacancies || [];
    if (!arr.length) break;
    for (const v of arr) {
      const id = idFromLink(v.link);
      if (id) map.set(id, v);
    }
    if (arr.length < 100) break;
  }
  return map;
}

// Список объявлений-вакансий аккаунта (объединённые данные).
export async function listAvitoVacancies(token, { onlyVacancies = true, maxPages = 20 } = {}) {
  // 1) База — core/v1/items (есть id, цена, url, адрес).
  const base = [];
  for (let page = 1; page <= maxPages; page++) {
    const data = await apiGet(token, `/core/v1/items?per_page=100&page=${page}&status=active`);
    const resources = data.resources || [];
    if (!resources.length) break;
    for (const r of resources) {
      const catName = (r.category?.name || '').toString();
      if (onlyVacancies && catName && !/вакан/i.test(catName)) continue;
      base.push(r);
    }
    if (resources.length < 100) break;
  }
  // 2) Обогащение — job/v2 (компания, профессия, сфера, город).
  let jobMap = new Map();
  try { jobMap = await fetchJobVacancies(token); } catch { /* не критично */ }

  return base.map((r) => normalizeAvitoItem(r, jobMap.get(String(r.id))));
}

// Нормализация в нашу запись вакансии.
export function normalizeAvitoItem(r, job) {
  const j = job || {};
  const price = r.price;
  const salary = price != null && price !== '' ? `${price} ₽` : '';
  const city = j.addressDetails?.city || '';
  const address = j.addressDetails?.address || r.address || '';
  const company = j.companyName || '';
  const profession = j.profession || '';
  const businessArea = j.businessArea || '';
  const url = r.url || j.link || (r.id ? `https://www.avito.ru/items/${r.id}` : '');

  // Описание собираем из доступных полей (полный текст — на Авито по ссылке).
  const parts = [];
  if (profession) parts.push(`Профессия: ${profession}`);
  if (company) parts.push(`Компания: ${company}`);
  if (businessArea) parts.push(`Сфера: ${businessArea}`);
  if (address) parts.push(`Адрес: ${address}`);
  if (salary) parts.push(`Зарплата (Авито): ${salary}`);
  if (url) parts.push(`Полное описание на Авито: ${url}`);
  const description = parts.join('\n');

  return {
    external_id: String(r.id ?? ''),
    title: (r.title || j.title || '').toString().trim(),
    url,
    salary,
    location: city || address,
    company,
    description,
    raw: { core: r, job: job || null },
  };
}
