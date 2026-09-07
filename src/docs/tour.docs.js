/**
 * @swagger
 * /api/tours:
 *   get:
 *     summary: Get all tours
 *     description: Retrieve a list of all published tours
 *     tags: [Tours]
 *     parameters:
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *           default: 1
 *         description: Page number
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 10
 *           maximum: 100
 *         description: Number of items per page
 *       - in: query
 *         name: status
 *         schema:
 *           type: string
 *           enum: [draft, published, archived]
 *         description: Filter by tour status
 *       - in: query
 *         name: category
 *         schema:
 *           type: string
 *         description: Filter by category
 *       - in: query
 *         name: featured
 *         schema:
 *           type: boolean
 *         description: Filter featured tours
 *       - in: query
 *         name: is_deal
 *         schema:
 *           type: boolean
 *         description: Filter deals
 *       - in: query
 *         name: min_price
 *         schema:
 *           type: number
 *         description: Minimum price filter
 *       - in: query
 *         name: max_price
 *         schema:
 *           type: number
 *         description: Maximum price filter
 *       - in: query
 *         name: search
 *         schema:
 *           type: string
 *         description: Search by title or overview
 *     responses:
 *       200:
 *         description: List of tours retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 data:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/Tour'
 *                 pagination:
 *                   type: object
 *                   properties:
 *                     page:
 *                       type: integer
 *                       example: 1
 *                     limit:
 *                       type: integer
 *                       example: 10
 *                     total:
 *                       type: integer
 *                       example: 25
 *       500:
 *         $ref: '#/components/responses/ServerError'
 */

/**
 * @swagger
 * /api/tours/search:
 *   get:
 *     summary: Search tours
 *     description: Search for tours by various criteria
 *     tags: [Tours]
 *     parameters:
 *       - in: query
 *         name: q
 *         schema:
 *           type: string
 *         description: Search query
 *       - in: query
 *         name: category
 *         schema:
 *           type: string
 *         description: Filter by category
 *       - in: query
 *         name: min_price
 *         schema:
 *           type: number
 *         description: Minimum price
 *       - in: query
 *         name: max_price
 *         schema:
 *           type: number
 *         description: Maximum price
 *     responses:
 *       200:
 *         description: Search results
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
 *                     $ref: '#/components/schemas/Tour'
 */

/**
 * @swagger
 * /api/tours/featured:
 *   get:
 *     summary: Get featured tours
 *     description: Retrieve all featured tours
 *     tags: [Tours]
 *     responses:
 *       200:
 *         description: Featured tours retrieved successfully
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
 *                     $ref: '#/components/schemas/Tour'
 */

/**
 * @swagger
 * /api/tours/deals:
 *   get:
 *     summary: Get tour deals
 *     description: Retrieve all tours marked as deals
 *     tags: [Tours]
 *     responses:
 *       200:
 *         description: Tour deals retrieved successfully
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
 *                     $ref: '#/components/schemas/Tour'
 */

/**
 * @swagger
 * /api/tours/{id}:
 *   get:
 *     summary: Get tour by ID
 *     description: Retrieve a single tour by its ID
 *     tags: [Tours]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *         description: Tour ID
 *     responses:
 *       200:
 *         description: Tour retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   $ref: '#/components/schemas/Tour'
 *       404:
 *         $ref: '#/components/responses/NotFoundError'
 */

/**
 * @swagger
 * /api/tours/slug/{slug}:
 *   get:
 *     summary: Get tour by slug
 *     description: Retrieve a single tour by its URL slug
 *     tags: [Tours]
 *     parameters:
 *       - in: path
 *         name: slug
 *         required: true
 *         schema:
 *           type: string
 *         description: Tour slug
 *     responses:
 *       200:
 *         description: Tour retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   $ref: '#/components/schemas/Tour'
 *       404:
 *         $ref: '#/components/responses/NotFoundError'
 */

/**
 * @swagger
 * /api/tours/{id}/full:
 *   get:
 *     summary: Get tour with destinations
 *     description: Retrieve a tour with all its associated destinations
 *     tags: [Tours]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *         description: Tour ID
 *     responses:
 *       200:
 *         description: Tour with destinations retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   $ref: '#/components/schemas/TourWithDestinations'
 *       404:
 *         $ref: '#/components/responses/NotFoundError'
 */

