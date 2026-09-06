import logger from '#config/logger.js';

// At the top of the file, add a helper
const _isSecureContext = () => {
  return (
    process.env.NODE_ENV === 'production' ||
    process.env.USE_HTTPS === 'true' ||
    process.env.CLOUDFLARE_TUNNEL === 'true'
  );
};
/**
 * Cookie utility functions for handling HTTP cookies
 */

export const cookies = {
  set: (res, name, value, options = {}) => {
    try {
      const defaultOptions = {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        maxAge: 24 * 60 * 60 * 1000, // 24 hours by default
        path: '/',
        ...options,
      };

      res.cookie(name, value, defaultOptions);
      logger.debug(`[Cookie] Set cookie: ${name}`);
    } catch (error) {
      logger.error(`[Cookie] Failed to set cookie ${name}:`, error);
    }
  },

  /**
   * Get a cookie value
   */
  get: (req, name) => {
    try {
      const value = req.cookies?.[name] || null;
      if (value) {
        logger.debug(`[Cookie] Retrieved cookie: ${name}`);
      } else {
        logger.debug(`[Cookie] Cookie not found: ${name}`);
      }
      return value;
    } catch (error) {
      logger.error(`[Cookie] Failed to get cookie ${name}:`, error);
      return null;
    }
  },

  /**
   * Clear/delete a cookie
   */
  clear: (res, name, options = {}) => {
    try {
      const clearOptions = {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        path: '/',
        ...options,
      };

      res.clearCookie(name, clearOptions);
      logger.debug(`[Cookie] Cleared cookie: ${name}`);
    } catch (error) {
      logger.error(`[Cookie] Failed to clear cookie ${name}:`, error);
    }
  },

  /**
   * Check if a cookie exists
   */
  exists: (req, name) => {
    try {
      const exists = !!(req.cookies && req.cookies[name]);
      logger.debug(`[Cookie] Cookie ${name} exists: ${exists}`);
      return exists;
    } catch (error) {
      logger.error(`[Cookie] Failed to check cookie ${name}:`, error);
      return false;
    }
  },

  /**
   * Get all cookies
   */
  getAll: (req) => {
    try {
      const allCookies = req.cookies || {};
      logger.debug('[Cookie] Retrieved all cookies:', Object.keys(allCookies));
      return allCookies;
    } catch (error) {
      logger.error('[Cookie] Failed to get all cookies:', error);
      return {};
    }
  },

  /**
   * Set multiple cookies at once
   */
  setMultiple: (res, cookieData) => {
    try {
      Object.entries(cookieData).forEach(([name, data]) => {
        if (typeof data === 'string') {
          // If data is a string, use it as value with default options
          cookies.set(res, name, data);
        } else if (data && typeof data === 'object') {
          // If data is an object, extract value and options
          const { value, ...options } = data;
          cookies.set(res, name, value, options);
        }
      });
      logger.debug('[Cookie] Set multiple cookies:', Object.keys(cookieData));
    } catch (error) {
      logger.error('[Cookie] Failed to set multiple cookies:', error);
    }
  },

  /**
   * Clear multiple cookies at once
   */
  clearMultiple: (res, cookieNames, options = {}) => {
    try {
      cookieNames.forEach((name) => {
        cookies.clear(res, name, options);
      });
      logger.debug('[Cookie] Cleared multiple cookies:', cookieNames);
    } catch (error) {
      logger.error('[Cookie] Failed to clear multiple cookies:', error);
    }
  },

  /**
   * Set a secure token cookie (for authentication)
   */
  setSecureToken: (res, name, token, additionalOptions = {}) => {
    const secureOptions = {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict', // More secure for tokens
      maxAge: 60 * 60 * 1000, // 1 hour default for tokens
      path: '/',
      ...additionalOptions,
    };

    cookies.set(res, name, token, secureOptions);
    logger.info(`[Cookie] Set secure token cookie: ${name}`);
  },

  /**
   * Set a session cookie (expires when browser closes)
   */
  setSession: (res, name, value, additionalOptions = {}) => {
    const sessionOptions = {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
      // No maxAge - session cookie
      ...additionalOptions,
    };

    cookies.set(res, name, value, sessionOptions);
    logger.debug(`[Cookie] Set session cookie: ${name}`);
  },
};
