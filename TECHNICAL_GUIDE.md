# Technical Guide: Testing, Swagger, and Race Conditions

## 1. 🧪 New Test Scripts Added

### Quick Reference

```bash

```

---

## 2. 📚 What is Swagger.js (OpenAPI)?

### The Simple Explanation

**Swagger** (now called **OpenAPI**) is like an **interactive menu** for your API. Instead of reading boring text documentation, developers can:

1. **See** all your API endpoints in one place
2. **Try** them out directly in the browser (no Postman needed!)
3. **Understand** request/response formats with examples
4. **Generate** client code automatically

### The Components

```
┌─────────────────────────────────────────┐
│         Your API (Express)              │
│  ┌───────────────────────────────────┐  │
│  │   1. swagger-jsdoc                │  │ ← Reads your code comments
│  │      - Scans your files           │  │   and generates OpenAPI spec
│  │      - Finds @swagger comments    │  │
│  │      - Builds specification       │  │
│  └───────────────────────────────────┘  │
│                  ↓                       │
│  ┌───────────────────────────────────┐  │
│  │   2. OpenAPI Specification        │  │ ← JSON/YAML describing
│  │      (swaggerSpec object)         │  │   your entire API
│  └───────────────────────────────────┘  │
│                  ↓                       │
│  ┌───────────────────────────────────┐  │
│  │   3. swagger-ui-express           │  │ ← Beautiful web UI
│  │      - Serves HTML interface      │  │   at /api-docs
│  │      - Interactive testing        │  │
│  └───────────────────────────────────┘  │
└─────────────────────────────────────────┘
```

### How It Works in Your API

**Step 1: Configuration** (`src/config/swagger.js`)

```javascript
import swaggerJsdoc from 'swagger-jsdoc';

const options = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'Footloose Adventures API',
      version: '1.0.0',
      description: 'Safari booking API',
    },
    servers: [{ url: 'http://localhost:3000', description: 'Development' }],
    components: {
      schemas: {
        Tour: {
          /* Tour object structure */
        },
        Booking: {
          /* Booking object structure */
        },
        // ... etc
      },
    },
  },
  apis: ['./src/docs/*.js'], // Where to find @swagger comments
};

export const swaggerSpec = swaggerJsdoc(options);
```

**Step 2: Documentation Comments** (`src/docs/tour.docs.js`)

```javascript
/**
 * @swagger
 * /api/tours:
 *   get:
 *     summary: Get all tours
 *     tags: [Tours]
 *     parameters:
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: Success
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/Tour'
 */
```

**Step 3: Serve UI** (`src/app.js`)

```javascript
import swaggerUi from 'swagger-ui-express';
import { swaggerSpec } from './config/swagger.js';

// Serve Swagger UI at /api-docs
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec));

// Serve raw JSON at /api-docs.json
app.get('/api-docs.json', (req, res) => {
  res.json(swaggerSpec);
});
```

### What You Get

**Interactive UI** at `http://localhost:3000/api-docs`:

```
┌─────────────────────────────────────────┐
│  Footloose Adventures API Documentation │
├─────────────────────────────────────────┤
│                                         │
│  Tours                                  │
│    GET  /api/tours      Get all tours  │  ← Click to expand
│    POST /api/tours      Create tour    │
│                                         │
│  Bookings                               │
│    GET  /api/bookings   Get bookings   │
│    POST /api/bookings   Create booking │
│                                         │
│  [Try it out] button                    │  ← Test endpoints!
│  [Execute] button                       │
│                                         │
│  Response:                              │
│  {                                      │
│    "success": true,                     │
│    "data": [...]                        │
│  }                                      │
└─────────────────────────────────────────┘
```

### Why It's Awesome

1. **Self-Documenting**: Add comments, get documentation automatically
2. **Always Up-to-Date**: Changes in code → changes in docs
3. **Interactive Testing**: No need for Postman during development
4. **Client Generation**: Generate TypeScript/Python/Java clients automatically
5. **Standard Format**: OpenAPI is an industry standard

