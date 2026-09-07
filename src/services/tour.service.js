// src/services/tour.service.js
import {
  eq,
  and,
  or,
  desc,
  asc,
  sql,
  gte,
  lte,
  ilike,
  inArray,
} from 'drizzle-orm';
import { withTenantDb, currentTenantId } from '#config/tenantContext.js';
import { tours, tourDestinations } from '#models/tour.model.js';
import {
  validateTour,
  validateTourUpdate,
  getDiscountedPrice,
  getPriceDisplay,
  getPriceRangeDisplay,
  getDisplayCurrency,
  getTierSavings,
  computeHeadlineDiscount,
  isTourCurrentlyBookable,
  getGroupSizeRange,
  toDateKey,
} from '#validations/tour.validation.js';
import { cache } from '#utils/cache.js';
import { CacheKeys } from '#utils/cacheKeys.js';
import { withRetry } from '#utils/dbRetry.js';
import logger from '#config/logger.js';

// ============= PRICING SQL FRAGMENTS =============
// Tiers live nested inside pricing_periods, so every price predicate needs a
// double unnest: periods first, then that period's tiers. Aliased `pp`/`t`
// because `period` is an SQL:2011 keyword.

/**
 * True when the tour has any tier, in any period, matching the price bound.
 * @param {'>=' | '<='} operator
 */
const tierPriceMatches = (operator, value) => sql`EXISTS (
  SELECT 1
  FROM jsonb_array_elements(${tours.pricing_periods}) AS pp,
       jsonb_array_elements(pp->'pricing_tiers') AS t
  WHERE (t->>'price_per_person')::numeric ${sql.raw(operator)} ${value}
)`;

/**
 * Cheapest per-person price anywhere in the tour's periods, falling back to
 * the flat base price for tours with no periods. NULLS LAST keeps tours with
 * neither a period nor a base price from floating to the top of an asc sort.
 */
const lowestPriceOrderBy = (direction) => sql`
  COALESCE(
    (SELECT MIN((t->>'price_per_person')::numeric)
     FROM jsonb_array_elements(${tours.pricing_periods}) AS pp,
          jsonb_array_elements(pp->'pricing_tiers') AS t),
    ${tours.price_amount}::numeric
  ) ${sql.raw(direction)} NULLS LAST`;

// ============= LIVE OFFER SQL =============
// `tours.discount_percentage` is a write-time summary across ALL seasons, so
// it can name a promo that has since expired. Deals eligibility and ranking
// are therefore computed fresh from seasons that HAVEN'T ENDED — a discount
// nobody can still book must not keep a tour in the carousel, nor rank it.

/** True when some not-yet-ended season has a tier priced below its compare-at. */
const hasLiveSeasonalOffer = sql`EXISTS (
  SELECT 1
  FROM jsonb_array_elements(${tours.pricing_periods}) AS pp,
       jsonb_array_elements(pp->'pricing_tiers') AS tr
  WHERE (pp->>'end_date')::date >= CURRENT_DATE
    AND (tr->>'compare_at_price') IS NOT NULL
    AND (tr->>'compare_at_price')::numeric > (tr->>'price_per_person')::numeric
)`;

/** Flat-priced products have no season to expire, so their offer is always live. */
const hasLiveFlatOffer = sql`(
  COALESCE(jsonb_array_length(${tours.pricing_periods}), 0) = 0
  AND ${tours.compare_at_amount} IS NOT NULL
  AND ${tours.compare_at_amount}::numeric > ${tours.price_amount}::numeric
)`;

/** Biggest still-bookable saving, as a percentage. 0 when nothing is live. */
const liveDiscountPercent = sql`
  GREATEST(
    COALESCE((
      SELECT MAX(ROUND((1 - (tr->>'price_per_person')::numeric
                          / (tr->>'compare_at_price')::numeric) * 100))
      FROM jsonb_array_elements(${tours.pricing_periods}) AS pp,
           jsonb_array_elements(pp->'pricing_tiers') AS tr
      WHERE (pp->>'end_date')::date >= CURRENT_DATE
        AND (tr->>'compare_at_price') IS NOT NULL
        AND (tr->>'compare_at_price')::numeric > (tr->>'price_per_person')::numeric
    ), 0),
    CASE
      WHEN COALESCE(jsonb_array_length(${tours.pricing_periods}), 0) = 0
       AND ${tours.compare_at_amount} IS NOT NULL
       AND ${tours.compare_at_amount}::numeric > ${tours.price_amount}::numeric
      THEN ROUND((1 - ${tours.price_amount}::numeric
                    / ${tours.compare_at_amount}::numeric) * 100)
      ELSE 0
    END
  )`;

/**
 * Create a new tour (with cache invalidation)
 */

