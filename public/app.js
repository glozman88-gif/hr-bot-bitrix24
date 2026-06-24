// ─── Тема (светлая / тёмная) ──────────────────────────────────────────
(function initTheme() {
  const saved = localStorage.getItem('theme') || 'light';
  document.documentElement.setAttribute('data-theme', saved);
  const updateBtn = () => {
    const btn = document.getElementById('themeToggle');
    if (btn) btn.textContent = document.documentElement.getAttribute('data-theme') === 'dark' ? '☀️' : '🌙';
  };
  document.addEventListener('DOMContentLoaded', () => {
    updateBtn();
    const btn = document.getElementById('themeToggle');
    if (btn) btn.onclick = () => {
      const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', next);
      localStorage.setItem('theme', next);
      updateBtn();
    };
  });
})();

'use strict';

// ───────── Сессия ─────────
// Токен сессии вшивается сервером в HTML при первой загрузке (window.__VIBE_SESSION),
// сохраняем его на время вкладки и шлём в заголовке X-App-Session — не зависим от
// сторонних cookie, которые браузер блокирует в iframe Битрикс24.
let VIBE_SESSION = '';
try {
  VIBE_SESSION = window.__VIBE_SESSION || sessionStorage.getItem('vibe_session') || '';
  if (window.__VIBE_SESSION) sessionStorage.setItem('vibe_session', window.__VIBE_SESSION);
} catch { VIBE_SESSION = window.__VIBE_SESSION || ''; }

// ───────── API helper ─────────
function adminPass() { try { return sessionStorage.getItem('admin_pass') || ''; } catch { return ''; } }
async function api(method, path, body) {
  const opts = { method, credentials: 'include', headers: {} };
  if (VIBE_SESSION) opts.headers['X-App-Session'] = 'Bearer ' + VIBE_SESSION;
  const ap = adminPass();
  if (ap) opts.headers['X-Admin-Pass'] = ap;
  if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  const res = await fetch('/api' + path, opts);
  if (res.status === 401) { throw { auth: true, message: 'Не авторизовано. Откройте приложение внутри Битрикс24.' }; }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw { message: data.message || data.error || ('HTTP ' + res.status) };
  return data;
}

// ───────── helpers ─────────
const $ = (sel, el = document) => el.querySelector(sel);
const esc = (s) => (s == null ? '' : String(s)).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
function toast(msg, isErr) {
  const t = $('#toast'); t.textContent = msg; t.className = 'toast' + (isErr ? ' err' : '');
  setTimeout(() => t.classList.add('hidden'), 2600);
}
function modal(html) { $('#modal-body').innerHTML = html; $('#modal').classList.remove('hidden'); }
function closeModal() { $('#modal').classList.add('hidden'); }
window.closeModal = closeModal;

const view = () => $('#view');
function authBanner(message) {
  view().innerHTML = `<div class="banner err"><b>Нет доступа.</b> ${esc(message)}<br>
   Это приложение работает внутри Битрикс24 (раздел «Приложения»). Для локальной отладки передайте заголовок <code>X-Admin-Token</code>.</div>`;
}

// ───────── routing ─────────
const tabs = {};
function registerTab(name, fn) { tabs[name] = fn; }
async function openTab(name) {
  if (typeof renewSession === 'function') renewSession();   // продлить сессию при навигации
  document.querySelectorAll('.tabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
  view().innerHTML = '<div class="loading">Загрузка…</div>';
  try { await tabs[name](); }
  catch (e) { if (e.auth) authBanner(e.message); else view().innerHTML = `<div class="banner err">Ошибка: ${esc(e.message)}</div>`; }
}
document.querySelectorAll('.tabs button').forEach(b => b.onclick = () => openTab(b.dataset.tab));

// ───────── Dashboard ─────────
registerTab('dashboard', async () => {
  const { settings, bot } = await api('GET', '/settings');
  const stats = await api('GET', '/stats');
  const av = stats.avito || {};
  const botOn = settings.bot_enabled;
  view().innerHTML = `
    <div class="stat-grid">
      <div class="stat"><div class="n">${stats.vacancies.active}</div><div class="l">активных вакансий</div></div>
      <div class="stat"><div class="n">${stats.candidates}</div><div class="l">соискателей</div></div>
      <div class="stat"><div class="n">${stats.dialogs}</div><div class="l">диалогов</div></div>
    </div>
    <div class="card">
      <h3>Состояние</h3>
      <p>Бот: <span class="pill ${botOn ? 'on' : 'off'}">${botOn ? 'включён' : 'выключен'}</span>
         &nbsp; ID бота: <code>${bot && bot.bot_id ? bot.bot_id : 'не зарегистрирован'}</code></p>
      <p>CRM-обновление сделок: <span class="pill ${settings.crm_update_enabled ? 'on' : 'off'}">${settings.crm_update_enabled ? 'вкл' : 'выкл'}</span></p>
      <p>Парсинг Авито: ${av.at ? `последний запуск ${new Date(av.at).toLocaleString('ru')} — ${av.ok ? '<span class="pill on">успех</span>' : '<span class="pill warn">с ошибками</span>'}, найдено ${av.found || 0}, новых ${av.upserted || 0}` : 'ещё не запускался'}
        ${av.errors && av.errors.length ? `<div class="hint">${av.errors.map(esc).join('<br>')}</div>` : ''}</p>
    </div>`;
});

// ───────── Vacancies ─────────
registerTab('_vacancies_disabled', async () => {
  view().innerHTML = `
    <div class="card">
      <div class="toolbar">
        <input type="text" id="vq" placeholder="Поиск по названию/описанию…" />
        <label class="switch sm"><input type="checkbox" id="vonly"/> только предлагаемые</label>
        <button class="btn sec sm" id="vrefresh">Обновить</button>
        <div class="right"></div>
        <button class="btn ok sm" id="vsync">⟳ Парсить Авито сейчас</button>
        <button class="btn sm" id="vadd">+ Добавить вручную</button>
      </div>
      <div class="toolbar">
        <span class="hint">Отметьте чекбокс «Предлагать» у нужных вакансий — бот предлагает только их. Массово для всех показанных:</span>
        <button class="btn sec sm" id="voffer">✓ Предлагать все показанные</button>
        <button class="btn sec sm" id="vunoffer">✕ Снять все показанные</button>
      </div>
      <div id="vtable"></div>
    </div>`;
  let shownIds = [];
  const load = async () => {
    const q = $('#vq').value.trim();
    const only = $('#vonly').checked;
    const { vacancies } = await api('GET', '/vacancies?active=true&source_ne=hh' + (only ? '&offered=true' : '') + (q ? '&q=' + encodeURIComponent(q) : ''));
    shownIds = vacancies.map(v => v.id);
    $('#vtable').innerHTML = renderVacTable(vacancies, { group: true });
  };
  window.__vacBulk = async (on) => {
    if (!shownIds.length) return toast('Список пуст', true);
    await api('POST', '/vacancies/bulk-offer', { ids: shownIds, is_offered: on });
    toast(`Обновлено: ${shownIds.length}`); load();
  };
  $('#vrefresh').onclick = load;
  $('#vq').onkeydown = (e) => { if (e.key === 'Enter') load(); };
  $('#vonly').onchange = load;
  $('#vsync').onclick = async () => {
    toast('Запускаю парсинг Авито…');
    try { const { result } = await api('POST', '/avito/sync', {}); toast(result.ok ? `Готово: найдено ${result.found}, новых ${result.upserted}` : 'Парсинг с ошибками: ' + (result.errors[0] || ''), !result.ok); load(); }
    catch (e) { toast(e.message, true); }
  };
  $('#vadd').onclick = () => vacancyForm();
  $('#voffer').onclick = () => window.__vacBulk(true);
  $('#vunoffer').onclick = () => window.__vacBulk(false);
  await load();
});


// ─── Helpers для группировки вакансий Авито ────────────────────────────────
function cleanVacTitle(title) {
  return title
    .replace(/\s*\([^)]*\)/g, '')              // сначала убрать всё в скобках
    .replace(/\s*в\s+Rostic[''s]+\b.*/i, '')   // убрать "в Rostic's..."
    .replace(/\s+Rostic[''s]\b.*/i, '')         // убрать "Rostic's..."
    .replace(/\s*Ростикс\b.*/gi, '')            // убрать "Ростикс..."
    .replace(/\s+в\s+ресторан[еа]?\b.*/i, '')  // убрать "в ресторане..."
    .replace(/\s+ресторана?\b/i, '')            // убрать "ресторана"
    .replace(/\s+работа\b/gi, '')              // убрать "работа"
    .replace(/\s+на\s+лето\b/gi, '')           // убрать "на лето"
    .replace(/\s+/g, ' ').trim();
}
function extractCity(loc) {
  if (!loc) return '';
  const skip = /обл\.|край|Республ|р-н|мун\.|муниц|округ|г\.о\.|ский\s+р|Татарс|Удмурт|Пермск|Кировск|Марий/i;
  for (const p of loc.split(', ')) { if (!skip.test(p)) return p.trim(); }
  return '';
}
function extractRestaurant(title, loc) {
  // Всегда берём адрес из поля location — это надёжнее, чем парсить скобки
  if (!loc) return '';
  const skip = /обл\.|край|Республ|р-н|мун\.|муниц|округ|г\.о\.|ский\s+р|Татарс|Удмурт|Пермск|Кировск|Марий/i;
  const parts = loc.split(', ');
  let citySkipped = false;
  const rest = [];
  for (const p of parts) {
    if (skip.test(p)) continue;
    if (!citySkipped) { citySkipped = true; continue; }
    rest.push(p);
  }
  return rest.join(', ');
}
function fmtSalary(s) {
  if (!s) return '';
  const n = parseInt((s||'').replace(/\D/g,''));
  if (n > 0 && n < 1000) return s + ' в час';
  return s;
}
function groupVacancies(vacancies) {
  const map = new Map();
  for (const v of vacancies) {
    const ct = cleanVacTitle(v.title) || v.title;
    const key = ct.toLowerCase().replace(/\s+/g,' ');
    if (!map.has(key)) {
      map.set(key, { ...v, title: ct, _ids: [], _citySet: new Set(), _cities: [], _restaurants: [], is_offered: false });
    }
    const g = map.get(key);
    g._ids.push(v.id);
    if (v.is_offered) g.is_offered = true;
    const city = extractCity(v.location || '');
    const restaurant = extractRestaurant(v.title, v.location || '');
    // Города — только уникальные
    if (city && !g._citySet.has(city)) { g._citySet.add(city); g._cities.push(city); }
    if (restaurant) g._restaurants.push(restaurant);
  }
  return [...map.values()].map(g => ({
    ...g,
    location: g._cities.join('\n'),
    company:  g._restaurants.join('\n'),
    // salary не трогаем — fmtSalary вызывается один раз в renderVacTable
  }));
}
// ───────────────────────────────────────────────────────────────────────────

