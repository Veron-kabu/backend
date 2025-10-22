-- Add product_id to reviews and create review_comments table
ALTER TABLE "reviews" ADD COLUMN IF NOT EXISTS "product_id" integer REFERENCES "products"("id");

-- Backfill product_id for existing rows from orders
UPDATE "reviews" r
SET "product_id" = o."product_id"
FROM "orders" o
WHERE r."order_id" IS NOT NULL AND r."order_id" = o."id" AND r."product_id" IS NULL;

-- Create review_comments table
CREATE TABLE IF NOT EXISTS "review_comments" (
  "id" serial PRIMARY KEY,
  "review_id" integer NOT NULL REFERENCES "reviews"("id") ON DELETE CASCADE,
  "author_user_id" integer NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "comment" text NOT NULL,
  "created_at" timestamp DEFAULT NOW()
);