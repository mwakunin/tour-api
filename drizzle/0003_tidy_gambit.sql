CREATE TYPE "public"."payment_transaction_status" AS ENUM('pending', 'completed', 'failed');--> statement-breakpoint
ALTER TABLE "payments" ALTER COLUMN "currency" SET DEFAULT 'KES'::"public"."currency";--> statement-breakpoint
ALTER TABLE "payments" ALTER COLUMN "currency" SET DATA TYPE "public"."currency" USING "currency"::"public"."currency";--> statement-breakpoint
ALTER TABLE "payments" ALTER COLUMN "status" SET DEFAULT 'pending'::"public"."payment_transaction_status";--> statement-breakpoint
ALTER TABLE "payments" ALTER COLUMN "status" SET DATA TYPE "public"."payment_transaction_status" USING "status"::"public"."payment_transaction_status";