export const createTour = async (data) => {
  try {
    const validated = validateTour(data);

    // Prepare tour data. `pricing` is optional now — period-only tours leave
    // the flat columns null and price off the period covering the travel date.
    // discount_percentage is DERIVED from the compare-at prices, never taken
    // from client input, so it can't drift from the tiers it describes.
    const tourData = {
      ...validated,
      // Assigned after the spread so caller input cannot set it. Not
      // exploitable today — every spread here is Zod output and the schemas
      // strip unknown keys — but the ordering is the thing that guarantees it.
      tenant_id: currentTenantId(),
      price_amount: validated.pricing?.amount?.toString() ?? null,
      price_currency: validated.pricing?.currency ?? null,
      compare_at_amount:
        validated.pricing?.compare_at_amount?.toString() ?? null,
      discount_percentage: computeHeadlineDiscount({
        pricing_periods: validated.pricing_periods,
        amount: validated.pricing?.amount,
        compare_at_amount: validated.pricing?.compare_at_amount,
      }).toString(),
      updated_at: new Date(),
    };

    // Remove fields that don't belong in tours table
    delete tourData.pricing;
    delete tourData.destination_ids; // Remove if present in validated data

    // Extract destination IDs before inserting tour
    const destinationIds = validated.destination_ids || [];

    // Both writes in ONE withTenantDb callback, so they share a transaction.
    // Split across two, a failed destination link — an invalid destination_id
    // is enough — left the tour row committed with no destinations while the
    // caller got an error. updateTour already did this correctly.
    const tour = await withTenantDb(async (tx) => {
      const [created] = await tx.insert(tours).values(tourData).returning();

      if (destinationIds.length > 0) {
        const tourDestinationValues = destinationIds.map((destId, index) => ({
          tenant_id: currentTenantId(),
          tour_id: created.id,
          destination_id: destId,
          order: index, // Preserve order
        }));

        await tx.insert(tourDestinations).values(tourDestinationValues);
      }

      return created;
    });

    // Invalidate list caches after creation
    await cache.delPattern(CacheKeys.patterns.tourLists());
    await cache.delPattern(CacheKeys.patterns.toursFeatured());
    await cache.delPattern(CacheKeys.patterns.toursDeals());
    await cache.delPattern(CacheKeys.patterns.toursSearch());

    // ✅ UPDATED: Invalidate cache for ALL associated destinations
    if (destinationIds.length > 0) {
      await Promise.all(
        destinationIds.map((destId) =>
          cache.del(CacheKeys.destinationTours(destId))
        )
      );
    }

    logger.info('Tour created and caches invalidated:', {
      id: tour.id,
      slug: tour.slug,
      destinations: destinationIds.length,
    });

    return formatTourResponse(tour);
  } catch (error) {
    logger.error('Failed to create tour:', error);
    throw error;
  }
};

