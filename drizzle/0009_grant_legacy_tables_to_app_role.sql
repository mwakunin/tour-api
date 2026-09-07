-- Give the runtime role access to the tables that predate it.
--
-- Migration 0008 granted `tourops_app` only the money-layer tables, because
-- those were the only ones it queried. Migrating the legacy handlers onto the
-- RLS-constrained connection needs those tables reachable first — otherwise a
-- migrated service fails with "permission denied" rather than working.
--
-- GRANTS WITHOUT POLICIES IS A DELIBERATE INTERMEDIATE STATE. Until ENABLE /
-- FORCE ROW LEVEL SECURITY lands on these tables, the runtime role sees every
-- row, exactly as the owner connection does today. That keeps this step a
-- pure no-op for behaviour: services can move across one file at a time, with
-- the suite green after each, and the change that actually bites — policies
-- plus dropping the tenant_id DEFAULT — lands once on an already-migrated app.

GRANT SELECT, INSERT, UPDATE, DELETE ON
  "tours","destinations","tour_destinations","bookings","payments",
  "files","blog_categories","blog_posts"
  TO tourops_app;--> statement-breakpoint

-- Better Auth's tables are global rather than tenant-scoped, but handlers
-- still read sessions and users through the same connection.
GRANT SELECT, INSERT, UPDATE, DELETE ON
  "user","session","account","verification"
  TO tourops_app;--> statement-breakpoint

-- blog_categories and blog_posts use `serial`, so inserts need the sequences.
-- Granting on ALL SEQUENCES covers those without naming them, and covers any
-- added later in this schema.
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO tourops_app;
