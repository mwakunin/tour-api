CREATE TYPE "public"."counterparty_type" AS ENUM('customer', 'supplier', 'agent', 'staff', 'authority', 'other');--> statement-breakpoint
CREATE TYPE "public"."ledger_account" AS ENUM('cash_mpesa', 'cash_pesapal', 'cash_paystack', 'cash_bank', 'cash_other', 'accounts_receivable', 'accounts_payable', 'revenue', 'cost_of_sales', 'commission_expense', 'fx_gain_loss', 'rounding');--> statement-breakpoint
CREATE TYPE "public"."obligation_direction" AS ENUM('receivable', 'payable');--> statement-breakpoint
CREATE TYPE "public"."obligation_kind" AS ENUM('deposit', 'balance', 'full', 'commission', 'refund', 'fee', 'adjustment');--> statement-breakpoint
CREATE TYPE "public"."obligation_status" AS ENUM('open', 'void', 'written_off');--> statement-breakpoint
CREATE TYPE "public"."settlement_direction" AS ENUM('in', 'out');--> statement-breakpoint
CREATE TYPE "public"."settlement_status" AS ENUM('pending', 'completed', 'failed', 'reversed');--> statement-breakpoint
CREATE TYPE "public"."tenant_status" AS ENUM('active', 'suspended');--> statement-breakpoint
CREATE TABLE "allocations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"obligation_id" uuid NOT NULL,
	"settlement_id" uuid NOT NULL,
	"amount_cents" bigint NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "allocations_obligation_settlement_key" UNIQUE("obligation_id","settlement_id"),
	CONSTRAINT "allocations_amount_cents_positive" CHECK ("allocations"."amount_cents" > 0)
);
--> statement-breakpoint
CREATE TABLE "counterparties" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"type" "counterparty_type" NOT NULL,
	"name" text NOT NULL,
	"email" text,
	"phone" text,
	"default_currency" "currency" DEFAULT 'KES' NOT NULL,
	"payment_terms_days" integer,
	"commission_rate_bps" integer,
	"mpesa_number" text,
	"bank_details" text,
	"notes" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "counterparties_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "counterparties_commission_rate_bps_range" CHECK ("counterparties"."commission_rate_bps" IS NULL OR ("counterparties"."commission_rate_bps" >= 0 AND "counterparties"."commission_rate_bps" <= 10000))
);
--> statement-breakpoint
CREATE TABLE "fx_rates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid,
	"base_currency" "currency" NOT NULL,
	"quote_currency" "currency" NOT NULL,
	"rate_ppm" bigint NOT NULL,
	"as_of" date NOT NULL,
	"source" varchar(64),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fx_rates_rate_ppm_positive" CHECK ("fx_rates"."rate_ppm" > 0),
	CONSTRAINT "fx_rates_currencies_differ" CHECK ("fx_rates"."base_currency" <> "fx_rates"."quote_currency")
);
--> statement-breakpoint
CREATE TABLE "ledger_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"entry_group_id" uuid NOT NULL,
	"account" "ledger_account" NOT NULL,
	"amount_cents" bigint NOT NULL,
	"currency" "currency" NOT NULL,
	"base_amount_cents" bigint NOT NULL,
	"fx_rate_id" uuid,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"source_type" text,
	"source_id" uuid,
	"memo" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ledger_entries_amount_cents_non_zero" CHECK ("ledger_entries"."amount_cents" <> 0)
);
--> statement-breakpoint
CREATE TABLE "obligations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"direction" "obligation_direction" NOT NULL,
	"kind" "obligation_kind" NOT NULL,
	"counterparty_id" uuid,
	"source_type" text,
	"source_id" uuid,
	"amount_cents" bigint NOT NULL,
	"currency" "currency" NOT NULL,
	"due_on" date,
	"status" "obligation_status" DEFAULT 'open' NOT NULL,
	"description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "obligations_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "obligations_amount_cents_positive" CHECK ("obligations"."amount_cents" > 0)
);
--> statement-breakpoint
CREATE TABLE "settlements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"direction" "settlement_direction" NOT NULL,
	"counterparty_id" uuid,
	"method" "payment_method" NOT NULL,
	"amount_cents" bigint NOT NULL,
	"currency" "currency" NOT NULL,
	"external_reference" text,
	"payment_id" uuid,
	"status" "settlement_status" DEFAULT 'pending' NOT NULL,
	"occurred_at" timestamp with time zone,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "settlements_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "settlements_amount_cents_positive" CHECK ("settlements"."amount_cents" > 0)
);
--> statement-breakpoint
CREATE TABLE "tenants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"slug" varchar(63) NOT NULL,
	"base_currency" "currency" DEFAULT 'KES' NOT NULL,
	"booking_ref_prefix" varchar(8) DEFAULT 'FA' NOT NULL,
	"mpesa_shortcode" text,
	"mpesa_credentials" text,
	"pesapal_credentials" text,
	"status" "tenant_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tenants_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