function renderVacTable(vacancies, opts = {}) {
  if (opts.group) vacancies = groupVacancies(vacancies);
  if (!vacancies.length) return '<p class="muted">Вакансий нет. Проверьте ключи Авито в Настройках или добавьте вручную.</p>';
  const offered = vacancies.filter(v => v.is_offered).length;
  const total = vacancies.length;
  const compCol = opts.group ? 'Рестораны' : 'Компания';
  return `<div style="margin-bottom:8px"><span class="hint">Всего вакансий: <b>${total}</b> &nbsp;·&nbsp; Предлагаем боту: <b>${offered}</b> из <b>${total}</b></span></div>
  <table><thead><tr>
    <th style="width:140px">Предлагать (${offered}/${total})</th><th>Название</th><th>Зарплата</th><th>Город</th><th>${compCol}</th>
    </tr></thead><tbody>${vacancies.map(v => `
    <tr>
      <td><label class="switch"><input type="checkbox" ${v.is_offered ? 'checked' : ''} onchange="toggleOffer(${JSON.stringify(v._ids||[v.id])}, this.checked); this.nextElementSibling.textContent=this.checked?'да':'нет'"> <span class="hint">${v.is_offered ? 'да' : 'нет'}</span></label></td>
      <td><a href="#" onclick="showVacancy(${v._ids?v._ids[0]:v.id});return false">${esc(v.title)}</a></td>
      <td class="nowrap">${esc(opts.group ? fmtSalary(v.salary) : v.salary || '')}</td>
      <td style="white-space:pre-line">${esc(v.location || '')}</td>
      <td style="white-space:pre-line">${esc(v.company || '')}</td>
    </tr>`).join('')}</tbody></table>`;
}
async function toggleOffer(ids, on) {
  try {
    const arr = Array.isArray(ids) ? ids : [ids];
    await Promise.all(arr.map(id => api('PATCH', '/vacancies/' + id, { is_offered: on })));
    toast(on ? 'Будут предлагаться' : 'Снято');
  } catch (e) { toast(e.message, true); }
}
window.toggleOffer = toggleOffer;
async function showVacancy(id) {
  const { vacancy: v } = await api('GET', '/vacancies/' + id);
  modal(`<h3>${esc(v.title)}</h3>
    <p class="muted">${esc(v.salary || '')} ${v.location ? '· ' + esc(v.location) : ''} ${v.company ? '· ' + esc(v.company) : ''}</p>
    ${v.url ? `<p><a href="${esc(v.url)}" target="_blank" rel="noopener">Открыть на источнике ↗</a></p>` : ''}
    <label class="checkbox"><input type="checkbox" ${v.is_offered ? 'checked' : ''} onchange="toggleOffer(${v.id}, this.checked)"> Предлагать соискателям</label>
    <h4>Описание</h4>
    <div class="desc">${esc(v.description || '— описание отсутствует —')}</div>
    <div class="row" style="margin-top:16px">
      <button class="btn sec" onclick='editVacancy(${JSON.stringify(v).replace(/'/g, "&#39;")})'>Редактировать</button>
      <button class="btn sec" onclick="closeModal()">Закрыть</button>
    </div>`);
}
window.showVacancy = showVacancy;
function vacancyForm(v) {
  v = v || {};
  modal(`<h3>${v.id ? 'Редактировать' : 'Добавить'} вакансию</h3>
    <label>Название</label><input type="text" id="f_title" value="${esc(v.title || '')}">
    <label>Зарплата</label><input type="text" id="f_salary" value="${esc(v.salary || '')}">
    <label>Город</label><input type="text" id="f_location" value="${esc(v.location || '')}">
    <label>Компания</label><input type="text" id="f_company" value="${esc(v.company || '')}">
    <label>Ссылка</label><input type="text" id="f_url" value="${esc(v.url || '')}">
    <label>Описание</label><textarea id="f_desc">${esc(v.description || '')}</textarea>
    <label class="checkbox"><input type="checkbox" id="f_offer" ${v.is_offered ? 'checked' : ''}> Предлагать соискателям</label>
    <div class="row" style="margin-top:16px">
      <button class="btn" id="f_save">Сохранить</button>
      <button class="btn sec" onclick="closeModal()">Отмена</button>
    </div>`);
  $('#f_save').onclick = async () => {
    const payload = {
      title: $('#f_title').value.trim(), salary: $('#f_salary').value.trim(),
      location: $('#f_location').value.trim(), company: $('#f_company').value.trim(),
      url: $('#f_url').value.trim(), description: $('#f_desc').value, is_offered: $('#f_offer').checked,
    };
    if (!payload.title) return toast('Укажите название', true);
    try {
      if (v.id) await api('PATCH', '/vacancies/' + v.id, payload);
      else await api('POST', '/vacancies', payload);
      toast('Сохранено'); closeModal(); openTab('vacancies');
    } catch (e) { toast(e.message, true); }
  };
}
window.editVacancy = (v) => vacancyForm(v);
async function delVacancy(id) {
  if (!confirm('Удалить вакансию?')) return;
  await api('DELETE', '/vacancies/' + id); toast('Удалено'); openTab('vacancies');
}
window.delVacancy = delVacancy;

