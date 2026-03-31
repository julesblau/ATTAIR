-- 015-outfit-of-the-week.sql
-- Outfit of the Week: AI editorial picks + weekly style report for Pro users.

-- ─── Weekly editorial table ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS outfit_of_the_week (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  week_start    DATE NOT NULL UNIQUE,          -- Monday of the week (ISO week)
  scan_ids      UUID[] NOT NULL DEFAULT '{}',   -- Top 10 trending scan IDs
  editorial     TEXT NOT NULL DEFAULT '',        -- Claude-written editorial caption
  headline      TEXT NOT NULL DEFAULT '',        -- Short punchy headline
  cover_image   TEXT,                            -- URL of the cover scan image
  generated_at  TIMESTAMPTZ DEFAULT now(),
  view_count    INTEGER DEFAULT 0
);

-- Index for quick current-week lookup
CREATE INDEX IF NOT EXISTS idx_ootw_week ON outfit_of_the_week (week_start DESC);

-- ─── Weekly style report tracking (Pro users) ────────────────────────
CREATE TABLE IF NOT EXISTS weekly_style_reports (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  week_start    DATE NOT NULL,
  scan_ids      UUID[] NOT NULL DEFAULT '{}',   -- 3 personalized look IDs
  sent_at       TIMESTAMPTZ DEFAULT now(),
  opened_at     TIMESTAMPTZ,
  UNIQUE(user_id, week_start)
);

CREATE INDEX IF NOT EXISTS idx_wsr_user_week ON weekly_style_reports (user_id, week_start DESC);

-- Add weekly_style_report to notification_prefs default for existing users
UPDATE profiles
SET notification_prefs = notification_prefs || '{"weekly_style_report": true}'::jsonb
WHERE notification_prefs IS NOT NULL
  AND NOT (notification_prefs ? 'weekly_style_report');

-- Update column default so new users get it automatically
ALTER TABLE profiles
ALTER COLUMN notification_prefs SET DEFAULT '{
  "price_drops": true,
  "style_dna": true,
  "social_activity": true,
  "new_posts": true,
  "weekly_digest": true,
  "weekly_style_report": true
}'::jsonb;

COMMENT ON TABLE outfit_of_the_week IS 'AI-curated weekly editorial picking top trending scans';
COMMENT ON TABLE weekly_style_reports IS 'Personalized weekly style report sent to Pro users on Sunday';
