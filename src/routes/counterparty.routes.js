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
import {
  listPayablesController,
  payCounterpartyController,
} from '#controllers/payable.controller.js';
import { requireAuth, requireAdmin } from '#middleware/auth.middleware.js';
import { authSecurityMiddleware } from '#middleware/security.middleware.js';
import { noStore } from '#middleware/cache.middleware.js';

const router = express.Router();

// Every response from this router is one operator's commercial position:
// who they buy from, what they owe, what has been paid. None of it may sit in
// a shared cache. On the router so a route added later is covered by default.
router.use(noStore);

// Security middleware first, before requireAuth. Behind it, an unauthenticated
// request is rejected at 401 without ever reaching Arcjet, so the endpoint can
// be probed without passing rate limiting or bot detection.
const adminOnly = [authSecurityMiddleware, requireAuth, requireAdmin];

router.get('/', ...adminOnly, listCounterpartiesController);
router.post('/', ...adminOnly, createCounterpartyController);

// What this counterparty is owed, and paying them. Registered before the bare
// '/:id' handlers so the more specific paths are matched first.
//
// A payment is addressed to the counterparty rather than to one invoice: an
// operator pays a lodge a lump sum and expects it to clear what has been owed
// longest, which is what the money layer does with it.
router.get('/:id/payables', ...adminOnly, listPayablesController);
router.post('/:id/payments', ...adminOnly, payCounterpartyController);

// Dynamic routes last, so a future '/summary' or '/export' is not swallowed
// by ':id'.
router.get('/:id', ...adminOnly, getCounterpartyController);
router.patch('/:id', ...adminOnly, updateCounterpartyController);
router.delete('/:id', ...adminOnly, deleteCounterpartyController);

export default router;
