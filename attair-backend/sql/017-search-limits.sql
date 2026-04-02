-- 017-search-limits.sql
-- Add search usage tracking columns to profiles for free-tier limits:
--   Deep Search: 3 per week
--   Fast Search: 12 per month

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS extended_searches_count INT DEFAULT 0,
  ADD COLUMN IF NOT EXISTS extended_searches_week  DATE DEFAULT CURRENT_DATE,
  ADD COLUMN IF NOT EXISTS fast_searches_count     INT DEFAULT 0,
  ADD COLUMN IF NOT EXISTS fast_searches_month     DATE DEFAULT CURRENT_DATE;
