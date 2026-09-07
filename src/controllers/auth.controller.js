import { auth } from '#utils/auth.js';
import logger from '#config/logger.js';

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
    await auth.api.revokeUserSessions({ userId });
    logger.info('[Auth] Force logout', {
      targetUserId: userId,
      adminId: req.user.id,
    });
    res.json({ success: true, message: `User ${userId} sessions revoked` });
  } catch (error) {
    logger.error('[Auth] Force logout error', error);
    res.status(500).json({ error: 'Failed to logout user' });
  }
};
