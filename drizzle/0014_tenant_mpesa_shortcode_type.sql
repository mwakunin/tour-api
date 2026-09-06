-- Whether a tenant's M-Pesa shortcode is a Paybill or a Till.
--
-- Daraja requires the transaction type to match the shortcode: a Paybill takes
-- CustomerPayBillOnline and a Till takes CustomerBuyGoodsOnline, and sending
-- the wrong one fails the STK push. It was a single deployment-wide constant,
-- which cannot be right once two operators have different shortcode kinds.
--
-- Defaults to paybill, which is what the existing constant assumed, so no
-- current behaviour changes until an operator is explicitly marked as a till.

CREATE TYPE "mpesa_shortcode_type" AS ENUM ('paybill', 'till');--> statement-breakpoint

ALTER TABLE "tenants"
  ADD COLUMN "mpesa_shortcode_type" "mpesa_shortcode_type" NOT NULL DEFAULT 'paybill';
