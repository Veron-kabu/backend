-- Add coarse geocell columns and triggers for users and products

ALTER TABLE IF EXISTS users ADD COLUMN IF NOT EXISTS geo_cell VARCHAR(32);
ALTER TABLE IF EXISTS products ADD COLUMN IF NOT EXISTS geo_cell VARCHAR(32);

-- Function to compute a coarse geocell string from a jsonb location
-- Resolution of 0.1 degree (~11km latitude) when res=10
CREATE OR REPLACE FUNCTION geocell_from_location(loc JSONB, res INTEGER DEFAULT 10)
RETURNS TEXT AS $$
DECLARE
  lat NUMERIC;
  lng NUMERIC;
  cell_lat INTEGER;
  cell_lng INTEGER;
BEGIN
  IF loc IS NULL THEN
    RETURN NULL;
  END IF;
  BEGIN
    lat := (loc->>'lat')::NUMERIC;
    lng := (loc->>'lng')::NUMERIC;
  EXCEPTION WHEN others THEN
    RETURN NULL;
  END;
  IF lat IS NULL OR lng IS NULL THEN
    RETURN NULL;
  END IF;
  cell_lat := FLOOR(lat * res);
  cell_lng := FLOOR(lng * res);
  RETURN cell_lat::TEXT || ':' || cell_lng::TEXT;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- Users trigger to keep geo_cell in sync
CREATE OR REPLACE FUNCTION trg_users_set_geocell()
RETURNS TRIGGER AS $$
BEGIN
  NEW.geo_cell := geocell_from_location(NEW.location, 10);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS users_set_geocell ON users;
CREATE TRIGGER users_set_geocell BEFORE INSERT OR UPDATE OF location ON users
FOR EACH ROW EXECUTE FUNCTION trg_users_set_geocell();

-- Products trigger to keep geo_cell in sync
CREATE OR REPLACE FUNCTION trg_products_set_geocell()
RETURNS TRIGGER AS $$
BEGIN
  NEW.geo_cell := geocell_from_location(NEW.location, 10);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS products_set_geocell ON products;
CREATE TRIGGER products_set_geocell BEFORE INSERT OR UPDATE OF location ON products
FOR EACH ROW EXECUTE FUNCTION trg_products_set_geocell();

-- Backfill existing rows
UPDATE users SET geo_cell = geocell_from_location(location, 10) WHERE location IS NOT NULL;
UPDATE products SET geo_cell = geocell_from_location(location, 10) WHERE location IS NOT NULL;

-- Indexes for faster lookup
CREATE INDEX IF NOT EXISTS idx_users_geo_cell ON users (geo_cell);
CREATE INDEX IF NOT EXISTS idx_products_geo_cell ON products (geo_cell);
