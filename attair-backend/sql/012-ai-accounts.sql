-- ═══════════════════════════════════════════════════════════
-- 012: AI style accounts for seeded content
-- ═══════════════════════════════════════════════════════════

-- Flag to identify AI-managed accounts
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS is_ai BOOLEAN DEFAULT FALSE;

-- Track AI-generated content schedule
CREATE TABLE IF NOT EXISTS ai_content_queue (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ai_user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  content_data JSONB NOT NULL,   -- { image_url, summary, items, detected_gender }
  scheduled_at TIMESTAMPTZ NOT NULL,
  posted_at TIMESTAMPTZ,         -- null = not yet posted
  scan_id UUID REFERENCES scans(id) ON DELETE SET NULL,  -- set after posting
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ai_content_queue_scheduled
  ON ai_content_queue(scheduled_at) WHERE posted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_ai_content_queue_user
  ON ai_content_queue(ai_user_id);
