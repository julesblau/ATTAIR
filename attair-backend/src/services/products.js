import supabase from "../lib/supabase.js";
import crypto from "crypto";

/**
 * ATTAIR Product Search — v4 (Visual-first)
 *
 * Architecture:
 * 1. Google Lens (reverse image search) on the actual photo
 *    → returns real product pages that visually match the outfit
 * 2. Match Lens results to Claude's identified items
 *    → "this product looks like the hoodie Claude identified"
 * 3. Text search fallback for items Lens didn't cover
 * 4. Score everything for relevance, partition into tiers by price
 *
 * This is fundamentally different from v1-v3 which only did text search.
 * Visual search finds products that LOOK like the photo, not just
 * keyword matches. This is what makes the app actually useful.
 */

const SERPAPI_URL = "https://serpapi.com/search.json";

// ─── Budget config ──────────────────────────────────────────
const DEFAULT_BUDGET = { min: 50, max: 100 };

// ─── Size preference helpers ────────────────────────────────
const BODY_TYPE_TERMS = {
  petite: "petite",
  tall: "tall",
  plus: "plus size",
  big_tall: "big & tall",
  athletic: "athletic fit",
  curvy: "curvy",
};
const BODY_TYPE_OPPOSITES = {
  petite: ["plus size", "big & tall"],
  plus: ["petite"],
  big_tall: ["petite"],
};
const FIT_TERMS = {
  slim: "slim fit",
  fitted: "fitted",
  relaxed: "relaxed fit",
  oversized: "oversized",
  flowy: "flowy",
};

function getSizeTermForItem(item, sizePrefs) {
  const sizes = sizePrefs?.sizes;
  if (!sizes) return null;
  const cat = (item.category || "").toLowerCase();
  const sub = (item.subcategory || "").toLowerCase();
  const combined = cat + " " + sub;
  if (["top", "shirt", "tee", "blouse", "polo", "sweater", "hoodie", "pullover", "sweatshirt"].some(k => combined.includes(k))) return sizes.tops || null;
  if (["jean", "denim"].some(k => combined.includes(k))) return sizes.jeans || sizes.bottoms || null;
  if (["short"].some(k => combined.includes(k))) return sizes.shorts || sizes.bottoms || null;
  if (["pant", "trouser", "chino", "legging", "bottom"].some(k => combined.includes(k))) return sizes.bottoms || null;
  if (["dress", "gown", "romper", "jumpsuit"].some(k => combined.includes(k))) return sizes.dresses || null;
  if (["outerwear", "jacket", "coat", "blazer", "parka", "bomber"].some(k => combined.includes(k))) return sizes.outerwear || null;
  if (["shoe", "sneaker", "boot", "sandal", "loafer", "heel", "flat", "trainer"].some(k => combined.includes(k))) return sizes.shoes || null;
  if (["sock"].some(k => combined.includes(k))) return sizes.socks || null;
  return null;
}

function getTierBounds(budgetMin, budgetMax) {
  let min = budgetMin || DEFAULT_BUDGET.min;
  let max = budgetMax || DEFAULT_BUDGET.max;
  if (min > 500) min = DEFAULT_BUDGET.min;
  if (max > 1000) max = DEFAULT_BUDGET.max;
  if (max <= min) max = min * 2;
  return { min, max };
}

// ─── Cache ──────────────────────────────────────────────────
let _lastCleanup = 0;
async function cleanupExpiredCache() {
  if (Date.now() - _lastCleanup < 3600000) return;
  _lastCleanup = Date.now();
  try { await supabase.from("product_cache").delete().lt("expires_at", new Date().toISOString()); } catch {}
}

function makeCacheKey(scanId, bMin, bMax) {
  return crypto.createHash("md5").update(`v4:${scanId}:${bMin}:${bMax}`).digest("hex");
}

function makeTextCacheKey(item, gender, bMin, bMax) {
  return crypto.createHash("md5").update(`v4t:${gender}:${bMin}:${bMax}:${item.search_query || item.name}`).digest("hex");
}

