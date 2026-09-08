// src/controllers/payable.controller.js
import {
  listPayables,
  payCounterparty,
  PAYABLE_COUNTERPARTY_NOT_FOUND,
  NOTHING_OWED,
} from '#services/payable.service.js';
import { validatePayCounterparty } from '#validations/payable.validation.js';
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
  [PAYABLE_COUNTERPARTY_NOT_FOUND]: 404,
  // Not a 404: the counterparty exists, and paying somebody who is owed
  // nothing is a request that cannot be carried out rather than one aimed at
  // something missing.
  [NOTHING_OWED]: 422,
};

export const listPayablesController = async (req, res, next) => {
  try {
    const { id } = uuidParamSchema.parse(req.params);
    const payables = await listPayables(id);

    // Cache-Control: no-store comes from the router — see noStore in
    // cache.middleware.js. Setting it here as well is how the neighbouring
    // reads ended up without it.
    res.json({ success: true, data: payables });
  } catch (error) {
    if (isZod(error)) return zodError(res, error);
    const status = STATUS[error.message];
    if (status) {
      return res.status(status).json({ success: false, error: error.message });
    }
    logger.error('[Payable Controller] List error:', error);
    next(error);
  }
};

export const payCounterpartyController = async (req, res, next) => {
  try {
    const { id } = uuidParamSchema.parse(req.params);
    const validated = validatePayCounterparty(req.body);
    const result = await payCounterparty(id, validated);

    res.status(201).json({ success: true, data: result });
  } catch (error) {
    if (isZod(error)) return zodError(res, error);

    // decimalToCents rejects an amount past exact representation, and the
    // money layer rejects a mismatched currency or direction. Both are the
    // caller's mistake rather than a server fault.
    if (error.message.startsWith('[money]')) {
      return res.status(400).json({ success: false, error: error.message });
    }

    const status = STATUS[error.message];
    if (status) {
      return res.status(status).json({ success: false, error: error.message });
    }

    logger.error('[Payable Controller] Pay error:', error);
    next(error);
  }
};