export const getTours = async (filters = {}) => {
  try {
    // Normalize search to lowercase for consistent caching
    const normalizedFilters = {
      ...filters,
      search: filters.search?.toLowerCase(),
    };

    logger.debug('[Tours] Listing with filters', {
      filters: normalizedFilters,
    });
    const cacheKey = CacheKeys.toursList(normalizedFilters); // ✅ Use normalizedFilters

    return await cache.wrap(cacheKey, 1800, () => {
      return withRetry(async () => {
        const conditions = [];

        // Simple filters
        if (normalizedFilters.featured !== undefined) {
          conditions.push(eq(tours.featured, normalizedFilters.featured));
        }
        if (normalizedFilters.is_deal !== undefined) {
          conditions.push(eq(tours.is_deal, normalizedFilters.is_deal));
        }
        if (normalizedFilters.status) {
          conditions.push(eq(tours.status, normalizedFilters.status));
        }

        // ✅ FIXED: Category filter - check both singular and plural params
        if (normalizedFilters.category) {
          // Single category from dropdown/filter
          conditions.push(
            sql`${tours.categories}::jsonb @> ${JSON.stringify([normalizedFilters.category])}`
          );
        }

        // ✅ FIXED: Multiple categories (if ever needed)
        if (
          normalizedFilters.categories &&
          Array.isArray(normalizedFilters.categories) &&
          normalizedFilters.categories.length > 0
        ) {
          conditions.push(
            or(
              ...normalizedFilters.categories.map(
                (cat) =>
                  sql`${tours.categories}::jsonb @> ${JSON.stringify([cat])}`
              )
            )
          );
        }
        // Filter by tags
        if (normalizedFilters.tag) {
          conditions.push(
            sql`${tours.tags} @> ${JSON.stringify([normalizedFilters.tag])}`
          );
        }

        if (normalizedFilters.min_price !== undefined) {
          conditions.push(
            or(
              // Flat base price, OR any tier in any pricing period
              gte(
                sql`${tours.price_amount}::numeric`,
                normalizedFilters.min_price
              ),
              tierPriceMatches('>=', normalizedFilters.min_price)
            )
          );
        }

        if (normalizedFilters.max_price !== undefined) {
          conditions.push(
            or(
              lte(
                sql`${tours.price_amount}::numeric`,
                normalizedFilters.max_price
              ),
              tierPriceMatches('<=', normalizedFilters.max_price)
            )
          );
        }

        // Duration filters
        if (normalizedFilters.min_duration !== undefined) {
          conditions.push(gte(tours.duration, normalizedFilters.min_duration));
        }
        if (normalizedFilters.max_duration !== undefined) {
          conditions.push(lte(tours.duration, normalizedFilters.max_duration));
        }
        if (normalizedFilters.duration_unit) {
          conditions.push(
            eq(tours.duration_unit, normalizedFilters.duration_unit)
          );
        }

        // ✅ UPDATED: Case-insensitive search filter
        if (normalizedFilters.search) {
          conditions.push(
            or(
              ilike(tours.title, `%${normalizedFilters.search}%`),
              ilike(tours.overview, `%${normalizedFilters.search}%`)
            )
          );
        }

        const whereClause =
          conditions.length > 0 ? and(...conditions) : undefined;

        let orderByClause;
        switch (normalizedFilters.sort_by) {
          case 'price':
            // Sort by lowest available price (any period's tiers, else base)
            orderByClause = lowestPriceOrderBy(
              normalizedFilters.sort_order === 'asc' ? 'ASC' : 'DESC'
            );
            break;

          case 'duration':
            orderByClause =
              normalizedFilters.sort_order === 'asc'
                ? asc(tours.duration)
                : desc(tours.duration);
            break;

          case 'title':
            orderByClause =
              normalizedFilters.sort_order === 'asc'
                ? asc(tours.title)
                : desc(tours.title);
            break;

          case 'featured':
            orderByClause = desc(tours.featured);
            break;

          default:
            orderByClause =
              normalizedFilters.sort_order === 'asc'
                ? asc(tours.created_at)
                : desc(tours.created_at);
        }

        const results = await withTenantDb((tx) =>
          tx
            .select()
            .from(tours)
            .where(whereClause)
            .orderBy(orderByClause)
            .limit(normalizedFilters.limit || 100)
            .offset(normalizedFilters.offset || 0)
        );

        return results.map(formatTourResponse);
      });
    });
  } catch (error) {
    logger.error('Failed to get tours:', error);
    throw error;
  }
};

/**
 * Get tour by ID (with caching and retry)
 */

export const getTourById = async (id) => {
  try {
    const cacheKey = CacheKeys.tour(id);
    return await cache.wrap(cacheKey, 3600, () => {
      return withRetry(async () => {
        // ✅ Use query API to include destinations
        const tour = await withTenantDb((tx) =>
          tx.query.tours.findFirst({
            where: eq(tours.id, id),
            with: {
              tourDestinations: {
                with: {
                  destination: true,
                },
                orderBy: asc(tourDestinations.order),
              },
            },
          })
        );

        if (!tour) {
          return null;
        }

        // Extract destinations
        const destinations = tour.tourDestinations.map((td) => td.destination);

        return {
          ...formatTourResponse(tour),
          destinations,
        };
      });
    });
  } catch (error) {
    logger.error('Failed to get tour by ID:', { id, error });
    throw error;
  }
};
/**
 * Get tour by slug (with caching and retry)
 */

export const getTourBySlug = async (slug) => {
  try {
    const cacheKey = CacheKeys.tourSlug(slug);
    return await cache.wrap(cacheKey, 3600, () => {
      return withRetry(async () => {
        const tour = await withTenantDb((tx) =>
          tx.query.tours.findFirst({
            where: eq(tours.slug, slug),
            with: {
              tourDestinations: {
                with: {
                  destination: true,
                },
                orderBy: asc(tourDestinations.order),
              },
            },
          })
        );

        if (!tour) {
          return null;
        }

        const destinations = tour.tourDestinations.map((td) => td.destination);

        return {
          ...formatTourResponse(tour),
          destinations,
        };
      });
    });
  } catch (error) {
    logger.error('Failed to get tour by slug:', { slug, error });
    throw error;
  }
};

/**
 * Get tour with destination (with caching and retry)
 */
// ✅ UPDATED: Get tour with ALL destinations (plural)
export const getTourWithDestinations = async (tourId) => {
  try {
    const cacheKey = CacheKeys.tourFull(tourId);
    return await cache.wrap(cacheKey, 3600, () => {
      return withRetry(async () => {
        const tour = await withTenantDb((tx) =>
          tx.query.tours.findFirst({
            where: eq(tours.id, tourId),
            with: {
              tourDestinations: {
                with: {
                  destination: true,
                },
                orderBy: asc(tourDestinations.order), // Respect the order
              },
            },
          })
        );

        if (!tour) {
          return null;
        }

        // Extract just the destination objects from the junction table
        const destinations = tour.tourDestinations.map((td) => td.destination);

        return {
          ...formatTourResponse(tour),
          destinations, // Array of destination objects
        };
      });
    });
  } catch (error) {
    logger.error('Failed to get tour with destinations:', { tourId, error });
    throw error;
  }
};
/**
 * Update tour (with cache invalidation)
 */

