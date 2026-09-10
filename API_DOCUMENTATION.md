# Footloose Adventures API Documentation

## Overview

The Footloose Adventures API is a production-ready RESTful API for managing safari tour bookings, payments, and operations. This document provides an overview of the API structure, authentication, and key features.

## Quick Start

### Accessing API Documentation

**Interactive Documentation (Swagger UI):**

- Development: http://localhost:3000/api-docs
- Production: https://your-domain.com/api-docs

#### API Documentation (OpenAPI/Swagger)

- **Swagger UI Integration**: Interactive API documentation available at `/api-docs`
- **OpenAPI 3.0 Specification**: Complete API specification with all endpoints documented
- **Comprehensive Schema Definitions**: Detailed schemas for Tour, Booking, Payment, User, and Destination models
- **Request/Response Examples**: Real-world examples for all endpoints
- **Authentication Documentation**: Session-based authentication flows documented
- **Error Response Standards**: Standardized error responses (4xx, 5xx) with examples

#### Dependencies

- Added `swagger-jsdoc@^6.2.8` - OpenAPI specification generation
- Added `swagger-ui-express@^5.0.1` - Swagger UI middleware

### Documentation Highlights

#### Tour Endpoints Documented

- GET `/api/tours` - List all tours with filtering
- GET `/api/tours/search` - Search tours
- GET `/api/tours/featured` - Featured tours
- GET `/api/tours/deals` - Tour deals
- GET `/api/tours/{id}` - Get tour by ID
- GET `/api/tours/slug/{slug}` - Get tour by slug
- GET `/api/tours/{id}/full` - Get tour with destinations
- POST `/api/tours` - Create tour (Admin)
- PATCH `/api/tours/{id}` - Update tour (Admin)
- DELETE `/api/tours/{id}` - Delete tour (Admin)

#### Booking Endpoints Documented

- POST `/api/bookings` - Create booking
- GET `/api/bookings/my-bookings` - User's bookings
- GET `/api/bookings/reference/{reference}` - Get by reference
- GET `/api/bookings/{id}` - Get booking details
- PATCH `/api/bookings/{id}` - Update booking
- PATCH `/api/bookings/{id}/cancel` - Cancel booking
- GET `/api/bookings` - All bookings (Admin)
- PATCH `/api/bookings/{id}/status` - Update status (Admin)
- GET `/api/bookings/stats/*` - Statistics (Admin)

#### Payment Endpoints Documented

- POST `/api/payments/initiate` - Initialize payment
- GET `/api/payments/verify` - Verify payment
- GET `/api/payments/booking/{bookingId}/status` - Payment status
- GET `/api/payments/methods` - Available payment methods
- POST `/api/payments/mpesa/callback` - M-Pesa webhook
- POST `/api/payments/paystack/webhook` - Paystack webhook
- GET `/api/payments/bank-transfers/*` - Bank transfer management (Admin)

**OpenAPI Specification (JSON):**

- http://localhost:3000/api-docs.json

## Files Structure

```
src/
├── config/
│   └── swagger.js           # Main configuration
│
├── docs/                    # Documentation files
│   ├── tour.docs.js        # Tour endpoint docs
│   ├── booking.docs.js     # Booking endpoint docs
│   └── payment.docs.js     # Payment endpoint docs
│
└── app.js                   # Swagger UI integration
```

### Base URL

```
Development: http://localhost:3000/api
Production: https://your-domain.com/api
```

## Authentication

The API uses **session-based authentication** via Kinde OAuth.

### Authentication Flow

1. **Login**: `GET /api/auth/login`
   - Redirects to Kinde OAuth
2. **Callback**: `GET /api/auth/kinde_callback`
   - Creates session after successful authentication
3. **Session Cookie**: `connect.sid`
   - Automatically included in subsequent requests

### Protected Endpoints

Protected endpoints require authentication. Include the session cookie in your requests.

**Example:**

