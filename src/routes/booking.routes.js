import express from 'express';
import {
  createBookingController,
  getAllBookings,
  getBooking,
  getBookingByReferenceController,
  getUserBookingsController,
  updateBookingStatusController,
  updatePaymentStatusController,
  cancelBookingController,
  getBookingStatsController,
  updateBookingController,
  getRevenueStatsController,
  getBookingTrendsController,
  getBookingPnlController,
} from '#controllers/booking.controller.js';
import { requireAuth, requireAdmin } from '#middleware/auth.middleware.js';
import { publicSecurityMiddleware } from '#middleware/security.middleware.js';

const router = express.Router();

// ===== IMPORTANT: Specific routes MUST come before dynamic params =====

// Public routes
router.get(
  '/reference/:reference',
  publicSecurityMiddleware,
  getBookingByReferenceController
);

router.get('/my-bookings', requireAuth, getUserBookingsController);

// Admin stats routes (must be before /:id)
router.get(
  '/stats/overview',
  requireAuth,
  requireAdmin,
  getBookingStatsController
);

router.get(
  '/stats/revenue',
  requireAuth,
  requireAdmin,
  getRevenueStatsController
);

router.get(
  '/stats/trends',
  requireAuth,
  requireAdmin,
  getBookingTrendsController
);

// Admin list all bookings
router.get('/', requireAuth, requireAdmin, getAllBookings);

// What one trip made. Registered with the other admin reads and before the
// dynamic ':id' handlers below, which would otherwise match '/:id/pnl' only by
// accident of ordering.
router.get('/:id/pnl', requireAuth, requireAdmin, getBookingPnlController);

// Protected routes - user authentication required
router.post('/', requireAuth, createBookingController);

// Dynamic ID routes (MUST be last to avoid matching specific routes)
router.get('/:id', requireAuth, getBooking);
router.patch('/:id/cancel', requireAuth, cancelBookingController);
router.patch('/:id', requireAuth, updateBookingController);

// Admin only routes with dynamic ID
router.patch(
  '/:id/status',
  requireAuth,
  requireAdmin,
  updateBookingStatusController
);
router.patch(
  '/:id/payment',
  requireAuth,
  requireAdmin,
  updatePaymentStatusController
);

export default router;
