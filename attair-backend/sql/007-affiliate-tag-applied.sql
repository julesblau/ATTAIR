-- Add tag_applied column to affiliate_clicks for tracking monetization coverage
ALTER TABLE affiliate_clicks
  ADD COLUMN IF NOT EXISTS tag_applied boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN affiliate_clicks.tag_applied IS 'True when affiliate params were appended to the URL, false when passed through unmodified';
