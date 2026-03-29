/**
 * ATTAIR Style Match Score Engine
 *
 * Computes a 0-100% compatibility score for each product against the user's
 * Style DNA profile and preference signals. Used to show "92% your style"
 * pills on product cards.
 *
 * Scoring weights:
 *   50% — Style archetype overlap (classic/trendy, minimal/maximal, etc.)
 *   30% — Price tier alignment
 *   20% — Category & brand preference
 *
 * When no Style DNA exists, falls back to preference-only scoring.
 * When neither exists, returns null (frontend shows "New to you").
 */

// ─── Style archetype keyword mapping ────────────────────────
// Maps product title/description keywords to style axis positions.
// Each axis is 1-10 (matching Style DNA's style_score format):
//   classic_vs_trendy:  1=classic, 10=trendy
//   minimal_vs_maximal: 1=minimal, 10=maximal
//   casual_vs_formal:   1=casual, 10=formal
//   budget_vs_luxury:   1=budget, 10=luxury

const STYLE_SIGNALS = {
  // Classic signals (low classic_vs_trendy)
  classic: { classic_vs_trendy: 2, minimal_vs_maximal: 4 },
  timeless: { classic_vs_trendy: 2, minimal_vs_maximal: 3 },
  traditional: { classic_vs_trendy: 1, minimal_vs_maximal: 4 },
  preppy: { classic_vs_trendy: 3, casual_vs_formal: 6 },
  heritage: { classic_vs_trendy: 2, budget_vs_luxury: 7 },
  tailored: { classic_vs_trendy: 3, casual_vs_formal: 7, minimal_vs_maximal: 3 },

  // Trendy signals (high classic_vs_trendy)
  trendy: { classic_vs_trendy: 9, minimal_vs_maximal: 7 },
  streetwear: { classic_vs_trendy: 8, casual_vs_formal: 2, minimal_vs_maximal: 7 },
  "y2k": { classic_vs_trendy: 9, minimal_vs_maximal: 8 },
  oversized: { classic_vs_trendy: 7, casual_vs_formal: 2 },
  distressed: { classic_vs_trendy: 8, casual_vs_formal: 2 },
  graphic: { classic_vs_trendy: 8, minimal_vs_maximal: 8 },
  vintage: { classic_vs_trendy: 6, minimal_vs_maximal: 5 },
  retro: { classic_vs_trendy: 6, minimal_vs_maximal: 6 },

  // Minimal signals (low minimal_vs_maximal)
  minimal: { minimal_vs_maximal: 2, classic_vs_trendy: 5 },
  minimalist: { minimal_vs_maximal: 1, classic_vs_trendy: 5 },
  clean: { minimal_vs_maximal: 2 },
  simple: { minimal_vs_maximal: 2 },
  neutral: { minimal_vs_maximal: 2, classic_vs_trendy: 4 },
  basic: { minimal_vs_maximal: 2, casual_vs_formal: 3 },
  understated: { minimal_vs_maximal: 2, budget_vs_luxury: 6 },
  sleek: { minimal_vs_maximal: 2, casual_vs_formal: 6 },
  monochrome: { minimal_vs_maximal: 2 },

  // Maximal signals (high minimal_vs_maximal)
  bold: { minimal_vs_maximal: 8 },
  statement: { minimal_vs_maximal: 9 },
  colorful: { minimal_vs_maximal: 8 },
  printed: { minimal_vs_maximal: 7 },
  embellished: { minimal_vs_maximal: 9, budget_vs_luxury: 7 },
  embroidered: { minimal_vs_maximal: 7, budget_vs_luxury: 6 },
  sequin: { minimal_vs_maximal: 9, casual_vs_formal: 8 },
  neon: { minimal_vs_maximal: 9, classic_vs_trendy: 8 },
  floral: { minimal_vs_maximal: 7, classic_vs_trendy: 4 },
  plaid: { minimal_vs_maximal: 6, classic_vs_trendy: 3 },
  striped: { minimal_vs_maximal: 5, classic_vs_trendy: 4 },

  // Casual signals (low casual_vs_formal)
  casual: { casual_vs_formal: 2 },
  relaxed: { casual_vs_formal: 2, minimal_vs_maximal: 3 },
  lounge: { casual_vs_formal: 1 },
  athleisure: { casual_vs_formal: 2, classic_vs_trendy: 6 },
  athletic: { casual_vs_formal: 1, classic_vs_trendy: 5 },
  sporty: { casual_vs_formal: 2, classic_vs_trendy: 6 },
  denim: { casual_vs_formal: 3 },
  hoodie: { casual_vs_formal: 1, classic_vs_trendy: 5 },
  sneaker: { casual_vs_formal: 2, classic_vs_trendy: 6 },
  jogger: { casual_vs_formal: 1 },

  // Formal signals (high casual_vs_formal)
  formal: { casual_vs_formal: 9 },
  elegant: { casual_vs_formal: 8, minimal_vs_maximal: 4 },
  evening: { casual_vs_formal: 8, minimal_vs_maximal: 6 },
  cocktail: { casual_vs_formal: 8 },
  "black tie": { casual_vs_formal: 10, budget_vs_luxury: 8 },
  suit: { casual_vs_formal: 8, classic_vs_trendy: 3 },
  blazer: { casual_vs_formal: 7, classic_vs_trendy: 4 },
  silk: { casual_vs_formal: 7, budget_vs_luxury: 7 },
  satin: { casual_vs_formal: 7, budget_vs_luxury: 6 },

  // Budget signals (low budget_vs_luxury)
  budget: { budget_vs_luxury: 1 },
  affordable: { budget_vs_luxury: 2 },
  value: { budget_vs_luxury: 2 },
  everyday: { budget_vs_luxury: 3, casual_vs_formal: 3 },

  // Luxury signals (high budget_vs_luxury)
  luxury: { budget_vs_luxury: 9 },
  designer: { budget_vs_luxury: 9 },
  premium: { budget_vs_luxury: 8 },
  leather: { budget_vs_luxury: 7, classic_vs_trendy: 4 },
  cashmere: { budget_vs_luxury: 8, classic_vs_trendy: 3 },
  couture: { budget_vs_luxury: 10, casual_vs_formal: 9 },
  "hand-made": { budget_vs_luxury: 8 },
  handmade: { budget_vs_luxury: 8 },
  "italian": { budget_vs_luxury: 7 },
};

