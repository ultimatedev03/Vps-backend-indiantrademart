import { cacheGetJson, cacheSetJson, isRedisConfigured } from './redisCache.js';

const AUTH_LOOKUP_CACHE_KEY = 'auth_lookup:email_to_auth_user_id:v1';
const AUTH_LOOKUP_CACHE_TTL_SECONDS = 60;

let memoryCacheAt = 0;
let memoryCache = new Map();

const normalizeEmail = (value) => String(value || '').trim().toLowerCase();
const normalizeId = (value) => String(value || '').trim();

const toPlainObject = (map) => {
  const payload = {};
  map.forEach((id, email) => {
    const safeEmail = normalizeEmail(email);
    const safeId = normalizeId(id);
    if (safeEmail && safeId) payload[safeEmail] = safeId;
  });
  return payload;
};

const toLookupMap = (value) => {
  if (!value) return new Map();
  if (value instanceof Map) return value;

  const map = new Map();
  if (Array.isArray(value)) {
    value.forEach((entry) => {
      const email = normalizeEmail(entry?.email);
      const id = normalizeId(entry?.id);
      if (email && id) map.set(email, id);
    });
    return map;
  }

  Object.entries(value).forEach(([email, id]) => {
    const safeEmail = normalizeEmail(email);
    const safeId = normalizeId(id);
    if (safeEmail && safeId) map.set(safeEmail, safeId);
  });
  return map;
};

export const buildAuthLookupMap = (users = []) => {
  const map = new Map();
  (users || []).forEach((user) => {
    const email = normalizeEmail(user?.email);
    const id = normalizeId(user?.id);
    if (email && id) map.set(email, id);
  });
  return map;
};

export const loadAuthLookupCache = async ({
  force = false,
  cacheKey = AUTH_LOOKUP_CACHE_KEY,
  ttlSeconds = AUTH_LOOKUP_CACHE_TTL_SECONDS,
  loader,
} = {}) => {
  const now = Date.now();
  if (!force && memoryCache.size > 0 && now - memoryCacheAt <= ttlSeconds * 1000) {
    return memoryCache;
  }

  if (!force && isRedisConfigured()) {
    try {
      const cached = await cacheGetJson(cacheKey);
      const cachedMap = toLookupMap(cached);
      if (cachedMap.size > 0) {
        memoryCache = cachedMap;
        memoryCacheAt = now;
        return memoryCache;
      }
    } catch {
      // Ignore Redis read failures and continue with the loader.
    }
  }

  if (typeof loader !== 'function') {
    return memoryCache;
  }

  try {
    const loaded = await loader();
    const freshMap = toLookupMap(loaded);
    if (freshMap.size > 0) {
      memoryCache = freshMap;
      memoryCacheAt = now;
      if (isRedisConfigured()) {
        cacheSetJson(cacheKey, toPlainObject(freshMap), ttlSeconds).catch(() => null);
      }
    } else if (force) {
      memoryCacheAt = now;
    }
  } catch {
    if (force) memoryCacheAt = now;
  }

  return memoryCache;
};
