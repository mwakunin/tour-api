-- The rate an obligation's accrual was booked at.
--
-- createObligation converts using the rate as of the due date; allocate
-- converts using the rate as of the settlement date. When those differ, the
-- debit that raised the receivable and the credit that clears it do not cancel
-- in base currency. Each entry group balances on its own, so postLedger's
-- check passes and nothing complains -- but the difference stays in
-- accounts_receivable after the obligation is fully paid, growing with every
-- cross-currency booking and reconciling to nothing.
--
-- Storing the accrual rate lets the settlement clear the obligation at the
-- rate it was raised at, which is what makes it cancel exactly. The gap
-- between that and the settlement-day rate is then what it actually is -- a
-- realised FX gain or loss -- and gets its own leg, in the account the enum
-- has been carrying since 0006 without a writer.
--
-- Nullable: an obligation already in the tenant's base currency has no rate,
-- and one raised before this column existed has no record of the rate it used.
-- Both fall back to converting the settlement side alone, which is exactly
-- what happened before.

ALTER TABLE "obligations" ADD COLUMN "fx_rate_id" uuid;--> statement-breakpoint
ALTER TABLE "obligations" ADD CONSTRAINT "obligations_fx_rate_id_fx_rates_id_fk" FOREIGN KEY ("fx_rate_id") REFERENCES "public"."fx_rates"("id") ON DELETE set null ON UPDATE no action;
