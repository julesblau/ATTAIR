import supabase from "../lib/supabase.js";

/**
 * ATTAIR User Preference Engine
 *
 * Records signals from verdict buttons (wear/fence/not_for_me) and
 * computes an AI-readable preference profile by analyzing patterns
 * in the user's history of signals.
 *
 * The preference profile is used by the product scoring engine to
 * boost/penalize products based on learned user preferences.
 */

const SIGNAL_MAP = {
  would_wear: "positive",
  on_the_fence: "neutral",
  not_for_me: "negative",
};

// Recency decay: recent signals matter more than old ones.
// 90-day half-life — a signal from 90 days ago counts as 0.5, 180 days as 0.25.
const HALF_LIFE_DAYS = 90;
function signalWeight(signalDate) {
  if (!signalDate) return 1;
  const daysSince = (Date.now() - new Date(signalDate).getTime()) / 86400000;
  return Math.pow(0.5, daysSince / HALF_LIFE_DAYS);
}

/**
 * Record a preference signal for an item in a scan.
 *
 * @param {string} userId - User ID
 * @param {string} scanId - Scan ID
 * @param {number} itemIndex - Index of the item in the scan
 * @param {string} verdict - "would_wear" | "on_the_fence" | "not_for_me"
 * @param {object} itemData - The identified item data (brand, category, etc.)
 */
export async function recordSignal(userId, scanId, itemIndex, verdict, itemData = {}) {
  const signal = SIGNAL_MAP[verdict];
  if (!signal) return null;

  // Upsert: replace any existing signal for this user+scan+item combo
  const { data, error } = await supabase
    .from("preference_signals")
    .upsert({
      user_id: userId,
      scan_id: scanId,
      item_index: itemIndex,
      signal,
      brand: itemData.brand && itemData.brand !== "Unidentified" ? itemData.brand : null,
      category: (itemData.category || "").toLowerCase() || null,
      subcategory: (itemData.subcategory || "").toLowerCase() || null,
      color: (itemData.color || "").toLowerCase() || null,
      material: (itemData.material || "").toLowerCase() || null,
      price_range: itemData.price_range || null,
      style_keywords: Array.isArray(itemData.style_keywords) ? itemData.style_keywords : [],
    }, {
      onConflict: "user_id,scan_id,item_index",
      ignoreDuplicates: false,
    });

  if (error) {
    console.error("[Prefs] Signal record error:", error.message);
    // Fallback: just insert (the unique constraint may not exist yet)
    await supabase.from("preference_signals").insert({
      user_id: userId,
      scan_id: scanId,
      item_index: itemIndex,
      signal,
      brand: itemData.brand && itemData.brand !== "Unidentified" ? itemData.brand : null,
      category: (itemData.category || "").toLowerCase() || null,
      subcategory: (itemData.subcategory || "").toLowerCase() || null,
      color: (itemData.color || "").toLowerCase() || null,
      material: (itemData.material || "").toLowerCase() || null,
      price_range: itemData.price_range || null,
      style_keywords: Array.isArray(itemData.style_keywords) ? itemData.style_keywords : [],
    });
  }

  return signal;
}

/**
 * Compute a preference profile from the user's signal history.
 * This analyzes patterns in what they like/dislike and produces
 * a structured profile that the search scoring engine can use.
 *
 * @param {string} userId - User ID
 * @returns {object|null} Preference profile or null if insufficient data
 */
