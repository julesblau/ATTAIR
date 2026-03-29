/**
 * ATTAIR Dupe Finder Service
 *
 * Searches for visually similar products at significantly lower price points.
 * Uses SerpAPI Google Shopping for candidate discovery and Claude vision for
 * visual similarity scoring.
 *
 * Flow:
 * 1. Build multiple search queries targeting budget alternatives
 * 2. Hit SerpAPI Google Shopping with price ceiling at 40% of original
 * 3. Filter and deduplicate candidates
 * 4. Score visual similarity via Claude vision (with text fallback)
 * 5. Return top 5 ranked dupes
 */

import crypto from "crypto";
import supabase from "../lib/supabase.js";

const SERPAPI_URL = "https://serpapi.com/search.json";
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";

// ─── SerpAPI concurrency limiter (shared concept with products.js) ──
const SERP_MAX_CONCURRENT = 3;
let _serpActive = 0;
const _serpQueue = [];

function serpAcquire() {
  if (_serpActive < SERP_MAX_CONCURRENT) {
    _serpActive++;
    return Promise.resolve();
  }
  return new Promise(resolve => _serpQueue.push(resolve));
}

function serpRelease() {
  if (_serpQueue.length > 0) {
    _serpQueue.shift()();
  } else {
    _serpActive--;
  }
}

// ─── Price extraction ──
function extractPrice(val) {
  if (!val) return null;
  if (typeof val === "object") {
    if (val.extracted_value != null) return parseFloat(val.extracted_value);
    if (val.value) return extractPrice(val.value);
    return null;
  }
  const m = String(val).replace(/,/g, "").match(/(\d+\.?\d*)/);
  return m ? parseFloat(m[1]) : null;
}

// ─── Domains to exclude (knockoffs / counterfeits) ──
const BLOCKED_DOMAINS = [
  "dhgate.com", "aliexpress.com", "alibaba.com", "wish.com",
  "temu.com", "banggood.com", "gearbest.com", "lightinthebox.com",
  "rosegal.com", "dresslily.com", "floryday.com", "jollychic.com",
  "zaful.com",
];

const BLOCKED_TITLE_KEYWORDS = [
  "replica", "knockoff", "knock off", "counterfeit", "fake",
  "inspired by", "dupe for",
];

// ─── Cache helpers (reuses the product_cache table) ──
async function getCache(key) {
  try {
    const { data } = await supabase
      .from("product_cache")
      .select("results, expires_at")
      .eq("cache_key", key)
      .single();
    if (data && new Date(data.expires_at) > new Date()) return data.results;
  } catch {}
  return null;
}

async function setCache(key, results) {
  const now = new Date();
  const ttl = 6 * 60 * 60 * 1000; // 6 hours — dupes change frequently
  await supabase.from("product_cache").upsert({
    cache_key: key,
    results,
    cached_at: now.toISOString(),
    expires_at: new Date(now.getTime() + ttl).toISOString(),
  }).catch(() => {}); // silent — cache writes should never fail the request
}

// ─── Build dupe search queries ──
function buildDupeQueries({ productName, description, category, gender }) {
  const genderLabel = gender === "male" ? "men's" : "women's";
  const queries = [];

  // Extract key descriptors from the product name / description
  const nameClean = productName
    .replace(/\b(luxury|designer|premium|authentic|genuine)\b/gi, "")
    .trim();

  // Query 1: Direct dupe search — "[gender] [category] similar to [product]"
  queries.push(`${genderLabel} ${nameClean} dupe alternative`);

  // Query 2: Description-based — material + style
  if (description) {
    const descClean = description
      .replace(/\b(luxury|designer|premium|authentic|genuine)\b/gi, "")
      .slice(0, 80)
      .trim();
    queries.push(`${genderLabel} ${descClean} ${category || ""}`);
  }

  // Query 3: Category + style search — more generic
  if (category) {
    // Extract color/material from name or description
    const colorMatch = (productName + " " + (description || "")).match(
      /\b(black|white|brown|beige|navy|cream|tan|red|pink|blue|green|grey|gray|olive|burgundy|camel|ivory)\b/i
    );
    const color = colorMatch ? colorMatch[1] : "";
    const materialMatch = (description || "").match(
      /\b(leather|suede|canvas|denim|wool|cotton|silk|satin|linen|knit|tweed|velvet|nylon)\b/i
    );
    const material = materialMatch ? materialMatch[1] : "";
    queries.push(`${genderLabel} ${color} ${material} ${category} affordable`.trim().replace(/\s+/g, " "));
  }

  return queries.slice(0, 3); // max 3 searches
}

// ─── SerpAPI Google Shopping search for dupes ──
async function searchDupeCandidates(query, maxPrice) {
  const params = new URLSearchParams({
    engine: "google_shopping",
    q: query,
    api_key: process.env.SERPAPI_KEY,
    hl: "en",
    gl: "us",
    num: "20",
    tbs: `price:1,ppr_max:${Math.ceil(maxPrice)}`,
  });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);

  await serpAcquire();
  try {
    console.log(`  [Dupe Search] Query: "${query}" (max $${maxPrice})`);
    const res = await fetch(`${SERPAPI_URL}?${params}`, { signal: controller.signal });
    clearTimeout(timeout);
    if (!res.ok) return [];
    const data = await res.json();
    const results = data.shopping_results || [];
    console.log(`  [Dupe Search] Got ${results.length} results`);
    return results;
  } catch (err) {
    clearTimeout(timeout);
    console.error(`  [Dupe Search] Error: ${err.message}`);
    return [];
  } finally {
    serpRelease();
  }
}