async function getCache(key) {
  try {
    const { data } = await supabase.from("product_cache").select("results, expires_at").eq("cache_key", key).single();
    if (data && new Date(data.expires_at) > new Date()) return data.results;
  } catch {}
  return null;
}

async function setCache(key, results) {
  const now = new Date();
  await supabase.from("product_cache").upsert({
    cache_key: key, results,
    cached_at: now.toISOString(),
    expires_at: new Date(now.getTime() + 86400000).toISOString(),
  });
}

// ─── Price extraction (handles both Shopping and Lens formats) ─
function extractPrice(val) {
  if (!val) return null;
  // Lens sometimes returns price as an object: { value: "$118.00", extracted_value: 118 }
  if (typeof val === "object") {
    if (val.extracted_value != null) return parseFloat(val.extracted_value);
    if (val.value) return extractPrice(val.value);
    return null;
  }
  const m = String(val).replace(/,/g, "").match(/(\d+\.?\d*)/);
  return m ? parseFloat(m[1]) : null;
}

// ═════════════════════════════════════════════════════════════
// STEP 1: Google Lens — Visual reverse image search
// ═════════════════════════════════════════════════════════════
async function googleLensSearch(imageUrl) {
  if (!imageUrl) {
    console.log("[Lens] No image URL provided, skipping visual search");
    return [];
  }

  console.log(`\n[Lens] Searching with image: ${imageUrl.slice(0, 80)}...`);

  const params = new URLSearchParams({
    engine: "google_lens",
    url: imageUrl,
    api_key: process.env.SERPAPI_KEY,
  });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);

  try {
    const res = await fetch(`${SERPAPI_URL}?${params}`, { signal: controller.signal });
    clearTimeout(timeout);

    if (!res.ok) {
      const text = await res.text();
      console.error(`[Lens] HTTP ${res.status}: ${text.slice(0, 200)}`);
      return [];
    }

    const data = await res.json();

    // Google Lens returns visual_matches (product pages that look like the image)
    const visualMatches = data.visual_matches || [];
    console.log(`[Lens] Got ${visualMatches.length} visual matches`);

    if (visualMatches.length > 0) {
      const s = visualMatches[0];
      console.log(`[Lens] Sample: "${(s.title || "").slice(0, 60)}" source=${s.source} price=${JSON.stringify(s.price)} link=${!!(s.link || s.product_link || s.url)}`);
    }

    return visualMatches;
  } catch (err) {
    clearTimeout(timeout);
    console.error(`[Lens] Error: ${err.message}`);
    return [];
  }
}

// ═════════════════════════════════════════════════════════════
// STEP 2: Match Lens results to identified items
// ═════════════════════════════════════════════════════════════
// Each Lens result is a product. We figure out which identified
// item it corresponds to based on category/subcategory keywords.

