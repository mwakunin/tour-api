// src/utils/cache.js
import redis from '#config/redis.js';
import logger from '#config/logger.js';

class Cache {
  constructor(redisClient) {
    this.redis = redisClient;
    this.isHealthy = true;

    // Track Redis connection state
    this.redis.on('error', (err) => {
      this.isHealthy = false;
      logger.error('[Cache] Redis error:', err.message);
    });

    this.redis.on('connect', () => {
      this.isHealthy = true;
      logger.info('[Cache] Redis connected');
    });

    this.redis.on('ready', () => {
      this.isHealthy = true;
      logger.info('[Cache] Redis ready');
    });
  }

  /**
   * Get cached data
   */
  async get(key) {
    if (!this.isHealthy) {
      logger.warn('[Cache] Redis unhealthy, skipping get');
      return null;
    }

    try {
      const data = await this.redis.get(key);
      if (data) {
        logger.debug(`[Cache] Hit: ${key}`);
        return JSON.parse(data);
      }
      logger.debug(`[Cache] Miss: ${key}`);
      return null;
    } catch (error) {
      logger.error(`[Cache] Get error for ${key}:`, error.message);
      return null;
    }
  }

  /**
   * Set cache data with TTL
   */
  async set(key, value, ttl = 3600) {
    if (!this.isHealthy) {
      logger.warn('[Cache] Redis unhealthy, skipping set');
      return;
    }

    try {
      await this.redis.setex(key, ttl, JSON.stringify(value));
      logger.debug(`[Cache] Set: ${key} (TTL: ${ttl}s)`);
    } catch (error) {
      logger.error(`[Cache] Set error for ${key}:`, error.message);
    }
  }

  /**
   * Delete cached data
   */
  async del(...keys) {
    if (!this.isHealthy || keys.length === 0) {
      return;
    }

    try {
      await this.redis.del(...keys);
      logger.debug(`[Cache] Deleted: ${keys.join(', ')}`);
    } catch (error) {
      logger.error('[Cache] Delete error:', error.message);
    }
  }

  /**
   * Delete all keys matching a pattern
   * WARNING: KEYS command can be slow on large datasets
   * Consider using SCAN in production with large key counts
   */
  async delPattern(pattern) {
    if (!this.isHealthy) {
      return;
    }

    try {
      const keys = await this.redis.keys(pattern);
      if (keys.length > 0) {
        await this.redis.del(...keys);
        logger.debug(
          `[Cache] Deleted ${keys.length} keys matching: ${pattern}`
        );
      }
    } catch (error) {
      logger.error(
        `[Cache] Delete pattern error for ${pattern}:`,
        error.message
      );
    }
  }

  /**
   * Delete using SCAN (better for production with many keys)
   * Use this instead of delPattern for patterns with potentially many matches
   */
  async delPatternSafe(pattern) {
    if (!this.isHealthy) {
      return;
    }

    try {
      let cursor = '0';
      let deletedCount = 0;

      do {
        const [newCursor, keys] = await this.redis.scan(
          cursor,
          'MATCH',
          pattern,
          'COUNT',
          100
        );
        cursor = newCursor;

        if (keys.length > 0) {
          await this.redis.del(...keys);
          deletedCount += keys.length;
        }
      } while (cursor !== '0');

      if (deletedCount > 0) {
        logger.debug(
          `[Cache] Deleted ${deletedCount} keys matching: ${pattern}`
        );
      }
    } catch (error) {
      logger.error(
        `[Cache] Delete pattern safe error for ${pattern}:`,
        error.message
      );
    }
  }

  /**
   * Delete multiple specific keys
   */
  async delMany(keys) {
    if (!this.isHealthy || keys.length === 0) {
      return;
    }

    try {
      await this.redis.del(...keys);
      logger.debug(`[Cache] Deleted ${keys.length} keys`);
    } catch (error) {
      logger.error('[Cache] Delete many error:', error.message);
    }
  }

  /**
   * Check if key exists
   */
  async exists(key) {
    if (!this.isHealthy) {
      return false;
    }

    try {
      const result = await this.redis.exists(key);
      return result === 1;
    } catch (error) {
      logger.error(`[Cache] Exists error for ${key}:`, error.message);
      return false;
    }
  }

  /**
   * Get remaining TTL for a key
   */
  async ttl(key) {
    if (!this.isHealthy) {
      return -1;
    }

    try {
      return await this.redis.ttl(key);
    } catch (error) {
      logger.error(`[Cache] TTL error for ${key}:`, error.message);
      return -1;
    }
  }

  /**
   * Cache wrapper - get from cache or execute function
   * This is your main caching pattern
   */
  async wrap(key, ttl, fn) {
    try {
      // Try cache first
      const cached = await this.get(key);
      if (cached !== null) {
        return { data: cached, cached: true };
      }

      // Cache miss - execute function
      const result = await fn();

      // Cache the result (fire and forget to avoid blocking)
      if (result !== null && result !== undefined) {
        this.set(key, result, ttl).catch((err) => {
          logger.error(
            `[Cache] Background set failed for ${key}:`,
            err.message
          );
        });
      }

      return { data: result, cached: false };
    } catch (error) {
      logger.error(`[Cache] Wrap error for ${key}:`, error.message);
      // On error, just execute the function without caching
      const result = await fn();
      return { data: result, cached: false };
    }
  }

  /**
   * Increment a counter
   */
  async incr(key) {
    if (!this.isHealthy) {
      return 0;
    }

    try {
      return await this.redis.incr(key);
    } catch (error) {
      logger.error(`[Cache] Increment error for ${key}:`, error.message);
      return 0;
    }
  }

  /**
   * Decrement a counter
   */
  async decr(key) {
    if (!this.isHealthy) {
      return 0;
    }

    try {
      return await this.redis.decr(key);
    } catch (error) {
      logger.error(`[Cache] Decrement error for ${key}:`, error.message);
      return 0;
    }
  }

  /**
   * Set expiration on existing key
   */
  async expire(key, seconds) {
    if (!this.isHealthy) {
      return;
    }

    try {
      await this.redis.expire(key, seconds);
      logger.debug(`[Cache] Set expiry: ${key} (${seconds}s)`);
    } catch (error) {
      logger.error(`[Cache] Expire error for ${key}:`, error.message);
    }
  }

  /**
   * Flush all cache (use with caution!)
   */
  async flushAll() {
    if (!this.isHealthy) {
      return;
    }

    try {
      await this.redis.flushall();
      logger.warn('[Cache] Flushed all cache');
    } catch (error) {
      logger.error('[Cache] Flush all error:', error.message);
    }
  }

  /**
   * Get Redis info for monitoring
   */
  async getInfo() {
    if (!this.isHealthy) {
      return { healthy: false };
    }

    try {
      const _info = await this.redis.info();
      const dbSize = await this.redis.dbsize();

      return {
        healthy: true,
        dbSize,
        connected: this.redis.status === 'ready',
      };
    } catch (error) {
      logger.error('[Cache] Get info error:', error.message);
      return { healthy: false };
    }
  }
}

export const cache = new Cache(redis);