ALTER TABLE "allocations" ADD CONSTRAINT "allocations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "allocations" ADD CONSTRAINT "allocations_obligation_tenant_fk" FOREIGN KEY ("tenant_id","obligation_id") REFERENCES "public"."obligations"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "allocations" ADD CONSTRAINT "allocations_settlement_tenant_fk" FOREIGN KEY ("tenant_id","settlement_id") REFERENCES "public"."settlements"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "counterparties" ADD CONSTRAINT "counterparties_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fx_rates" ADD CONSTRAINT "fx_rates_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_fx_rate_id_fx_rates_id_fk" FOREIGN KEY ("fx_rate_id") REFERENCES "public"."fx_rates"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "obligations" ADD CONSTRAINT "obligations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "obligations" ADD CONSTRAINT "obligations_counterparty_tenant_fk" FOREIGN KEY ("tenant_id","counterparty_id") REFERENCES "public"."counterparties"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlements" ADD CONSTRAINT "settlements_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlements" ADD CONSTRAINT "settlements_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlements" ADD CONSTRAINT "settlements_counterparty_tenant_fk" FOREIGN KEY ("tenant_id","counterparty_id") REFERENCES "public"."counterparties"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "allocations_tenant_id_idx" ON "allocations" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "allocations_obligation_idx" ON "allocations" USING btree ("obligation_id");--> statement-breakpoint
CREATE INDEX "allocations_settlement_idx" ON "allocations" USING btree ("settlement_id");--> statement-breakpoint
CREATE INDEX "counterparties_tenant_id_idx" ON "counterparties" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "counterparties_tenant_type_idx" ON "counterparties" USING btree ("tenant_id","type");--> statement-breakpoint
CREATE INDEX "counterparties_name_idx" ON "counterparties" USING btree ("name");--> statement-breakpoint
CREATE INDEX "fx_rates_lookup_idx" ON "fx_rates" USING btree ("tenant_id","base_currency","quote_currency","as_of");--> statement-breakpoint
CREATE INDEX "ledger_entries_tenant_id_idx" ON "ledger_entries" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "ledger_entries_group_idx" ON "ledger_entries" USING btree ("entry_group_id");--> statement-breakpoint
CREATE INDEX "ledger_entries_tenant_account_occurred_idx" ON "ledger_entries" USING btree ("tenant_id","account","occurred_at");--> statement-breakpoint
CREATE INDEX "ledger_entries_source_idx" ON "ledger_entries" USING btree ("source_type","source_id");--> statement-breakpoint
CREATE INDEX "obligations_tenant_id_idx" ON "obligations" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "obligations_counterparty_idx" ON "obligations" USING btree ("counterparty_id");--> statement-breakpoint
CREATE INDEX "obligations_source_idx" ON "obligations" USING btree ("source_type","source_id");--> statement-breakpoint
CREATE INDEX "obligations_tenant_direction_due_idx" ON "obligations" USING btree ("tenant_id","direction","due_on");--> statement-breakpoint
CREATE INDEX "settlements_tenant_id_idx" ON "settlements" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "settlements_counterparty_idx" ON "settlements" USING btree ("counterparty_id");--> statement-breakpoint
CREATE INDEX "settlements_external_reference_idx" ON "settlements" USING btree ("external_reference");--> statement-breakpoint
CREATE INDEX "settlements_payment_id_idx" ON "settlements" USING btree ("payment_id");--> statement-breakpoint
CREATE INDEX "settlements_tenant_direction_occurred_idx" ON "settlements" USING btree ("tenant_id","direction","occurred_at");--> statement-breakpoint
CREATE INDEX "tenants_slug_idx" ON "tenants" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "tenants_status_idx" ON "tenants" USING btree ("status");