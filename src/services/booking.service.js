// src/services/booking.service.js
import { eq, and, or, gte, lte, desc, asc, sql } from 'drizzle-orm';
import { withTenantDb, currentTenantId } from '#config/tenantContext.js';
import { tenants } from '#models/tenant.model.js';
import {
  raiseBookingReceivable,
  voidBookingReceivables,
} from './bookingLedger.service.js';
import {
  bookings,
  generateBookingReferenceSimple,
} from '#models/booking.model.js';
import { tours } from '#models/tour.model.js';
import { validateBooking } from '#validations/booking.validation.js';
import { cache } from '#utils/cache.js';
import { CacheKeys } from '#utils/cacheKeys.js';
import {
  invalidateBooking,
  invalidateStats,
} from '#utils/cacheInvalidation.js';
import { withRetry } from '#utils/dbRetry.js';
import logger from '#config/logger.js';
import { emailService } from './email.service.js';
import {
  isTourCurrentlyBookable,
  resolvePricingPeriod,
  resolveTierForGroupSize,
} from '#validations/tour.validation.js';

/**
 * A rejection the customer can act on (bad dates, mismatched package) rather
 * than a server fault. error.middleware.js honours `statusCode`, so these
 * surface as 400s instead of being reported as 500s.
 */
const clientError = (message) => {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
};

/**
 * Create a new booking (with cache invalidation)
 */
