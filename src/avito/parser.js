// Парсер вакансий с Авито.
//
// ВНИМАНИЕ: Авито активно защищается от парсинга (JS-челлендж, файрвол, блокировка
// серверных IP). Этот парсер работает «как браузер»: реалистичные заголовки + извлечение
// встроенного в страницу JSON (window.__initialData__). Если Авито отдаёт challenge/HTML
// без данных — возвращаем понятную ошибку, и работают ручное добавление / повторная попытка.

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

function browserHeaders() {
  return {
    'User-Agent': UA,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'ru-RU,ru;q=0.9,en;q=0.8',
    'Cache-Control': 'no-cache',
    'Upgrade-Insecure-Requests': '1',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
  };
}

async function fetchHtml(url) {
  const res = await fetch(url, { headers: browserHeaders(), redirect: 'follow' });
  const html = await res.text();
  return { status: res.status, html };
}

// Достаём window.__initialData__ (URI-encoded JSON) либо JSON из тега __NEXT_DATA__.
function extractInitialData(html) {
  // 1) window.__initialData__ = "...";
  let m = html.match(/window\.__initialData__\s*=\s*"([^"]*)"/);
  if (m) {
    try { return JSON.parse(decodeURIComponent(m[1])); } catch {}
  }
  // 2) <script id="__NEXT_DATA__" ...>{...}</script>
  m = html.match(/<script[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (m) {
    try { return JSON.parse(m[1]); } catch {}
  }
  return null;
}

// Эвристика: похоже ли это на объект объявления.
function looksLikeListing(o) {
  if (!o || typeof o !== 'object') return false;
  const hasId = o.id != null || o.itemId != null;
  const hasTitle = typeof o.title === 'string' && o.title.length > 0;
  const hasUrl = typeof o.urlPath === 'string' || typeof o.url === 'string';
  return hasId && hasTitle && (hasUrl || o.priceDetailed || o.price);
}

// Рекурсивно собрать все объекты-объявления из дерева данных.
function collectListings(node, acc, seen) {
  if (!node || typeof node !== 'object') return;
  if (seen.has(node)) return;
  seen.add(node);
  if (Array.isArray(node)) {
    for (const v of node) collectListings(v, acc, seen);
    return;
  }
  if (looksLikeListing(node)) acc.push(node);
  for (const k of Object.keys(node)) collectListings(node[k], acc, seen);
}

function priceToText(o) {
  if (o.priceDetailed?.string) return o.priceDetailed.string;
  if (typeof o.priceDetailed?.value === 'number') return String(o.priceDetailed.value);
  if (o.normalizedPrice) return String(o.normalizedPrice);
  if (o.price?.string) return o.price.string;
  if (typeof o.price === 'number') return String(o.price);
  return '';
}

function normalizeListing(o) {
  const urlPath = o.urlPath || o.url || '';
  const url = urlPath.startsWith('http') ? urlPath : (urlPath ? `https://www.avito.ru${urlPath}` : '');
  return {
    external_id: String(o.id ?? o.itemId ?? ''),
    title: (o.title || '').trim(),
    url,
    salary: priceToText(o),
    location: (o.location?.name || o.geo?.formattedAddress || o.address || '').toString(),
    company: (o.company?.name || o.userType || '').toString(),
    description: (o.description || o.snippet?.text || '').toString(),
    raw: o,
  };
}

// Парсинг страницы со списком вакансий.
export async function parseAvitoListUrl(url) {
  const { status, html } = await fetchHtml(url);
  if (status !== 200) {
    throw new Error(`Авито вернул HTTP ${status}`);
  }
  // Признаки challenge/блокировки.
  if (/Доступ ограничен|вы не робот|captcha|firewall/i.test(html) && html.length < 60000) {
    throw new Error('Авито показал страницу защиты от ботов (challenge). Попробуйте позже или используйте ручное добавление.');
  }
  const data = extractInitialData(html);
  if (!data) {
    throw new Error('Не удалось извлечь данные со страницы Авито (структура изменилась или включена защита).');
  }
  const acc = [];
  collectListings(data, acc, new WeakSet());
  // Дедуп по external_id и фильтр пустых заголовков.
  const byId = new Map();
  for (const o of acc) {
    const n = normalizeListing(o);
    if (n.external_id && n.title && !byId.has(n.external_id)) byId.set(n.external_id, n);
  }
  return Array.from(byId.values());
}

// Догрузить описание конкретного объявления (со страницы объявления).
export async function fetchAvitoItemDescription(itemUrl) {
  try {
    const { status, html } = await fetchHtml(itemUrl);
    if (status !== 200) return '';
    const data = extractInitialData(html);
    if (!data) {
      // запасной вариант — meta description
      const m = html.match(/<meta[^>]*name="description"[^>]*content="([^"]*)"/i);
      return m ? m[1] : '';
    }
    const acc = [];
    collectListings(data, acc, new WeakSet());
    const withDesc = acc.find(o => typeof o.description === 'string' && o.description.length > 30);
    return withDesc ? withDesc.description : '';
  } catch {
    return '';
  }
}
