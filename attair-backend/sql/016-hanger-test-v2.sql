-- ═══════════════════════════════════════════════════════════════
-- Hanger Test v2 — 5-outfit daily cadence + taste profiles
-- ═══════════════════════════════════════════════════════════════

-- 1. Allow multiple outfits per day (was UNIQUE on active_date)
ALTER TABLE hanger_outfits DROP CONSTRAINT IF EXISTS hanger_outfits_active_date_key;
ALTER TABLE hanger_outfits ADD COLUMN IF NOT EXISTS batch_position INT DEFAULT 1;
ALTER TABLE hanger_outfits ADD COLUMN IF NOT EXISTS style_archetype TEXT;
ALTER TABLE hanger_outfits ADD CONSTRAINT hanger_outfits_date_position_unique UNIQUE (active_date, batch_position);

-- 2. Taste profile table
CREATE TABLE IF NOT EXISTS hanger_taste_profiles (
  user_id         UUID PRIMARY KEY REFERENCES profiles(id) ON DELETE CASCADE,
  style_breakdown JSONB DEFAULT '[]',
  archetype       TEXT,
  favorite_vibes  TEXT[] DEFAULT '{}',
  avoid_vibes     TEXT[] DEFAULT '{}',
  wear_rate       NUMERIC(5,2) DEFAULT 0,
  total_votes     INT DEFAULT 0,
  last_computed   TIMESTAMPTZ DEFAULT NOW(),
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- 3. Cadence tracking on streaks
ALTER TABLE hanger_streaks ADD COLUMN IF NOT EXISTS cadence_date DATE;
ALTER TABLE hanger_streaks ADD COLUMN IF NOT EXISTS cadence_votes_today INT DEFAULT 0;

-- 4. Hanger taste cache on profiles (for feed/search integration)
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS hanger_taste_cache JSONB DEFAULT NULL;

-- 5. Voter archetype tracking
ALTER TABLE hanger_votes ADD COLUMN IF NOT EXISTS voter_archetype TEXT;

-- 6. Updated record_hanger_vote with cadence + archetype support
CREATE OR REPLACE FUNCTION record_hanger_vote(
  p_user_id     UUID,
  p_outfit_id   UUID,
  p_verdict     TEXT,
  p_voter_archetype TEXT DEFAULT NULL
) RETURNS JSONB AS $$
DECLARE
  v_streak RECORD;
  v_today DATE := CURRENT_DATE;
  v_new_streak INT;
  v_new_longest INT;
  v_wear_count INT;
  v_pass_count INT;
  v_total_votes INT;
  v_cadence_votes INT;
  v_earned_insight BOOLEAN := FALSE;
  v_earned_badge BOOLEAN := FALSE;
BEGIN
  -- Insert vote (will fail on duplicate via UNIQUE(user_id, outfit_id))
  INSERT INTO hanger_votes (user_id, outfit_id, verdict, voter_archetype)
  VALUES (p_user_id, p_outfit_id, p_verdict, p_voter_archetype);

  -- Update outfit counts
  IF p_verdict = 'wear' THEN
    UPDATE hanger_outfits SET wear_count = wear_count + 1 WHERE id = p_outfit_id;
  ELSE
    UPDATE hanger_outfits SET pass_count = pass_count + 1 WHERE id = p_outfit_id;
  END IF;

  SELECT wear_count, pass_count INTO v_wear_count, v_pass_count
  FROM hanger_outfits WHERE id = p_outfit_id;

  -- Get or create streak record
  SELECT * INTO v_streak FROM hanger_streaks WHERE user_id = p_user_id;

  IF NOT FOUND THEN
    INSERT INTO hanger_streaks (user_id, current_streak, longest_streak, last_vote_date, total_votes, cadence_date, cadence_votes_today)
    VALUES (p_user_id, 1, 1, v_today, 1, v_today, 1);
    v_new_streak := 1;
    v_new_longest := 1;
    v_total_votes := 1;
    v_cadence_votes := 1;
  ELSE
    v_total_votes := v_streak.total_votes + 1;

    -- Cadence tracking: reset if new day
    IF v_streak.cadence_date = v_today THEN
      v_cadence_votes := v_streak.cadence_votes_today + 1;
    ELSE
      v_cadence_votes := 1;
    END IF;

    -- Streak: only update on FIRST vote of the day
    IF v_streak.last_vote_date = v_today THEN
      -- Already voted today, keep streak as-is
      v_new_streak := v_streak.current_streak;
    ELSIF v_streak.last_vote_date = v_today - 1 THEN
      -- Consecutive day
      v_new_streak := v_streak.current_streak + 1;
    ELSE
      -- Streak broken
      v_new_streak := 1;
    END IF;

    v_new_longest := GREATEST(v_streak.longest_streak, v_new_streak);

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
      cadence_date = v_today,
      cadence_votes_today = v_cadence_votes,
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
    'cadence_votes_today', v_cadence_votes,
    'earned_insight', v_earned_insight,
    'earned_badge', v_earned_badge
  );
END;
$$ LANGUAGE plpgsql;

-- 7. Tranche stats RPC
CREATE OR REPLACE FUNCTION get_hanger_tranche_stats(
  p_outfit_id  UUID,
  p_archetype  TEXT
) RETURNS JSONB AS $$
DECLARE
  v_global RECORD;
  v_tranche RECORD;
  v_global_total INT;
  v_tranche_total INT;
BEGIN
  SELECT wear_count, pass_count INTO v_global FROM hanger_outfits WHERE id = p_outfit_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  v_global_total := v_global.wear_count + v_global.pass_count;

  SELECT
    COUNT(*) FILTER (WHERE verdict = 'wear') AS wear,
    COUNT(*) AS total
  INTO v_tranche
  FROM hanger_votes
  WHERE outfit_id = p_outfit_id AND voter_archetype = p_archetype;

  v_tranche_total := COALESCE(v_tranche.total, 0);

  RETURN jsonb_build_object(
    'global_wear_pct', CASE WHEN v_global_total > 0 THEN ROUND((v_global.wear_count::NUMERIC / v_global_total) * 100) ELSE 50 END,
    'global_total', v_global_total,
    'tranche_wear_pct', CASE WHEN v_tranche_total > 0 THEN ROUND((v_tranche.wear::NUMERIC / v_tranche_total) * 100) ELSE NULL END,
    'tranche_total', v_tranche_total,
    'tranche_archetype', p_archetype
  );
END;
$$ LANGUAGE plpgsql;
