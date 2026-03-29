-- ═══════════════════════════════════════════════════════════
-- 010: User Preference Signals — track what users like/dislike
-- ═══════════════════════════════════════════════════════════
-- Stores per-item preference signals from verdict buttons
-- (would_wear, on_the_fence, not_for_me). These signals feed
-- the AI preference engine to learn user style patterns.

-- Create preference signal type
DO $$ BEGIN
  CREATE TYPE preference_signal AS ENUM ('positive', 'neutral', 'negative');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS preference_signals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  scan_id UUID REFERENCES scans(id) ON DELETE SET NULL,
  item_index INT,                    -- which item in the scan
  signal preference_signal NOT NULL, -- positive=wear, neutral=fence, negative=not_for_me
  -- Denormalized item attributes for fast AI queries (no joins needed)
  brand TEXT,
  category TEXT,
  subcategory TEXT,
  color TEXT,
  material TEXT,
  price_range TEXT,                   -- e.g. "50-100"
  style_keywords JSONB DEFAULT '[]',  -- e.g. ["streetwear", "minimalist"]
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for querying user preference patterns
CREATE INDEX IF NOT EXISTS idx_pref_signals_user ON preference_signals(user_id);
CREATE INDEX IF NOT EXISTS idx_pref_signals_user_signal ON preference_signals(user_id, signal);
CREATE INDEX IF NOT EXISTS idx_pref_signals_user_brand ON preference_signals(user_id, brand) WHERE brand IS NOT NULL;

-- Add computed preference profile to profiles table
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS preference_profile JSONB DEFAULT NULL;
-- preference_profile stores the AI-computed analysis:
-- {
--   liked_brands: ["Nike", "Zara"],
--   avoided_brands: ["H&M"],
--   preferred_categories: ["top", "shoes"],
--   avoided_categories: [],
--   color_preferences: { positive: ["black", "navy"], negative: ["pink"] },
--   price_tendency: "mid",  -- "budget" | "mid" | "premium"
--   style_keywords: ["streetwear", "minimalist"],
--   signal_count: 25,
--   last_updated: "2026-03-28T00:00:00Z"
-- }

-- RLS: users can only read/write their own signals
ALTER TABLE preference_signals ENABLE ROW LEVEL SECURITY;

CREATE POLICY preference_signals_select ON preference_signals
  FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY preference_signals_insert ON preference_signals
  FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY preference_signals_delete ON preference_signals
  FOR DELETE USING (auth.uid() = user_id);
