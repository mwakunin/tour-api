// src/config/database.js
import 'dotenv/config';
import { Pool, neonConfig } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-serverless';
import ws from 'ws';
import logger from './logger.js';
import { withRetry } from '#utils/dbRetry.js';
import * as schema from '#models/schema.js';

// Validate required environment variables
if (!process.env.DATABASE_URL) {
  logger.error('[DB] DATABASE_URL environment variable is required');
  process.exit(1);
}

/* Comment out the local development config if you're not using Docker
 if (process.env.NODE_ENV === 'development') {
   neonConfig.fetchEndpoint = 'http://neon-local:5432/sql';
   neonConfig.useSecureWebSocket = false;
   neonConfig.poolQueryViaFetch = true;
 }
*/

// Set WebSocket constructor
neonConfig.webSocketConstructor = ws;

// Create connection pool
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: process.env.NODE_ENV === 'production' ? 10 : 3,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
  allowExitOnIdle: process.env.NODE_ENV !== 'production',
});

// Track connection state
let isConnected = false;
let isShuttingDown = false;
let dbInitialized = false;

// Handle pool errors
pool.on('error', (err) => {
  logger.error('[DB] Unexpected pool error:', err);
  isConnected = false;
});

pool.on('connect', () => {
  logger.debug('[DB] New client connected to pool');
  isConnected = true;
});

pool.on('remove', () => {
  logger.debug('[DB] Client removed from pool');
});

// Create Drizzle instance
const db = drizzle(pool, {
  schema,
  logger: process.env.NODE_ENV === 'development',
});

// ✅ Health check function
export const checkDatabaseHealth = async () => {
  if (isShuttingDown) {
    return false;
  }

  // ✅ Don't check until init completes
  if (!dbInitialized) {
    return false;
  }

  try {
    const client = await pool.connect();
    try {
      await client.query('SELECT 1');
      isConnected = true;
      return true;
    } finally {
      client.release();
    }
  } catch (err) {
    logger.error('[DB] Health check failed:', err.message);
    isConnected = false;
    return false;
  }
};

// Export an initialization function
export const initDatabase = async () => {
  console.log('[DB] Starting connection test...');
  console.log('[DB] DATABASE_URL exists:', !!process.env.DATABASE_URL);

  await withRetry(async () => {
    console.log('[DB] Attempting connection...');
    const client = await pool.connect();
    console.log('[DB] Client connected, running query...');
    try {
      await client.query('SELECT 1');
      console.log('[DB] Query successful!');
      logger.info('[DB] Connected to Neon database');
      if (process.env.NODE_ENV === 'development') {
        logger.debug(`[DB] Pool: max=${pool.options.max} connections`);
      }
      isConnected = true;
      dbInitialized = true; // ✅ Set this flag
    } finally {
      client.release();
    }
  });

  console.log('[DB] Connection test completed successfully');
};

// Graceful shutdown
const shutdown = async () => {
  if (isShuttingDown) {
    logger.warn('[DB] Shutdown already in progress');
    return;
  }

  isShuttingDown = true;
  logger.info('[DB] Closing database pool...');

  try {
    await Promise.race([
      pool.end(),
      new Promise((resolve) => setTimeout(resolve, 5000)),
    ]);
    logger.info('[DB] Database pool closed');
  } catch (err) {
    logger.error('[DB] Error during pool shutdown:', err);
  }
};

// Shutdown handlers (production only)
if (process.env.NODE_ENV === 'production') {
  const handleShutdown = async (signal) => {
    logger.info(`[DB] Received ${signal}, closing pool...`);
    await shutdown();
    process.exit(0);
  };

  process.on('SIGTERM', handleShutdown);
  process.on('SIGINT', handleShutdown);
}

export { db, pool, isConnected, dbInitialized, shutdown };
