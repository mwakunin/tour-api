# TourOps API — Project Context

**This is a fork of the live Footloose Adventures backend, being built into a multi-tenant tour-operations product.** The live site (`footloose/api`, GitHub `mwakunin/footloose-backend`) stays untouched and in production; this fork is where the money layer (suppliers, payables, payment schedules, agent commissions, FX, ledger) and tenancy get built. Footloose will later migrate onto this as tenant #1.

`upstream` points at the original footloose-backend repo so bugfixes shipped to live can be cherry-picked across. There is deliberately **no `origin`** yet — add one when you create the new repo, and never push this branch to footloose-backend.

This file gives Claude Code the context it needs to work effectively in this repo without re-discovering things each session.

## Stack

- **Runtime:** Node.js, Express
- **Package manager:** `pnpm` — **never `npm`**. This project has no `package-lock.json`, only `pnpm-lock.yaml`. `npm ci`/`npm install` will fail or create an inconsistent state. Always use `pnpm install`, `pnpm run <script>`, `pnpm test`.
- **ORM:** Drizzle ORM (`drizzle-kit` for migrations)
- **Database:** PostgreSQL 16 (Docker: `postgres:16-alpine`). **15 is the
  hard minimum** — migration 0007's column-scoped `ON DELETE SET NULL