export const updateTour = async (id, data) => {
  try {
    const validated = validateTourUpdate(data);

    const updateData = { ...validated };

    if (validated.pricing) {
      updateData.price_amount = validated.pricing.amount?.toString();
      updateData.price_currency = validated.pricing.currency;
      updateData.compare_at_amount =
        validated.pricing.compare_at_amount?.toString() ?? null;
      delete updateData.pricing;
    }
    // Never take discount_percentage from the client — it is derived below
    // from whatever the row looks like after the patch is applied.
    delete updateData.discount_percentage;

    // ✅ NEW: Extract destination_ids if provided
    const newDestinationIds = validated.destination_ids;
    delete updateData.destination_ids; // Remove before update

    updateData.updated_at = new Date();

    // ✅ NEW: Get old destinations BEFORE updating (for cache invalidation)
    const oldTourDestinations = await withTenantDb((tx) =>
      tx
        .select({ destination_id: tourDestinations.destination_id })
        .from(tourDestinations)
        .where(eq(tourDestinations.tour_id, id))
    );

    const oldDestinationIds = oldTourDestinations.map(
      (td) => td.destination_id
    );

    // Use transaction to ensure atomicity. withTenantDb IS that transaction —
    // it opens one and sets app.tenant_id inside it — so this is the same
    // atomicity it always had, now tenant-scoped.
    const updated = await withTenantDb(async (tx) => {
      // Update the tour
      let [updatedTour] = await tx
        .update(tours)
        .set(updateData)
        .where(eq(tours.id, id))
        .returning();

      if (!updatedTour) {
        throw new Error('Tour not found');
      }

      // Recompute the headline discount from the MERGED row — a patch may have
      // touched only the periods, or only the flat compare-at, and either
      // changes the answer.
      const headline = computeHeadlineDiscount({
        pricing_periods: updatedTour.pricing_periods,
        amount: updatedTour.price_amount,
        compare_at_amount: updatedTour.compare_at_amount,
      }).toString();

      if (
        parseFloat(updatedTour.discount_percentage) !== parseFloat(headline)
      ) {
        [updatedTour] = await tx
          .update(tours)
          .set({ discount_percentage: headline })
          .where(eq(tours.id, id))
          .returning();
      }

      // ✅ NEW: Update destinations if provided
      if (newDestinationIds && Array.isArray(newDestinationIds)) {
        // Delete old tour-destination relationships
        await tx
          .delete(tourDestinations)
          .where(eq(tourDestinations.tour_id, id));

        // Insert new relationships
        if (newDestinationIds.length > 0) {
          const tourDestinationValues = newDestinationIds.map(
            (destId, index) => ({
              tenant_id: currentTenantId(),
              tour_id: id,
              destination_id: destId,
              order: index,
            })
          );

          await tx.insert(tourDestinations).values(tourDestinationValues);
        }
      }

      return updatedTour;
    });

    if (updated) {
      // ✅ UPDATED: Invalidate caches for both old AND new destinations
      const allDestinationIds = new Set([
        ...oldDestinationIds,
        ...(newDestinationIds || []),
      ]);

      // Invalidate tour-specific caches
      await cache.del(CacheKeys.tourFull(updated.id));
      //await cache.del(CacheKeys.tourBySlug(updated.slug));
      await cache.del(CacheKeys.tourSlug(updated.slug));

      // Invalidate list caches
      await cache.delPattern(CacheKeys.patterns.tourLists());
      await cache.delPattern(CacheKeys.patterns.toursFeatured());
      await cache.delPattern(CacheKeys.patterns.toursDeals());
      await cache.delPattern(CacheKeys.patterns.toursSearch());

      // Invalidate destination caches
      if (allDestinationIds.size > 0) {
        await Promise.all(
          Array.from(allDestinationIds).map((destId) =>
            cache.del(CacheKeys.destinationTours(destId))
          )
        );
      }

      logger.info('Tour updated and caches invalidated:', {
        id: updated.id,
        slug: updated.slug,
        destinations: allDestinationIds.size,
      });
    }

    return updated ? formatTourResponse(updated) : null;
  } catch (error) {
    logger.error('Failed to update tour:', { id, error });
    throw error;
  }
};

/**
 * Delete tour (with cache invalidation)
 */