// ─── Filter and deduplicate candidates ──
function filterCandidates(candidates, originalPrice) {
  const maxPrice = originalPrice * 0.40;
  const seen = new Set();

  return candidates
    .map(c => {
      const price = extractPrice(c.price) ?? extractPrice(c.extracted_price);
      const link = (c.link || c.product_link || "").toLowerCase();
      const title = (c.title || "").toLowerCase();
      const source = (c.source || "").toLowerCase();

      return {
        product_name: c.title || "Product",
        brand: c.source || "Unknown",
        price: c.price || `$${price}`,
        price_numeric: price,
        image_url: c.thumbnail || "",
        url: c.link || c.product_link || "",
        store: c.source || "Store",
        link_lower: link,
        title_lower: title,
        source_lower: source,
      };
    })
    .filter(c => {
      // Must have a valid price
      if (!c.price_numeric || c.price_numeric <= 0) return false;

      // Must be under 40% of original price
      if (c.price_numeric > maxPrice) return false;

      // Must cost at least $5 (filter out obvious junk)
      if (c.price_numeric < 5) return false;

      // Block knockoff domains
      if (BLOCKED_DOMAINS.some(d => c.link_lower.includes(d))) return false;

      // Block knockoff title keywords
      if (BLOCKED_TITLE_KEYWORDS.some(kw => c.title_lower.includes(kw))) return false;

      // Deduplicate by URL domain + normalized title
      const dedupeKey = `${c.source_lower}:${c.title_lower.slice(0, 50)}`;
      if (seen.has(dedupeKey)) return false;
      seen.add(dedupeKey);

      return true;
    })
    .map(({ link_lower, title_lower, source_lower, ...rest }) => rest); // strip internal fields
}

// ─── Claude vision similarity scoring ──
async function scoreSimilarity(originalName, originalDescription, originalImageUrl, candidates) {
  if (!candidates.length) return [];

  // Build candidate list for prompt
  const candidateList = candidates.map((c, i) => ({
    idx: i,
    name: (c.product_name || "").slice(0, 100),
    brand: (c.brand || "").slice(0, 40),
    price: c.price || "unknown",
  }));

  const prompt = `You are a fashion expert evaluating budget alternatives ("dupes") for a luxury/expensive item. Rate how visually similar each candidate is to the original.

ORIGINAL ITEM:
- Name: ${originalName}
- Description: ${originalDescription || "Not provided"}
${originalImageUrl ? `- Image URL: ${originalImageUrl}` : ""}

CANDIDATE DUPES:
${candidateList.map(c => `[${c.idx}] "${c.name}" by ${c.brand} — ${c.price}`).join("\n")}

For each candidate, score 0-100 on VISUAL SIMILARITY to the original:
- 90-100: Nearly identical look — same silhouette, same design elements, same vibe
- 70-89: Very similar — same style category, very close appearance, minor differences
- 60-69: Decent match — same general type, similar aesthetic, noticeable differences
- 40-59: Weak match — same category but different style/look
- 0-39: Poor match — clearly different item

Focus ONLY on visual appearance similarity — silhouette, design details, hardware, proportions, color, material appearance. Ignore brand prestige or quality differences.

IMPORTANT: Score EVERY candidate. Do not skip any.

Return JSON only — no markdown, no backticks:
{ "scores": [ { "idx": 0, "score": 75, "reason": "Similar quilted pattern and chain strap design, slightly different proportions" } ] }`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);

  try {
    const messages = [{ role: "user", content: prompt }];

    // If we have an image URL, try vision-enabled scoring
    if (originalImageUrl) {
      try {
        messages[0] = {
          role: "user",
          content: [
            {
              type: "image",
              source: { type: "url", url: originalImageUrl },
            },
            { type: "text", text: prompt },
          ],
        };
      } catch {
        // Fall back to text-only if image URL fails
      }
    }

    const res = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 1500,
        messages,
      }),
    });

    clearTimeout(timeout);
    if (!res.ok) {
      console.error(`[Dupe Scoring] API ${res.status}`);
      // Fail open — assign default scores based on simple heuristics
      return assignFallbackScores(originalName, candidates);
    }

    const data = await res.json();
    const text = data.content?.map(c => c.text || "").join("") || "";

    // Parse JSON from response
    let parsed;
    try {
      let s = text.replace(/```json\s*/gi, "").replace(/```\s*/g, "").trim();
      const start = s.indexOf("{");
      const end = s.lastIndexOf("}");
      if (start !== -1 && end > start) s = s.substring(start, end + 1);
      parsed = JSON.parse(s);
    } catch {
      console.error("[Dupe Scoring] Failed to parse response");
      return assignFallbackScores(originalName, candidates);
    }

    const scoreMap = new Map();
    for (const s of (parsed.scores || [])) {
      scoreMap.set(s.idx, { score: s.score || 0, reason: s.reason || "" });
    }

    return candidates.map((c, i) => {
      const aiResult = scoreMap.get(i);
      return {
        ...c,
        similarity_score: aiResult ? aiResult.score : 50,
        similarity_reason: aiResult ? aiResult.reason : "Could not score",
      };
    });
  } catch (err) {
    clearTimeout(timeout);
    console.error(`[Dupe Scoring] Error: ${err.message}`);
    return assignFallbackScores(originalName, candidates);
  }
}

