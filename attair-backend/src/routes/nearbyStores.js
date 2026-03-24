import { Router } from "express";
import { optionalAuth } from "../middleware/auth.js";

const router = Router();
const SERPAPI_URL = "https://serpapi.com/search.json";

/**
 * GET /api/nearby-stores?brand=Nike&category=shoes&lat=40.71&lng=-74.00
 *
 * Finds nearby retail stores that likely carry the brand/category.
 * Uses SerpAPI Google Maps engine.
 * Returns { stores: [{ name, address, rating, hours, distance, maps_url }] }
 *
 * Works for anonymous users (no purchase needed to discover stores).
 */
router.get("/", optionalAuth, async (req, res) => {
  const { brand, category, lat, lng } = req.query;

  if (!lat || !lng) return res.status(400).json({ error: "lat and lng are required" });

  // SECURITY: lat and lng are interpolated directly into the SerpAPI query string.
  // Validate them as finite numbers within legal geographic bounds to prevent parameter
  // injection (e.g. passing `ll=@<script>` or extra URL characters into the SerpAPI request).
  const latNum = parseFloat(lat);
  const lngNum = parseFloat(lng);
  if (!Number.isFinite(latNum) || latNum < -90 || latNum > 90) {
    return res.status(400).json({ error: "lat must be a number between -90 and 90" });
  }
  if (!Number.isFinite(lngNum) || lngNum < -180 || lngNum > 180) {
    return res.status(400).json({ error: "lng must be a number between -180 and 180" });
  }

  // Build a focused search query
  const storeName = brand && brand !== "Unidentified" ? brand : "";
  const storeCategory = category ? `${category} store` : "clothing store";
  const q = storeName ? `${storeName} store` : storeCategory;

  // Use the validated numeric values (latNum/lngNum) rather than the raw query strings
  // so the interpolated value is guaranteed to be a plain decimal number.
  const params = new URLSearchParams({
    engine: "google_maps",
    q,
    ll: `@${latNum},${lngNum},14z`,
    type: "search",
    api_key: process.env.SERPAPI_KEY,
  });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);

  try {
    const serpRes = await fetch(`${SERPAPI_URL}?${params}`, { signal: controller.signal });
    clearTimeout(timeout);

    if (!serpRes.ok) return res.json({ stores: [] });

    const data = await serpRes.json();
    // SECURITY: Validate URLs from SerpAPI before sending to the client.
    // Only allow http/https — a javascript: or data: URL in maps_url or thumbnail
    // could be misused when the frontend places it in an href or img src.
    function safeUrl(url) {
      try {
        const u = new URL(url || "");
        return (u.protocol === "http:" || u.protocol === "https:") ? url : "";
      } catch { return ""; }
    }

    const places = (data.local_results || []).slice(0, 5).map(p => ({
      name: p.title || "",
      address: p.address || "",
      rating: p.rating || null,
      reviews: p.reviews || null,
      hours: p.hours || "",
      open_now: p.open_state || "",
      distance: p.distance || "",
      phone: p.phone || "",
      maps_url: safeUrl(p.links?.directions || p.place_id_search),
      thumbnail: safeUrl(p.thumbnail),
    }));

    return res.json({ stores: places });
  } catch (err) {
    clearTimeout(timeout);
    console.error("Nearby stores error:", err.message);
    return res.json({ stores: [] });
  }
});

export default router;
