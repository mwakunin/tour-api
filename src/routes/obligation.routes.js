// src/routes/obligation.routes.js
//
// Read-only, and there is no route here to create, amend or delete one.
// An obligation is raised by the thing that caused it — a booking, an agent's
// commission, a supplier's invoice — so an endpoint that made one from nothing
// would be a way to write money into the books with no event behind it.

import express from 'express';
import { listObligationsController } from '#controllers/obligation.controller.js';
import { requireAuth, requireAdmin } from '#middleware/auth.middleware.js';
import { authSecurityMiddleware } from '#middleware/security.middleware.js';
import { noStore } from '#middleware/cache.middleware.js';

const router = express.Router();

router.use(noStore);

const adminOnly = [authSecurityMiddleware, requireAuth, requireAdmin];

router.get('/', ...adminOnly, listObligationsController);

export default router;