export const createBooking = async (data) => {
  try {
    const validated = validateBooking(data);

    // Fetch tour
    const [tour] = await withTenantDb((tx) =>
      tx.select().from(tours).where(eq(tours.id, validated.tour_id)).limit(1)
    );

    if (!tour) {
      throw new Error('Tour not found');
    }

    if (tour.status !== 'published') {
      throw new Error('This tour is not available for booking');
    }

    // ✅ UPDATED: Validate that group size is reasonable (1-20 people)
    if (validated.group_size < 1 || validated.group_size > 20) {
      throw new Error('Group size must be between 1 and 20 people');
    }

    // ✅ Check availability with requested group size
    const availability = await checkTourAvailability(
      validated.tour_id,
      validated.start_date,
      validated.end_date,
      validated.group_size
    );

    if (!availability.available) {
      throw new Error(
        `Only ${availability.available_spots} spots available for these dates`
      );
    }

    // ✅ Resolve pricing from the period covering the travel start date
    const hasPricingPeriods =
      Array.isArray(tour.pricing_periods) && tour.pricing_periods.length > 0;

    // Prices are charged exactly as entered — the tier's price_per_person IS
    // the price. compare_at_price is display-only and never affects what the
    // customer pays.
    let pricePerPerson;
    let currency;

    if (hasPricingPeriods) {
      const period = resolvePricingPeriod(
        tour.pricing_periods,
        validated.start_date
      );

      if (!period) {
        throw clientError(
          'No pricing is available for these travel dates. Please contact us for a custom quote.'
        );
      }

      // Pricing is server-authoritative: the tier follows from group_size, so
      // a client cannot pick a cheaper package than its group qualifies for.
      const resolved = resolveTierForGroupSize(period, validated.group_size);

      if (!resolved) {
        throw clientError(
          'No pricing is available for these travel dates. Please contact us for a custom quote.'
        );
      }

      if (
        validated.selected_tier_index !== undefined &&
        validated.selected_tier_index !== null &&
        validated.selected_tier_index !== resolved.index
      ) {
        throw clientError(
          `Selected pricing package does not match your group size of ${validated.group_size}`
        );
      }

      pricePerPerson = parseFloat(resolved.tier.price_per_person);
      currency = resolved.tier.currency;
    } else {
      if (tour.price_amount === null || tour.price_amount === undefined) {
        throw clientError(
          'No pricing is available for this tour. Please contact us for a custom quote.'
        );
      }
      pricePerPerson = parseFloat(tour.price_amount);
      currency = tour.price_currency;
    }

    const totalPrice = pricePerPerson * validated.group_size;

    // Generate booking reference
    // The operator's own prefix, not a deployment-wide env var — branding is
    // tenant configuration. Falls back inside the generator if unset.
    const [tenant] = await withTenantDb((tx) =>
      tx
        .select({ prefix: tenants.booking_ref_prefix })
        .from(tenants)
        .where(eq(tenants.id, currentTenantId()))
        .limit(1)
    );
    const bookingReference = generateBookingReferenceSimple(tenant?.prefix);

    // Create booking
    let booking;
    try {
      const result = await withTenantDb((tx) =>
        tx
          .insert(bookings)
          .values({
            ...validated,
            // Assigned after the spread so caller input cannot set it. Not
            // exploitable today — every spread here is Zod output and the schemas
            // strip unknown keys — but the ordering is the thing that guarantees it.
            tenant_id: currentTenantId(),
            // After the spread, so they cannot be overridden by input even if
            // the schema is later loosened. A booking becomes confirmed or
            // paid only through a payment flow.
            status: 'pending',
            payment_status: 'pending',
            booking_reference: bookingReference,
            price_per_person: pricePerPerson.toFixed(2),
            total_price: totalPrice.toFixed(2),
            currency,
            updated_at: new Date(),
          })
          .returning()
      );

      if (!result || result.length === 0) {
        throw new Error(
          'Failed to create booking - no data returned from database'
        );
      }

      booking = result[0];
    } catch (insertError) {
      logger.error('Database insert error:', {
        error: insertError.message,
        code: insertError.code,
        detail: insertError.detail,
        validated,
      });
      throw new Error(`Failed to create booking: ${insertError.message}`);
    }

    // Fetch complete booking with relations
    let completeBooking;
    try {
      completeBooking = await withTenantDb((tx) =>
        tx.query.bookings.findFirst({
          where: eq(bookings.id, booking.id),
          with: {
            tour: true,
            user: true,
          },
        })
      );

      if (!completeBooking) {
        logger.warn(
          'Could not fetch complete booking with relations, using basic booking'
        );
        completeBooking = { ...booking, tour, user: null };
      }
    } catch (fetchError) {
      logger.error('Error fetching complete booking:', fetchError);
      completeBooking = { ...booking, tour, user: null };
    }

    // Raise the receivable. Never throws — a booking must not fail because its
    // accrual did; that is a reconciliation problem, not a reason to reject a
    // customer who has committed.
    await raiseBookingReceivable(completeBooking ?? booking);

    // Invalidate relevant caches
    try {
      await cache.delPattern(CacheKeys.patterns.userBookings(booking.user_id));
      await cache.delPattern(CacheKeys.patterns.bookingLists());
      await cache.del(CacheKeys.tourStats(booking.tour_id));
      await cache.del(CacheKeys.tourBookings(booking.tour_id));
      await invalidateStats();
    } catch (cacheError) {
      logger.error('Cache invalidation error (non-critical):', cacheError);
    }

    // Send confirmation email
    try {
      await emailService.sendBookingConfirmation(completeBooking);
      logger.info('Booking confirmation email sent successfully', {
        bookingId: booking.id,
      });
    } catch (emailError) {
      logger.error('Failed to send booking confirmation email:', {
        bookingId: booking.id,
        error: emailError.message,
      });
    }

    // Send admin notification
    try {
      await emailService.sendAdminBookingNotification(completeBooking);
    } catch (emailError) {
      logger.error('Failed to send admin notification:', emailError);
    }

    logger.info('Booking created and caches invalidated:', {
      id: booking.id,
      reference: bookingReference,
      tour: tour.title,
      selected_tier: validated.selected_tier_index,
      //tier_capacity: selectedTier.pax,
      actual_group_size: validated.group_size,
      price_per_person: pricePerPerson.toFixed(2),
      total_price: totalPrice.toFixed(2),
      currency,
    });

    return completeBooking;
  } catch (error) {
    logger.error('Failed to create booking:', {
      error: error.message,
      stack: error.stack,
      code: error.code,
      detail: error.detail,
    });
    throw error;
  }
};
/**
 *
 * Get bookings with filters (with caching and retry)
 */
