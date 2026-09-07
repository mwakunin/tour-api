# Footloose Adventures API — Operations Guide

Practical day-to-day commands for running, testing, and maintaining this project. Written from real setup/debugging sessions — if something here stops matching reality, update it.

---

## Environments at a glance

| Environment | Database                               | Redis                            | Env file    | Started with   |
| ----------- | -------------------------------------- | -------------------------------- | ----------- | -------------- |
| Local dev   | Docker Postgres (`footloose-postgres`) | Docker Redis (`footloose-redis`) | `.env`      | `pnpm run dev` |
| Local test  | Docker Postgres (`footloose_test` DB)  | Docker Redis                     | `.env.test` | `pnpm test`    |

| Local prod-mode | **Real Supabase** | **Real Upstash** | `.env.production` | `pnpm run start:prod` |

`.env.production` points at real, live infrastructure. Anything you do while running `start:prod` touches real data — treat it accordingly.

---

## Daily start-of-day procedure

**If you ended the previous day with `docker compose stop`** (containers still exist, just paused — the normal case):

```bash
cd ~/Videos/PROJECTS/footloose/api
docker compose start postgres redis
docker ps
```

`start` resumes existing containers — faster than recreating them.

**If you ended the previous day with `docker compose down`** (containers were removed, only volumes remain), or this is a fresh machine:

```bash
cd ~/Videos/PROJECTS/footloose/api
docker compose up -d postgres redis
docker ps
```

`up -d` creates and starts containers fresh, reattaching to the existing named volumes so data is preserved either way.

Wait until both show `(healthy)` in `docker ps` output before running the app or tests.

```bash
# Start the dev server (hot-reload via --watch)
pnpm run dev
```

---

## End-of-day / stop procedure

```bash
# Stop the dev server: Ctrl+C in its terminal
```

Then choose one:

**Option A — `stop` (recommended for a normal end-of-day):** pauses containers without removing them. Fastest to resume next day (`docker compose start postgres redis`).

```bash
docker compose stop
```

**Option B — `down`: removes containers but keeps volumes/data intact.** Slightly slower to resume (`docker compose up -d postgres redis` recreates them), but frees up a bit more system resources if you won't touch the project for a while.

```bash
docker compose down
```

| You ran                  | Data kept?               | Resume with                           |
| ------------------------ | ------------------------ | ------------------------------------- |
| `docker compose stop`    | Yes                      | `docker compose start postgres redis` |
| `docker compose down`    | Yes                      | `docker compose up -d postgres redis` |
| `docker compose down -v` | **No — deletes volumes** | N/A, starting fresh                   |

Only `docker volume rm` or `docker compose down -v` actually deletes data — avoid those unless you specifically want a clean slate.

If you ran `start:prod` at any point, **stop it explicitly (Ctrl+C)** — don't leave a process pointed at real Supabase/Upstash running unattended.

---

## Running tests

```bash
# Full suite
pnpm test

# Single file
pnpm test -- bookings.test.js

# Single test by name
pnpm test -- -t "should create a booking successfully"

# Multiple files at once
pnpm test -- bookings.test.js destinations.test.js tours.test.js
```

Tests run against `footloose_test` (via `.env.test`), completely separate from `footloose_dev`. Verify isolation is intact any time you touch `src/__tests__/setup.js`:

```bash
docker exec footloose-postgres psql -U postgres -d footloose_dev -c "SELECT count(*) FROM \"user\";"
pnpm test -- auth.test.js
docker exec footloose-postgres psql -U postgres -d footloose_dev -c "SELECT count(*) FROM \"user\";"
```

If the `footloose_dev` count changes after a test run, something's leaking — tests should only ever write to `footloose_test`.

**Lint/format, same as CI runs:**

```bash
pnpm run lint
pnpm run format:check
```

---

## Database migrations

Drizzle reads your schema files under `src/models/*.js` and diffs them against the last generated snapshot to produce migration SQL.

### Making a schema change

1. Edit the relevant file in `src/models/` (e.g. add a column, change a constraint, add an enum value).
2. Generate the migration:
   ```bash
   pnpm run db:generate
   ```
3. **Read the generated SQL file** in `drizzle/` before applying anything — especially for `ALTER TABLE` on columns with existing data (type changes, `NOT NULL` changes, enum conversions usually need a `USING` cast clause).
4. Apply to your local dev database:
   ```bash
   pnpm run db:migrate
   ```
5. Apply to the local test database too, so tests reflect the new schema:
   ```bash
   NODE_ENV=test pnpm run db:migrate
   ```
6. Run the full test suite to confirm nothing broke:
   ```bash
   pnpm test
   ```

### Applying migrations to production (Supabase)

Only do this once the migration has been tested against local dev/test and reviewed.

