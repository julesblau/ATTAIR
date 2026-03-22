-- ═══════════════════════════════════════════════════════════════
-- ATTAIR Database Schema
-- Run this in Supabase SQL Editor (Dashboard → SQL Editor → New Query)
-- ═══════════════════════════════════════════════════════════════

-- 1. Profiles — extends Supabase auth.users
CREATE TABLE IF NOT EXISTS profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  gender_pref TEXT DEFAULT 'both',
  budget_pref TEXT DEFAULT 'mid',
  tier TEXT DEFAULT 'free',                    -- free | trial | pro | expired
  subscription_provider TEXT,                  -- stripe | revenuecat
  subscription_id TEXT,
  trial_ends_at TIMESTAMPTZ,
  scans_today INT DEFAULT 0,
  scans_today_reset DATE DEFAULT CURRENT_DATE,
  saved_count INT DEFAULT 0,
  referral_code TEXT UNIQUE,
  referred_by UUID REFERENCES profiles(id),
  upgrade_source TEXT,                         -- ad_fatigue | scan_limit | paywall | referral
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 2. Scans — each photo analysis
CREATE TABLE IF NOT EXISTS scans (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES profiles(id) ON DELETE CASCADE,
  image_thumbnail TEXT,
  detected_gender TEXT,
  summary TEXT,
  items JSONB,
  tiers JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 3. Saved items — bookmarked products
CREATE TABLE IF NOT EXISTS saved_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES profiles(id) ON DELETE CASCADE,
  scan_id UUID REFERENCES scans(id) ON DELETE SET NULL,
  item_data JSONB,
  selected_tier TEXT,          -- budget | mid | premium
  tier_product JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 4. Affiliate clicks — revenue tracking
CREATE TABLE IF NOT EXISTS affiliate_clicks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES profiles(id) ON DELETE SET NULL,
  scan_id UUID REFERENCES scans(id) ON DELETE SET NULL,
  item_index INT,
  tier TEXT,                   -- budget | mid | premium
  retailer TEXT,
  product_url TEXT,
  affiliate_url TEXT,
  clicked_at TIMESTAMPTZ DEFAULT NOW()
);

-- 5. Ad events — impression/click/upgrade tracking
CREATE TABLE IF NOT EXISTS ad_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES profiles(id) ON DELETE SET NULL,
  ad_type TEXT,                -- interstitial | banner | native | upgrade_prompt
  ad_placement TEXT,           -- post_scan | results_banner | retailer_list | upgrade_modal
  action TEXT,                 -- impression | click | dismiss | upgrade_clicked
  revenue_estimate DECIMAL(10,4),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 6. Product cache — 24h TTL for SerpAPI results
CREATE TABLE IF NOT EXISTS product_cache (
  cache_key TEXT PRIMARY KEY,
  results JSONB,
  cached_at TIMESTAMPTZ DEFAULT NOW(),
  expires_at TIMESTAMPTZ DEFAULT NOW() + INTERVAL '24 hours'
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_scans_user_date ON scans(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_clicks_tier ON affiliate_clicks(tier);
CREATE INDEX IF NOT EXISTS idx_ad_events_user ON ad_events(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_ad_events_type ON ad_events(ad_type, action);
CREATE INDEX IF NOT EXISTS idx_product_cache_expires ON product_cache(expires_at);

-- ═══════════════════════════════════════════════════════════════
-- Row Level Security (RLS) Policies
-- ═══════════════════════════════════════════════════════════════

ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE scans ENABLE ROW LEVEL SECURITY;
ALTER TABLE saved_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE affiliate_clicks ENABLE ROW LEVEL SECURITY;
ALTER TABLE ad_events ENABLE ROW LEVEL SECURITY;

-- Profiles: users can read/update their own row
CREATE POLICY "Users can view own profile"
  ON profiles FOR SELECT USING (auth.uid() = id);
CREATE POLICY "Users can update own profile"
  ON profiles FOR UPDATE USING (auth.uid() = id);

-- Scans: users see their own scans
CREATE POLICY "Users can view own scans"
  ON scans FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users can insert own scans"
  ON scans FOR INSERT WITH CHECK (auth.uid() = user_id);

-- Saved items: users manage their own saved items
CREATE POLICY "Users can view own saved items"
  ON saved_items FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users can insert own saved items"
  ON saved_items FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can delete own saved items"
  ON saved_items FOR DELETE USING (auth.uid() = user_id);

-- Affiliate clicks: insert-only for users, read via service role
CREATE POLICY "Users can insert own clicks"
  ON affiliate_clicks FOR INSERT WITH CHECK (auth.uid() = user_id);

-- Ad events: insert-only for users
CREATE POLICY "Users can insert own ad events"
  ON ad_events FOR INSERT WITH CHECK (auth.uid() = user_id);

-- ═══════════════════════════════════════════════════════════════
-- Auto-create profile on signup (Supabase trigger)
-- ═══════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.profiles (id) VALUES (NEW.id);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();