export const getBookings = async (filters = {}) => {
  try {
    const cacheKey = CacheKeys.bookingsList(filters);

    return await cache.wrap(cacheKey, 300, () => {
      return withRetry(async () => {
        const conditions = [];

        if (filters.status) {
          conditions.push(eq(bookings.status, filters.status));
        }

        if (filters.payment_status) {
          conditions.push(eq(bookings.payment_status, filters.payment_status));
        }

        if (filters.tour_id) {
          conditions.push(eq(bookings.tour_id, filters.tour_id));
        }

        if (filters.user_id) {
          conditions.push(eq(bookings.user_id, filters.user_id));
        }

        if (filters.start_date) {
          conditions.push(gte(bookings.start_date, filters.start_date));
        }

        if (filters.end_date) {
          conditions.push(lte(bookings.start_date, filters.end_date));
        }

        const whereClause =
          conditions.length > 0 ? and(...conditions) : undefined;

        const results = await withTenantDb((tx) =>
          tx.query.bookings.findMany({
            where: whereClause,
            with: {
              tour: {
                columns: {
                  id: true,
                  title: true,
                  slug: true,
                  cover_image: true,
                },
              },
              user: {
                columns: {
                  id: true,
                  email: true,
                  given_name: true,
                  family_name: true,
                },
              },
            },
            orderBy: desc(bookings.created_at),
            limit: filters.limit || 100,
            offset: filters.offset || 0,
          })
        );

        return results;
      });
    });
  } catch (error) {
    logger.error('Failed to get bookings:', error);
    throw error;
  }
};

/**
 * Get booking by ID (with caching and retry)
 */
export const getBookingById = async (id) => {
  try {
    const cacheKey = CacheKeys.booking(id);

    return await cache.wrap(cacheKey, 300, () => {
      return withRetry(async () => {
        const booking = await withTenantDb((tx) =>
          tx.query.bookings.findFirst({
            where: eq(bookings.id, id),
            with: {
              tour: true, // Remove the nested with
              user: true,
            },
          })
        );

        return booking || null;
      });
    });
  } catch (error) {
    logger.error('Failed to get booking by ID:', { id, error });
    throw error;
  }
};

/**
 * Get booking by reference (with caching and retry)
 */
export const getBookingByReference = async (reference) => {
  try {
    const cacheKey = CacheKeys.bookingReference(reference.toUpperCase());

    return await cache.wrap(cacheKey, 300, () => {
      return withRetry(async () => {
        const booking = await withTenantDb((tx) =>
          tx.query.bookings.findFirst({
            where: eq(bookings.booking_reference, reference.toUpperCase()),
            with: {
              tour: true,
              user: {
                columns: {
                  id: true,
                  email: true,
                  given_name: true,
                  family_name: true,
                },
              },
            },
          })
        );

        return booking || null;
      });
    });
  } catch (error) {
    logger.error('Failed to get booking by reference:', { reference, error });
    throw error;
  }
};

/**
 * Get user's bookings (with caching and retry)
 */
export const getUserBookings = async (userId, filters = {}) => {
  try {
    const cacheKey = CacheKeys.userBookings(userId, filters);

    return await cache.wrap(cacheKey, 300, () => {
      return withRetry(async () => {
        const conditions = [eq(bookings.user_id, userId)];

        if (filters.status) {
          conditions.push(eq(bookings.status, filters.status));
        }

        const results = await withTenantDb((tx) =>
          tx.query.bookings.findMany({
            where: and(...conditions),
            with: {
              tour: true,
            },
            orderBy: desc(bookings.created_at),
            limit: filters.limit || 50,
            offset: filters.offset || 0,
          })
        );

        return results;
      });
    });
  } catch (error) {
    logger.error('Failed to get user bookings:', { userId, error });
    throw error;
  }
};

/**
 * Update booking status (with cache invalidation)
 */