export const deleteTour = async (id) => {
  try {
    // ✅ UPDATED: Check for active bookings (pending, confirmed, completed)
    const activeBookings = await withTenantDb((tx) =>
      tx.query.bookings.findFirst({
        where: (bookings, { eq, and, inArray }) =>
          and(
            eq(bookings.tour_id, id),
            inArray(bookings.status, ['pending', 'confirmed', 'completed'])
          ),
        columns: { id: true },
      })
    );

    if (activeBookings) {
      throw new Error(
        'Cannot delete tour with active bookings. Please cancel all bookings first.'
      );
    }

    // ✅ Fetch tour with destinations
    const tour = await withTenantDb((tx) =>
      tx.query.tours.findFirst({
        where: eq(tours.id, id),
        with: {
          tourDestinations: {
            columns: { destination_id: true },
          },
        },
      })
    );

    if (!tour) {
      throw new Error('Tour not found');
    }

    // ✅ NEW: Extract destination IDs before deletion
    const destinationIds = tour.tourDestinations.map((td) => td.destination_id);

    // Delete tour (cascade will handle tour_destinations due to onDelete: 'cascade')
    await withTenantDb((tx) => tx.delete(tours).where(eq(tours.id, id)));

    // ✅ UPDATED: Invalidate caches (FIXED: tourSlug instead of tourBySlug)
    await cache.del(CacheKeys.tourFull(tour.id));
    await cache.del(CacheKeys.tourSlug(tour.slug)); // ✅ FIXED: was tourBySlug
    await cache.del(CacheKeys.tour(tour.id));
    await cache.del(CacheKeys.tourStats(tour.id));

    // Invalidate list caches
    await cache.delPattern(CacheKeys.patterns.tourLists());
    await cache.delPattern(CacheKeys.patterns.toursFeatured());
    await cache.delPattern(CacheKeys.patterns.toursDeals());
    await cache.delPattern(CacheKeys.patterns.toursSearch());

    // Invalidate all associated destination caches
    if (destinationIds.length > 0) {
      await Promise.all(
        destinationIds.map((destId) =>
          Promise.all([
            cache.del(CacheKeys.destinationTours(destId)),
            cache.del(CacheKeys.destinationStats(destId)),
          ])
        )
      );
    }

    // Invalidate stats
    await cache.del(CacheKeys.stats.tourPopularity());

    logger.info('Tour deleted and caches invalidated:', {
      id,
      destinations: destinationIds.length,
    });

    return { success: true, message: 'Tour deleted successfully' };
  } catch (error) {
    logger.error('Failed to delete tour:', { id, error });
    throw error;
  }
};
/**
 * Search tours (with caching and retry)
 */
export const searchTours = async (searchTerm) => {
  try {
    const cacheKey = CacheKeys.toursSearch(searchTerm);

    return await cache.wrap(cacheKey, 900, () => {
      return withRetry(async () => {
        const results = await withTenantDb((tx) =>
          tx
            .select()
            .from(tours)
            .where(
              and(
                eq(tours.status, 'published'),
                or(
                  ilike(tours.title, `%${searchTerm}%`),
                  ilike(tours.overview, `%${searchTerm}%`),
                  sql`${tours.tags}::text ILIKE ${`%${searchTerm}%`}`
                )
              )
            )
            .orderBy(desc(tours.featured), desc(tours.created_at))
            .limit(50)
        );

        return results.map(formatTourResponse);
      });
    });
  } catch (error) {
    logger.error('Failed to search tours:', { searchTerm, error });
    throw error;
  }
};

/**
 * Get featured tours (with caching and retry)
 */
export const getFeaturedTours = async (limit = 6) => {
  try {
    const cacheKey = CacheKeys.toursFeatured(limit);

    return await cache.wrap(cacheKey, 3600, () => {
      return withRetry(async () => {
        const results = await withTenantDb((tx) =>
          tx
            .select()
            .from(tours)
            .where(and(eq(tours.featured, true), eq(tours.status, 'published')))
            .orderBy(desc(tours.created_at))
            .limit(limit)
        );

        return results.map(formatTourResponse);
      });
    });
  } catch (error) {
    logger.error('Failed to get featured tours:', error);
    throw error;
  }
};

/**
 * Get deals (with caching and retry)
 */
