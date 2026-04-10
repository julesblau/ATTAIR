-- 021: Create preference_signals table for Hanger Check verdict tracking
-- Records user style preferences (positive/neutral/negative) per item

CREATE TABLE IF NOT EXISTS preference_signals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  scan_id UUID REFERENCES scans(id) ON DELETE SET NULL,
  item_index INTEGER,
  signal TEXT NOT NULL CHECK (signal IN ('positive', 'neutral', 'negative')),
  brand TEXT,
  category TEXT,
  subcategory TEXT,
  color TEXT,
  material TEXT,
  price_range TEXT,
  style_keywords TEXT[] DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE (user_id, scan_id, item_index)
);

CREATE INDEX IF NOT EXISTS idx_preference_signals_user ON preference_signals(user_id);