export const updateBookingStatus = async (id, status) => {
  try {
    const [updated] = await withTenantDb((tx) =>
      tx
        .update(bookings)
        .set({
          status,
          updated_at: new Date(),
        })
        .where(eq(bookings.id, id))
        .returning()
    );

    if (updated) {
      // A cancelled booking should stop showing as money owed. Void rather
      // than delete: the accrual was posted, so the row stays and its status
      // changes. Anything already settled against it is left alone — that is
      // a refund question, not a bookkeeping one.
      if (status === 'cancelled') {
        await voidBookingReceivables(updated.id);
      }

      // Invalidate caches using helper
      await invalidateBooking(
        updated.id,
        updated.user_id,
        updated.tour_id,
        updated.booking_reference
      );
      await invalidateStats();

      logger.info('Booking status updated and caches invalidated:', {
        id,
        status,
      });
    }

    return updated || null;
  } catch (error) {
    logger.error('Failed to update booking status:', { id, error });
    throw error;
  }
};

/**
 * Update payment status (with cache invalidation)
 */

export const updatePaymentStatus = async (id, paymentStatus, paymentMethod) => {
  try {
    const updateData = {
      payment_status: paymentStatus,
      updated_at: new Date(),
    };

    if (paymentMethod) {
      updateData.payment_method = paymentMethod;
    }

    // If payment is successful, auto-confirm booking
    if (paymentStatus === 'paid') {
      updateData.status = 'confirmed';
    }

    const [updated] = await withTenantDb((tx) =>
      tx.update(bookings).set(updateData).where(eq(bookings.id, id)).returning()
    );

    if (updated) {
      // Fetch complete booking for email
      const completeBooking = await withTenantDb((tx) =>
        tx.query.bookings.findFirst({
          where: eq(bookings.id, id),
          with: {
            tour: true,
            user: true,
          },
        })
      );

      // Send payment confirmation email if paid
      if (paymentStatus === 'paid') {
        try {
          await emailService.sendPaymentConfirmation(completeBooking);
          logger.info('Payment confirmation email sent');
        } catch (emailError) {
          logger.error(
            'Failed to send payment confirmation email:',
            emailError
          );
        }
      }

      // Invalidate caches using helper
      await invalidateBooking(
        updated.id,
        updated.user_id,
        updated.tour_id,
        updated.booking_reference
      );
      await invalidateStats();

      logger.info('Payment status updated and caches invalidated:', {
        id,
        paymentStatus,
      });

      return completeBooking;
    }

    return updated || null;
  } catch (error) {
    logger.error('Failed to update payment status:', { id, error });
    throw error;
  }
};

/**
 * Cancel booking (with cache invalidation)
 */

export const cancelBooking = async (id) => {
  try {
    // Fetch booking before cancelling for email
    const bookingToCancel = await withTenantDb((tx) =>
      tx.query.bookings.findFirst({
        where: eq(bookings.id, id),
        with: {
          tour: true,
          user: true,
        },
      })
    );

    const [cancelled] = await withTenantDb((tx) =>
      tx
        .update(bookings)
        .set({
          status: 'cancelled',
          cancelled_at: new Date(),
          updated_at: new Date(),
        })
        .where(eq(bookings.id, id))
        .returning()
    );

    if (cancelled) {
      // cancelBooking is a separate path from updateBookingStatus, so voiding
      // has to happen here too — otherwise a booking cancelled through this
      // route keeps showing as money owed. Safe to repeat: it only touches
      // rows still 'open'.
      await voidBookingReceivables(cancelled.id);

      // Send cancellation email
      try {
        await emailService.sendBookingCancellation(bookingToCancel);
        logger.info('Cancellation email sent');
      } catch (emailError) {
        logger.error('Failed to send cancellation email:', emailError);
      }

      // Invalidate caches using helper
      await invalidateBooking(
        cancelled.id,
        cancelled.user_id,
        cancelled.tour_id,
        cancelled.booking_reference
      );
      await invalidateStats();

      logger.info('Booking cancelled and caches invalidated:', { id });
    }

    return cancelled || null;
  } catch (error) {
    logger.error('Failed to cancel booking:', { id, error });
    throw error;
  }
};

/**
 * Get booking statistics (with caching and retry)
 */
