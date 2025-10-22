-- Add thumbnails JSONB column for progressive image loading
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "thumbnails" jsonb DEFAULT '[]'::jsonb;
