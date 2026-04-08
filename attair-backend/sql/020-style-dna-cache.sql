-- 020: Add style_dna_cache column to profiles table
-- Required by style-twins feature to store computed style DNA vectors

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS style_dna_cache JSONB DEFAULT NULL;

-- Index for faster style twin matching (only non-null entries)
CREATE INDEX IF NOT EXISTS idx_profiles_style_dna_cache
  ON profiles (id)
  WHERE style_dna_cache IS NOT NULL;
