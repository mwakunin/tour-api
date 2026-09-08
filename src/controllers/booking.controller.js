// src/controllers/booking.controller.js
import {
  createBooking,
  getBookings,
  getBookingById,
  getBookingByReference,
  getUserBookings,
  updateBookingStatus,
  updatePaymentStatus,
  cancelBooking,
  getBookingStats,
  getRevenueStats,
  getBookingTrends,
} from '#services/booking.service.js';
import logger from '#config/logger.js';
import { withTenantDb } from '#config/tenantContext.js';
import { bookings } from '#models/booking.model.js';
import { and, eq, ne } from 'drizzle-orm';
import { invalidateBooking } from '#utils/cacheInvalidation.js';
import {
  bookingCustomerEditableSchema,
  bookingPriceAdjustmentSchema,
} from '#validations/booking.validation.js';
import { paginationSchema, uuidParamSchema } from '#validations/common.js';
import {
  bookingPnl,
  BOOKING_NOT_FOUND as PNL_BOOKING_NOT_FOUND,
} from '#services/bookingPnl.service.js';

export const createBookingController = async (req, res, next) => {
  try {
    const userId = req.user.id;

    const booking = await createBooking({
      ...req.body,
      user_id: userId,
    });

    res.status(201).json({
      success: true,
      data: booking,
      message: 'Booking created successfully',
    });
  } catch (error) {
    if (error.name === 'ZodError') {
      return res.status(400).json({
        success: false,
        error: 'Validation error',
        details: error.issues,
      });
    }
    logger.error('[Booking Controller] Create error:', error);
    next(error);
  }
};

export const getAllBookings = async (req, res, next) => {
  try {
    const { status, payment_status, tour_id, start_date, end_date } = req.query;

    // page=0 produced a negative offset and an unbounded limit reached the
    // query untouched. paginationSchema coerces both, requires page positive
    // and caps limit at 100.
    const { page, limit } = paginationSchema.parse(req.query);
    const offset = (page - 1) * limit;

    const { data, cached } = await getBookings({
      status,
      payment_status,
      tour_id,
      start_date: start_date ? new Date(start_date) : undefined,
      end_date: end_date ? new Date(end_date) : undefined,
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
        error: 'Validation error',
        details: error.issues,
      });
    }
    logger.error('[Booking Controller] Get all error:', error);
    next(error);
  }
};

export const getUserBookingsController = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const { status } = req.query;
    const { page, limit } = paginationSchema.parse(req.query);
    const offset = (page - 1) * limit;

    const { data, cached } = await getUserBookings(userId, {
      status,
      // page, not just offset: CacheKeys.userBookings builds the key from
      // page and defaults a missing one to 1, so every page shared the
      // page-one entry and page two served page one's rows for five minutes.
      page,
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
        error: 'Validation error',
        details: error.issues,
      });
    }
    logger.error('[Booking Controller] Get user bookings error:', error);
    next(error);
  }
};

export const getBooking = async (req, res, next) => {
  try {
    const { data, cached } = await getBookingById(req.params.id);

    if (!data) {
      return res.status(404).json({
        success: false,
        error: 'Booking not found',
      });
    }

    // Only allow user to see their own booking or admin
    if (data.user_id !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({
        success: false,
        error: 'Access denied',
      });
    }

    res.json({
      success: true,
      data,
      ...(cached && { cached: true }),
    });
  } catch (error) {
    logger.error('[Booking Controller] Get by ID error:', error);
    next(error);
  }
};

export const getBookingByReferenceController = async (req, res, next) => {
  try {
    const reference = req.params.reference.toUpperCase();
    const { data, cached } = await getBookingByReference(reference);

    if (!data) {
      return res.status(404).json({
        success: false,
        error: 'Booking not found',
      });
    }

    // This route is public, and a booking carries the customer's name, email,
    // phone and itinerary. The email was previously optional, so anyone who
    // guessed a reference — they are sequential-ish, FA-YYYY-NNNNNN — got all
    // of it. It is now required and must match.
    //
    // Returning the same 404 as a missing booking is deliberate: a distinct
    // 403 would confirm which references exist.
    const { email } = req.query;
    if (
      !email ||
      String(data.customer_email ?? '').toLowerCase() !==
        String(email).toLowerCase()
    ) {
      return res.status(404).json({
        success: false,
        error: 'Booking not found',
      });
    }

    res.json({
      success: true,
      data,
      ...(cached && { cached: true }),
    });
  } catch (error) {
    logger.error('[Booking Controller] Get by reference error:', error);
    next(error);
  }
};

