// src/validations/counterparty.validation.js
import { z } from 'zod';
import { emailSchema, phoneSchema, paginationSchema } from './common.js';

// Mirrors counterpartyTypeEnum. Kept as a literal list rather than derived
// from the Drizzle enum so a schema change has to be made deliberately in both
// places — the API contract and the column are allowed to diverge for a
// release, and silently following the column would hide that.
export const COUNTERPARTY_TYPES = [
  'customer',
  'supplier',
  'agent',
  'staff',
  'authority',
  'other',
];

const CURRENCIES = ['USD', 'KES'];

// Basis points, not a percentage: 1250 is 12.5%. An integer because a
// commission rate is multiplied by money, and a float rate would put rounding
// error into a payable. 10000 bps is 100%, the column's own upper bound.
const commissionRateBps = z
  .number()
  .int('Commission rate must be whole basis points')
  .min(0)
  .max(10000, 'Commission rate cannot exceed 10000 bps (100%)');

// Net terms in days from invoice date. Zero is meaningful — payment on
// receipt — so the bound is 0, not 1.
const paymentTermsDays = z
  .number()
  .int('Payment terms must be a whole number of days')
  .min(0)
  .max(365);

export const counterpartySchema = z.object({
  type: z.enum(COUNTERPARTY_TYPES),
  name: z.string().min(1, 'Name is required').max(200),
  email: emailSchema.optional().nullable(),
  phone: phoneSchema.optional().nullable(),
  default_currency: z.enum(CURRENCIES).default('KES'),
  payment_terms_days: paymentTermsDays.optional().nullable(),
  commission_rate_bps: commissionRateBps.optional().nullable(),
  mpesa_number: z.string().max(32).optional().nullable(),
  bank_details: z.string().max(2000).optional().nullable(),
  notes: z.string().max(2000).optional().nullable(),
  is_active: z.boolean().default(true),
});

// eqeqeq is enforced here without a null exception, so `== null` is spelled
// out rather than relied on.
const isUnset = (value) => value === null || value === undefined;

// A commission rate on a supplier, or payment terms on an agent, are almost
// always a mistake rather than an intent — the two fields belong to opposite
// sides of the ledger. Caught at the edge rather than silently stored, because
// an agent with no commission_rate_bps produces a zero payable and nobody
// notices until reconciliation.
const crossFieldRules = (data, ctx) => {
  if (data.type === 'agent' && isUnset(data.commission_rate_bps)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'An agent needs a commission_rate_bps to earn commission on',
      path: ['commission_rate_bps'],
    });
  }

  if (data.type !== 'agent' && !isUnset(data.commission_rate_bps)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'commission_rate_bps only applies to an agent',
      path: ['commission_rate_bps'],
    });
  }
};

export const counterpartyCreateSchema =
  counterpartySchema.superRefine(crossFieldRules);

// Omitted and redeclared rather than .partial(), which keeps the create
// schema's defaults — a PATCH that never mentioned default_currency or
// is_active would otherwise reset them to 'KES' and true. The same trap
// destination.validation.js documents.
export const counterpartyUpdateSchema = counterpartySchema
  .omit({ default_currency: true, is_active: true })
  .partial()
  .extend({
    default_currency: z.enum(CURRENCIES).optional(),
    is_active: z.boolean().optional(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: 'No fields provided to update',
  });

export const counterpartyQuerySchema = paginationSchema.extend({
  type: z.enum(COUNTERPARTY_TYPES).optional(),
  // Absent means "either" rather than "active only": an admin listing
  // suppliers to correct one needs to see the deactivated ones.
  is_active: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === 'true')),
  search: z.string().max(200).optional(),
});

export const validateCounterpartyCreate = (data) =>
  counterpartyCreateSchema.parse(data);
export const validateCounterpartyUpdate = (data) =>
  counterpartyUpdateSchema.parse(data);
export const validateCounterpartyQuery = (data) =>
  counterpartyQuerySchema.parse(data);
