-- 006-price-alerts.sql: Add price_alerts table for Pro subscriber price drop notifications

CREATE TABLE IF NOT EXISTS price_alerts (
  id              UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id         UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  saved_item_id   UUID,  -- reference to saved_items.id (soft reference — item may be deleted)
  product_name    TEXT,
  brand           TEXT,
  original_price  NUMERIC,
  current_price   NUMERIC,
  drop_percentage NUMERIC,
  product_url     TEXT,
  search_query    TEXT,
  seen            BOOLEAN DEFAULT false,
  detected_at     TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_price_alerts_user ON price_alerts(user_id, seen);
CREATE INDEX IF NOT EXISTS idx_price_alerts_item  ON price_alerts(saved_item_id);
CREATE INDEX IF NOT EXISTS idx_price_alerts_date  ON price_alerts(detected_at);

-- RLS: users can only read/update their own alerts; inserts are service-role only
ALTER TABLE price_alerts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own price alerts"
  ON price_alerts FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can update own price alerts"
  ON price_alerts FOR UPDATE
  USING (auth.uid() = user_id);
