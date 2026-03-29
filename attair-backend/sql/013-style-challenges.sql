-- 013-style-challenges.sql
-- Style Challenges: weekly outfit contests with AI verification + voting

-- Challenges table (one per week)
CREATE TABLE IF NOT EXISTS style_challenges (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title            TEXT NOT NULL,                -- e.g., "Monochrome Monday"
  description      TEXT,                         -- Brief rules/theme description
  theme_tags       TEXT[] DEFAULT '{}',          -- AI verification tags: ["monochrome", "single color"]
  starts_at        TIMESTAMPTZ NOT NULL,
  ends_at          TIMESTAMPTZ NOT NULL,
  status           TEXT DEFAULT 'active',        -- active | voting | completed
  winner_id        UUID REFERENCES profiles(id), -- winner after voting ends
  created_at       TIMESTAMPTZ DEFAULT NOW()
);

-- Challenge submissions (one per user per challenge)
CREATE TABLE IF NOT EXISTS challenge_submissions (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  challenge_id     UUID NOT NULL REFERENCES style_challenges(id) ON DELETE CASCADE,
  user_id          UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  scan_id          UUID REFERENCES scans(id),    -- linked scan (optional)
  image_url        TEXT NOT NULL,
  caption          TEXT,
  ai_verified      BOOLEAN DEFAULT false,        -- true if AI says it matches theme
  ai_feedback      TEXT,                          -- AI's feedback on the submission
  vote_count       INTEGER DEFAULT 0,
  created_at       TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(challenge_id, user_id)                  -- one submission per user per challenge
);

-- Votes (one per user per submission)
CREATE TABLE IF NOT EXISTS challenge_votes (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  submission_id    UUID NOT NULL REFERENCES challenge_submissions(id) ON DELETE CASCADE,
  voter_id         UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  created_at       TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(submission_id, voter_id)                -- one vote per user per submission
);

-- Winner badges on profiles
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS challenge_wins INTEGER DEFAULT 0;

-- Indexes for common queries
CREATE INDEX IF NOT EXISTS idx_challenges_status ON style_challenges(status);
CREATE INDEX IF NOT EXISTS idx_challenges_ends_at ON style_challenges(ends_at);
CREATE INDEX IF NOT EXISTS idx_submissions_challenge ON challenge_submissions(challenge_id);
CREATE INDEX IF NOT EXISTS idx_submissions_user ON challenge_submissions(user_id);
CREATE INDEX IF NOT EXISTS idx_votes_submission ON challenge_votes(submission_id);
CREATE INDEX IF NOT EXISTS idx_votes_voter ON challenge_votes(voter_id);
