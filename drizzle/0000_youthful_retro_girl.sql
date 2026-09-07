CREATE TYPE "public"."post_status" AS ENUM('draft', 'published');--> statement-breakpoint
CREATE TYPE "public"."booking_status" AS ENUM('pending', 'confirmed', 'cancelled', 'completed');--> statement-breakpoint
CREATE TYPE "public"."currency" AS ENUM('USD', 'KES');--> statement-breakpoint
CREATE TYPE "public"."duration_unit" AS ENUM('hours', 'days', 'weeks');--> statement-breakpoint
CREATE TYPE "public"."payment_status" AS ENUM('pending', 'paid', 'failed', 'refunded');--> statement-breakpoint
CREATE TYPE "public"."tour_category" AS ENUM('adventure', 'cultural', 'wildlife', 'beach', 'luxury', 'budget', 'family', 'honeymoon', 'group', 'private');--> statement-breakpoint
CREATE TYPE "public"."tour_status" AS ENUM('draft', 'published', 'archived');--> statement-breakpoint
CREATE TYPE "public"."payment_method" AS ENUM('mpesa', 'paystack', 'pesapal', 'card', 'bank_transfer', 'cash');--> statement-breakpoint
CREATE TABLE "blog_categories" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" varchar(100) NOT NULL,
	"slug" varchar(100) NOT NULL,
	"description" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "blog_categories_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "blog_posts" (
	"id" serial PRIMARY KEY NOT NULL,
	"title" varchar(255) NOT NULL,
	"slug" varchar(255) NOT NULL,
	"excerpt" text NOT NULL,
	"content" text NOT NULL,
	"featured_image" varchar(500),
	"category_id" integer,
	"author_id" text NOT NULL,
	"status" "post_status" DEFAULT 'draft' NOT NULL,
	"meta_title" varchar(60),
	"meta_description" text,
	"read_time_minutes" integer,
	"views_count" integer DEFAULT 0 NOT NULL,
	"published_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "blog_posts_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "bookings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"booking_reference" varchar(20) NOT NULL,
	"tour_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"group_size" integer NOT NULL,
	"start_date" timestamp with time zone NOT NULL,
	"end_date" timestamp with time zone NOT NULL,
	"price_per_person" numeric(10, 2) NOT NULL,
	"total_price" numeric(10, 2) NOT NULL,
	"currency" "currency" NOT NULL,
	"customer_name" text NOT NULL,
	"customer_email" text NOT NULL,
	"customer_phone" text,
	"country" varchar(100),
	"special_requests" text,
	"payment_status" "payment_status" DEFAULT 'pending' NOT NULL,
	"payment_method" text,
	"payment_id" text,
	"status" "booking_status" DEFAULT 'pending' NOT NULL,
	"cancelled_at" timestamp with time zone,
	"cancellation_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bookings_booking_reference_unique" UNIQUE("booking_reference")
);
--> statement-breakpoint
CREATE TABLE "destinations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" text NOT NULL,
	"slug" varchar(250) NOT NULL,
	"description" text NOT NULL,
	"image" text NOT NULL,
	"country" text NOT NULL,
	"region" text,
	"featured" boolean DEFAULT false NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"meta_title" varchar(60),
	"meta_description" varchar(160),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "destinations_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"file_id" text NOT NULL,
	"file_name" text NOT NULL,
	"original_name" text NOT NULL,
	"url" text NOT NULL,
	"thumbnail_url" text,
	"folder" text NOT NULL,
	"file_type" text NOT NULL,
	"mime_type" text NOT NULL,
	"size" integer NOT NULL,
	"width" integer,
	"height" integer,
	"tags" jsonb DEFAULT '[]'::jsonb,
	"metadata" jsonb DEFAULT '{}'::jsonb,
	"uploaded_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "files_file_id_unique" UNIQUE("file_id")
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"booking_id" uuid NOT NULL,
	"amount" numeric(10, 2) NOT NULL,
	"currency" text DEFAULT 'KES' NOT NULL,
	"payment_method" "payment_method" NOT NULL,
	"mpesa_receipt_number" text,
	"mpesa_phone_number" text,
	"merchant_request_id" text,
	"checkout_request_id" text,
	"pesapal_tracking_id" text,
	"pesapal_merchant_reference" text,
	"pesapal_redirect_url" text,
	"paystack_reference" text,
	"paystack_access_code" text,
	"paystack_authorization_url" text,
	"receipt_number" text,
	"notes" text,
	"confirmed_by" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"response_data" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "account" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp,
	"refresh_token_expires_at" timestamp,
	"scope" text,
	"password" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "session" (
	"id" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp NOT NULL,
	"token" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" text NOT NULL,
	CONSTRAINT "session_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "user" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"role" text DEFAULT 'user' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "user_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "verification" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tour_destinations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tour_id" uuid NOT NULL,
	"destination_id" uuid NOT NULL,
	"order" integer DEFAULT 0,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "tour_destinations_tour_id_destination_id_unique" UNIQUE("tour_id","destination_id")
);
--> statement-breakpoint
CREATE TABLE "tours" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" text NOT NULL,
	"slug" varchar(250) NOT NULL,
	"overview" text NOT NULL,
	"itinerary" jsonb DEFAULT '[]'::jsonb,
	"duration" integer NOT NULL,
	"duration_unit" "duration_unit" DEFAULT 'days' NOT NULL,
	"price_amount" numeric(10, 2) NOT NULL,
	"price_currency" "currency" NOT NULL,
	"discount_percentage" numeric(5, 2) DEFAULT '0',
	"pricing_tiers" jsonb DEFAULT '[]'::jsonb,
	"validity_period" jsonb,
	"featured" boolean DEFAULT false NOT NULL,
	"is_deal" boolean DEFAULT false NOT NULL,
	"images" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"cover_image" text,
	"includes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"excludes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"requirements" text,
	"age_restriction" jsonb,
	"tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"categories" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" "tour_status" DEFAULT 'draft' NOT NULL,
	"meta_title" varchar(60),
	"meta_description" varchar(160),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tours_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