```bash
curl -X GET https://api.example.com/api/bookings/my-bookings \
  -H "Cookie: connect.sid=your-session-id"
```

### Authorization Levels

1. **Public** - No authentication required
2. **Authenticated** - Valid session required
3. **Admin** - Admin role required

## Core Resources

### Tours

Safari tour packages with pricing, itineraries, and destinations.

**Key Endpoints:**

- `GET /api/tours` - List all tours
- `GET /api/tours/{id}` - Get tour details
- `GET /api/tours/slug/{slug}` - Get tour by URL slug
- `GET /api/tours/search?q=safari` - Search tours
- `GET /api/tours/featured` - Featured tours
- `GET /api/tours/deals` - Special deals
- `POST /api/tours` - Create tour (Admin)

**Filtering:**

- `?category=wildlife` - Filter by category
- `?featured=true` - Featured tours only
- `?min_price=500&max_price=2000` - Price range
- `?page=1&limit=10` - Pagination

### Bookings

Tour reservations with customer information and payment tracking.

**Key Endpoints:**

- `POST /api/bookings` - Create booking
- `GET /api/bookings/my-bookings` - User's bookings
- `GET /api/bookings/reference/{reference}` - Lookup by reference
- `PATCH /api/bookings/{id}/cancel` - Cancel booking
- `GET /api/bookings` - All bookings (Admin)
- `GET /api/bookings/stats/overview` - Statistics (Admin)

**Booking Reference Format:**

```
FA-2025-000123
FA-[YEAR]-[SEQUENCE]
```

### Payments

Multi-gateway payment processing with Pesapal, M-Pesa, and bank transfer.

**Key Endpoints:**

- `POST /api/payments/initiate` - Initialize payment
- `GET /api/payments/verify?reference=xxx` - Verify payment
- `GET /api/payments/booking/{id}/status` - Payment status
- `GET /api/payments/methods?currency=KES` - Available methods

**Supported Payment Methods:**

- **Pesapal**: Cards and mobile money (KES, USD, TZS, UGX) — the default
- **M-Pesa**: Mobile money (KES only)
- **Bank Transfer**: Manual confirmation (Admin)

Paystack is deprecated. `getAvailablePaymentMethods` filters it out, so it is
never offered for a new payment; the webhook and verification paths stay
mounted only so transactions created before the move to Pesapal can still be
settled. Flutterwave was never implemented — it was listed here and carried as
a dependency, but no code ever imported it.

## Data Models

### Tour

A tour carries **either** seasonal `pricing_periods` **or** a flat
`price_amount`/`price_currency` — never neither. Periods must not overlap, and
each carries its own tier table. Bookings resolve their price from the period
covering the trip's start date; if no period covers it, the booking is rejected
with a message directing the customer to request a custom quote.

**Prices are charged exactly as entered.** `price_per_person` (and `price_amount`)
is what the customer pays — nothing is multiplied. `compare_at_price` (and
`compare_at_amount`) is an optional struck-through "was" figure used for display
only; it must be higher than the charged price. `discount_percentage` is
**read-only and server-derived** — the largest saving across the tour's tiers.
Any value a client sends for it is ignored.

```json
{
  "id": "uuid",
  "title": "Maasai Mara Safari",
  "slug": "maasai-mara-safari",
  "overview": "Detailed description...",
  "duration": 5,
  "duration_unit": "days",
  "price_amount": "600.00",
  "price_currency": "USD",
  "compare_at_amount": "800.00",
  "discount_percentage": "25.00",
  "pricing_periods": [
    {
      "label": "Festive Season",
      "start_date": "2026-12-23",
      "end_date": "2027-01-02",
      "pricing_tiers": [
        {
          "pax": 2,
          "price_per_person": 600,
          "compare_at_price": 800,
          "total": 1200,
          "currency": "USD"
        }
      ]
    }
  ],
  "featured": true,
  "is_deal": false,
  "images": ["url1", "url2"],
  "categories": ["wildlife", "adventure"],
  "status": "published"
}
```

