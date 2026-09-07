// src/instrument.js
// start.js loads this module before src/index.js, making it the first code to
// touch process.env — so it must resolve the environment the same way every
// other module does. It previously used `dotenv/config`, which always reads
// plain `.env`; under NODE_ENV=production that handed Sentry the development
// DSN, and only went unnoticed because both files happened to hold the same
// value.
import '#config/loadEnv.js';
import * as Sentry from '@sentry/node';
import { nodeProfilingIntegration } from '@sentry/profiling-node';

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  environment: process.env.NODE_ENV || 'development',

  // Disable debug logs in all environments
  debug: false,

  // Sample rates
  tracesSampleRate: process.env.NODE_ENV === 'production' ? 0.1 : 1.0,
  profilesSampleRate: process.env.NODE_ENV === 'production' ? 0.1 : 1.0,

  integrations: [
    Sentry.httpIntegration({ tracing: true }),
    nodeProfilingIntegration(),
    Sentry.captureConsoleIntegration({
      levels: ['error'], // Only capture console.error
    }),
  ],

  beforeSend(event, _hint) {
    // Sanitize sensitive data
    if (event.request?.headers) {
      delete event.request.headers.authorization;
      delete event.request.headers.cookie;
    }

    if (event.request?.data) {
      const sensitiveFields = ['password', 'token', 'secret', 'api_key'];
      sensitiveFields.forEach((field) => {
        if (event.request.data[field]) {
          event.request.data[field] = '[REDACTED]';
        }
      });
    }

    return event;
  },

  // Re-enable error filtering for production
  ignoreErrors: [
    'Non-Error promise rejection captured',
    'ResizeObserver loop limit exceeded',
    'NetworkError',
    'Network request failed',
  ],
});
