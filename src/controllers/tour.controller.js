// src/controllers/tour.controller.js
import {
  createTour,
  getTours,
  getTourById,
  getTourBySlug,
  getTourWithDestinations,
  getToursWithDestinations,
  getTourByIdWithDestinations,
  getTourBySlugWithDestinations,
  updateTour,
  deleteTour,
  searchTours,
  getFeaturedTours,
  getDeals,
  getTourStats,
  getTopPerformingTours,
} from '#services/tour.service.js';
import {
  validateTourQuery,
  getPeriodDisplay,
  getGroupSizeRange,
} from '#validations/tour.validation.js';
import logger from '#config/logger.js';

export const getAllTours = async (req, res, next) => {
  try {
    const validatedQuery = validateTourQuery(req.query);
    const { page, limit, ...filters } = validatedQuery;

    const offset = (parseInt(page) - 1) * parseInt(limit);

    const { data, cached } = await getTours({
      ...filters,
      limit: parseInt(limit),
      offset,
    });

    res.json({
      success: true,
      data,
      count: data.length,
      page: parseInt(page),
      limit: parseInt(limit),
      ...(cached && { cached: true }),
    });
  } catch (error) {
    logger.error('[Tour Controller] Get all error:', error);
    next(error);
  }
};

export const searchToursController = async (req, res, next) => {
  try {
    const { q } = req.query;

    if (!q || q.trim().length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Search query is required',
      });
    }

    const { data, cached } = await searchTours(q);

    res.json({
      success: true,
      data,
      count: data.length,
      ...(cached && { cached: true }),
    });
  } catch (error) {
    logger.error('[Tour Controller] Search error:', error);
    next(error);
  }
};

export const getFeaturedToursController = async (req, res, next) => {
  try {
    const { limit = 6 } = req.query;
    const { data, cached } = await getFeaturedTours(parseInt(limit));

    res.json({
      success: true,
      data,
      count: data.length,
      ...(cached && { cached: true }),
    });
  } catch (error) {
    logger.error('[Tour Controller] Get featured error:', error);
    next(error);
  }
};

export const getDealsController = async (req, res, next) => {
  try {
    const { limit = 10 } = req.query;
    const { data, cached } = await getDeals(parseInt(limit));

    res.json({
      success: true,
      data,
      count: data.length,
      ...(cached && { cached: true }),
    });
  } catch (error) {
    logger.error('[Tour Controller] Get deals error:', error);
    next(error);
  }
};

export const getTour = async (req, res, next) => {
  try {
    const { data, cached } = await getTourById(req.params.id);

    if (!data) {
      return res.status(404).json({
        success: false,
        error: 'Tour not found',
      });
    }

    // formatTourResponse has already nested the flat columns into `pricing`
    // and stripped them, so read currency/discount from there — reading
    // data.price_currency here would always be undefined.
    const pricing = data.pricing || {
      amount: null,
      currency: null,
      discount_percentage: 0,
    };

    const periods = Array.isArray(data.pricing_periods)
      ? data.pricing_periods
      : [];
    const groupSizeRange = getGroupSizeRange(periods);

    const response = {
      ...data,

      pricing_display: {
        // Already computed by formatTourResponse off the raw row
        display_price: data.price_display,
        price_range: data.price_range_display,

        // Period information — the full seasonal pricing table
        has_periods: periods.length > 0,
        periods,
        period_labels: periods.map((p) => getPeriodDisplay(p)),

        // Currency info
        currency: pricing.currency,
        currency_symbol: pricing.currency === 'USD' ? '$' : 'KSh',

        // Discount info
        has_discount: (pricing.discount_percentage || 0) > 0,
        discount_percentage: pricing.discount_percentage || 0,

        // Group size range across all periods
        min_group_size: groupSizeRange.min,
        max_group_size: groupSizeRange.max,
      },
    };

    res.json({
      success: true,
      data: response,
      ...(cached && { cached: true }),
    });
  } catch (error) {
    logger.error('[Tour Controller] Get by ID error:', error);
    next(error);
  }
};

export const getTourBySlugController = async (req, res, next) => {
  try {
    const { data, cached } = await getTourBySlug(req.params.slug);

    if (!data) {
      return res.status(404).json({
        success: false,
        error: 'Tour not found',
      });
    }

    res.json({
      success: true,
      data,
      ...(cached && { cached: true }),
    });
  } catch (error) {
    logger.error('[Tour Controller] Get by slug error:', error);
    next(error);
  }
};

