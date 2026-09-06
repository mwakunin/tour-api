/**
 * @swagger
 * /api/payments/initiate:
 *   post:
 *     summary: Initiate payment
 *     description: Initialize a payment for a booking
 *     tags: [Payments]
 *     security:
 *       - sessionAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - booking_id
 *               - payment_method
 *             properties:
 *               booking_id:
 *                 type: string
 *                 format: uuid
 *                 example: 123e4567-e89b-12d3-a456-426614174000
 *               payment_method:
 *                 type: string
 *                 enum: [mpesa, paystack, card, bank_transfer]
 *                 example: mpesa
 *               phone_number:
 *                 type: string
 *                 description: Required for M-Pesa payments
 *                 example: 254712345678
 *               email:
 *                 type: string
 *                 format: email
 *                 description: Required for card payments
 *                 example: john@example.com
 *     responses:
 *       200:
 *         description: Payment initiated successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 data:
 *                   type: object
 *                   properties:
 *                     authorization_url:
 *                       type: string
 *                       description: URL to complete payment (Paystack)
 *                     reference:
 *                       type: string
 *                       description: Payment reference
 *                     checkout_request_id:
 *                       type: string
 *                       description: M-Pesa STK push request ID
 *       400:
 *         $ref: '#/components/responses/ValidationError'
 *       401:
 *         $ref: '#/components/responses/UnauthorizedError'
 *       404:
 *         description: Booking not found
 */

/**
 * @swagger
 * /api/payments/verify:
 *   get:
 *     summary: Verify payment
 *     description: Verify a Paystack payment using reference
 *     tags: [Payments]
 *     parameters:
 *       - in: query
 *         name: reference
 *         required: true
 *         schema:
 *           type: string
 *         description: Payment reference
 *     responses:
 *       200:
 *         description: Payment verification result
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
 *                     status:
 *                       type: string
 *                       example: completed
 *                     amount:
 *                       type: number
 *                     currency:
 *                       type: string
 *       400:
 *         description: Invalid reference
 */

/**
 * @swagger
 * /api/payments/booking/{bookingId}/status:
 *   get:
 *     summary: Get payment status for booking
 *     description: Retrieve payment status for a specific booking
 *     tags: [Payments]
 *     security:
 *       - sessionAuth: []
 *     parameters:
 *       - in: path
 *         name: bookingId
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *         description: Booking ID
 *     responses:
 *       200:
 *         description: Payment status retrieved successfully
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
 *                     payment_status:
 *                       type: string
 *                       enum: [pending, processing, completed, failed, refunded]
 *                     payment_method:
 *                       type: string
 *                     amount:
 *                       type: string
 *       401:
 *         $ref: '#/components/responses/UnauthorizedError'
 *       404:
 *         description: Booking not found
 */

/**
 * @swagger
 * /api/payments/methods:
 *   get:
 *     summary: Get available payment methods
 *     description: Retrieve available payment methods based on currency
 *     tags: [Payments]
 *     parameters:
 *       - in: query
 *         name: currency
 *         schema:
 *           type: string
 *           enum: [USD, KES]
 *         description: Currency code
 *     responses:
 *       200:
 *         description: Payment methods retrieved successfully
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
 *                     type: object
 *                     properties:
 *                       method:
 *                         type: string
 *                         example: mpesa
 *                       name:
 *                         type: string
 *                         example: M-Pesa
 *                       supported_currencies:
 *                         type: array
 *                         items:
 *                           type: string
 */

/**
 * @swagger
 * /api/payments/mpesa/callback:
 *   post:
 *     summary: M-Pesa payment callback
 *     description: Webhook endpoint for M-Pesa payment notifications
 *     tags: [Payments]
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *     responses:
 *       200:
 *         description: Callback processed
 */

/**
 * @swagger
 * /api/payments/paystack/webhook:
 *   post:
 *     summary: Paystack payment webhook
 *     description: Webhook endpoint for Paystack payment notifications
 *     tags: [Payments]
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *     responses:
 *       200:
 *         description: Webhook processed
 */

/**
 * @swagger
 * /api/payments/bank-transfers/pending:
 *   get:
 *     summary: Get pending bank transfers (Admin only)
 *     description: Retrieve all pending bank transfer payments
 *     tags: [Payments]
 *     security:
 *       - sessionAuth: []
 *     responses:
 *       200:
 *         description: Pending transfers retrieved successfully
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
 *                     $ref: '#/components/schemas/Payment'
 *       401:
 *         $ref: '#/components/responses/UnauthorizedError'
 *       403:
 *         $ref: '#/components/responses/ForbiddenError'
 */

/**
 * @swagger
 * /api/payments/bank-transfers/{id}/confirm:
 *   post:
 *     summary: Confirm bank transfer (Admin only)
 *     description: Confirm a bank transfer payment
 *     tags: [Payments]
 *     security:
 *       - sessionAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *         description: Payment ID
 *     responses:
 *       200:
 *         description: Bank transfer confirmed successfully
 *       401:
 *         $ref: '#/components/responses/UnauthorizedError'
 *       403:
 *         $ref: '#/components/responses/ForbiddenError'
 *       404:
 *         $ref: '#/components/responses/NotFoundError'
 */

/**
 * @swagger
 * /api/payments/bank-transfers/stats:
 *   get:
 *     summary: Get bank transfer statistics (Admin only)
 *     description: Retrieve statistics for bank transfer payments
 *     tags: [Payments]
 *     security:
 *       - sessionAuth: []
 *     responses:
 *       200:
 *         description: Statistics retrieved successfully
 *       401:
 *         $ref: '#/components/responses/UnauthorizedError'
 *       403:
 *         $ref: '#/components/responses/ForbiddenError'
 */
