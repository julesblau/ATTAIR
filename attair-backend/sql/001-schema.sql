-- ═══════════════════════════════════════════════════════════════
-- ATTAIR Database Schema  (source of truth — matches live Supabase)
-- Run this in Supabase SQL Editor to create a fresh database.
-- For migrations on an existing database see the ALTER TABLE
-- statements at the bottom of this file.
-- ═══════════════════════════════════════════════════════════════

-- 1. Profiles — extends Supabase auth.users
CREATE TABLE IF NOT EXISTS profiles (
  id                    UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  display_name          TEXT,
  phone                 TEXT,
  avatar_url            TEXT,
  gender_pref           TEXT DEFAULT 'both',
  budget_pref           TEXT DEFAULT 'mid',
  budget_min            INT  DEFAULT 50,
  budget_max            INT  DEFAULT 100,
  size_prefs            JSONB DEFAULT '{}'::jsonb,   -- { body_type, fit, sizes: { tops, bottoms, shoes, ... } }
  tier                  TEXT DEFAULT 'free',         -- free | trial | pro | expired
  subscription_provider TEXT,                        -- stripe | revenuecat
  subscription_id       TEXT,
  trial_ends_at         TIMESTAMPTZ,
  scans_today           INT  DEFAULT 0,
  scans_today_reset     DATE DEFAULT CURRENT_DATE,
  saved_count           INT  DEFAULT 0,
  referral_code         TEXT UNIQUE,
  referred_by           UUID REFERENCES profiles(id),
  upgrade_source        TEXT,                        -- ad_fatigue | scan_limit | paywall | referral
  created_at            TIMESTAMPTZ DEFAULT NOW()
);

-- 2. Scans — each photo analysis
CREATE TABLE IF NOT EXISTS scans (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          UUID REFERENCES profiles(id) ON DELETE CASCADE,
  scan_name        TEXT,
  image_thumbnail  TEXT,
  image_url        TEXT,
  detected_gender  TEXT,
  summary          TEXT,
  items            JSONB,
  tiers            JSONB,
  created_at       TIMESTAMPTZ DEFAULT NOW()
);

-- 3. Saved items — bookmarked products
CREATE TABLE IF NOT EXISTS saved_items (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID REFERENCES profiles(id) ON DELETE CASCADE,
  scan_id        UUID REFERENCES scans(id) ON DELETE SET NULL,
  item_data      JSONB,
  selected_tier  TEXT,          -- budget | mid | premium
  tier_product   JSONB,
  created_at     TIMESTAMPTZ DEFAULT NOW()
);

-- 4. Affiliate clicks — revenue tracking
CREATE TABLE IF NOT EXISTS affiliate_clicks (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID REFERENCES profiles(id) ON DELETE SET NULL,
  scan_id       UUID REFERENCES scans(id) ON DELETE SET NULL,
  item_index    INT,
  tier          TEXT,           -- budget | mid | premium
  retailer      TEXT,
  product_url   TEXT,
  affiliate_url TEXT,
  clicked_at    TIMESTAMPTZ DEFAULT NOW()
);

-- 5. Ad events — impression/click/upgrade tracking
CREATE TABLE IF NOT EXISTS ad_events (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          UUID REFERENCES profiles(id) ON DELETE SET NULL,
  ad_type          TEXT,        -- interstitial | banner | native | upgrade_prompt
  ad_placement     TEXT,        -- post_scan | results_banner | retailer_list | upgrade_modal
  action           TEXT,        -- impression | click | dismiss | upgrade_clicked
  revenue_estimate DECIMAL(10,4),
  created_at       TIMESTAMPTZ DEFAULT NOW()
);

-- 6. Product cache — 24h TTL for SerpAPI results
CREATE TABLE IF NOT EXISTS product_cache (
  cache_key  TEXT PRIMARY KEY,
  results    JSONB,
  cached_at  TIMESTAMPTZ DEFAULT NOW(),
  expires_at TIMESTAMPTZ DEFAULT NOW() + INTERVAL '24 hours'
);

-- ─── Indexes ──────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_scans_user_date      ON scans(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_clicks_tier          ON affiliate_clicks(tier);
CREATE INDEX IF NOT EXISTS idx_ad_events_user       ON ad_events(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_ad_events_type       ON ad_events(ad_type, action);
CREATE INDEX IF NOT EXISTS idx_product_cache_expires ON product_cache(expires_at);

-- ═══════════════════════════════════════════════════════════════
-- Row Level Security
-- ═══════════════════════════════════════════════════════════════

ALTER TABLE profiles       ENABLE ROW LEVEL SECURITY;
ALTER TABLE scans          ENABLE ROW LEVEL SECURITY;
ALTER TABLE saved_items    ENABLE ROW LEVEL SECURITY;
ALTER TABLE affiliate_clicks ENABLE ROW LEVEL SECURITY;
ALTER TABLE ad_events      ENABLE ROW LEVEL SECURITY;
-- SECURITY: product_cache has no RLS policies defined here. The backend accesses it only via the
-- service-role client (which bypasses RLS), so no anon/authenticated client can read or write it
-- directly. If you ever enable direct client access, add restrictive policies or keep it
-- service-role-only. Current state is safe as long as the service role key stays server-side.
-- SECURITY: wishlists table is defined in migrations but has no RLS policies in this file.
-- Ensure the following policies exist in Supabase or add them here:
--   CREATE POLICY "Users can manage own wishlists" ON wishlists USING (auth.uid() = user_id);
-- The backend enforces user_id scoping in every query, but belt-and-suspenders RLS is required.

-- Profiles
CREATE POLICY "Users can view own profile"   ON profiles FOR SELECT USING (auth.uid() = id);
CREATE POLICY "Users can update own profile" ON profiles FOR UPDATE USING (auth.uid() = id);

-- Scans
CREATE POLICY "Users can view own scans"   ON scans FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users can insert own scans" ON scans FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can update own scans" ON scans FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "Users can delete own scans" ON scans FOR DELETE USING (auth.uid() = user_id);

-- Saved items
CREATE POLICY "Users can view own saved items"   ON saved_items FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users can insert own saved items" ON saved_items FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can delete own saved items" ON saved_items FOR DELETE USING (auth.uid() = user_id);

-- Affiliate clicks: insert-only for users, read via service role
CREATE POLICY "Users can insert own clicks" ON affiliate_clicks FOR INSERT WITH CHECK (auth.uid() = user_id);

-- Ad events: insert-only for users
CREATE POLICY "Users can insert own ad events" ON ad_events FOR INSERT WITH CHECK (auth.uid() = user_id);

-- ═══════════════════════════════════════════════════════════════
-- Migrations — run these on existing databases
-- (safe to re-run; IF NOT EXISTS / idempotent guards)
-- ═══════════════════════════════════════════════════════════════

-- size_prefs column added for personalised search results
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS size_prefs JSONB DEFAULT '{}'::jsonb;

-- stripe_customer_id: stored on checkout.session.completed so subscription.deleted
-- and invoice.payment_failed webhooks can look up the profile and downgrade the user.
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS stripe_customer_id TEXT;