// ───────── Prompts ─────────

// ─────────── Vacancies HH ───────────
registerTab('_vacancies_hh_disabled', async () => {
  view().innerHTML = `
    <div class="card">
      <div class="toolbar">
        <input type="text" id="hhq" placeholder="Поиск по названию/описанию…" />
        <label class="switch sm"><input type="checkbox" id="hhonly"/> только предлагаемые</label>
        <button class="btn sec sm" id="hhrefresh">Обновить</button>
        <div class="right"></div>
        <button class="btn ok sm" id="hhsync">⏳ Синхронизировать HH сейчас</button>
      </div>
      <div class="toolbar">
        <span class="hint">Отметьте чекбокс «Предлагать» у нужных вакансий — бот предлагает только их. Массово для всех показанных:</span>
        <button class="btn sec sm" id="hhoffer">✓ Предлагать все показанные</button>
        <button class="btn sec sm" id="hhunoffer">✗ Снять все показанные</button>
      </div>
      <div id="hhtable"></div>
    </div>`;
  let shownIds = [];
  const load = async () => {
    const q = $('#hhq').value.trim();
    const only = $('#hhonly').checked;
    const { vacancies } = await api('GET', '/vacancies?active=true&source=hh' + (only ? '&offered=true' : '') + (q ? '&q=' + encodeURIComponent(q) : ''));
    shownIds = vacancies.map(v => v.id);
    $('#hhtable').innerHTML = renderVacTable(vacancies);
  };
  window.__hhBulk = async (on) => {
    if (!shownIds.length) return toast('Список пуст', true);
    await api('POST', '/vacancies/bulk-offer', { ids: shownIds, is_offered: on });
    toast(`Обновлено: ${shownIds.length}`); load();
  };
  $('#hhrefresh').onclick = load;
  $('#hhq').onkeydown = (e) => { if (e.key === 'Enter') load(); };
  $('#hhonly').onchange = load;
  $('#hhsync').onclick = async () => {
    toast('Запускаю синхронизацию HH…');
    try {
      const { result } = await api('POST', '/hh/sync', {});
      toast(result.ok ? `Готово: найдено ${result.found}, новых ${result.upserted}` : 'Ошибка HH: ' + (result.errors[0] || ''), !result.ok);
      load();
    } catch (e) { toast(e.message, true); }
  };
  $('#hhoffer').onclick = () => window.__hhBulk(true);
  $('#hhunoffer').onclick = () => window.__hhBulk(false);
  await load();
});

// ─── Вакансии Авито V2 — группировка по городам ─────────────────────────────
function renderVacV2(vacancies) {
  if (!vacancies.length) return '<p class="muted">Вакансий нет.</p>';

  // Группируем по городу
  const cityMap = new Map();
  for (const v of vacancies) {
    const city = extractCity(v.location || '') || '—';
    if (!cityMap.has(city)) cityMap.set(city, []);
    cityMap.get(city).push(v);
  }

  const offered = vacancies.filter(v => v.is_offered).length;
  const total   = vacancies.length;

  let html = `<div class="vac-counter">Всего: ${total} · Предлагаем боту: <b>${offered}</b> из ${total}</div>
<table class="tbl v2-table"><thead><tr>
  <th>Предлагать</th><th>Название</th><th class="nowrap">Зарплата</th><th>Ресторан</th>
</tr></thead><tbody>`;

  const sorted = [...cityMap.entries()].sort((a,b) => a[0].localeCompare(b[0],'ru'));
  for (const [city, cvacs] of sorted) {
    html += `<tr class="v2-city-row"><td colspan="4">${esc(city)}</td></tr>`;
    for (const v of cvacs) {
      const title      = cleanVacTitle(v.title) || v.title;
      const restaurant = extractRestaurant(v.title, v.location || '');
      const salary     = fmtSalary(v.salary || '');
      html += `<tr>
        <td><label class="toggle"><input type="checkbox" ${v.is_offered ? 'checked' : ''}
          onchange="toggleOffer([${v.id}],this.checked)"><span></span></label></td>
        <td>${esc(title)}</td>
        <td class="nowrap">${esc(salary)}</td>
        <td class="muted small">${esc(restaurant)}</td>
      </tr>`;
    }
  }
  html += `</tbody></table>`;
  return html;
}

registerTab('_vacancies_v2_disabled', async () => {
  view().innerHTML = `
    <div class="card">
      <div class="toolbar">
        <input type="text" id="v2q" placeholder="Поиск по названию…" />
        <label class="switch sm"><input type="checkbox" id="v2only"/> только предлагаемые</label>
        <button class="btn sec sm" id="v2refresh">Обновить</button>
        <div class="right"></div>
        <button class="btn ok sm" id="v2offer">✓ Предлагать все</button>
        <button class="btn sec sm" id="v2unoffer">✗ Снять все</button>
      </div>
      <div id="v2table"></div>
    </div>`;
  let allVacs = [];
  const load = async () => {
    const q    = $('#v2q').value.trim();
    const only = $('#v2only').checked;
    const { vacancies } = await api('GET', '/vacancies?active=true&source_ne=hh'
      + (only ? '&offered=true' : '')
      + (q    ? '&q=' + encodeURIComponent(q) : ''));
    allVacs = vacancies;
    $('#v2table').innerHTML = renderVacV2(vacancies);
  };
  const bulkV2 = async (on) => {
    if (!allVacs.length) return;
    await api('POST', '/vacancies/bulk-offer', { ids: allVacs.map(v=>v.id), is_offered: on });
    toast(`Обновлено: ${allVacs.length}`); load();
  };
  $('#v2refresh').onclick = load;
  $('#v2q').onkeydown = (e) => { if (e.key==='Enter') load(); };
  $('#v2only').onchange = load;
  $('#v2offer').onclick   = () => bulkV2(true);
  $('#v2unoffer').onclick = () => bulkV2(false);
  await load();
});
// ─────────────────────────────────────────────────────────────────────────────

