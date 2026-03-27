-- ═══════════════════════════════════════════════════════════════
-- Migration 004: Social Features
-- All statements are idempotent — safe to re-run on any database state.
-- Run after 001-schema.sql, 002-functions.sql, 003-referral-code.sql.
-- ═══════════════════════════════════════════════════════════════

-- ─── follows table ────────────────────────────────────────────
-- Tracks user follow relationships. PRIMARY KEY on (follower_id, following_id)
-- serves as the UNIQUE constraint — one follow record per pair.
CREATE TABLE IF NOT EXISTS follows (
  follower_id  UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  following_id UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (follower_id, following_id)
);

CREATE INDEX IF NOT EXISTS idx_follows_follower  ON follows(follower_id);
CREATE INDEX IF NOT EXISTS idx_follows_following ON follows(following_id);

-- ─── visibility on scans ──────────────────────────────────────
ALTER TABLE scans ADD COLUMN IF NOT EXISTS visibility TEXT NOT NULL DEFAULT 'private';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_name = 'scans'
      AND constraint_name = 'scans_visibility_check'
  ) THEN
    ALTER TABLE scans
      ADD CONSTRAINT scans_visibility_check
      CHECK (visibility IN ('public', 'private', 'followers'));
  END IF;
END $$;

-- ─── visibility on saved_items ────────────────────────────────
ALTER TABLE saved_items ADD COLUMN IF NOT EXISTS visibility TEXT NOT NULL DEFAULT 'private';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_name = 'saved_items'
      AND constraint_name = 'saved_items_visibility_check'
  ) THEN
    ALTER TABLE saved_items
      ADD CONSTRAINT saved_items_visibility_check
      CHECK (visibility IN ('public', 'private'));
  END IF;
END $$;

-- ─── visibility on wishlists ──────────────────────────────────
-- wishlists table created in 001-schema.sql; visibility column may already exist.
ALTER TABLE wishlists ADD COLUMN IF NOT EXISTS visibility TEXT NOT NULL DEFAULT 'private';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_name = 'wishlists'
      AND constraint_name = 'wishlists_visibility_check'
  ) THEN
    ALTER TABLE wishlists
      ADD CONSTRAINT wishlists_visibility_check
      CHECK (visibility IN ('public', 'private'));
  END IF;
END $$;

-- ─── profile: bio (max 200 chars) ────────────────────────────
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS bio TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_name = 'profiles'
      AND constraint_name = 'profiles_bio_length_check'
  ) THEN
    ALTER TABLE profiles
      ADD CONSTRAINT profiles_bio_length_check
      CHECK (char_length(bio) <= 200);
  END IF;
END $$;

-- ─── profile: display_name (max 50 chars) ────────────────────
-- Column already present in the initial CREATE TABLE in 001-schema.sql.
-- The ADD COLUMN IF NOT EXISTS is a no-op when it already exists.
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS display_name TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_name = 'profiles'
      AND constraint_name = 'profiles_display_name_length_check'
  ) THEN
    ALTER TABLE profiles
      ADD CONSTRAINT profiles_display_name_length_check
      CHECK (char_length(display_name) <= 50);
  END IF;
END $$;

-- ─── profile: style_interests (JSONB array) ───────────────────
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS style_interests JSONB DEFAULT '[]'::jsonb;

-- ─── RLS policies for follows ────────────────────────────────
ALTER TABLE follows ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'follows' AND policyname = 'Users can manage own follows'
  ) THEN
    EXECUTE 'CREATE POLICY "Users can manage own follows"
      ON follows
      USING (auth.uid() = follower_id)
      WITH CHECK (auth.uid() = follower_id)';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'follows' AND policyname = 'Users can view all follows'
  ) THEN
    EXECUTE 'CREATE POLICY "Users can view all follows"
      ON follows FOR SELECT
      USING (true)';
  END IF;
END $$;
