import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";

const router = Router();

const SERPAPI_URL = "https://serpapi.com/search.json";

/**
 * GET /api/seen-on?brand=Nike&name=Air+Force+1
 *
 * Searches for celebrity/influencer sightings of a specific item.
 * Returns { appearances: [{ person, context, source_url, source_name, thumbnail }] }
 *
 * Uses optionalAuth — works for anonymous users but logs user_id if available.
 */
router.get("/", requireAuth, async (req, res) => {
  const { brand, name } = req.query;
  if (!name && !brand) return res.status(400).json({ error: "Missing name or brand" });

  const query = brand && brand !== "Unidentified"
    ? `${brand} ${name || ""} celebrity spotted street style outfit`
    : `${name} celebrity spotted outfit street style`;

  const params = new URLSearchParams({
    engine: "google",
    q: query.trim(),
    api_key: process.env.SERPAPI_KEY,
    tbm: "nws",   // news search — catches celeb sightings better than web search
    num: "5",
  });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);

  try {
    const serpRes = await fetch(`${SERPAPI_URL}?${params}`, { signal: controller.signal });
    clearTimeout(timeout);
    if (!serpRes.ok) return res.json({ appearances: [] });

    const data = await serpRes.json();
    // SECURITY: Validate URLs from SerpAPI before sending to the client.
    // Only allow http/https — a javascript: or data: URL in source_url or thumbnail
    // could be misused when the frontend places it in an href or img src.
    function safeUrl(url) {
      try {
        const u = new URL(url || "");
        return (u.protocol === "http:" || u.protocol === "https:") ? url : "";
      } catch { return ""; }
    }

    const articles = (data.news_results || []).slice(0, 4).map(a => ({
      title: a.title || "",
      source_name: a.source?.name || a.source || "",
      source_url: safeUrl(a.link),
      thumbnail: safeUrl(a.thumbnail),
      date: a.date || "",
      snippet: a.snippet || "",
    }));

    return res.json({ appearances: articles });
  } catch (err) {
    clearTimeout(timeout);
    console.error("Seen-on error:", err.message);
    return res.json({ appearances: [] });
  }
});

export default router;
