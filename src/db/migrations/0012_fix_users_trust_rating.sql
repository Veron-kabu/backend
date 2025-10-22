-- Ensure users table has moderation and rating columns expected by the app
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "farm_verified" boolean DEFAULT false;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "is_trusted" boolean DEFAULT false;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "strikes_count" integer DEFAULT 0;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "rating_avg" numeric(3,2) DEFAULT 0;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "rating_count" integer DEFAULT 0;
