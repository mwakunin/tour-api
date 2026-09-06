import express from 'express';
import { getCurrentUser, forceLogout } from '#controllers/auth.controller.js';
import { requireAuth, requireAdmin } from '#middleware/auth.middleware.js';
import {
  authSecurityMiddleware,
  publicSecurityMiddleware,
} from '#middleware/security.middleware.js';

const router = express.Router();

// Protected routes
// Security middleware first: behind requireAuth it never ran for an
// unauthenticated request, so session validation could be hammered without
// passing Arcjet's rate limiting or bot detection.
router.get('/me', publicSecurityMiddleware, requireAuth, getCurrentUser);

// Admin only
// Same ordering: unauthenticated callers were rejected before Arcjet saw them.
router.post(
  '/force-logout/:userId',
  authSecurityMiddleware,
  requireAuth,
  requireAdmin,
  forceLogout
);

export default router;
