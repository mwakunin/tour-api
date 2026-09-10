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
//
// resolveTenant used to be listed here explicitly, because this router mounted
// ahead of the app-wide tenant middleware and requireAdmin needs a membership,
// which needs a tenant. app.js now resolves the tenant for all of /api/auth,
// so the local copy is gone -- one place decides, rather than two.
router.post(
  '/force-logout/:userId',
  authSecurityMiddleware,
  requireAuth,
  requireAdmin,
  forceLogout
);

export default router;
