-- Make reviews.order_id nullable to support product-based reviews (no order)
ALTER TABLE "reviews" ALTER COLUMN "order_id" DROP NOT NULL;
