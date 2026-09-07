ALTER TABLE "bookings" DROP CONSTRAINT "bookings_user_id_user_id_fk";
--> statement-breakpoint
ALTER TABLE "bookings" ALTER COLUMN "user_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;