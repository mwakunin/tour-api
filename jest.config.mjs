// ============================================
// FILE: jest.config.js (root of server/)
// ============================================
export default {
  // Test environment
  testEnvironment: 'node', // ✅ Fixed - was 'jest-circus/environment'
  setupFilesAfterEnv: ['<rootDir>/src/__tests__/setup.js'],
  // No transformation needed for ES modules
  transform: {},

  // ✅ Add global setup/teardown
  globalSetup: '<rootDir>/src/__tests__/globalSetup.js',
  globalTeardown: '<rootDir>/src/__tests__/globalTeardown.js',

  // Path aliases matching your project structure
  moduleNameMapper: {
    '^#config/(.*)$': '<rootDir>/src/config/$1',
    '^#controllers/(.*)$': '<rootDir>/src/controllers/$1',
    '^#middleware/(.*)$': '<rootDir>/src/middleware/$1',
    '^#models/(.*)$': '<rootDir>/src/models/$1',
    '^#routes/(.*)$': '<rootDir>/src/routes/$1',
    '^#services/(.*)$': '<rootDir>/src/services/$1',
    '^#utils/(.*)$': '<rootDir>/src/utils/$1',
    '^#validations/(.*)$': '<rootDir>/src/validations/$1',
  },

  // Test file patterns
  testMatch: ['**/__tests__/**/*.test.js'],

  // Setup file to run before tests
  //setupFilesAfterEnv: [
  //  '<rootDir>/src/__tests__/setup.js',
  // '<rootDir>/jest.setup.js',
  //],

  // Test runner
  testRunner: 'jest-circus/runner',

  // Test execution settings
  testTimeout: 30000,
  verbose: true,
  maxWorkers: 1,
  detectOpenHandles: true,
  forceExit: true,

  // ============================================
  // COVERAGE CONFIGURATION
  // ============================================
  collectCoverage: false,

  collectCoverageFrom: [
    'src/**/*.js',
    '!src/**/*.test.js',
    '!src/__tests__/**',
    '!src/config/database.js',
    '!src/config/redis.js',
    '!src/index.js',
    '!src/server.js',
    '!src/app.js',
    '!src/migrations/**',
    '!src/seeds/**',
    '!src/drizzle/**',
    '!node_modules/**',
  ],

  coverageDirectory: 'coverage',

  coverageReporters: ['text', 'text-summary', 'html', 'lcov', 'json'],

  coverageThreshold: {
    global: {
      branches: 35,
      functions: 45,
      lines: 50,
      statements: 50,
    },
    './src/services/users.service.js': {
      branches: 90,
      functions: 100,
      lines: 90,
      statements: 90,
    },
    './src/services/payment.service.js': {
      branches: 60,
      functions: 75,
      lines: 70,
      statements: 70,
    },
  },

  // ============================================
  // ADDITIONAL SETTINGS
  // ============================================
  clearMocks: true,
  resetMocks: false,
  restoreMocks: false,
  errorOnDeprecated: true,

  modulePathIgnorePatterns: [
    '<rootDir>/dist/',
    '<rootDir>/build/',
    '<rootDir>/coverage/',
  ],

  watchPathIgnorePatterns: ['/node_modules/', '/coverage/', '/dist/'],
};
