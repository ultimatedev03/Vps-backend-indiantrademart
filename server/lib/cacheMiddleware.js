/**
 * Express middleware for Redis-backed API response caching.
 *
 * Usage:
 *   import { cacheResponse, invalidateCache } from '../lib/cacheMiddleware.js';
 *
 *   router.get('/states', cacheResponse('dir:states', 3600), handler);
 *
 *   // Invalidate after a write:
 *   await invalidateCache('dir:states');
 *   await invalidatePattern('dir:*');            // flush a whole domain
 */

import { isRedisConfigured, cacheGetJson, cacheSetJson, redisCommand } from './redisCache.js';
import { logger } from '../utils/logger.js';

const CACHE_PREFIX = 'apicache:';

/**
 * Build a cache key from prefix + sorted query params.
 */
const buildCacheKey = (prefix, query = {}) => {
  const parts = Object.entries(query)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  return `${CACHE_PREFIX}${prefix}${parts ? ':' + parts : ''}`;
};

/**
 * Express middleware that caches successful JSON responses in Redis.
 *
 * @param {string}  keyPrefix   Logical namespace, e.g. 'dir:states'
 * @param {number}  ttlSeconds  Time-to-live in seconds (default 300 = 5 min)
 * @param {object}  [opts]
 * @param {boolean} [opts.includeQuery=true]  Whether to include query params in cache key
 * @param {boolean} [opts.includeParams=false] Whether to include route params in cache key
 */
export const cacheResponse = (keyPrefix, ttlSeconds = 300, opts = {}) => {
  const { includeQuery = true, includeParams = false } = opts;

  return async (req, res, next) => {
    if (!isRedisConfigured()) return next();

    try {
      const queryParts = includeQuery ? req.query : {};
      const paramParts = includeParams ? req.params : {};
      const key = buildCacheKey(keyPrefix, { ...queryParts, ...paramParts });

      const cached = await cacheGetJson(key);
      if (cached !== null && cached !== undefined) {
        res.setHeader('X-Cache', 'HIT');
        return res.json(cached);
      }

      // Intercept res.json to capture and cache the payload
      const originalJson = res.json.bind(res);
      res.json = (body) => {
        // Only cache successful responses
        if (res.statusCode >= 200 && res.statusCode < 300) {
          cacheSetJson(key, body, ttlSeconds).catch((err) => {
            logger.warn('[Cache] Failed to set cache:', err?.message);
          });
        }
        res.setHeader('X-Cache', 'MISS');
        return originalJson(body);
      };

      next();
    } catch (err) {
      logger.warn('[Cache] Middleware error, skipping cache:', err?.message);
      next();
    }
  };
};

/**
 * Delete a single cache key.
 */
export const invalidateCache = async (keyPrefix) => {
  if (!isRedisConfigured()) return;
  try {
    const key = `${CACHE_PREFIX}${keyPrefix}`;
    await redisCommand(['DEL', key]);
  } catch (err) {
    logger.warn('[Cache] Invalidate failed:', err?.message);
  }
};

/**
 * Delete all cache keys matching a pattern (e.g. 'dir:*').
 * Uses SCAN + DEL for safety (no KEYS in production).
 */
export const invalidatePattern = async (pattern) => {
  if (!isRedisConfigured()) return;
  try {
    const fullPattern = `${CACHE_PREFIX}${pattern}`;
    let cursor = '0';
    let iterations = 0;
    const MAX_ITERATIONS = 100;

    do {
      const result = await redisCommand(['SCAN', cursor, 'MATCH', fullPattern, 'COUNT', '100']);
      if (!Array.isArray(result) || result.length < 2) break;

      cursor = String(result[0]);
      const keys = result[1];

      if (Array.isArray(keys) && keys.length > 0) {
        await redisCommand(['DEL', ...keys]);
      }

      iterations += 1;
    } while (cursor !== '0' && iterations < MAX_ITERATIONS);
  } catch (err) {
    logger.warn('[Cache] Pattern invalidation failed:', err?.message);
  }
};

/**
 * Convenience: flush all dir-related cache (call after category/product writes).
 */
export const invalidateDirCache = () => invalidatePattern('dir:*');
