import { Router } from "express";
import rateLimit from "express-rate-limit";
import { optionalAuth } from "../middleware/auth.js";
import supabase from "../lib/supabase.js";

const router = Router();

// Amazon affiliate tag mapping
const AFFILIATE_TAGS = {
  amazon: process.env.AMAZON_AFFILIATE_TAG || "attair-20",
};

/**
 * Returns true only if the URL uses http or https.
 * Rejects javascript:, data:, and any other non-web scheme that could be
 * used for XSS or phishing via an open redirect.
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
 * Appends affiliate parameters to a product URL based on the retailer.
 * Returns null for URLs that are not http/https to prevent open redirects.
 */
function tagUrl(url, retailer) {
  if (!url) return null;

  // SECURITY: Only allow http/https URLs. javascript:, data:, and other schemes
  // can be exploited for XSS or phishing when used as a redirect target.
  if (!isSafeUrl(url)) return null;

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
    return null;
  }
}

// Per-IP rate limit on affiliate click endpoints to deter click-fraud / count inflation.
// 60 clicks per minute per IP is generous for real users but hard to abuse at scale.
const clickLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many affiliate clicks from this IP, please slow down" },
});

/**
 * POST /api/go/:click_id
 *
 * Body: { scan_id, item_index, tier, retailer, product_url }
 * Logs the click, then 302 redirects to the affiliate-tagged URL.
 */
router.post("/:click_id", clickLimiter, optionalAuth, async (req, res) => {
  const { click_id } = req.params;
  const { scan_id, item_index, tier, retailer, product_url } = req.body;

  if (!product_url) {
    return res.status(400).json({ error: "Missing product_url" });
  }

  const affiliateUrl = tagUrl(product_url, retailer);
  if (!affiliateUrl) {
    return res.status(400).json({ error: "Invalid product_url: must be an http or https URL" });
  }

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
router.get("/:click_id", clickLimiter, optionalAuth, async (req, res) => {
  const { url, scan_id, item_index, tier, retailer } = req.query;

  if (!url) {
    return res.status(400).json({ error: "Missing url query parameter" });
  }

  const affiliateUrl = tagUrl(url, retailer);
  if (!affiliateUrl) {
    return res.status(400).json({ error: "Invalid url: must be an http or https URL" });
  }

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
