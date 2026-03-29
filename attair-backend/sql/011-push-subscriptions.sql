-- ═══════════════════════════════════════════════════════════
-- 011: Push notification subscriptions
-- ═══════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  endpoint TEXT NOT NULL,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, endpoint)
);

CREATE INDEX IF NOT EXISTS idx_push_subs_user ON push_subscriptions(user_id);

-- Notification preferences on profiles
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS notification_prefs JSONB DEFAULT '{
  "price_drops": true,
  "style_dna": true,
  "social_activity": true,
  "new_posts": true,
  "weekly_digest": true
}'::jsonb;

-- Notification log (for tracking what was sent)
CREATE TABLE IF NOT EXISTS notification_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  type TEXT NOT NULL,       -- price_drop, style_dna, social, new_post, digest
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  data JSONB DEFAULT '{}',  -- URL, scan_id, etc.
  sent_at TIMESTAMPTZ DEFAULT NOW(),
  read_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_notif_log_user ON notification_log(user_id);
CREATE INDEX IF NOT EXISTS idx_notif_log_user_unread ON notification_log(user_id) WHERE read_at IS NULL;

-- RLS
ALTER TABLE push_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY push_subs_select ON push_subscriptions FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY push_subs_insert ON push_subscriptions FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY push_subs_delete ON push_subscriptions FOR DELETE USING (auth.uid() = user_id);
CREATE POLICY notif_log_select ON notification_log FOR SELECT USING (auth.uid() = user_id);
