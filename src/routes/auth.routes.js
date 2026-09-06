import express from 'express';
import { getCurrentUser, forceLogout } from '#controllers/auth.controller.js';
import { requireAuth, requireAdmin } from '#middleware/auth.middleware.js';
import {
  authSecurityMiddleware,
  publicSecurityMiddleware,
} from '#middleware/security.middleware.js';

const router = express.Router();

// Protected routes
router.get('/me', requireAuth, publicSecurityMiddleware, getCurrentUser);

// Admin only
router.post(
  '/force-logout/:userId',
  requireAuth,
  requireAdmin,
  authSecurityMiddleware,
  forceLogout
);

export default router;
