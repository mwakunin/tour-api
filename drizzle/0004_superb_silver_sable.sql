DROP INDEX "tours_pricing_tiers_idx";--> statement-breakpoint
DROP INDEX "tours_validity_period_idx";--> statement-breakpoint
ALTER TABLE "tours" ALTER COLUMN "price_amount" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "tours" ALTER COLUMN "price_currency" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "tours" ADD COLUMN "pricing_periods" jsonb DEFAULT '[]'::jsonb;--> statement-breakpoint
CREATE INDEX "tours_pricing_periods_idx" ON "tours" USING gin ("pricing_periods");--> statement-breakpoint
ALTER TABLE "tours" DROP COLUMN "pricing_tiers";--> statement-breakpoint
ALTER TABLE "tours" DROP COLUMN "validity_period";