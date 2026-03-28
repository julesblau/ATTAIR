-- Migration 009: add is_private column to profiles for follower list privacy (HIGH-5).
-- Defaults to FALSE so existing users are treated as public (no breaking change).
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS is_private BOOLEAN NOT NULL DEFAULT FALSE;
