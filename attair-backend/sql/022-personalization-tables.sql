-- 022: Personalization tables for search algorithm v5
-- Phase 2: Per-category price sweet spots
-- Phase 4: Brand affinity with Bayesian confidence
-- Phase 5: Attribute affinity vectors
-- Phase 6: Affiliate partner registry

-- Per-category price modeling (Gaussian sweet spot)
CREATE TABLE IF NOT EXISTS user_price_profiles (
  user_id UUID REFERENCES profiles(id) ON DELETE CASCADE,
  category VARCHAR(50),
  sweet_spot FLOAT,
  std_dev FLOAT,
  hard_max FLOAT,
  sample_count INT DEFAULT 0,
  updated_at TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (user_id, category)
);

-- Brand affinity with Bayesian confidence scoring
CREATE TABLE IF NOT EXISTS user_brand_affinities (
  user_id UUID REFERENCES profiles(id) ON DELETE CASCADE,
  brand VARCHAR(200),
  positive_signals INT DEFAULT 0,
  negative_signals INT DEFAULT 0,
  total_exposures INT DEFAULT 0,
  affinity_score FLOAT DEFAULT 0.0,
  updated_at TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (user_id, brand)
);

-- Per-attribute affinity vectors (color, style, material, fit, category)
CREATE TABLE IF NOT EXISTS user_attribute_affinities (
  user_id UUID REFERENCES profiles(id) ON DELETE CASCADE,
  attribute_type VARCHAR(50),
  attribute_value VARCHAR(100),
  affinity_score FLOAT DEFAULT 0.0,
  interaction_count INT DEFAULT 0,
  last_updated TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (user_id, attribute_type, attribute_value)
);

-- Affiliate partner registry for monetization
CREATE TABLE IF NOT EXISTS affiliate_partners (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  domain VARCHAR(200) UNIQUE NOT NULL,
  partner_name VARCHAR(200),
  affiliate_tag VARCHAR(200),
  commission_rate FLOAT DEFAULT 0.0,
  link_template VARCHAR(500),
  is_active BOOLEAN DEFAULT true,
  priority INT DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_price_profiles_user ON user_price_profiles(user_id);
CREATE INDEX IF NOT EXISTS idx_brand_affinities_user ON user_brand_affinities(user_id);
CREATE INDEX IF NOT EXISTS idx_attr_affinities_user ON user_attribute_affinities(user_id);
CREATE INDEX IF NOT EXISTS idx_affiliate_partners_domain ON affiliate_partners(domain);
