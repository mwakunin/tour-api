import express from 'express';
import { getCurrentUser, forceLogout } from '#controllers/auth.controller.js';
import { requireAuth, requireAdmin } from '#middleware/auth.middleware.js';
import { resolveTenant } from '#middleware/tenant.middleware.js';
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
// resolveTenant is listed explicitly because this router is mounted on
// /api/auth in app.js, which is BEFORE the app-wide `app.use('/api',
// resolveTenant)` -- deliberately, so an unauthenticated probe does not need a
// tenant. requireAdmin now reads req.membership, and a membership can only be
// loaded inside a tenant context, so without this the route would answer 403
// to a genuine operator admin and the log would say "no membership context".
// It has to run before requireAuth, since requireAuth is what populates the
// membership.
router.post(
  '/force-logout/:userId',
  authSecurityMiddleware,
  resolveTenant,
  requireAuth,
  requireAdmin,
  forceLogout
);

export default router;
