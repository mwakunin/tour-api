// src/controllers/ledgerOutbox.controller.js
import { listEntries } from '#services/ledgerOutbox.service.js';
import { drainOutbox } from '#services/bookingLedger.service.js';
import {
  outboxQuerySchema,
  drainSchema,
} from '#validations/ledgerOutbox.validation.js';
import logger from '#config/logger.js';

// Zod v4 reports on `.issues`; `.errors` is undefined and drops every detail.
const zodError = (res, error) =>
  res.status(400).json({
    success: false,
    error: 'Validation error',
    details: error.issues,
  });

const isZod = (error) => error.name === 'ZodError';

export const listOutboxController = async (req, res, next) => {
  try {
    const filters = outboxQuerySchema.parse(req.query);
    const { data, total, page, limit } = await listEntries(filters);

    res.json({ success: true, data, count: data.length, total, page, limit });
  } catch (error) {
    if (isZod(error)) return zodError(res, error);
    logger.error('[Ledger Outbox Controller] List error:', error);
    next(error);
  }
};

export const drainOutboxController = async (req, res, next) => {
  try {
    const { limit } = drainSchema.parse(req.body ?? {});
    const result = await drainOutbox({ limit });

    // 200, not 202: the work is done by the time this answers. There is no
    // scheduler in this deployment, so nothing is queued behind it.
    res.json({ success: true, data: result });
  } catch (error) {
    if (isZod(error)) return zodError(res, error);
    logger.error('[Ledger Outbox Controller] Drain error:', error);
    next(error);
  }
};