(category_id)` does not parse on 14 or older, so an older production server
  fails partway through the migration run rather than at startup.
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

Docker Compose project name is explicitly set to `tourops-api` (via the top-level `name:` key in `docker-compose.yml`). **Do not remove that key** — without it, Compose falls back to the parent directory name for volume/network naming, which caused this project's Postgres/Redis volumes to silently collide with a sibling checkout that also lived in a folder named `api`. This fork is exactly that hazard: it is a second `api` folder alongside `footloose/api`, so its compose name, container names, host ports and DB names were all deliberately changed. Every sibling project's compose file should have its own explicit `name:` for the same reason.

```bash
docker compose up -d postgres redis   # infra only, no API container
docker compose up -d                  # full stack including api
```

Databases: `tourops_dev` and `tourops_test`, same Postgres container, different DB names. `.env` points at `tourops_dev`, `.env.test` points at `tourops_test`.

**Host ports are shifted off footloose's** so both stacks can run at once: API `3100` (was 3000), Postgres `5437`, Redis `6382`. Inside the Docker network the services still use 3000/5432/6379 — only the host-side mappings and the non-Docker `DATABASE_URL`/`REDIS_URL` changed.

**Known env-loading gotcha:** `src/__tests__/setup.js` must load `.env.test` with `dotenv.config({ path: '.env.test', override: true })` — the `override: true` is required. Without it, if anything upstream already called `import 'dotenv/config'` (which loads plain `.env`), dotenv's default behavior is to _not_ overwrite already-set variables, so `DATABASE_URL` silently stays pointed at `tourops_dev` even when `NODE_ENV=test`. This exact bug caused test runs to pollute the dev database for a while — always verify with a before/after row count check if touching this file:

```bash
docker exec tourops-postgres psql -U postgres -d tourops_test -c "SELECT count(*) FROM \"user\";"
```

## Multi-tenancy

Shared schema, shared database, `tenant_id` discriminator — the same shape as
school-saas, ported conceptually (that project is TypeScript/Hono, this is
JavaScript/Express, so nothing copies verbatim).

**The data model is tenant-aware; the tenancy product is not built.** There is
no signup, no subdomain routing, no billing, no tenant switcher, and nothing
user-facing says the word "tenant". Footloose runs as a single seeded row,
`00000000-0000-0000-0000-000000000001`. The column exists now because
retrofitting a discriminator across every table and query later is the
expensive migration; the product surface can wait for operator #2.

**`user`, `session`, `account` and `verification` are deliberately global.**
They are Better Auth's tables, and a person may legitimately work for two
operators. Roles will come from a memberships table, not `user.role`.

**Composite foreign keys.** Child rows reference `(tenant_id, id)`, never
`(id)` alone. Postgres validates a foreign key internally, so a single-column
reference would happily let one tenant's booking point at another tenant's
tour. Any new table referencing another tenant-scoped table must do the same.

**Slugs and references are unique per tenant, not globally.** `tours.slug`,
`destinations.slug`, `blog_categories.slug`, `blog_posts.slug` and
`bookings.booking_reference` are `UNIQUE (tenant_id, <col>)`. Two operators
both selling a "7-day-mara-safari" is normal. The exception is
`files.file_id`, which stays globally unique because it is an ImageKit id
issued by an external system and is not ours to scope.

**`tenant_id` has a DEFAULT, and that is a temporary crutch.** Migration 0007
defaults it to the seed tenant so the existing handlers and the whole test
suite keep working without being rewritten in the same change. It means a
handler that forgets `tenant_id` silently writes to the seed tenant — exactly
the failure RLS exists to prevent. **Drop the default in the same change that
adds the `withTenant` middleware and RLS policies.**

**RLS covers the money-layer tables and `tenants`, and nothing else yet.**
Migration 0008 enables and FORCEs row-level security on `counterparties`,
`obligations`, `settlements`, `allocations`, `fx_rates`, `ledger_entries` and
`tenants`, with both `USING` and `WITH CHECK` — without the latter a handler
could insert a row attributed to another tenant and merely be unable to read it
back, which is corruption rather than protection. With no tenant set,
`public.current_tenant_id()` is NULL and every protected table returns zero
rows; never everything.

The legacy tables are deliberately still uncovered. Nothing queries the money
layer yet, so enabling policies there has a blast radius of zero and proves the
mechanism. `bookings`, `tours`, `payments` and the rest join the policy set in
the change that moves their handlers onto `withTenantDb` and drops the
`tenant_id` DEFAULT.

**Deposit policy is per-tenant, and null by default.** `tenants.deposit_percent_bps`
and `tenants.balance_due_days_before_departure` drive whether
`raiseBookingReceivable` posts one full-amount receivable or a deposit/balance
pair. Null means one, which is what every operator does today. **There is no
endpoint to set them** — deposit terms belong to the tenancy product, which is
not built, so it is an owner-plane `UPDATE` and the CHECK constraints on
`tenants` are the only validation. The balance leg is always `total - deposit`,
never a second percentage, so the two sum to the booking exactly.

**Two connections, on purpose.** `FORCE ROW LEVEL SECURITY` still exempts a
table's owner, so an app connecting as the owner has decorative policies.
`database.js` (`DATABASE_URL`, owner) is for migrations and the owner plane;
`appDatabase.js` (`APP_DATABASE_URL`, role `tourops_app`, NOBYPASSRLS) is the
runtime connection and the only one the policies constrain. The role is created
NOLOGIN by the migration — a password does not belong in a committed file — so
provision it once per environment with `APP_DB_PASSWORD=... pnpm run db:app-role`.

**The transaction is per operation, NOT per request.** This is the one place
school-saas's pattern does not port. That project wraps a whole request in one
transaction; this app calls Safaricom, Pesapal and Paystack from inside request
handlers, interleaved with queries. A request-scoped transaction would hold one
of only 15 production connections (3 in dev) open across a multi-second call to
Daraja, and a handful of concurrent checkouts would exhaust the pool. So
`runWithTenant` puts the tenant id in AsyncLocalStorage for the request, and
`withTenantDb` opens a short transaction per operation. Isolation is unchanged —
`set_config(..., true)` is transaction-scoped either way — only the holding
time differs. **Never put an external HTTP call inside a `withTenantDb`
callback.** Nested `withTenantDb` calls reuse the ambient transaction.

**One deliberate schema/snapshot divergence.** `blog_posts_category_tenant_fk`
is written by hand in migration 0007 as `ON DELETE SET NULL (category_id)` —
the column-scoped form Postgres 15+ supports. A plain `ON DELETE SET NULL` is
_accepted_ at definition time but fails at DELETE time, because it would try
to null `tenant_id`, which is `NOT NULL`; the bug would only surface the first
time somebody deleted a blog category in production. Drizzle cannot express the
column list, so its snapshot records a plain `set null`. Do not "fix" this by
regenerating the statement.

---

## Known gotchas / patterns to watch for

**1. Temporal Dead Zone (TDZ) variable shadowing.** A recurring bug pattern found multiple times in this codebase: destructuring a query result into a variable with the same name as an imported Drizzle table, then referencing the table in the same statement before the local variable is assigned:

```javascript
// ❌ throws "Cannot access 'user' before initialization"
const [user] = await db.select().from(user).where(eq(user.id, id));

