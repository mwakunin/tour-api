import express from 'express';
import { requireAuth, requireAdmin } from '#middleware/auth.middleware.js';

const router = express.Router();

// Public test route (no authentication required)
router.get('/public', (req, res) => {
  res.json({
    message: 'Public route - no authentication required',
    timestamp: new Date().toISOString(),
  });
});

// Basic authenticated route
router.get('/protected', requireAuth, (req, res) => {
  res.json({
    message: 'Protected route - authentication required',
    user: {
      id: req.user.id,
      email: req.user.email,
      role: req.user.role,
    },
  });
});

// Admin only route
router.get('/admin-only', requireAuth, requireAdmin, (req, res) => {
  res.json({
    message: 'Admin access granted!',
    user: {
      id: req.user.id,
      email: req.user.email,
      role: req.user.role,
      org_code: req.user.org_code,
      permissions: req.user.permissions,
    },
    timestamp: new Date().toISOString(),
  });
});

// Role-based access (multiple roles allowed)
router.get('/moderator', requireAuth, (req, res) => {
  res.json({
    message: 'Moderator or Admin access granted',
    userRole: req.user.role,
    user: req.user.email,
  });
});

// Permission-based access
router.get('/read-users', requireAuth, (req, res) => {
  res.json({
    message: 'Permission granted: can read users',
    permissions: req.user.permissions,
    user: req.user.email,
  });
});

export default router;
