-- Drop the tenant_id DEFAULT.
--
-- Migration 0007 added it as an explicit, temporary crutch so the retrofit did
-- not also have to rewrite every handler and all 397 tests in one change. Its
-- cost was that a handler which forgot tenant_id silently wrote to the seed
-- tenant — the exact failure row-level security exists to prevent, and one
-- that no policy can catch, because the row IS correctly attributed, just to
-- the wrong operator.
--
-- Every service, controller and test fixture now sets tenant_id explicitly, so
-- the crutch comes out and a forgotten tenant_id becomes a NOT NULL violation
-- at the point of the bug rather than a silent misattribution discovered
-- later.

ALTER TABLE "tours" ALTER COLUMN "tenant_id" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "destinations" ALTER COLUMN "tenant_id" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "tour_destinations" ALTER COLUMN "tenant_id" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "bookings" ALTER COLUMN "tenant_id" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "payments" ALTER COLUMN "tenant_id" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "files" ALTER COLUMN "tenant_id" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "blog_categories" ALTER COLUMN "tenant_id" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "blog_posts" ALTER COLUMN "tenant_id" DROP DEFAULT;
