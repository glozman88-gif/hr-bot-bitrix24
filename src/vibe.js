import { config } from './config.js';

// Клиент VibeCode API. Все backend-вызовы идут с персональным ключом (X-Api-Key).
// ВАЖНО (известный нюанс платформы): при таймауте gateway может вернуть HTML-страницу
// «Black Hole» со статусом HTTP 200. Поэтому мы всегда проверяем content-type и тело.

class VibeError extends Error {
  constructor(message, { status, code, retriable } = {}) {
    super(message);
    this.name = 'VibeError';
    this.status = status;
    this.code = code;
    this.retriable = !!retriable;
  }
}

function looksLikeHtml(text) {
  const t = text.slice(0, 200).toLowerCase();
  return t.includes('<!doctype') || t.includes('<html') || t.includes('black hole');
}

async function parseResponse(res) {
  const ct = res.headers.get('content-type') || '';
  const text = await res.text();
  if (!ct.includes('application/json') || looksLikeHtml(text)) {
    // Gateway вернул HTML (Black Hole / таймаут) — считаем временной ошибкой.
    throw new VibeError('Gateway вернул не-JSON ответ (вероятно Black Hole/timeout)', {
      status: res.status,
      code: 'GATEWAY_HTML',
      retriable: true,
    });
  }
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new VibeError('Не удалось разобрать JSON-ответ', { status: res.status, retriable: true });
  }
  return json;
}

// Базовый вызов /v1/* (entity API, bot API, infra и т.п.).
export async function vibe(method, path, { body, bearer, query, apiKey } = {}) {
  const url = new URL(config.vibeBase.replace(/\/$/, '') + path);
  if (query) for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  }
  const headers = { 'X-Api-Key': apiKey || config.vibeApiKey };
  if (bearer) headers['Authorization'] = `Bearer ${bearer}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  const res = await fetch(url, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const json = await parseResponse(res);
  if (json && json.success === false) {
    const err = json.error || {};
    throw new VibeError(err.message || 'VibeCode API error', {
      status: res.status,
      code: err.code,
      retriable: res.status >= 500 || res.status === 429,
    });
  }
  return json;
}

// Удобные обёртки.
export const vibeGet = (path, opts) => vibe('GET', path, opts);
export const vibePost = (path, body, opts) => vibe('POST', path, { ...opts, body });
export const vibePatch = (path, body, opts) => vibe('PATCH', path, { ...opts, body });
export const vibeDelete = (path, opts) => vibe('DELETE', path, opts);

// ───────────────────────── AI Router (OpenAI-совместимый) ─────────────────────────
// Возвращает «сырой» OpenAI-формат (не {success,data}).
export async function chatCompletion(messages, { model, temperature, maxTokens, responseFormat, apiKey } = {}) {
  const url = config.vibeBase.replace(/\/$/, '') + '/chat/completions';
  const payload = { messages };
  // Пустая/отсутствующая модель => бесплатный BitrixGPT.
  if (model) payload.model = model;
  if (temperature !== undefined) payload.temperature = temperature;
  if (maxTokens !== undefined) payload.max_tokens = maxTokens;
  if (responseFormat) payload.response_format = responseFormat;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'X-Api-Key': apiKey || config.vibeApiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  const ct = res.headers.get('content-type') || '';
  const text = await res.text();
  if (!ct.includes('application/json') || looksLikeHtml(text)) {
    throw new VibeError('AI Router вернул не-JSON (Black Hole/timeout)', {
      status: res.status, code: 'GATEWAY_HTML', retriable: true,
    });
  }
  const json = JSON.parse(text);
  if (json.error) {
    throw new VibeError(json.error.message || 'AI error', { status: res.status, code: json.error.code });
  }
  return json;
}

export { VibeError };
