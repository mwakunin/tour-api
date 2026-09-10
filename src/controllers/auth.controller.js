import { eq } from 'drizzle-orm';

import logger from '#config/logger.js';
import { appDb } from '#config/appDatabase.js';
import { session } from '#models/user.model.js';
import { isTenantMember } from '#middleware/membership.middleware.js';

export const getCurrentUser = (req, res) => {
  try {
    res.json({ user: req.user });
  } catch (error) {
    logger.error('[Auth] Get current user error', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

export const forceLogout = async (req, res) => {
  try {
    const { userId } = req.params;

    // requireAdmin established that the CALLER administers this operator. It
    // says nothing about the target, and :userId indexes Better Auth's global
    // `user` table -- so without this an admin at one operator could revoke
    // the sessions of another operator's users, logging them out at will.
    //
    // No self-exemption, unlike the /users/:id paths: force-logout is only
    // ever an admin acting on someone, and an admin here necessarily holds a
    // membership here.
    //
    // Same body as a genuinely unknown id, for the same reason it is used in
    // users.controller.js: a distinguishable rejection confirms the id names a
    // real account somewhere.
    if (!(await isTenantMember(userId))) {
      logger.warn('[Auth] Force logout refused: target is not a member', {
        targetUserId: userId,
        adminId: req.user.id,
      });
      return res.status(404).json({ error: 'User not found' });
    }

    // Deleting the rows rather than calling auth.api.revokeUserSessions,
    // which does not exist here: it ships with better-auth's `admin` plugin
    // and no plugins are configured, so this endpoint answered 500 to every
    // request it ever received. It had no test, which is why nobody knew.
    //
    // Enabling the plugin to get one function would mount its whole surface --
    // ban, impersonate, list-users, set-role -- under /api/auth/*, which is
    // mounted BEFORE the app-wide resolveTenant and would therefore be
    // unscoped across operators. Four lines of DELETE is the smaller change
    // and the smaller blast radius.
    //
    // Sessions are not per-tenant -- there is one set per user -- so this logs
    // them out everywhere, which is the only thing the schema can express.
    const revoked = await appDb
      .delete(session)
      .where(eq(session.userId, userId))
      .returning({ id: session.id });

    logger.info('[Auth] Force logout', {
      targetUserId: userId,
      adminId: req.user.id,
      sessionsRevoked: revoked.length,
    });
    res.json({ success: true, message: `User ${userId} sessions revoked` });
  } catch (error) {
    logger.error('[Auth] Force logout error', error);
    res.status(500).json({ error: 'Failed to logout user' });
  }
};
