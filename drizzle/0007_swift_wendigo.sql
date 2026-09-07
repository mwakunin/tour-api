-- Retrofit the tenant discriminator onto the tables that predate it.
--
-- Drizzle generates `ADD COLUMN tenant_id uuid NOT NULL` with no default,
-- which fails immediately on any table that already has rows — and Footloose
-- live has rows. So the column arrives nullable, gets backfilled, and only
-- then becomes NOT NULL.
--
-- Backfill inherits from the parent rather than stamping the seed tenant
-- everywhere. With one operator the two are identical, but inheriting is the
-- shape that stays correct, and a COALESCE to the seed tenant covers orphans
-- and nullable parents.
--
-- THE DEFAULT IS A DELIBERATE, TEMPORARY CRUTCH. Every existing handler and
-- all 397 tests insert without a tenant_id; the default keeps them working so
-- this migration is not also a rewrite of every service. It must be dropped in
-- the same change that introduces the withTenant middleware and RLS —
-- until then a handler that forgets tenant_id silently writes to the seed
-- tenant, which is exactly the failure mode RLS exists to prevent.

-- ============ 1. the seed tenant ============
INSERT INTO "tenants" ("id","name","slug","base_currency","booking_ref_prefix")
VALUES ('00000000-0000-0000-0000-000000000001','Footloose Adventures','footloose','KES','FA')
ON CONFLICT ("id") DO NOTHING;--> statement-breakpoint

-- ============ 2. drop the global uniques ============
-- A slug is unique within an operator, not across the platform. Two operators
-- both selling "7-day-mara-safari" is normal; these constraints forbade it.
ALTER TABLE "blog_categories" DROP CONSTRAINT "blog_categories_slug_unique";--> statement-breakpoint
ALTER TABLE "blog_posts" DROP CONSTRAINT "blog_posts_slug_unique";--> statement-breakpoint
ALTER TABLE "bookings" DROP CONSTRAINT "bookings_booking_reference_unique";--> statement-breakpoint
ALTER TABLE "destinations" DROP CONSTRAINT "destinations_slug_unique";--> statement-breakpoint
ALTER TABLE "tours" DROP CONSTRAINT "tours_slug_unique";--> statement-breakpoint
-- files.file_id stays globally unique: it is an ImageKit id issued by an
-- external system, so it is not ours to scope.
ALTER TABLE "settlements" DROP CONSTRAINT "settlements_payment_id_payments_id_fk";--> statement-breakpoint

-- ============ 3. add the column, nullable for now ============
ALTER TABLE "blog_categories" ADD COLUMN "tenant_id" uuid;--> statement-breakpoint
ALTER TABLE "blog_posts" ADD COLUMN "tenant_id" uuid;--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "tenant_id" uuid;--> statement-breakpoint
ALTER TABLE "destinations" ADD COLUMN "tenant_id" uuid;--> statement-breakpoint
ALTER TABLE "files" ADD COLUMN "tenant_id" uuid;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "tenant_id" uuid;--> statement-breakpoint
ALTER TABLE "tour_destinations" ADD COLUMN "tenant_id" uuid;--> statement-breakpoint
ALTER TABLE "tours" ADD COLUMN "tenant_id" uuid;--> statement-breakpoint

-- ============ 4. backfill, parents before children ============
UPDATE "tours"            SET "tenant_id" = '00000000-0000-0000-0000-000000000001' WHERE "tenant_id" IS NULL;--> statement-breakpoint
UPDATE "destinations"     SET "tenant_id" = '00000000-0000-0000-0000-000000000001' WHERE "tenant_id" IS NULL;--> statement-breakpoint
UPDATE "blog_categories"  SET "tenant_id" = '00000000-0000-0000-0000-000000000001' WHERE "tenant_id" IS NULL;--> statement-breakpoint
UPDATE "files"            SET "tenant_id" = '00000000-0000-0000-0000-000000000001' WHERE "tenant_id" IS NULL;--> statement-breakpoint

UPDATE "bookings" b SET "tenant_id" = COALESCE(
  (SELECT t."tenant_id" FROM "tours" t WHERE t."id" = b."tour_id"),
  '00000000-0000-0000-0000-000000000001') WHERE b."tenant_id" IS NULL;--> statement-breakpoint

UPDATE "tour_destinations" td SET "tenant_id" = COALESCE(
  (SELECT t."tenant_id" FROM "tours" t WHERE t."id" = td."tour_id"),
  '00000000-0000-0000-0000-000000000001') WHERE td."tenant_id" IS NULL;--> statement-breakpoint

UPDATE "blog_posts" p SET "tenant_id" = COALESCE(
  (SELECT c."tenant_id" FROM "blog_categories" c WHERE c."id" = p."category_id"),
  '00000000-0000-0000-0000-000000000001') WHERE p."tenant_id" IS NULL;--> statement-breakpoint

UPDATE "payments" pm SET "tenant_id" = COALESCE(
  (SELECT b."tenant_id" FROM "bookings" b WHERE b."id" = pm."booking_id"),
  '00000000-0000-0000-0000-000000000001') WHERE pm."tenant_id" IS NULL;--> statement-breakpoint