// ── Вакансии (job_positions) ──────────────────────────────────────────────────
function renderPositions(positions) {
  if (!positions.length) return '<p class="muted">Вакансий нет.</p>';

  const offered = positions.filter(p => p.is_offered).length;
  const total   = positions.length;

  // Группируем по городу, сохраняем порядок
  const cityMap = new Map();
  for (const p of positions) {
    if (!cityMap.has(p.city)) cityMap.set(p.city, []);
    cityMap.get(p.city).push(p);
  }

  let html = `<div class="vac-counter">Всего: ${total} · Предлагаем боту: <b>${offered}</b> из ${total}</div>
<table class="tbl v2-table"><thead><tr>
  <th>Предлагать</th><th>Категория</th><th>Вакансия</th><th>Описание</th>
</tr></thead><tbody>`;

  for (const [city, items] of cityMap) {
    html += `<tr class="v2-city-row"><td colspan="3">${esc(city)}</td></tr>`;
    for (const p of items) {
      html += `<tr>
        <td><label class="toggle"><input type="checkbox" ${p.is_offered ? 'checked' : ''}
          onchange="togglePosition(${p.id},this.checked)"><span></span></label></td>
        <td class="muted small">${esc(p.category)}</td>
        <td>${esc(p.position)}</td>
        <td class="muted small desc-cell">${esc(p.description||'').replace(/\n/g,'<br>')}</td>
      </tr>`;
    }
  }
  html += `</tbody></table>`;
  return html;
}

window.togglePosition = async (id, on) => {
  await api('PATCH', '/positions/' + id, { is_offered: on });
};

registerTab('positions', async () => {
  view().innerHTML = `
    <div class="card">
      <div class="toolbar">
        <span class="hint">Отметьте вакансии, которые бот будет предлагать кандидатам</span>
        <div class="right"></div>
        <button class="btn ok sm" id="posOffer">✓ Предлагать все</button>
        <button class="btn sec sm" id="posUnoffer">✗ Снять все</button>
      </div>
      <div id="postable"></div>
    </div>`;
  let allPos = [];
  const load = async () => {
    const { positions } = await api('GET', '/positions');
    allPos = positions;
    $('#postable').innerHTML = renderPositions(positions);
  };
  const bulkPos = async (on) => {
    if (!allPos.length) return;
    await api('POST', '/positions/bulk-offer', { ids: allPos.map(p=>p.id), is_offered: on });
    toast(`Обновлено: ${allPos.length}`); load();
  };
  $('#posOffer').onclick   = () => bulkPos(true);
  $('#posUnoffer').onclick = () => bulkPos(false);
  await load();
});
// ─────────────────────────────────────────────────────────────────────────────

registerTab('prompts', async () => {
  const { prompts } = await api('GET', '/prompts');
  const { settings } = await api('GET', '/settings');
  view().innerHTML = `
    <div class="card">
      <div class="toolbar"><h3 style="margin:0">Промпты под типы задач</h3>
        <div class="right"></div><button class="btn sm" id="paddbtn">+ Новый промпт</button></div>
      <p class="hint">Активный «по умолчанию» промпт используется ботом. Можно держать несколько (скрининг, FAQ и т.п.) и переключать.</p>
      <table><thead><tr><th>Активный</th><th>Название</th><th>Тип</th><th>Включён</th><th></th></tr></thead>
      <tbody>${prompts.map(p => `<tr>
        <td><input type="radio" name="activep" ${settings.active_prompt_id === p.id ? 'checked' : ''} onchange="setActivePrompt(${p.id})"></td>
        <td>${esc(p.name)}</td>
        <td><span class="pill off">${esc(p.task_type)}</span></td>
        <td><span class="pill ${p.is_active ? 'on' : 'off'}">${p.is_active ? 'да' : 'нет'}</span></td>
        <td class="nowrap"><button class="btn sec sm" onclick='editPrompt(${JSON.stringify(p).replace(/'/g, "&#39;")})'>Изменить</button>
            <button class="btn danger sm" onclick="delPrompt(${p.id})">Удалить</button></td>
      </tr>`).join('')}</tbody></table>
    </div>`;
  $('#paddbtn').onclick = () => promptForm();
});
async function setActivePrompt(id) {
  await api('PUT', '/settings', { active_prompt_id: id }); toast('Активный промпт обновлён');
}
window.setActivePrompt = setActivePrompt;
function promptForm(p) {
  p = p || { task_type: 'custom', is_active: true, collect_fields: [] };
  const fields = (p.collect_fields || []).join(', ');
  modal(`<h3>${p.id ? 'Редактировать' : 'Новый'} промпт</h3>
    <label>Название</label><input type="text" id="p_name" value="${esc(p.name || '')}">
    <label>Тип задачи</label><input type="text" id="p_type" value="${esc(p.task_type || 'custom')}">
    <label>Системный промпт</label><textarea id="p_sys" style="min-height:200px">${esc(p.system_prompt || '')}</textarea>
    <label>Поля для сбора (через запятую)</label><input type="text" id="p_fields" value="${esc(fields)}">
    <p class="hint">Напр.: full_name, phone, city, desired_position, experience, salary_expectation, schedule</p>
    <label class="checkbox"><input type="checkbox" id="p_active" ${p.is_active ? 'checked' : ''}> Включён</label>
    <div class="row" style="margin-top:16px"><button class="btn" id="p_save">Сохранить</button>
      <button class="btn sec" onclick="closeModal()">Отмена</button></div>`);
  $('#p_save').onclick = async () => {
    const payload = {
      name: $('#p_name').value.trim(), task_type: $('#p_type').value.trim() || 'custom',
      system_prompt: $('#p_sys').value, is_active: $('#p_active').checked,
      collect_fields: $('#p_fields').value.split(',').map(s => s.trim()).filter(Boolean),
    };
    if (!payload.name || !payload.system_prompt) return toast('Название и промпт обязательны', true);
    try {
      if (p.id) await api('PUT', '/prompts/' + p.id, payload);
      else await api('POST', '/prompts', payload);
      toast('Сохранено'); closeModal(); openTab('prompts');
    } catch (e) { toast(e.message, true); }
  };
}
window.editPrompt = (p) => promptForm(p);
async function delPrompt(id) { if (!confirm('Удалить промпт?')) return; await api('DELETE', '/prompts/' + id); toast('Удалено'); openTab('prompts'); }
window.delPrompt = delPrompt;

