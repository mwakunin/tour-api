import express from 'express';

import { publicSecurityMiddleware } from '#middleware/security.middleware.js';
import logger from '#config/logger.js';

const router = express.Router();

// Was hardcoded to one operator's n8n instance, which in a multi-tenant app
// means every tenant's chat traffic went to Footloose's workflow. Configured
// now; per-tenant routing belongs with the rest of the tenant settings when
// there is a second operator to route.
const CHAT_WEBHOOK_URL = process.env.CHAT_WEBHOOK_URL;

// The upstream is a workflow engine that can hang. Without a bound, a slow
// n8n holds this request — and its socket — open indefinitely.
const parsedChatTimeout = Number(process.env.CHAT_TIMEOUT_MS);
// Number('abc') is NaN and setTimeout(fn, NaN) fires immediately, so a
// mistyped value would abort every chat request instead of bounding it.
const UPSTREAM_TIMEOUT_MS =
  Number.isFinite(parsedChatTimeout) && parsedChatTimeout > 0
    ? parsedChatTimeout
    : 15000;

/**
 * POST /api/chat
 * Proxy chat requests to the configured workflow endpoint.
 */
router.post('/', publicSecurityMiddleware, async (req, res) => {
  if (!CHAT_WEBHOOK_URL) {
    logger.error('[Chat] CHAT_WEBHOOK_URL is not configured');
    return res.status(503).json({ error: 'Chat service unavailable' });
  }

  // Aborts on timeout, and also if the client hangs up first — otherwise a
  // cancelled browser request leaves the upstream call running.
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  // res 'close' rather than the deprecated req 'aborted'. Guarded on
  // writableEnded so a normally completed response does not abort a fetch that
  // has already delivered.
  const onClientAbort = () => {
    if (!res.writableEnded) controller.abort();
  };
  res.on('close', onClientAbort);

  try {
    const response = await fetch(CHAT_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req.body),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`Upstream responded with status: ${response.status}`);
    }

    const data = await response.json();
    res.json(data);
  } catch (error) {
    // Generic to the client: the message carries the upstream hostname and
    // status. Detail stays in the log.
    logger.error('[Chat] Proxy error:', {
      error: error.message,
      aborted: error.name === 'AbortError',
    });
    res.status(502).json({ error: 'Chat service unavailable' });
  } finally {
    clearTimeout(timeout);
    res.off('close', onClientAbort);
  }
});

export default router;
