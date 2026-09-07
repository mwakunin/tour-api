// src/validations/supplierInvoice.validation.js
import { z } from 'zod';
import { paginationSchema } from './common.js';

const CURRENCIES = ['USD', 'KES'];

// The shape check and the round-trip together. Date.parse accepts 2025-02-30
// and rolls it forward to 2025-03-02, so a shape check alone files the invoice
// under a day nobody chose.
const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD')
  .refine((v) => {
    const parsed = new Date(`${v}T00:00:00Z`);
    return (
      !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === v
    );
  }, 'Date is not a real calendar day');

// A decimal string, as it appears on the invoice. Converted to cents with
// integer arithmetic in the service — decimalToCents parses the digits rather
// than going through a float, because parseFloat('1.15') * 100 is
// 114.99999999999999 and the error only shows on the one amount that matters.
const amountString = z
  .string()
  .trim()
  .regex(/^\d+(\.\d{1,2})?$/, 'Amount must be a decimal, e.g. "1250.00"')
  .refine((v) => Number(v) > 0, 'Amount must be greater than zero');

export const supplierInvoiceCreateSchema = z.object({
  counterparty_id: z.string().uuid('counterparty_id must be a UUID'),
  invoice_number: z
    .string()
    .trim()
    .min(1, 'Invoice number is required')
    .max(64),
  issued_on: isoDate,
  amount: amountString,

  // Both optional because the supplier already told us. Currency falls back to
  // the counterparty's default_currency and due_on to issued_on plus their
  // payment_terms_days — which is what recording those on the counterparty was
  // for. Supplying either overrides it for this invoice.
  currency: z.enum(CURRENCIES).optional(),
  due_on: isoDate.optional(),

  notes: z.string().max(2000).optional().nullable(),
});

export const supplierInvoiceQuerySchema = paginationSchema.extend({
  counterparty_id: z.string().uuid().optional(),
  // 'open' is the working view: what is still owed. 'all' includes settled and
  // voided invoices, which is what reconciliation against a statement needs.
  status: z.enum(['all', 'open', 'settled', 'void']).default('all'),
});

export const validateSupplierInvoiceCreate = (data) =>
  supplierInvoiceCreateSchema.parse(data);
export const validateSupplierInvoiceQuery = (data) =>
  supplierInvoiceQuerySchema.parse(data);