function matchLensResultToItem(result, items) {
  const title = (result.title || "").toLowerCase();
  let bestMatch = -1;
  let bestScore = 0;

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    let score = 0;

    // Subcategory match (most specific)
    const sub = (item.subcategory || "").toLowerCase();
    if (sub && sub.length > 2 && title.includes(sub)) score += 30;
    // Handle plurals: "sneaker" matches "sneakers"
    else if (sub && sub.length > 4 && title.includes(sub.slice(0, -1))) score += 20;

    // Category match (broader)
    const cat = (item.category || "").toLowerCase();
    if (cat && title.includes(cat)) score += 10;

    // Brand match
    const brand = (item.brand || "").toLowerCase();
    if (brand && brand !== "unidentified" && title.includes(brand)) score += 25;

    // Color match
    const color = (item.color || "").toLowerCase();
    if (color && color.length > 2 && title.includes(color)) score += 10;

    // Common clothing keywords to help disambiguate
    const keywords = {
      outerwear: ["jacket", "coat", "blazer", "parka", "vest", "cardigan", "bomber"],
      top: ["shirt", "tee", "t-shirt", "blouse", "polo", "tank", "sweater", "hoodie", "pullover", "sweatshirt", "top", "henley"],
      bottom: ["pants", "jeans", "trousers", "shorts", "joggers", "chinos", "leggings", "skirt"],
      shoes: ["shoe", "sneaker", "boot", "sandal", "loafer", "heel", "flat", "trainer", "runner", "slip-on"],
      dress: ["dress", "gown", "romper", "jumpsuit"],
      accessory: ["hat", "cap", "belt", "watch", "glasses", "sunglasses", "scarf", "tie", "bracelet", "necklace", "ring"],
      bag: ["bag", "purse", "backpack", "tote", "clutch", "wallet"],
    };

    // Check if the title contains keywords for this item's category
    const catKeywords = keywords[cat] || [];
    if (catKeywords.some(kw => title.includes(kw))) score += 15;

    if (score > bestScore) {
      bestScore = score;
      bestMatch = i;
    }
  }

  // Require at least a minimal match (category or subcategory)
  return bestScore >= 10 ? bestMatch : -1;
}

// ═════════════════════════════════════════════════════════════
// STEP 3: Text search fallback (for items Lens didn't cover)
// ═════════════════════════════════════════════════════════════
async function textSearch(query) {
  const params = new URLSearchParams({
    engine: "google_shopping",
    q: query,
    api_key: process.env.SERPAPI_KEY,
    hl: "en",
    gl: "us",
    num: "20",
  });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);

  try {
    console.log(`  [Text] Query: "${query}"`);
    const res = await fetch(`${SERPAPI_URL}?${params}`, { signal: controller.signal });
    clearTimeout(timeout);
    if (!res.ok) return [];
    const data = await res.json();
    const results = data.shopping_results || [];
    console.log(`  [Text] Got ${results.length} results`);
    return results;
  } catch (err) {
    clearTimeout(timeout);
    console.error(`  [Text] Error: ${err.message}`);
    return [];
  }
}

async function textSearchForItem(item, gender, tierBounds, sizePrefs = {}) {
  const g = gender === "female" ? "women's" : "men's";
  const genderWords = ["men's", "mens", "women's", "womens"];
  const hasGender = (q) => genderWords.some(w => q.toLowerCase().includes(w));

  // Derive size/fit/body modifiers from prefs (body_type and fit are now arrays)
  const bodyTypes = Array.isArray(sizePrefs.body_type) ? sizePrefs.body_type : (sizePrefs.body_type ? [sizePrefs.body_type] : []);
  const fitStyles = Array.isArray(sizePrefs.fit) ? sizePrefs.fit : (sizePrefs.fit ? [sizePrefs.fit] : []);
  const bodyTerm = BODY_TYPE_TERMS[bodyTypes[0]] || null;
  const fitTerm = FIT_TERMS[fitStyles[0]] || null;
  const sizeTerm = getSizeTermForItem(item, sizePrefs);

  // Build 2 queries: Claude's search query + description-based
  const queries = [];
  if (item.search_query) {
    const sq = item.search_query;
    let q = hasGender(sq) ? sq : `${g} ${sq}`;
    if (bodyTerm && !q.toLowerCase().includes(bodyTerm)) q = `${bodyTerm} ${q}`;
    queries.push(q);
  }

  const brand = item.brand && item.brand !== "Unidentified" ? item.brand : "";
  if (brand && (item.brand_confidence === "confirmed" || item.brand_confidence === "high")) {
    queries.push(item.product_line ? `${brand} ${item.product_line}` : `${brand} ${item.name}`);
  }

  const bodyPrefix = bodyTerm ? `${bodyTerm} ` : "";
  const fitSuffix = fitTerm ? ` ${fitTerm}` : "";
  const sizeSuffix = sizeTerm ? ` size ${sizeTerm}` : "";
  const desc = `${g} ${bodyPrefix}${item.subcategory || item.category} ${item.color || ""}${fitSuffix}${sizeSuffix}`.replace(/\s+/g, " ").trim();
  if (!queries.some(q => q.toLowerCase() === desc.toLowerCase())) {
    queries.push(desc);
  }

  const uniqueQueries = [...new Set(queries)].slice(0, 2);
  console.log(`[TextFallback] Item: "${item.name}" — ${uniqueQueries.map(q => `"${q}"`).join(", ")}`);

  const allResults = [];
  const batches = await Promise.all(uniqueQueries.map(q => textSearch(q).catch(() => [])));
  for (const batch of batches) allResults.push(...batch);

  return allResults;
}

