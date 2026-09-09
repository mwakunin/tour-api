// src/validations/obligation.validation.js
import { z } from 'zod';
import { paginationSchema } from './common.js';

const CURRENCIES = ['USD', 'KES'];

export const obligationQuerySchema = paginationSchema.extend({
  // Money in can only clear a receivable and money out only a payable, so the
  // worklist filters on this rather than offering candidates the allocation
  // would refuse.
  direction: z.enum(['receivable', 'payable']).optional(),
  currency: z.enum(CURRENCIES).optional(),
  counterparty_id: z.string().uuid().optional(),
  search: z.string().max(200).optional(),
});

export const validateObligationQuery = (data) =>
  obligationQuerySchema.parse(data);
