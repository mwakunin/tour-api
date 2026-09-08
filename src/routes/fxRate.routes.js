// src/routes/fxRate.routes.js
//
// Loading exchange rates. Admin only: a rate decides what every
// foreign-currency booking and supplier invoice is worth in the operator's own
// books, so it is a financial control, not reference data.
//
// There is no PATCH. A rate is a fact about a day that ledger entries already
// point at, and editing one silently rewrites what past conversions meant.
// Corrections are a DELETE-then-load while nothing has been converted at it,
// and after that the rate is history.

import express from 'express';
import {
  listFxRatesController,
  resolveFxRateController,
  getFxRateController,
  createFxRateController,
  deleteFxRateController,
} from '#controllers/fxRate.controller.js';
import { requireAuth, requireAdmin } from '#middleware/auth.middleware.js';
import { authSecurityMiddleware } from '#middleware/security.middleware.js';
import { noStore } from '#middleware/cache.middleware.js';

const router = express.Router();

// Every response from this router is one operator's commercial position:
// who they buy from, what they owe, what has been paid. None of it may sit in
// a shared cache. On the router so a route added later is covered by default.
router.use(noStore);

// Security middleware ahead of requireAuth: behind it, an unauthenticated
// request is answered 401 without ever reaching Arcjet.
const adminOnly = [authSecurityMiddleware, requireAuth, requireAdmin];

router.get('/', ...adminOnly, listFxRatesController);
router.post('/', ...adminOnly, createFxRateController);

// Specific path before the dynamic one, or '/:id' swallows 'resolve'.
router.get('/resolve', ...adminOnly, resolveFxRateController);

router.get('/:id', ...adminOnly, getFxRateController);
router.delete('/:id', ...adminOnly, deleteFxRateController);

export default router;