// ═════════════════════════════════════════════════════════════
// SCORING — How relevant is this product to the identified item?
// ═════════════════════════════════════════════════════════════
function scoreProduct(product, item, isFromLens, sizePrefs = {}) {
  const title = (product.title || "").toLowerCase();
  const source = (product.source || "").toLowerCase();
  const link = product.link || product.product_link || product.url || "";
  const price = extractPrice(product.price) || extractPrice(product.extracted_price);

  // Must have a link to a product page
  if (!link) return -1;

  // Text results MUST have a price (otherwise useless for tiering)
  // Lens results WITHOUT a price are still valuable — they're visual matches
  if (!isFromLens && price === null) return -1;

  let score = 0;

  // Lens results get a big base bonus — they're visually matched to the actual photo
  if (isFromLens) score += 25;
  // Lens results WITH a price are even more valuable (can be properly tiered)
  if (isFromLens && price !== null) score += 10;

  // Subcategory match
  const sub = (item.subcategory || "").toLowerCase();
  if (sub && sub.length > 2) {
    if (title.includes(sub)) score += 25;
    else if (sub.length > 4 && title.includes(sub.slice(0, -1))) score += 15;
  }

  // Category match
  const cat = (item.category || "").toLowerCase();
  if (cat && title.includes(cat)) score += 8;

  // Brand match
  const brand = (item.brand || "").toLowerCase();
  if (brand && brand !== "unidentified") {
    if (title.includes(brand) || source.includes(brand)) score += 30;
    const line = (item.product_line || "").toLowerCase();
    if (line && line.length > 2 && title.includes(line)) score += 20;
  }

  // Color match
  const color = (item.color || "").toLowerCase();
  if (color && color.length > 2 && title.includes(color)) score += 12;

  // Material match
  const material = (item.material || "").toLowerCase();
  if (material && material.length > 3 && title.includes(material)) score += 5;

  // Penalties
  const isMale = (item.gender || "male") === "male";
  if (isMale && (title.includes("women's") || title.includes("womens"))) score -= 40;
  if (!isMale && (title.includes("men's ") || title.includes("mens "))) score -= 40;
  if (/\b(set of|pack of|\d+\s*pack|bundle)\b/i.test(product.title || "")) score -= 25;

  // Size preference scoring (body_type and fit are arrays)
  const bodyTypes = Array.isArray(sizePrefs.body_type) ? sizePrefs.body_type : (sizePrefs.body_type ? [sizePrefs.body_type] : []);
  const fitStyles = Array.isArray(sizePrefs.fit) ? sizePrefs.fit : (sizePrefs.fit ? [sizePrefs.fit] : []);
  for (const bt of bodyTypes) {
    const bodyTerm = BODY_TYPE_TERMS[bt];
    if (bodyTerm && title.includes(bodyTerm.toLowerCase())) { score += 15; break; }
  }
  // Penalise if title mentions a body type incompatible with ALL user preferences
  const allOpposites = bodyTypes.flatMap(bt => BODY_TYPE_OPPOSITES[bt] || []);
  for (const opp of allOpposites) {
    if (title.includes(opp.toLowerCase())) { score -= 25; break; }
  }
  for (const fs of fitStyles) {
    const fitTerm = FIT_TERMS[fs];
    if (fitTerm && title.includes(fitTerm.toLowerCase())) { score += 10; break; }
  }

  return score;
}

