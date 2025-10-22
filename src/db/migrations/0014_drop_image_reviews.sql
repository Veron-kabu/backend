-- Drop deprecated per-image review data now removed from the codebase
ALTER TABLE "verification_submissions" DROP COLUMN IF EXISTS "image_reviews";
