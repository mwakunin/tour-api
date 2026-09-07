/**
 * @swagger
 * /api/bookings:
 *   post:
 *     summary: Create a booking
 *     description: Create a new tour booking. Requires authentication.
 *     tags: [Bookings]
 *     security:
 *       - sessionAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - tour_id
 *               - group_size
 *               - start_date
 *               - end_date
 *               - customer_name
 *               - customer_email
 *             properties:
 *               tour_id:
 *                 type: string
 *                 format: uuid
 *                 example: 123e4567-e89b-12d3-a456-426614174000
 *               group_size:
 *                 type: integer
 *                 minimum: 1
 *                 example: 4
 *               selected_tier_index:
 *                 type: integer
 *                 minimum: 0
 *                 description: >
 *                   Optional. Index into the pricing_tiers array of the period
 *                   covering start_date. Pricing is server-authoritative: the
 *                   tier is derived from group_size (exact pax match, else the
 *                   closest tier at or below it), so this is only validated for
 *                   agreement. A value that differs from the resolved tier is
 *                   rejected with 400. Ignored for flat-priced tours.
 *                 example: 1
 *               start_date:
 *                 type: string
 *                 format: date-time
 *                 description: >
 *                   Determines which pricing period applies. If no period covers
 *                   this date, the booking is rejected and the customer is
 *                   directed to request a custom quote.
 *                 example: 2025-06-15T00:00:00Z
 *               end_date:
 *                 type: string
 *                 format: date-time
 *                 example: 2025-06-20T00:00:00Z
 *               customer_name:
 *                 type: string
 *                 example: John Doe
 *               customer_email:
 *                 type: string
 *                 format: email
 *                 example: john@example.com
 *               customer_phone:
 *                 type: string
 *                 example: +254712345678
 *               country:
 *                 type: string
 *                 example: Kenya
 *               special_requests:
 *                 type: string
 *                 example: Vegetarian meals required
 *     responses:
 *       201:
 *         description: Booking created successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 data:
 *                   $ref: '#/components/schemas/Booking'
 *       400:
 *         $ref: '#/components/responses/ValidationError'
 *       401:
 *         $ref: '#/components/responses/UnauthorizedError'
 *       404:
 *         description: Tour not found
 */

/**
 * @swagger
 * /api/bookings/my-bookings:
 *   get:
 *     summary: Get user's bookings
 *     description: Retrieve all bookings for the authenticated user
 *     tags: [Bookings]
 *     security:
 *       - sessionAuth: []
 *     responses:
 *       200:
 *         description: User bookings retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/Booking'
 *       401:
 *         $ref: '#/components/responses/UnauthorizedError'
 */

/**
 * @swagger
 * /api/bookings/reference/{reference}:
 *   get:
 *     summary: Get booking by reference
 *     description: Retrieve a booking using its unique reference number
 *     tags: [Bookings]
 *     parameters:
 *       - in: path
 *         name: reference
 *         required: true
 *         schema:
 *           type: string
 *         description: Booking reference (e.g., FA-2025-000123)
 *     responses:
 *       200:
 *         description: Booking retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   $ref: '#/components/schemas/Booking'
 *       404:
 *         $ref: '#/components/responses/NotFoundError'
 */

/**
 * @swagger
 * /api/bookings/{id}:
 *   get:
 *     summary: Get booking by ID
 *     description: Retrieve a specific booking. User can only view their own bookings.
 *     tags: [Bookings]
 *     security:
 *       - sessionAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *         description: Booking ID
 *     responses:
 *       200:
 *         description: Booking retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   $ref: '#/components/schemas/Booking'
 *       401:
 *         $ref: '#/components/responses/UnauthorizedError'
 *       403:
 *         $ref: '#/components/responses/ForbiddenError'
 *       404:
 *         $ref: '#/components/responses/NotFoundError'
 */

