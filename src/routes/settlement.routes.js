// src/routes/settlement.routes.js
//
// The unmatched receipts worklist. Admin only: it is a list of the operator's
// money and who it may belong to.
//
// There is no create route here. Settlements are recorded by the thing that
// caused them — a payment provider callback, a bank transfer confirmation, a
// payment to a supplier — so an endpoint that invented one from nothing would
// be a way to write money into the books with no event behind it.

import express from 'express';
import {
  listUnmatchedController,
  matchSettlementController,
} from '#controllers/settlement.controller.js';
import { requireAuth, requireAdmin } from '#middleware/auth.middleware.js';
import { authSecurityMiddleware } from '#middleware/security.middleware.js';

const router = express.Router();

// Security middleware ahead of requireAuth: behind it, an unauthenticated
// request is answered 401 without ever reaching Arcjet.
const adminOnly = [authSecurityMiddleware, requireAuth, requireAdmin];

// Specific path before the dynamic one, or '/:id' swallows 'unmatched'.
router.get('/unmatched', ...adminOnly, listUnmatchedController);

router.post('/:id/allocations', ...adminOnly, matchSettlementController);

export default router;
