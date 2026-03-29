-- ═══════════════════════════════════════════════════════════════
-- Hanger Test — Daily Outfit Verdict Habit
-- Tables: hanger_outfits, hanger_votes, hanger_streaks
-- ═══════════════════════════════════════════════════════════════

-- 1. Daily outfit that users vote on
CREATE TABLE IF NOT EXISTS hanger_outfits (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  image_url       TEXT NOT NULL,
  description     TEXT NOT NULL,
  style_tags      TEXT[] DEFAULT '{}',
  source_scan_id  UUID REFERENCES scans(id) ON DELETE SET NULL,
  source_type     TEXT DEFAULT 'scan',  -- 'scan' or 'curated'
  active_date     DATE NOT NULL UNIQUE, -- one outfit per day
  wear_count      INT DEFAULT 0,
  pass_count      INT DEFAULT 0,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_hanger_outfits_active_date ON hanger_outfits(active_date DESC);

-- 2. Individual user votes
CREATE TABLE IF NOT EXISTS hanger_votes (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  outfit_id   UUID NOT NULL REFERENCES hanger_outfits(id) ON DELETE CASCADE,
  verdict     TEXT NOT NULL CHECK (verdict IN ('wear', 'pass')),
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, outfit_id)
);

CREATE INDEX IF NOT EXISTS idx_hanger_votes_user ON hanger_votes(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_hanger_votes_outfit ON hanger_votes(outfit_id);

-- 3. Streak tracking per user
CREATE TABLE IF NOT EXISTS hanger_streaks (
  user_id         UUID PRIMARY KEY REFERENCES profiles(id) ON DELETE CASCADE,
  current_streak  INT DEFAULT 0,
  longest_streak  INT DEFAULT 0,
  last_vote_date  DATE,
  total_votes     INT DEFAULT 0,
  style_insight   TEXT,            -- Claude-generated insight at 7-day streak
  taste_badge     BOOLEAN DEFAULT FALSE, -- earned at 30-day streak
  insight_count   INT DEFAULT 0,   -- how many insights generated (first is free)
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- 4. RPC: atomic vote + streak update
CREATE OR REPLACE FUNCTION record_hanger_vote(
  p_user_id  UUID,
  p_outfit_id UUID,
  p_verdict  TEXT
) RETURNS JSONB AS $$
DECLARE
  v_streak RECORD;
  v_today DATE := CURRENT_DATE;
  v_new_streak INT;
  v_new_longest INT;
  v_wear_count INT;
  v_pass_count INT;
  v_total_votes INT;
  v_earned_insight BOOLEAN := FALSE;
  v_earned_badge BOOLEAN := FALSE;
BEGIN
  -- Insert vote (will fail on duplicate)
  INSERT INTO hanger_votes (user_id, outfit_id, verdict)
  VALUES (p_user_id, p_outfit_id, p_verdict);

  -- Update outfit counts
  IF p_verdict = 'wear' THEN
    UPDATE hanger_outfits SET wear_count = wear_count + 1 WHERE id = p_outfit_id;
  ELSE
    UPDATE hanger_outfits SET pass_count = pass_count + 1 WHERE id = p_outfit_id;
  END IF;

  -- Get current counts
  SELECT wear_count, pass_count INTO v_wear_count, v_pass_count
  FROM hanger_outfits WHERE id = p_outfit_id;

  -- Get or create streak record
  SELECT * INTO v_streak FROM hanger_streaks WHERE user_id = p_user_id;

  IF NOT FOUND THEN
    INSERT INTO hanger_streaks (user_id, current_streak, longest_streak, last_vote_date, total_votes)
    VALUES (p_user_id, 1, 1, v_today, 1);
    v_new_streak := 1;
    v_new_longest := 1;
    v_total_votes := 1;
  ELSE
    -- Calculate new streak
    IF v_streak.last_vote_date = v_today - 1 THEN
      -- Consecutive day
      v_new_streak := v_streak.current_streak + 1;
    ELSIF v_streak.last_vote_date = v_today THEN
      -- Already voted today (shouldn't happen due to unique constraint, but handle it)
      v_new_streak := v_streak.current_streak;
    ELSE
      -- Streak broken
      v_new_streak := 1;
    END IF;

    v_new_longest := GREATEST(v_streak.longest_streak, v_new_streak);
    v_total_votes := v_streak.total_votes + 1;

    -- Check milestones
    IF v_new_streak = 7 AND v_streak.current_streak < 7 THEN
      v_earned_insight := TRUE;
    END IF;
    IF v_new_streak >= 30 AND NOT v_streak.taste_badge THEN
      v_earned_badge := TRUE;
    END IF;

    UPDATE hanger_streaks SET
      current_streak = v_new_streak,
      longest_streak = v_new_longest,
      last_vote_date = v_today,
      total_votes = v_total_votes,
      taste_badge = CASE WHEN v_earned_badge THEN TRUE ELSE taste_badge END,
      updated_at = NOW()
    WHERE user_id = p_user_id;
  END IF;

  RETURN jsonb_build_object(
    'wear_count', v_wear_count,
    'pass_count', v_pass_count,
    'current_streak', v_new_streak,
    'longest_streak', v_new_longest,
    'total_votes', v_total_votes,
    'earned_insight', v_earned_insight,
    'earned_badge', v_earned_badge
  );
END;
$$ LANGUAGE plpgsql;

-- 5. RPC: get vote percentages for an outfit
CREATE OR REPLACE FUNCTION get_hanger_stats(p_outfit_id UUID)
RETURNS JSONB AS $$
DECLARE
  v_outfit RECORD;
  v_total INT;
  v_wear_pct NUMERIC;
BEGIN
  SELECT wear_count, pass_count INTO v_outfit
  FROM hanger_outfits WHERE id = p_outfit_id;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  v_total := v_outfit.wear_count + v_outfit.pass_count;
  v_wear_pct := CASE WHEN v_total > 0 THEN ROUND((v_outfit.wear_count::NUMERIC / v_total) * 100) ELSE 50 END;

  RETURN jsonb_build_object(
    'wear_count', v_outfit.wear_count,
    'pass_count', v_outfit.pass_count,
    'total_votes', v_total,
    'wear_pct', v_wear_pct,
    'pass_pct', 100 - v_wear_pct
  );
END;
$$ LANGUAGE plpgsql;