### Booking

```json
{
  "id": "uuid",
  "booking_reference": "FA-2025-000123",
  "tour_id": "uuid",
  "group_size": 4,
  "start_date": "2025-06-15T00:00:00Z",
  "end_date": "2025-06-20T00:00:00Z",
  "total_price": "3200.00",
  "currency": "USD",
  "customer_name": "John Doe",
  "customer_email": "john@example.com",
  "payment_status": "pending",
  "status": "pending"
}
```

### Payment

```json
{
  "id": "uuid",
  "booking_id": "uuid",
  "amount": "3200.00",
  "currency": "USD",
  "payment_method": "mpesa",
  "status": "completed",
  "reference": "PAY-2025-001234",
  "provider_reference": "MPESA-ABC123"
}
```

## Response Format

### Success Response

```json
{
  "success": true,
  "data": { ... },
  "pagination": {
    "page": 1,
    "limit": 10,
    "total": 25
  }
}
```

### Error Response

```json
{
  "success": false,
  "error": "Error type",
  "message": "Detailed error message"
}
```

### Validation Error

```json
{
  "success": false,
  "error": "Validation error",
  "details": [
    {
      "field": "email",
      "message": "Invalid email format"
    }
  ]
}
```

## HTTP Status Codes

- `200 OK` - Request successful
- `201 Created` - Resource created
- `400 Bad Request` - Validation error
- `401 Unauthorized` - Authentication required
- `403 Forbidden` - Insufficient permissions
- `404 Not Found` - Resource not found
- `429 Too Many Requests` - Rate limit exceeded
- `500 Internal Server Error` - Server error

## Rate Limiting

**Arcjet Security:**

- **Public Routes**: 100 requests/minute
- **Auth Routes**: 30 requests/minute
- **Rate limit bypass**: Development mode

## Pagination

Default pagination for list endpoints:

```
?page=1&limit=10
```

**Query Parameters:**

- `page` - Page number (default: 1)
- `limit` - Items per page (default: 10, max: 100)

**Response:**

```json
{
  "data": [...],
  "pagination": {
    "page": 1,
    "limit": 10,
    "total": 25,
    "totalPages": 3
  }
}
```

## Filtering & Sorting

### Tours

**Filters:**

- `?status=published` - Filter by status
- `?category=wildlife` - Filter by category
- `?featured=true` - Featured only
- `?is_deal=true` - Deals only
- `?min_price=500` - Minimum price
- `?max_price=2000` - Maximum price
- `?search=safari` - Text search

**Sorting:**

- `?sort_by=price&sort_order=asc` - Sort by price ascending
- `?sort_by=created_at&sort_order=desc` - Newest first
- Available fields: `price`, `title`, `duration`, `created_at`

### Bookings

**Filters:**

- `?status=confirmed` - Filter by booking status
- `?payment_status=completed` - Filter by payment status

## Webhooks

### Paystack Webhook

```
POST /api/payments/paystack/webhook
```

**Signature Verification:**

- Header: `x-paystack-signature`
- Algorithm: HMAC SHA512

### M-Pesa Callback

```
POST /api/payments/mpesa/callback
```

**Authentication:**

- Safaricom validates callback URL

## Testing

### Test Organization

```
src/__tests__/
├── unit/                        # Unit tests (NEW!)
│   ├── validations.test.js     # Zod schema validation tests
│   ├── middleware.test.js      # Middleware logic tests
│   └── utils.test.js           # Utility function tests
│
└── integration/                 # Integration tests (existing)
    ├── auth.test.js
    ├── users.test.js
    ├── tours.test.js
    ├── bookings.test.js
    ├── payments.test.js
    ├── emails.test.js
    └── uploads.test.js
```

### Test Scripts Explained