// ─── Brand → style axis mapping (well-known brands) ─────────
const BRAND_STYLE = {
  // Streetwear/trendy
  "supreme": { classic_vs_trendy: 9, casual_vs_formal: 2, minimal_vs_maximal: 7, budget_vs_luxury: 7 },
  "off-white": { classic_vs_trendy: 9, casual_vs_formal: 3, minimal_vs_maximal: 7, budget_vs_luxury: 9 },
  "stussy": { classic_vs_trendy: 8, casual_vs_formal: 2, minimal_vs_maximal: 6, budget_vs_luxury: 5 },
  "palace": { classic_vs_trendy: 8, casual_vs_formal: 2, minimal_vs_maximal: 7, budget_vs_luxury: 6 },

  // Minimalist
  "cos": { classic_vs_trendy: 5, minimal_vs_maximal: 2, casual_vs_formal: 5, budget_vs_luxury: 5 },
  "uniqlo": { classic_vs_trendy: 4, minimal_vs_maximal: 2, casual_vs_formal: 4, budget_vs_luxury: 3 },
  "muji": { classic_vs_trendy: 3, minimal_vs_maximal: 1, casual_vs_formal: 4, budget_vs_luxury: 4 },
  "everlane": { classic_vs_trendy: 4, minimal_vs_maximal: 2, casual_vs_formal: 4, budget_vs_luxury: 4 },
  "the row": { classic_vs_trendy: 4, minimal_vs_maximal: 1, casual_vs_formal: 6, budget_vs_luxury: 10 },

  // Luxury
  "gucci": { classic_vs_trendy: 7, minimal_vs_maximal: 8, casual_vs_formal: 6, budget_vs_luxury: 10 },
  "louis vuitton": { classic_vs_trendy: 6, minimal_vs_maximal: 7, casual_vs_formal: 6, budget_vs_luxury: 10 },
  "prada": { classic_vs_trendy: 6, minimal_vs_maximal: 5, casual_vs_formal: 7, budget_vs_luxury: 10 },
  "chanel": { classic_vs_trendy: 4, minimal_vs_maximal: 5, casual_vs_formal: 8, budget_vs_luxury: 10 },
  "hermes": { classic_vs_trendy: 3, minimal_vs_maximal: 4, casual_vs_formal: 7, budget_vs_luxury: 10 },
  "dior": { classic_vs_trendy: 5, minimal_vs_maximal: 6, casual_vs_formal: 7, budget_vs_luxury: 10 },
  "balenciaga": { classic_vs_trendy: 9, minimal_vs_maximal: 7, casual_vs_formal: 4, budget_vs_luxury: 10 },
  "bottega veneta": { classic_vs_trendy: 5, minimal_vs_maximal: 3, casual_vs_formal: 6, budget_vs_luxury: 10 },
  "saint laurent": { classic_vs_trendy: 6, minimal_vs_maximal: 4, casual_vs_formal: 7, budget_vs_luxury: 10 },
  "versace": { classic_vs_trendy: 7, minimal_vs_maximal: 9, casual_vs_formal: 7, budget_vs_luxury: 10 },

  // Classic
  "ralph lauren": { classic_vs_trendy: 2, minimal_vs_maximal: 4, casual_vs_formal: 6, budget_vs_luxury: 7 },
  "brooks brothers": { classic_vs_trendy: 1, minimal_vs_maximal: 3, casual_vs_formal: 8, budget_vs_luxury: 7 },
  "burberry": { classic_vs_trendy: 4, minimal_vs_maximal: 5, casual_vs_formal: 6, budget_vs_luxury: 9 },
  "j. crew": { classic_vs_trendy: 3, minimal_vs_maximal: 4, casual_vs_formal: 5, budget_vs_luxury: 5 },
  "j.crew": { classic_vs_trendy: 3, minimal_vs_maximal: 4, casual_vs_formal: 5, budget_vs_luxury: 5 },
  "banana republic": { classic_vs_trendy: 3, minimal_vs_maximal: 3, casual_vs_formal: 6, budget_vs_luxury: 5 },

  // Athleisure
  "nike": { classic_vs_trendy: 6, minimal_vs_maximal: 5, casual_vs_formal: 2, budget_vs_luxury: 5 },
  "adidas": { classic_vs_trendy: 6, minimal_vs_maximal: 5, casual_vs_formal: 2, budget_vs_luxury: 5 },
  "lululemon": { classic_vs_trendy: 5, minimal_vs_maximal: 3, casual_vs_formal: 2, budget_vs_luxury: 6 },
  "alo": { classic_vs_trendy: 6, minimal_vs_maximal: 3, casual_vs_formal: 2, budget_vs_luxury: 6 },
  "new balance": { classic_vs_trendy: 7, minimal_vs_maximal: 4, casual_vs_formal: 2, budget_vs_luxury: 5 },

  // Fast fashion
  "zara": { classic_vs_trendy: 7, minimal_vs_maximal: 5, casual_vs_formal: 5, budget_vs_luxury: 4 },
  "h&m": { classic_vs_trendy: 6, minimal_vs_maximal: 5, casual_vs_formal: 4, budget_vs_luxury: 3 },
  "shein": { classic_vs_trendy: 8, minimal_vs_maximal: 6, casual_vs_formal: 4, budget_vs_luxury: 1 },
  "asos": { classic_vs_trendy: 7, minimal_vs_maximal: 6, casual_vs_formal: 4, budget_vs_luxury: 3 },
  "forever 21": { classic_vs_trendy: 8, minimal_vs_maximal: 7, casual_vs_formal: 3, budget_vs_luxury: 1 },
  "gap": { classic_vs_trendy: 3, minimal_vs_maximal: 3, casual_vs_formal: 4, budget_vs_luxury: 3 },
  "old navy": { classic_vs_trendy: 3, minimal_vs_maximal: 4, casual_vs_formal: 3, budget_vs_luxury: 2 },
  "target": { classic_vs_trendy: 4, minimal_vs_maximal: 4, casual_vs_formal: 4, budget_vs_luxury: 2 },
  "mango": { classic_vs_trendy: 6, minimal_vs_maximal: 4, casual_vs_formal: 5, budget_vs_luxury: 4 },
  "& other stories": { classic_vs_trendy: 5, minimal_vs_maximal: 4, casual_vs_formal: 5, budget_vs_luxury: 5 },
  "arket": { classic_vs_trendy: 4, minimal_vs_maximal: 2, casual_vs_formal: 5, budget_vs_luxury: 5 },

  // Contemporary
  "acne studios": { classic_vs_trendy: 7, minimal_vs_maximal: 3, casual_vs_formal: 5, budget_vs_luxury: 8 },
  "reformation": { classic_vs_trendy: 6, minimal_vs_maximal: 4, casual_vs_formal: 5, budget_vs_luxury: 6 },
  "ganni": { classic_vs_trendy: 8, minimal_vs_maximal: 7, casual_vs_formal: 4, budget_vs_luxury: 7 },
  "sandro": { classic_vs_trendy: 5, minimal_vs_maximal: 4, casual_vs_formal: 6, budget_vs_luxury: 7 },
  "maje": { classic_vs_trendy: 6, minimal_vs_maximal: 5, casual_vs_formal: 6, budget_vs_luxury: 7 },
  "allsaints": { classic_vs_trendy: 6, minimal_vs_maximal: 5, casual_vs_formal: 4, budget_vs_luxury: 6 },
  "theory": { classic_vs_trendy: 4, minimal_vs_maximal: 2, casual_vs_formal: 7, budget_vs_luxury: 7 },
  "vince": { classic_vs_trendy: 4, minimal_vs_maximal: 2, casual_vs_formal: 5, budget_vs_luxury: 7 },
};

