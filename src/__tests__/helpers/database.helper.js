// src/__tests__/helpers/database.helper.js
export const ensureTestDatabase = () => {
  const dbUrl = process.env.DATABASE_URL || '';

  if (process.env.NODE_ENV === 'test' && !dbUrl.includes('test')) {
    throw new Error('❌ Test database not configured properly!');
  }
};

// Call this in setup.js
