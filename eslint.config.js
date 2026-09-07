import js from '@eslint/js';
import prettier from 'eslint-config-prettier';

export default [
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        console: 'readonly',
        process: 'readonly',
        Buffer: 'readonly',
        __dirname: 'readonly',
        __filename: 'readonly',
        URL: 'readonly',
        // Node globals the config had not declared. `fetch` was already
        // erroring before this change; AbortController is used alongside it to
        // bound upstream calls.
        fetch: 'readonly',
        AbortController: 'readonly',
        AbortSignal: 'readonly',
        crypto: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        setImmediate: 'readonly',
        clearImmediate: 'readonly',
        global: 'readonly',
        exports: 'readonly',
        module: 'readonly',
        require: 'readonly',
      },
    },
    rules: {
      // Remove formatting rules - let Prettier handle them
      // ❌ REMOVE: indent, quotes, semi, comma-dangle, arrow-spacing, space-before-blocks, keyword-spacing

      // ✅ KEEP: Logic and code quality rules
      'no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
        },
      ],
      'no-console': 'off',
      'prefer-const': 'error',
      'no-var': 'error',
      'object-shorthand': 'error',
      'prefer-arrow-callback': 'error',
      'no-unused-expressions': 'error',
      'no-duplicate-imports': 'error',
      'no-template-curly-in-string': 'error',
      'require-await': 'error',
      'no-return-await': 'error',
      'prefer-template': 'warn',
      'no-nested-ternary': 'warn',
      eqeqeq: ['error', 'always'],
      curly: ['error', 'all'],
      'brace-style': ['error', '1tbs'],
    },
  },
  prettier, // ✅ Add this at the end to disable conflicting rules
  {
    // jest.setup.js sits at the repository root and matched none of these
    // globs, so its beforeAll/afterAll/afterEach read as undefined globals.
    files: [
      '**/__tests__/**/*.js',
      '**/*.test.js',
      '**/*.spec.js',
      'jest.setup.js',
    ],
    languageOptions: {
      globals: {
        describe: 'readonly',
        it: 'readonly',
        expect: 'readonly',
        beforeEach: 'readonly',
        afterEach: 'readonly',
        beforeAll: 'readonly',
        afterAll: 'readonly',
        jest: 'readonly',
        test: 'readonly',
      },
    },
    rules: {
      'no-unused-expressions': 'off',
      // Mock factories are written `jest.fn(async () => value)` so they return
      // a promise like the function they replace, and jest's setup hooks have
      // the same shape. There is nothing for them to await, so the rule only
      // fires on code that is correct as written. It stays on everywhere else.
      'require-await': 'off',
    },
  },
  {
    ignores: [
      'node_modules/**',
      'coverage/**',
      'logs/**',
      'drizzle/**',
      'dist/**',
      '.env',
      '.env.*',
    ],
  },
];
