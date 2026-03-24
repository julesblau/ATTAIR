-- Migration 003: ensure columns added after initial schema are present on live databases.
-- All statements are idempotent (ADD COLUMN IF NOT EXISTS) — safe to re-run.

-- Add referral_code column if it doesn't exist
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS referral_code TEXT UNIQUE;

-- Add stripe_customer_id if missing
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS stripe_customer_id TEXT;

-- Add trial_ends_at if missing
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS trial_ends_at TIMESTAMPTZ;

-- Add upgrade_source if missing
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS upgrade_source TEXT;

-- ─── try_increment_scan ───────────────────────────────────────────────────────
-- Atomically increments the monthly scan counter and returns the new count.
-- p_today: YYYY-MM string (e.g. '2026-03') for monthly reset logic.
-- Returns 0 if the user is already at or above the limit.
-- Called by rateLimit.js incrementScanCount() to prevent race conditions.
CREATE OR REPLACE FUNCTION public.try_increment_scan(
  p_user_id UUID,
  p_today   TEXT,   -- YYYY-MM
  p_limit   INT
)
RETURNS INT
LANGUAGE plpgsql
AS $$
DECLARE
  v_count INT;
BEGIN
  -- Reset counter when the stored month is not the current month
  UPDATE profiles
  SET scans_today = 0, scans_today_reset = p_today
  WHERE id = p_user_id
    AND (scans_today_reset IS NULL OR scans_today_reset <> p_today);

  -- Atomically increment only when still under the monthly limit
  UPDATE profiles
  SET scans_today = scans_today + 1
  WHERE id = p_user_id
    AND scans_today < p_limit
  RETURNING scans_today INTO v_count;

  -- If the limit was already reached, no row is updated → return 0
  RETURN COALESCE(v_count, 0);
END;
$$;
