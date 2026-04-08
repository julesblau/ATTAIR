-- 017: Add missing index on saved_items for user queries
-- saved_items is frequently queried by user_id with ORDER BY created_at DESC
-- (user.js:611, social.js:273) but only had an index on wishlist_id

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_saved_items_user_date
  ON saved_items(user_id, created_at DESC);
