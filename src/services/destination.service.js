// src/services/destination.service.js
import { eq, and, or, sql, ilike } from 'drizzle-orm';
import { db } from '#config/database.js';
import { destinations } from '#models/destination.model.js';
import {
  validateDestination,
  validateDestinationUpdate,
} from '#validations/destination.validation.js';
import { cache } from '#utils/cache.js';
import { CacheKeys } from '#utils/cacheKeys.js';
import { invalidateDestination } from '#utils/cacheInvalidation.js';
import { withRetry } from '#utils/dbRetry.js';
import logger from '#config/logger.js';
import { formatTourResponse } from './tour.service.js';

/**
 * Create a new destination
 * @param {Object} data - Destination data
 * @returns {Promise<Object>} Created destination
 */
export const createDestination = async (data) => {
  try {
    const validated = validateDestination(data);

    const [destination] = await db
      .insert(destinations)
      .values({
        ...validated,
        updated_at: new Date(),
      })
      .returning();

    // Invalidate list caches after creation
    await cache.delPattern(CacheKeys.patterns.destinationLists());
    await cache.delPattern(CacheKeys.patterns.allStats());

    logger.info('Destination created and caches invalidated:', {
      id: destination.id,
      slug: destination.slug,
    });

    return destination;
  } catch (error) {
    logger.error('Failed to create destination:', error);
    throw error;
  }
};

/**
 * Get destinations with optional filters (with caching and retry)
 * @param {Object} filters - Filter options
 * @returns {Promise<Object>} { data, cached }
 */

export const getDestinations = async (filters = {}) => {
  try {
    // Normalize search to lowercase for consistent caching
    const normalizedFilters = {
      ...filters,
      search: filters.search?.toLowerCase(),
    };

    // Build cache key from NORMALIZED filters
    const cacheKey = CacheKeys.destinationsList(normalizedFilters); // ✅ Changed from filters

    // Use cache.wrap for read-through caching
    return await cache.wrap(cacheKey, 3600, () => {
      return withRetry(async () => {
        const conditions = [];

        // Filter by featured status
        if (normalizedFilters.featured !== undefined) {
          const isFeatured =
            normalizedFilters.featured === 'true' ||
            normalizedFilters.featured === true;
          conditions.push(eq(destinations.featured, isFeatured));
        }

        // Filter by country
        if (normalizedFilters.country) {
          conditions.push(eq(destinations.country, normalizedFilters.country));
        }

        // Filter by region
        if (normalizedFilters.region) {
          conditions.push(eq(destinations.region, normalizedFilters.region));
        }

        // Search by title or description
        if (normalizedFilters.search) {
          conditions.push(
            or(
              ilike(destinations.title, `%${normalizedFilters.search}%`),
              ilike(destinations.description, `%${normalizedFilters.search}%`)
            )
          );
        }

        // Build where clause
        const whereClause =
          conditions.length > 0 ? and(...conditions) : undefined;

        // Determine sort order
        const sortBy = normalizedFilters.sort_by || 'created_at';
        const sortOrder = normalizedFilters.sort_order || 'desc';

        // Execute query with tour counts
        const results = await db.query.destinations.findMany({
          where: whereClause,
          orderBy: (destinations, { asc, desc }) => [
            sortOrder === 'asc'
              ? asc(destinations[sortBy])
              : desc(destinations[sortBy]),
          ],
          limit: normalizedFilters.limit || 100,
          offset: normalizedFilters.offset || 0,
          with: {
            tourDestinations: {
              columns: { id: true },
            },
          },
        });

        // Transform to include tour count
        return results.map((dest) => ({
          ...dest,
          tours_count: dest.tourDestinations?.length || 0,
          tourDestinations: undefined,
        }));
      });
    });
  } catch (error) {
    logger.error('Failed to get destinations:', error);
    throw error;
  }
};

/**
 * Get destination by ID (with caching and retry)
 * @param {string} id - Destination UUID
 * @returns {Promise<Object>} { data, cached }
 */
export const getDestinationById = async (id) => {
  try {
    const cacheKey = CacheKeys.destination(id);

    return await cache.wrap(cacheKey, 3600, () => {
      return withRetry(async () => {
        const [destination] = await db
          .select()
          .from(destinations)
          .where(eq(destinations.id, id))
          .limit(1);

        return destination || null;
      });
    });
  } catch (error) {
    logger.error('Failed to get destination by ID:', { id, error });
    throw error;
  }
};

/**
 * Get destination by slug (with caching and retry)
 * @param {string} slug - Destination slug
 * @returns {Promise<Object>} { data, cached }
 */
export const getDestinationBySlug = async (slug) => {
  try {
    const cacheKey = CacheKeys.destinationSlug(slug);

    return await cache.wrap(cacheKey, 3600, () => {
      return withRetry(async () => {
        const [destination] = await db
          .select()
          .from(destinations)
          .where(eq(destinations.slug, slug))
          .limit(1);

        return destination || null;
      });
    });
  } catch (error) {
    logger.error('Failed to get destination by slug:', { slug, error });
    throw error;
  }
};