export const updateBookingStatusController = async (req, res, next) => {
  try {
    const { status } = req.body;

    if (
      !status ||
      !['pending', 'confirmed', 'cancelled', 'completed'].includes(status)
    ) {
      return res.status(400).json({
        success: false,
        error: 'Invalid status value',
      });
    }

    const booking = await updateBookingStatus(req.params.id, status);

    if (!booking) {
      return res.status(404).json({
        success: false,
        error: 'Booking not found',
      });
    }

    res.json({
      success: true,
      data: booking,
      message: 'Booking status updated successfully',
    });
  } catch (error) {
    logger.error('[Booking Controller] Update status error:', error);
    next(error);
  }
};

export const updatePaymentStatusController = async (req, res, next) => {
  try {
    const { payment_status, payment_method } = req.body;

    if (
      !payment_status ||
      !['pending', 'paid', 'failed', 'refunded'].includes(payment_status)
    ) {
      return res.status(400).json({
        success: false,
        error: 'Invalid payment status value',
      });
    }

    const booking = await updatePaymentStatus(
      req.params.id,
      payment_status,
      payment_method
    );

    if (!booking) {
      return res.status(404).json({
        success: false,
        error: 'Booking not found',
      });
    }

    res.json({
      success: true,
      data: booking,
      message: 'Payment status updated successfully',
    });
  } catch (error) {
    logger.error('[Booking Controller] Update payment error:', error);
    next(error);
  }
};

export const cancelBookingController = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const bookingId = req.params.id;

    // Get booking to check ownership (from cache)
    const { data: existingBooking } = await getBookingById(bookingId);

    if (!existingBooking) {
      return res.status(404).json({
        success: false,
        error: 'Booking not found',
      });
    }

    // Only allow user to cancel their own booking or admin
    if (existingBooking.user_id !== userId && req.user.role !== 'admin') {
      return res.status(403).json({
        success: false,
        error: 'Access denied',
      });
    }

    const booking = await cancelBooking(bookingId);

    res.json({
      success: true,
      data: booking,
      message: 'Booking cancelled successfully',
    });
  } catch (error) {
    logger.error('[Booking Controller] Cancel error:', error);
    next(error);
  }
};

export const getBookingStatsController = async (req, res, next) => {
  try {
    const { tour_id, start_date, end_date } = req.query;

    const { data, cached } = await getBookingStats({
      tour_id,
      start_date: start_date ? new Date(start_date) : undefined,
      end_date: end_date ? new Date(end_date) : undefined,
    });

    res.json({
      success: true,
      data,
      ...(cached && { cached: true }),
    });
  } catch (error) {
    logger.error('[Booking Controller] Get stats error:', error);
    next(error);
  }
};