// ───────── Candidates ─────────
registerTab('candidates', async () => {
  const { candidates } = await api('GET', '/candidates');
  view().innerHTML = `<div class="card">
    <h3>Соискатели (${candidates.length})</h3>
    ${candidates.length ? `<table><thead><tr>
      <th>ФИО</th><th>Телефон</th><th>Возраст</th><th>Город</th><th>Гражданство</th><th>Вакансия</th><th>Срок работы</th><th>График</th><th>Сделка</th><th></th>
    </tr></thead><tbody>${candidates.map(c => `<tr>
      <td>${esc(c.full_name || '—')}</td><td>${esc(c.phone || '')}</td>
      <td>${esc(c.age || '')}</td><td>${esc(c.city || '')}</td>
      <td>${esc(c.citizenship || '')}</td><td>${esc(c.desired_position || '')}</td>
      <td>${esc(c.work_duration || '')}</td><td>${esc(c.schedule || '')}</td>
      <td>${c.crm_deal_id ? '#' + c.crm_deal_id : '<span class="pill off">нет</span>'}</td>
      <td><button class="btn sec sm" onclick="showDialog('${esc(c.dialog_id)}')">Диалог</button></td>
    </tr>`).join('')}</tbody></table>` : '<p class="muted">Пока нет собранных анкет.</p>'}
  </div>`;
});
async function showDialog(dialogId) {
  const { messages } = await api('GET', '/candidates/' + encodeURIComponent(dialogId) + '/messages');
  modal(`<h3>Диалог</h3><div class="desc">${messages.map(m =>
    `<p><b>${m.role === 'user' ? 'Соискатель' : 'Бот'}:</b> ${esc(m.text)}</p>`).join('')}</div>
    <div class="row" style="margin-top:14px"><button class="btn sec" onclick="closeModal()">Закрыть</button></div>`);
}
window.showDialog = showDialog;

// ───────── Usage (токены) ─────────
registerTab('usage', async () => {
  const u = await api('GET', '/usage');
  const t = u.totals;
  view().innerHTML = `
    <div class="stat-grid">
      <div class="stat"><div class="n">${t.total.toLocaleString('ru')}</div><div class="l">токенов всего</div></div>
      <div class="stat"><div class="n">${u.avgPerDialog.toLocaleString('ru')}</div><div class="l">токенов на диалог (ср.)</div></div>
      <div class="stat"><div class="n" style="color:var(--ok)">${fmtRub(u.avgPerDialogRub)}</div><div class="l">стоимость диалога (ср.)</div></div>
      <div class="stat"><div class="n">${u.avgPerCall.toLocaleString('ru')}</div><div class="l">токенов на ответ (ср.)</div></div>
      <div class="stat"><div class="n">${t.dialogs}</div><div class="l">диалогов</div></div>
    </div>
    <p class="hint">Стоимость считается по тарифу ${u.pricePer1k ? fmtRub(u.pricePer1k) + ' за 1000 токенов' : '(не задан — укажите на вкладке «Баланс»)'}. Всего израсходовано: ${fmtRub(u.totalRub)}.</p>
    <div class="card">
      <h3>Расход токенов по диалогам</h3>
      <p class="hint">Входящие (prompt) + исходящие (completion) токены, потраченные ботом. По этим данным определим стоимость диалога.</p>
      ${t.calls ? `<table><thead><tr><th>Диалог</th><th>Ответов</th><th>Prompt</th><th>Completion</th><th>Всего</th><th>Последний</th></tr></thead>
      <tbody>${u.perDialog.map(d => `<tr>
        <td><code>${esc(d.dialog_id)}</code></td>
        <td>${d.calls}</td>
        <td>${(d.prompt_tokens||0).toLocaleString('ru')}</td>
        <td>${(d.completion_tokens||0).toLocaleString('ru')}</td>
        <td><b>${(d.total_tokens||0).toLocaleString('ru')}</b></td>
        <td class="nowrap">${d.last_at ? new Date(d.last_at).toLocaleString('ru') : ''}</td>
      </tr>`).join('')}</tbody></table>` : '<p class="muted">Пока нет данных — токены появятся после первых диалогов с ботом.</p>'}
    </div>`;
});

