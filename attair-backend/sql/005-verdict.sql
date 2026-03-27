-- 005-verdict.sql: Add verdict column to scans table
-- Verdict replaces the 1-5 star rating with named verdicts

-- Add verdict enum type
DO $$ BEGIN
  CREATE TYPE scan_verdict AS ENUM ('would_wear', 'on_the_fence', 'not_for_me');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- Add verdict column to scans
ALTER TABLE scans ADD COLUMN IF NOT EXISTS verdict scan_verdict DEFAULT NULL;

-- Add index for filtering by verdict
CREATE INDEX IF NOT EXISTS idx_scans_verdict ON scans(user_id, verdict) WHERE verdict IS NOT NULL;

-- Comment
COMMENT ON COLUMN scans.verdict IS 'User verdict: would_wear, on_the_fence, not_for_me. Replaces numeric rating.';
