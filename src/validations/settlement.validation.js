// src/validations/settlement.validation.js
import { z } from 'zod';
import { paginationSchema } from './common.js';
import { decimalToCents } from '#utils/money.js';

export const unmatchedQuerySchema = paginationSchema.extend({
  // Money that arrived without a home, and money that left without one, are
  // two different worklists for two different people — the first is a customer
  // payment nobody could match, the second is a payment to a supplier that
  // cleared nothing.
  direction: z.enum(['in', 'out']).optional(),
  counterparty_id: z.string().uuid().optional(),
});

export const matchSettlementSchema = z.object({
  obligation_id: z.string().uuid('obligation_id must be a UUID'),

  // Optional: without it, as much of the settlement as the obligation can take.
  // That is what somebody clearing a worklist means by "match these", and
  // making them compute the smaller of two numbers by hand is how the wrong
  // one gets typed.
  amount: z
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
    }, 'Amount is larger than this system can represent exactly')
    .optional(),

  note: z.string().max(500).optional().nullable(),
});

export const validateUnmatchedQuery = (data) =>
  unmatchedQuerySchema.parse(data);
export const validateMatchSettlement = (data) =>
  matchSettlementSchema.parse(data);
