import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import { suggestPairings } from "../services/claude.js";
import supabase from "../lib/supabase.js";

const router = Router();

/**
 * Returns true only if the URL uses http or https.
 * Prevents javascript:, data:, and any other unsafe scheme from being stored.
 */
function isSafeUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * POST /api/suggest-pairings
 *
 * Request: { scan_id, items: [{name, category, ...}], gender }
 * Response: { pairings: [{ name, category, why, search_query }] }
 */
router.post("/", requireAuth, async (req, res) => {
  const { scan_id, items, gender = "male" } = req.body;

  if (!items || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: "Missing items array" });
  }

  try {
    const { data: profile } = await supabase
      .from("profiles")
      .select("budget_max")
      .eq("id", req.userId)
      .single();

    const result = await suggestPairings(items, gender, profile?.budget_max);
    if (!result || !Array.isArray(result.pairings)) {
      return res.status(500).json({ error: "No pairings returned" });
    }

    return res.json({ pairings: result.pairings });
  } catch (err) {
    // SECURITY: Do not forward err.message to the client — it can contain Anthropic API error
    // bodies or internal service details. Log server-side only.
    console.error("Suggest pairings error:", err.message);
    return res.status(500).json({ error: "Failed to suggest pairings" });
  }
});

/**
 * POST /api/suggest-pairings/track-click
 *
 * Records an affiliate click for a pairing product link.
 * Body: { pairing_product_url, item_name }
 * Auth required.
 */
router.post("/track-click", requireAuth, async (req, res) => {
  const { pairing_product_url, item_name } = req.body;

  if (!pairing_product_url) {
    return res.status(400).json({ error: "Missing pairing_product_url" });
  }

  // SECURITY: Only allow http/https URLs to prevent open redirect or XSS vectors.
  if (!isSafeUrl(pairing_product_url)) {
    return res.status(400).json({ error: "pairing_product_url must be an http or https URL" });
  }

  try {
    const { error } = await supabase
      .from("affiliate_clicks")
      .insert({
        user_id: req.userId,
        scan_id: null,
        item_index: null,
        tier: null,
        retailer: null,
        product_url: pairing_product_url,
        affiliate_url: pairing_product_url,
        click_type: "pairing",
        item_name: item_name || null,
      });

    if (error) {
      console.error("Pairing click log error:", error.message);
      return res.status(500).json({ error: "Failed to record click" });
    }

    return res.json({ success: true });
  } catch (err) {
    console.error("Pairing track-click error:", err.message);
    return res.status(500).json({ error: "Failed to record click" });
  }
});

export default router;
