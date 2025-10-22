CREATE TABLE IF NOT EXISTS "app_settings" (
	"id" serial PRIMARY KEY NOT NULL,
	"key" varchar(128) NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp DEFAULT now(),
	CONSTRAINT "app_settings_key_unique" UNIQUE("key")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "audit_logs" (
	"id" serial PRIMARY KEY NOT NULL,
	"actor_user_id" integer,
	"action" varchar(64) NOT NULL,
	"subject_type" varchar(64) NOT NULL,
	"subject_id" varchar(64),
	"details" jsonb,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "image_hashes" (
	"id" serial PRIMARY KEY NOT NULL,
	"hash" varchar(128) NOT NULL,
	"verification_id" integer NOT NULL,
	"user_id" integer NOT NULL,
	"phash" varchar(32),
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "upload_tokens" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"upload_key" text NOT NULL,
	"content_type" varchar(128),
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "user_notifications" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"type" varchar(64) NOT NULL,
	"title" varchar(255) NOT NULL,
	"body" text,
	"data" jsonb DEFAULT '{}'::jsonb,
	"read_at" timestamp,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "user_verification" (
	"user_id" integer NOT NULL,
	"status" varchar(20) DEFAULT 'unverified' NOT NULL,
	"updated_at" timestamp DEFAULT now(),
	CONSTRAINT "user_verification_user_id_unique" UNIQUE("user_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "verification_appeals" (
	"id" serial PRIMARY KEY NOT NULL,
	"submission_id" integer NOT NULL,
	"user_id" integer NOT NULL,
	"reason" text,
	"status" varchar(20) DEFAULT 'open',
	"priority" integer DEFAULT 1,
	"created_at" timestamp DEFAULT now(),
	"resolved_at" timestamp,
	"resolver_user_id" integer,
	"resolution_note" text,
	"retention_extended_until" timestamp
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "verification_codes" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"code" varchar(64) NOT NULL,
	"expires_at" timestamp NOT NULL,
	"allowed_uses" integer DEFAULT 3 NOT NULL,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "verification_status_history" (
	"id" serial PRIMARY KEY NOT NULL,
	"submission_id" integer NOT NULL,
	"from_status" varchar(32),
	"to_status" varchar(32) NOT NULL,
	"actor_user_id" integer,
	"note" text,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "verification_submissions" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"code" varchar(64),
	"images" jsonb DEFAULT '[]'::jsonb,
	"device_info" jsonb,
	"status" varchar(20) DEFAULT 'pending',
	"image_reviews" jsonb DEFAULT '[]'::jsonb,
	"reviewer_id" integer,
	"reviewer_id2" integer,
	"review_comment" text,
	"auto_checks" jsonb DEFAULT '{}'::jsonb,
	"two_admin_required" boolean DEFAULT false,
	"retention_extended_until" timestamp,
	"admin_comments" jsonb DEFAULT '[]'::jsonb,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
-- Ensure new columns exist when table was created in a prior migration without them
ALTER TABLE "verification_submissions" ADD COLUMN IF NOT EXISTS "reviewer_id2" integer;--> statement-breakpoint
ALTER TABLE "verification_submissions" ADD COLUMN IF NOT EXISTS "two_admin_required" boolean DEFAULT false;--> statement-breakpoint
ALTER TABLE "verification_submissions" ADD COLUMN IF NOT EXISTS "retention_extended_until" timestamp;--> statement-breakpoint
ALTER TABLE "verification_submissions" ADD COLUMN IF NOT EXISTS "admin_comments" jsonb DEFAULT '[]'::jsonb;--> statement-breakpoint
ALTER TABLE "verification_submissions" ADD COLUMN IF NOT EXISTS "auto_checks" jsonb DEFAULT '{}'::jsonb;--> statement-breakpoint
ALTER TABLE "verification_submissions" ADD COLUMN IF NOT EXISTS "image_reviews" jsonb DEFAULT '[]'::jsonb;--> statement-breakpoint
ALTER TABLE "verification_submissions" ADD COLUMN IF NOT EXISTS "review_comment" text;--> statement-breakpoint
ALTER TABLE IF EXISTS "messages" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE IF EXISTS "messages" CASCADE;--> statement-breakpoint
ALTER TABLE "order_status_history" DROP CONSTRAINT "order_status_history_order_id_orders_id_fk";
--> statement-breakpoint
ALTER TABLE "reviews" DROP CONSTRAINT "reviews_order_id_orders_id_fk";
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "farm_verified" boolean DEFAULT false;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "is_trusted" boolean DEFAULT false;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "strikes_count" integer DEFAULT 0;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "rating_avg" numeric(3,2) DEFAULT 0;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "rating_count" integer DEFAULT 0;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "image_hashes" ADD CONSTRAINT "image_hashes_verification_id_verification_submissions_id_fk" FOREIGN KEY ("verification_id") REFERENCES "public"."verification_submissions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "image_hashes" ADD CONSTRAINT "image_hashes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "upload_tokens" ADD CONSTRAINT "upload_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_notifications" ADD CONSTRAINT "user_notifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_verification" ADD CONSTRAINT "user_verification_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verification_appeals" ADD CONSTRAINT "verification_appeals_submission_id_verification_submissions_id_fk" FOREIGN KEY ("submission_id") REFERENCES "public"."verification_submissions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verification_appeals" ADD CONSTRAINT "verification_appeals_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verification_appeals" ADD CONSTRAINT "verification_appeals_resolver_user_id_users_id_fk" FOREIGN KEY ("resolver_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verification_codes" ADD CONSTRAINT "verification_codes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verification_status_history" ADD CONSTRAINT "verification_status_history_submission_id_verification_submissions_id_fk" FOREIGN KEY ("submission_id") REFERENCES "public"."verification_submissions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verification_status_history" ADD CONSTRAINT "verification_status_history_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verification_submissions" ADD CONSTRAINT "verification_submissions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verification_submissions" ADD CONSTRAINT "verification_submissions_reviewer_id_users_id_fk" FOREIGN KEY ("reviewer_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verification_submissions" ADD CONSTRAINT "verification_submissions_reviewer_id2_users_id_fk" FOREIGN KEY ("reviewer_id2") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_status_history" ADD CONSTRAINT "order_status_history_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
-- Moderation tables for reporting & appeals
CREATE TABLE IF NOT EXISTS "user_reports" (
	"id" serial PRIMARY KEY NOT NULL,
	"reported_user_id" integer NOT NULL,
	"reporter_id" integer NOT NULL,
	"reason_code" varchar(32) NOT NULL,
	"description" text,
	"evidence_media_links" jsonb DEFAULT '[]'::jsonb,
	"status" varchar(20) DEFAULT 'open',
	"created_at" timestamp DEFAULT now(),
	"validated_by_user_id" integer,
	"validated_at" timestamp,
	"resolution_note" text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "report_appeals" (
	"id" serial PRIMARY KEY NOT NULL,
	"report_id" integer NOT NULL,
	"user_id" integer NOT NULL,
	"reason" text,
	"status" varchar(20) DEFAULT 'open',
	"created_at" timestamp DEFAULT now(),
	"resolved_at" timestamp,
	"resolver_user_id" integer,
	"resolution_note" text
);
--> statement-breakpoint
ALTER TABLE "user_reports" ADD CONSTRAINT "user_reports_reported_user_id_users_id_fk" FOREIGN KEY ("reported_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_reports" ADD CONSTRAINT "user_reports_reporter_id_users_id_fk" FOREIGN KEY ("reporter_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_reports" ADD CONSTRAINT "user_reports_validated_by_user_id_users_id_fk" FOREIGN KEY ("validated_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_appeals" ADD CONSTRAINT "report_appeals_report_id_user_reports_id_fk" FOREIGN KEY ("report_id") REFERENCES "public"."user_reports"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_appeals" ADD CONSTRAINT "report_appeals_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_appeals" ADD CONSTRAINT "report_appeals_resolver_user_id_users_id_fk" FOREIGN KEY ("resolver_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint