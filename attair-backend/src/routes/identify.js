import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import { scanRateLimit, incrementScanCount } from "../middleware/rateLimit.js";
import { identifyClothing } from "../services/claude.js";
import supabase from "../lib/supabase.js";
import { v4 as uuidv4 } from "uuid";
import { FREE_SCAN_LIMIT } from "../config/limits.js";

const router = Router();

// Dedup logic
function dedup(items) {
  const slots = {};
  for (const item of items) {
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
  return Object.values(slots);
}

/**
 * Upload image to Supabase Storage, return public URL.
 * Falls back gracefully — if storage fails, returns null.
 */
async function uploadImage(base64, mimeType, userId) {
  try {
    const ext = mimeType === "image/png" ? "png" : "jpg";
    const fileName = `${userId}/${uuidv4()}.${ext}`;
    const buffer = Buffer.from(base64, "base64");

    const { data, error } = await supabase.storage
      .from("scan-images")
      .upload(fileName, buffer, {
        contentType: mimeType,
        upsert: false,
      });

    if (error) {
      console.error("Storage upload error:", error.message);
      return null;
    }

    // Get public URL
    const { data: urlData } = supabase.storage
      .from("scan-images")
      .getPublicUrl(data.path);

    return urlData?.publicUrl || null;
  } catch (err) {
    console.error("Image upload failed:", err.message);
    return null;
  }
}

router.post("/", requireAuth, scanRateLimit, async (req, res) => {
  const { image, mime_type, user_prefs, priority_region_base64 } = req.body;

  if (!image) {
    return res.status(400).json({ error: "Missing image field (base64)" });
  }

  if (typeof image !== "string" || image.length < 100) {
    return res.status(400).json({ error: "Invalid image data" });
  }

  const ALLOWED_MIME_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"];
  if (mime_type && !ALLOWED_MIME_TYPES.includes(mime_type)) {
    return res.status(400).json({ error: "Invalid image type. Allowed: jpeg, png, webp, gif" });
  }

  const cleanImage = image.startsWith("data:") ? image.split(",")[1] || image : image;

  if (!/^[A-Za-z0-9+/=\s]+$/.test(cleanImage.slice(0, 200))) {
    return res.status(400).json({ error: "Invalid base64 encoding" });
  }

  // SECURITY: Enforce a size cap on the optional priority region so a client cannot send
  // a near-10MB second image and double the Anthropic API cost / request size.
  // 1.5 MB of base64 encodes roughly 1.1 MB of binary — sufficient for a cropped region.
  const MAX_PRIORITY_B64_CHARS = 2_000_000; // ~1.5 MB base64
  if (priority_region_base64 && (typeof priority_region_base64 !== "string" || priority_region_base64.length > MAX_PRIORITY_B64_CHARS)) {
    return res.status(400).json({ error: "priority_region_base64 exceeds maximum allowed size" });
  }

  const mimeType = mime_type || "image/jpeg";
  const prefs = user_prefs || {};

  // Merge profile preferences as defaults
  if (!prefs.gender && req.profile.gender_pref) prefs.gender = req.profile.gender_pref;
  // Pass budget range to the AI prompt for better price estimates
  if (req.profile.budget_min != null) prefs.budget_min = req.profile.budget_min;
  if (req.profile.budget_max != null) prefs.budget_max = req.profile.budget_max;

  try {
    // 1. Upload full-res image to Supabase Storage (async, don't block)
    // Race against a 30s timeout so a stalled upload never hangs the request
    const imageUrlPromise = Promise.race([
      uploadImage(cleanImage, mimeType, req.userId),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Image upload timeout')), 30000))
    ]).catch(err => {
      console.error('[Identify] Image upload failed:', err.message);
      return null; // Continue without image URL
    });

    // 2. Call Claude (runs in parallel with upload)
    const raw = await identifyClothing(cleanImage, mimeType, prefs, priority_region_base64);

    // 3. Dedup & sort
    let items = dedup(raw.items || []);
    items.sort((a, b) => (a.position_y || 0.5) - (b.position_y || 0.5));

    // 4. Increment scan count — skip if scanRateLimit already did it atomically
    const newCount = req.scanAlreadyIncremented
      ? req.profile.scans_today
      : await incrementScanCount(req.userId);

    // 5. Wait for image upload
    const imageUrl = await imageUrlPromise;

    // 6. Persist scan
    const scanRecord = {
      user_id: req.userId,
      image_url: imageUrl,
      image_thumbnail: null,
      detected_gender: raw.gender || "male",
      summary: raw.summary || "",
      items,
      tiers: null,
    };

    const { data: scan, error: scanErr } = await supabase
      .from("scans")
      .insert(scanRecord)
      .select("id")
      .single();

    if (scanErr) console.error("Scan save error:", scanErr.message);

    // 7. Calculate remaining scans
    const tier = req.profile.tier;
    const isUnlimited = tier === "pro" || tier === "trial";
    const scansRemaining = isUnlimited ? -1 : Math.max(0, FREE_SCAN_LIMIT - newCount);

    return res.json({
      scan_id: scan?.id || null,
      image_url: imageUrl,
      gender: raw.gender || "male",
      summary: raw.summary || "",
      items,
      user_scans_remaining: scansRemaining,
      user_tier: tier,
    });
  } catch (err) {
    // SECURITY: Do not forward err.message to the client — it can contain Anthropic API error
    // bodies, internal paths, or DB details. Log server-side only.
    console.error("Identify error:", err.message);
    return res.status(500).json({ error: "Identification failed" });
  }
});

export default router;
