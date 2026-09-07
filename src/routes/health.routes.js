import express from 'express';
import { checkDatabaseHealth } from '#config/database.js';
import { cache } from '#utils/cache.js';

const router = express.Router();

router.get('/health', async (req, res) => {
  const health = {
    status: 'ok',
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || 'development',
    services: {},
  };

  const dbHealthy = await checkDatabaseHealth();
  health.services.database = dbHealthy ? 'connected' : 'disconnected';
  if (!dbHealthy) health.status = 'degraded';

  try {
    await cache.get('health-check');
    health.services.redis = 'connected';
  } catch {
    health.services.redis = 'disconnected';
    health.status = 'degraded';
  }

  const statusCode = health.status === 'ok' ? 200 : 503;
  res.status(statusCode).json(health);
});

router.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || 'development',
    uptime: process.uptime(),
    memory: process.memoryUsage(),
  });
});

export default router;
