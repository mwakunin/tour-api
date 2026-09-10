import { auth } from '#utils/auth.js';
import { fromNodeHeaders } from 'better-auth/node';
import logger from '#config/logger.js';
import { attachMembership } from '#middleware/membership.middleware.js';

export const requireAuth = async (req, res, next) => {
  try {
    const session = await auth.api.getSession({
      headers: fromNodeHeaders(req.headers),
    });

    if (!session) {
      logger.warn('[Auth] Unauthorized request - no session', {
        path: req.path,
        ip: req.ip,
      });
      return res.status(401).json({
        error: 'Authentication required',
        message: 'No active session',
      });
    }

    req.user = session.user;
    req.session = session.session;

    // Who they are AT this tenant, alongside who they are. Additive for now --
    // requireRole below still reads req.user.role, so this decides nothing
    // yet. It never throws; see attachMembership.
    await attachMembership(req);

    next();
  } catch (error) {
    logger.error('[Auth] Authentication failed:', error.message);
    return res.status(401).json({
      error: 'Authentication failed',
      message: 'Session validation error',
    });
  }
};

export const optionalAuth = async (req, res, next) => {
  try {
    const session = await auth.api.getSession({
      headers: fromNodeHeaders(req.headers),
    });
    if (session) {
      req.user = session.user;
      req.session = session.session;
      await attachMembership(req);
    }
    next();
  } catch (error) {
    logger.error('[Auth] Optional authentication error:', error);
    next();
  }
};

export const requireRole = (allowedRoles) => {
  const rolesArray = Array.isArray(allowedRoles)
    ? allowedRoles
    : [allowedRoles];

  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({
        error: 'Authentication required',
        message: 'User not authenticated',
      });
    }

    const userRole = req.user.role || 'user';

    if (!rolesArray.includes(userRole)) {
      logger.warn(
        `[Auth] Access denied: user ${req.user.id} has role '${userRole}', required: [${rolesArray.join(', ')}]`
      );
      return res.status(403).json({
        error: 'Access denied',
        message: 'Insufficient permissions',
      });
    }

    next();
  };
};

export const requireAdmin = requireRole('admin');

export const requireOwnerOrAdmin = (getUserId) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({
        error: 'Authentication required',
        message: 'User not authenticated',
      });
    }

    const resourceUserId =
      typeof getUserId === 'function' ? getUserId(req) : getUserId;
    const isOwner = req.user.id === resourceUserId;
    const isAdmin = req.user.role === 'admin';

    if (!isOwner && !isAdmin) {
      logger.warn(`[Auth] Owner/Admin access denied for user ${req.user.id}`);
      return res.status(403).json({
        error: 'Access denied',
        message:
          'You can only access your own resources or you must be an admin',
      });
    }

    next();
  };
};

export const isAuthenticated = (req) => !!req.user;
export const hasRole = (req, role) => req.user?.role === role;
export const isOwner = (req, resourceUserId) => req.user?.id === resourceUserId;
