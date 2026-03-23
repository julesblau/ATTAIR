-- ═══════════════════════════════════════════════════════════════
-- ATTAIR — Supabase SQL Migrations
-- Run these in the Supabase SQL Editor (Dashboard → SQL Editor)
-- ═══════════════════════════════════════════════════════════════

-- ─── Rating column on scans (Feature 15) ─────────────────────
ALTER TABLE scans ADD COLUMN IF NOT EXISTS rating INTEGER CHECK (rating BETWEEN 1 AND 5);

-- ─── Wishlists table (Feature 10) ────────────────────────────
CREATE TABLE IF NOT EXISTS wishlists (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE wishlists ENABLE ROW LEVEL SECURITY;

CREATE POLICY IF NOT EXISTS "Users manage own wishlists"
  ON wishlists FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- ─── wishlist_id on saved_items (Feature 10) ─────────────────
ALTER TABLE saved_items
  ADD COLUMN IF NOT EXISTS wishlist_id UUID
  REFERENCES wishlists(id) ON DELETE SET NULL;

-- ─── Index for faster wishlist queries ───────────────────────
CREATE INDEX IF NOT EXISTS idx_saved_items_wishlist ON saved_items(wishlist_id);
CREATE INDEX IF NOT EXISTS idx_wishlists_user ON wishlists(user_id);