export const getDeals = async (limit = 10) => {
  try {
    const cacheKey = CacheKeys.toursDeals(limit);

    return await cache.wrap(cacheKey, 1800, () => {
      return withRetry(async () => {
        const results = await withTenantDb((tx) =>
          tx
            .select({
              tour: tours,
              live_discount_percentage: liveDiscountPercent,
            })
            .from(tours)
            .where(
              and(
                eq(tours.is_deal, true),
                eq(tours.status, 'published'),
                // Eligibility from LIVE offers only, computed fresh — the stored
                // discount_percentage would keep expired promos in the carousel
                or(hasLiveSeasonalOffer, hasLiveFlatOffer)
              )
            )
            // Rank on the still-bookable saving too, so a tour with an expired
            // 50% and a live 10% doesn't outrank a genuine live 30%
            .orderBy(desc(liveDiscountPercent), desc(tours.created_at))
            .limit(limit)
        );

        if (results.length === 0) return [];

        // Destinations come from a follow-up query rather than a join: the
        // live-offer SQL above references tours.* directly, and the relational
        // query builder aliases tables in a way those raw fragments don't
        // survive. Cheap either way — this is capped at `limit` rows and the
        // whole function is cached.
        const tourIds = results.map((row) => row.tour.id);
        const links = await withTenantDb((tx) =>
          tx.query.tourDestinations.findMany({
            where: inArray(tourDestinations.tour_id, tourIds),
            with: { destination: true },
            orderBy: asc(tourDestinations.order),
          })
        );

        const destinationsByTour = new Map();
        for (const link of links) {
          if (!destinationsByTour.has(link.tour_id)) {
            destinationsByTour.set(link.tour_id, []);
          }
          destinationsByTour.get(link.tour_id).push(link.destination);
        }

        return results.map((row) => ({
          ...formatTourResponse({
            ...row.tour,
            discount_percentage: row.live_discount_percentage,
          }),
          // Always an array — a tour with no destinations must not yield
          // `undefined` here, or cards branching on `.length` throw
          destinations: destinationsByTour.get(row.tour.id) ?? [],
        }));
      });
    });
  } catch (error) {
    logger.error('Failed to get deals:', error);
    throw error;
  }
};

/**
 * Get tour statistics (with caching and retry)
 */
export const getTourStats = async (tourId) => {
  try {
    const cacheKey = CacheKeys.tourStats(tourId);

    return await cache.wrap(cacheKey, 300, () => {
      return withRetry(async () => {
        const tour = await withTenantDb((tx) =>
          tx.query.tours.findFirst({
            where: eq(tours.id, tourId),
            with: {
              bookings: {
                columns: {
                  id: true,
                  status: true,
                  total_price: true,
                },
              },
            },
          })
        );

        if (!tour) {
          throw new Error('Tour not found');
        }

        const totalBookings = tour.bookings.length;
        const confirmedBookings = tour.bookings.filter(
          (b) => b.status === 'confirmed'
        ).length;
        const completedBookings = tour.bookings.filter(
          (b) => b.status === 'completed'
        ).length;

        const totalRevenue = tour.bookings
          .filter((b) => b.status === 'confirmed' || b.status === 'completed')
          .reduce((sum, b) => sum + parseFloat(b.total_price || 0), 0);

        return {
          tour_id: tourId,
          total_bookings: totalBookings,
          confirmed_bookings: confirmedBookings,
          completed_bookings: completedBookings,
          total_revenue: totalRevenue.toFixed(2),
          currency: tour.price_currency,
        };
      });
    });
  } catch (error) {
    logger.error('Failed to get tour stats:', { tourId, error });
    throw error;
  }
};

// ============================================
// GET ALL TOURS WITH DESTINATIONS
// ============================================

