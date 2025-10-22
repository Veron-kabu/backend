-- Migration: standardize reports status to 'pending' and clean up legacy values
-- Date: 2025-10-21

BEGIN;

-- Ensure user_reports table exists with the correct default
CREATE TABLE IF NOT EXISTS "user_reports" (
  "id" serial PRIMARY KEY NOT NULL,
  "reported_user_id" integer NOT NULL REFERENCES "public"."users"("id") ON DELETE cascade,
  "reporter_id" integer NOT NULL REFERENCES "public"."users"("id") ON DELETE cascade,
  "reason_code" varchar(32) NOT NULL,
  "description" text,
  "evidence_media_links" jsonb DEFAULT '[]'::jsonb,
  "status" varchar(20) DEFAULT 'pending',
  "created_at" timestamp DEFAULT now(),
  "validated_by_user_id" integer REFERENCES "public"."users"("id"),
  "validated_at" timestamp,
  "resolution_note" text
);

-- Update existing legacy rows from 'open' to 'pending'
UPDATE "user_reports" SET "status" = 'pending' WHERE "status" = 'open';

-- Ensure report_appeals table exists (keeps 'open' as default for appeals)
CREATE TABLE IF NOT EXISTS "report_appeals" (
  "id" serial PRIMARY KEY NOT NULL,
  "report_id" integer NOT NULL REFERENCES "public"."user_reports"("id") ON DELETE cascade,
  "user_id" integer NOT NULL REFERENCES "public"."users"("id") ON DELETE cascade,
  "reason" text,
  "status" varchar(20) DEFAULT 'open',
  "created_at" timestamp DEFAULT now(),
  "resolved_at" timestamp,
  "resolver_user_id" integer REFERENCES "public"."users"("id"),
  "resolution_note" text
);

COMMIT;
