-- Add discount_percent column to products
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "discount_percent" integer DEFAULT 0;

-- Optional: backfill ensure no nulls
UPDATE "products" SET "discount_percent" = 0 WHERE "discount_percent" IS NULL;
