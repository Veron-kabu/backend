-- 0006_add_clerk_sync_runs.sql
-- Adds clerk_sync_runs table for tracking user sync executions
CREATE TABLE IF NOT EXISTS clerk_sync_runs (
  id serial PRIMARY KEY,
  source varchar(40),
  dry_run boolean DEFAULT false,
  started_at timestamp DEFAULT now(),
  finished_at timestamp,
  duration_ms integer,
  processed integer DEFAULT 0,
  inserted integer DEFAULT 0,
  updated integer DEFAULT 0,
  status varchar(20) DEFAULT 'success',
  error_message text
);