### Real-World Example

**Before Swagger:**

```
Developer: "How do I create a booking?"
You: "Send POST to /api/bookings with tour_id, group_size..."
Developer: "What's the response format?"
You: "Uh, let me check the code..."
```

**With Swagger:**

```
Developer: "How do I create a booking?"
You: "Visit /api-docs, look at POST /api/bookings"
Developer: [Clicks, sees example, clicks "Try it out", tests it]
Developer: "Perfect, got it!"
```

#

---

## 3. 🔴 Race Condition in Booking Reference Generation

### The Problem

**Location**: `src/models/booking.model.js:119`

```javascript
export const generateBookingReference = async (db) => {
  const year = new Date().getFullYear();
  const prefix = `FA-${year}-`;

  // 🔴 RACE CONDITION HERE!
  // 1. Get latest booking
  const latestBooking = await db
    .select({ booking_reference: bookings.booking_reference })
    .from(bookings)
    .where(sql`${bookings.booking_reference} LIKE ${`${prefix}%`}`)
    .orderBy(desc(bookings.created_at))
    .limit(1);

  let sequence = 1;

  if (latestBooking.length > 0) {
    // 2. Extract sequence number
    const lastRef = latestBooking[0].booking_reference;
    const lastSequence = parseInt(lastRef.split('-')[2], 10);
    sequence = lastSequence + 1; // 3. Increment
  }

  // 4. Generate new reference
  const paddedSequence = sequence.toString().padStart(6, '0');
  return `${prefix}${paddedSequence}`;
};
```

### What's the Race Condition?

**Scenario**: Two users book at the EXACT same time

```
Time: 10:00:00.000

User A (Request 1)              User B (Request 2)
───────────────────             ───────────────────
1. Query latest booking
   → Gets: FA-2025-000042      1. Query latest booking
                                   → Gets: FA-2025-000042

2. Calculate next: 000043       2. Calculate next: 000043

3. Save booking with            3. Save booking with
   FA-2025-000043 ✅              FA-2025-000043 ❌

Result: TWO bookings with the SAME reference number!
```

### Why This Happens

The operation is **not atomic**. There are **4 separate steps**:

1. **Read** latest booking ← Request A reads
2. **Read** latest booking ← Request B reads (before A writes!)
3. **Calculate** next number
4. **Write** new booking

Between steps 1 and 4, another request can do the same thing!

### Real-World Impact

```
Database State:
┌─────────────────────────────┐
│ FA-2025-000042 │ John Doe  │
│ FA-2025-000043 │ Jane Smith│ ← First to save
│ FA-2025-000043 │ Bob Jones │ ← Race condition! 💥
└─────────────────────────────┘

Problems:
❌ Payment tracking fails (which 000043?)
❌ Email confirmations wrong
❌ Customer confusion
❌ Accounting nightmare
❌ Database unique constraint violation (if you have it)
```

### The Probability

**How likely is this?**

- Low traffic (10 bookings/hour): Very rare
- Medium traffic (100 bookings/hour): Occasional
- High traffic (1000 bookings/hour): **Guaranteed to happen**
- Concurrent bookings: **Almost certain**

**Formula**:

```
Probability = (Requests per second)² × Average request time
```

If request takes 100ms and you have 10 req/sec:

```
P = 10² × 0.1 = 10 collisions per second!
```

---

## 4. 🛠️ How to Fix the Race Condition

### Solution 1: PostgreSQL Sequence (BEST)

**Create a sequence in your database:**

```sql
-- Migration file: create_booking_sequence.sql
CREATE SEQUENCE IF NOT EXISTS booking_sequence_2025
  START WITH 1
  INCREMENT BY 1
  NO MAXVALUE
  CACHE 10;
```

**Update the function:**