export const getToursWithDestinations = async (filters = {}) => {
  try {
    // ✅ Normalize search to lowercase for consistent caching
    const normalizedFilters = {
      ...filters,
      search: filters.search?.toLowerCase(),
    };

    const cacheKey = CacheKeys.toursList({
      ...normalizedFilters,
      with_destinations: true,
    });

    return await cache.wrap(cacheKey, 1800, () => {
      return withRetry(async () => {
        const conditions = [];

        // All your existing filters...
        if (normalizedFilters.featured !== undefined) {
          conditions.push(eq(tours.featured, normalizedFilters.featured));
        }
        if (normalizedFilters.is_deal !== undefined) {
          conditions.push(eq(tours.is_deal, normalizedFilters.is_deal));
        }
        if (normalizedFilters.status) {
          conditions.push(eq(tours.status, normalizedFilters.status));
        }

        // Filter by destination using junction table
        if (normalizedFilters.destination_id) {
          // Awaited and unwrapped to ids, not passed through as a builder.
          // This was a Drizzle subquery before the move to withTenantDb, which
          // returns a promise — inArray would have received a Promise object
          // and silently built nonsense.
          const rows = await withTenantDb((tx) =>
            tx
              .select({ tour_id: tourDestinations.tour_id })
              .from(tourDestinations)
              .where(
                eq(
                  tourDestinations.destination_id,
                  normalizedFilters.destination_id
                )
              )
          );
          const tourIds = rows.map((row) => row.tour_id);

          if (tourIds.length === 0) {
            // No tour serves this destination. Without this, inArray on an
            // empty array is a SQL error in some drivers and a match-everything
            // in others; neither is "no results".
            return [];
          }
          conditions.push(inArray(tours.id, tourIds));
        }
        // ✅ Date/Availability filter
        if (normalizedFilters.date) {
          const filterDate = toDateKey(normalizedFilters.date);

          conditions.push(
            or(
              // Flat-priced tours have no periods and are always available
              sql`COALESCE(jsonb_array_length(${tours.pricing_periods}), 0) = 0`,

              // OR some pricing period covers the requested date
              sql`EXISTS (
                SELECT 1
                FROM jsonb_array_elements(${tours.pricing_periods}) AS pp
                WHERE (pp->>'start_date')::date <= ${filterDate}::date
                  AND (pp->>'end_date')::date >= ${filterDate}::date
              )`
            )
          );
        }

        // Filter by category using JSONB
        if (normalizedFilters.category) {
          conditions.push(
            sql`${tours.categories} @> ${JSON.stringify([normalizedFilters.category])}`
          );
        }

        if (normalizedFilters.min_price !== undefined) {
          conditions.push(
            or(
              gte(
                sql`${tours.price_amount}::numeric`,
                normalizedFilters.min_price
              ),
              tierPriceMatches('>=', normalizedFilters.min_price)
            )
          );
        }

        if (normalizedFilters.max_price !== undefined) {
          conditions.push(
            or(
              lte(
                sql`${tours.price_amount}::numeric`,
                normalizedFilters.max_price
              ),
              tierPriceMatches('<=', normalizedFilters.max_price)
            )
          );
        }
        if (normalizedFilters.min_duration !== undefined) {
          conditions.push(gte(tours.duration, normalizedFilters.min_duration));
        }
        if (normalizedFilters.max_duration !== undefined) {
          conditions.push(lte(tours.duration, normalizedFilters.max_duration));
        }
        if (normalizedFilters.duration_unit) {
          conditions.push(
            eq(tours.duration_unit, normalizedFilters.duration_unit)
          );
        }

        // ✅ FIXED: Use ilike for case-insensitive search
        if (normalizedFilters.search) {
          conditions.push(
            or(
              ilike(tours.title, `%${normalizedFilters.search}%`),
              ilike(tours.overview, `%${normalizedFilters.search}%`)
            )
          );
        }

        const whereClause =
          conditions.length > 0 ? and(...conditions) : undefined;

        let orderByClause;

        switch (normalizedFilters.sort_by) {
          case 'price':
            orderByClause = lowestPriceOrderBy(
              normalizedFilters.sort_order === 'asc' ? 'ASC' : 'DESC'
            );
            break;
          case 'duration':
            orderByClause =
              normalizedFilters.sort_order === 'asc'
                ? asc(tours.duration)
                : desc(tours.duration);
            break;
          case 'title':
            orderByClause =
              normalizedFilters.sort_order === 'asc'
                ? asc(tours.title)
                : desc(tours.title);
            break;
          case 'featured':
            orderByClause = desc(tours.featured);
            break;
          default:
            orderByClause =
              normalizedFilters.sort_order === 'asc'
                ? asc(tours.created_at)
                : desc(tours.created_at);
        }

        // ✅ Use query API to include destinations
        const results = await withTenantDb((tx) =>
          tx.query.tours.findMany({
            where: whereClause,
            orderBy: orderByClause,
            limit: normalizedFilters.limit || 100,
            offset: normalizedFilters.offset || 0,
            with: {
              tourDestinations: {
                with: {
                  destination: true,
                },
                orderBy: asc(tourDestinations.order),
              },
            },
          })
        );

        // ✅ Format response with destinations
        return results.map((tour) => {
          const destinations = tour.tourDestinations.map(
            (td) => td.destination
          );
          return {
            ...formatTourResponse(tour),
            destinations,
          };
        });
      });
    });
  } catch (error) {
    logger.error('Failed to get tours with destinations:', error);
    throw error;
  }
};
// ============================================
// GET TOUR BY ID WITH DESTINATIONS
// ============================================

export const getTourByIdWithDestinations = async (id) => {
  try {
    const cacheKey = CacheKeys.tour(id);
    return await cache.wrap(cacheKey, 3600, () => {
      return withRetry(async () => {
        const tour = await withTenantDb((tx) =>
          tx.query.tours.findFirst({
            where: eq(tours.id, id),
            with: {
              tourDestinations: {
                with: {
                  destination: true,
                },
                orderBy: asc(tourDestinations.order),
              },
            },
          })
        );

        if (!tour) {
          return null;
        }

        const destinations = tour.tourDestinations.map((td) => td.destination);

        return {
          ...formatTourResponse(tour),
          destinations,
        };
      });
    });
  } catch (error) {
    logger.error('Failed to get tour by ID with destinations:', { id, error });
    throw error;
  }
};

// ============================================
// GET TOUR BY SLUG WITH DESTINATIONS
// ============================================

