import { Router } from "express";
import Anthropic from "@anthropic-ai/sdk";
import { requireAuth } from "../middleware/auth.js";
import { findProductsForItems } from "../services/products.js";
import supabase from "../lib/supabase.js";

const router = Router();

// ─── Custom occasion cache (in-memory, process-lifetime) ────
// Maps sanitized occasion string → comma-separated keyword modifiers
const occasionCache = new Map();

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
    occasionCache.set(occasionStr, result);
    return result;
  } catch (err) {
    console.error("Custom occasion Claude error:", err.message);
    // Fall back to the raw occasion string as-is
    const fallback = occasionStr;
    occasionCache.set(occasionStr, fallback);
    return fallback;
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
  const { items, gender, scan_id, occasion: occasionRaw, search_notes: rawSearchNotes } = req.body;

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
      console.log(`[CustomOccasion] "${sanitizedOccasionRaw}" → "${customOccasionModifiers}"`);
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
    // Get user's profile defaults (used as fallback when no per-item override)
    const { data: profile } = await supabase
      .from("profiles")
      .select("budget_min, budget_max, size_prefs")
      .eq("id", req.userId)
      .single();

    // Get the scan's image URL for Google Lens visual search
    let imageUrl = null;
    if (scan_id) {
      const { data: scan } = await supabase
        .from("scans")
        .select("image_url")
        .eq("id", scan_id)
        .eq("user_id", req.userId)
        .single();
      imageUrl = scan?.image_url || null;
    }

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