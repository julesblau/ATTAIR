import { Router } from "express";
import rateLimit from "express-rate-limit";
import { optionalAuth } from "../middleware/auth.js";
import supabase from "../lib/supabase.js";

const router = Router();

// ---------------------------------------------------------------------------
// Affiliate tag / ID configuration
//
// Each retailer uses a different affiliate network. The network and the
// parameter name that carries our publisher ID are noted inline.
//
// Network reference:
//   Amazon Associates — amazon.com + shopbop.com — param: tag
//   Rakuten Advertising — nordstrom, revolve, madewell, anthropologie, UO — param: mid
//   AWIN — asos, lululemon — param: affid
//   CJ Affiliate (Commission Junction) — zappos — params: AID + PID
//   ShareASale — ssense — param: sscid
// ---------------------------------------------------------------------------
const AFFILIATE_TAGS = {
  // Amazon Associates (covers amazon.com and shopbop.com)
  amazon: process.env.AMAZON_AFFILIATE_TAG || "attair-20",

  // Rakuten Advertising publisher IDs
  nordstrom:     process.env.RAKUTEN_NORDSTROM_MID     || "attair-rakuten-nordstrom-id",
  revolve:       process.env.RAKUTEN_REVOLVE_MID       || "attair-rakuten-revolve-id",
  madewell:      process.env.RAKUTEN_MADEWELL_MID      || "attair-rakuten-madewell-id",
  anthropologie: process.env.RAKUTEN_ANTHROPOLOGIE_MID || "attair-rakuten-anthropologie-id",
  urbanoutfitters: process.env.RAKUTEN_UO_MID          || "attair-rakuten-uo-id",

  // AWIN publisher IDs
  asos:      process.env.AWIN_ASOS_AFFID      || "attair-awin-asos-id",
  lululemon: process.env.AWIN_LULULEMON_AFFID || "attair-awin-lululemon-id",

  // CJ Affiliate — Zappos requires both an advertiser ID (AID) and publisher ID (PID)
  zapposAid: process.env.CJ_ZAPPOS_AID || "attair-cj-zappos-aid",
  zapposPid: process.env.CJ_ZAPPOS_PID || "attair-cj-zappos-pid",

  // ShareASale — SSENSE
  ssense: process.env.SHAREASALE_SSENSE_SSCID || "attair-shareasale-ssense-id",
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
 * Returns an object: { url: string|null, tagged: boolean }
 *   url    — the (possibly modified) destination URL, or null if unsafe
 *   tagged — true when affiliate params were successfully appended
 *
 * SECURITY: Only http/https URLs are accepted. javascript:, data:, and other
 * schemes can be exploited for XSS or phishing via an open redirect.
 */
function tagUrl(url) {
  if (!url) return { url: null, tagged: false };

  if (!isSafeUrl(url)) return { url: null, tagged: false };

  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();

    // Amazon Associates — amazon.com (all TLDs) + shopbop.com
    if (host.includes("amazon") || host.includes("shopbop")) {
      u.searchParams.set("tag", AFFILIATE_TAGS.amazon);
      return { url: u.toString(), tagged: true };
    }

    // Rakuten Advertising — Nordstrom
    if (host.includes("nordstrom")) {
      u.searchParams.set("mid", AFFILIATE_TAGS.nordstrom);
      return { url: u.toString(), tagged: true };
    }

    // Rakuten Advertising — Revolve
    if (host.includes("revolve")) {
      u.searchParams.set("mid", AFFILIATE_TAGS.revolve);
      return { url: u.toString(), tagged: true };
    }

    // Rakuten Advertising — Madewell
    if (host.includes("madewell")) {
      u.searchParams.set("mid", AFFILIATE_TAGS.madewell);
      return { url: u.toString(), tagged: true };
    }

    // Rakuten Advertising — Anthropologie
    if (host.includes("anthropologie")) {
      u.searchParams.set("mid", AFFILIATE_TAGS.anthropologie);
      return { url: u.toString(), tagged: true };
    }

    // Rakuten Advertising — Urban Outfitters
    if (host.includes("urbanoutfitters")) {
      u.searchParams.set("mid", AFFILIATE_TAGS.urbanoutfitters);
      return { url: u.toString(), tagged: true };
    }

    // AWIN — ASOS
    if (host.includes("asos")) {
      u.searchParams.set("affid", AFFILIATE_TAGS.asos);
      return { url: u.toString(), tagged: true };
    }

    // AWIN — Lululemon
    if (host.includes("lululemon")) {
      u.searchParams.set("affid", AFFILIATE_TAGS.lululemon);
      return { url: u.toString(), tagged: true };
    }

    // CJ Affiliate — Zappos (requires both AID and PID)
    if (host.includes("zappos")) {
      u.searchParams.set("AID", AFFILIATE_TAGS.zapposAid);
      u.searchParams.set("PID", AFFILIATE_TAGS.zapposPid);
      return { url: u.toString(), tagged: true };
    }

    // ShareASale — SSENSE
    if (host.includes("ssense")) {
      u.searchParams.set("sscid", AFFILIATE_TAGS.ssense);
      return { url: u.toString(), tagged: true };
    }

    // Unrecognised retailer — pass through unmodified
    return { url, tagged: false };
  } catch {
    return { url: null, tagged: false };
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

  const { url: affiliateUrl, tagged } = tagUrl(product_url);
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
      tag_applied: tagged,
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

  const { url: affiliateUrl, tagged } = tagUrl(url);
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
      tag_applied: tagged,
    })
    .then(({ error }) => {
      if (error) console.error("Click log error:", error.message);
    });

  return res.redirect(302, affiliateUrl);
});

export default router;
