ALTER TABLE "payments" DROP CONSTRAINT "payments_confirmed_by_user_id_fk";
--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_confirmed_by_user_id_fk" FOREIGN KEY ("confirmed_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "payments_checkout_request_id_idx" ON "payments" USING btree ("checkout_request_id");