export const getTourWithDestinationsController = async (req, res, next) => {
  try {
    const { data, cached } = await getTourWithDestinations(req.params.id);

    if (!data) {
      return res.status(404).json({
        success: false,
        error: 'Tour not found',
      });
    }

    res.json({
      success: true,
      data,
      ...(cached && { cached: true }),
    });
  } catch (error) {
    logger.error('[Tour Controller] Get with destination error:', error);
    next(error);
  }
};

export const getTourStatsController = async (req, res, next) => {
  try {
    const { data, cached } = await getTourStats(req.params.id);

    res.json({
      success: true,
      data,
      ...(cached && { cached: true }),
    });
  } catch (error) {
    logger.error('[Tour Controller] Get stats error:', error);
    next(error);
  }
};

export const createTourController = async (req, res, next) => {
  try {
    const tour = await createTour(req.body);

    res.status(201).json({
      success: true,
      data: tour,
      message: 'Tour created successfully',
    });
  } catch (error) {
    if (error.name === 'ZodError') {
      return res.status(400).json({
        success: false,
        error: 'Validation error',
        details: error.issues,
      });
    }
    logger.error('[Tour Controller] Create error:', error);
    next(error);
  }
};

export const updateTourController = async (req, res, next) => {
  try {
    const tour = await updateTour(req.params.id, req.body);

    if (!tour) {
      return res.status(404).json({
        success: false,
        error: 'Tour not found',
      });
    }

    res.json({
      success: true,
      data: tour,
      message: 'Tour updated successfully',
    });
  } catch (error) {
    // ✅ ADD: Check if error is "not found" before other error handling
    if (
      error.message === 'Tour not found' ||
      error.message?.includes('not found')
    ) {
      return res.status(404).json({
        success: false,
        error: 'Tour not found',
      });
    }

    if (error.name === 'ZodError') {
      return res.status(400).json({
        success: false,
        error: 'Validation error',
        details: error.issues,
      });
    }

    logger.error('[Tour Controller] Update error:', error);
    next(error);
  }
};

export const deleteTourController = async (req, res, next) => {
  try {
    const result = await deleteTour(req.params.id);

    // ✅ Add this check
    if (!result) {
      return res.status(404).json({
        success: false,
        error: 'Tour not found',
      });
    }

    res.json({
      success: true,
      message: 'Tour deleted successfully',
    });
  } catch (error) {
    // ✅ Handle specific error cases
    if (error.message === 'Tour not found') {
      return res.status(404).json({
        success: false,
        error: 'Tour not found',
      });
    }

    logger.error('[Tour Controller] Delete error:', error);
    next(error);
  }
};

// ============================================
// ✅ NEW CONTROLLERS (With Destinations)
// ============================================

export const getAllToursWithDestinations = async (req, res, next) => {
  try {
    const validatedQuery = validateTourQuery(req.query);
    const { page, limit, ...filters } = validatedQuery;

    const offset = (parseInt(page) - 1) * parseInt(limit);

    const { data, cached } = await getToursWithDestinations({
      ...filters,
      limit: parseInt(limit),
      offset,
    });

    res.json({
      success: true,
      data,
      count: data.length,
      page: parseInt(page),
      limit: parseInt(limit),
      ...(cached && { cached: true }),
    });
  } catch (error) {
    logger.error('[Tour Controller] Get all with destinations error:', error);
    next(error);
  }
};

export const getTourWithDestinationsById = async (req, res, next) => {
  try {
    const { data, cached } = await getTourByIdWithDestinations(req.params.id);

    if (!data) {
      return res.status(404).json({
        success: false,
        error: 'Tour not found',
      });
    }

    res.json({
      success: true,
      data,
      ...(cached && { cached: true }),
    });
  } catch (error) {
    logger.error('[Tour Controller] Get by ID with destinations error:', error);
    next(error);
  }
};

export const getTourWithDestinationsBySlug = async (req, res, next) => {
  try {
    const { data, cached } = await getTourBySlugWithDestinations(
      req.params.slug
    );

    if (!data) {
      return res.status(404).json({
        success: false,
        error: 'Tour not found',
      });
    }

    res.json({
      success: true,
      data,
      ...(cached && { cached: true }),
    });
  } catch (error) {
    logger.error(
      '[Tour Controller] Get by slug with destinations error:',
      error
    );
    next(error);
  }
};

export const getTopPerformingToursController = async (req, res, next) => {
  try {
    const metric = req.query.metric || 'bookings';

    if (!['bookings', 'revenue'].includes(metric)) {
      return res.status(400).json({
        success: false,
        error: "Invalid metric. Must be 'bookings' or 'revenue'",
      });
    }

    const { data, cached } = await getTopPerformingTours(metric);

    res.json({
      success: true,
      data,
      ...(cached && { cached: true }),
    });
  } catch (error) {
    logger.error('[Tours Controller] Get top performing error:', error);
    next(error);
  }
};
