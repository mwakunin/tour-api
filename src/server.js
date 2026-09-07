import * as Sentry from '@sentry/node';
import logger from '#config/logger.js';
import { initDatabase, shutdown as dbShutdown } from '#config/database.js';
import app from './app.js';

const PORT = process.env.PORT || 3000;

(async () => {
  try {
    await initDatabase();
    console.log('[App] Starting HTTP server...');

    const server = app.listen(PORT, '0.0.0.0', () => {
      logger.info(`Server running on port ${PORT}`);
      logger.info(`Environment: ${process.env.NODE_ENV}`);
    });

    // Node's defaults (requestTimeout 300s, headersTimeout 60s) let a stalled
    // upload pin a request — and its in-memory file buffer — for five minutes.
    // 120s comfortably covers a slow multipart upload while still bounding it;
    // keepAliveTimeout sits above the usual 60s proxy idle timeout so the proxy
    // closes idle connections first, avoiding races that surface as 502s.
    server.requestTimeout = 120_000;
    server.headersTimeout = 65_000;
    server.keepAliveTimeout = 61_000;

    const gracefulShutdown = (signal) => {
      logger.info(`[App] ${signal} received, shutting down gracefully...`);
      server.close(async () => {
        logger.info('[App] Server closed');
        await dbShutdown();
        process.exit(0);
      });
      setTimeout(() => {
        logger.error('[App] Forced shutdown after timeout');
        process.exit(1);
      }, 10000);
    };

    process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
    process.on('SIGINT', () => gracefulShutdown('SIGINT'));
    process.on('uncaughtException', (error) => {
      logger.error('[App] Uncaught exception:', error);
      gracefulShutdown('UNCAUGHT_EXCEPTION');
    });
    process.on('unhandledRejection', (reason, promise) => {
      logger.error('[App] Unhandled rejection:', { promise, reason });
      gracefulShutdown('UNHANDLED_REJECTION');
    });
  } catch (error) {
    console.error('[App] Initialization failed:', error);
    logger.error('[App] Failed to initialize:', error);
    // captureConsoleIntegration hands the console.error above to Sentry, but
    // delivery is asynchronous — exiting immediately kills it in flight, which
    // is why an unreachable database never raised an alert. Wait up to 2s, then
    // exit whether or not it got through.
    await Sentry.flush(2000);
    process.exit(1);
  }
})();
