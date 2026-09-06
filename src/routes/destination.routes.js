import express from 'express';
import {
  getAllDestinations,
  getDestination,
  getDestinationBySlugController,
  getDestinationWithToursController,
  getDestinationStatsController,
  createDestinationController,
  updateDestinationController,
  deleteDestinationController,
  getRevenueBreakdownController,
} from '#controllers/destination.controller.js';
import { requireAuth, requireAdmin } from '#middleware/auth.middleware.js';
import { publicSecurityMiddleware } from '#middleware/security.middleware.js';

const router = express.Router();

// ✅ SPECIFIC ROUTES FIRST (before dynamic :id/:slug)
// Admin routes with specific paths
router.get(
  '/stats/revenue-breakdown', // ✅ Move this BEFORE /:id/stats
  requireAuth,
  requireAdmin,
  getRevenueBreakdownController
);

// Public routes - specific paths before dynamic params
router.get('/', publicSecurityMiddleware, getAllDestinations);

router.get(
  '/slug/:slug', // ✅ Specific path, should come early
  publicSecurityMiddleware,
  getDestinationBySlugController
);

// ✅ DYNAMIC ROUTES LAST (/:id patterns)

router.get(
  '/:id/tours',
  publicSecurityMiddleware,
  getDestinationWithToursController
);

router.get(
  '/:id/stats',
  requireAuth,
  requireAdmin,
  getDestinationStatsController
);
router.get('/:id', publicSecurityMiddleware, getDestination);

// Admin mutation routes (POST, PATCH, DELETE)
router.post('/', requireAuth, requireAdmin, createDestinationController);
router.patch('/:id', requireAuth, requireAdmin, updateDestinationController);
router.delete('/:id', requireAuth, requireAdmin, deleteDestinationController);

export default router;
