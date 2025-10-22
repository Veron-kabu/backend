-- Migration: add banner_image_url to users
ALTER TABLE users ADD COLUMN IF NOT EXISTS banner_image_url text;
