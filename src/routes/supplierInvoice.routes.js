// src/routes/supplierInvoice.routes.js
//
// What the operator owes suppliers. Admin only: this is the cost side of the
// business, and what a lodge charges is commercially sensitive in a way a tour
// price is not.
//
// There is no PATCH and no DELETE. An invoice is a document somebody else
// issued — editing the amount would silently disagree with the payable already
// in the ledger, and deleting it would remove the record of a debt that was
// once real. Cancelling is POST /:id/void, which reverses the accrual through
// the money layer and leaves the document standing.

import express from 'express';
import {
  createSupplierInvoiceController,
  listSupplierInvoicesController,
  getSupplierInvoiceController,
  voidSupplierInvoiceController,
} from '#controllers/supplierInvoice.controller.js';
import { requireAuth, requireAdmin } from '#middleware/auth.middleware.js';
import { authSecurityMiddleware } from '#middleware/security.middleware.js';

const router = express.Router();

// Security middleware ahead of requireAuth: behind it, an unauthenticated
// request is answered 401 without ever reaching Arcjet.
const adminOnly = [authSecurityMiddleware, requireAuth, requireAdmin];

router.get('/', ...adminOnly, listSupplierInvoicesController);
router.post('/', ...adminOnly, createSupplierInvoiceController);

// Specific paths before the dynamic one.
router.post('/:id/void', ...adminOnly, voidSupplierInvoiceController);
router.get('/:id', ...adminOnly, getSupplierInvoiceController);

export default router;
