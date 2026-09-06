import aj, { ajWithBotDetection } from '#config/arcjet.js';
import logger from '#config/logger.js';
import { slidingWindow } from '@arcjet/node';

// ✅ For authentication routes (login, register, etc.)
// ✅ Auth routes — bot detection + rate limiting
export const authSecurityMiddleware = async (req, res, next) => {
  try {
    if (process.env.NODE_ENV !== 'production') return next();

    const client = ajWithBotDetection.withRule(
      // 👈 uses bot detection
      slidingWindow({ mode: 'LIVE', interval: '1m', max: 30 })
    );

    const decision = await client.protect(req);

    if (decision.isDenied() && decision.reason.isBot()) {
      logger.warn('Bot blocked on auth route', {
        ip: req.ip,
        path: req.path,
      });
      return res.status(403).json({
        error: 'Forbidden',
        message: 'Automated requests are not allowed',
      });
    }

    if (decision.isDenied() && decision.reason.isShield()) {
      logger.warn('Shield blocked on auth route', {
        ip: req.ip,
        path: req.path,
      });
      return res.status(403).json({
        error: 'Forbidden',
        message: 'Request blocked by security policy',
      });
    }

    if (decision.isDenied() && decision.reason.isRateLimit()) {
      logger.warn('Rate limit on auth route', {
        ip: req.ip,
        path: req.path,
      });
      return res.status(429).json({
        error: 'Too Many Requests',
        message: 'Too many authentication attempts. Please try again later.',
      });
    }

    next();
  } catch (e) {
    logger.error('Auth security middleware error:', e);
    next();
  }
};

// ✅ For public routes (browsing tours, destinations, etc.)
export const publicSecurityMiddleware = async (req, res, next) => {
  try {
    if (process.env.NODE_ENV !== 'production') {
      return next();
    }

    const client = aj.withRule(
      slidingWindow({
        mode: 'LIVE',
        interval: '1m',
        max: 100, // Generous limit for browsing
      })
    );

    const decision = await client.protect(req);

    if (decision.isDenied() && decision.reason.isShield()) {
      logger.warn('Shield blocked on public route', {
        ip: req.ip,
        path: req.path,
      });
      return res.status(403).json({
        error: 'Forbidden',
        message: 'Request blocked by security policy',
      });
    }

    if (decision.isDenied() && decision.reason.isRateLimit()) {
      logger.warn('Rate limit on public route', {
        ip: req.ip,
        path: req.path,
      });
      return res.status(429).json({
        error: 'Too Many Requests',
        message: 'Too many requests. Please try again later.',
      });
    }

    next();
  } catch (e) {
    logger.error('Public security middleware error:', e);
    next();
  }
};

// ✅ Default export for backward compatibility (auth security)
export default authSecurityMiddleware;
