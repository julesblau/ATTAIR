import { Router } from "express";
import rateLimit from "express-rate-limit";
import { requireAuth } from "../middleware/auth.js";
import supabase from "../lib/supabase.js";

const router = Router();

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const MIN_SCANS = 5;
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// In-memory cache: userId → { generatedAt, lastScanId, payload }
const dnaCache = new Map();

// Cap dnaCache to prevent unbounded growth
setInterval(() => {
  if (dnaCache.size > 500) {
    const toDelete = dnaCache.size - 500;
    const iter = dnaCache.keys();
    for (let i = 0; i < toDelete; i++) dnaCache.delete(iter.next().value);
  }
}, 60 * 60 * 1000);

// 5 requests per hour per user (keyed by userId via req.userId after auth)
const styleDnaLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  keyGenerator: (req) => req.userId || req.ip,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many Style DNA requests — try again in an hour" },
});

// ─── Aggregation helpers ─────────────────────────────────────

function frequency(arr) {
  const counts = {};
  for (const v of arr) {
    if (v) counts[v] = (counts[v] || 0) + 1;
  }
  return counts;
}

function topN(freqMap, n) {
  return Object.entries(freqMap)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([value, count]) => ({ value, count }));
}

// Map a price_range string like "$80 - $200" or "$$$" to a tier bucket.
function parsePriceTier(priceRange) {
  if (!priceRange) return null;

  // Handle explicit dollar-sign tiers ($, $$, $$$, $$$$)
  const tierMatch = priceRange.match(/^(\$+)$/);
  if (tierMatch) return tierMatch[1].length;

  // Parse numeric ranges — extract all numbers, take the average
  const nums = priceRange.match(/\d+/g);
  if (!nums || nums.length === 0) return null;
  const avg = nums.reduce((s, n) => s + Number(n), 0) / nums.length;

  if (avg < 50) return 1;   // $
  if (avg < 150) return 2;  // $$
  if (avg < 400) return 3;  // $$$
  return 4;                  // $$$$
}

function tierLabel(avgTier) {
  const tier = Math.round(avgTier);
  return "$".repeat(Math.max(1, Math.min(4, tier)));
}

function aggregateScans(scans) {
  const categories = [];
  const brands = [];
  const colors = [];
  const fits = [];
  const priceTiers = [];
  const styleKeywords = [];
  const verdicts = { would_wear: 0, on_the_fence: 0, not_for_me: 0 };

  for (const scan of scans) {
    // Verdict tallying
    if (scan.verdict && Object.hasOwn(verdicts, scan.verdict)) {
      verdicts[scan.verdict]++;
    }

    const items = Array.isArray(scan.items) ? scan.items : [];
    for (const item of items) {
      if (item.category) categories.push(item.category.toLowerCase());
      if (item.brand && item.brand !== "Unidentified") brands.push(item.brand);
      if (item.color) colors.push(item.color.toLowerCase());
      if (item.fit) fits.push(item.fit.toLowerCase());
      if (item.price_range) {
        const tier = parsePriceTier(item.price_range);
        if (tier) priceTiers.push(tier);
      }
      if (Array.isArray(item.style_keywords)) {
        for (const kw of item.style_keywords) {
          if (kw) styleKeywords.push(kw.toLowerCase());
        }
      }
    }
  }

  const total = scans.length;
  const verdictTotal = Object.values(verdicts).reduce((s, v) => s + v, 0);

  // Category breakdown as percentages
  const catFreq = frequency(categories);
  const totalItems = categories.length || 1;
  const categoryBreakdown = {};
  for (const [cat, count] of Object.entries(catFreq)) {
    categoryBreakdown[cat] = Math.round((count / totalItems) * 100);
  }

  // Fit distribution as percentages
  const fitFreq = frequency(fits);
  const totalFits = fits.length || 1;
  const fitBreakdown = {};
  for (const [fit, count] of Object.entries(fitFreq)) {
    fitBreakdown[fit] = Math.round((count / totalFits) * 100);
  }

  const avgPriceTier = priceTiers.length
    ? priceTiers.reduce((s, v) => s + v, 0) / priceTiers.length
    : 2;

  return {
    total_scans: total,
    top_brands: topN(frequency(brands), 5),
    dominant_colors: topN(frequency(colors), 5),
    top_style_keywords: topN(frequency(styleKeywords), 10),
    category_breakdown: categoryBreakdown,
    fit_breakdown: fitBreakdown,
    price_tier: tierLabel(avgPriceTier),
    verdict_breakdown: verdictTotal > 0 ? {
      would_wear: Math.round((verdicts.would_wear / verdictTotal) * 100),
      on_the_fence: Math.round((verdicts.on_the_fence / verdictTotal) * 100),
      not_for_me: Math.round((verdicts.not_for_me / verdictTotal) * 100),
    } : null,
  };
}

// ─── Claude Haiku call ───────────────────────────────────────