export const getTourBySlugWithDestinations = async (slug) => {
  try {
    const cacheKey = CacheKeys.tourSlug(slug);
    return await cache.wrap(cacheKey, 3600, () => {
      return withRetry(async () => {
        const tour = await withTenantDb((tx) =>
          tx.query.tours.findFirst({
            where: eq(tours.slug, slug),
            with: {
              tourDestinations: {
                with: {
                  destination: true,
                },
                orderBy: asc(tourDestinations.order),
              },
            },
          })
        );

        if (!tour) {
          return null;
        }

        const destinations = tour.tourDestinations.map((td) => td.destination);

        return {
          ...formatTourResponse(tour),
          destinations,
        };
      });
    });
  } catch (error) {
    logger.error('Failed to get tour by slug with destinations:', {
      slug,
      error,
    });
    throw error;
  }
};
/**
 * Format tour response with pricing.
 *
 * Every pricing-derived field is computed from the RAW row, before the flat
 * columns are stripped — the display helpers read price_amount/price_currency/
 * discount_percentage directly, so computing them after stripping would
 * silently render every tour as KSh0.00.
 */
export function formatTourResponse(tour) {
  const pricing = {
    // The price charged, as entered. null (not NaN) for period-only tours,
    // which have no flat base price.
    amount:
      tour.price_amount === null || tour.price_amount === undefined
        ? null
        : parseFloat(tour.price_amount),
    // Optional struck-through "was" figure, display only
    compare_at_amount:
      tour.compare_at_amount === null || tour.compare_at_amount === undefined
        ? null
        : parseFloat(tour.compare_at_amount),
    // Falls back to the tier currency for period-only tours, whose flat
    // price_currency column is null
    currency: getDisplayCurrency(tour),
    // Server-derived headline: the biggest saving anywhere on this tour
    discount_percentage: tour.discount_percentage
      ? parseFloat(tour.discount_percentage)
      : 0,
  };

  const periods = Array.isArray(tour.pricing_periods)
    ? tour.pricing_periods
    : [];
  const groupSizeRange = getGroupSizeRange(periods);

  return {
    ...tour,
    pricing,
    // Deprecated alias — prices are charged as entered, so this equals
    // pricing.amount. Kept so existing consumers don't break.
    discounted_price: getDiscountedPrice(pricing),
    price_display: getPriceDisplay(tour),
    price_range_display: getPriceRangeDisplay(periods),

    pricing_display: {
      base_amount: pricing.amount,
      compare_at_amount: pricing.compare_at_amount,
      currency: pricing.currency,
      discount_percentage: pricing.discount_percentage,
      has_discount: pricing.discount_percentage > 0,
      // Saving on the flat price, when the tour has one on offer
      savings: getTierSavings({
        amount: pricing.amount,
        compare_at_amount: pricing.compare_at_amount,
      }),
      min_group_size: groupSizeRange.min,
      max_group_size: groupSizeRange.max,
      has_periods: periods.length > 0,
    },

    is_currently_bookable: isTourCurrentlyBookable(periods),

    // Remove flat pricing fields (keep them in pricing object)
    price_amount: undefined,
    price_currency: undefined,
    compare_at_amount: undefined,
    discount_percentage: undefined,
  };
}

export const getTopPerformingTours = async (metric = 'bookings') => {
  try {
    const cacheKey = CacheKeys.topTours(metric);

    return await cache.wrap(cacheKey, 600, () => {
      return withRetry(async () => {
        const result =
          metric === 'revenue'
            ? await withTenantDb((tx) =>
                tx.execute(sql`
        SELECT 
          t.id,
          t.title as name,
          SUM(CASE 
            WHEN b.currency = 'KES' THEN b.total_price / 130.0
            ELSE b.total_price 
          END) as value
        FROM tours t
        INNER JOIN bookings b ON t.id = b.tour_id
        WHERE b.status IN ('confirmed', 'completed')
        GROUP BY t.id, t.title
        ORDER BY value DESC
        LIMIT 5;
      `)
              )
            : await withTenantDb((tx) =>
                tx.execute(sql`
        SELECT 
          t.id,
          t.title as name,
          COUNT(b.id) as value
        FROM tours t
        INNER JOIN bookings b ON t.id = b.tour_id
        WHERE b.status IN ('confirmed', 'completed')
        GROUP BY t.id, t.title
        ORDER BY value DESC
        LIMIT 5;
      `)
              );
        const tours = result.map((row) => ({
          id: row.id,
          name: row.name,
          value:
            metric === 'revenue' ? parseFloat(row.value) : parseInt(row.value),
        }));

        const topTour = tours[0] || { name: 'N/A', value: 0 };

        return {
          tours,
          top_tour: {
            title: topTour.name,
            value: topTour.value,
          },
        };
      });
    });
  } catch (error) {
    logger.error('Failed to get top performing tours:', error);
    throw error;
  }
};
