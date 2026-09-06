// src/config/database.js
import { setDefaultResultOrder } from 'dns';
setDefaultResultOrder('ipv4first');

import '#config/loadEnv.js';


import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import logger from './logger.js';
import { withRetry } from '#utils/dbRetry.js';
import * as schema from '#models/schema.js';


// Use DOCKER_DATABASE_URL inside Docker, fallback to DATABASE_URL for host
const isDocker = process.env.IS_DOCKER === 'true';
const connectionUrl = isDocker 
  ? process.env.DOCKER_DATABASE_URL 
  : process.env.DATABASE_URL;

// Validate required environment variables
if (!connectionUrl) {
  logger.error('[DB] DATABASE_URL environment variable is required');
  process.exit(1);
}

//const isPooler = process.env.DATABASE_URL.includes('pooler.supabase.com');
const isTransactionMode = connectionUrl.includes(':6543'); // Transaction mode uses port 6543

// A local Postgres answers in milliseconds, but Supabase's pooler needs a TLS
// handshake plus tenant auth across the network — measured at 3.3-4.7s from a
// dev machine to eu-west-2. A 10s budget leaves so little slack that a brief
// network wobble at startup surfaces as a hard CONNECT_TIMEOUT.
const isRemote = connectionUrl.includes('pooler.supabase.com');

const pool = postgres(connectionUrl, {
  max: process.env.NODE_ENV === 'production' ? 15 : 3,
  idle_timeout: 60,
  connect_timeout: isRemote ? 30 : 10,
  prepare: !isTransactionMode, // Session pooler SUPPORTS prepared statements!
  ssl:
    process.env.NODE_ENV === 'production'
      ? { rejectUnauthorized: false }
      : false,
});

// Track connection state
let isConnected = false;
let isShuttingDown = false;
let dbInitialized = false;

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
    await pool`SELECT 1`;
    isConnected = true;
    return true;
  } catch (err) {
    logger.error('[DB] Health check failed:', err.message);
    isConnected = false;
    return false;
  }
};

// Export an initialization function
export const initDatabase = async () => {
  console.log('[DB] Starting connection test...');
  console.log('[DB] Connection URL configured:', !!connectionUrl);

  // More attempts than the request-path default: a boot that lands on a
  // momentary network drop should wait it out, not kill the process.
  await withRetry(async () => {
    console.log('[DB] Attempting connection...');
    await pool`SELECT 1`;
    console.log('[DB] Query successful!');
    logger.info('[DB] Connected to database');
    if (process.env.NODE_ENV === 'development') {
      logger.debug(`[DB] Connection pool configured`);
    }
    isConnected = true;
    dbInitialized = true;
  }, 5);

  console.log('[DB] Connection test completed successfully');
};

// Graceful shutdown
const shutdown = async () => {
  if (isShuttingDown) {
    logger.warn('[DB] Shutdown already in progress');
    return;
  }

  isShuttingDown = true;
  logger.info('[DB] Closing database connection...');

  try {
    await Promise.race([
      pool.end(),
      new Promise((resolve) => setTimeout(resolve, 5000)),
    ]);
    logger.info('[DB] Database connection closed');
  } catch (err) {
    logger.error('[DB] Error during shutdown:', err);
  }
};

export { db, pool, isConnected, dbInitialized, shutdown };
