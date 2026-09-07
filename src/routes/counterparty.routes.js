// src/routes/counterparty.routes.js
//
// Suppliers, agents and the rest of the cost side. Admin-only throughout:
// a lodge's bank details and an agent's commission rate are the operator's
// commercial terms, not customer-facing data.

import express from 'express';
import {
  listCounterpartiesController,
  getCounterpartyController,
  createCounterpartyController,
  updateCounterpartyController,
  deleteCounterpartyController,
} from '#controllers/counterparty.controller.js';
import { requireAuth, requireAdmin } from '#middleware/auth.middleware.js';
import { authSecurityMiddleware } from '#middleware/security.middleware.js';

const router = express.Router();

// Security middleware first, before requireAuth. Behind it, an unauthenticated
// request is rejected at 401 without ever reaching Arcjet, so the endpoint can
// be probed without passing rate limiting or bot detection.
const adminOnly = [authSecurityMiddleware, requireAuth, requireAdmin];

router.get('/', ...adminOnly, listCounterpartiesController);
router.post('/', ...adminOnly, createCounterpartyController);

// Dynamic routes last, so a future '/summary' or '/export' is not swallowed
// by ':id'.
router.get('/:id', ...adminOnly, getCounterpartyController);
router.patch('/:id', ...adminOnly, updateCounterpartyController);
router.delete('/:id', ...adminOnly, deleteCounterpartyController);

export default router;