-- ============ 5. lock it down ============
ALTER TABLE "blog_categories"  ALTER COLUMN "tenant_id" SET NOT NULL, ALTER COLUMN "tenant_id" SET DEFAULT '00000000-0000-0000-0000-000000000001';--> statement-breakpoint
ALTER TABLE "blog_posts"       ALTER COLUMN "tenant_id" SET NOT NULL, ALTER COLUMN "tenant_id" SET DEFAULT '00000000-0000-0000-0000-000000000001';--> statement-breakpoint
ALTER TABLE "bookings"         ALTER COLUMN "tenant_id" SET NOT NULL, ALTER COLUMN "tenant_id" SET DEFAULT '00000000-0000-0000-0000-000000000001';--> statement-breakpoint
ALTER TABLE "destinations"     ALTER COLUMN "tenant_id" SET NOT NULL, ALTER COLUMN "tenant_id" SET DEFAULT '00000000-0000-0000-0000-000000000001';--> statement-breakpoint
ALTER TABLE "files"            ALTER COLUMN "tenant_id" SET NOT NULL, ALTER COLUMN "tenant_id" SET DEFAULT '00000000-0000-0000-0000-000000000001';--> statement-breakpoint
ALTER TABLE "payments"         ALTER COLUMN "tenant_id" SET NOT NULL, ALTER COLUMN "tenant_id" SET DEFAULT '00000000-0000-0000-0000-000000000001';--> statement-breakpoint
ALTER TABLE "tour_destinations" ALTER COLUMN "tenant_id" SET NOT NULL, ALTER COLUMN "tenant_id" SET DEFAULT '00000000-0000-0000-0000-000000000001';--> statement-breakpoint
ALTER TABLE "tours"            ALTER COLUMN "tenant_id" SET NOT NULL, ALTER COLUMN "tenant_id" SET DEFAULT '00000000-0000-0000-0000-000000000001';--> statement-breakpoint

-- ============ 6. tenant-scoped uniques, needed as FK targets ============
ALTER TABLE "blog_categories" ADD CONSTRAINT "blog_categories_tenant_id_id_key" UNIQUE("tenant_id","id");--> statement-breakpoint
ALTER TABLE "blog_categories" ADD CONSTRAINT "blog_categories_tenant_id_slug_key" UNIQUE("tenant_id","slug");--> statement-breakpoint
ALTER TABLE "blog_posts" ADD CONSTRAINT "blog_posts_tenant_id_slug_key" UNIQUE("tenant_id","slug");--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_tenant_id_id_key" UNIQUE("tenant_id","id");--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_tenant_id_reference_key" UNIQUE("tenant_id","booking_reference");--> statement-breakpoint
ALTER TABLE "destinations" ADD CONSTRAINT "destinations_tenant_id_id_key" UNIQUE("tenant_id","id");--> statement-breakpoint
ALTER TABLE "destinations" ADD CONSTRAINT "destinations_tenant_id_slug_key" UNIQUE("tenant_id","slug");--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_tenant_id_id_key" UNIQUE("tenant_id","id");--> statement-breakpoint
ALTER TABLE "tours" ADD CONSTRAINT "tours_tenant_id_id_key" UNIQUE("tenant_id","id");--> statement-breakpoint
ALTER TABLE "tours" ADD CONSTRAINT "tours_tenant_id_slug_key" UNIQUE("tenant_id","slug");--> statement-breakpoint

-- ============ 7. foreign keys ============
ALTER TABLE "blog_categories" ADD CONSTRAINT "blog_categories_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "blog_posts" ADD CONSTRAINT "blog_posts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "destinations" ADD CONSTRAINT "destinations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "files" ADD CONSTRAINT "files_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tour_destinations" ADD CONSTRAINT "tour_destinations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tours" ADD CONSTRAINT "tours_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint

-- Composite keys: a child may only point at a parent in its own tenant.
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_tour_tenant_fk" FOREIGN KEY ("tenant_id","tour_id") REFERENCES "public"."tours"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_booking_tenant_fk" FOREIGN KEY ("tenant_id","booking_id") REFERENCES "public"."bookings"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tour_destinations" ADD CONSTRAINT "tour_destinations_tour_tenant_fk" FOREIGN KEY ("tenant_id","tour_id") REFERENCES "public"."tours"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tour_destinations" ADD CONSTRAINT "tour_destinations_destination_tenant_fk" FOREIGN KEY ("tenant_id","destination_id") REFERENCES "public"."destinations"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlements" ADD CONSTRAINT "settlements_payment_tenant_fk" FOREIGN KEY ("tenant_id","payment_id") REFERENCES "public"."payments"("tenant_id","id") ON DELETE SET NULL ("payment_id") ON UPDATE no action;--> statement-breakpoint

-- Column-scoped SET NULL (Postgres 15+). A plain ON DELETE SET NULL is
-- ACCEPTED at definition time here but fails at DELETE time, because it would
-- try to null tenant_id, which is NOT NULL — a bug that would only surface the
-- first time somebody deleted a blog category in production. Drizzle cannot
-- express the column list, so its snapshot says a plain `set null`; do not
-- "fix" the divergence by regenerating this statement.
ALTER TABLE "blog_posts" ADD CONSTRAINT "blog_posts_category_tenant_fk" FOREIGN KEY ("tenant_id","category_id") REFERENCES "public"."blog_categories"("tenant_id","id") ON DELETE SET NULL ("category_id") ON UPDATE no action;--> statement-breakpoint

-- ============ 8. indexes ============
CREATE INDEX "blog_categories_tenant_id_idx" ON "blog_categories" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "blog_posts_tenant_id_idx" ON "blog_posts" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "bookings_tenant_id_idx" ON "bookings" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "destinations_tenant_id_idx" ON "destinations" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "files_tenant_id_idx" ON "files" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "payments_tenant_id_idx" ON "payments" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "tour_destinations_tenant_id_idx" ON "tour_destinations" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "tours_tenant_id_idx" ON "tours" USING btree ("tenant_id");