export const getDestinationWithTours = async (id) => {
  try {
    const cacheKey = CacheKeys.destinationTours(id);
    return await cache.wrap(cacheKey, 3600, () => {
      return withRetry(async () => {
        const destination = await db.query.destinations.findFirst({
          where: eq(destinations.id, id),
          with: {
            tourDestinations: {
              with: {
                tour: {
                  where: (tours, { eq }) => eq(tours.status, 'published'),
                  // ✅ REMOVE columns restriction to get all fields
                },
              },
              orderBy: (tourDestinations, { asc }) => [
                asc(tourDestinations.order),
              ],
            },
          },
        });

        if (!destination) {
          return null;
        }

        return {
          ...destination,
          tours: destination.tourDestinations
            .map((td) => td.tour)
            .filter((tour) => tour !== null)
            .map(formatTourResponse), // ✅ ADD THIS to format each tour
        };
      });
    });
  } catch (error) {
    logger.error('Failed to get destination with tours:', { id, error });
    throw error;
  }
};
/**
 * Update destination (with cache invalidation)
 * @param {string} id - Destination UUID
 * @param {Object} data - Update data
 * @returns {Promise<Object|null>} Updated destination or null
 */

export const updateDestination = async (id, data) => {
  try {
    const validated = validateDestinationUpdate(data);

    const [updated] = await db
      .update(destinations)
      .set({
        ...validated,
        updated_at: new Date(),
      })
      .where(eq(destinations.id, id))
      .returning();

    if (updated) {
      // Invalidate all related caches
      await invalidateDestination(updated.id, updated.slug);

      logger.info('Destination updated and caches invalidated:', {
        id: updated.id,
        slug: updated.slug,
      });
    }

    return updated || null;
  } catch (error) {
    logger.error('Failed to update destination:', { id, error });
    throw error;
  }
};

/**
 * Delete destination (with cache invalidation)
 * @param {string} id - Destination UUID
 * @returns {Promise<Object>} Success response
 */
export const deleteDestination = async (id) => {
  try {
    // ✅ CHANGED: Check if destination has tours through junction table
    const destination = await db.query.destinations.findFirst({
      where: eq(destinations.id, id),
      with: {
        tourDestinations: {
          columns: { id: true },
          limit: 1,
        },
      },
    });

    if (!destination) {
      throw new Error('Destination not found');
    }

    // ✅ CHANGED: Check tourDestinations instead of tours
    if (
      destination.tourDestinations &&
      destination.tourDestinations.length > 0
    ) {
      throw new Error(
        'Cannot delete destination with associated tours. Delete or reassign tours first.'
      );
    }

    await db.delete(destinations).where(eq(destinations.id, id));

    // Invalidate all related caches
    await invalidateDestination(destination.id, destination.slug);

    // Also invalidate tour list caches since tours reference destinations
    await cache.delPattern(CacheKeys.patterns.tourLists());

    logger.info('Destination deleted and caches invalidated:', { id });

    return { success: true, message: 'Destination deleted successfully' };
  } catch (error) {
    logger.error('Failed to delete destination:', { id, error });
    throw error;
  }
};

/**
 * Get destination statistics (with caching and retry)
 * @param {string} id - Destination UUID
 * @returns {Promise<Object>} { data, cached }
 */
export const getDestinationStats = async (id) => {
  try {
    const cacheKey = CacheKeys.destinationStats(id);

    return await cache.wrap(cacheKey, 600, () => {
      return withRetry(async () => {
        // ✅ CHANGED: Get tours through junction table
        const destination = await db.query.destinations.findFirst({
          where: eq(destinations.id, id),
          with: {
            tourDestinations: {
              with: {
                tour: {
                  columns: {
                    id: true,
                    status: true,
                  },
                },
              },
            },
          },
        });

        if (!destination) {
          throw new Error('Destination not found');
        }

        // ✅ Extract tours from junction table
        const tours = destination.tourDestinations
          .map((td) => td.tour)
          .filter((t) => t !== null);

        const totalTours = tours.length;
        const publishedTours = tours.filter(
          (t) => t.status === 'published'
        ).length;
        const draftTours = tours.filter((t) => t.status === 'draft').length;

        return {
          destination_id: id,
          total_tours: totalTours,
          published_tours: publishedTours,
          draft_tours: draftTours,
        };
      });
    });
  } catch (error) {
    logger.error('Failed to get destination stats:', { id, error });
    throw error;
  }
};

export const getRevenueBreakdown = async () => {
  try {
    const cacheKey = CacheKeys.destinationRevenue();

    return await cache.wrap(cacheKey, 600, () => {
      return withRetry(async () => {
        const result = await db.execute(sql`
          WITH destination_revenue AS (
            SELECT 
              d.id,
              d.title as name,
              SUM(CASE 
                WHEN b.currency = 'KES' THEN b.total_price / 130.0
                ELSE b.total_price 
              END) as revenue
            FROM destinations d
            INNER JOIN tour_destinations td ON d.id = td.destination_id
            INNER JOIN bookings b ON td.tour_id = b.tour_id
            WHERE b.status IN ('confirmed', 'completed')
            GROUP BY d.id, d.title
          ),
          total AS (
            SELECT SUM(revenue) as total_revenue FROM destination_revenue
          )
          SELECT 
            dr.name,
            ROUND(CAST(dr.revenue AS NUMERIC), 2) as revenue,
            ROUND(CAST((dr.revenue / t.total_revenue * 100) AS NUMERIC), 1) as percentage
          FROM destination_revenue dr
          CROSS JOIN total t
          ORDER BY dr.revenue DESC;
        `);
        const destinations = result.map((row) => ({
          name: row.name,
          revenue: parseFloat(row.revenue),
          percentage: parseFloat(row.percentage),
        }));

        const totalRevenue = destinations.reduce(
          (sum, d) => sum + d.revenue,
          0
        );
        const topDestination = destinations[0] || {
          name: 'N/A',
          revenue: 0,
          percentage: 0,
        };

        return {
          destinations,
          total_revenue: Math.round(totalRevenue * 100) / 100,
          top_destination: topDestination,
        };
      });
    });
  } catch (error) {
    logger.error('Failed to get destination revenue breakdown:', error);
    throw error;
  }
};
