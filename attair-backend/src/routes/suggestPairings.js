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
 * Records an affiliate click for a pairing product link and returns a
 * tracked redirect URL via /api/go/:clickId.
 *
 * Body: { scan_id, pairing_url, product_name, retailer }
 * Response: { click_id, tracked_url }
 * Auth required.
 */
router.post("/track-click", requireAuth, async (req, res) => {
  const { scan_id, pairing_url, product_name, retailer } = req.body;

  if (!pairing_url) {
    return res.status(400).json({ error: "Missing pairing_url" });
  }

  // SECURITY: Only allow http/https URLs to prevent open redirect or XSS vectors.
  if (!isSafeUrl(pairing_url)) {
    return res.status(400).json({ error: "pairing_url must be an http or https URL" });
  }

  try {
    const { data, error } = await supabase
      .from("affiliate_clicks")
      .insert({
        user_id: req.userId,
        scan_id: scan_id || null,
        item_index: null,
        tier: null,
        retailer: retailer || null,
        product_url: pairing_url,
        affiliate_url: pairing_url,
        source: "pairing",
        item_name: product_name || null,
      })
      .select("id")
      .single();

    if (error) {
      console.error("Pairing click log error:", error.message);
      return res.status(500).json({ error: "Failed to record click" });
    }

    const clickId = data.id;
    // Build the tracked redirect URL using the existing /api/go/:click_id GET handler.
    // Derive the API base from the incoming request so this works in all environments.
    const apiBase = `${req.protocol}://${req.get("host")}`;
    const trackedUrl = `${apiBase}/api/go/${clickId}?url=${encodeURIComponent(pairing_url)}&retailer=${encodeURIComponent(retailer || "")}`;

    return res.json({ success: true, click_id: clickId, tracked_url: trackedUrl });
  } catch (err) {
    console.error("Pairing track-click error:", err.message);
    return res.status(500).json({ error: "Failed to record click" });
  }
});

export default router;
