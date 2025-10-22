CREATE TABLE "clerk_sync_runs" (
	"id" serial PRIMARY KEY NOT NULL,
	"source" varchar(40),
	"dry_run" boolean DEFAULT false,
	"started_at" timestamp DEFAULT now(),
	"finished_at" timestamp,
	"duration_ms" integer,
	"processed" integer DEFAULT 0,
	"inserted" integer DEFAULT 0,
	"updated" integer DEFAULT 0,
	"status" varchar(20) DEFAULT 'success',
	"error_message" text
);
--> statement-breakpoint
CREATE TABLE "order_status_history" (
	"id" serial PRIMARY KEY NOT NULL,
	"order_id" integer NOT NULL,
	"from_status" varchar(20),
	"to_status" varchar(20) NOT NULL,
	"changed_by_user_id" integer NOT NULL,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "geo_cell" varchar(32);--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "thumbnails" jsonb DEFAULT '[]'::jsonb;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "image_blurhashes" jsonb DEFAULT '[]'::jsonb;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "discount_percent" integer DEFAULT 0;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "geo_cell" varchar(32);--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "banner_image_url" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "profile_image_blurhash" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "banner_image_blurhash" text;--> statement-breakpoint
ALTER TABLE "order_status_history" ADD CONSTRAINT "order_status_history_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_status_history" ADD CONSTRAINT "order_status_history_changed_by_user_id_users_id_fk" FOREIGN KEY ("changed_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;