export const getBookingStats = async (filters = {}) => {
  try {
    const cacheKey = CacheKeys.bookingStats(filters);

    return await cache.wrap(cacheKey, 600, () => {
      return withRetry(async () => {
        const conditions = [];

        if (filters.tour_id) {
          conditions.push(eq(bookings.tour_id, filters.tour_id));
        }

        if (filters.start_date) {
          conditions.push(gte(bookings.created_at, filters.start_date));
        }

        if (filters.end_date) {
          conditions.push(lte(bookings.created_at, filters.end_date));
        }

        const whereClause =
          conditions.length > 0 ? and(...conditions) : undefined;

        const [stats] = await withTenantDb((tx) =>
          tx
            .select({
              total_bookings: sql`count(*)::int`,
              pending: sql`sum(case when ${bookings.status} = 'pending' then 1 else 0 end)::int`,
              confirmed: sql`sum(case when ${bookings.status} = 'confirmed' then 1 else 0 end)::int`,
              cancelled: sql`sum(case when ${bookings.status} = 'cancelled' then 1 else 0 end)::int`,
              completed: sql`sum(case when ${bookings.status} = 'completed' then 1 else 0 end)::int`,
              total_revenue: sql`sum(case when ${bookings.payment_status} = 'paid' then ${bookings.total_price}::numeric else 0 end)`,
              pending_revenue: sql`sum(case when ${bookings.payment_status} = 'pending' then ${bookings.total_price}::numeric else 0 end)`,
            })
            .from(bookings)
            .where(whereClause)
        );

        return {
          total_bookings: parseInt(stats.total_bookings || 0),
          pending: parseInt(stats.pending || 0),
          confirmed: parseInt(stats.confirmed || 0),
          cancelled: parseInt(stats.cancelled || 0),
          completed: parseInt(stats.completed || 0),
          total_revenue: parseFloat(stats.total_revenue || 0).toFixed(2),
          pending_revenue: parseFloat(stats.pending_revenue || 0).toFixed(2),
        };
      });
    });
  } catch (error) {
    logger.error('Failed to get booking stats:', error);
    throw error;
  }
};

/**
 * ✅ UPDATED: Check tour availability - now allows any group size (1-20)
 */
export const checkTourAvailability = async (
  tourId,
  startDate,
  endDate,
  requestedGroupSize
) => {
  try {
    const tour = await withTenantDb((tx) =>
      tx.query.tours.findFirst({
        where: eq(tours.id, tourId),
      })
    );

    if (!tour) {
      throw new Error('Tour not found');
    }

    // ✅ Simple validation: 1-20 people allowed
    if (requestedGroupSize) {
      if (requestedGroupSize < 1) {
        throw new Error('Group size must be at least 1 person');
      }
      if (requestedGroupSize > 20) {
        throw new Error('Maximum group size is 20 people');
      }
    }

    // Check seasonal availability — every pricing period is already in the past
    if (!isTourCurrentlyBookable(tour.pricing_periods)) {
      throw clientError(
        'This tour has no current pricing. Please contact us for a custom quote.'
      );
    }

    // Get existing bookings for the date range
    const existingBookings = await withTenantDb((tx) =>
      tx.query.bookings.findMany({
        where: and(
          eq(bookings.tour_id, tourId),
          or(eq(bookings.status, 'confirmed'), eq(bookings.status, 'pending')),
          // Standard interval overlap: starts on or before the window ends,
          // and ends on or after it begins. The previous endpoint-in-range
          // test missed bookings that span the whole window — a ten-day
          // booking straddling a three-day query counted as zero booked
          // spots, so the tour could be overbooked.
          and(
            lte(bookings.start_date, endDate),
            gte(bookings.end_date, startDate)
          )
        ),
      })
    );

    const bookedSpots = existingBookings.reduce(
      (sum, booking) => sum + booking.group_size,
      0
    );

    // Use a reasonable max capacity (can be adjusted)
    const maxCapacity = 50;
    const availableSpots = maxCapacity - bookedSpots;

    return {
      available:
        availableSpots > 0 && availableSpots >= (requestedGroupSize || 1),
      available_spots: Math.max(0, availableSpots),
      booked_spots: bookedSpots,
      max_capacity: maxCapacity,
      is_currently_bookable: isTourCurrentlyBookable(tour.pricing_periods),
    };
  } catch (error) {
    logger.error('Failed to check tour availability:', { tourId, error });
    throw error;
  }
};