// ───────── Billing (Баланс / Выписка / Счета) ─────────
const fmtRub = (n) => (Math.round((Number(n) || 0) * 100) / 100).toLocaleString('ru', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' ₽';
const fmtNum = (n) => (Number(n) || 0).toLocaleString('ru');
const txnKind = { debit: 'Списание', topup: 'Пополнение', invoice_paid: 'Оплата счёта', promised: 'Обещанный платёж', promised_settled: 'Оплачен обещанный', adjust: 'Корректировка' };
const invStatus = { issued: '<span class="pill warn">ожидает оплаты</span>', paid: '<span class="pill on">оплачен</span>', cancelled: '<span class="pill off">отменён</span>' };

registerTab('billing', async () => {
  const s = await api('GET', '/billing/state');
  const r = s.recipient || {};
  const adminMode = !!adminPass();          // админ-часть включается только по паролю (кнопка в углу)
  const lowBalance = s.balanceTokens <= 0;
  view().innerHTML = `
    <div class="banner ${adminMode ? 'warn' : ''}" style="${adminMode ? '' : 'background:#eef5ff;color:#1b4f8a;border:1px solid #cfe0f5'}">
      ${adminMode ? '🔧 <b>Админ-часть</b> — управление счетами, оплатами и пополнением. Нажмите «🔓 Админ» вверху, чтобы вернуться в кабинет клиента.'
                  : '👤 <b>Кабинет клиента</b> — баланс, счета и выписка. Управление — в админ-части (кнопка «🔒 Админ» вверху).'}
    </div>

    <div class="row">
      <div class="card accent" style="flex:1;min-width:240px">
        <h3>Текущий баланс</h3>
        <div style="font-size:32px;font-weight:700;color:${lowBalance ? 'var(--danger)' : 'var(--primary)'}">${fmtNum(s.balanceTokens)} <span style="font-size:16px;color:var(--muted)">токенов</span></div>
        <div class="hint">${s.pricePer1k ? '≈ ' + fmtRub(s.balanceRub) + ` (по ${fmtRub(s.pricePer1k)}/1000 токенов)` : 'цена за токен не задана'}</div>
        <div style="margin-top:8px">${s.exhausted
          ? '<span class="pill" style="background:#fde8e6;color:#8a1a10">⏸ Бот приостановлен — диалоги уходят операторам</span>'
          : '<span class="pill on">✓ Бот активен</span>'}</div>
      </div>
    </div>

    ${adminMode ? `
    <div class="card">
      <h3>Ручное пополнение баланса</h3>
      <p class="hint">Зачислить токены вручную. В выписке у клиента отобразится как «Пополнение баланса (ИП Глозман Е. М.)» — без акта.</p>
      <div class="row">
        <div style="flex:1;min-width:160px"><label>Токенов</label><input type="number" id="m_tokens" placeholder="например 1000000"></div>
        <div style="align-self:end"><button class="btn ok" id="m_topup">＋ Пополнить</button></div>
      </div>
    </div>

    <div class="card">
      <h3>Выставить счёт</h3>
      <p class="hint">Введите токены — сумма посчитается по тарифу (${s.pricePer1k ? fmtRub(s.pricePer1k) + '/1000 токенов' : 'тариф не задан'}); или введите сумму — посчитаются токены. Юр.лицо и ИНН обязательны.</p>
      <div class="row">
        <div style="flex:1;min-width:130px"><label>Токенов</label><input type="number" id="i_tokens" placeholder="1000000"></div>
        <div style="flex:1;min-width:120px"><label>Сумма, ₽</label><input type="number" step="0.01" id="i_amount" placeholder="по тарифу"></div>
        <div style="flex:2;min-width:200px"><label>Юр.лицо (плательщик) *</label><input type="text" id="i_payer" placeholder="ООО «...» / ИП ..."></div>
        <div style="flex:1;min-width:130px"><label>ИНН *</label><input type="text" id="i_inn" placeholder="10 или 12 цифр"></div>
      </div>
      <label class="checkbox" style="margin-top:10px"><input type="checkbox" id="i_promised" ${s.hasOutstandingPromised ? 'disabled' : ''}>
        Обещанный платёж — зачислить токены на баланс <b>сразу</b> (до оплаты), не более ${fmtRub(s.promisedMaxRub)}</label>
      ${s.hasOutstandingPromised ? '<p class="hint" style="color:var(--warn)">Уже есть неоплаченный обещанный платёж — новый можно выписать только после его оплаты.</p>' : ''}
      <div class="row" style="margin-top:8px"><button class="btn" id="i_create">Выставить счёт</button></div>
    </div>` : ''}

    ${s.pending.length ? `<div class="card"><h3>Счета к оплате (${s.pending.length})</h3>
      <table><thead><tr><th>№</th><th>Плательщик</th><th>Токенов</th><th>Сумма</th><th>Создан</th><th></th></tr></thead><tbody>
      ${s.pending.map(i => `<tr><td>${esc(i.number||i.id)}</td><td>${esc(i.payer_name||'—')}${i.payer_inn ? ' <span class="hint">ИНН '+esc(i.payer_inn)+'</span>' : ''}</td>
        <td>${fmtNum(i.tokens)}</td><td>${fmtRub(i.amount_rub)}</td>
        <td class="nowrap">${new Date(i.created_at).toLocaleDateString('ru')}</td>
        <td class="nowrap"><button class="btn sec sm" onclick="invoicePdf(${i.id})">📄 Счёт PDF</button>
            ${adminMode ? `<button class="btn ok sm" onclick="payInv(${i.id})">Оплачен</button>
            <button class="btn danger sm" onclick="cancelInv(${i.id})">Отмена</button>` : ''}</td></tr>`).join('')}
      </tbody></table></div>` : ''}

    ${adminMode ? `<div class="card"><h3>Оплаты T-Bank</h3>
      <p class="hint">Оплаченные счета зачисляются автоматически (сверка выписки по сумме + ИНН плательщика каждые ~10 мин). Если платёж не подхватился — проверьте вручную.</p>
      <p>Сверка: ${s.tbank && s.tbank.configured
          ? (s.tbank.lastRun && s.tbank.lastRun.at
              ? `последняя ${new Date(s.tbank.lastRun.at).toLocaleString('ru')} — входящих ${s.tbank.lastRun.scanned||0}, оплачено ${s.tbank.lastRun.matched||0}${s.tbank.lastRun.errors && s.tbank.lastRun.errors.length ? ' <span class="pill warn">ошибки</span>' : ' <span class="pill on">ок</span>'}`
              : 'ещё не запускалась')
          : '<span class="pill off">прокси не настроен</span>'}
        ${s.tbank && s.tbank.lastRun && s.tbank.lastRun.errors && s.tbank.lastRun.errors.length ? `<div class="hint">${s.tbank.lastRun.errors.map(esc).join('<br>')}</div>` : ''}</p>
      <button class="btn ok" id="t_check">🔄 Проверить оплаты сейчас</button>
    </div>` : ''}

    <div class="card"><h3>Выписка по балансу</h3>
      <div class="toolbar">
        <select id="f_dir">
          <option value="all">Все операции</option>
          <option value="credit">Только пополнения</option>
          <option value="debit">Только списания</option>
        </select>
        <label class="hint">с <input type="date" id="f_from" style="width:auto"></label>
        <label class="hint">по <input type="date" id="f_to" style="width:auto"></label>
        <button class="btn sec sm" id="f_apply">Показать</button>
      </div>
      <div id="txn_box"><p class="muted">Загрузка…</p></div>
    </div>

    <div class="card"><h3>Реквизиты получателя</h3>
      <div class="desc">${[r.shortName, r.fullName, r.inn ? 'ИНН ' + r.inn : '', r.bankName, r.bik ? 'БИК ' + r.bik : '', r.bankAccount ? 'Р/с ' + r.bankAccount : '', r.corrAccount ? 'К/с ' + r.corrAccount : '', r.purpose].filter(Boolean).map(esc).join('<br>')}</div>
    </div>`;

  // Выписка с фильтрами
  async function loadTxns() {
    const dir = $('#f_dir').value, from = $('#f_from').value, to = $('#f_to').value;
    const qs = new URLSearchParams({ direction: dir });
    if (from) qs.set('from', from); if (to) qs.set('to', to);
    try {
      const { transactions } = await api('GET', '/billing/transactions?' + qs.toString());
      $('#txn_box').innerHTML = renderTxns(transactions);
    } catch (e) { $('#txn_box').innerHTML = `<p class="banner err">${esc(e.message)}</p>`; }
  }
  $('#f_apply').onclick = loadTxns;
  $('#f_dir').onchange = loadTxns;
  await loadTxns();

  if (adminMode) {
    const mt = $('#m_topup');
    if (mt) mt.onclick = async () => {
      const tokens = Number($('#m_tokens').value);
      if (!tokens) return toast('Укажите токены', true);
      try { await api('POST', '/billing/topup', { tokens }); toast('Баланс пополнен'); openTab('billing'); } catch (e) { toast(e.message, true); }
    };
    const tbtn = $('#t_check');
    if (tbtn) tbtn.onclick = async () => {
      tbtn.disabled = true; toast('Проверяю выписку T-Bank…');
      try { const { result } = await api('POST', '/billing/check-payments', {});
        toast(result.ok ? `Готово: входящих ${result.scanned}, оплачено счетов ${result.matched}` : 'Ошибка: ' + (result.errors[0] || ''), !result.ok);
        openTab('billing');
      } catch (e) { toast(e.message, true); tbtn.disabled = false; }
    };
    const price = Number(s.pricePer1k || 0);
    const tokEl = $('#i_tokens'), amtEl = $('#i_amount');
    let syncing = false;
    tokEl.oninput = () => { if (syncing || !price) return; syncing = true; const t = Number(tokEl.value) || 0; amtEl.value = t ? (Math.round((t / 1000) * price * 100) / 100) : ''; syncing = false; };
    amtEl.oninput = () => { if (syncing || !price) return; syncing = true; const a = Number(amtEl.value) || 0; tokEl.value = a ? Math.round((a / price) * 1000) : ''; syncing = false; };
    $('#i_create').onclick = async () => {
      const tokens = Number(tokEl.value) || 0;
      const amountRub = Number(amtEl.value) || null;
      const payerName = $('#i_payer').value.trim();
      const innClean = $('#i_inn').value.replace(/\D/g, '');
      const isPromised = $('#i_promised').checked;
      if (!tokens && !amountRub) return toast('Укажите токены или сумму', true);
      if (!payerName) return toast('Укажите юр.лицо (плательщика)', true);
      if (innClean.length !== 10 && innClean.length !== 12) return toast('ИНН должен быть 10 или 12 цифр', true);
      if (isPromised && amountRub && amountRub > s.promisedMaxRub) return toast(`Обещанный платёж не больше ${fmtRub(s.promisedMaxRub)}`, true);
      try { await api('POST', '/billing/invoice', { tokens, amountRub, payerName, payerInn: innClean, isPromised }); toast(isPromised ? 'Обещанный платёж выписан, баланс пополнен' : 'Счёт выставлен'); openTab('billing'); } catch (e) { toast(e.message, true); }
    };
  }
});

// Рендер выписки: списания показывают диалог и ссылку на него.
function renderTxns(txns) {
  if (!txns || !txns.length) return '<p class="muted">Операций по фильтру нет.</p>';
  return `<table><thead><tr><th>Дата</th><th>Операция</th><th>Детали</th><th>Токены</th><th>Остаток</th></tr></thead><tbody>
    ${txns.map(t => {
      const dlg = t.dialog_id ? `по диалогу <a href="#" onclick="billingDialog('${esc(t.dialog_id)}');return false">${esc(t.dialog_id)}</a>` : esc(t.description || '');
      return `<tr>
        <td class="nowrap">${new Date(t.created_at).toLocaleString('ru')}</td>
        <td>${txnKind[t.kind] || t.kind}</td>
        <td>${dlg}</td>
        <td style="color:${t.tokens < 0 ? 'var(--danger)' : 'var(--ok)'}">${t.tokens > 0 ? '+' : ''}${fmtNum(t.tokens)}</td>
        <td>${fmtNum(t.balance_after)}</td>
      </tr>`;
    }).join('')}</tbody></table>`;
}
// Открыть переписку диалога (по ссылке из выписки списаний).
async function billingDialog(dialogId) {
  try {
    const { messages } = await api('GET', '/candidates/' + encodeURIComponent(dialogId) + '/messages');
    modal(`<h3>Диалог ${esc(dialogId)}</h3>
      <p><a href="https://gkfs.bitrix24.ru/online/?IM_DIALOG=${encodeURIComponent(dialogId)}" target="_blank" rel="noopener">Открыть в Битрикс24 ↗</a></p>
      <div class="desc">${(messages||[]).map(m => `<p><b>${m.role === 'user' ? 'Соискатель' : 'Бот'}:</b> ${esc(m.text)}</p>`).join('') || '<span class="muted">сообщений нет</span>'}</div>
      <div class="row" style="margin-top:12px"><button class="btn sec" onclick="closeModal()">Закрыть</button></div>`);
  } catch (e) { toast(e.message, true); }
}
window.billingDialog = billingDialog;
// Скачать PDF счёта (через fetch с заголовком сессии → blob).
async function invoicePdf(id) {
  try {
    const res = await fetch('/api/billing/invoice/' + id + '/pdf', {
      credentials: 'include',
      headers: VIBE_SESSION ? { 'X-App-Session': 'Bearer ' + VIBE_SESSION } : {},
    });
    if (!res.ok) throw new Error('Ошибка ' + res.status);
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    window.open(url, '_blank');
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  } catch (e) { toast('Не удалось получить PDF: ' + e.message, true); }
}
window.invoicePdf = invoicePdf;
async function payInv(id) { if (!confirm('Отметить счёт оплаченным? Баланс пополнится.')) return; await api('POST', `/billing/invoice/${id}/pay`); toast('Оплачен, баланс пополнен'); openTab('billing'); }
async function cancelInv(id) { if (!confirm('Отменить счёт?')) return; await api('POST', `/billing/invoice/${id}/cancel`); toast('Отменён'); openTab('billing'); }
window.payInv = payInv; window.cancelInv = cancelInv;

// ───────── Settings ─────────
registerTab('settings', async () => {
  const { settings } = await api('GET', '/settings');
  let modelData = { models: [], defaultModel: '', byokAvailable: false, usable: [] };
  try { modelData = await api('GET', '/ai/models'); } catch {}
  const sources = (settings.avito_sources || []).map(s => (typeof s === 'string' ? s : s.url)).join('\n');
  const usableOpts = (modelData.usable || []).map(m => `<option value="${esc(m)}" ${settings.ai_model === m ? 'selected' : ''}>${esc(m)}</option>`).join('');
  view().innerHTML = `
    <div class="card"><h3>Бот</h3>
      <label class="checkbox"><input type="checkbox" id="s_enabled" ${settings.bot_enabled ? 'checked' : ''}> Бот включён (отвечает в открытых линиях)</label>
    </div>

    <div class="card"><h3>Нейрон (модель ответа)</h3>
      <label>Модель</label>
      <select id="s_model">
        <option value="" ${!settings.ai_model ? 'selected' : ''}>— BitrixGPT (по умолчанию: ${esc(modelData.defaultModel || 'bitrix/free')}) —</option>
        ${usableOpts}
      </select>
      <label>Или укажите модель вручную (для платной/BYOK)</label>
      <input type="text" id="s_model_manual" placeholder="напр. openai/gpt-4o или anthropic/claude-..." value="${settings.ai_model && !(modelData.usable||[]).includes(settings.ai_model) ? esc(settings.ai_model) : ''}">
      <p class="hint">BYOK ${modelData.byokAvailable ? '<span class="pill on">доступен</span> — ключ провайдера регистрируется в AI Router платформы (раздел credentials).' : 'недоступен на текущем тарифе.'}</p>
      <div class="row">
        <div style="flex:1"><label>Температура</label><input type="number" step="0.1" min="0" max="2" id="s_temp" value="${settings.temperature}"></div>
        <div style="flex:1"><label>Макс. токенов ответа</label><input type="number" id="s_maxtok" value="${settings.max_tokens}"></div>
      </div>
    </div>

    <div class="card"><h3>CRM</h3>
      <label class="checkbox"><input type="checkbox" id="s_crm" ${settings.crm_update_enabled ? 'checked' : ''}> Обновлять сделку открытой линии собранными данными</label>
      <label>Тип сущности</label>
      <select id="s_crmtype">
        <option value="deal" ${settings.crm_entity_type === 'deal' ? 'selected' : ''}>Сделка</option>
        <option value="lead" ${settings.crm_entity_type === 'lead' ? 'selected' : ''}>Лид</option>
      </select>
    </div>

    <div class="card"><h3>Вакансии с Авито (официальный API)</h3>
      <p class="hint">Ключи из кабинета Авито: Профиль → Настройки → API. Бот подтянет вакансии вашего аккаунта напрямую (без блокировок). Прямой парсинг страниц Авито не работает — блокируется по IP.</p>
      <div class="row">
        <div style="flex:1"><label>Client ID</label><input type="text" id="s_avito_id" value="${esc(settings.avito_client_id || '')}"></div>
        <div style="flex:1"><label>Client Secret ${settings.avito_secret_set ? '<span class="pill on">задан</span>' : ''}</label>
          <input type="text" id="s_avito_secret" placeholder="${settings.avito_secret_set ? '•••••• (оставьте пустым, чтобы не менять)' : 'вставьте client_secret'}"></div>
      </div>
      <label class="checkbox"><input type="checkbox" id="s_avito_only" ${settings.avito_only_vacancies !== false ? 'checked' : ''}> Загружать только категорию «Вакансии»</label>
      <p class="hint" style="margin-top:10px">После сохранения ключей зайдите во вкладку «Вакансии» → «Парсить Авито сейчас», затем отметьте галочками, что предлагать.</p>
      <details style="margin-top:8px"><summary class="hint">Запасной вариант: URL-источники (ненадёжно, блокируется)</summary>
        <textarea id="s_avito" placeholder="https://www.avito.ru/...">${esc(sources)}</textarea>
      </details>
    </div>

    
    <div class="card"><h3>Вакансии с HH.ru</h3>
      <p class="hint">Укажите ID работодателя — бот автоматически подтянет активные вакансии. ID виден в URL: hh.ru/employer/<b>66989</b></p>
      <label>ID работодателя (hh.ru)</label>
      <input type="text" id="s_hh_id" placeholder="например: 66989" value="${esc(settings.hh_employer_id || '')}">
      <p class="hint" style="margin-top:8px">После сохранения → вкладка «Вакансии HH» → «Синхронизировать HH сейчас».</p>
    </div>

<div class="card"><h3>Встраивание в Битрикс24</h3>
      <div id="embed_box"><p class="muted">Загрузка статуса приложения…</p></div>
    </div>

    <div class="row"><button class="btn" id="s_save">Сохранить настройки</button></div>`;

  // Статус встраивания + публикация
  (async () => {
    try {
      const st = await api('GET', '/app/status');
      const box = document.getElementById('embed_box');
      if (!box) return;
      if (!st.configured) { box.innerHTML = '<p class="muted">OAuth-приложение не настроено (нет APP_ID/VIBE_APP_KEY).</p>'; return; }
      const published = (st.placements || []).length > 0;
      box.innerHTML = `
        <p>Статус: ${published ? '<span class="pill on">опубликовано</span> · места: ' + st.placements.map(esc).join(', ') : '<span class="pill off">не опубликовано</span>'}</p>
        <p class="hint">Чтобы приложение появилось в <b>левом меню</b> Битрикс24 для сотрудников:</p>
        <ol class="hint">
          <li>Откройте ссылку авторизации и подтвердите установку приложения на портал:
            <br><a href="${esc(st.authorizeUrl)}" target="_blank" rel="noopener">Авторизовать приложение в Битрикс24 ↗</a></li>
          <li>Затем нажмите «Опубликовать».</li>
        </ol>
        <button class="btn ok" id="pub_btn">Опубликовать в левом меню</button>`;
      document.getElementById('pub_btn').onclick = async () => {
        try { const r = await api('POST', '/app/publish', { placements: ['LEFT_MENU'] });
          toast('Опубликовано: ' + ((r.app?.placements || []).join(', ') || 'ok')); openTab('settings'); }
        catch (e) { toast(e.message || 'Сначала авторизуйте приложение по ссылке выше', true); }
      };
    } catch (e) { /* секция необязательна */ }
  })();

  $('#s_save').onclick = async () => {
    const manual = $('#s_model_manual').value.trim();
    const model = manual || $('#s_model').value;
    const avito = $('#s_avito').value.split('\n').map(s => s.trim()).filter(Boolean).map(url => ({ url }));
    const payload = {
      bot_enabled: $('#s_enabled').checked,
      ai_model: model,
      crm_update_enabled: $('#s_crm').checked,
      crm_entity_type: $('#s_crmtype').value,
      temperature: Number($('#s_temp').value),
      max_tokens: Number($('#s_maxtok').value),
      avito_sources: avito,
      avito_client_id: $('#s_avito_id').value.trim(),
      hh_employer_id: ($('#s_hh_id') ? $('#s_hh_id').value.trim() : undefined),
      hh_client_id: ($('#s_hh_client_id') ? $('#s_hh_client_id').value.trim() : undefined),
      avito_only_vacancies: $('#s_avito_only').checked,
    };
    const secret = $('#s_avito_secret').value.trim();
    if (secret) payload.avito_client_secret = secret;
    const hhSecret = $('#s_hh_client_secret') ? $('#s_hh_client_secret').value.trim() : '';
    if (hhSecret) payload.hh_client_secret = hhSecret;
    try {
      await api('PUT', '/settings', payload);
      toast('Настройки сохранены');
    } catch (e) { toast(e.message, true); }
  };
});

// ───────── keepalive ─────────
// Cookie сессии gateway (_vibe_gw) живёт со sliding-refresh ПРИ АКТИВНОСТИ.
// Без запросов сессия протухает и приложение «слетает». Держим её тёплой:
// пинг каждые 30с, при клике на вкладку, при возврате фокуса/видимости вкладки.
let authLost = false;
let lastRenew = 0;
async function renewSession(force) {
  const now = Date.now();
  if (!force && now - lastRenew < 5000) return; // троттлинг
  lastRenew = now;
  try {
    await api('GET', '/me');
    if (authLost) { authLost = false; const t = $('#toast'); if (t) t.classList.add('hidden'); }
  } catch (e) {
    if (e.auth && !authLost) {
      authLost = true;
      const t = $('#toast');
      if (t) { t.textContent = 'Сессия истекла — переоткройте приложение из меню Битрикс24'; t.className = 'toast err'; }
    }
  }
}
function startHeartbeat() {
  setInterval(() => renewSession(true), 30000);                 // регулярный пульс
  window.addEventListener('focus', () => renewSession());       // возврат в окно
  document.addEventListener('visibilitychange', () => { if (!document.hidden) renewSession(); });
  document.addEventListener('click', () => renewSession());     // любой клик (троттлинг внутри)
}

// ───────── Вход в админ-часть по паролю (кнопка в углу) ─────────
function updateAdminBtn(isAdmin) {
  const b = document.getElementById('adminBtn');
  if (!b) return;
  if (adminPass() || isAdmin) { b.textContent = '🔓 Админ'; b.title = 'Админ-режим активен (выйти)'; }
  else { b.textContent = '🔒 Админ'; b.title = 'Войти в админ-часть по паролю'; }
}
function initAdminButton() {
  const b = document.getElementById('adminBtn');
  if (!b) return;
  b.onclick = async () => {
    if (adminPass()) { // выйти из админ-режима
      sessionStorage.removeItem('admin_pass'); updateAdminBtn(false); toast('Вышли из админ-режима'); openTab('billing'); return;
    }
    const pass = prompt('Пароль для входа в админ-часть:');
    if (!pass) return;
    try {
      sessionStorage.setItem('admin_pass', pass);
      await api('POST', '/admin-login', { password: pass });
      updateAdminBtn(true); toast('Админ-режим включён'); openTab('billing');
    } catch (e) { sessionStorage.removeItem('admin_pass'); toast(e.message || 'Неверный пароль', true); }
  };
}

// ───────── boot ─────────
(async function boot() {
  let isAdmin = false;
  try {
    const me = await api('GET', '/me');
    const user = me.user; isAdmin = me.isAdmin;
    $('#who').textContent = user && (user.name || user.id) ? ('👤 ' + (user.name || user.id)) : '';
  } catch (e) { /* покажет баннер при открытии вкладки */ }
  initAdminButton();
  updateAdminBtn(isAdmin);
  openTab('dashboard');
  startHeartbeat();
})();