/**
 * @swagger
 * /api/tours:
 *   post:
 *     summary: Create a new tour (Admin only)
 *     description: Create a new tour. Requires admin authentication.
 *     tags: [Tours]
 *     security:
 *       - sessionAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - title
 *               - slug
 *               - overview
 *               - duration
 *               - images
 *             description: >
 *               A tour needs either `pricing_periods` (seasonal) or a flat
 *               `pricing` base price. Supplying neither is rejected.
 *             properties:
 *               title:
 *                 type: string
 *                 example: Maasai Mara Safari
 *               slug:
 *                 type: string
 *                 example: maasai-mara-safari
 *               overview:
 *                 type: string
 *                 minLength: 100
 *               duration:
 *                 type: integer
 *                 example: 5
 *               duration_unit:
 *                 type: string
 *                 enum: [hours, days, weeks]
 *                 default: days
 *               pricing:
 *                 type: object
 *                 description: >
 *                   Flat base price, for tours without seasonal pricing
 *                   (transfers, day trips). Charged as entered. Omit when
 *                   supplying pricing_periods.
 *                 properties:
 *                   amount:
 *                     type: number
 *                     example: 1200
 *                   currency:
 *                     type: string
 *                     enum: [USD, KES]
 *                   compare_at_amount:
 *                     type: number
 *                     description: Optional "was" price, display only
 *                     example: 800
 *               pricing_periods:
 *                 type: array
 *                 description: >
 *                   Seasonal pricing. Each period carries its own date range and
 *                   tier table. Periods must not overlap. A booking is priced by
 *                   the period covering its start date.
 *                 items:
 *                   type: object
 *                   required: [start_date, end_date, pricing_tiers]
 *                   properties:
 *                     label:
 *                       type: string
 *                       example: Festive Season
 *                     start_date:
 *                       type: string
 *                       format: date
 *                       example: '2026-12-23'
 *                     end_date:
 *                       type: string
 *                       format: date
 *                       example: '2027-01-02'
 *                     pricing_tiers:
 *                       type: array
 *                       minItems: 1
 *                       items:
 *                         type: object
 *                         properties:
 *                           pax:
 *                             type: integer
 *                           price_per_person:
 *                             type: number
 *                             description: The price charged, as entered
 *                           compare_at_price:
 *                             type: number
 *                             description: >
 *                               Optional "was" price shown struck through.
 *                               Must exceed price_per_person. Never charged.
 *                           total:
 *                             type: number
 *                           currency:
 *                             type: string
 *               images:
 *                 type: array
 *                 items:
 *                   type: string
 *                   format: uri
 *               destination_ids:
 *                 type: array
 *                 items:
 *                   type: string
 *                   format: uuid
 *     responses:
 *       201:
 *         description: Tour created successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   $ref: '#/components/schemas/Tour'
 *       400:
 *         $ref: '#/components/responses/ValidationError'
 *       401:
 *         $ref: '#/components/responses/UnauthorizedError'
 *       403:
 *         $ref: '#/components/responses/ForbiddenError'
 */

/**
 * @swagger
 * /api/tours/{id}:
 *   patch:
 *     summary: Update a tour (Admin only)
 *     description: Update an existing tour. Requires admin authentication.
 *     tags: [Tours]
 *     security:
 *       - sessionAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *         description: Tour ID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               title:
 *                 type: string
 *               overview:
 *                 type: string
 *               pricing:
 *                 type: object
 *               status:
 *                 type: string
 *                 enum: [draft, published, archived]
 *     responses:
 *       200:
 *         description: Tour updated successfully
 *       400:
 *         $ref: '#/components/responses/ValidationError'
 *       401:
 *         $ref: '#/components/responses/UnauthorizedError'
 *       403:
 *         $ref: '#/components/responses/ForbiddenError'
 *       404:
 *         $ref: '#/components/responses/NotFoundError'
 */

/**
 * @swagger
 * /api/tours/{id}:
 *   delete:
 *     summary: Delete a tour (Admin only)
 *     description: Delete a tour. Requires admin authentication.
 *     tags: [Tours]
 *     security:
 *       - sessionAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *         description: Tour ID
 *     responses:
 *       200:
 *         description: Tour deleted successfully
 *       401:
 *         $ref: '#/components/responses/UnauthorizedError'
 *       403:
 *         $ref: '#/components/responses/ForbiddenError'
 *       404:
 *         $ref: '#/components/responses/NotFoundError'
 */
