// src/controllers/settlement.controller.js
import {
  listUnmatched,
  matchSettlement,
  SETTLEMENT_NOT_FOUND,
  OBLIGATION_NOT_FOUND,
  NOTHING_LEFT,
  NOTHING_OWED,
  COUNTERPARTY_MISMATCH,
} from '#services/settlement.service.js';
import {
  validateUnmatchedQuery,
  validateMatchSettlement,
} from '#validations/settlement.validation.js';
import { uuidParamSchema } from '#validations/common.js';
import logger from '#config/logger.js';

// Zod v4 reports on `.issues`; `.errors` is undefined and drops every detail.
const zodError = (res, error) =>
  res.status(400).json({
    success: false,
    error: 'Validation error',
    details: error.issues,
  });

const isZod = (error) => error.name === 'ZodError';

const STATUS = {
  [SETTLEMENT_NOT_FOUND]: 404,
  [OBLIGATION_NOT_FOUND]: 404,
  // Both rows exist; the match is just no longer possible, usually because
  // somebody else cleared it from the same worklist a moment earlier.
  [NOTHING_LEFT]: 409,
  [NOTHING_OWED]: 409,
  // Both rows exist and both are usable; pairing these two is the mistake.
  [COUNTERPARTY_MISMATCH]: 422,
};

export const listUnmatchedController = async (req, res, next) => {
  try {
    const filters = validateUnmatchedQuery(req.query);
    const { data, total, page, limit } = await listUnmatched(filters);

    // Cache-Control: no-store comes from the router — see noStore in
    // cache.middleware.js.
    res.json({ success: true, data, count: data.length, total, page, limit });
  } catch (error) {
    if (isZod(error)) return zodError(res, error);
    logger.error('[Settlement Controller] Unmatched list error:', error);
    next(error);
  }
};

export const matchSettlementController = async (req, res, next) => {
  try {
    const { id } = uuidParamSchema.parse(req.params);
    const validated = validateMatchSettlement(req.body);
    const result = await matchSettlement(id, validated);

    res.status(201).json({ success: true, data: result });
  } catch (error) {
    if (isZod(error)) return zodError(res, error);

    const status = STATUS[error.message];
    if (status) {
      return res.status(status).json({ success: false, error: error.message });
    }

    // money.allocate refuses a currency mismatch, a direction that does not
    // agree, an obligation that is not open, and over-allocating either side.
    // Every one of those is the caller choosing the wrong pair, not a server
    // fault.
    if (error.message.startsWith('[money]')) {
      return res.status(422).json({ success: false, error: error.message });
    }

    logger.error('[Settlement Controller] Match error:', error);
    next(error);
  }
};