// ✅ correct
const [foundUser] = await db.select().from(user).where(eq(user.id, id));
```

Grep for this pattern (`const [x] = await db....from(x)` where `x` matches an imported table name) if debugging a "Cannot access X before initialization" error.

**2. Jest + native ESM mocking.** Because tests run under `--experimental-vm-modules`, the classic `jest.mock()` does **not** reliably intercept ESM imports — it's designed for the CommonJS/Babel transform pipeline. Use `jest.unstable_mockModule()` instead, and anything that transitively imports the mocked module must use dynamic `await import()` placed _after_ the mock is registered:

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

**Money that moves is integer cents, and the decimals are generated from it.** `bookings.total_price_cents`, `bookings.price_per_person_cents` and `payments.amount_cents` are the stored, writeable columns. `total_price`, `price_per_person` and `amount` are `GENERATED ALWAYS ... STORED` from them — they still read as `"1000.15"` strings so the API contract and every reader (invoice PDF, emails, revenue SQL) are unchanged, but **an INSERT or UPDATE naming one fails with `428C9`**. Write the `_cents` column. Do not add a second column "kept in sync"; that is what this replaced.

`tours` pricing is deliberately still decimal — `price_amount`, `compare_at_amount` and the `pricing_periods` JSONB tiers (`price_per_person`, `compare_at_price`, `total` as JSON numbers). Those are the catalogue, not money that has moved, and their shape is a cross-repo contract with the frontend's `src/lib/utils/pricing.ts`. Converting them is a coordinated change in both repos, not a backend refactor.

**4. Better Auth user IDs are opaque strings, not integers.** Any leftover `z.number()` validation on a `user_id` field, or any `varchar`/`integer` column typed for the old Kinde/integer-ID era, will break. Better Auth generates random alphanumeric string IDs (e.g. `bd4ze9e4FM101GdIgz5o1eGTMibVBXHs`). Check both the Zod schema layer _and_ the actual Postgres column type when debugging ID-related validation or insert failures — they can disagree independently.

**5. Booking reference format.** `booking_reference` column is `varchar(20)`. The generator (`generateBookingReferenceSimple` in `src/models/booking.model.js`) produces `FA-YYYY-XXXXXX` (~14-16 chars) — stay well under 20 if ever changing the format. A previous version used a longer `BOLDAFRICAS-YYYY-NNNNNN` prefix that silently exceeded the column limit and caused every booking insert to fail with an opaque DB error.

**6. Tour pricing: seasonal periods OR a flat price, never neither.** `tours.pricing_periods` (JSONB array) replaced the old `pricing_tiers` + `validity_period` columns. Each period is `{label?, start_date, end_date, pricing_tiers: [{pax, price_per_person, compare_at_price?, total?, currency}]}` with day-precision dates that may span a year boundary (23 Dec – 2 Jan), at least one tier each, and **no overlaps** (rejected at validation). `price_amount`/`price_currency` are **nullable** and used only when `pricing_periods` is empty (flat-priced transfers/day trips) — so branch on `pricing_periods.length`, and never assume `price_amount` is non-null.

Three rules that are easy to get wrong:

- **Prices are charged exactly as entered.** `price_per_person` is what the customer pays; nothing multiplies it. `compare_at_price` (and `compare_at_amount` for flat tours) is an optional struck-through "was" figure, **display only**, and must exceed the charged price. If you find yourself writing `price * (1 - discount/100)` anywhere, that is the bug this model was built to remove — the admin used to have to work backwards from the price they wanted to charge.
- **`tours.discount_percentage` is DERIVED and read-only.** `createTour`/`updateTour` compute it via `computeHeadlineDiscount()` (the largest saving across all tiers) and write it; client-supplied values are ignored. It is kept as a real column purely so `getDeals` can filter/sort on it without a JSONB subquery. `updateTour` recomputes it from the _merged_ row after the patch, since a patch may touch only the periods or only the flat compare-at.
- **Booking price resolves by the trip's START DATE only** (no proration). If no period covers it, reject and direct the customer to a custom quote — don't silently fall back to the flat price.
- **Tier selection is server-authoritative.** `resolveTierForGroupSize` picks the exact pax match, else the closest tier _at or below_ the group size (a group of 3 against 1/2/4/6 tiers pays the 2-pax rate). A client-supplied `selected_tier_index` is only validated for _agreement_ with that result — it never determines the price, or a client could pick a cheaper tier.

All the percent-off arithmetic lives in one place, `getTierSavings()`, mirrored on the client in `src/lib/utils/pricing.ts`. Badges, strikethroughs and "Save X" figures all derive from it.

Both helpers live in `src/validations/tour.validation.js`. Compare dates via the exported `toDateKey` (lexicographic `YYYY-MM-DD`), **not** `new Date(iso)` + `setHours(0,0,0,0)` — the latter mixes UTC parsing with local-time mutation and shifts the day in timezones behind UTC, breaking exact period boundaries.

Tiers are nested one level deeper than before, so raw SQL over them needs a **double** unnest — see `tierPriceMatches` / `lowestPriceOrderBy` in `src/services/tour.service.js`, which the price filters and price sorting in both query builders share. Alias periods as `pp`, not `period` (an SQL:2011 keyword).

**7. Route ordering in `app.js` matters.** Better Auth's catch-all handler (`app.all('/api/auth/*path', toNodeHandler(auth))`) must be registered **after** any custom routes mounted under `/api/auth` (like `/api/auth/me`), or the custom routes become unreachable (Better Auth's wildcard swallows the request first and 404s since it doesn't recognize the path as one of its own endpoints).

**8. Session/auth testing.** `src/__tests__/helpers/auth.helper.js` creates real authenticated sessions by hitting Better Auth's actual `/api/auth/sign-up/email` and `/api/auth/sign-in/email` endpoints through a `supertest` agent (which auto-persists the `better-auth.session_token` cookie), rather than faking sessions. This is intentional — don't reintroduce manual Redis session/cookie forging, it doesn't match how Better Auth actually validates sessions.

## Third-party service credentials in CI/production

Arcjet, Sentry, Resend, and whatever payment provider keys are live all need their own environment variables set as GitHub Actions secrets (for CI) and in the actual deploy target's env config (for production) — separate from local `.env`/`.env.test`. When touching CI workflows, don't assume a service will silently no-op without credentials; some (Arcjet, Sentry) may throw on missing config depending on how they're initialized. Check `src/config/arcjet.js` and `src/instrument.js`/`src/config/sentry.js` for whether they guard against missing env vars before wiring them into a new CI workflow.

## Branding

Hardcoded branding is a **bug** in this repo, not a rebranding task. Footloose and Bold Africa are both destined to be tenants, so any operator name, logo, email, booking-reference prefix (`BOOKING_REF_PREFIX`), or copy baked into code or config needs to become tenant-scoped configuration rather than being renamed. When you find a hardcoded "Footloose", "Bold Africa", "boldafrica", or `bold_africa` reference, the fix is to read it from tenant settings — not to swap in a different brand string.

```bash
grep -rli "boldafrica\|bold africa\|bold_africa" . --exclude-dir=node_modules --exclude-dir=.git
```

## CI

GitHub Actions workflows (`.github/workflows/test.yml`, `.github/workflows/lint-and-format.yml`) must use `pnpm`, not `npm`, including the `pnpm/action-setup` step before `actions/setup-node`. Watch for accidental double-substitution if using `sed` to bulk-replace `npm` → `pnpm` — `pnpm` contains `npm` as a substring, so running the same replacement twice produces `pnpm` → `pnnpm` → `pppnpm` etc. Verify with `grep -c "pnpm"` matching expected count, not just "no npm left."

CodeRabbit is connected to this repo and reviews PRs automatically. Large PRs (100+ files) can take 15-30+ minutes for a first review — this is normal, not a stuck/broken state.
