// src/controllers/counterparty.controller.js
import {
  listCounterparties,
  getCounterpartyById,
  createCounterparty,
  updateCounterparty,
  removeCounterparty,
  COUNTERPARTY_NOT_FOUND,
} from '#services/counterparty.service.js';
import {
  validateCounterpartyCreate,
  validateCounterpartyUpdate,
  validateCounterpartyQuery,
} from '#validations/counterparty.validation.js';
import logger from '#config/logger.js';

// Zod v4 reports issues on `.issues`, not `.errors` -- reading `.errors` here
// returns undefined and swallows every validation detail.
const zodError = (res, error) =>
  res.status(400).json({
    success: false,
    error: 'Validation error',
    details: error.issues,
  });

const isZod = (error) => error.name === 'ZodError';
const isNotFound = (error) => error.message === COUNTERPARTY_NOT_FOUND;

export const listCounterpartiesController = async (req, res, next) => {
  try {
    const filters = validateCounterpartyQuery(req.query);
    const { data, total, page, limit } = await listCounterparties(filters);

    res.json({
      success: true,
      data,
      count: data.length,
      total,
      page,
      limit,
    });
  } catch (error) {
    if (isZod(error)) return zodError(res, error);
    logger.error('[Counterparty Controller] List error:', error);
    next(error);
  }
};

export const getCounterpartyController = async (req, res, next) => {
  try {
    const counterparty = await getCounterpartyById(req.params.id);
    res.json({ success: true, data: counterparty });
  } catch (error) {
    if (isNotFound(error)) {
      return res
        .status(404)
        .json({ success: false, error: COUNTERPARTY_NOT_FOUND });
    }
    logger.error('[Counterparty Controller] Get error:', error);
    next(error);
  }
};

export const createCounterpartyController = async (req, res, next) => {
  try {
    const validated = validateCounterpartyCreate(req.body);
    const counterparty = await createCounterparty(validated);
    res.status(201).json({ success: true, data: counterparty });
  } catch (error) {
    if (isZod(error)) return zodError(res, error);
    logger.error('[Counterparty Controller] Create error:', error);
    next(error);
  }
};

export const updateCounterpartyController = async (req, res, next) => {
  try {
    const validated = validateCounterpartyUpdate(req.body);
    const counterparty = await updateCounterparty(req.params.id, validated);
    res.json({ success: true, data: counterparty });
  } catch (error) {
    if (isZod(error)) return zodError(res, error);
    if (isNotFound(error)) {
      return res
        .status(404)
        .json({ success: false, error: COUNTERPARTY_NOT_FOUND });
    }
    logger.error('[Counterparty Controller] Update error:', error);
    next(error);
  }
};

export const deleteCounterpartyController = async (req, res, next) => {
  try {
    const { deleted, counterparty } = await removeCounterparty(req.params.id);

    // 200 rather than 204, because the two outcomes differ and the caller has
    // to be able to tell them apart: a counterparty with accounting history
    // cannot be removed, so it is deactivated and stays visible in listings
    // that do not filter on is_active.
    res.json({
      success: true,
      deleted,
      message: deleted
        ? 'Counterparty deleted'
        : 'Counterparty has accounting history and was deactivated instead',
      data: counterparty,
    });
  } catch (error) {
    if (isNotFound(error)) {
      return res
        .status(404)
        .json({ success: false, error: COUNTERPARTY_NOT_FOUND });
    }
    logger.error('[Counterparty Controller] Delete error:', error);
    next(error);
  }
};