export async function computePreferenceProfile(userId) {
  const { data: signals, error } = await supabase
    .from("preference_signals")
    .select("*")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(200);

  if (error || !signals || signals.length < 3) return null;

  const positive = signals.filter(s => s.signal === "positive");
  const negative = signals.filter(s => s.signal === "negative");

  // Brand analysis (weighted by recency)
  const brandCounts = { positive: {}, negative: {} };
  for (const s of positive) {
    const w = signalWeight(s.created_at);
    if (s.brand) brandCounts.positive[s.brand] = (brandCounts.positive[s.brand] || 0) + w;
  }
  for (const s of negative) {
    const w = signalWeight(s.created_at);
    if (s.brand) brandCounts.negative[s.brand] = (brandCounts.negative[s.brand] || 0) + w;
  }

  const likedBrands = Object.entries(brandCounts.positive)
    .filter(([_, count]) => count >= 1.5) // ~2 recent signals or 3+ older ones
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([brand]) => brand);

  const avoidedBrands = Object.entries(brandCounts.negative)
    .filter(([_, count]) => count >= 1.5)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([brand]) => brand);

  // Category analysis (weighted by recency)
  const catCounts = { positive: {}, negative: {} };
  for (const s of positive) {
    const w = signalWeight(s.created_at);
    if (s.category) catCounts.positive[s.category] = (catCounts.positive[s.category] || 0) + w;
  }
  for (const s of negative) {
    const w = signalWeight(s.created_at);
    if (s.category) catCounts.negative[s.category] = (catCounts.negative[s.category] || 0) + w;
  }

  const preferredCategories = Object.entries(catCounts.positive)
    .filter(([_, count]) => count >= 1.5)
    .sort((a, b) => b[1] - a[1])
    .map(([cat]) => cat);

  const avoidedCategories = Object.entries(catCounts.negative)
    .filter(([_, count]) => count >= 2.0) // higher bar for avoidance to prevent over-filtering
    .sort((a, b) => b[1] - a[1])
    .map(([cat]) => cat);

  // Color analysis (weighted by recency)
  const colorCounts = { positive: {}, negative: {} };
  for (const s of positive) {
    const w = signalWeight(s.created_at);
    if (s.color) colorCounts.positive[s.color] = (colorCounts.positive[s.color] || 0) + w;
  }
  for (const s of negative) {
    const w = signalWeight(s.created_at);
    if (s.color) colorCounts.negative[s.color] = (colorCounts.negative[s.color] || 0) + w;
  }

  const positiveColors = Object.entries(colorCounts.positive)
    .filter(([_, count]) => count >= 1.5)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([color]) => color);

  const negativeColors = Object.entries(colorCounts.negative)
    .filter(([_, count]) => count >= 2.0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([color]) => color);

  // Style keyword aggregation (weighted by recency)
  const kwCounts = {};
  for (const s of positive) {
    const w = signalWeight(s.created_at);
    const kws = Array.isArray(s.style_keywords) ? s.style_keywords : [];
    for (const kw of kws) {
      kwCounts[kw] = (kwCounts[kw] || 0) + w;
    }
  }
  const topKeywords = Object.entries(kwCounts)
    .filter(([_, count]) => count >= 1.5)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([kw]) => kw);

  // Build rejected product fingerprints from negative signals
  // These are stored as search queries that can be fingerprinted against new results
  const rejectedQueries = negative
    .map(s => {
      const parts = [s.brand, s.subcategory || s.category, s.color].filter(Boolean);
      return parts.join(" ").toLowerCase().trim();
    })
    .filter(q => q.length > 3)
    .slice(0, 50); // Cap at 50 to keep profile size reasonable

  const profile = {
    liked_brands: likedBrands,
    avoided_brands: avoidedBrands,
    preferred_categories: preferredCategories,
    avoided_categories: avoidedCategories,
    color_preferences: { positive: positiveColors, negative: negativeColors },
    style_keywords: topKeywords,
    rejected_queries: rejectedQueries,
    signal_count: signals.length,
    positive_count: positive.length,
    negative_count: negative.length,
    last_updated: new Date().toISOString(),
  };

  // Save computed profile to user's profile
  await supabase
    .from("profiles")
    .update({ preference_profile: profile })
    .eq("id", userId);

  return profile;
}

/**
 * Compute per-category price sweet spots from positive signals.
 * Updates user_price_profiles table with Gaussian parameters.
 */
export async function updatePriceProfiles(userId) {
  // Fetch positive signals that have a price_range
  const { data: signals } = await supabase
    .from("preference_signals")
    .select("category, price_range, created_at")
    .eq("user_id", userId)
    .eq("signal", "positive")
    .not("price_range", "is", null)
    .order("created_at", { ascending: false })
    .limit(100);

  if (!signals || signals.length < 3) return;

  // Group prices by category
  const byCategory = {};
  for (const s of signals) {
    if (!s.category || !s.price_range) continue;
    // Extract numeric price from price_range (e.g. "$50-$100" → midpoint 75)
    const nums = s.price_range.match(/\d+/g);
    if (!nums || nums.length === 0) continue;
    const price = nums.length >= 2
      ? (parseFloat(nums[0]) + parseFloat(nums[1])) / 2
      : parseFloat(nums[0]);
    if (isNaN(price) || price <= 0) continue;

    const w = signalWeight(s.created_at);
    if (!byCategory[s.category]) byCategory[s.category] = [];
    byCategory[s.category].push({ price, weight: w });
  }

  // Compute Gaussian parameters per category
  for (const [category, entries] of Object.entries(byCategory)) {
    if (entries.length < 2) continue;

    const totalWeight = entries.reduce((sum, e) => sum + e.weight, 0);
    const weightedMean = entries.reduce((sum, e) => sum + e.price * e.weight, 0) / totalWeight;

    const weightedVariance = entries.reduce((sum, e) =>
      sum + e.weight * Math.pow(e.price - weightedMean, 2), 0) / totalWeight;
    const stdDev = Math.max(Math.sqrt(weightedVariance), 10); // floor to prevent over-narrowing

    const prices = entries.map(e => e.price).sort((a, b) => a - b);
    const hardMax = prices[Math.floor(prices.length * 0.95)] || prices[prices.length - 1];

    await supabase.from("user_price_profiles").upsert({
      user_id: userId,
      category,
      sweet_spot: Math.round(weightedMean * 100) / 100,
      std_dev: Math.round(stdDev * 100) / 100,
      hard_max: Math.round(hardMax * 100) / 100,
      sample_count: entries.length,
      updated_at: new Date().toISOString(),
    }, { onConflict: "user_id,category" }).catch(() => {});
  }
}

