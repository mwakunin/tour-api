// src/validations/payable.validation.js
import { z } from 'zod';
import { decimalToCents } from '#utils/money.js';

const CURRENCIES = ['USD', 'KES'];

// Mirrors paymentMethodEnum. A payment to a supplier goes out by the same
// rails a customer's payment comes in by, and the ledger picks its cash
// account from this — see CASH_ACCOUNT in money.service.js.
const METHODS = [
  'mpesa',
  'pesapal',
  'paystack',
  'bank_transfer',
  'card',
  'cash',
];

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD')
  .refine((v) => {
    const parsed = new Date(`${v}T00:00:00Z`);
    return (
      !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === v
    );
  }, 'Date is not a real calendar day');

// The conversion is the check. A bound written separately here would be a
// second opinion about what fits in a number, and the two would drift.
const amountString = z
  .string()
  .trim()
  .regex(/^\d+(\.\d{1,2})?$/, 'Amount must be a decimal, e.g. "1250.00"')
  .refine((v) => Number(v) > 0, 'Amount must be greater than zero')
  .refine((v) => {
    try {
      decimalToCents(v);
      return true;
    } catch {
      return false;
    }
  }, 'Amount is larger than this system can represent exactly');

export const payCounterpartySchema = z.object({
  amount: amountString,
  method: z.enum(METHODS),

  // Defaults to the counterparty's own default_currency. A payment can only
  // ever clear obligations in its own currency, so getting this wrong means
  // the money sits unallocated rather than settling anything.
  currency: z.enum(CURRENCIES).optional(),

  // When the money actually moved, which is not always when somebody recorded
  // it. Drives the FX rate the ledger converts at.
  occurred_on: isoDate.optional(),

  // The bank slip, the M-Pesa confirmation code — whatever reconciles this
  // against a statement.
  reference: z.string().trim().max(128).optional().nullable(),
  notes: z.string().max(2000).optional().nullable(),
});

export const validatePayCounterparty = (data) =>
  payCounterpartySchema.parse(data);
