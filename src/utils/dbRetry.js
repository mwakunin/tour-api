// src/utils/dbRetry.js
import logger from '#config/logger.js';

// The pool is module-level and never recreated, so once pool.end() has run
// postgres.js rejects every later query in handler() with CONNECTION_ENDED —
// permanently, since `ending` is latched. Retrying that can only burn the
// backoff budget and delay a shutdown before failing with the same error.
// CONNECTION_DESTROYED is deliberately *not* here: connect() clears the
// connection's `terminated` flag, so a destroyed connection is reusable as
// long as the pool itself is still open. During an actual shutdown the next
// attempt hits the ended pool and bails out on CONNECTION_ENDED anyway.
const TERMINAL_CODES = new Set(['CONNECTION_ENDED']);

// Network-level failures are worth another attempt whatever their message
// text says. Checked before the bail-out list below, because a dropped or
// timed-out connection can phrase itself in ways that list would catch.
const TRANSIENT_CODES = new Set([
  'CONNECT_TIMEOUT',
  'CONNECTION_CLOSED',
  'CONNECTION_DESTROYED',
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EPIPE',
  'EAI_AGAIN',
]);

/**
 * Retry a database query with exponential backoff
 */
export const withRetry = async (fn, maxRetries = 3) => {
  let lastError;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      // Terminal pool state — nothing left to reconnect to, so bail out
      // before the backoff rather than retrying into the same rejection.
      if (TERMINAL_CODES.has(error.code)) {
        throw error;
      }

      // Retry ONLY what is known to be transient. The previous condition threw
      // for non-transient errors that also matched a message or code pattern,
      // which meant every other non-transient failure — check violations,
      // foreign-key violations, ordinary bugs — fell through and was retried.
      // Retrying a non-idempotent write is how one payment becomes several.
      if (!TRANSIENT_CODES.has(error.code)) {
        throw error;
      }

      if (attempt < maxRetries) {
        const delay = Math.min(1000 * Math.pow(2, attempt - 1), 5000);
        logger.warn(
          `[DB Retry] Attempt ${attempt} failed, retrying in ${delay}ms:`,
          error.message
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  logger.error('[DB Retry] All retry attempts failed:', lastError);
  throw lastError;
};