// ─── Fallback scoring when AI is unavailable ──
function assignFallbackScores(originalName, candidates) {
  const origWords = new Set(
    originalName.toLowerCase().replace(/[^a-z0-9\s]/g, "").split(/\s+/).filter(w => w.length > 2)
  );

  return candidates.map(c => {
    const candidateWords = new Set(
      (c.product_name || "").toLowerCase().replace(/[^a-z0-9\s]/g, "").split(/\s+/).filter(w => w.length > 2)
    );
    // Simple word overlap score
    let overlap = 0;
    for (const w of candidateWords) {
      if (origWords.has(w)) overlap++;
    }
    const overlapRatio = origWords.size > 0 ? overlap / origWords.size : 0;
    const score = Math.min(90, Math.max(40, Math.round(40 + overlapRatio * 50)));

    return {
      ...c,
      similarity_score: score,
      similarity_reason: "Scored by keyword similarity (AI unavailable)",
    };
  });
}

// ═════════════════════════════════════════════════════════════
// MAIN: findDupes — orchestrates the full dupe search pipeline
// ═════════════════════════════════════════════════════════════
export async function findDupes({ productName, description, price, imageUrl, category, gender }) {
  console.log(`[Dupes] Searching for dupes of "${productName}" ($${price})`);

  // Check cache first
  const cacheKey = crypto.createHash("md5")
    .update(`dupes:${productName}:${price}:${category}:${gender}`)
    .digest("hex");
  const cached = await getCache(cacheKey);
  if (cached) {
    console.log(`[Dupes] Cache hit: ${cacheKey}`);
    return cached;
  }

  // Price ceiling: 40% of original
  const maxPrice = Math.floor(price * 0.40);

  // Build and execute searches in parallel
  const queries = buildDupeQueries({ productName, description, category, gender });
  console.log(`[Dupes] Running ${queries.length} searches (max $${maxPrice})`);

  const searchResults = await Promise.all(
    queries.map(q => searchDupeCandidates(q, maxPrice))
  );

  // Flatten and filter all candidates
  const allCandidates = searchResults.flat();
  console.log(`[Dupes] Raw candidates: ${allCandidates.length}`);

  const filtered = filterCandidates(allCandidates, price);
  console.log(`[Dupes] After filtering: ${filtered.length}`);

  if (filtered.length === 0) {
    const result = {
      dupes: [],
      original: { name: productName, price, image_url: imageUrl },
    };
    // Cache empty results for a shorter time (1 hour)
    await setCache(cacheKey, result);
    return result;
  }

  // Take top 15 candidates for AI scoring (balance cost vs coverage)
  const toScore = filtered.slice(0, 15);

  // Score similarity via Claude
  const scored = await scoreSimilarity(productName, description, imageUrl, toScore);

  // Filter to 60%+ similarity and sort by score descending
  const qualifiedDupes = scored
    .filter(d => d.similarity_score >= 60)
    .sort((a, b) => b.similarity_score - a.similarity_score)
    .slice(0, 5) // Max 5 dupes
    .map(d => ({
      product_name: d.product_name,
      brand: d.brand,
      price: d.price,
      price_numeric: d.price_numeric,
      image_url: d.image_url,
      url: d.url,
      store: d.store,
      savings_pct: Math.round((1 - d.price_numeric / price) * 100),
      similarity_score: d.similarity_score,
      similarity_reason: d.similarity_reason,
    }));

  // If no dupes meet the 60% threshold, return the top 3 anyway (with lower threshold)
  let finalDupes = qualifiedDupes;
  if (finalDupes.length === 0 && scored.length > 0) {
    finalDupes = scored
      .sort((a, b) => b.similarity_score - a.similarity_score)
      .slice(0, 3)
      .filter(d => d.similarity_score >= 40) // minimum floor
      .map(d => ({
        product_name: d.product_name,
        brand: d.brand,
        price: d.price,
        price_numeric: d.price_numeric,
        image_url: d.image_url,
        url: d.url,
        store: d.store,
        savings_pct: Math.round((1 - d.price_numeric / price) * 100),
        similarity_score: d.similarity_score,
        similarity_reason: d.similarity_reason,
      }));
  }

  console.log(`[Dupes] Final dupes: ${finalDupes.length}`);

  const result = {
    dupes: finalDupes,
    original: { name: productName, price, image_url: imageUrl },
  };

  // Cache successful results
  await setCache(cacheKey, result);

  return result;
}
