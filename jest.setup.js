// jest.setup.js (in server root)
import 'dotenv/config';
import { jest } from '@jest/globals';
import { db } from './src/config/database.js';
import redis from './src/config/redis.js';

// Mock environment variables
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-jwt-secret';
process.env.SESSION_SECRET = 'test-session-secret';

// Global timeout
jest.setTimeout(30000);

// ✅ ONE-TIME CLEANUP before ALL tests start
beforeAll(async () => {
  console.log('🧪 Global Test Setup Starting...');
  console.log('📊 Environment:', process.env.NODE_ENV);

  try {
    // Clear Redis once at the start
    if (redis && redis.status === 'ready') {
      await redis.flushdb();
      console.log('🧹 Redis flushed');
    }

    // Optional: Clear test database tables
    // Only do this if you want a completely clean start
    // Comment out if you want to preserve data between test runs

    console.log('🧹 Cleaning test database...');
    await db.execute('TRUNCATE TABLE bookings CASCADE');
    await db.execute('TRUNCATE TABLE tours CASCADE');
    await db.execute('TRUNCATE TABLE destinations CASCADE');
    await db.execute('TRUNCATE TABLE users CASCADE');

    console.log('✅ Global setup complete');
  } catch (error) {
    console.error('❌ Global setup failed:', error);
    throw error;
  }
});

// ✅ FINAL CLEANUP after ALL tests finish
afterAll(async () => {
  console.log('🧹 Global Test Cleanup...');

  try {
    // Close Redis
    if (redis && redis.status === 'ready') {
      await redis.quit();
      console.log('🔌 Redis closed');
    }
  } catch (error) {
    if (!error.message?.includes('Connection is closed')) {
      console.error('❌ Redis cleanup error:', error.message);
    }
  }
});

// ✅ Clear mocks after each test (applies to ALL tests)
afterEach(() => {
  jest.clearAllMocks();
});
