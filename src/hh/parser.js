// Парсер HH.ru — публичные страницы поиска, без OAuth
const HH_SEARCH = 'https://hh.ru/search/vacancy';
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml',
  'Accept-Language': 'ru-RU,ru;q=0.9',
};

// Извлечь текст из innerHTML (убирает теги, комментарии, &-сущности)
function innerText(html) {
  return html
    .replace(/<!--[\s\S]*?-->/g, '')   // убрать HTML-комментарии
    .replace(/<[^>]+>/g, '')           // убрать теги
    .replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>')
    .replace(/&quot;/g,'"').replace(/&#x27;/g,"'").replace(/&nbsp;/g,' ')
    .replace(/ /g,' ')            // неразрывный пробел
    .replace(/\s+/g,' ').trim();
}

// Достать первый span/div с data-qa="KEY" и вернуть его innerText
function extractByQa(html, qa) {
  const re = new RegExp(`data-qa="${qa}"[^>]*>([\\s\\S]{0,500}?)<\\/(?:span|div|a)>`, 'i');
  const m = html.match(re);
  return m ? innerText(m[1]) : '';
}

// href из data-qa="serp-item__title"
function extractHref(html) {
  const m = html.match(/data-qa="serp-item__title"[^>]*href="([^"]+)"/);
  if (m) return m[1];
  const m2 = html.match(/href="([^"]+)"[^>]*data-qa="serp-item__title"/);
  return m2 ? m2[1] : '';
}

// Зарплата: первый span с typography-label-1-regular после title
function parseSalary(cardHtml) {
  const m = cardHtml.match(/typography-label-1-regular[^>]*>([\s\S]{1,400}?)<\/span>/);
  return m ? innerText(m[1]) : '';
}

function parseCards(html) {
  const items = [];
  // Разбить на карточки по границам vacancy-card
  const cardRe = /id="(\d{6,})"[^>]*class="vacancy-card--/g;
  const positions = [];
  let m;
  while ((m = cardRe.exec(html)) !== null) {
    positions.push({ id: m[1], pos: m.index });
  }
  for (let i = 0; i < positions.length; i++) {
    const { id, pos } = positions[i];
    // Берём до следующей карточки или +8000 символов
    const end = i + 1 < positions.length ? positions[i+1].pos : pos + 8000;
    const card = html.slice(pos, end);

    const title    = extractByQa(card, 'serp-item__title-text');
    const href     = extractHref(card);
    const location = extractByQa(card, 'vacancy-serp__vacancy-address');
    const salary   = parseSalary(card);
    const company  = extractByQa(card, 'vacancy-serp__vacancy-employer');

    if (!title) continue;
    const url = href
      ? (href.startsWith('http') ? href.split('?')[0] : 'https://hh.ru' + href.split('?')[0])
      : `https://hh.ru/vacancy/${id}`;

    items.push({ external_id: id, title, url, salary, location, company });
  }
  return items;
}

function getMaxPage(html) {
  const nums = [...html.matchAll(/data-qa="pager-page"[^>]*>(\d+)/g)].map(m => parseInt(m[1]));
  return nums.length ? Math.max(...nums) : 1;
}

export async function parseHHEmployerVacancies(employerId) {
  const all = [];
  let page = 0;
  let maxPage = 1;
  const seenIds = new Set();
  do {
    const url = `${HH_SEARCH}?employer_id=${encodeURIComponent(employerId)}&per_page=20&page=${page}`;
    const resp = await fetch(url, { headers: HEADERS });
    if (!resp.ok) throw new Error(`HH парсер: HTTP ${resp.status} на странице ${page}`);
    const html = await resp.text();
    if (page === 0) maxPage = getMaxPage(html);
    const cards = parseCards(html);
    for (const c of cards) {
      if (!seenIds.has(c.external_id)) {
        seenIds.add(c.external_id);
        all.push(c);
      }
    }
    console.log(`[hh-parser] стр. ${page+1}/${maxPage}: +${cards.length}, итого ${all.length}`);
    page++;
    if (page < maxPage) await new Promise(r => setTimeout(r, 600));
  } while (page < maxPage && all.length < 2000);
  return all;
}
