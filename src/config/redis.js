// src/config/redis.js
import Redis from 'ioredis';
import logger from './logger.js';

const isDocker = process.env.IS_DOCKER === 'true';
const redisUrl = isDocker 
  ? process.env.DOCKER_REDIS_URL 
  : process.env.REDIS_URL;

const redis = new Redis(redisUrl, {
  maxRetriesPerRequest: 3,
  enableReadyCheck: true,
  retryStrategy: (times) => {
    const delay = Math.min(times * 50, 2000);
    return delay;
  },
  reconnectOnError: (err) => {
    const targetError = 'READONLY';
    if (err.message.includes(targetError)) {
      return true;
    }
    return false;
  },
});

redis.on('connect', () => {
  logger.info('[Redis] Connected successfully');
});

redis.on('ready', () => {
  logger.info('[Redis] Ready to accept commands');
});

redis.on('error', (err) => {
  logger.error('[Redis] Connection error:', err.message);
});

redis.on('close', () => {
  logger.warn('[Redis] Connection closed');
});

export default redis;