/**
 * Get upcoming bookings for a user
 */
export const getUpcomingBookings = async (userId, limit = 5) => {
  try {
    return await withRetry(async () => {
      const now = new Date().toISOString();

      const results = await withTenantDb((tx) =>
        tx.query.bookings.findMany({
          where: and(
            eq(bookings.user_id, userId),
            gte(bookings.start_date, now),
            or(eq(bookings.status, 'confirmed'), eq(bookings.status, 'pending'))
          ),
          with: {
            tour: true,
          },
          orderBy: asc(bookings.start_date),
          limit,
        })
      );

      return results;
    });
  } catch (error) {
    logger.error('Failed to get upcoming bookings:', { userId, error });
    throw error;
  }
};

/**
 * Get past bookings for a user
 */
export const getPastBookings = async (userId, limit = 10) => {
  try {
    return await withRetry(async () => {
      const now = new Date().toISOString();

      const results = await withTenantDb((tx) =>
        tx.query.bookings.findMany({
          where: and(
            eq(bookings.user_id, userId),
            lte(bookings.end_date, now),
            eq(bookings.status, 'completed')
          ),
          with: {
            tour: true,
          },
          orderBy: desc(bookings.end_date),
          limit,
        })
      );

      return results;
    });
  } catch (error) {
    logger.error('Failed to get past bookings:', { userId, error });
    throw error;
  }
};

// Add to your bookings service/queries file
export const getRevenueStats = async (_filters = {}) => {
  try {
    const cacheKey = CacheKeys.revenueStats();
    return await cache.wrap(cacheKey, 600, () => {
      return withRetry(async () => {
        // Get monthly data for last 12 months
        const monthlyData = await withTenantDb((tx) =>
          tx.execute(sql`
          WITH monthly_stats AS (
            SELECT
              TO_CHAR(DATE_TRUNC('month', created_at), 'Mon') as month,
              DATE_TRUNC('month', created_at) as month_date,
              SUM(CASE
                WHEN currency = 'KES' THEN total_price / 130.0
                ELSE total_price
              END) as revenue,
              COUNT(*) as bookings,
              -- ✅ NEW: Track average price per person
              AVG(CASE
                WHEN currency = 'KES' THEN COALESCE(price_per_person, total_price / NULLIF(group_size, 0)) / 130.0
                ELSE COALESCE(price_per_person, total_price / NULLIF(group_size, 0))
              END) as avg_price_per_person,
              -- ✅ NEW: Track total people (guests)
              SUM(group_size) as total_guests
            FROM ${bookings}
            WHERE
              created_at >= NOW() - INTERVAL '12 months'
              AND status IN ('confirmed', 'completed')
              AND payment_status = 'paid'
            GROUP BY DATE_TRUNC('month', created_at)
            ORDER BY DATE_TRUNC('month', created_at)
          )
          SELECT
            month,
            ROUND(CAST(revenue AS NUMERIC), 2) as revenue,
            bookings::int,
            ROUND(CAST(avg_price_per_person AS NUMERIC), 2) as avg_price_per_person,
            total_guests::int
          FROM monthly_stats
        `)
        );

        const rows = monthlyData;

        // Calculate stats
        const totalRevenue = rows.reduce(
          (sum, row) => sum + parseFloat(row.revenue),
          0
        );
        const totalBookings = rows.reduce(
          (sum, row) => sum + parseInt(row.bookings),
          0
        );
        // ✅ NEW: Total guests served
        const totalGuests = rows.reduce(
          (sum, row) => sum + parseInt(row.total_guests || 0),
          0
        );

        const avgMonthlyRevenue =
          rows.length > 0 ? totalRevenue / rows.length : 0;

        // ✅ NEW: Overall average price per person
        const avgPricePerPerson =
          rows.length > 0
            ? rows.reduce(
                (sum, row) => sum + parseFloat(row.avg_price_per_person || 0),
                0
              ) / rows.length
            : 0;

        // Best month
        const bestMonth = rows.reduce(
          (max, row) =>
            parseFloat(row.revenue) > parseFloat(max.revenue) ? row : max,
          rows[0] || { month: 'N/A', revenue: 0 }
        );

        // Growth percentage
        let growthPercentage = 0;
        if (rows.length >= 2) {
          const lastMonth = parseFloat(rows[rows.length - 1].revenue);
          const prevMonth = parseFloat(rows[rows.length - 2].revenue);
          if (prevMonth > 0) {
            growthPercentage = ((lastMonth - prevMonth) / prevMonth) * 100;
          }
        }

        return {
          monthly_data: rows.map((row) => ({
            month: row.month,
            revenue: parseFloat(row.revenue),
            bookings: parseInt(row.bookings),
            avg_price_per_person: parseFloat(row.avg_price_per_person || 0), // ✅ NEW
            total_guests: parseInt(row.total_guests || 0), // ✅ NEW
            target: 20000, // Optional target
          })),
          total_revenue: Math.round(totalRevenue * 100) / 100,
          average_monthly_revenue: Math.round(avgMonthlyRevenue * 100) / 100,
          total_bookings: totalBookings,
          total_guests: totalGuests, // ✅ NEW
          avg_price_per_person: Math.round(avgPricePerPerson * 100) / 100, // ✅ NEW
          growth_percentage: Math.round(growthPercentage * 10) / 10,
          best_month: {
            month: bestMonth.month,
            revenue: parseFloat(bestMonth.revenue),
          },
        };
      });
    });
  } catch (error) {
    logger.error('Failed to get revenue stats:', error);
    throw error;
  }
};

