-- 013b-challenge-rpcs.sql
-- RPC functions for atomic challenge vote counting

CREATE OR REPLACE FUNCTION increment_vote_count(sub_id UUID)
RETURNS void AS $$
BEGIN
  UPDATE challenge_submissions SET vote_count = vote_count + 1 WHERE id = sub_id;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION decrement_vote_count(sub_id UUID)
RETURNS void AS $$
BEGIN
  UPDATE challenge_submissions SET vote_count = GREATEST(0, vote_count - 1) WHERE id = sub_id;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION increment_challenge_wins(uid UUID)
RETURNS void AS $$
BEGIN
  UPDATE profiles SET challenge_wins = COALESCE(challenge_wins, 0) + 1 WHERE id = uid;
END;
$$ LANGUAGE plpgsql;