export const updateBookingController = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const bookingId = req.params.id;

    // Get existing booking
    const existingBooking = await getBookingById(bookingId);

    if (!existingBooking.data) {
      return res
        .status(404)
        .json({ success: false, error: 'Booking not found' });
    }

    // Check ownership
    if (existingBooking.data.user_id !== userId && req.user.role !== 'admin') {
      return res.status(403).json({ success: false, error: 'Access denied' });
    }

    // Only allow editing unpaid bookings
    if (existingBooking.data.payment_status === 'paid') {
      return res.status(400).json({
        success: false,
        error: 'Cannot edit paid bookings. Please contact support.',
      });
    }

    // ✅ Whitelist editable fields — prevents mass assignment of
    // protected fields like payment_status, status, total_price, user_id
    const allowedFields = [
      'customer_name',
      'customer_email',
      'customer_phone',
      'country',
      'special_requests',
    ];

    const rawUpdateData = {};
    for (const field of allowedFields) {
      if (req.body[field] !== undefined) {
        rawUpdateData[field] = req.body[field];
      }
    }

    // Admins may re-price a booking agreed off-site. Only the rate is taken
    // from the request — the total is recomputed here from the stored group
    // size, the same way createBooking derives it — so a client can never send
    // a total that disagrees with the rate the customer was quoted.
    let repricing = null;
    if (req.user.role === 'admin' && req.body.price_per_person !== undefined) {
      const priceResult = bookingPriceAdjustmentSchema.safeParse({
        price_per_person: req.body.price_per_person,
      });

      if (!priceResult.success) {
        return res.status(400).json({
          success: false,
          error: 'Validation failed',
          details: priceResult.error.issues,
        });
      }

      // Round to whole cents first, then derive the total from that stored
      // rate. Rounding the rate and the total independently lets them disagree
      // — 1.005 x 2 would persist a rate of "1.00" against a total of "2.01",
      // which the booking schema's own consistency rule treats as invalid.
      const { price_per_person: pricePerPerson } = priceResult.data;
      const rateInCents = Math.round(pricePerPerson * 100);
      const totalInCents = rateInCents * existingBooking.data.group_size;

      // Already in cents, and now stored that way — the round trip out to a
      // decimal string and back was the only thing that could lose one.
      repricing = {
        price_per_person_cents: rateInCents,
        total_price_cents: totalInCents,
      };
    }

    if (Object.keys(rawUpdateData).length === 0 && !repricing) {
      return res.status(400).json({
        success: false,
        error: 'No valid fields provided to update',
      });
    }

    let updateData = {};

    if (Object.keys(rawUpdateData).length > 0) {
      const validationResult =
        bookingCustomerEditableSchema.safeParse(rawUpdateData);
      if (!validationResult.success) {
        return res.status(400).json({
          success: false,
          error: 'Validation failed',
          details: validationResult.error.issues,
        });
      }
      updateData = validationResult.data;
    }

    if (repricing) {
      updateData = { ...updateData, ...repricing };
      logger.info(
        `Booking ${bookingId} re-priced by admin ${req.user.id}: ${repricing.price_per_person_cents} cents per person, total ${repricing.total_price_cents} cents`
      );
    }

    const [updated] = await withTenantDb((tx) =>
      tx
        .update(bookings)
        .set({
          ...updateData,
          updated_at: new Date(),
        })
        // Repricing carries the paid-state check into the UPDATE itself. The
        // authorization above read payment_status earlier in the request, so a
        // payment settling in between let an admin change the total of a
        // booking the customer had already paid. Other edits keep the plain
        // condition: a paid booking may still have its status advanced.
        .where(
          repricing
            ? and(
                eq(bookings.id, bookingId),
                ne(bookings.payment_status, 'paid')
              )
            : eq(bookings.id, bookingId)
        )
        .returning()
    );

    if (!updated && repricing) {
      // Two causes now, and they need different answers: telling an admin
      // "not found" about a booking that was paid a moment ago sends them
      // looking for the wrong problem.
      const [current] = await withTenantDb((tx) =>
        tx
          .select({ payment_status: bookings.payment_status })
          .from(bookings)
          .where(eq(bookings.id, bookingId))
          .limit(1)
      );

      if (current) {
        return res.status(409).json({
          success: false,
          error: `Cannot reprice a booking whose payment is already ${current.payment_status}`,
        });
      }
    }

    if (!updated) {
      // The UPDATE matched nothing — the booking does not exist, or belongs to
      // another tenant and RLS hid it. Reading updated.id here threw a
      // TypeError, surfacing as a 500 instead of a 404.
      return res.status(404).json({
        success: false,
        error: 'Booking not found',
      });
    }

    // Invalidate cache
    await invalidateBooking(
      updated.id,
      updated.user_id,
      updated.tour_id,
      updated.booking_reference
    );

    res.json({ success: true, data: updated });
  } catch (error) {
    logger.error('Error updating booking:', error);
    next(error);
  }
};

export const getRevenueStatsController = async (req, res, next) => {
  try {
    const { data, cached } = await getRevenueStats();

    res.json({
      success: true,
      data,
      ...(cached && { cached: true }),
    });
  } catch (error) {
    logger.error('[Booking Controller] Get revenue stats error:', error);
    next(error);
  }
};

export const getBookingTrendsController = async (req, res, next) => {
  try {
    const { data, cached } = await getBookingTrends();

    res.json({
      success: true,
      data,
      ...(cached && { cached: true }),
    });
  } catch (error) {
    logger.error('[Booking Controller] Get trends error:', error);
    next(error);
  }
};

/**
 * GET /api/bookings/:id/pnl
 *
 * Revenue against cost for one trip, in the operator's own currency. Admin
 * only: what a booking made is the operator's commercial position, not
 * something the customer who made it should be able to read.
 */
export const getBookingPnlController = async (req, res, next) => {
  try {
    // Validated before the query: a malformed id reaches a uuid column as a
    // Postgres cast error, which the error handler answers 500 rather than
    // 400.
    const { id } = uuidParamSchema.parse(req.params);
    const pnl = await bookingPnl(id);

    // What a trip made is the operator's commercial position. Helmet sets no
    // cache policy, and without one a shared cache or a browser is free to
    // keep an authenticated JSON response around — on a shared machine that
    // outlives the session that was allowed to see it.
    res.set('Cache-Control', 'no-store');
    res.json({ success: true, data: pnl });
  } catch (error) {
    if (error.name === 'ZodError') {
      return res.status(400).json({
        success: false,
        error: 'Validation error',
        details: error.issues,
      });
    }
    if (error.message === PNL_BOOKING_NOT_FOUND) {
      return res
        .status(404)
        .json({ success: false, error: PNL_BOOKING_NOT_FOUND });
    }
    logger.error('[Booking Controller] P&L error:', error);
    next(error);
  }
};
