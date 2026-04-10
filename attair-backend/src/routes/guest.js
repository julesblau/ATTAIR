import { Router } from "express";
import { guestRateLimit } from "../middleware/rateLimit.js";
import { identifyClothing } from "../services/claude.js";
import { findProductsForItems } from "../services/products.js";

const router = Router();

// ─── Guest search limits (in-memory, IP-keyed) ─────────────
const GUEST_EXTENDED_LIMIT = 3;  // per week
const GUEST_FAST_LIMIT = 12;     // per month
const guestSearchCounters = new Map(); // ip → { ext: { count, weekStart }, fast: { count, month } }

// Evict stale entries hourly to prevent unbounded growth
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of guestSearchCounters) {
    const weekStale = entry.ext && (now - entry.ext.weekStart > 8 * 24 * 60 * 60 * 1000);
    const monthStale = entry.fast && (new Date().getUTCMonth() !== entry.fast.month);
    if (weekStale && monthStale) guestSearchCounters.delete(ip);
  }
}, 60 * 60 * 1000);

function getISOWeekStart(d) {
  const date = new Date(d);
  const day = date.getUTCDay();
  const diff = (day === 0 ? -6 : 1) - day;
  date.setUTCDate(date.getUTCDate() + diff);
  date.setUTCHours(0, 0, 0, 0);
  return date.getTime();
}

function checkGuestSearchLimit(ip, searchMode) {
  const now = new Date();
  let entry = guestSearchCounters.get(ip);
  if (!entry) {
    entry = {
      ext: { count: 0, weekStart: getISOWeekStart(now) },
      fast: { count: 0, month: now.toISOString().slice(0, 7) },
    };
    guestSearchCounters.set(ip, entry);
  }

  if (searchMode === "extended") {
    const currentWeekStart = getISOWeekStart(now);
    if (entry.ext.weekStart !== currentWeekStart) {
      entry.ext = { count: 0, weekStart: currentWeekStart };
    }
    if (entry.ext.count >= GUEST_EXTENDED_LIMIT) {
      return { allowed: false, message: `You've used all ${GUEST_EXTENDED_LIMIT} Deep Searches this week. Sign up for free to get more!` };
    }
    return { allowed: true };
  } else {
    const currentMonth = now.toISOString().slice(0, 7);
    if (entry.fast.month !== currentMonth) {
      entry.fast = { count: 0, month: currentMonth };
    }
    if (entry.fast.count >= GUEST_FAST_LIMIT) {
      return { allowed: false, message: `You've used all ${GUEST_FAST_LIMIT} Fast Searches this month. Sign up for free to get more!` };
    }
    return { allowed: true };
  }
}

function incrementGuestSearchCounter(ip, searchMode) {
  const entry = guestSearchCounters.get(ip);
  if (!entry) return;
  if (searchMode === "extended") entry.ext.count++;
  else entry.fast.count++;
}

/**
 * POST /api/guest/identify
 *
 * Stripped-down identify for unauthenticated users.
 * - No image upload to Supabase storage
 * - No scan persistence to DB
 * - No profile preferences merge
 * - IP rate-limited to 3 scans/day
 */
router.post("/identify", guestRateLimit, async (req, res) => {
  const { image, mime_type, priority_region_base64 } = req.body;

  if (!image || typeof image !== "string" || image.length < 100) {
    return res.status(400).json({ error: "Missing or invalid image data" });
  }

  const ALLOWED_MIME_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"];
  if (mime_type && !ALLOWED_MIME_TYPES.includes(mime_type)) {
    return res.status(400).json({ error: "Invalid image type" });
  }

  const cleanImage = image.startsWith("data:") ? image.split(",")[1] || image : image;
  if (!/^[A-Za-z0-9+/=\s]+$/.test(cleanImage.slice(0, 200))) {
    return res.status(400).json({ error: "Invalid base64 encoding" });
  }

  const MAX_PRIORITY_B64_CHARS = 2_000_000;
  if (priority_region_base64 && (typeof priority_region_base64 !== "string" || priority_region_base64.length > MAX_PRIORITY_B64_CHARS)) {
    return res.status(400).json({ error: "priority_region_base64 exceeds maximum allowed size" });
  }

  const mimeType = mime_type || "image/jpeg";

  try {
    const raw = await identifyClothing(cleanImage, mimeType, {}, priority_region_base64);

    // Content safety check
    if (raw.unsafe) {
      console.warn(`[Safety] Guest image flagged as unsafe: ${raw.reason}`);
      return res.status(422).json({
        error: "Image not suitable for scanning",
        reason: "This image doesn't appear to contain appropriate fashion content. Please upload a photo of an outfit.",
        unsafe: true,
      });
    }

    // Dedup same as identify.js
    const slots = {};
    for (const item of raw.items || []) {
      if ((item.visibility_pct || 100) < 50) continue;
      let key = (item.category || "other").toLowerCase();
      if (key === "accessory" || key === "bag") {
        const n = (item.name || "").toLowerCase();
        key = n.includes("hat") || n.includes("cap") ? "acc_head"
          : n.includes("watch") ? "acc_watch"
          : n.includes("bag") || n.includes("backpack") ? "acc_bag"
          : n.includes("belt") ? "acc_belt"
          : n.includes("glass") || n.includes("sunglass") ? "acc_eye"
          : `acc_${Object.keys(slots).length}`;
      }
      if (!slots[key] || (item.identification_confidence || 0) > (slots[key].identification_confidence || 0)) {
        slots[key] = item;
      }
    }
    let items = Object.values(slots);
    items.sort((a, b) => (a.position_y || 0.5) - (b.position_y || 0.5));

    return res.json({
      scan_id: null, // no persistence for guests
      image_url: null,
      gender: raw.gender || "male",
      summary: raw.summary || "",
      items,
      guest: true,
      guest_scans_remaining: req.guestScansRemaining ?? 0,
    });
  } catch (err) {
    console.error("Guest identify error:", err.message);
    return res.status(500).json({ error: "Identification failed" });
  }
});

/**
 * POST /api/guest/find-products
 *
 * Stripped-down product search for unauthenticated users.
 * - No profile budget/size defaults
 * - No scan image URL (skips Lens — text search only)
 * - No tier persistence
 * - IP rate-limited (shared budget with identify)
 */
router.post("/find-products", guestRateLimit, async (req, res) => {
  const { items, gender, search_mode: rawSearchMode } = req.body;

  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: "Items array is required" });
  }

  const searchMode = rawSearchMode === "extended" ? "extended" : "fast";

  // ─── Guest search limit check ──────────────────────────
  const ip = req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.ip || "unknown";
  const limitCheck = checkGuestSearchLimit(ip, searchMode);
  if (!limitCheck.allowed) {
    return res.status(429).json({ error: "Search limit reached", message: limitCheck.message });
  }

  try {
    const results = await findProductsForItems(
      items,
      gender,
      null, // budget_min
      null, // budget_max
      null, // imageUrl (no Lens for guests)
      {},   // size_prefs
      null, // occasion
      null, // search_notes
      null, // customOccasionModifiers
      searchMode,
    );

    // Increment counter after successful search
    incrementGuestSearchCounter(ip, searchMode);

    return res.json(results);
  } catch (err) {
    console.error("Guest find-products error:", err.message);
    return res.status(500).json({ error: "Product search failed" });
  }
});

export default router;
