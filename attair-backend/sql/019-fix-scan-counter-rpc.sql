-- Fix try_increment_scan: scans_today_reset is DATE but p_today is TEXT (YYYY-MM)
-- The old version compared date = text which caused a type error, silently breaking scan counting.
DROP FUNCTION IF EXISTS try_increment_scan(uuid, text, integer);
CREATE OR REPLACE FUNCTION try_increment_scan(p_user_id uuid, p_today text, p_limit int)
RETURNS int AS $$
DECLARE
  v_count INT;
  v_month TEXT;
BEGIN
  v_month := substring(p_today from 1 for 7);
  -- Reset if month changed (compare YYYY-MM of stored date vs current month)
  UPDATE profiles
  SET scans_today = 0, scans_today_reset = CURRENT_DATE
  WHERE id = p_user_id AND (scans_today_reset IS NULL OR to_char(scans_today_reset, 'YYYY-MM') IS DISTINCT FROM v_month);

  -- Atomically increment only if under limit
  UPDATE profiles
  SET scans_today = scans_today + 1
  WHERE id = p_user_id AND scans_today < p_limit
  RETURNING scans_today INTO v_count;

  RETURN COALESCE(v_count, 0);
END;
$$ LANGUAGE plpgsql;