async function generateArchetype(stats) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);

  const prompt = `You are a fashion analyst. Based on this user's scan data, generate their style archetype.

DATA:
- Scans analyzed: ${stats.total_scans}
- Top brands: ${stats.top_brands.map(b => b.value).join(", ") || "varied"}
- Dominant colors: ${stats.dominant_colors.map(c => c.value).join(", ") || "varied"}
- Category mix: ${Object.entries(stats.category_breakdown).map(([k, v]) => `${k} ${v}%`).join(", ")}
- Fit preferences: ${Object.entries(stats.fit_breakdown).map(([k, v]) => `${k} ${v}%`).join(", ")}
- Price tier: ${stats.price_tier}
- Style keywords: ${stats.top_style_keywords.slice(0, 8).map(k => k.value).join(", ") || "varied"}
- Verdict split: ${stats.verdict_breakdown ? `${stats.verdict_breakdown.would_wear}% would wear, ${stats.verdict_breakdown.on_the_fence}% on the fence, ${stats.verdict_breakdown.not_for_me}% not for me` : "unknown"}

Return ONLY valid JSON, no markdown:
{
  "archetype": "2-3 word style label",
  "description": "2-3 sentences describing their style personality in second person (You gravitate toward...)",
  "traits": ["trait 1", "trait 2", "trait 3", "trait 4"],
  "style_score": {
    "classic_vs_trendy": 1-10,
    "minimal_vs_maximal": 1-10,
    "casual_vs_formal": 1-10,
    "budget_vs_luxury": 1-10
  }
}

For style_score: 1 = classic/minimal/casual/budget, 10 = trendy/maximal/formal/luxury. Be precise, not generic.`;

  try {
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
        max_tokens: 500,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    clearTimeout(timeout);
    if (!res.ok) throw new Error(`Anthropic API ${res.status}`);

    const data = await res.json();
    const text = data.content?.map(c => c.text || "").join("") || "";

    // Strip markdown fences if present
    let cleaned = text.replace(/```json\s*/gi, "").replace(/```\s*/g, "").trim();
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start !== -1 && end > start) cleaned = cleaned.substring(start, end + 1);

    return JSON.parse(cleaned);
  } catch (err) {
    clearTimeout(timeout);
    console.error("Style DNA Claude error:", err.message);
    return null; // Caller handles null gracefully
  }
}

// ─── GET /api/user/style-dna ─────────────────────────────────

router.get("/", requireAuth, styleDnaLimiter, async (req, res) => {
  try {
    const userId = req.userId;

    // Fetch last 30 scans
    const { data: scans, error: scansError } = await supabase
      .from("scans")
      .select("id, items, verdict, created_at, detected_gender")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(30);

    if (scansError) {
      console.error("Style DNA scans fetch error:", scansError.message);
      return res.status(500).json({ error: "Failed to fetch scan history" });
    }

    const scanList = scans || [];
    const count = scanList.length;

    // Not enough data yet
    if (count < MIN_SCANS) {
      return res.json({
        ready: false,
        scans_needed: MIN_SCANS - count,
        message: "Scan 5 outfits to unlock your Style DNA",
      });
    }

    // Check in-memory cache — valid if generated within 7 days
    // and the most recent scan ID hasn't changed (no new scans since last generation)
    const latestScanId = scanList[0]?.id;
    const cached = dnaCache.get(userId);
    if (
      cached &&
      cached.lastScanId === latestScanId &&
      Date.now() - cached.generatedAt < CACHE_TTL_MS
    ) {
      return res.json({ ...cached.payload, cached: true });
    }

    // Aggregate stats
    const stats = aggregateScans(scanList);

    // Call Claude Haiku for archetype
    const archetype = await generateArchetype(stats);

    const payload = {
      ready: true,
      archetype: archetype?.archetype ?? null,
      description: archetype?.description ?? null,
      traits: archetype?.traits ?? null,
      style_score: archetype?.style_score ?? null,
      stats: {
        total_scans: stats.total_scans,
        top_brands: stats.top_brands,
        dominant_colors: stats.dominant_colors,
        category_breakdown: stats.category_breakdown,
        fit_breakdown: stats.fit_breakdown,
        price_tier: stats.price_tier,
        verdict_breakdown: stats.verdict_breakdown,
      },
    };

    // Store in memory cache
    dnaCache.set(userId, {
      generatedAt: Date.now(),
      lastScanId: latestScanId,
      payload,
    });

    // Persist to profiles table so style match scoring can access it
    // without re-generating (fire-and-forget — never blocks response)
    supabase
      .from("profiles")
      .update({ style_dna_cache: payload })
      .eq("id", userId)
      .then(() => {})
      .catch(err => console.error("[StyleDNA] Cache persist error:", err.message));

    return res.json(payload);
  } catch (err) {
    console.error("Style DNA error:", err.message);
    return res.status(500).json({ error: "Failed to generate Style DNA" });
  }
});

export default router;
