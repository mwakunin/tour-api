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

    // Who they are AT this tenant, alongside who they are. requireRole below
    // reads this and nothing else, so a failed lookup must not be mistaken for
    // a held role -- attachMembership sets null on error and never throws.
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

// Membership roles that carry administrative authority AT one operator.
// `owner` is included wherever `admin` is: it is strictly more privileged, and
// leaving it out would lock an operator out of their own account.
export const ADMIN_ROLES = ['owner', 'admin'];

/**
 * Whether the caller holds an administrative role at the CURRENT tenant.
 *
 * Reads req.membership, not req.user.role. The Better Auth row's `role` is one
 * global string, so 'admin' there means admin of every operator -- which is
 * precisely the authorization bug this replaces.
 */
export const isTenantAdmin = (req) =>
  (req.membership?.roles ?? []).some((role) => ADMIN_ROLES.includes(role));

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

    // null and [] are different faults and the log has to tell them apart.
    // null means no tenant context existed to ask within -- a route mounted
    // before resolveTenant, which is a wiring bug that would otherwise present
    // as a mysterious 403 for a user who really is an admin. [] means the
    // question was asked and answered: they hold nothing here.
    if (!req.membership) {
      logger.error(
        `[Auth] No membership context for user ${req.user.id} on ${req.method} ${req.originalUrl}. ` +
          'This route runs outside resolveTenant, so no tenant could be resolved to check against.'
      );
      return res.status(403).json({
        error: 'Access denied',
        message: 'Insufficient permissions',
      });
    }

    const held = req.membership.roles;

    if (!held.some((role) => rolesArray.includes(role))) {
      logger.warn(
        `[Auth] Access denied: user ${req.user.id} holds [${held.join(', ')}] at tenant ${req.membership.tenantId}, required: [${rolesArray.join(', ')}]`
      );
      return res.status(403).json({
        error: 'Access denied',
        message: 'Insufficient permissions',
      });
    }

    next();
  };
};

export const requireAdmin = requireRole(ADMIN_ROLES);

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
    const isAdmin = isTenantAdmin(req);

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
// Membership roles, not the global user.role. Callers asking "is this person
// an admin" mean "here", and there is no other useful reading of the question.
export const hasRole = (req, role) =>
  (req.membership?.roles ?? []).includes(role);
export const isOwner = (req, resourceUserId) => req.user?.id === resourceUserId;