| Script                          | What it Does                        | When to Use                      |
| ------------------------------- | ----------------------------------- | -------------------------------- |
| `npm test`                      | Runs all tests                      | Before commits                   |
| `npm run test:unit`             | Runs only unit tests                | Fast feedback during development |
| `npm run test:integration`      | Runs only integration tests         | Testing API endpoints            |
| `npm run test:coverage`         | Runs all tests with coverage report | Before releases                  |
| `npm run test:watch`            | Watches for file changes            | Active development               |
| `npm run test:unit:validations` | Tests Zod schemas only              | After schema changes             |
| `npm run test:unit:middleware`  | Tests middleware only               | After middleware changes         |
| `npm run test:unit:utils`       | Tests utilities only                | After utility changes            |

### Running Tests

**Unit tests are FAST** (no database required):

```bash
# These run in milliseconds
npm run test:unit:validations   # ~500ms
npm run test:unit:middleware     # ~300ms
npm run test:unit:utils          # ~400ms
```

**Integration tests are SLOWER** (database + API required):

```bash
# These need database setup
npm run test:integration         # ~5-10 seconds
npm run test:tours              # ~2 seconds
```

### Test Coverage Goals

The new tests significantly improve coverage in these areas:

| Component       | Before | Target | Added Tests |
| --------------- | ------ | ------ | ----------- |
| **Validations** | ~30%   | 90%    | 40+ cases   |
| **Middleware**  | ~40%   | 80%    | 15+ cases   |
| **Utilities**   | ~50%   | 85%    | 30+ cases   |
| **Overall**     | ~45%   | 70%+   | 85+ cases   |

### Running Tests

```bash
# All tests
npm test

# Specific test suite
npm run test:tours
npm run test:bookings
npm run test:payments

# With coverage
npm run test:coverage

# Run ALL unit tests
npm run test:unit

# Run specific unit test files
npm run test:unit:validations    # Validation schema tests
npm run test:unit:middleware      # Middleware & error handling tests
npm run test:unit:utils          # Utility function tests

# Run all integration tests
npm run test:integration

# Run all tests (unit + integration)
npm test

# Run with coverage
npm run test:coverage
```

### Test Database

Tests use a separate database configured via `DATABASE_URL` environment variable. The test suite automatically prevents running against production databases.

## Error Handling

The API implements comprehensive error handling:

1. **Zod Validation Errors** - 400 with field-specific messages
2. **Database Errors** - 500 with sanitized messages
3. **Authentication Errors** - 401 with helpful messages
4. **Authorization Errors** - 403 with permission details
5. **Not Found Errors** - 404 with resource information

## Caching

**Redis Caching:**

- Tours: 1 hour TTL
- Destinations: 6 hours TTL
- Booking lookups: 5 minutes TTL

**Cache Keys:**

```
tour:id:{uuid}
tour:slug:{slug}
tours:all
bookings:user:{userId}
```

## Security

**Security Measures:**

1. **Helmet.js** - HTTP security headers
2. **CORS** - Configured allowed origins
3. **Arcjet** - Rate limiting & bot protection
4. **Session Security** - HTTP-only cookies, SameSite
5. **Input Validation** - Zod schema validation
6. **SQL Injection Protection** - Drizzle ORM
7. **Sentry** - Error tracking & monitoring

## Support

- **Documentation**: http://localhost:3000/api-docs
- **GitHub Issues**: https://github.com/nmwakuni/FOOTLOOSEAVENTURES/issues
- **Email**: footlooseadventures2026@gmail.com

## Version

Current API Version: **1.0.0**

---

### Developer Notes

#### Swagger Documentation Best Practices

1. All new endpoints should include JSDoc comments
2. Use existing schemas from `src/config/swagger.js`
3. Include request/response examples
4. Document all query parameters and path parameters
5. Specify required fields and validation rules

#### Test Coverage Goals

- Aim for 70%+ overall coverage
- Critical paths (payment, booking) should have 85%+ coverage
- All validation schemas should have comprehensive tests
- All error scenarios should be tested

**Last Updated**: 2025-01-14
