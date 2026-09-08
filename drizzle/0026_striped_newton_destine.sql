-- Money that moves becomes integer cents.
--
-- drizzle-kit generates this as five DROP/ADDs in schema order, which drops
-- price_per_person before price_per_person_cents exists and loses every
-- booking's price. The order below backfills first. It is otherwise the same
-- end state, and the snapshot is the generated one.
--
-- The decimal columns come back GENERATED ALWAYS, so nothing that reads them
-- changes -- the invoice PDF, the confirmation emails, the revenue SQL and the
-- API's "4200.00" strings all keep working -- while writes have to name the
-- _cents column or Postgres rejects them.

--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "price_per_person_cents" bigint;--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "total_price_cents" bigint;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "amount_cents" bigint;--> statement-breakpoint

-- Exact, not approximate: the source is numeric(10,2), so multiplying by 100
-- already lands on a whole number and round() only guards the cast.
UPDATE "bookings" SET
  "price_per_person_cents" = round("price_per_person" * 100)::bigint,
  "total_price_cents" = round("total_price" * 100)::bigint;--> statement-breakpoint
UPDATE "payments" SET "amount_cents" = round("amount" * 100)::bigint;--> statement-breakpoint

ALTER TABLE "bookings" ALTER COLUMN "price_per_person_cents" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "bookings" ALTER COLUMN "total_price_cents" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "payments" ALTER COLUMN "amount_cents" SET NOT NULL;--> statement-breakpoint

ALTER TABLE "bookings" DROP COLUMN "price_per_person";--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "price_per_person" numeric(10, 2) GENERATED ALWAYS AS ((price_per_person_cents::numeric / 100)) STORED NOT NULL;--> statement-breakpoint
ALTER TABLE "bookings" DROP COLUMN "total_price";--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "total_price" numeric(10, 2) GENERATED ALWAYS AS ((total_price_cents::numeric / 100)) STORED NOT NULL;--> statement-breakpoint
ALTER TABLE "payments" DROP COLUMN "amount";--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "amount" numeric(10, 2) GENERATED ALWAYS AS ((amount_cents::numeric / 100)) STORED NOT NULL;