// ─── Price tier detection ───────────────────────────────────
// Returns 1-10 scale matching budget_vs_luxury axis
function priceToBudgetLuxury(priceStr) {
  if (!priceStr) return 5; // neutral
  const nums = String(priceStr).match(/[\d.]+/g);
  if (!nums || nums.length === 0) return 5;
  const price = parseFloat(nums[0]);
  if (isNaN(price)) return 5;

  if (price < 25) return 1;
  if (price < 50) return 2;
  if (price < 80) return 3;
  if (price < 120) return 4;
  if (price < 200) return 5;
  if (price < 350) return 6;
  if (price < 500) return 7;
  if (price < 800) return 8;
  if (price < 1500) return 9;
  return 10;
}

// ─── Category → casual_vs_formal mapping ────────────────────
const CATEGORY_FORMALITY = {
  // Casual
  "t-shirt": 2, "tee": 2, "hoodie": 1, "sweatshirt": 2, "tank top": 2,
  "shorts": 2, "jeans": 3, "sneakers": 2, "sandals": 2, "flip flops": 1,
  "joggers": 1, "sweatpants": 1, "leggings": 2, "tracksuit": 1,
  "crop top": 2, "romper": 3, "overalls": 2, "beanie": 2, "cap": 2,

  // Mid casual
  "shirt": 5, "blouse": 6, "polo": 4, "cardigan": 4, "sweater": 4,
  "chinos": 5, "trousers": 6, "skirt": 5, "dress": 6, "boots": 5,
  "loafers": 6, "flats": 5, "jacket": 5, "coat": 6, "vest": 5,

  // Formal
  "blazer": 7, "suit": 8, "tie": 8, "dress shirt": 8, "pencil skirt": 7,
  "heels": 7, "pumps": 8, "oxfords": 7, "gown": 9, "tuxedo": 10,
  "cufflinks": 9, "clutch": 7,

  // Accessories (neutral)
  "bag": 5, "handbag": 6, "backpack": 3, "sunglasses": 5, "watch": 6,
  "jewelry": 6, "necklace": 6, "bracelet": 5, "ring": 6, "earrings": 6,
  "belt": 5, "scarf": 5, "hat": 4,

  // Outerwear
  "parka": 3, "puffer": 3, "windbreaker": 3, "trench coat": 7,
  "leather jacket": 5, "denim jacket": 3, "bomber": 4,

  // Shoes
  "shoes": 5, "top": 4, "bottom": 4, "outerwear": 5, "accessory": 5,
};