```javascript
// src/models/booking.model.js
export const generateBookingReference = async (db) => {
  const year = new Date().getFullYear();

  // ✅ ATOMIC: Database guarantees unique numbers
  const result = await db.execute(
    sql`SELECT nextval('booking_sequence_${sql.raw(year.toString())}') as seq`
  );

  const sequence = result.rows[0].seq;
  const paddedSequence = sequence.toString().padStart(6, '0');

  return `FA-${year}-${paddedSequence}`;
};
```

**Why it works:**

- `nextval()` is **atomic** - database handles concurrency
- Even with 1000 concurrent requests, each gets unique number
- Database-level guarantee, no application logic needed

**Setup:**

```javascript
// Create sequence for new year automatically
export const ensureBookingSequence = async (db) => {
  const year = new Date().getFullYear();

  await db.execute(sql`
    CREATE SEQUENCE IF NOT EXISTS ${sql.identifier(`booking_sequence_${year}`)}
    START WITH 1
    INCREMENT BY 1
    NO MAXVALUE
    CACHE 10
  `);
};
```

### Solution 2: Database Transaction with Lock (GOOD)

```javascript
export const generateBookingReference = async (db) => {
  const year = new Date().getFullYear();
  const prefix = `FA-${year}-`;

  // ✅ Use transaction with SELECT FOR UPDATE
  return await db.transaction(async (tx) => {
    // Lock the latest row until transaction completes
    const latestBooking = await tx
      .select({ booking_reference: bookings.booking_reference })
      .from(bookings)
      .where(sql`${bookings.booking_reference} LIKE ${`${prefix}%`}`)
      .orderBy(desc(bookings.created_at))
      .limit(1)
      .for('update'); // ← This locks the row!

    let sequence = 1;
    if (latestBooking.length > 0) {
      const lastRef = latestBooking[0].booking_reference;
      const lastSequence = parseInt(lastRef.split('-')[2], 10);
      sequence = lastSequence + 1;
    }

    const paddedSequence = sequence.toString().padStart(6, '0');
    return `${prefix}${paddedSequence}`;
  });
};
```

**How it works:**

```
Request A locks row → Request B waits → A finishes → B continues
```

**Drizzle ORM syntax:**

```javascript
// Using Drizzle's transaction and locking
import { sql } from 'drizzle-orm';

const result = await db.transaction(async (tx) => {
  const latest = await tx
    .select()
    .from(bookings)
    .where(/* ... */)
    .orderBy(desc(bookings.created_at))
    .limit(1)
    .for('update'); // Row-level lock

  // ... rest of logic
});
```

### Solution 3: Redis Atomic Counter (GOOD for distributed systems)

```javascript
import { cache } from '#utils/cache.js';

export const generateBookingReference = async () => {
  const year = new Date().getFullYear();
  const key = `booking:sequence:${year}`;

  // ✅ ATOMIC: Redis INCR is atomic
  const sequence = await cache.incr(key);

  // Set expiry for next year
  if (sequence === 1) {
    const endOfYear = new Date(year, 11, 31, 23, 59, 59);
    const ttl = Math.floor((endOfYear - new Date()) / 1000);
    await cache.expire(key, ttl);
  }

  const paddedSequence = sequence.toString().padStart(6, '0');
  return `FA-${year}-${paddedSequence}`;
};
```

**Pros:**

- Works across multiple servers (distributed)
- Very fast (Redis is in-memory)
- Atomic operations guaranteed

**Cons:**

- Requires Redis to be available
- Need backup if Redis fails
- Numbers might have gaps if Redis restarts

### Solution 4: UUID-based Reference (ALTERNATIVE)

**Avoid sequential numbers entirely:**

```javascript
import { v4 as uuidv4 } from 'uuid';

export const generateBookingReference = () => {
  const year = new Date().getFullYear();
  const shortUuid = uuidv4().split('-')[0].toUpperCase(); // First 8 chars

  return `FA-${year}-${shortUuid}`;
  // Example: FA-2025-A3F8B2E1
};
```

**Pros:**

- ✅ No race conditions possible
- ✅ No database queries needed
- ✅ Works in distributed systems
- ✅ Globally unique

**Cons:**

- ❌ Not sequential (harder for humans)
- ❌ Longer references
- ❌ Can't easily determine order

### Comparison Table

| Solution                | Race-Safe? | Performance    | Distributed? | Sequential? | Complexity |
| ----------------------- | ---------- | -------------- | ------------ | ----------- | ---------- |
| **PostgreSQL Sequence** | ✅ Yes     | ⚡ Fast        | ❌ No        | ✅ Yes      | 🟢 Low     |
| **Transaction + Lock**  | ✅ Yes     | 🐌 Slower      | ❌ No        | ✅ Yes      | 🟡 Medium  |
| **Redis Counter**       | ✅ Yes     | ⚡⚡ Very Fast | ✅ Yes       | ✅ Yes      | 🟡 Medium  |
| **UUID**                | ✅ Yes     | ⚡⚡⚡ Instant | ✅ Yes       | ❌ No       | 🟢 Low     |
| **Current Code**        | ❌ NO      | ⚡ Fast        | ❌ No        | ✅ Yes      | 🟢 Low     |

### Recommended Solution

**For your API: PostgreSQL Sequence**

```javascript
// 1. Create migration
// migrations/001_booking_sequence.sql
CREATE SEQUENCE IF NOT EXISTS booking_sequence_2025
  START WITH 1
  INCREMENT BY 1;

// 2. Update function
export const generateBookingReference = async (db) => {
  const year = new Date().getFullYear();

  // Ensure sequence exists for current year
  await db.execute(sql`
    CREATE SEQUENCE IF NOT EXISTS ${sql.identifier(`booking_sequence_${year}`)}
    START WITH 1
  `);

  // Get next value atomically
  const [result] = await db.execute(sql`
    SELECT nextval(${sql.identifier(`booking_sequence_${year}`)}) as seq
  `);

  const sequence = Number(result.seq);
  const paddedSequence = sequence.toString().padStart(6, '0');

  return `FA-${year}-${paddedSequence}`;
};
```

### Testing the Fix

```javascript
// Test concurrent booking creation
import { describe, it, expect } from '@jest/globals';

describe('Booking Reference Generation - Race Condition Test', () => {
  it('should generate unique references for concurrent bookings', async () => {
    // Create 100 bookings simultaneously
    const promises = Array(100)
      .fill(null)
      .map(() =>
        createBooking({
          /* ... */
        })
      );

    const bookings = await Promise.all(promises);
    const references = bookings.map((b) => b.booking_reference);

    // All references should be unique
    const uniqueReferences = new Set(references);
    expect(uniqueReferences.size).toBe(100);

    // All should follow format
    references.forEach((ref) => {
      expect(ref).toMatch(/^FA-\d{4}-\d{6}$/);
    });
  });
});
```

---

## Summary

### Test Scripts

- Added `npm run test:unit` for fast unit tests
- Added individual scripts for each test file
- Organized tests into unit vs integration

### Swagger

- It's an interactive API documentation tool
- Auto-generates docs from code comments
- Provides UI for testing endpoints
- Industry standard (OpenAPI 3.0)

### Race Condition

- Current code has timing vulnerability
- Can create duplicate booking references
- **Fix**: Use PostgreSQL sequences (atomic, guaranteed unique)
- Critical for production use

### Priority Actions

1. ✅ Use new test scripts (`npm run test:unit`)
2. ✅ Access Swagger UI at `/api-docs`
3. 🔴 **Fix race condition before production!**
4. ✅ Run tests before deployment

---

**Questions?** Check the Swagger UI for interactive examples or run the tests to see how everything works!
