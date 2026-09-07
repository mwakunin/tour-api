import express from 'express';
import {
  initiatePayment,
  verifyPaymentStatus,
  mpesaCallback,
  paystackWebhook,
  pesapalIPN,
  pesapalCallback,
  getPaymentStatus,
  confirmBankTransferController,
  getPendingBankTransfersController,
  getBankTransferStatsController,
} from '#controllers/payment.controller.js';
import { getAvailablePaymentMethods } from '#services/payment.service.js';
import { requireAuth, requireAdmin } from '#middleware/auth.middleware.js';

const router = express.Router();

// Unified payment initialization
router.post('/initiate', requireAuth, initiatePayment);

// Verify payment (Paystack)
router.get('/verify', verifyPaymentStatus);

// Webhooks
router.post('/mpesa/callback', mpesaCallback);
router.post('/paystack/webhook', paystackWebhook);

// ✅ ADD THESE ROUTES (after existing routes)
router.get('/pesapal/ipn', pesapalIPN);
router.post('/pesapal/ipn', pesapalIPN);
router.get('/pesapal/callback', pesapalCallback);

// GET /api/payments/booking/:bookingId/status
router.get('/booking/:bookingId/status', requireAuth, getPaymentStatus);

// GET /api/payments/methods?currency=KES
router.get('/methods', (req, res) => {
  const { currency } = req.query;
  const methods = getAvailablePaymentMethods(currency);
  res.json({ success: true, data: methods });
});

// Admin routes - bank transfer management
router.get(
  '/bank-transfers/pending',
  requireAuth,
  requireAdmin,
  getPendingBankTransfersController
);

router.get(
  '/bank-transfers/stats',
  requireAuth,
  requireAdmin,
  getBankTransferStatsController
);

router.post(
  '/bank-transfers/:id/confirm',
  requireAuth,
  requireAdmin,
  confirmBankTransferController
);

export default router;
