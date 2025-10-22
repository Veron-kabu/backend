-- Verification persistence

CREATE TABLE IF NOT EXISTS user_verification (
  user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status varchar(20) NOT NULL DEFAULT 'unverified',
  updated_at timestamp DEFAULT now(),
  CONSTRAINT user_verification_user_id_unique UNIQUE (user_id)
);

CREATE TABLE IF NOT EXISTS verification_submissions (
  id serial PRIMARY KEY,
  user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code varchar(64),
  images jsonb DEFAULT '[]'::jsonb,
  device_info jsonb,
  status varchar(20) DEFAULT 'pending',
  created_at timestamp DEFAULT now(),
  updated_at timestamp DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_verif_submissions_user ON verification_submissions(user_id);
CREATE INDEX IF NOT EXISTS idx_verif_submissions_created ON verification_submissions(created_at DESC);
