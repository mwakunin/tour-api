import express from 'express';
import {
  fetchAllUsers,
  fetchUserById,
  updateUserById,
  deleteUserById,
  fetchUserStats, // ← Add this
} from '#controllers/users.controller.js';
import { requireAuth, requireAdmin, requireOwnerOrAdmin } from '#middleware/auth.middleware.js';

const router = express.Router();

// GET /users - Get all users (admin only)
router.get('/', requireAuth, requireAdmin, fetchAllUsers);

// GET /users/stats - Get user statistics (MUST be before /:id)
router.get('/stats', requireAuth, requireAdmin, fetchUserStats);

// GET /users/:id - Get user by ID (authenticated users only)
router.get('/:id', requireAuth, fetchUserById);

// PUT /users/:id - Update user by ID
router.put('/:id', requireAuth, updateUserById);

// router.delete('/:id', requireAuth, deleteUserById);
// DELETE /users/:id - Delete user by ID (self or admin)
router.delete(
  '/:id',
  requireAuth,
  requireOwnerOrAdmin((req) => req.params.id),
  deleteUserById
);

export default router;