// ─── Format for frontend ────────────────────────────────────
function formatProduct(product, isOriginalBrand) {
  const price = extractPrice(product.price) || extractPrice(product.extracted_price);
  return {
    product_name: product.title || "Unknown",
    brand: product.source || "Unknown",
    price: price != null ? `$${price.toFixed(2)}` : "See price →",
    url: product.link || product.product_link || product.url || "",
    image_url: product.thumbnail || product.image || "",
    is_product_page: true,
    is_identified_brand: isOriginalBrand,
    why: "",
  };
}

function explainMatch(product, item, tier, isFromLens) {
  const title = (product.title || "").toLowerCase();
  const source = (product.source || "").toLowerCase();
  const reasons = [];

  if (isFromLens) reasons.push("visual match");

  const brand = (item.brand || "").toLowerCase();
  if (brand !== "unidentified" && (title.includes(brand) || source.includes(brand))) reasons.push("exact brand");

  const line = (item.product_line || "").toLowerCase();
  if (line && line.length > 2 && title.includes(line)) reasons.push(item.product_line);

  const color = (item.color || "").toLowerCase();
  if (color && title.includes(color)) reasons.push(item.color);

  const price = extractPrice(product.price);
  if (price) reasons.push(`$${price.toFixed(0)}`);

  return reasons.length ? reasons.join(" · ") : `${item.subcategory || item.category} — ${tier} tier`;
}

// ─── Google Shopping fallback link ──────────────────────────
function fallbackTier(item, tier, tierBounds) {
  const g = (item.gender || "male") === "female" ? "women's" : "men's";
  const q = encodeURIComponent(`${g} ${item.search_query || item.name}`);
  const prices = {
    budget: { min: 0, max: tierBounds.min },
    mid: { min: tierBounds.min, max: tierBounds.max },
    premium: { min: tierBounds.max, max: 99999 },
  }[tier];

  const url = prices.max < 99999
    ? `https://www.google.com/search?tbm=shop&q=${q}&tbs=mr:1,price:1,ppr_min:${prices.min},ppr_max:${prices.max}`
    : `https://www.google.com/search?tbm=shop&q=${q}&tbs=mr:1,price:1,ppr_min:${prices.min}`;

  return {
    product_name: `Search: ${item.name}`,
    brand: "Google Shopping",
    price: prices.max < 99999 ? `$${prices.min}–$${prices.max}` : `$${prices.min}+`,
    url, image_url: "",
    is_product_page: false,
    is_identified_brand: false,
    why: "No exact match — tap to search",
  };
}