/**
 * Extract style axis signals from a product's attributes.
 * Returns an object like { classic_vs_trendy: 6, minimal_vs_maximal: 4, ... }
 * with only axes that had signal data.
 */
function extractProductStyleAxes(product) {
  const axes = {};
  const axisCounts = {};

  function addSignal(axis, value) {
    if (value == null) return;
    if (!axes[axis]) { axes[axis] = 0; axisCounts[axis] = 0; }
    axes[axis] += value;
    axisCounts[axis]++;
  }

  const title = (product.product_name || "").toLowerCase();
  const brand = (product.brand || "").toLowerCase();
  const price = product.price;
  const category = (product.category || "").toLowerCase();

  // 1. Brand signal (strongest single signal)
  const brandStyle = BRAND_STYLE[brand];
  if (brandStyle) {
    for (const [axis, val] of Object.entries(brandStyle)) {
      addSignal(axis, val * 2); // double-weight brand
      axisCounts[axis]++; // extra count for weight
    }
  }

  // 2. Title keyword signals
  for (const [keyword, signals] of Object.entries(STYLE_SIGNALS)) {
    // Word boundary match to avoid "classic" matching "classical" substring issues
    const regex = new RegExp(`\\b${keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
    if (regex.test(title)) {
      for (const [axis, val] of Object.entries(signals)) {
        addSignal(axis, val);
      }
    }
  }

  // 3. Price signal → budget_vs_luxury axis
  const priceSignal = priceToBudgetLuxury(price);
  addSignal("budget_vs_luxury", priceSignal);

  // 4. Category signal → casual_vs_formal axis
  // Try exact match first, then partial
  let formalitySignal = CATEGORY_FORMALITY[category];
  if (formalitySignal == null) {
    // Try matching category keywords in the map
    for (const [catKey, formality] of Object.entries(CATEGORY_FORMALITY)) {
      if (title.includes(catKey) || category.includes(catKey)) {
        formalitySignal = formality;
        break;
      }
    }
  }
  if (formalitySignal != null) {
    addSignal("casual_vs_formal", formalitySignal);
  }

  // Average out each axis
  const result = {};
  for (const axis of Object.keys(axes)) {
    result[axis] = axes[axis] / axisCounts[axis];
  }

  return result;
}

/**
 * Compute axis distance score (0-100).
 * 0 = perfect match, 100 = maximum mismatch.
 * Returns similarity as 100 - distance.
 */
function axisMatchScore(userValue, productValue) {
  if (userValue == null || productValue == null) return 50; // neutral when no data
  // Both are 1-10 scale. Max distance = 9.
  const distance = Math.abs(userValue - productValue);
  // Convert to 0-100 similarity: distance 0 = 100%, distance 9 = 0%
  return Math.round(100 - (distance / 9) * 100);
}

/**
 * Compute the Style Match Score for a single product.
 *
 * @param {object} product - Product object with product_name, brand, price, category
 * @param {object|null} styleDna - User's Style DNA (with style_score, stats)
 * @param {object|null} prefProfile - User's preference profile (liked_brands, etc.)
 * @returns {number|null} 0-100 score, or null if no user data to compare against
 */
export function computeStyleMatchScore(product, styleDna, prefProfile) {
  if (!product || product.is_product_page === false) return null;

  const hasStyleDna = styleDna?.ready && styleDna?.style_score;
  const hasPrefProfile = prefProfile && (prefProfile.signal_count || 0) >= 3;

  // No user style data at all — return null for "New to you" pill
  if (!hasStyleDna && !hasPrefProfile) return null;

  const productAxes = extractProductStyleAxes(product);
  let archetypeScore = 50; // default neutral
  let priceTierScore = 50;
  let categoryPrefScore = 50;

  // ── 50% weight: Style Archetype Overlap ─────────────────────
  if (hasStyleDna) {
    const userAxes = styleDna.style_score;
    const axisScores = [];

    // Compare each style axis
    for (const axis of ["classic_vs_trendy", "minimal_vs_maximal", "casual_vs_formal", "budget_vs_luxury"]) {
      if (userAxes[axis] != null) {
        axisScores.push(axisMatchScore(userAxes[axis], productAxes[axis]));
      }
    }

    if (axisScores.length > 0) {
      archetypeScore = Math.round(axisScores.reduce((s, v) => s + v, 0) / axisScores.length);
    }
  } else if (hasPrefProfile) {
    // Fallback: use preference profile keywords to estimate archetype match
    const title = (product.product_name || "").toLowerCase();
    const brand = (product.brand || "").toLowerCase();
    const styleKws = (prefProfile.style_keywords || []).map(k => k.toLowerCase());
    const likedBrands = (prefProfile.liked_brands || []).map(b => b.toLowerCase());
    const avoidedBrands = (prefProfile.avoided_brands || []).map(b => b.toLowerCase());

    let signals = 0;
    let matches = 0;

    // Brand matching
    if (likedBrands.some(b => brand.includes(b) || title.includes(b))) { matches += 2; }
    if (avoidedBrands.some(b => brand.includes(b) || title.includes(b))) { matches -= 2; }
    signals += 2;

    // Style keyword matching
    for (const kw of styleKws) {
      signals++;
      if (title.includes(kw)) matches++;
    }

    if (signals > 0) {
      archetypeScore = Math.max(0, Math.min(100, 50 + (matches / signals) * 50));
    }
  }

  // ── 30% weight: Price Tier Alignment ────────────────────────
  if (hasStyleDna && styleDna.stats?.price_tier) {
    // User's price tier is "$", "$$", "$$$", or "$$$$" (1-4 scale)
    const userPriceTierRaw = styleDna.stats.price_tier.length; // "$$$" → 3
    // Map 1-4 tier to 1-10 budget_vs_luxury scale
    const userPriceAxis = Math.round(((userPriceTierRaw - 1) / 3) * 9 + 1);
    const productPriceAxis = priceToBudgetLuxury(product.price);
    priceTierScore = axisMatchScore(userPriceAxis, productPriceAxis);
  } else if (hasPrefProfile) {
    // No Style DNA price tier — use a neutral score
    priceTierScore = 55; // slightly positive — benefit of the doubt
  }

  // ── 20% weight: Category Preference ─────────────────────────
  if (hasStyleDna && styleDna.stats?.category_breakdown) {
    const breakdown = styleDna.stats.category_breakdown;
    const productCategory = (product.category || "").toLowerCase();
    const productTitle = (product.product_name || "").toLowerCase();

    // Check if this product's category is one the user frequently scans
    let bestCatMatch = 0;
    for (const [cat, pct] of Object.entries(breakdown)) {
      const catLower = cat.toLowerCase();
      if (productCategory.includes(catLower) || productTitle.includes(catLower) || catLower.includes(productCategory)) {
        // Higher percentage in user's breakdown = stronger match
        bestCatMatch = Math.max(bestCatMatch, pct);
      }
    }

    if (bestCatMatch > 0) {
      // Top category is ~30-40%, rarest are ~5%. Scale to 0-100.
      categoryPrefScore = Math.min(100, 40 + bestCatMatch * 1.5);
    } else {
      categoryPrefScore = 30; // category not in user's history = mild negative
    }
  } else if (hasPrefProfile) {
    const prefCats = (prefProfile.preferred_categories || []).map(c => c.toLowerCase());
    const avoidedCats = (prefProfile.avoided_categories || []).map(c => c.toLowerCase());
    const productCategory = (product.category || "").toLowerCase();
    const productTitle = (product.product_name || "").toLowerCase();

    if (prefCats.some(c => productCategory.includes(c) || productTitle.includes(c))) {
      categoryPrefScore = 75;
    } else if (avoidedCats.some(c => productCategory.includes(c) || productTitle.includes(c))) {
      categoryPrefScore = 20;
    }
  }

  // ── Weighted combination ────────────────────────────────────
  const finalScore = Math.round(
    archetypeScore * 0.50 +
    priceTierScore * 0.30 +
    categoryPrefScore * 0.20
  );

  return Math.max(0, Math.min(100, finalScore));
}

/**
 * Apply style match scores to all products in the output array.
 * Mutates products in-place by adding style_match field.
 *
 * @param {Array} output - Array of { tiers: { budget: [], mid: [], premium: [], resale: [] }, ... }
 * @param {object|null} styleDna - User's Style DNA data
 * @param {object|null} prefProfile - User's preference profile
 */
export function applyStyleMatchScores(output, styleDna, prefProfile) {
  // Check if we have any user data to work with
  const hasStyleDna = styleDna?.ready && styleDna?.style_score;
  const hasPrefProfile = prefProfile && (prefProfile.signal_count || 0) >= 3;

  for (const result of output) {
    for (const tierName of ["budget", "mid", "premium", "resale"]) {
      const tier = result.tiers?.[tierName];
      if (!Array.isArray(tier)) continue;

      for (const product of tier) {
        const score = computeStyleMatchScore(product, styleDna, prefProfile);
        // Always set the field so frontend knows the state:
        // - number 0-100: computed score
        // - null: no user data (show "New to you")
        product.style_match = score;
      }
    }

    // Also flag whether user has Style DNA (frontend uses this for "New to you" → quiz CTA)
    result._has_style_dna = hasStyleDna;
    result._has_pref_profile = hasPrefProfile;
  }
}
