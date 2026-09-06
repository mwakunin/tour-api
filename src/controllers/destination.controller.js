// src/controllers/destination.controller.js
import {
  createDestination,
  getDestinations,
  getDestinationById,
  getDestinationBySlug,
  updateDestination,
  deleteDestination,
  getDestinationWithTours,
  getDestinationStats,
  getRevenueBreakdown,
} from '#services/destination.service.js';
import { validateDestinationQuery } from '#validations/destination.validation.js';
import logger from '#config/logger.js';

/**
 * Get all destinations with optional filters
 * GET /destinations?featured=true&country=Kenya
 */
export const getAllDestinations = async (req, res, next) => {
  try {
    const validatedQuery = validateDestinationQuery(req.query);
    const { page, limit, ...filters } = validatedQuery;

    const offset = (parseInt(page) - 1) * parseInt(limit);

    const { data, cached } = await getDestinations({
      ...filters,
      limit,
      offset,
    });

    res.json({
      success: true,
      data,
      count: data.length,
      page,
      limit,
      ...(cached && { cached: true }),
    });
  } catch (error) {
    if (error.name === 'ZodError') {
      return res.status(400).json({
        success: false,
        error: 'Invalid query parameters',
        details: error.issues,
      });
    }
    logger.error('[Destination Controller] Get all error:', error);
    next(error);
  }
};

/**
 * Get single destination by ID
 */
export const getDestination = async (req, res, next) => {
  try {
    const { data, cached } = await getDestinationById(req.params.id);

    if (!data) {
      return res.status(404).json({
        success: false,
        error: 'Destination not found',
      });
    }

    res.json({
      success: true,
      data,
      ...(cached && { cached: true }),
    });
  } catch (error) {
    logger.error('[Destination Controller] Get by ID error:', error);
    next(error);
  }
};

/**
 * Get destination by slug
 */
export const getDestinationBySlugController = async (req, res, next) => {
  try {
    const { data, cached } = await getDestinationBySlug(req.params.slug);

    if (!data) {
      return res.status(404).json({
        success: false,
        error: 'Destination not found',
      });
    }

    res.json({
      success: true,
      data,
      ...(cached && { cached: true }),
    });
  } catch (error) {
    logger.error('[Destination Controller] Get by slug error:', error);
    next(error);
  }
};

/**
 * Create new destination
 */
export const createDestinationController = async (req, res, next) => {
  try {
    const destination = await createDestination(req.body);

    res.status(201).json({
      success: true,
      data: destination,
      message: 'Destination created successfully',
    });
  } catch (error) {
    if (error.name === 'ZodError') {
      return res.status(400).json({
        success: false,
        error: 'Validation error',
        details: error.issues,
      });
    }
    logger.error('[Destination Controller] Create error:', error);
    next(error);
  }
};

/**
 * Update destination
 */
export const updateDestinationController = async (req, res, next) => {
  try {
    const destination = await updateDestination(req.params.id, req.body);

    if (!destination) {
      return res.status(404).json({
        success: false,
        error: 'Destination not found',
      });
    }

    res.json({
      success: true,
      data: destination,
      message: 'Destination updated successfully',
    });
  } catch (error) {
    if (error.name === 'ZodError') {
      return res.status(400).json({
        success: false,
        error: 'Validation error',
        details: error.issues,
      });
    }
    logger.error('[Destination Controller] Update error:', error);
    next(error);
  }
};

/**
 * Delete destination
 */
export const deleteDestinationController = async (req, res, next) => {
  try {
    const destination = await deleteDestination(req.params.id);

    if (!destination) {
      return res.status(404).json({
        success: false,
        error: 'Destination not found',
      });
    }

    res.json({
      success: true,
      message: 'Destination deleted successfully',
    });
  } catch (error) {
    // ✅ Handle specific error cases
    if (error.message === 'Destination not found') {
      return res.status(404).json({
        success: false,
        error: 'Destination not found',
      });
    }

    logger.error('[Destination Controller] Delete error:', error);
    next(error);
  }
};

export const getDestinationWithToursController = async (req, res, next) => {
  try {
    const { data, cached } = await getDestinationWithTours(req.params.id);

    if (!data) {
      return res.status(404).json({
        success: false,
        error: 'Destination not found',
      });
    }

    res.json({
      success: true,
      data,
      ...(cached && { cached: true }),
    });
  } catch (error) {
    logger.error('[Destination Controller] Get with tours error:', error);
    next(error);
  }
};

/**
 * Get destination statistics
 * GET /destinations/:id/stats
 */
export const getDestinationStatsController = async (req, res, next) => {
  try {
    const { data, cached } = await getDestinationStats(req.params.id);

    res.json({
      success: true,
      data,
      ...(cached && { cached: true }),
    });
  } catch (error) {
    logger.error('[Destination Controller] Get stats error:', error);
    next(error);
  }
};

export const getRevenueBreakdownController = async (req, res, next) => {
  try {
    const { data, cached } = await getRevenueBreakdown();

    res.json({
      success: true,
      data,
      ...(cached && { cached: true }),
    });
  } catch (error) {
    logger.error(
      '[Destinations Controller] Get revenue breakdown error:',
      error
    );
    next(error);
  }
};