/**
 * @swagger
 * /api/bookings/{id}:
 *   patch:
 *     summary: Update booking
 *     description: Update booking details. User can only update their own bookings.
 *     tags: [Bookings]
 *     security:
 *       - sessionAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *         description: Booking ID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               customer_phone:
 *                 type: string
 *               special_requests:
 *                 type: string
 *     responses:
 *       200:
 *         description: Booking updated successfully
 *       401:
 *         $ref: '#/components/responses/UnauthorizedError'
 *       403:
 *         $ref: '#/components/responses/ForbiddenError'
 *       404:
 *         $ref: '#/components/responses/NotFoundError'
 */

/**
 * @swagger
 * /api/bookings/{id}/cancel:
 *   patch:
 *     summary: Cancel booking
 *     description: Cancel a booking. User can only cancel their own bookings.
 *     tags: [Bookings]
 *     security:
 *       - sessionAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *         description: Booking ID
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               cancellation_reason:
 *                 type: string
 *                 example: Change of plans
 *     responses:
 *       200:
 *         description: Booking cancelled successfully
 *       401:
 *         $ref: '#/components/responses/UnauthorizedError'
 *       403:
 *         $ref: '#/components/responses/ForbiddenError'
 *       404:
 *         $ref: '#/components/responses/NotFoundError'
 */

/**
 * @swagger
 * /api/bookings:
 *   get:
 *     summary: Get all bookings (Admin only)
 *     description: Retrieve all bookings in the system
 *     tags: [Bookings]
 *     security:
 *       - sessionAuth: []
 *     parameters:
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *           default: 1
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 10
 *       - in: query
 *         name: status
 *         schema:
 *           type: string
 *           enum: [pending, confirmed, cancelled, completed]
 *       - in: query
 *         name: payment_status
 *         schema:
 *           type: string
 *           enum: [pending, processing, completed, failed, refunded]
 *     responses:
 *       200:
 *         description: Bookings retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/Booking'
 *                 pagination:
 *                   type: object
 *       401:
 *         $ref: '#/components/responses/UnauthorizedError'
 *       403:
 *         $ref: '#/components/responses/ForbiddenError'
 */

/**
 * @swagger
 * /api/bookings/{id}/status:
 *   patch:
 *     summary: Update booking status (Admin only)
 *     description: Update the status of a booking
 *     tags: [Bookings]
 *     security:
 *       - sessionAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - status
 *             properties:
 *               status:
 *                 type: string
 *                 enum: [pending, confirmed, cancelled, completed]
 *     responses:
 *       200:
 *         description: Booking status updated successfully
 *       401:
 *         $ref: '#/components/responses/UnauthorizedError'
 *       403:
 *         $ref: '#/components/responses/ForbiddenError'
 */

/**
 * @swagger
 * /api/bookings/stats/overview:
 *   get:
 *     summary: Get booking statistics (Admin only)
 *     description: Retrieve booking statistics and metrics
 *     tags: [Bookings]
 *     security:
 *       - sessionAuth: []
 *     responses:
 *       200:
 *         description: Statistics retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   type: object
 *                   properties:
 *                     total_bookings:
 *                       type: integer
 *                     pending_bookings:
 *                       type: integer
 *                     confirmed_bookings:
 *                       type: integer
 *                     cancelled_bookings:
 *                       type: integer
 *       401:
 *         $ref: '#/components/responses/UnauthorizedError'
 *       403:
 *         $ref: '#/components/responses/ForbiddenError'
 */

/**
 * @swagger
 * /api/bookings/stats/revenue:
 *   get:
 *     summary: Get revenue statistics (Admin only)
 *     description: Retrieve revenue statistics
 *     tags: [Bookings]
 *     security:
 *       - sessionAuth: []
 *     responses:
 *       200:
 *         description: Revenue statistics retrieved successfully
 *       401:
 *         $ref: '#/components/responses/UnauthorizedError'
 *       403:
 *         $ref: '#/components/responses/ForbiddenError'
 */

/**
 * @swagger
 * /api/bookings/stats/trends:
 *   get:
 *     summary: Get booking trends (Admin only)
 *     description: Retrieve booking trends over time
 *     tags: [Bookings]
 *     security:
 *       - sessionAuth: []
 *     responses:
 *       200:
 *         description: Booking trends retrieved successfully
 *       401:
 *         $ref: '#/components/responses/UnauthorizedError'
 *       403:
 *         $ref: '#/components/responses/ForbiddenError'
 */
