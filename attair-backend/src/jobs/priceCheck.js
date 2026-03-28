/**
 * priceCheck.js — Price drop detection job for ATTAIR Pro subscribers.
 *
 * Call checkPriceDrops() manually or via the POST /api/price-alerts/check endpoint.
 *
 * Logic:
 *   1. Find all active Pro users (tier = 'pro', or 'trial' with non-expired trial_ends_at).
 *   2. For each user, fetch saved items from the last 90 days that have a usable search query.
 *   3. Skip items already alerted in the last 7 days (avoid duplicate noise).
 *   4. Cap at MAX_CHECKS_PER_USER SerpAPI calls per user per run.
 *   5. For each item, run a Google Shopping text search to find the current lowest price.
 *   6. If the price dropped ≥ DROP_THRESHOLD_PCT, insert a price_alerts row.
 */

import supabase from "../lib/supabase.js";
import crypto from "crypto";

const SERPAPI_URL = "https://serpapi.com/search.json";
const MAX_CHECKS_PER_USER = 5;     // SerpAPI cost guard — max 5 checks per user per run
const DROP_THRESHOLD_PCT = 12;      // Minimum % drop to trigger an alert
const LOOKBACK_DAYS = 90;           // Only check items saved in the last N days
const REALERT_COOLDOWN_DAYS = 7;    // Don't re-alert for the same item within N days

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Extract a numeric price from SerpAPI price values.
 * Handles strings like "$118.00", numbers, and SerpAPI price objects.
 */
function extractPrice(val) {
  if (val == null) return null;
  if (typeof val === "object") {
    if (val.extracted_value != null) return parseFloat(val.extracted_value);
    if (val.value) return extractPrice(val.value);
    return null;
  }
  const m = String(val).replace(/,/g, "").match(/(\d+\.?\d*)/);
  return m ? parseFloat(m[1]) : null;
}

/**
 * Extract the original price from a saved item's tier_product or item_data.
 * Returns a numeric value or null.
 */
function getOriginalPrice(savedItem) {
  // tier_product.price is formatted like "$118.00"
  if (savedItem.tier_product?.price) {
    const p = extractPrice(savedItem.tier_product.price);
    if (p != null && p > 0) return p;
  }
  // item_data may also carry price info in some cases
  if (savedItem.item_data?.price) {
    const p = extractPrice(savedItem.item_data.price);
    if (p != null && p > 0) return p;
  }
  return null;
}

/**
 * Build a search query from a saved item's metadata.
 * Prefers tier_product data (most specific), falls back to item_data.
 * Returns null if there is not enough signal to build a useful query.
 */
function buildSearchQuery(savedItem) {
  const tp = savedItem.tier_product;
  const id = savedItem.item_data;

  // Use the stored product name + brand from tier_product if available
  if (tp?.product_name && tp.product_name !== "Unknown") {
    const brand = (tp.brand && tp.brand !== "Unknown") ? tp.brand : "";
    const query = [brand, tp.product_name].filter(Boolean).join(" ").trim();
    if (query.length > 3) return query;
  }

  // Fall back to item_data fields (brand + subcategory + color)
  if (id) {
    const parts = [
      id.brand && id.brand !== "Unidentified" ? id.brand : "",
      id.subcategory || id.category || "",
      id.color || "",
    ].filter(Boolean);
    const query = parts.join(" ").trim();
    if (query.length > 3) return query;
  }

  return null;
}

/**
 * Run a Google Shopping search and return the lowest price found.
 * Returns { lowestPrice, productUrl, productName } or null on failure.
 */
async function findLowestCurrentPrice(searchQuery) {
  const params = new URLSearchParams({
    engine: "google_shopping",
    q: searchQuery,
    api_key: process.env.SERPAPI_KEY,
    hl: "en",
    gl: "us",
    num: "10",
  });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);

  try {
    const res = await fetch(`${SERPAPI_URL}?${params}`, { signal: controller.signal });
    clearTimeout(timeout);

    if (!res.ok) {
      console.warn(`[priceCheck] SerpAPI HTTP ${res.status} for query: "${searchQuery}"`);
      return null;
    }

    const data = await res.json();
    const results = data.shopping_results || [];

    if (results.length === 0) return null;

    // Find the lowest price among results that have a valid price
    let lowest = null;
    let lowestResult = null;

    for (const r of results) {
      const price = extractPrice(r.price) ?? extractPrice(r.extracted_price);
      if (price != null && price > 0) {
        if (lowest === null || price < lowest) {
          lowest = price;
          lowestResult = r;
        }
      }
    }

    if (lowest === null || !lowestResult) return null;

    return {
      lowestPrice: lowest,
      productUrl: lowestResult.link || lowestResult.product_link || "",
      productName: lowestResult.title || searchQuery,
    };
  } catch (err) {
    clearTimeout(timeout);
    console.error(`[priceCheck] Search error for "${searchQuery}": ${err.message}`);
    return null;
  }
}

// ─── Main job ────────────────────────────────────────────────────────────────

/**
 * Check for price drops across all active Pro users' saved items.
 * Returns a summary object { usersChecked, itemsChecked, alertsCreated, errors }.
 */
