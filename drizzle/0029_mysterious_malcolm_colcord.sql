CREATE TYPE "public"."membership_role" AS ENUM('owner', 'admin', 'staff', 'customer');--> statement-breakpoint
CREATE TABLE "memberships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"role" "membership_role" NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memberships_tenant_user_role_key" UNIQUE("tenant_id","user_id","role"),
	CONSTRAINT "memberships_tenant_id_id_key" UNIQUE("tenant_id","id")
);
--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "memberships_tenant_user_idx" ON "memberships" USING btree ("tenant_id","user_id");--> statement-breakpoint
CREATE INDEX "memberships_user_idx" ON "memberships" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "memberships_tenant_id_idx" ON "memberships" USING btree ("tenant_id");
--> statement-breakpoint

-- ============ backfill ============
--
-- Every existing user needs a membership before anything reads this table for
-- authorization, or the change that moves the twenty call sites over locks out
-- the entire user base at once.
--
-- The tenant is resolved rather than assumed. The seeded operator from
-- migration 0007 is the expected answer, but a deployment that renamed or
-- reseeded it would otherwise get a silent no-op backfill -- and "no rows
-- inserted" and "correctly backfilled" look identical afterwards. If neither
-- rule finds a tenant this RAISEs, because failing the migration is recoverable
-- and a silent lockout later is not.
--
-- Role maps from the global user.role: 'admin' becomes an admin membership,
-- everyone else a customer. That is lossless -- 'user' and 'admin' are the only
-- two values the column holds -- and it preserves today's behaviour exactly.
DO $$
DECLARE
  target_tenant uuid;
  tenant_count  integer;
  inserted      integer;
BEGIN
  IF row_security_active('memberships') THEN
    RAISE EXCEPTION
      'Cannot backfill memberships: row-level security is active for role %, '
      'so this INSERT would be filtered to one tenant and the backfill would '
      'be silently partial. Run migrations as the owner (DATABASE_URL), not '
      'the runtime role.', current_user;
  END IF;

  SELECT count(*) INTO tenant_count FROM tenants;

  SELECT id INTO target_tenant
    FROM tenants
   WHERE id = '00000000-0000-0000-0000-000000000001'::uuid;

  -- Exactly one operator and it is not the seeded id: unambiguous anyway.
  IF target_tenant IS NULL AND tenant_count = 1 THEN
    SELECT id INTO target_tenant FROM tenants;
  END IF;

  IF target_tenant IS NULL THEN
    RAISE EXCEPTION
      'Cannot backfill memberships: found % tenants and none with the seeded '
      'id. Existing users would be left with no membership, which becomes a '
      'lockout as soon as authorization reads this table. Attach them '
      'deliberately, then re-run.', tenant_count;
  END IF;

  INSERT INTO memberships (tenant_id, user_id, role)
  SELECT target_tenant,
         u.id,
         CASE WHEN u.role = 'admin' THEN 'admin'::membership_role
              ELSE 'customer'::membership_role
         END
    FROM "user" u
  ON CONFLICT ON CONSTRAINT memberships_tenant_user_role_key DO NOTHING;

  GET DIAGNOSTICS inserted = ROW_COUNT;
  RAISE NOTICE 'memberships backfill: % rows for tenant %', inserted, target_tenant;
END
$$;--> statement-breakpoint

-- ============ runtime grants ============
-- INSERT and UPDATE, but no DELETE: revoking access sets is_active = false so
-- the record of who could once act survives. Nothing in the app deletes a
-- membership; the FK from `user` cascades if the account itself goes.
GRANT SELECT, INSERT, UPDATE ON "memberships" TO tourops_app;--> statement-breakpoint

-- ============ row-level security ============
-- The point of the whole table. With policies on, `loadMembership` running
-- through withTenantDb cannot see a membership at another operator -- so a
-- session cookie that the browser sent to the wrong tenant's hostname finds
-- zero rows, rather than finding a row that some hand-written comparison then
-- has to notice is wrong.
--
-- FORCE, because the owner is otherwise exempt and the policies would be
-- decorative on any connection that happened to be the owner's.
ALTER TABLE "memberships" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "memberships" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "memberships_tenant_isolation" ON "memberships"
  USING ("tenant_id" = public.current_tenant_id())
  WITH CHECK ("tenant_id" = public.current_tenant_id());
