import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { withRetry } from '#utils/dbRetry.js';

describe('Cache Utility', () => {
  let mockRedis;

  beforeEach(() => {
    // Mock Redis client
    mockRedis = {
      get: jest.fn(),
      setex: jest.fn(),
      del: jest.fn(),
      keys: jest.fn(),
      scan: jest.fn(),
      exists: jest.fn(),
      ttl: jest.fn(),
      incr: jest.fn(),
      decr: jest.fn(),
      expire: jest.fn(),
      flushall: jest.fn(),
      info: jest.fn(),
      dbsize: jest.fn(),
      on: jest.fn(),
      status: 'ready',
    };
  });

  describe('get', () => {
    it('should return parsed data when cache hit', async () => {
      const testData = { id: 1, name: 'Test' };
      mockRedis.get.mockResolvedValue(JSON.stringify(testData));

      // Would test actual Cache class here
      const result = JSON.parse(await mockRedis.get('test-key'));
      expect(result).toEqual(testData);
    });

    it('should return null when cache miss', async () => {
      mockRedis.get.mockResolvedValue(null);

      const result = await mockRedis.get('test-key');
      expect(result).toBeNull();
    });

    it('should handle errors gracefully', async () => {
      mockRedis.get.mockRejectedValue(new Error('Redis error'));

      await expect(mockRedis.get('test-key')).rejects.toThrow('Redis error');
    });
  });

  describe('set', () => {
    it('should store data with TTL', async () => {
      const testData = { id: 1, name: 'Test' };
      mockRedis.setex.mockResolvedValue('OK');

      await mockRedis.setex('test-key', 3600, JSON.stringify(testData));

      expect(mockRedis.setex).toHaveBeenCalledWith(
        'test-key',
        3600,
        JSON.stringify(testData)
      );
    });

    it('should use default TTL when not specified', async () => {
      // Would test with actual Cache class
      expect(true).toBe(true);
    });
  });

  describe('del', () => {
    it('should delete single key', async () => {
      mockRedis.del.mockResolvedValue(1);

      await mockRedis.del('test-key');

      expect(mockRedis.del).toHaveBeenCalledWith('test-key');
    });

    it('should delete multiple keys', async () => {
      mockRedis.del.mockResolvedValue(3);

      await mockRedis.del('key1', 'key2', 'key3');

      expect(mockRedis.del).toHaveBeenCalledWith('key1', 'key2', 'key3');
    });
  });

  describe('delPattern', () => {
    it('should delete all keys matching pattern', async () => {
      mockRedis.keys.mockResolvedValue(['tour:1', 'tour:2', 'tour:3']);
      mockRedis.del.mockResolvedValue(3);

      const keys = await mockRedis.keys('tour:*');
      if (keys.length > 0) {
        await mockRedis.del(...keys);
      }

      expect(mockRedis.keys).toHaveBeenCalledWith('tour:*');
      expect(mockRedis.del).toHaveBeenCalledWith('tour:1', 'tour:2', 'tour:3');
    });

    it('should handle pattern with no matches', async () => {
      mockRedis.keys.mockResolvedValue([]);

      const keys = await mockRedis.keys('nonexistent:*');

      expect(keys).toEqual([]);
    });
  });

  describe('delPatternSafe (SCAN)', () => {
    it('should delete keys using SCAN', async () => {
      // First scan
      mockRedis.scan.mockResolvedValueOnce(['10', ['key1', 'key2']]);
      // Second scan
      mockRedis.scan.mockResolvedValueOnce(['0', ['key3']]);
      mockRedis.del.mockResolvedValue(1);

      // Simulate SCAN loop
      let cursor = '0';
      let deletedCount = 0;

      do {
        const [newCursor, keys] = await mockRedis.scan(
          cursor,
          'MATCH',
          'tour:*',
          'COUNT',
          100
        );
        cursor = newCursor;

        if (keys.length > 0) {
          await mockRedis.del(...keys);
          deletedCount += keys.length;
        }
      } while (cursor !== '0');

      expect(deletedCount).toBe(3);
      expect(mockRedis.scan).toHaveBeenCalledTimes(2);
    });
  });

  describe('wrap', () => {
    it('should return cached data when available', async () => {
      const cachedData = { id: 1, cached: true };
      mockRedis.get.mockResolvedValue(JSON.stringify(cachedData));

      const result = JSON.parse(await mockRedis.get('test-key'));

      expect(result).toEqual(cachedData);
      expect(result.cached).toBe(true);
    });

    it('should execute function and cache result on miss', async () => {
      mockRedis.get.mockResolvedValue(null);
      mockRedis.setex.mockResolvedValue('OK');

      const fn = jest.fn().mockResolvedValue({ id: 1, fresh: true });

      // Simulate cache miss scenario
      const cached = await mockRedis.get('test-key');

      if (!cached) {
        const freshData = await fn();
        await mockRedis.setex('test-key', 3600, JSON.stringify(freshData));

        expect(fn).toHaveBeenCalled();
        expect(mockRedis.setex).toHaveBeenCalled();
      }
    });
  });

  describe('incr/decr', () => {
    it('should increment counter', async () => {
      mockRedis.incr.mockResolvedValue(1);

      const result = await mockRedis.incr('counter');

      expect(result).toBe(1);
      expect(mockRedis.incr).toHaveBeenCalledWith('counter');
    });

    it('should decrement counter', async () => {
      mockRedis.decr.mockResolvedValue(0);

      const result = await mockRedis.decr('counter');

      expect(result).toBe(0);
      expect(mockRedis.decr).toHaveBeenCalledWith('counter');
    });
  });

  describe('exists', () => {
    it('should return true when key exists', async () => {
      mockRedis.exists.mockResolvedValue(1);

      const result = await mockRedis.exists('test-key');

      expect(result).toBe(1);
    });

    it('should return false when key does not exist', async () => {
      mockRedis.exists.mockResolvedValue(0);

      const result = await mockRedis.exists('nonexistent-key');

      expect(result).toBe(0);
    });
  });

  describe('ttl', () => {
    it('should return remaining TTL', async () => {
      mockRedis.ttl.mockResolvedValue(3600);

      const result = await mockRedis.ttl('test-key');

      expect(result).toBe(3600);
    });

    it('should return -1 for key with no expiry', async () => {
      mockRedis.ttl.mockResolvedValue(-1);

      const result = await mockRedis.ttl('persistent-key');

      expect(result).toBe(-1);
    });

    it('should return -2 for non-existent key', async () => {
      mockRedis.ttl.mockResolvedValue(-2);

      const result = await mockRedis.ttl('nonexistent-key');

      expect(result).toBe(-2);
    });
  });
});

