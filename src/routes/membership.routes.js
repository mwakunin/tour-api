// src/routes/membership.routes.js
//
// Who works for this operator. Admin-only throughout: the list is the
// operator's staff and customers by name and email, and the writes are grants
// of authority.
//
// This is what the 409 on DELETE /users/:id tells an administrator to use
// instead. Removing somebody from your operator is a membership operation --
// the account may be shared with another operator, and is not yours to delete.

import express from 'express';

import {
  listMembershipsController,
  grantMembershipController,
  revokeMembershipController,
} from '#controllers/membership.controller.js';
import { requireAuth, requireAdmin } from '#middleware/auth.middleware.js';
import { authSecurityMiddleware } from '#middleware/security.middleware.js';
import { noStore } from '#middleware/cache.middleware.js';

const router = express.Router();

// Names, emails and who holds authority. None of it may sit in a shared cache.
router.use(noStore);

// Security middleware first, before requireAuth: behind it an unauthenticated
// request is rejected at 401 without reaching Arcjet, so the endpoint could be
// probed without passing rate limiting or bot detection.
const adminOnly = [authSecurityMiddleware, requireAuth, requireAdmin];

router.get('/', ...adminOnly, listMembershipsController);
router.post('/', ...adminOnly, grantMembershipController);
router.delete('/:id', ...adminOnly, revokeMembershipController);

export default router;
