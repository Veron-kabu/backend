-- Extend verification persistence: codes, tokens, reviewer, user flag

-- Users: farm_verified boolean
ALTER TABLE users ADD COLUMN IF NOT EXISTS farm_verified boolean DEFAULT false;

-- Verification submissions: reviewer_id, review_comment, auto_checks
ALTER TABLE verification_submissions ADD COLUMN IF NOT EXISTS reviewer_id integer REFERENCES users(id);
ALTER TABLE verification_submissions ADD COLUMN IF NOT EXISTS review_comment text;
ALTER TABLE verification_submissions ADD COLUMN IF NOT EXISTS auto_checks jsonb DEFAULT '{}'::jsonb;

-- Image hashes table (if not already exists in your environment)
CREATE TABLE IF NOT EXISTS image_hashes (
  id serial PRIMARY KEY,
  hash varchar(128) NOT NULL,
  verification_id integer NOT NULL REFERENCES verification_submissions(id) ON DELETE CASCADE,
  user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  phash varchar(32),
  created_at timestamp DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_image_hashes_user ON image_hashes(user_id);
CREATE INDEX IF NOT EXISTS idx_image_hashes_created ON image_hashes(created_at DESC);

-- Verification codes
CREATE TABLE IF NOT EXISTS verification_codes (
  id serial PRIMARY KEY,
  user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code varchar(64) NOT NULL,
  expires_at timestamp NOT NULL,
  allowed_uses integer NOT NULL DEFAULT 3,
  created_at timestamp DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_verification_codes_user ON verification_codes(user_id);
CREATE INDEX IF NOT EXISTS idx_verification_codes_code ON verification_codes(code);

-- Upload tokens
CREATE TABLE IF NOT EXISTS upload_tokens (
  id serial PRIMARY KEY,
  user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  upload_key text NOT NULL,
  content_type varchar(128),
  expires_at timestamp NOT NULL,
  created_at timestamp DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_upload_tokens_user ON upload_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_upload_tokens_key ON upload_tokens(upload_key);
