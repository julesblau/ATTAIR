import { Router } from "express";
import { createHash } from "crypto";
import { requireAuth } from "../middleware/auth.js";
import { suggestPairings } from "../services/claude.js";
import supabase from "../lib/supabase.js";

const router = Router();

const PAIRING_CACHE_TTL_MS = 86400000; // 24 hours
const SERPAPI_TIMEOUT_MS = 5000;

/**
 * Returns a deterministic cache key for a single pairing product search.
 * Namespaced with "pairing:v1:" to avoid collisions with scan-level cache keys.
 */
function makePairingCacheKey(searchQuery) {
  return createHash("md5")
    .update(`pairing:v1:${searchQuery.trim().toLowerCase()}`)
    .digest("hex");
}

/**
 * Look up a cached pairing product result.
 * Returns the cached product object or null on miss / error.
 */
async function getPairingCache(key) {
  try {
    const { data } = await supabase
      .from("product_cache")
      .select("results, expires_at")
      .eq("cache_key", key)
      .single();
    if (data && new Date(data.expires_at) > new Date()) return data.results;
  } catch {
    // Cache read failure is non-fatal — fall through to live search.
  }
  return null;
}

/**
 * Persist a pairing product result so the next request for the same
 * search_query is served from cache without a SerpAPI round-trip.
 */
async function setPairingCache(key, product) {
  try {
    const now = new Date();
    await supabase.from("product_cache").upsert({
      cache_key: key,
      results: product,
      cached_at: now.toISOString(),
      expires_at: new Date(now.getTime() + PAIRING_CACHE_TTL_MS).toISOString(),
    });
  } catch {
    // Cache write failure is non-fatal.
  }
}

/**
 * Run a Google Shopping search for a single pairing suggestion and return
 * a product object, or null if no result is found or an error occurs.
 *
 * Results are read from / written to product_cache to avoid redundant API calls.
 */
async function fetchPairingProduct(searchQuery) {
  const cacheKey = makePairingCacheKey(searchQuery);

  const cached = await getPairingCache(cacheKey);
  if (cached) return cached;

  const params = new URLSearchParams({
    engine: "google_shopping",
    q: searchQuery,
    api_key: process.env.SERPAPI_KEY,
    num: 3,
    gl: "us",
    hl: "en",
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SERPAPI_TIMEOUT_MS);

  let serpData;
  try {
    const serpRes = await fetch(
      `https://serpapi.com/search.json?${params}`,
      { signal: controller.signal }
    );
    serpData = await serpRes.json();
  } finally {
    clearTimeout(timer);
  }

  const results = serpData.shopping_results || [];
  if (results.length === 0) return null;

  const best = results[0];
  const product = {
    image_url: best.thumbnail || null,
    price: best.extracted_price != null
      ? `$${best.extracted_price}`
      : (best.price || null),
    product_name: best.title || null,
    url: best.link || null,
    brand: best.source || "",
  };

  await setPairingCache(cacheKey, product);
  return product;
}

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

    // Enrich up to the first 3 pairings with a real product image, price, and URL
    // sourced from Google Shopping via SerpAPI. Each search is isolated in its own
    // try/catch so a single failure never blocks the other pairings or the response.
    const pairings = result.pairings.slice(0, 3);

    if (process.env.SERPAPI_KEY) {
      await Promise.all(
        pairings.map(async (pairing) => {
          if (!pairing.search_query) return;
          try {
            const product = await fetchPairingProduct(pairing.search_query);
            if (product) pairing.product = product;
          } catch (searchErr) {
            // Log but do not surface — the pairing is still useful without a product.
            console.error(
              `Pairing product search failed for "${pairing.search_query}":`,
              searchErr.message
            );
          }
        })
      );
    }

    // Include any pairings beyond the first 3 unchanged (no product enrichment).
    const remainingPairings = result.pairings.slice(3);

    return res.json({ pairings: [...pairings, ...remainingPairings] });
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
