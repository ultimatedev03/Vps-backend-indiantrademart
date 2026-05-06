const sanitizeEnvValue = (value) => {
  if (typeof value !== 'string') return '';
  let cleaned = value.trim();
  if (
    (cleaned.startsWith('"') && cleaned.endsWith('"')) ||
    (cleaned.startsWith('\'') && cleaned.endsWith('\''))
  ) {
    cleaned = cleaned.slice(1, -1).trim();
  }
  return cleaned;
};

const readEnv = (...keys) => {
  for (const key of keys) {
    const value = sanitizeEnvValue(process.env[key]);
    if (value) return value;
  }
  return '';
};

const getRedisConfig = () => ({
  url: readEnv('UPSTASH_REDIS_REST_URL', 'REDIS_REST_URL', 'KV_REST_API_URL'),
  token: readEnv('UPSTASH_REDIS_REST_TOKEN', 'REDIS_REST_TOKEN', 'KV_REST_API_TOKEN'),
});

export const isRedisConfigured = () => {
  const { url, token } = getRedisConfig();
  return Boolean(url && token);
};

export const redisCommand = async (command = []) => {
  const { url, token } = getRedisConfig();
  if (!url || !token) {
    throw new Error('Redis cache is not configured. Set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN.');
  }
  if (!Array.isArray(command) || !command.length) {
    throw new Error('Redis command is required');
  }

  const response = await fetch(url.replace(/\/+$/, ''), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ command }),
  });

  const payload = await response.json().catch(() => null);
  if (!response.ok || payload?.error) {
    throw new Error(payload?.error || `Redis command failed (${response.status})`);
  }

  return payload?.result ?? null;
};

export const cacheSetJson = async (key, value, ttlSeconds) => {
  const ttl = Number(ttlSeconds);
  const payload = JSON.stringify(value ?? null);
  if (Number.isFinite(ttl) && ttl > 0) {
    return redisCommand(['SET', key, payload, 'EX', Math.round(ttl)]);
  }
  return redisCommand(['SET', key, payload]);
};

export const cacheGetJson = async (key) => {
  const value = await redisCommand(['GET', key]);
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string') return value;
  return JSON.parse(value);
};

export const cacheDelete = async (key) => redisCommand(['DEL', key]);
