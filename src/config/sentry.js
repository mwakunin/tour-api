import * as Sentry from '@sentry/node';
import { nodeProfilingIntegration } from '@sentry/profiling-node';

export const initializeSentry = (app) => {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    // Set environment
    environment: process.env.NODE_ENV || 'development',
    // Performance Monitoring
    tracesSampleRate: process.env.NODE_ENV === 'production' ? 0.1 : 1.0,
    profilesSampleRate: process.env.NODE_ENV === 'production' ? 0.1 : 1.0,
    // Integrations
    integrations: [
      // Enable HTTP calls tracing
      Sentry.httpIntegration({ tracing: true }),
      // Profiling integration
      nodeProfilingIntegration(),
    ],
    // Filter out sensitive data
    beforeSend(event, _hint) {
      // Remove sensitive headers
      if (event.request?.headers) {
        delete event.request.headers.authorization;
        delete event.request.headers.cookie;
      }
      // Remove sensitive data from body
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
    // Ignore certain errors
    ignoreErrors: [
      'Non-Error promise rejection captured',
      'ResizeObserver loop limit exceeded',
      'NetworkError',
      'Network request failed',
    ],
  });

  // ✅ Sentry v10+ uses setupExpressErrorHandler
  Sentry.setupExpressErrorHandler(app);
};
