CREATE TYPE "public"."ledger_outbox_operation" AS ENUM('booking_receivable', 'agent_commission', 'booking_settlement');--> statement-breakpoint
CREATE TABLE "ledger_outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"operation" "ledger_outbox_operation" NOT NULL,
	"subject_id" uuid NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"last_attempted_at" timestamp with time zone,
	"resolved_at" timestamp with time zone,
	"resolution" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ledger_outbox_operation_subject_key" UNIQUE("tenant_id","operation","subject_id")
);
--> statement-breakpoint
ALTER TABLE "ledger_outbox" ADD CONSTRAINT "ledger_outbox_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ledger_outbox_tenant_idx" ON "ledger_outbox" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "ledger_outbox_pending_idx" ON "ledger_outbox" USING btree ("tenant_id","resolved_at","created_at");--> statement-breakpoint
CREATE INDEX "ledger_outbox_subject_idx" ON "ledger_outbox" USING btree ("operation","subject_id");--> statement-breakpoint

-- ============ tenancy ============
--
-- Both halves are required. Without the GRANT the runtime role cannot touch
-- the table; without the policies it could read and write every tenant's
-- failed accruals, because a table with RLS disabled has no policy to fail.
-- drizzle-kit emits neither, so they are written here by hand.

GRANT SELECT, INSERT, UPDATE, DELETE ON "ledger_outbox" TO tourops_app;--> statement-breakpoint

ALTER TABLE "ledger_outbox" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "ledger_outbox" FORCE ROW LEVEL SECURITY;--> statement-breakpoint

-- USING governs what is visible, WITH CHECK what may be written. Both, so a
-- handler cannot file another tenant's failure and merely be unable to read it
-- back.
CREATE POLICY "ledger_outbox_tenant_isolation" ON "ledger_outbox"
  USING ("tenant_id" = public.current_tenant_id())
  WITH CHECK ("tenant_id" = public.current_tenant_id());--> statement-breakpoint

-- ============ what makes a retry safe ============
--
-- An outbox is only worth having if replaying an entry cannot post the same
-- revenue twice. recordBookingSettlement was already idempotent -- the partial
-- unique index from 0012 on settlements.payment_id makes a second attempt fail
-- with 23505, which that path treats as the guard working. The two obligation
-- raisers were not: each retry would have created another receivable.
--
-- One open accrual per (booking, direction, kind). Deposit and balance are
-- different kinds so a schedule still fits; a commission is a different
-- direction as well. Partial on status='open' so a cancelled booking, whose
-- obligations are voided rather than deleted, can still be re-raised.
--
-- The check in bookingLedger turns this into a clean skip. The index is what
-- makes it true when two drains run at once.
-- Refuse legibly rather than failing on the index build.
--
-- Nothing before this migration stopped two concurrent calls from raising the
-- same accrual twice: the raisers read-then-inserted with no constraint behind
-- them. Neither dev nor test has such a row, but neither is production, and
-- CREATE UNIQUE INDEX would report one duplicated key value and nothing about
-- which bookings to look at or what to do.
--
-- Deliberately NOT reconciling them automatically. Two open accruals against
-- one booking are two claims on real money, and which of them is right -- or
-- whether both are, because somebody genuinely rebooked -- is not a decision a
-- migration gets to take silently. Voiding the wrong one erases revenue.
DO $$
DECLARE
  offenders text;
BEGIN
  -- format() takes %s; RAISE below takes a bare %. They are not the same
  -- placeholder, and mixing them prints a stray 's' into the operator's face
  -- at exactly the moment they are trying to read it.
  SELECT E'\n  ' || string_agg(
           format('booking %s (%s/%s): %s rows', source_id, direction, kind, n),
           E'\n  '
         )
    INTO offenders
    FROM (
      SELECT source_id, direction, kind, count(*) AS n
        FROM obligations
       WHERE status = 'open' AND source_type = 'booking'
       GROUP BY tenant_id, source_id, direction, kind
      HAVING count(*) > 1
    ) dupes;

  IF offenders IS NOT NULL THEN
    RAISE EXCEPTION
      'Duplicate open booking accruals exist, so the uniqueness this migration '
      'adds cannot be applied. Void the obligations that should not stand, '
      'then re-run. Affected:%', offenders;
  END IF;
END
$$;--> statement-breakpoint

CREATE UNIQUE INDEX "obligations_booking_accrual_unique"
  ON "obligations" ("tenant_id", "source_type", "source_id", "direction", "kind")
  WHERE "status" = 'open' AND "source_type" = 'booking';
