import { Router } from "express";
import Anthropic from "@anthropic-ai/sdk";
import { requireAuth } from "../middleware/auth.js";
import { findProductsForItems } from "../services/products.js";
import { applyStyleMatchScores } from "../services/styleMatch.js";
import supabase from "../lib/supabase.js";
import { getPreferenceProfile } from "../services/preferences.js";

const router = Router();

const FREE_EXTENDED_SEARCH_LIMIT = 3;   // per week
const FREE_FAST_SEARCH_LIMIT = 12;      // per month

/**
 * Check and enforce search limits for free-tier users.
 * Resets counters when the week/month rolls over.
 * Returns { allowed: true } or { allowed: false, message } .
 */
async function checkSearchLimit(userId, searchMode) {
  const { data: profile, error } = await supabase
    .from("profiles")
    .select("tier, trial_ends_at, extended_searches_count, extended_searches_week, fast_searches_count, fast_searches_month")
    .eq("id", userId)
    .single();

  if (error || !profile) return { allowed: true }; // fail open if profile missing

  let tier = profile.tier || "free";
  if (tier === "trial" && profile.trial_ends_at && new Date(profile.trial_ends_at) < new Date()) {
    tier = "expired";
  }
  if (tier === "pro" || tier === "trial") return { allowed: true };

  const now = new Date();

  if (searchMode === "extended") {
    // Week resets on Monday — check if stored week is in the current ISO week
    const storedWeek = profile.extended_searches_week ? new Date(profile.extended_searches_week) : null;
    const sameWeek = storedWeek && isSameISOWeek(storedWeek, now);
    const count = sameWeek ? (profile.extended_searches_count || 0) : 0;

    if (count >= FREE_EXTENDED_SEARCH_LIMIT) {
      return { allowed: false, message: `You've used all ${FREE_EXTENDED_SEARCH_LIMIT} Deep Searches this week. Upgrade to Pro for unlimited.` };
    }
    return { allowed: true, resetWeek: !sameWeek };
  } else {
    // Month resets on the 1st
    const storedMonth = profile.fast_searches_month ? new Date(profile.fast_searches_month).toISOString().slice(0, 7) : null;
    const currentMonth = now.toISOString().slice(0, 7);
    const sameMonth = storedMonth === currentMonth;
    const count = sameMonth ? (profile.fast_searches_count || 0) : 0;

    if (count >= FREE_FAST_SEARCH_LIMIT) {
      return { allowed: false, message: `You've used all ${FREE_FAST_SEARCH_LIMIT} Fast Searches this month. Upgrade to Pro for unlimited.` };
    }
    return { allowed: true, resetMonth: !sameMonth };
  }
}

/**
 * Increment the appropriate search counter after a successful search.
 */
async function incrementSearchCounter(userId, searchMode) {
  const now = new Date();
  const todayStr = now.toISOString().slice(0, 10);

  if (searchMode === "extended") {
    // Read current to decide if we need a reset
    const { data: profile } = await supabase
      .from("profiles")
      .select("extended_searches_count, extended_searches_week")
      .eq("id", userId)
      .single();

    const storedWeek = profile?.extended_searches_week ? new Date(profile.extended_searches_week) : null;
    const sameWeek = storedWeek && isSameISOWeek(storedWeek, now);

    await supabase.from("profiles").update({
      extended_searches_count: sameWeek ? (profile?.extended_searches_count || 0) + 1 : 1,
      extended_searches_week: todayStr,
    }).eq("id", userId);
  } else {
    const { data: profile } = await supabase
      .from("profiles")
      .select("fast_searches_count, fast_searches_month")
      .eq("id", userId)
      .single();

    const storedMonth = profile?.fast_searches_month ? new Date(profile.fast_searches_month).toISOString().slice(0, 7) : null;
    const currentMonth = now.toISOString().slice(0, 7);
    const sameMonth = storedMonth === currentMonth;

    await supabase.from("profiles").update({
      fast_searches_count: sameMonth ? (profile?.fast_searches_count || 0) + 1 : 1,
      fast_searches_month: todayStr,
    }).eq("id", userId);
  }
}

/**
 * Check whether two dates fall in the same ISO week (Mon–Sun).
 */
function isSameISOWeek(d1, d2) {
  const getISOWeekStart = (d) => {
    const date = new Date(d);
    const day = date.getUTCDay(); // 0=Sun, 1=Mon, ...
    const diff = (day === 0 ? -6 : 1) - day; // shift to Monday
    date.setUTCDate(date.getUTCDate() + diff);
    date.setUTCHours(0, 0, 0, 0);
    return date.getTime();
  };
  return getISOWeekStart(d1) === getISOWeekStart(d2);
}

// ─── Custom occasion cache (in-memory, process-lifetime) ────
// Maps sanitized occasion string → comma-separated keyword modifiers
// SECURITY: Capped at 1000 entries to prevent unbounded memory growth from distinct user inputs
const occasionCache = new Map();
const OCCASION_CACHE_MAX = 1000;

/**
 * Calls Claude haiku to interpret a free-text occasion into Shopping query
 * modifier keywords. Results are cached so we don't re-prompt for the same string.
 *
 * @param {string} occasionStr  - Sanitized occasion description
 * @returns {Promise<string>}   - Comma-separated keywords, e.g. "black tie, formal gown, elegant"
 */