// ═════════════════════════════════════════════════════════════
// MAIN: Process all items for a scan
// ═════════════════════════════════════════════════════════════
export async function findProductsForItems(items, gender, budgetMin, budgetMax, imageUrl, sizePrefs = {}) {
  cleanupExpiredCache();
  const defaultTierBounds = getTierBounds(budgetMin, budgetMax);
  const defaultSizePrefs = sizePrefs;

  // Helper: derive per-item tier bounds from a single budget target number.
  // _budget = user's max comfortable spend; budget tier = under 40%, mid = 40-100%, premium = over 100%.
  function getItemTierBounds(item) {
    if (item._budget != null && item._budget > 0) {
      const max = item._budget;
      const min = Math.round(max * 0.4);
      return getTierBounds(min, max);
    }
    return defaultTierBounds;
  }
  function getItemSizePrefs(item) {
    return item._size_prefs != null ? item._size_prefs : defaultSizePrefs;
  }

  // ── Step 1: Google Lens on the full image ─────────
  const lensResults = await googleLensSearch(imageUrl);

  // ── Step 2: Match Lens results to identified items ─
  // Each item gets a pool of matched products
  const itemPools = items.map(() => ({ lens: [], text: [] }));

  for (const result of lensResults) {
    const matchIdx = matchLensResultToItem(result, items);
    if (matchIdx >= 0) {
      itemPools[matchIdx].lens.push(result);
    }
  }

  // Log Lens matching
  for (let i = 0; i < items.length; i++) {
    console.log(`[Match] "${items[i].name}" ← ${itemPools[i].lens.length} Lens matches`);
  }

  // ── Step 3: Text search fallback for items with few USEFUL Lens matches
  const textPromises = items.map(async (item, i) => {
    // Count Lens results that actually have prices
    const pricedLens = itemPools[i].lens.filter(r => {
      const p = extractPrice(r.price) || extractPrice(r.extracted_price);
      return p !== null;
    });
    // Text search if we have fewer than 3 priced Lens results
    if (pricedLens.length < 3) {
      const textResults = await textSearchForItem(item, gender, getItemTierBounds(item), getItemSizePrefs(item));
      itemPools[i].text = textResults;
      console.log(`[Match] "${item.name}" ← ${textResults.length} text results (supplementing ${itemPools[i].lens.length} Lens, ${pricedLens.length} with price)`);
    }
  });
  await Promise.all(textPromises);

  // ── Step 4: Score, tier, and pick for each item ───
  // NEW ARCHITECTURE:
  // 1. Find the ORIGINAL product (brand-matched Lens result) → it gets "mid" tier with ORIGINAL badge
  // 2. Budget = cheaper alternative, Premium = pricier alternative
  // 3. If no original found, fall back to best-in-each-tier as before
  const output = items.map((rawItem, i) => {
    const itemTierBounds = getItemTierBounds(rawItem);
    const itemSizePrefs = getItemSizePrefs(rawItem);
    const item = { ...rawItem, gender };
    const pool = itemPools[i];
    const brandLower = (item.brand || "").toLowerCase();
    const hasBrand = brandLower && brandLower !== "unidentified";

    // Combine Lens + text results, deduplicate by URL
    const seen = new Set();
    const allProducts = [];

    for (const r of pool.lens) {
      const url = r.link || r.product_link || r.url || "";
      if (url && !seen.has(url)) { seen.add(url); allProducts.push({ product: r, isLens: true }); }
    }
    for (const r of pool.text) {
      const url = r.link || r.product_link || "";
      if (url && !seen.has(url)) { seen.add(url); allProducts.push({ product: r, isLens: false }); }
    }

    // Score everything
    const allScored = allProducts
      .map(({ product, isLens }) => ({
        product,
        isLens,
        score: scoreProduct(product, item, isLens, itemSizePrefs),
        price: extractPrice(product.price) || extractPrice(product.extracted_price),
      }))
      .filter(s => s.score > 0)
      .sort((a, b) => b.score - a.score);

    const priced = allScored.filter(s => s.price !== null);
    const unpriced = allScored.filter(s => s.price === null);

    // ── Find the ORIGINAL product ───────────────────
    // = Lens result whose title or source matches the identified brand
    let original = null;
    if (hasBrand) {
      original = allScored.find(s => {
        const t = (s.product.title || "").toLowerCase();
        const src = (s.product.source || "").toLowerCase();
        return s.isLens && (t.includes(brandLower) || src.includes(brandLower));
      });
      if (original) {
        console.log(`[Original] "${item.name}" → FOUND: "${(original.product.title || "").slice(0, 60)}" ${original.price != null ? "$" + original.price : "no-price"} [LENS]`);
      }
    }

    console.log(`[Tier] "${item.name}": ${priced.length} priced + ${unpriced.length} unpriced (bounds: $${itemTierBounds.min}-$${itemTierBounds.max})`);
    if (allScored.length > 0) {
      for (const s of allScored.slice(0, 3)) {
        console.log(`  → score=${s.score} ${s.price != null ? "$" + s.price : "no-price"} ${s.isLens ? "[LENS]" : "[TEXT]"} "${(s.product.title || "").slice(0, 55)}"`);
      }
    }

    const usedUrls = new Set();
    function getUrl(s) { return s.product.link || s.product.product_link || s.product.url || ""; }

    function formatAndTrack(s, tier, isBrandMatch) {
      usedUrls.add(getUrl(s));
      const formatted = formatProduct(s.product, isBrandMatch);
      formatted.why = explainMatch(s.product, item, tier, s.isLens);
      return formatted;
    }

    function pickBestAvailable(candidates, tier) {
      const pick = candidates.find(s => !usedUrls.has(getUrl(s)));
      if (!pick) return null;
      const isBrand = hasBrand && ((pick.product.title || "").toLowerCase().includes(brandLower) || (pick.product.source || "").toLowerCase().includes(brandLower));
      return formatAndTrack(pick, tier, isBrand);
    }

    const tiers = { budget: null, mid: null, premium: null };

    if (original) {
      // ── ORIGINAL FOUND: place it in mid, alternatives in budget/premium ──
      const isBrand = true;
      tiers.mid = formatAndTrack(original, "mid", isBrand);

      // Budget = cheapest alternative that isn't the original
      const cheaper = priced.filter(s => !usedUrls.has(getUrl(s))).sort((a, b) => a.price - b.price);
      tiers.budget = cheaper.length ? formatAndTrack(cheaper[0], "budget", false) : null;

      // Premium = most expensive alternative that isn't the original or the budget pick
      const pricier = priced.filter(s => !usedUrls.has(getUrl(s))).sort((a, b) => b.price - a.price);
      tiers.premium = pricier.length ? formatAndTrack(pricier[0], "premium", false) : null;

      // Fill any still-empty tier with unpriced Lens results
      if (!tiers.budget) tiers.budget = pickBestAvailable(unpriced, "budget");
      if (!tiers.premium) tiers.premium = pickBestAvailable(unpriced, "premium");

    } else {
      // ── NO ORIGINAL: partition by price as before ──
      const budgetPool = priced.filter(s => s.price < itemTierBounds.min).sort((a, b) => b.score - a.score);
      const midPool = priced.filter(s => s.price >= itemTierBounds.min && s.price <= itemTierBounds.max).sort((a, b) => b.score - a.score);
      const premiumPool = priced.filter(s => s.price > itemTierBounds.max).sort((a, b) => b.score - a.score);

      tiers.budget = pickBestAvailable(budgetPool, "budget");
      tiers.mid = pickBestAvailable(midPool, "mid");
      tiers.premium = pickBestAvailable(premiumPool, "premium");

      // Fill empty tiers with widened ranges
      if (!tiers.budget) tiers.budget = pickBestAvailable(priced.filter(s => s.price < itemTierBounds.min * 1.5), "budget");
      if (!tiers.mid) tiers.mid = pickBestAvailable(priced, "mid");
      if (!tiers.premium) tiers.premium = pickBestAvailable(priced.filter(s => s.price > itemTierBounds.max * 0.7), "premium");

      // Still empty? Use unpriced Lens results
      if (!tiers.budget) tiers.budget = pickBestAvailable(unpriced, "budget");
      if (!tiers.mid) tiers.mid = pickBestAvailable(unpriced, "mid");
      if (!tiers.premium) tiers.premium = pickBestAvailable(unpriced, "premium");
    }

    const brandVerified = item.brand && item.brand !== "Unidentified" &&
      Object.values(tiers).some(t => t?.is_identified_brand);

    return {
      item_index: rawItem._scan_item_index ?? i,
      brand_verified: brandVerified,
      tiers: {
        budget: tiers.budget || fallbackTier(item, "budget", itemTierBounds),
        mid: tiers.mid || fallbackTier(item, "mid", itemTierBounds),
        premium: tiers.premium || fallbackTier(item, "premium", itemTierBounds),
      },
    };
  });

  return output;
}