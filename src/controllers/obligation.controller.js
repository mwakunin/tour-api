// src/controllers/obligation.controller.js
import { listOpenObligations } from '#services/obligation.service.js';
import { validateObligationQuery } from '#validations/obligation.validation.js';
import logger from '#config/logger.js';

const zodError = (res, error) =>
  res.status(400).json({
    success: false,
    error: 'Validation error',
    details: error.issues,
  });

export const listObligationsController = async (req, res, next) => {
  try {
    const filters = validateObligationQuery(req.query);
    const { data, total, page, limit } = await listOpenObligations(filters);

    res.json({ success: true, data, count: data.length, total, page, limit });
  } catch (error) {
    if (error.name === 'ZodError') return zodError(res, error);
    logger.error('[Obligation Controller] List error:', error);
    next(error);
  }
};
