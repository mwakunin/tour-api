// src/validations/fxRate.validation.js
import { z } from 'zod';
import { paginationSchema } from './common.js';

const CURRENCIES = ['USD', 'KES'];

// Rates arrive as a decimal string — "130.25" — because that is what an
// operator reads off a bank statement, and because a JSON number cannot carry
// six decimal places reliably. The string is converted to parts per million
// with integer arithmetic in the service; see decimalToPpm.
//
// Bounded at both ends: the regex refuses a negative or a bare '.', and the
// service refuses anything that rounds to zero ppm or leaves the safe-integer
// range. 1e9 as an upper bound is far past any real currency pair while
// staying comfortably inside bigint.
const rateString = z
  .string()
  .trim()
  .regex(/^\d+(\.\d+)?$/, 'Rate must be a positive decimal, e.g. "130.25"')
  .refine((v) => Number(v) > 0, 'Rate must be greater than zero')
  .refine((v) => Number(v) < 1_000_000_000, 'Rate is implausibly large');

// Day precision, matching the column. A rate is a fact about a day, not an
// instant — nobody reconciles to the second.
const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'as_of must be YYYY-MM-DD')
  .refine((v) => !Number.isNaN(Date.parse(v)), 'as_of is not a real date');

export const fxRateCreateSchema = z
  .object({
    base_currency: z.enum(CURRENCIES),
    quote_currency: z.enum(CURRENCIES),
    rate: rateString,
    as_of: isoDate,
    source: z.string().max(64).optional().nullable(),
  })
  .refine((data) => data.base_currency !== data.quote_currency, {
    message: 'base_currency and quote_currency must differ',
    path: ['quote_currency'],
  });

export const fxRateQuerySchema = paginationSchema.extend({
  base_currency: z.enum(CURRENCIES).optional(),
  quote_currency: z.enum(CURRENCIES).optional(),
  // Absent means "the tenant's own and the shared ones", which is what
  // findRate sees. 'own' narrows to rates this operator loaded.
  scope: z.enum(['all', 'own']).default('all'),
});

// The rate that a conversion on this date would actually pick. Exposed because
// "why was this booking converted at 129.45" is the first question anybody
// asks of a foreign-currency ledger entry, and answering it by reading the
// list and reimplementing findRate's ordering by eye is how people get it
// wrong.
export const fxRateResolveSchema = z
  .object({
    base_currency: z.enum(CURRENCIES),
    quote_currency: z.enum(CURRENCIES),
    on_date: isoDate,
  })
  .refine((data) => data.base_currency !== data.quote_currency, {
    message: 'base_currency and quote_currency must differ',
    path: ['quote_currency'],
  });

export const validateFxRateCreate = (data) => fxRateCreateSchema.parse(data);
export const validateFxRateQuery = (data) => fxRateQuerySchema.parse(data);
export const validateFxRateResolve = (data) => fxRateResolveSchema.parse(data);