ALTER TABLE "blog_posts" ADD CONSTRAINT "blog_posts_category_id_blog_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."blog_categories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "blog_posts" ADD CONSTRAINT "blog_posts_author_id_user_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_tour_id_tours_id_fk" FOREIGN KEY ("tour_id") REFERENCES "public"."tours"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "files" ADD CONSTRAINT "files_uploaded_by_user_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_booking_id_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_confirmed_by_user_id_fk" FOREIGN KEY ("confirmed_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tour_destinations" ADD CONSTRAINT "tour_destinations_tour_id_tours_id_fk" FOREIGN KEY ("tour_id") REFERENCES "public"."tours"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tour_destinations" ADD CONSTRAINT "tour_destinations_destination_id_destinations_id_fk" FOREIGN KEY ("destination_id") REFERENCES "public"."destinations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "bookings_booking_reference_idx" ON "bookings" USING btree ("booking_reference");--> statement-breakpoint
CREATE INDEX "bookings_tour_id_idx" ON "bookings" USING btree ("tour_id");--> statement-breakpoint
CREATE INDEX "bookings_user_id_idx" ON "bookings" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "bookings_status_idx" ON "bookings" USING btree ("status");--> statement-breakpoint
CREATE INDEX "bookings_payment_status_idx" ON "bookings" USING btree ("payment_status");--> statement-breakpoint
CREATE INDEX "bookings_start_date_idx" ON "bookings" USING btree ("start_date");--> statement-breakpoint
CREATE INDEX "bookings_created_at_idx" ON "bookings" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "destinations_slug_idx" ON "destinations" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "destinations_country_idx" ON "destinations" USING btree ("country");--> statement-breakpoint
CREATE INDEX "destinations_featured_idx" ON "destinations" USING btree ("featured");--> statement-breakpoint
CREATE INDEX "payments_booking_id_idx" ON "payments" USING btree ("booking_id");--> statement-breakpoint
CREATE INDEX "payments_status_idx" ON "payments" USING btree ("status");--> statement-breakpoint
CREATE INDEX "payments_paystack_ref_idx" ON "payments" USING btree ("paystack_reference");--> statement-breakpoint
CREATE INDEX "payments_pesapal_tracking_idx" ON "payments" USING btree ("pesapal_tracking_id");--> statement-breakpoint
CREATE INDEX "payments_pesapal_merchant_ref_idx" ON "payments" USING btree ("pesapal_merchant_reference");--> statement-breakpoint
CREATE INDEX "account_userId_idx" ON "account" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "session_userId_idx" ON "session" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "verification_identifier_idx" ON "verification" USING btree ("identifier");--> statement-breakpoint
CREATE INDEX "tour_destinations_tour_id_idx" ON "tour_destinations" USING btree ("tour_id");--> statement-breakpoint
CREATE INDEX "tour_destinations_destination_id_idx" ON "tour_destinations" USING btree ("destination_id");--> statement-breakpoint
CREATE INDEX "tour_destinations_tour_dest_idx" ON "tour_destinations" USING btree ("tour_id","destination_id");--> statement-breakpoint
CREATE INDEX "tours_slug_idx" ON "tours" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "tours_status_idx" ON "tours" USING btree ("status");--> statement-breakpoint
CREATE INDEX "tours_featured_idx" ON "tours" USING btree ("featured");--> statement-breakpoint
CREATE INDEX "tours_is_deal_idx" ON "tours" USING btree ("is_deal");--> statement-breakpoint
CREATE INDEX "tours_created_at_idx" ON "tours" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "tours_price_idx" ON "tours" USING btree ("price_amount");--> statement-breakpoint
CREATE INDEX "tours_pricing_tiers_idx" ON "tours" USING gin ("pricing_tiers");--> statement-breakpoint
CREATE INDEX "tours_validity_period_idx" ON "tours" USING gin ("validity_period");