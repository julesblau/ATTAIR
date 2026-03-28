-- Migration 008: atomic saved_count helpers to prevent TOCTOU race condition.
-- Two functions replace the read-modify-write pattern in user.js.

-- ─── try_increment_saved_count ────────────────────────────────────────────────
-- Atomically increments saved_count only when the current value is below p_limit.
-- Returns the new saved_count, or NULL if the limit was already reached.
-- A NULL return means the caller should respond with 429.
CREATE OR REPLACE FUNCTION public.try_increment_saved_count(
  p_user_id UUID,
  p_limit   INT
)
RETURNS INT
LANGUAGE plpgsql
AS $$
DECLARE
  v_count INT;
BEGIN
  UPDATE profiles
  SET saved_count = saved_count + 1
  WHERE id = p_user_id
    AND saved_count < p_limit
  RETURNING saved_count INTO v_count;

  RETURN v_count;  -- NULL when limit was already reached
END;
$$;

-- ─── decrement_saved_count ────────────────────────────────────────────────────
-- Atomically decrements saved_count, clamping to zero.
-- Safe to call even when saved_count is already 0.
CREATE OR REPLACE FUNCTION public.decrement_saved_count(
  p_user_id UUID
)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE profiles
  SET saved_count = GREATEST(0, saved_count - 1)
  WHERE id = p_user_id;
END;
$$;
