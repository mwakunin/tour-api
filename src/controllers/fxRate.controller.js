// src/controllers/fxRate.controller.js
import {
  listFxRates,
  getFxRateById,
  createFxRate,
  resolveFxRate,
  removeFxRate,
  FX_RATE_NOT_FOUND,
  FX_RATE_DUPLICATE,
  FX_RATE_IN_USE,
} from '#services/fxRate.service.js';
import {
  validateFxRateCreate,
  validateFxRateQuery,
  validateFxRateResolve,
} from '#validations/fxRate.validation.js';
import logger from '#config/logger.js';

// Zod v4 reports on `.issues`; `.errors` is undefined and would drop every
// detail silently.
const zodError = (res, error) =>
  res.status(400).json({
    success: false,
    error: 'Validation error',
    details: error.issues,
  });

const isZod = (error) => error.name === 'ZodError';

// decimalToPpm throws for a rate that rounds to zero or leaves the safe
// integer range. Those are caller mistakes, not server faults, so they answer
// 400 rather than falling through to a 500.
const isBadRate = (error) => error.message.startsWith('[money]');

const send = (res, error, fallback) => {
  if (error.message === FX_RATE_NOT_FOUND) {
    return res.status(404).json({ success: false, error: FX_RATE_NOT_FOUND });
  }
  if (error.message === FX_RATE_DUPLICATE) {
    return res.status(409).json({ success: false, error: FX_RATE_DUPLICATE });
  }
  if (error.message === FX_RATE_IN_USE) {
    return res.status(409).json({ success: false, error: FX_RATE_IN_USE });
  }
  return fallback();
};

export const listFxRatesController = async (req, res, next) => {
  try {
    const filters = validateFxRateQuery(req.query);
    const { data, total, page, limit } = await listFxRates(filters);
    res.json({ success: true, data, count: data.length, total, page, limit });
  } catch (error) {
    if (isZod(error)) return zodError(res, error);
    logger.error('[FX Rate Controller] List error:', error);
    next(error);
  }
};

// Before '/:id', so 'resolve' is not read as an id.
export const resolveFxRateController = async (req, res, next) => {
  try {
    const query = validateFxRateResolve(req.query);
    const rate = await resolveFxRate(query);
    res.json({ success: true, data: rate });
  } catch (error) {
    if (isZod(error)) return zodError(res, error);
    return send(res, error, () => {
      logger.error('[FX Rate Controller] Resolve error:', error);
      next(error);
    });
  }
};

export const getFxRateController = async (req, res, next) => {
  try {
    const rate = await getFxRateById(req.params.id);
    res.json({ success: true, data: rate });
  } catch (error) {
    return send(res, error, () => {
      logger.error('[FX Rate Controller] Get error:', error);
      next(error);
    });
  }
};

export const createFxRateController = async (req, res, next) => {
  try {
    const validated = validateFxRateCreate(req.body);
    const rate = await createFxRate(validated);
    res.status(201).json({ success: true, data: rate });
  } catch (error) {
    if (isZod(error)) return zodError(res, error);
    if (isBadRate(error)) {
      return res.status(400).json({ success: false, error: error.message });
    }
    return send(res, error, () => {
      logger.error('[FX Rate Controller] Create error:', error);
      next(error);
    });
  }
};

export const deleteFxRateController = async (req, res, next) => {
  try {
    const rate = await removeFxRate(req.params.id);
    res.json({ success: true, data: rate });
  } catch (error) {
    return send(res, error, () => {
      logger.error('[FX Rate Controller] Delete error:', error);
      next(error);
    });
  }
};
