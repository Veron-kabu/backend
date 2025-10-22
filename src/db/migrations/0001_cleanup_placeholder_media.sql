-- 0001_cleanup_placeholder_media.sql
-- Purpose: Permanently clear any lingering placeholder CloudFront media URLs
-- that contain the scaffold value 'your-cloudfront-domain' in avatar or banner fields.
-- This prevents client-side resolution loops & warnings for stale invalid hosts.

UPDATE users
SET banner_image_url = NULL
WHERE banner_image_url ILIKE '%your-cloudfront-domain%';

UPDATE users
SET profile_image_url = NULL
WHERE profile_image_url ILIKE '%your-cloudfront-domain%';

-- (Optional) You could also log how many rows were affected if run manually:
-- SELECT COUNT(*) FROM users WHERE banner_image_url IS NULL AND profile_image_url IS NULL;