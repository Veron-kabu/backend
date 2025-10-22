-- Migration: add order_status_history table
CREATE TABLE IF NOT EXISTS "order_status_history" (
  "id" serial PRIMARY KEY,
  "order_id" integer NOT NULL REFERENCES "orders"("id") ON DELETE cascade,
  "from_status" varchar(20),
  "to_status" varchar(20) NOT NULL,
  "changed_by_user_id" integer NOT NULL REFERENCES "users"("id") ON DELETE no action,
  "created_at" timestamp DEFAULT now()
);

CREATE INDEX IF NOT EXISTS order_status_history_order_idx ON "order_status_history" ("order_id");
