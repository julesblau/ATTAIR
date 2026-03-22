import { Router } from "express";
import { optionalAuth } from "../middleware/auth.js";
import supabase from "../lib/supabase.js";

const router = Router();

// Amazon affiliate tag mapping
const AFFILIATE_TAGS = {
  amazon: process.env.AMAZON_AFFILIATE_TAG || "attair-20",
};

/**
 * Appends affiliate parameters to a product URL based on the retailer.
 */
function tagUrl(url, retailer) {
  if (!url) return url;

  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();

    // Amazon Associates
    if (host.includes("amazon")) {
      u.searchParams.set("tag", AFFILIATE_TAGS.amazon);
      return u.toString();
    }

    // Future: CJ Affiliate, ShareASale, Rakuten, etc.
    // For now, pass through other URLs unmodified
    return url;
  } catch {
    return url;
  }
}

/**
 * POST /api/go/:click_id
 *
 * Body: { scan_id, item_index, tier, retailer, product_url }
 * Logs the click, then 302 redirects to the affiliate-tagged URL.
 */
router.post("/:click_id", optionalAuth, async (req, res) => {
  const { click_id } = req.params;
  const { scan_id, item_index, tier, retailer, product_url } = req.body;

  if (!product_url) {
    return res.status(400).json({ error: "Missing product_url" });
  }

  const affiliateUrl = tagUrl(product_url, retailer);

  // Log the click asynchronously — don't block the redirect
  supabase
    .from("affiliate_clicks")
    .insert({
      user_id: req.userId || null,
      scan_id: scan_id || null,
      item_index: item_index ?? null,
      tier: tier || null,
      retailer: retailer || null,
      product_url,
      affiliate_url: affiliateUrl,
    })
    .then(({ error }) => {
      if (error) console.error("Click log error:", error.message);
    });

  return res.redirect(302, affiliateUrl);
});

/**
 * GET /api/go/:click_id
 * Same as POST but for simple <a href> links from the frontend.
 * Expects query params: ?url=...&scan_id=...&item_index=...&tier=...&retailer=...
 */
router.get("/:click_id", optionalAuth, async (req, res) => {
  const { url, scan_id, item_index, tier, retailer } = req.query;

  if (!url) {
    return res.status(400).json({ error: "Missing url query parameter" });
  }

  const affiliateUrl = tagUrl(url, retailer);

  // Log asynchronously
  supabase
    .from("affiliate_clicks")
    .insert({
      user_id: req.userId || null,
      scan_id: scan_id || null,
      item_index: item_index ? parseInt(item_index) : null,
      tier: tier || null,
      retailer: retailer || null,
      product_url: url,
      affiliate_url: affiliateUrl,
    })
    .then(({ error }) => {
      if (error) console.error("Click log error:", error.message);
    });

  return res.redirect(302, affiliateUrl);
});

export default router;