export const getBookingTrends = async () => {
  try {
    const cacheKey = CacheKeys.bookingTrends();

    return await cache.wrap(cacheKey, 600, () => {
      return withRetry(async () => {
        const result = await withTenantDb((tx) =>
          tx.execute(sql`
          WITH current_year AS (
            SELECT 
              TO_CHAR(DATE_TRUNC('month', created_at), 'Mon') as month,
              DATE_TRUNC('month', created_at) as month_date,
              COUNT(*) as bookings
            FROM bookings
            WHERE 
              EXTRACT(YEAR FROM created_at) = EXTRACT(YEAR FROM NOW())
              AND status IN ('confirmed', 'completed')
            GROUP BY DATE_TRUNC('month', created_at)
          ),
          previous_year AS (
            SELECT 
              TO_CHAR(DATE_TRUNC('month', created_at), 'Mon') as month,
              DATE_TRUNC('month', created_at) as month_date,
              COUNT(*) as bookings
            FROM bookings
            WHERE 
              EXTRACT(YEAR FROM created_at) = EXTRACT(YEAR FROM NOW()) - 1
              AND status IN ('confirmed', 'completed')
            GROUP BY DATE_TRUNC('month', created_at)
          )
          SELECT 
            cy.month,
            cy.bookings as current_year,
            COALESCE(py.bookings, 0) as prev_year
          FROM current_year cy
          LEFT JOIN previous_year py 
            ON EXTRACT(MONTH FROM cy.month_date) = EXTRACT(MONTH FROM py.month_date)
          ORDER BY cy.month_date;
        `)
        );

        const monthlyData = result;

        const totalBookings = monthlyData.reduce(
          (sum, row) => sum + parseInt(row.current_year),
          0
        );
        const avgPerMonth =
          monthlyData.length > 0
            ? Math.round(totalBookings / monthlyData.length)
            : 0;

        // Calculate trend (last month vs previous month)
        let trend = 0;
        if (monthlyData.length >= 2) {
          const lastMonth = parseInt(
            monthlyData[monthlyData.length - 1].current_year
          );
          const prevMonth = parseInt(
            monthlyData[monthlyData.length - 2].current_year
          );
          if (prevMonth > 0) {
            trend = Math.round(((lastMonth - prevMonth) / prevMonth) * 100);
          }
        }

        return {
          monthly_data: monthlyData.map((row) => ({
            month: row.month,
            current_year: parseInt(row.current_year),
            prev_year: parseInt(row.prev_year),
          })),
          total_bookings: totalBookings,
          avg_per_month: avgPerMonth,
          trend,
        };
      });
    });
  } catch (error) {
    logger.error('Failed to get booking trends:', error);
    throw error;
  }
};
