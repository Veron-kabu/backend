-- Ensure deleting from orders cascades to dependent tables

-- order_status_history.order_id -> orders.id ON DELETE CASCADE
ALTER TABLE "order_status_history"
  DROP CONSTRAINT IF EXISTS "order_status_history_order_id_orders_id_fk";
ALTER TABLE "order_status_history"
  ADD CONSTRAINT "order_status_history_order_id_orders_id_fk"
  FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE;

-- reviews.order_id -> orders.id ON DELETE CASCADE
ALTER TABLE "reviews"
  DROP CONSTRAINT IF EXISTS "reviews_order_id_orders_id_fk";
ALTER TABLE "reviews"
  ADD CONSTRAINT "reviews_order_id_orders_id_fk"
  FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE;

-- If you still have a messages table referencing orders (older schema), cascade that too
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'messages'
  ) THEN
    BEGIN
      EXECUTE 'ALTER TABLE "messages" DROP CONSTRAINT IF EXISTS "messages_order_id_orders_id_fk"';
      EXECUTE 'ALTER TABLE "messages" ADD CONSTRAINT "messages_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE';
    EXCEPTION WHEN undefined_table THEN
      -- ignore if messages table no longer exists
      NULL;
    END;
  END IF;
END$$;
