-- 0003_add_blurhash_columns.sql
ALTER TABLE users ADD COLUMN IF NOT EXISTS profile_image_blurhash text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS banner_image_blurhash text;
ALTER TABLE products ADD COLUMN IF NOT EXISTS image_blurhashes jsonb DEFAULT '[]'::jsonb;
