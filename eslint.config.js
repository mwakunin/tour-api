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
    files: ['**/__tests__/**/*.js', '**/*.test.js', '**/*.spec.js'],
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