export async function checkPriceDrops() {
  const summary = { usersChecked: 0, itemsChecked: 0, alertsCreated: 0, errors: [] };

  if (!process.env.SERPAPI_KEY) {
    const msg = "[priceCheck] SERPAPI_KEY not set — aborting";
    console.error(msg);
    summary.errors.push(msg);
    return summary;
  }

  // ── 1. Find all active Pro users ──────────────────────────────
  const now = new Date().toISOString();

  const { data: proProfiles, error: profilesError } = await supabase
    .from("profiles")
    .select("id, tier, trial_ends_at")
    .or(`tier.eq.pro,and(tier.eq.trial,trial_ends_at.gt.${now})`);

  if (profilesError) {
    const msg = `[priceCheck] Failed to fetch Pro profiles: ${profilesError.message}`;
    console.error(msg);
    summary.errors.push(msg);
    return summary;
  }

  if (!proProfiles || proProfiles.length === 0) {
    console.log("[priceCheck] No active Pro users found — nothing to check");
    return summary;
  }

  console.log(`[priceCheck] Checking ${proProfiles.length} Pro user(s)`);

  const cutoffDate = new Date(Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const realertCutoff = new Date(Date.now() - REALERT_COOLDOWN_DAYS * 24 * 60 * 60 * 1000).toISOString();

  // ── 2. Process each Pro user ───────────────────────────────────
  for (const profile of proProfiles) {
    summary.usersChecked++;
    let checksThisUser = 0;

    try {
      // Fetch saved items from the last 90 days
      const { data: savedItems, error: savedError } = await supabase
        .from("saved_items")
        .select("id, item_data, tier_product, created_at")
        .eq("user_id", profile.id)
        .gte("created_at", cutoffDate)
        .order("created_at", { ascending: false });

      if (savedError) {
        console.error(`[priceCheck] Failed to fetch saved items for user ${profile.id}: ${savedError.message}`);
        summary.errors.push(`user ${profile.id}: ${savedError.message}`);
        continue;
      }

      if (!savedItems || savedItems.length === 0) continue;

      // Fetch recent alerts for this user to skip already-alerted items
      const { data: recentAlerts } = await supabase
        .from("price_alerts")
        .select("saved_item_id")
        .eq("user_id", profile.id)
        .gte("detected_at", realertCutoff);

      const recentlyAlertedIds = new Set(
        (recentAlerts || []).map(a => a.saved_item_id).filter(Boolean)
      );

      // ── 3. Check each saved item ─────────────────────────────
      for (const item of savedItems) {
        if (checksThisUser >= MAX_CHECKS_PER_USER) break;

        // Skip if already alerted recently
        if (recentlyAlertedIds.has(item.id)) continue;

        // Build a search query — skip items with insufficient metadata
        const searchQuery = buildSearchQuery(item);
        if (!searchQuery) continue;

        // Need a baseline price to compare against
        const originalPrice = getOriginalPrice(item);
        if (!originalPrice || originalPrice <= 0) continue;

        checksThisUser++;
        summary.itemsChecked++;

        console.log(`[priceCheck] Checking item ${item.id} for user ${profile.id}: "${searchQuery}" (original: $${originalPrice})`);

        // ── 4. Search for current price ──────────────────────
        const result = await findLowestCurrentPrice(searchQuery);
        if (!result) continue;

        const { lowestPrice, productUrl, productName } = result;

        // ── 5. Check if drop meets threshold ──────────────────
        const dropPct = ((originalPrice - lowestPrice) / originalPrice) * 100;

        if (dropPct < DROP_THRESHOLD_PCT) {
          console.log(`[priceCheck] No significant drop for "${searchQuery}": ${dropPct.toFixed(1)}% (need ${DROP_THRESHOLD_PCT}%)`);
          continue;
        }

        console.log(`[priceCheck] Price drop detected: "${searchQuery}" ${dropPct.toFixed(1)}% ($${originalPrice} → $${lowestPrice})`);

        // ── 6. Insert alert ───────────────────────────────────
        const { error: insertError } = await supabase
          .from("price_alerts")
          .insert({
            user_id: profile.id,
            saved_item_id: item.id,
            product_name: productName,
            brand: item.tier_product?.brand || item.item_data?.brand || null,
            original_price: originalPrice,
            current_price: lowestPrice,
            drop_percentage: parseFloat(dropPct.toFixed(2)),
            product_url: productUrl,
            search_query: searchQuery,
            seen: false,
          });

        if (insertError) {
          console.error(`[priceCheck] Failed to insert alert for item ${item.id}: ${insertError.message}`);
          summary.errors.push(`insert alert for item ${item.id}: ${insertError.message}`);
        } else {
          summary.alertsCreated++;
          // Add to the local set so subsequent items don't also trigger (edge case)
          recentlyAlertedIds.add(item.id);
        }
      }
    } catch (err) {
      console.error(`[priceCheck] Unexpected error for user ${profile.id}: ${err.message}`);
      summary.errors.push(`user ${profile.id}: ${err.message}`);
    }
  }

  console.log(`[priceCheck] Done — users: ${summary.usersChecked}, items: ${summary.itemsChecked}, alerts: ${summary.alertsCreated}, errors: ${summary.errors.length}`);
  return summary;
}
