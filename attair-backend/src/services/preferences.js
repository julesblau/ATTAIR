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

  // Brand analysis
  const brandCounts = { positive: {}, negative: {} };
  for (const s of positive) {
    if (s.brand) brandCounts.positive[s.brand] = (brandCounts.positive[s.brand] || 0) + 1;
  }
  for (const s of negative) {
    if (s.brand) brandCounts.negative[s.brand] = (brandCounts.negative[s.brand] || 0) + 1;
  }

  const likedBrands = Object.entries(brandCounts.positive)
    .filter(([_, count]) => count >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([brand]) => brand);

  const avoidedBrands = Object.entries(brandCounts.negative)
    .filter(([_, count]) => count >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([brand]) => brand);

  // Category analysis
  const catCounts = { positive: {}, negative: {} };
  for (const s of positive) {
    if (s.category) catCounts.positive[s.category] = (catCounts.positive[s.category] || 0) + 1;
  }
  for (const s of negative) {
    if (s.category) catCounts.negative[s.category] = (catCounts.negative[s.category] || 0) + 1;
  }

  const preferredCategories = Object.entries(catCounts.positive)
    .filter(([_, count]) => count >= 2)
    .sort((a, b) => b[1] - a[1])
    .map(([cat]) => cat);

  const avoidedCategories = Object.entries(catCounts.negative)
    .filter(([_, count]) => count >= 3)
    .sort((a, b) => b[1] - a[1])
    .map(([cat]) => cat);

  // Color analysis
  const colorCounts = { positive: {}, negative: {} };
  for (const s of positive) {
    if (s.color) colorCounts.positive[s.color] = (colorCounts.positive[s.color] || 0) + 1;
  }
  for (const s of negative) {
    if (s.color) colorCounts.negative[s.color] = (colorCounts.negative[s.color] || 0) + 1;
  }

  const positiveColors = Object.entries(colorCounts.positive)
    .filter(([_, count]) => count >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([color]) => color);

  const negativeColors = Object.entries(colorCounts.negative)
    .filter(([_, count]) => count >= 3)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([color]) => color);

  // Style keyword aggregation
  const kwCounts = {};
  for (const s of positive) {
    const kws = Array.isArray(s.style_keywords) ? s.style_keywords : [];
    for (const kw of kws) {
      kwCounts[kw] = (kwCounts[kw] || 0) + 1;
    }
  }
  const topKeywords = Object.entries(kwCounts)
    .filter(([_, count]) => count >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([kw]) => kw);

  const profile = {
    liked_brands: likedBrands,
    avoided_brands: avoidedBrands,
    preferred_categories: preferredCategories,
    avoided_categories: avoidedCategories,
    color_preferences: { positive: positiveColors, negative: negativeColors },
    style_keywords: topKeywords,
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
