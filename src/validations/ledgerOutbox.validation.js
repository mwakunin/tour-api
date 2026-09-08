// src/validations/ledgerOutbox.validation.js
import { z } from 'zod';

export const outboxQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(50),

  // Default true: the reason to open this list is to see what is outstanding.
  // ?pending=false asks for the history as well.
  pending: z
    .enum(['true', 'false'])
    .default('true')
    .transform((value) => value === 'true'),
});

export const drainSchema = z.object({
  // Bounded so one call cannot hold a connection while it works through an
  // unbounded backlog. Drain again for the rest.
  limit: z.coerce.number().int().positive().max(200).default(50),
});
