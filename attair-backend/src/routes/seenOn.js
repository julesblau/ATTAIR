import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";

const router = Router();

const SERPAPI_URL = "https://serpapi.com/search.json";

// Map of interest category → query template function
// Each template receives (brand, name) and returns a search string.
const INTEREST_QUERY_MAP = {
  "Actors & Actresses":       (brand, name) => `actor actress wearing ${brand ? brand + " " : ""}${name}`,
  "Musicians & K-Pop":        (brand, name) => `musician kpop idol wearing ${brand ? brand + " " : ""}${name}`,
  "Athletes":                 (brand, name) => `athlete sports star wearing ${brand ? brand + " " : ""}${name}`,
  "TikTok Creators":          (brand, name) => `tiktok creator influencer wearing ${brand ? brand + " " : ""}${name}`,
  "Instagram Influencers":    (brand, name) => `instagram influencer wearing ${brand ? brand + " " : ""}${name} style`,
  "Streamers & YouTubers":    (brand, name) => `youtuber streamer wearing ${brand ? brand + " " : ""}${name}`,
  "Fashion Icons & Models":   (brand, name) => `fashion model supermodel wearing ${brand ? brand + " " : ""}${name}`,
  "Street Style":             (brand, name) => `street style ${name} ${brand || ""} spotted`.trim(),
};

// Derive a stable platform label from the interest category key
function platformFromInterest(interest) {
  return interest.toLowerCase().replace(/[^a-z0-9]+/g, "_");
}

function safeUrl(url) {
  try {
    const u = new URL(url || "");
    return (u.protocol === "http:" || u.protocol === "https:") ? url : "";
  } catch { return ""; }
}

async function fetchAppearances(query, platform) {
  const params = new URLSearchParams({
    engine: "google",
    q: query.trim(),
    api_key: process.env.SERPAPI_KEY,
    tbm: "nws",
    num: "5",
  });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);

  try {
    const serpRes = await fetch(`${SERPAPI_URL}?${params}`, { signal: controller.signal });
    clearTimeout(timeout);
    if (!serpRes.ok) return [];

    const data = await serpRes.json();
    return (data.news_results || []).slice(0, 4).map(a => ({
      title: a.title || "",
      source_name: a.source?.name || a.source || "",
      source_url: safeUrl(a.link),
      thumbnail: safeUrl(a.thumbnail),
      date: a.date || "",
      snippet: a.snippet || "",
      platform,
    }));
  } catch (err) {
    clearTimeout(timeout);
    console.error(`Seen-on fetch error (platform=${platform}):`, err.message);
    return [];
  }
}

/**
 * GET /api/seen-on?brand=Nike&name=Air+Force+1&interests=Actors+%26+Actresses,Athletes
 *
 * Searches for celebrity/influencer sightings of a specific item.
 * Optional `interests` param (comma-separated) personalizes results to specific platforms.
 * When interests are provided, runs up to 3 tailored SerpAPI queries and merges results.
 *
 * Returns { appearances: [{ title, source_name, source_url, thumbnail, date, snippet, platform }] }
 */
router.get("/", requireAuth, async (req, res) => {
  const { brand, name, interests: interestsRaw } = req.query;
  if (!name && !brand) return res.status(400).json({ error: "Missing name or brand" });

  const safeBrand = (brand && brand !== "Unidentified") ? brand : null;

  try {
    // ── Personalized mode: interests provided ───────────────────────
    if (interestsRaw) {
      // Parse and validate interests; silently ignore unknowns
      const requested = interestsRaw
        .split(",")
        .map(s => s.trim())
        .filter(s => s.length > 0);

      const knownInterests = Object.keys(INTEREST_QUERY_MAP);
      const validInterests = requested.filter(i => knownInterests.includes(i));

      // Cap at 3 SerpAPI calls to avoid quota burn
      const selectedInterests = validInterests.slice(0, 3);

      if (selectedInterests.length === 0) {
        // No valid interests — fall through to default behaviour below
      } else {
        const resultSets = await Promise.all(
          selectedInterests.map(interest => {
            const queryFn = INTEREST_QUERY_MAP[interest];
            const query = queryFn(safeBrand, name || "");
            const platform = platformFromInterest(interest);
            return fetchAppearances(query, platform);
          })
        );

        // Flatten, deduplicate by source_url, keep insertion order
        const seen = new Set();
        const appearances = [];
        for (const batch of resultSets) {
          for (const item of batch) {
            const key = item.source_url || item.title;
            if (key && !seen.has(key)) {
              seen.add(key);
              appearances.push(item);
            }
          }
        }

        return res.json({ appearances });
      }
    }

    // ── Default mode: generic celebrity/street style search ─────────
    const query = safeBrand
      ? `${safeBrand} ${name || ""} celebrity spotted street style outfit`
      : `${name} celebrity spotted outfit street style`;

    const appearances = await fetchAppearances(query.trim(), "general");
    return res.json({ appearances });
  } catch (err) {
    console.error("Seen-on error:", err.message);
    return res.json({ appearances: [] });
  }
});

export default router;
