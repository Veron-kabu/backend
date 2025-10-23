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
CREATE TABLE IF NOT EXISTS "review_comments" (
	"id" serial PRIMARY KEY NOT NULL,
	"review_id" integer NOT NULL,
	"author_user_id" integer NOT NULL,
	"comment" text NOT NULL,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "user_reports" (
	"id" serial PRIMARY KEY NOT NULL,
	"reported_user_id" integer NOT NULL,
	"reporter_id" integer NOT NULL,
	"reason_code" varchar(32) NOT NULL,
	"description" text,
	"evidence_media_links" jsonb DEFAULT '[]'::jsonb,
	"status" varchar(20) DEFAULT 'pending',
	"created_at" timestamp DEFAULT now(),
	"validated_by_user_id" integer,
	"validated_at" timestamp,
	"resolution_note" text
);
--> statement-breakpoint
DROP TABLE IF EXISTS "image_hashes" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "verification_codes" CASCADE;--> statement-breakpoint
ALTER TABLE "reviews" ALTER COLUMN "order_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "reviews" ADD COLUMN IF NOT EXISTS "product_id" integer;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "is_trusted" boolean DEFAULT false;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "strikes_count" integer DEFAULT 0;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "rating_avg" numeric(3, 2) DEFAULT '0';--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "rating_count" integer DEFAULT 0;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "report_appeals" ADD CONSTRAINT "report_appeals_report_id_user_reports_id_fk" FOREIGN KEY ("report_id") REFERENCES "public"."user_reports"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "report_appeals" ADD CONSTRAINT "report_appeals_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "report_appeals" ADD CONSTRAINT "report_appeals_resolver_user_id_users_id_fk" FOREIGN KEY ("resolver_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "review_comments" ADD CONSTRAINT "review_comments_review_id_reviews_id_fk" FOREIGN KEY ("review_id") REFERENCES "public"."reviews"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "review_comments" ADD CONSTRAINT "review_comments_author_user_id_users_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "user_reports" ADD CONSTRAINT "user_reports_reported_user_id_users_id_fk" FOREIGN KEY ("reported_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "user_reports" ADD CONSTRAINT "user_reports_reporter_id_users_id_fk" FOREIGN KEY ("reporter_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "user_reports" ADD CONSTRAINT "user_reports_validated_by_user_id_users_id_fk" FOREIGN KEY ("validated_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "reviews" ADD CONSTRAINT "reviews_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_favorites_buyer" ON "favorites" USING btree ("buyer_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_favorites_product" ON "favorites" USING btree ("product_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_orders_buyer" ON "orders" USING btree ("buyer_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_orders_farmer" ON "orders" USING btree ("farmer_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_orders_product" ON "orders" USING btree ("product_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_orders_created" ON "orders" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_products_created" ON "products" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_products_status_created" ON "products" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_products_farmer" ON "products" USING btree ("farmer_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_products_category" ON "products" USING btree ("category");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_reviews_reviewed" ON "reviews" USING btree ("reviewed_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_reviews_product" ON "reviews" USING btree ("product_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_reviews_created" ON "reviews" USING btree ("created_at");--> statement-breakpoint
ALTER TABLE "verification_submissions" DROP COLUMN IF EXISTS "code";--> statement-breakpoint
ALTER TABLE "verification_submissions" DROP COLUMN IF EXISTS "image_reviews";--> statement-breakpoint
ALTER TABLE "verification_submissions" DROP COLUMN IF EXISTS "auto_checks";--> statement-breakpoint
ALTER TABLE "verification_submissions" DROP COLUMN IF EXISTS "two_admin_required";