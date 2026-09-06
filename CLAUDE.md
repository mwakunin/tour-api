# Footloose Adventures API — Project Context

Backend API for Footloose Adventures, forked from the Bold Africa Adventures codebase and rebranded. This file gives Claude Code the context it needs to work effectively in this repo without re-discovering things each session.

## Stack

- **Runtime:** Node.js, Express
- **Package manager:** `pnpm` — **never `npm`**. This project has no `package-lock.json`, only `pnpm-lock.yaml`. `npm ci`/`npm install` will fail or create an inconsistent state. Always use `pnpm install`, `pnpm run <script>`, `pnpm test`.
- **ORM:** Drizzle ORM (`drizzle-kit` for migrations)
- **Database:** PostgreSQL 16 (Docker: `postgres:16-alpine`)
- **Cache/sessions:** Redis 7 (Docker: `redis:7-alpine`)
- **Auth:** Better Auth (`better-auth` package) — **not** Kinde, not raw express-session. Migrated off Kinde; any lingering `KINDE_*` env vars or references are dead and should be removed on sight.
- **Validation:** Zod
- **Testing:** Jest, run in native ESM mode via `NODE_OPTIONS='--experimental-vm-modules'`
- **Email:** Resend (via `emailService` in `src/services/email.service.js`). Resend's test/free-tier mode rejects sending to non-approved domains (e.g. `example.com`) with a `422 validation_error` — this is expected and non-fatal in tests/dev, not a real bug. Real delivery requires a verified sending domain.
- **Payments:** M-Pesa (Safaricom Daraja API), Paystack (deprecated, kept for backward compat), Pesapal (current primary for card/USD)
- **PDF generation:** jsPDF + jspdf-autotable (uses the newer functional API — `autoTable(doc, {...})`, not `doc.autoTable({...})`)
- **Rate limiting / bot protection:** Arcjet (`src/config/arcjet.js`)
- **Error tracking:** Sentry (`src/config/sentry.js`, `src/instrument.js`). `Sentry.setupExpressErrorHandler(app)` must be registered after all routes but before the custom error handler in `app.js` — order matters for Sentry v8+.
- **Database (legacy/alternate config):** `src/config/neondatabase.js` references Neon/Supabase-style Postgres — this is **not** the active local dev/test path. Local dev and test both run against plain Docker `postgres:16-alpine` (`src/config/database.js`), not Supabase. If you see `PRODUCTION_DATABASE_URL` or Supabase-style connection strings anywhere, they're either unused legacy config or specifically for the real production deploy target — confirm which before assuming either way, and don't reintroduce a Supabase-vs-local safety check into `globalSetup.js` (it was deliberately removed since it doesn't apply to this Docker-based setup).

## Commands

```bash
pnpm install                  # install deps
pnpm run dev                  # local dev server
pnpm run db:migrate           # run drizzle migrations
NODE_ENV=test pnpm run db:migrate  # migrate the test database
pnpm test                     # full test suite
pnpm test -- <file>.test.js   # single test file
pnpm test -- -t "test name"   # single test by name
pnpm run lint                 # eslint
pnpm run format:check         # prettier check
```

Full test command under the hood (for reference, don't need to type this manually — `pnpm test` already runs it):
```bash
NODE_ENV=test NODE_OPTIONS='--experimental-vm-modules' jest --runInBand --detectOpenHandles
```

## Local infrastructure

Docker Compose project name is explicitly set to `footloose-api` (via the top-level `name:` key in `docker-compose.yml`). **Do not remove that key** — without it, Compose falls back to the parent directory name for volume/network naming, which caused this project's Postgres/Redis volumes to silently collide with a sibling Bold Africa checkout that also lived in a folder named `api`. Every sibling project's compose file should have its own explicit `name:` for the same reason.

```bash
docker compose up -d postgres redis   # infra only, no API container
docker compose up -d                  # full stack including api
```

Databases: `footloose_dev` and `footloose_test`, same Postgres container, different DB names. `.env` points at `footloose_dev`, `.env.test` points at `footloose_test`.

**Known env-loading gotcha:** `src/__tests__/setup.js` must load `.env.test` with `dotenv.config({ path: '.env.test', override: true })` — the `override: true` is required. Without it, if anything upstream already called `import 'dotenv/config'` (which loads plain `.env`), dotenv's default behavior is to *not* overwrite already-set variables, so `DATABASE_URL` silently stays pointed at `footloose_dev` even when `NODE_ENV=test`. This exact bug caused test runs to pollute the dev database for a while — always verify with a before/after row count check if touching this file:
```bash
docker exec footloose-postgres psql -U postgres -d footloose_test -c "SELECT count(*) FROM \"user\";"
```

## Known gotchas / patterns to watch for

**1. Temporal Dead Zone (TDZ) variable shadowing.** A recurring bug pattern found multiple times in this codebase: destructuring a query result into a variable with the same name as an imported Drizzle table, then referencing the table in the same statement before the local variable is assigned:
```javascript
// ❌ throws "Cannot access 'user' before initialization"
const [user] = await db.select().from(user).where(eq(user.id, id));

// ✅ correct
const [foundUser] = await db.select().from(user).where(eq(user.id, id));
```
Grep for this pattern (`const [x] = await db....from(x)` where `x` matches an imported table name) if debugging a "Cannot access X before initialization" error.

**2. Jest + native ESM mocking.** Because tests run under `--experimental-vm-modules`, the classic `jest.mock()` does **not** reliably intercept ESM imports — it's designed for the CommonJS/Babel transform pipeline. Use `jest.unstable_mockModule()` instead, and anything that transitively imports the mocked module must use dynamic `await import()` placed *after* the mock is registered:
```javascript
jest.unstable_mockModule('#services/mpesa.service.js', () => ({
  initiateSTKPush: jest.fn(async (...) => ({ ... })),
  handleMpesaCallback: jest.fn(async () => ({ success: true })),
  // include every real export, even ones you're not changing behavior for —
  // omitting one throws "does not provide an export named X"
}));

const { default: app } = await import('../../app.js');
```

**3. Drizzle `decimal` columns return as strings.** Any column defined as `decimal('x', { precision, scale })` comes back from Postgres as a JS string, not a number. Always `parseFloat()` before doing arithmetic (e.g. `tour.price_amount` from the `tours` table).

**4. Better Auth user IDs are opaque strings, not integers.** Any leftover `z.number()` validation on a `user_id` field, or any `varchar`/`integer` column typed for the old Kinde/integer-ID era, will break. Better Auth generates random alphanumeric string IDs (e.g. `bd4ze9e4FM101GdIgz5o1eGTMibVBXHs`). Check both the Zod schema layer *and* the actual Postgres column type when debugging ID-related validation or insert failures — they can disagree independently.

**5. Booking reference format.** `booking_reference` column is `varchar(20)`. The generator (`generateBookingReferenceSimple` in `src/models/booking.model.js`) produces `FA-YYYY-XXXXXX` (~14-16 chars) — stay well under 20 if ever changing the format. A previous version used a longer `BOLDAFRICAS-YYYY-NNNNNN` prefix that silently exceeded the column limit and caused every booking insert to fail with an opaque DB error.

**6. Tour pricing: seasonal periods OR a flat price, never neither.** `tours.pricing_periods` (JSONB array) replaced the old `pricing_tiers` + `validity_period` columns. Each period is `{label?, start_date, end_date, pricing_tiers: [{pax, price_per_person, compare_at_price?, total?, currency}]}` with day-precision dates that may span a year boundary (23 Dec – 2 Jan), at least one tier each, and **no overlaps** (rejected at validation). `price_amount`/`price_currency` are **nullable** and used only when `pricing_periods` is empty (flat-priced transfers/day trips) — so branch on `pricing_periods.length`, and never assume `price_amount` is non-null.

Three rules that are easy to get wrong:
- **Prices are charged exactly as entered.** `price_per_person` is what the customer pays; nothing multiplies it. `compare_at_price` (and `compare_at_amount` for flat tours) is an optional struck-through "was" figure, **display only**, and must exceed the charged price. If you find yourself writing `price * (1 - discount/100)` anywhere, that is the bug this model was built to remove — the admin used to have to work backwards from the price they wanted to charge.
- **`tours.discount_percentage` is DERIVED and read-only.** `createTour`/`updateTour` compute it via `computeHeadlineDiscount()` (the largest saving across all tiers) and write it; client-supplied values are ignored. It is kept as a real column purely so `getDeals` can filter/sort on it without a JSONB subquery. `updateTour` recomputes it from the *merged* row after the patch, since a patch may touch only the periods or only the flat compare-at.
- **Booking price resolves by the trip's START DATE only** (no proration). If no period covers it, reject and direct the customer to a custom quote — don't silently fall back to the flat price.
- **Tier selection is server-authoritative.** `resolveTierForGroupSize` picks the exact pax match, else the closest tier *at or below* the group size (a group of 3 against 1/2/4/6 tiers pays the 2-pax rate). A client-supplied `selected_tier_index` is only validated for *agreement* with that result — it never determines the price, or a client could pick a cheaper tier.

All the percent-off arithmetic lives in one place, `getTierSavings()`, mirrored on the client in `src/lib/utils/pricing.ts`. Badges, strikethroughs and "Save X" figures all derive from it.

Both helpers live in `src/validations/tour.validation.js`. Compare dates via the exported `toDateKey` (lexicographic `YYYY-MM-DD`), **not** `new Date(iso)` + `setHours(0,0,0,0)` — the latter mixes UTC parsing with local-time mutation and shifts the day in timezones behind UTC, breaking exact period boundaries.

Tiers are nested one level deeper than before, so raw SQL over them needs a **double** unnest — see `tierPriceMatches` / `lowestPriceOrderBy` in `src/services/tour.service.js`, which the price filters and price sorting in both query builders share. Alias periods as `pp`, not `period` (an SQL:2011 keyword).

**7. Route ordering in `app.js` matters.** Better Auth's catch-all handler (`app.all('/api/auth/*path', toNodeHandler(auth))`) must be registered **after** any custom routes mounted under `/api/auth` (like `/api/auth/me`), or the custom routes become unreachable (Better Auth's wildcard swallows the request first and 404s since it doesn't recognize the path as one of its own endpoints).

**8. Session/auth testing.** `src/__tests__/helpers/auth.helper.js` creates real authenticated sessions by hitting Better Auth's actual `/api/auth/sign-up/email` and `/api/auth/sign-in/email` endpoints through a `supertest` agent (which auto-persists the `better-auth.session_token` cookie), rather than faking sessions. This is intentional — don't reintroduce manual Redis session/cookie forging, it doesn't match how Better Auth actually validates sessions.

## Third-party service credentials in CI/production

Arcjet, Sentry, Resend, and whatever payment provider keys are live all need their own environment variables set as GitHub Actions secrets (for CI) and in the actual deploy target's env config (for production) — separate from local `.env`/`.env.test`. When touching CI workflows, don't assume a service will silently no-op without credentials; some (Arcjet, Sentry) may throw on missing config depending on how they're initialized. Check `src/config/arcjet.js` and `src/instrument.js`/`src/config/sentry.js` for whether they guard against missing env vars before wiring them into a new CI workflow.

## Branding

Rebranding from "Bold Africa Adventures" is in progress. If you find any remaining references to "Bold Africa," "boldafrica," or `bold_africa` (case-insensitive) in code, config, docs, or CI workflows, they should be updated to Footloose Adventures branding. Check beyond `src/` — also scan `.github/workflows/`, `docker-compose*.yml`, `*.md` docs, and log files.

```bash
grep -rli "boldafrica\|bold africa\|bold_africa" . --exclude-dir=node_modules --exclude-dir=.git
```

## CI

GitHub Actions workflows (`.github/workflows/test.yml`, `.github/workflows/lint-and-format.yml`) must use `pnpm`, not `npm`, including the `pnpm/action-setup` step before `actions/setup-node`. Watch for accidental double-substitution if using `sed` to bulk-replace `npm` → `pnpm` — `pnpm` contains `npm` as a substring, so running the same replacement twice produces `pnpm` → `pnnpm` → `pppnpm` etc. Verify with `grep -c "pnpm"` matching expected count, not just "no npm left."

CodeRabbit is connected to this repo and reviews PRs automatically. Large PRs (100+ files) can take 15-30+ minutes for a first review — this is normal, not a stuck/broken state.