// src/routes/ledgerOutbox.routes.js
//
// The failed-accrual worklist, and the button that retries it.
//
// Admin only: it is a list of the operator's revenue that did not reach the
// books. There is no route to create or delete an entry — one is written by
// the ledger path that failed, and cleared by a retry that succeeded. A
// hand-written entry would be a way to make the ledger replay something that
// never happened, and a hand-deleted one a way to hide that it did.

import express from 'express';
import {
  listOutboxController,
  drainOutboxController,
} from '#controllers/ledgerOutbox.controller.js';
import { requireAuth, requireAdmin } from '#middleware/auth.middleware.js';
import { authSecurityMiddleware } from '#middleware/security.middleware.js';
import { noStore } from '#middleware/cache.middleware.js';

const router = express.Router();

router.use(noStore);

// Security middleware ahead of requireAuth: behind it, an unauthenticated
// request is answered 401 without ever reaching Arcjet.
const adminOnly = [authSecurityMiddleware, requireAuth, requireAdmin];

router.get('/', ...adminOnly, listOutboxController);
router.post('/drain', ...adminOnly, drainOutboxController);

export default router;
