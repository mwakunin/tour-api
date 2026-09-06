import express from 'express';
import {
  getAllTours,
  getAllToursWithDestinations,
  searchToursController,
  getFeaturedToursController,
  getDealsController,
  getTour,
  getTourWithDestinationsById,
  getTourBySlugController,
  getTourWithDestinationsBySlug,
  getTourWithDestinationsController,
  getTourStatsController,
  createTourController,
  updateTourController,
  deleteTourController,
  getTopPerformingToursController,
} from '#controllers/tour.controller.js';
import { requireAuth, requireAdmin } from '#middleware/auth.middleware.js';
import { publicSecurityMiddleware } from '#middleware/security.middleware.js';

const router = express.Router();

// ============================================
// LEVEL 1: Fully Static Paths (MOST SPECIFIC)
// ============================================

// Search, featured, deals
router.get('/search', publicSecurityMiddleware, searchToursController);
router.get('/featured', publicSecurityMiddleware, getFeaturedToursController);
router.get('/deals', publicSecurityMiddleware, getDealsController);
router.get(
  '/with-destinations',
  publicSecurityMiddleware,
  getAllToursWithDestinations
);

// ✅ CRITICAL: Admin stats route (fully static)
router.get(
  '/stats/top-performing',
  requireAuth,
  requireAdmin,
  getTopPerformingToursController
);

// Root path (all tours)
router.get('/', publicSecurityMiddleware, getAllTours);
// ============================================
// LEVEL 2: Static Prefix + Param (MEDIUM SPECIFICITY)
// ============================================

// Slug routes with suffix
router.get(
  '/slug/:slug/with-destinations',
  publicSecurityMiddleware,
  getTourWithDestinationsBySlug
);

// Slug routes without suffix
router.get('/slug/:slug', publicSecurityMiddleware, getTourBySlugController);

// ============================================
// LEVEL 3: Param + Static Suffix (LESS SPECIFIC)
// ============================================

// Tour with destinations (various formats)
router.get(
  '/:id/full',
  publicSecurityMiddleware,
  getTourWithDestinationsController
);

router.get(
  '/:id/with-destinations',
  publicSecurityMiddleware,
  getTourWithDestinationsById
);

// ✅ Tour stats (comes AFTER /stats/top-performing)
router.get('/:id/stats', requireAuth, requireAdmin, getTourStatsController);

// ============================================
// LEVEL 4: Pure Param Routes (LEAST SPECIFIC - MUST BE LAST!)
// ============================================

// Single tour by ID - ✅ MUST BE ABSOLUTE LAST
router.get('/:id', publicSecurityMiddleware, getTour);

// ============================================
// ADMIN WRITE OPERATIONS (Order doesn't matter for different HTTP methods)
// ============================================

router.post('/', requireAuth, requireAdmin, createTourController);

router.patch('/:id', requireAuth, requireAdmin, updateTourController);

router.delete('/:id', requireAuth, requireAdmin, deleteTourController);

export default router;
