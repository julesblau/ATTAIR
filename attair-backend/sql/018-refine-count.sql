-- 018: Add refine_count to scans for tracking refinement usage
ALTER TABLE scans ADD COLUMN IF NOT EXISTS refine_count INT DEFAULT 0;
