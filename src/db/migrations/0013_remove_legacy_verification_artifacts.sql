-- Drop legacy verification artifacts: image_hashes table, verification_codes table,
-- and columns auto_checks and two_admin_required from verification_submissions.

-- Safely drop foreign keys and tables if exist
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='image_hashes') THEN
    DROP TABLE IF EXISTS image_hashes CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='verification_codes') THEN
    DROP TABLE IF EXISTS verification_codes CASCADE;
  END IF;
END $$;

-- Remove columns from verification_submissions if they exist
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='verification_submissions' AND column_name='auto_checks'
  ) THEN
    ALTER TABLE verification_submissions DROP COLUMN auto_checks;
  END IF;
END $$;

DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='verification_submissions' AND column_name='two_admin_required'
  ) THEN
    ALTER TABLE verification_submissions DROP COLUMN two_admin_required;
  END IF;
END $$;

DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='verification_submissions' AND column_name='code'
  ) THEN
    ALTER TABLE verification_submissions DROP COLUMN code;
  END IF;
END $$;