async function getCustomOccasionModifiers(occasionStr) {
  if (occasionCache.has(occasionStr)) return occasionCache.get(occasionStr);

  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  try {
    const message = await anthropic.messages.create({
      model: "claude-haiku-4-5",
      max_tokens: 60,
      messages: [
        {
          role: "user",
          content: `The user is shopping for an outfit for: '${occasionStr}'. Generate 3-5 search modifier keywords for Google Shopping. Return only the keywords, comma-separated. No explanation.`,
        },
      ],
    });

    const raw = message.content?.[0]?.text || "";
    // Sanitize Claude's response: keep only alphanumeric, spaces, commas, hyphens
    const keywords = raw.replace(/[^a-zA-Z0-9 ,\-]/g, "").trim();
    const result = keywords || occasionStr;
    // Evict oldest entry if cache is full
    if (occasionCache.size >= OCCASION_CACHE_MAX) {
      const oldest = occasionCache.keys().next().value;
      occasionCache.delete(oldest);
    }
    occasionCache.set(occasionStr, result);
    return result;
  } catch (err) {
    console.error("Custom occasion Claude error:", err.message);
    // SECURITY: Do not cache error results — a transient failure should not lock in the
    // raw user string as a permanent modifier. Return null so the search runs without a modifier.
    return null;
  }
}

/**
 * POST /api/find-products
 *
 * Request:  { items: [...identified items], gender: "male"|"female", scan_id?: "uuid" }
 * Response: [ { item_index, brand_verified, tiers: { budget, mid, premium } } ]
 *
 * Per-item budget and size overrides are embedded in each item as _budget_min, _budget_max, and _size_prefs.
 * Profile values are used as defaults for items without overrides.
 */
router.post("/", requireAuth, async (req, res) => {
  const { items, gender, scan_id, occasion: occasionRaw, search_notes: rawSearchNotes, search_mode: rawSearchMode } = req.body;

  // Search mode: "fast" (default) or "extended" (deeper search + AI re-ranking)
  const searchMode = rawSearchMode === "extended" ? "extended" : "fast";

  const VALID_OCCASIONS = ["casual", "work", "night_out", "athletic", "formal", "outdoor",
                            "wedding", "date", "beach", "smart_casual", "festival"];

  // Sanitize the raw occasion string: trim, max 100 chars, strip dangerous characters
  const sanitizedOccasionRaw = occasionRaw
    ? String(occasionRaw).trim().slice(0, 100).replace(/[^a-zA-Z0-9 _\-]/g, "").trim()
    : null;

  let occasion = null;
  let customOccasionModifiers = null;

  if (sanitizedOccasionRaw) {
    if (VALID_OCCASIONS.includes(sanitizedOccasionRaw)) {
      // Known occasion — use the built-in OCCASION_MODIFIERS lookup in products.js
      occasion = sanitizedOccasionRaw;
    } else {
      // Unknown occasion — ask Claude to interpret it into search modifiers
      customOccasionModifiers = await getCustomOccasionModifiers(sanitizedOccasionRaw);
      console.log(`[CustomOccasion] custom occasion received, length=${sanitizedOccasionRaw.length}`);
    }
  }

  // Sanitize search_notes: trim, cap at 200 chars, keep only safe characters
  const search_notes = rawSearchNotes
    ? rawSearchNotes.trim().slice(0, 200).replace(/[^a-zA-Z0-9 ,.\-'\/]/g, "").trim() || null
    : null;

  if (!items || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: "Missing or empty items array" });
  }

  if (!gender || !["male", "female"].includes(gender)) {
    return res.status(400).json({ error: 'gender must be "male" or "female"' });
  }

  try {
    // ─── Search limit check (free/expired tier only) ──────────
    const limitCheck = await checkSearchLimit(req.userId, searchMode);
    if (!limitCheck.allowed) {
      return res.status(429).json({ error: "Search limit reached", message: limitCheck.message });
    }

    // Run profile + image URL + preference + Style DNA lookups in parallel
    const [profileResult, scanResult, prefProfile, styleDnaResult] = await Promise.all([
      supabase.from("profiles").select("budget_min, budget_max, size_prefs, preference_profile").eq("id", req.userId).single(),
      scan_id ? supabase.from("scans").select("image_url").eq("id", scan_id).eq("user_id", req.userId).single() : { data: null },
      getPreferenceProfile(req.userId).catch(() => null),
      // Fetch cached Style DNA from profiles (generated by /api/user/style-dna endpoint).
      // Column may not exist yet if migration hasn't run — catch gracefully.
      supabase.from("profiles").select("style_dna_cache").eq("id", req.userId).single()
        .then(r => r.data?.style_dna_cache || null)
        .catch(() => null),
    ]);
    const profile = profileResult.data;
    const imageUrl = scanResult.data?.image_url || null;

    const results = await findProductsForItems(
      items,
      gender,
      profile?.budget_min,
      profile?.budget_max,
      imageUrl,
      profile?.size_prefs || {},
      occasion,
      search_notes,
      customOccasionModifiers,
      searchMode,
      prefProfile,
    );

    // Apply Style Match scores using both Style DNA and preference profile
    // This replaces the basic preference-only scoring in products.js
    applyStyleMatchScores(results, styleDnaResult, prefProfile);

    // Increment search counter (non-blocking — don't fail the response)
    incrementSearchCounter(req.userId, searchMode).catch(err =>
      console.error("Search counter increment error:", err.message)
    );

    // Persist tier results back to the scan row
    if (scan_id) {
      await supabase
        .from("scans")
        .update({ tiers: results })
        .eq("id", scan_id)
        .eq("user_id", req.userId);
    }

    return res.json(results);
  } catch (err) {
    // SECURITY: Do not forward err.message to the client — it can contain SerpAPI key details,
    // internal URLs, or Supabase error bodies. Log server-side only.
    console.error("Find products error:", err.message);
    return res.status(500).json({
      error: "Product search failed",
    });
  }
});

export default router;