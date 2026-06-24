// HeadHunter.ru API с поддержкой OAuth (client_credentials)
// Без токена HH блокирует запросы с серверных IP (403 forbidden)
const HH_API = 'https://api.hh.ru';
const HH_TOKEN_URL = 'https://hh.ru/oauth/token';

const HH_HEADERS = (token) => ({
  'User-Agent': 'hr-bot/1.0 (gkfs.bitrix24.ru)',
  'HH-User-Agent': 'hr-bot/1.0 (gkfs.bitrix24.ru)',
  'Accept': 'application/json',
  'Accept-Language': 'ru-RU,ru;q=0.9',
  ...(token ? { 'Authorization': 'Bearer ' + token } : {}),
});

// Кэш токена — живёт 12 часов (HH выдаёт на 14 дней, обновляем заранее)
let _tokenCache = { token: null, expiresAt: 0 };

/**
 * Получить access_token через client_credentials.
 * Требует регистрации приложения на dev.hh.ru
 */
export async function getHHToken(clientId, clientSecret) {
  if (_tokenCache.token && Date.now() < _tokenCache.expiresAt) {
    return _tokenCache.token;
  }
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: clientId,
    client_secret: clientSecret,
  });
  const resp = await fetch(HH_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'hr-bot/1.0 (gkfs.bitrix24.ru)',
    },
    body: body.toString(),
  });
  if (!resp.ok) {
    const txt = await resp.text().catch(() => '');
    throw new Error(`HH OAuth ${resp.status}: ${txt.slice(0, 200)}`);
  }
  const data = await resp.json();
  const token = data.access_token;
  if (!token) throw new Error('HH OAuth: access_token не получен: ' + JSON.stringify(data));
  // expires_in в секундах, кэшируем на 12 часов или меньше
  const ttlMs = Math.min((data.expires_in || 86400) * 1000, 12 * 60 * 60 * 1000);
  _tokenCache = { token, expiresAt: Date.now() + ttlMs };
  return token;
}

/**
 * Возвращает все активные вакансии работодателя по его HH employer_id.
 * clientId/clientSecret — опциональные OAuth-ключи (рекомендуется).
 * Без ключей пробует публичный доступ, но серверные IP часто блокируются.
 */
export async function listHHVacancies(employerId, clientId, clientSecret) {
  let token = null;
  if (clientId && clientSecret) {
    token = await getHHToken(clientId, clientSecret);
  }

  const all = [];
  let page = 0;
  let pages = 1;
  do {
    const url = `${HH_API}/vacancies?employer_id=${encodeURIComponent(employerId)}&per_page=100&page=${page}`;
    const resp = await fetch(url, { headers: HH_HEADERS(token) });
    if (!resp.ok) {
      const txt = await resp.text().catch(() => '');
      throw new Error(`HH API ${resp.status}: ${txt.slice(0, 300)}`);
    }
    const data = await resp.json();
    pages = data.pages ?? 1;
    for (const item of (data.items ?? [])) {
      all.push(normalizeHHItem(item));
    }
    page++;
  } while (page < pages && all.length < 2000);
  return all;
}

function normalizeHHItem(item) {
  return {
    external_id: String(item.id),
    title: item.name || '',
    url: item.alternate_url || '',
    salary: formatSalary(item.salary),
    location: item.area?.name || '',
    company: item.employer?.name || '',
    description: buildDescription(item),
    raw: item,
  };
}

function formatSalary(s) {
  if (!s) return '';
  const parts = [];
  if (s.from) parts.push('от ' + Number(s.from).toLocaleString('ru'));
  if (s.to)   parts.push('до ' + Number(s.to).toLocaleString('ru'));
  if (!parts.length) return '';
  const cur = s.currency === 'RUR' ? '₽' : (s.currency || '');
  const gross = s.gross ? ' (до вычета налогов)' : '';
  return parts.join(' ') + (cur ? ' ' + cur : '') + gross;
}

function buildDescription(item) {
  const parts = [];
  if (item.snippet?.requirement)
    parts.push('Требования: ' + stripHtml(item.snippet.requirement));
  if (item.snippet?.responsibility)
    parts.push('Обязанности: ' + stripHtml(item.snippet.responsibility));
  if (item.alternate_url)
    parts.push('\nПодробнее: ' + item.alternate_url);
  return parts.filter(Boolean).join('\n');
}

function stripHtml(s) {
  return (s || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}
