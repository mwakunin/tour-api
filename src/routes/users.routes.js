import express from 'express';
import {
  fetchAllUsers,
  fetchUserById,
  updateUserById,
  deleteUserById,
  fetchUserStats, // ← Add this
} from '#controllers/users.controller.js';
import {
  requireAuth,
  requireAdmin,
  requireOwnerOrAdmin,
} from '#middleware/auth.middleware.js';

const router = express.Router();

// GET /users - Get all users (admin only)
router.get('/', requireAuth, requireAdmin, fetchAllUsers);

// GET /users/stats - Get user statistics (MUST be before /:id)
router.get('/stats', requireAuth, requireAdmin, fetchUserStats);

// GET /users/:id - Get user by ID (authenticated users only)
// Deliberately authenticated but not ownership-restricted: any signed-in user
// may view another user's profile. See the auth integration test that pins
// this. NOTE: the handler currently returns `email` and `role`, which is more
// than "basic profile" implies — worth narrowing the projection, but that is a
// product decision, not a middleware one.
router.get('/:id', requireAuth, fetchUserById);

// PUT /users/:id - Update user by ID
router.put(
  '/:id',
  requireAuth,
  requireOwnerOrAdmin((req) => req.params.id),
  updateUserById
);

// router.delete('/:id', requireAuth, deleteUserById);
// DELETE /users/:id - Delete user by ID (self or admin)
router.delete(
  '/:id',
  requireAuth,
  requireOwnerOrAdmin((req) => req.params.id),
  deleteUserById
);

export default router;