```bash
pnpm run db:migrate:production
```

This uses `drizzle.config.js`, which loads `.env.production` automatically based on `NODE_ENV`. Double check `.env.production`'s `DATABASE_URL` is correct before running — there's no confirmation prompt.

### Verifying a migration landed correctly

```bash
docker exec footloose-postgres psql -U postgres -d footloose_dev -c "\d table_name"
```

For production, use Supabase's **SQL Editor** instead:

```sql
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_name = 'table_name';
```

---

## Docker

### Starting infra

```bash
docker compose up -d postgres redis   # infra only
docker compose up -d                  # infra + api container
docker compose up -d postgres redis api   # explicit, same as above
```

### Checking status

```bash
docker ps           # running containers
docker ps -a         # including stopped ones
docker volume ls     # confirm volumes are named footloose-api_* (not just api_*)
```

If you ever see volumes prefixed just `api_` instead of `footloose-api_`, the compose project name isn't being read correctly — check `docker-compose.yml` has the top-level `name: footloose-api` key.

### Making changes to `docker-compose.yml` or `Dockerfile`

1. Edit the file.
2. Recreate affected containers:
   ```bash
   docker compose up -d --build   # --build forces image rebuild if Dockerfile changed
   ```
3. If something seems stuck on an old config, do a clean recreate:
   ```bash
   docker compose down
   docker compose up -d
   ```
   (This does **not** delete volumes — data is safe.)

### Full reset (destructive — only if you want to lose local dev data)

```bash
docker compose down
docker volume rm footloose-api_postgres-data footloose-api_redis-data
docker compose up -d postgres redis
pnpm run db:migrate
NODE_ENV=test pnpm run db:migrate
```

---

## Running against production locally (Supabase + Upstash)

Useful for seeding initial data through the admin API/dashboard before a real frontend exists, or for testing against real infra without deploying anywhere.

```bash
pnpm run start:prod
```

This loads `.env.production`, connects to real Supabase Postgres and real Upstash Redis (must be `rediss://`, not `redis://` — Upstash requires TLS), and starts the server on port 3000.

**Before running this for the first time after a schema change**, make sure migrations have actually been applied to Supabase (`pnpm run db:migrate:production`) — the app will start even if tables don't exist yet, but any real request will fail.

**Stop it explicitly** (Ctrl+C) when done — don't leave a process connected to live infrastructure running in the background unattended.

### Creating an admin user against production

```bash
# 1. Sign up a real account
curl -X POST http://localhost:3000/api/auth/sign-up/email \
  -H "Content-Type: application/json" \
  -d '{"email":"you@example.com","password":"YourRealPassword123!","name":"Your Name"}'

# 2. In Supabase's SQL Editor, promote to admin:
#    UPDATE "user" SET role = 'admin' WHERE email = 'you@example.com';

# 3. Sign in again to refresh the session with the new role
curl -X POST http://localhost:3000/api/auth/sign-in/email \
  -H "Content-Type: application/json" \
  -c cookies.txt \
  -d '{"email":"you@example.com","password":"YourRealPassword123!"}'

# 4. Verify
curl http://localhost:3000/api/auth/me -b cookies.txt
```

---

## Common gotchas (found the hard way)

- **`npm` vs `pnpm`** — this project has no `package-lock.json`, only `pnpm-lock.yaml`. Never run `npm install`/`npm ci` — always `pnpm`.
- **TDZ shadowing** — never destructure a query result into a variable with the same name as an imported Drizzle table in the same statement (`const [user] = await db...from(user)` throws).
- **Zod v4** — error details are on `.issues`, not `.errors`. `error.errors` throws `undefined is not iterable`.
- **`db.execute(sql\`...\`)`results are plain arrays** under`postgres-js`(this project's driver) — no`.rows`wrapper like`pg`/node-postgres. Never write `result.rows`.
- **Decimal columns return as strings** from Drizzle — always `parseFloat()` before arithmetic.
- **Dotenv doesn't override by default** — if you need a specific env file to win over anything loaded earlier, pass `override: true` explicitly.
- **`varchar(20)` on `booking_reference`** — any custom prefix must stay short; the format `FA-YYYY-NNNNNN` uses the full budget.
- **Compose project naming** — always keep the `name:` key at the top of `docker-compose.yml` explicit, or sibling projects in similarly-named folders can silently share volumes.

---

## Quick reference — most-used commands

```bash
# Start local dev
docker compose up -d postgres redis && pnpm run dev

# Run tests
pnpm test

# Schema change
pnpm run db:generate   # review the SQL
pnpm run db:migrate
NODE_ENV=test pnpm run db:migrate

# Run against production locally
pnpm run start:prod

# Apply migration to production
pnpm run db:migrate:production

# Stop everything
docker compose stop
```