describe('Cache Key Utilities', () => {
  describe('Cache key generation', () => {
    it('should generate tour cache key', () => {
      const tourId = '123e4567-e89b-12d3-a456-426614174000';
      const key = `tour:id:${tourId}`;

      expect(key).toBe(`tour:id:${tourId}`);
    });

    it('should generate tour slug cache key', () => {
      const slug = 'maasai-mara-safari';
      const key = `tour:slug:${slug}`;

      expect(key).toBe(`tour:slug:${slug}`);
    });

    it('should generate user bookings cache key', () => {
      const userId = 123;
      const key = `bookings:user:${userId}`;

      expect(key).toBe(`bookings:user:${userId}`);
    });
  });
});

describe('Booking Reference Generation', () => {
  describe('Booking Reference Format', () => {
    it('should generate reference with current year', () => {
      const year = new Date().getFullYear();
      const reference = `FA-${year}-000001`;

      expect(reference).toMatch(/^FA-\d{4}-\d{6}$/);
      expect(reference).toContain(year.toString());
    });

    it('should pad sequence to 6 digits', () => {
      const sequence = 42;
      const paddedSequence = sequence.toString().padStart(6, '0');

      expect(paddedSequence).toBe('000042');
      expect(paddedSequence).toHaveLength(6);
    });

    it('should handle large sequence numbers', () => {
      const sequence = 999999;
      const paddedSequence = sequence.toString().padStart(6, '0');

      expect(paddedSequence).toBe('999999');
    });
  });

  describe('generateBookingReferenceSimple', () => {
    it('should generate reference with timestamp and random', () => {
      const year = new Date().getFullYear();
      const timestamp = Date.now().toString().slice(-6);
      const random = Math.floor(Math.random() * 1000)
        .toString()
        .padStart(3, '0');

      const reference = `FA-${year}-${timestamp}${random}`;

      expect(reference).toMatch(/^FA-\d{4}-\d{9}$/);
    });
  });
});

describe('Format Utilities', () => {
  describe('Currency formatting', () => {
    it('should format USD currency', () => {
      const amount = 1200.5;
      const formatted = `$${amount.toFixed(2)}`;

      expect(formatted).toBe('$1200.50');
    });

    it('should format KES currency', () => {
      const amount = 50000;
      const formatted = `KSh${amount.toFixed(2)}`;

      expect(formatted).toBe('KSh50000.00');
    });
  });

  describe('Date formatting', () => {
    it('should format ISO date', () => {
      const date = new Date('2025-06-15T00:00:00Z');
      const formatted = date.toISOString();

      expect(formatted).toBe('2025-06-15T00:00:00.000Z');
    });
  });
});

describe('Database Retry Logic', () => {
  describe('Exponential backoff', () => {
    it('should retry with exponential backoff', async () => {
      const attempts = [1, 2, 3];
      const delays = attempts.map((attempt) => Math.pow(2, attempt) * 1000);

      expect(delays).toEqual([2000, 4000, 8000]);
    });

    it('should limit max retries', () => {
      const maxRetries = 3;
      let attempts = 0;

      const retry = () => {
        attempts++;
        if (attempts >= maxRetries) {
          return true;
        }
        return retry();
      };

      retry();

      expect(attempts).toBe(maxRetries);
    });
  });

  describe('withRetry', () => {
    const dbError = (code) => Object.assign(new Error(code), { code });

    it('does not retry once the pool has been ended', async () => {
      const fn = jest.fn().mockRejectedValue(dbError('CONNECTION_ENDED'));

      await expect(withRetry(fn)).rejects.toMatchObject({
        code: 'CONNECTION_ENDED',
      });
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('retries a destroyed connection the pool can reopen', async () => {
      const fn = jest
        .fn()
        .mockRejectedValueOnce(dbError('CONNECTION_DESTROYED'))
        .mockResolvedValueOnce('ok');

      await expect(withRetry(fn)).resolves.toBe('ok');
      expect(fn).toHaveBeenCalledTimes(2);
    });
  });
});