/**
 * Update per-attribute affinity scores (color, style, material, fit, category).
 * Called after each verdict. Each attribute the user interacted with gets
 * its affinity score nudged toward positive or negative.
 */
export async function updateAttributeAffinities(userId) {
  const SIGNAL_WEIGHTS = { positive: 0.15, neutral: 0.03, negative: -0.10 };

  const { data: signals } = await supabase
    .from("preference_signals")
    .select("signal, category, subcategory, color, material, style_keywords, created_at")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(200);

  if (!signals || signals.length === 0) return;

  // Accumulate weighted affinity deltas per attribute
  const affinities = {}; // key: "type:value" → { score, count }
  for (const s of signals) {
    const w = signalWeight(s.created_at);
    const delta = (SIGNAL_WEIGHTS[s.signal] || 0) * w;
    if (delta === 0) continue;

    const attrs = [];
    if (s.color) attrs.push(["color", s.color.toLowerCase()]);
    if (s.category) attrs.push(["category", s.category.toLowerCase()]);
    if (s.subcategory) attrs.push(["subcategory", s.subcategory.toLowerCase()]);
    if (s.material) attrs.push(["material", s.material.toLowerCase()]);
    const kws = Array.isArray(s.style_keywords) ? s.style_keywords : [];
    for (const kw of kws) attrs.push(["style", kw.toLowerCase()]);

    for (const [type, value] of attrs) {
      const key = `${type}:${value}`;
      if (!affinities[key]) affinities[key] = { type, value, score: 0, count: 0 };
      affinities[key].score += delta;
      affinities[key].count += w;
    }
  }

  // Upsert all affinities (batch)
  const rows = Object.values(affinities)
    .filter(a => a.count >= 1) // need at least ~1 weighted signal
    .map(a => ({
      user_id: userId,
      attribute_type: a.type,
      attribute_value: a.value,
      affinity_score: Math.round(Math.max(-1, Math.min(1, a.score / a.count)) * 1000) / 1000,
      interaction_count: Math.round(a.count),
      last_updated: new Date().toISOString(),
    }));

  if (rows.length === 0) return;

  // Batch upsert in chunks of 50
  for (let i = 0; i < rows.length; i += 50) {
    const chunk = rows.slice(i, i + 50);
    await supabase.from("user_attribute_affinities")
      .upsert(chunk, { onConflict: "user_id,attribute_type,attribute_value" })
      .catch(err => console.error("[AttrAffinity] upsert error:", err.message));
  }
}

/**
 * Update brand affinity scores using Bayesian smoothing.
 * Called after each verdict to build continuous brand preference scores.
 */
export async function updateBrandAffinities(userId) {
  const { data: signals } = await supabase
    .from("preference_signals")
    .select("brand, signal, created_at")
    .eq("user_id", userId)
    .not("brand", "is", null)
    .order("created_at", { ascending: false })
    .limit(200);

  if (!signals || signals.length === 0) return;

  // Aggregate by brand with recency weighting
  const brands = {};
  for (const s of signals) {
    if (!s.brand) continue;
    const w = signalWeight(s.created_at);
    if (!brands[s.brand]) brands[s.brand] = { positive: 0, negative: 0, total: 0 };
    brands[s.brand].total += w;
    if (s.signal === "positive") brands[s.brand].positive += w;
    else if (s.signal === "negative") brands[s.brand].negative += w;
  }

  // Compute Bayesian affinity score and upsert
  const ALPHA = 2; // Laplace smoothing prior
  for (const [brand, counts] of Object.entries(brands)) {
    const smoothedPos = (counts.positive + ALPHA) / (counts.total + 2 * ALPHA);
    const smoothedNeg = (counts.negative + ALPHA) / (counts.total + 2 * ALPHA);
    const affinity = smoothedPos - smoothedNeg * 0.5; // penalize negatives less

    await supabase.from("user_brand_affinities").upsert({
      user_id: userId,
      brand,
      positive_signals: Math.round(counts.positive),
      negative_signals: Math.round(counts.negative),
      total_exposures: Math.round(counts.total),
      affinity_score: Math.round(affinity * 1000) / 1000, // 3 decimal places
      updated_at: new Date().toISOString(),
    }, { onConflict: "user_id,brand" }).catch(() => {});
  }
}

/**
 * Get the user's preference profile (cached or compute fresh).
 */
export async function getPreferenceProfile(userId) {
  const { data: profile } = await supabase
    .from("profiles")
    .select("preference_profile")
    .eq("id", userId)
    .single();

  if (profile?.preference_profile?.signal_count >= 3) {
    return profile.preference_profile;
  }

  return computePreferenceProfile(userId);
}
