-- 023: Content moderation fields for scans
ALTER TABLE scans ADD COLUMN IF NOT EXISTS moderated_at TIMESTAMPTZ DEFAULT NULL;
ALTER TABLE scans ADD COLUMN IF NOT EXISTS moderation_reason TEXT DEFAULT NULL;

-- Index for finding unmoderated public scans efficiently
CREATE INDEX IF NOT EXISTS idx_scans_unmoderated
  ON scans (created_at DESC)
  WHERE visibility = 'public' AND moderated_at IS NULL;
