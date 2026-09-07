import { cache } from '#utils/cache.js';
import logger from '#config/logger.js';

/**
 * Generic cache middleware for GET requests
 * @param {string} keyPrefix - Prefix for cache key
 * @param {number} ttl - Time to live in seconds
 * @param {function} keyGenerator - Function to generate cache key from request
 */
export const cacheMiddleware = (keyPrefix, ttl = 3600, keyGenerator = null) => {
  return async (req, res, next) => {
    // Only cache GET requests
    if (req.method !== 'GET') {
      return next();
    }

    try {
      // Generate cache key
      const cacheKey = keyGenerator
        ? keyGenerator(req)
        : `${keyPrefix}:${req.originalUrl}`;

      // Try to get from cache
      const cached = await cache.get(cacheKey);

      if (cached) {
        logger.debug(`[Cache Middleware] Hit: ${cacheKey}`);
        // Arrays must be returned as arrays. `{...cached}` turns [a, b] into
        // {0: a, 1: b, cached: true}, so a list endpoint changed JSON type
        // depending on whether the cache was warm. The marker is only
        // meaningful on an object response anyway.
        if (Array.isArray(cached)) {
          return res.json(cached);
        }
        return res.json({
          ...cached,
          cached: true,
        });
      }

      // Store original json method
      const originalJson = res.json.bind(res);

      // Override json method to cache response
      res.json = function (data) {
        // Only cache successful responses
        if (res.statusCode >= 200 && res.statusCode < 300) {
          cache.set(cacheKey, data, ttl).catch((err) => {
            logger.error(`[Cache Middleware] Set error: ${err.message}`);
          });
        }

        return originalJson(data);
      };

      next();
    } catch (error) {
      logger.error('[Cache Middleware] Error:', error);
      next(); // Continue without cache on error
    }
  };
};

/**
 * Middleware to invalidate cache patterns after mutations
 * @param {string[]} patterns - Array of cache key patterns to invalidate
 */
export const invalidateCacheMiddleware = (patterns) => {
  return (req, res, next) => {
    // Store original methods
    const originalJson = res.json.bind(res);
    const originalSend = res.send.bind(res);

    const invalidateCache = async () => {
      if (res.statusCode >= 200 && res.statusCode < 300) {
        for (const pattern of patterns) {
          try {
            await cache.delPattern(pattern);
            logger.debug(`[Cache Invalidation] Cleared: ${pattern}`);
          } catch (error) {
            logger.error(
              `[Cache Invalidation] Error clearing ${pattern}:`,
              error
            );
          }
        }
      }
    };

    // Express 5 implements res.json() as `return this.send(body)`, so
    // originalJson(data) re-enters the overridden res.send below and started a
    // second full invalidation while the first was still in flight. One
    // promise per response, reused by whichever wrapper runs.
    let inFlight = null;
    const invalidateOnce = () => (inFlight ??= invalidateCache());

    // Await the invalidation before the response goes out. Firing it and
    // returning immediately let a client read its own write back from a stale
    // cache, because the response could land before delPattern finished.
    res.json = function (data) {
      invalidateOnce().then(
        () => originalJson(data),
        (error) => {
          logger.error('[Cache] Invalidation failed:', error.message);
          originalJson(data);
        }
      );
      return res;
    };

    res.send = function (data) {
      invalidateOnce().then(
        () => originalSend(data),
        (error) => {
          logger.error('[Cache] Invalidation failed:', error.message);
          originalSend(data);
        }
      );
      return res;
    };

    next();
  };
};
