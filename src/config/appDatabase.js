// src/config/appDatabase.js
//
// The RLS-constrained connection.
//
// `database.js` connects as the owner, which is what migrations and the
// owner-plane need — but FORCE ROW LEVEL SECURITY still exempts a table's
// owner, so an app querying through that pool has decorative policies. This
// pool connects as `tourops_app`, which owns nothing and is NOBYPASSRLS, so
// the policies in migration 0008 actually constrain it.
//
// Every query through here must run inside `withTenantDb` (see
// tenantContext.js). Querying it without a tenant set is not a leak — it
// returns zero rows — but it is always a bug.

import { setDefaultResultOrder } from 'dns';
setDefaultResultOrder('ipv4first');

import '#config/loadEnv.js';

import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import logger from './logger.js';
import * as schema from '#models/schema.js';

const isDocker = process.env.IS_DOCKER === 'true';
const connectionUrl = isDocker
  ? process.env.DOCKER_APP_DATABASE_URL || process.env.APP_DATABASE_URL
  : process.env.APP_DATABASE_URL;

// Throw rather than process.exit. This module is imported by tests and
// tooling, and exiting at module scope kills the whole runner with no stack,
// turning a missing environment variable into an unexplained crash. A thrown
// error is reported against the import that caused it.
//
// Not defaulted to an empty string either: postgres.js would happily fall back
// to localhost defaults and fail later with a connection error that says
// nothing about the real cause.
if (!connectionUrl) {
  throw new Error(
    '[AppDB] APP_DATABASE_URL is required — the RLS-constrained runtime ' +
      'connection. Run `pnpm run db:app-role` to provision the role.'
  );
}

const isRemote = connectionUrl.includes('pooler.supabase.com');

export const appPool = postgres(connectionUrl, {
  // The app runs two pools now — this one as the owner, appDatabase as the
  // RLS-constrained runtime role — but the non-production default was still
  // sized for one. With withTenantDb opening a short transaction per
  // operation, three connections per pool was tight enough that suite runs
  // intermittently timed out acquiring one. Overridable for constrained
  // environments.
  max:
    Number(process.env.DB_POOL_MAX) ||
    (process.env.NODE_ENV === 'production' ? 15 : 10),
  idle_timeout: 60,
  connect_timeout: isRemote ? 30 : 10,
  ssl:
    process.env.NODE_ENV === 'production'
      ? { rejectUnauthorized: false }
      : false,
});

export const appDb = drizzle(appPool, {
  schema,
  logger: process.env.NODE_ENV === 'development',
});

export const shutdownAppDb = async () => {
  try {
    await appPool.end({ timeout: 5 });
  } catch (error) {
    logger.error('[AppDB] error closing pool', { error: error.message });
  }
};
