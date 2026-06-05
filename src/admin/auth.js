import { config } from '../config.js';
import { vibeGet } from '../vibe.js';

// BFF-аутентификация. Gateway инжектит заголовок X-Vibe-Authorization: Bearer vibe_session_*
// на каждый запрос к приложению (после авторизации пользователя через placement).
// Мы валидируем сессию через GET /v1/me с этим bearer и получаем личность пользователя.
//
// Запасной путь для ops/тестов: заголовок X-Admin-Token === process.env.ADMIN_API_TOKEN.

const meCache = new Map(); // bearer -> { user, exp }
const ME_TTL_MS = 60 * 1000;

function readBearer(req) {
  // 1) X-Vibe-Authorization — инжектится gateway (когда cookie доходит).
  const xva = req.get('x-vibe-authorization');
  if (xva) return xva.replace(/^Bearer\s+/i, '').trim();
  // 2) X-App-Session — токен, захваченный SPA при первой загрузке и присылаемый явно
  //    (работает в iframe Б24, где сторонние cookie заблокированы).
  const xas = req.get('x-app-session');
  if (xas) return xas.replace(/^Bearer\s+/i, '').trim();
  return null;
}

async function resolveUser(bearer) {
  const cached = meCache.get(bearer);
  if (cached && cached.exp > Date.now()) return cached.user;
  const res = await vibeGet('/me', { bearer });
  const user = res.data?.owner || res.data?.user || res.data || null;
  meCache.set(bearer, { user, exp: Date.now() + ME_TTL_MS });
  return user;
}

export function authMiddleware(req, res, next) {
  // ops-токен
  const adminToken = process.env.ADMIN_API_TOKEN;
  if (adminToken && req.get('x-admin-token') === adminToken) {
    req.user = { id: 'ops', name: 'Ops', viaToken: true };
    return next();
  }

  const bearer = readBearer(req);
  if (!bearer) {
    return res.status(401).json({ error: 'NOT_AUTHENTICATED', message: 'Откройте приложение внутри Битрикс24.' });
  }
  resolveUser(bearer)
    .then((user) => {
      if (!user) return res.status(401).json({ error: 'INVALID_SESSION' });
      req.user = user;
      req.vibeBearer = bearer;
      next();
    })
    .catch((e) => {
      res.status(401).json({ error: 'AUTH_FAILED', message: e.message });
    });
}

// Лёгкая проверка личности для index (не блокирует, просто прокидывает).
export async function optionalUser(req) {
  const bearer = readBearer(req);
  if (!bearer) return null;
  try { return await resolveUser(bearer); } catch { return null; }
}
