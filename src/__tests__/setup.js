import './loadTestEnv.js';
import { beforeAll, afterAll } from '@jest/globals';
import { pool } from '#config/database.js';

beforeAll(() => {
  console.log('🧪 Test suite starting...');
  console.log('📊 Environment:', process.env.NODE_ENV);
  console.log('🗄️  Database:', process.env.DATABASE_URL);

  const dbUrl = process.env.DATABASE_URL || '';

  let hostname;
  try {
    hostname = new URL(dbUrl).hostname;
  } catch {
    throw new Error(
      '🚨 TESTS BLOCKED: DATABASE_URL is not a valid database URL.'
    );
  }

  const isLocalDb = ['localhost', '127.0.0.1', '[::1]'].includes(hostname);

  if (!isLocalDb) {
    throw new Error(
      '🚨 TESTS BLOCKED: DATABASE_URL does not point to a local database.'
    );
  }

  console.log('✅ Safe to run tests - using local database');
  console.log('📦 Test file setup complete');
});

afterAll(async () => {
  console.log('🧹 Test suite cleanup...');

  try {
    if (pool && !pool.ending && !pool.ended) {
      await pool.end();
      console.log('🔌 Database pool closed');
    }
  } catch (error) {
    if (!error.message?.includes('Cannot use a pool after calling end')) {
      console.error('❌ Error closing pool:', error.message);
    }
  }

  console.log('✅ Test suite completed');
});
