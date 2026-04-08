import { Router } from "express";
import { randomBytes } from "crypto";
import { requireAuth } from "../middleware/auth.js";
import supabase from "../lib/supabase.js";
import { recordSignal, computePreferenceProfile, getPreferenceProfile } from "../services/preferences.js";

import { FREE_SCAN_LIMIT, FREE_SAVE_LIMIT, FREE_HISTORY_DAYS, FREE_EXTENDED_SEARCH_LIMIT, FREE_FAST_SEARCH_LIMIT } from "../config/limits.js";

const router = Router();

function isSameISOWeek(d1, d2) {
  const getISOWeekStart = (d) => {
    const date = new Date(d);
    const day = date.getUTCDay();
    const diff = (day === 0 ? -6 : 1) - day;
    date.setUTCDate(date.getUTCDate() + diff);
    date.setUTCHours(0, 0, 0, 0);
    return date.getTime();
  };
  return getISOWeekStart(d1) === getISOWeekStart(d2);
}

// ─── GET /api/user/status ───────────────────────────────────
router.get("/status", requireAuth, async (req, res) => {
  try {
    const { data: profile, error } = await supabase
      .from("profiles")
      .select("*")
      .eq("id", req.userId)
      .single();

    if (error || !profile) {
      return res.status(404).json({ error: "Profile not found" });
    }

    let tier = profile.tier;
    if (tier === "trial" && profile.trial_ends_at) {
      if (new Date(profile.trial_ends_at) < new Date()) {
        tier = "expired";
      }
    }

    const thisMonthUTC = new Date().toISOString().slice(0, 7); // YYYY-MM
    const scansToday =
      profile.scans_today_reset?.slice(0, 7) === thisMonthUTC ? (profile.scans_today || 0) : 0;

    const isUnlimited = tier === "pro" || tier === "trial";

    // ─── Compute remaining search counts ──────────────────
    let extendedSearchesRemaining = -1;
    let fastSearchesRemaining = -1;
    if (!isUnlimited) {
      const now = new Date();
      // Extended (weekly reset)
      const storedWeek = profile.extended_searches_week ? new Date(profile.extended_searches_week) : null;
      const sameWeek = storedWeek && isSameISOWeek(storedWeek, now);
      const extUsed = sameWeek ? (profile.extended_searches_count || 0) : 0;
      extendedSearchesRemaining = Math.max(0, FREE_EXTENDED_SEARCH_LIMIT - extUsed);

      // Fast (monthly reset)
      const storedMonth = profile.fast_searches_month ? new Date(profile.fast_searches_month).toISOString().slice(0, 7) : null;
      const currentMonth = now.toISOString().slice(0, 7);
      const sameMonth = storedMonth === currentMonth;
      const fastUsed = sameMonth ? (profile.fast_searches_count || 0) : 0;
      fastSearchesRemaining = Math.max(0, FREE_FAST_SEARCH_LIMIT - fastUsed);
    }

    return res.json({
      tier,
      scans_remaining_today: isUnlimited ? -1 : Math.max(0, FREE_SCAN_LIMIT - scansToday),
      scans_limit: isUnlimited ? -1 : FREE_SCAN_LIMIT,
      saved_count: profile.saved_count || 0,
      saved_limit: isUnlimited ? -1 : FREE_SAVE_LIMIT,
      history_days: isUnlimited ? -1 : FREE_HISTORY_DAYS,
      trial_ends_at: profile.trial_ends_at || null,
      show_ads: tier === "free" || tier === "expired",
      extended_searches_remaining: extendedSearchesRemaining,
      extended_searches_limit: isUnlimited ? -1 : FREE_EXTENDED_SEARCH_LIMIT,
      fast_searches_remaining: fastSearchesRemaining,
      fast_searches_limit: isUnlimited ? -1 : FREE_FAST_SEARCH_LIMIT,
    });
  } catch (err) {
    console.error("User status error:", err.message);
    return res.status(500).json({ error: "Failed to fetch status" });
  }
});

// ─── POST /api/user/avatar ─────────────────────────────────
router.post("/avatar", requireAuth, async (req, res) => {
  try {
    const { image } = req.body;
    if (!image || typeof image !== "string") {
      return res.status(400).json({ error: "Missing image data" });
    }

    // Parse data URI: data:image/jpeg;base64,/9j/4AAQ...
    const match = image.match(/^data:(image\/(jpeg|png|webp));base64,(.+)$/);
    if (!match) {
      return res.status(400).json({ error: "Invalid image format. Expected data:image/{jpeg|png|webp};base64,..." });
    }

    const mimeType = match[1];
    const ext = match[2] === "jpeg" ? "jpg" : match[2];
    const base64Data = match[3];
    const buffer = Buffer.from(base64Data, "base64");

    // Limit to 5MB
    if (buffer.length > 5 * 1024 * 1024) {
      return res.status(400).json({ error: "Image too large. Max 5MB." });
    }

    const fileName = `avatars/${req.userId}.${ext}`;

    // Upsert: overwrite existing avatar
    const { data, error } = await supabase.storage
      .from("scan-images")
      .upload(fileName, buffer, {
        contentType: mimeType,
        upsert: true,
      });

    if (error) {
      console.error("Avatar upload error:", error.message);
      return res.status(500).json({ error: "Failed to upload avatar" });
    }

    // Get public URL
    const { data: urlData } = supabase.storage
      .from("scan-images")
      .getPublicUrl(data.path);

    const avatar_url = urlData?.publicUrl;
    if (!avatar_url) {
      return res.status(500).json({ error: "Failed to get avatar URL" });
    }

    // Update profile
    const { error: updateError } = await supabase
      .from("profiles")
      .update({ avatar_url })
      .eq("id", req.userId);

    if (updateError) {
      console.error("Avatar profile update error:", updateError.message);
      return res.status(500).json({ error: "Failed to update profile" });
    }

    return res.json({ avatar_url });
  } catch (err) {
    console.error("Avatar upload error:", err.message);
    return res.status(500).json({ error: "Failed to upload avatar" });
  }
});

// ─── GET /api/user/profile ──────────────────────────────────
router.get("/profile", requireAuth, async (req, res) => {
  const { data: profile, error } = await supabase
    .from("profiles")
    .select("id, display_name, phone, avatar_url, gender_pref, budget_min, budget_max, size_prefs, tier, created_at, referral_code, bio, style_interests")
    .eq("id", req.userId)
    .single();

  if (error) return res.status(404).json({ error: "Profile not found" });

  if (!profile.referral_code) {
    const code = randomBytes(5).toString("hex").toUpperCase();
    await supabase.from("profiles").update({ referral_code: code }).eq("id", req.userId);
    profile.referral_code = code;
  }

  return res.json(profile);
});

// ─── PATCH /api/user/profile ────────────────────────────────
// Style interests can be categories ("Athletes", "TikTok Creators") or
// specific people names ("Zendaya", "A$AP Rocky") from the onboarding picker.

router.patch("/profile", requireAuth, async (req, res) => {
  const { display_name, phone, avatar_url, gender_pref, budget_min, budget_max, size_prefs, bio, style_interests } = req.body;

  const updates = {};
  if (display_name !== undefined && display_name !== null && String(display_name).length > 50) {
    return res.status(400).json({ error: "Display name must be 50 characters or less" });
  }
  if (display_name !== undefined) updates.display_name = display_name;
  if (phone !== undefined) updates.phone = phone;

  // SECURITY: avatar_url is stored in the DB and later rendered in an <img src>.
  // Reject any URL whose scheme is not http or https to prevent javascript: or data: URIs
  // from being stored and potentially misused by the frontend.
  if (avatar_url !== undefined) {
    if (avatar_url !== null) {
      try {
        const u = new URL(avatar_url);
        if (u.protocol !== "http:" && u.protocol !== "https:") {
          return res.status(400).json({ error: "avatar_url must be an http or https URL" });
        }
      } catch {
        return res.status(400).json({ error: "avatar_url must be a valid URL" });
      }
    }
    updates.avatar_url = avatar_url;
  }

  if (gender_pref !== undefined) updates.gender_pref = gender_pref;

  // SECURITY: Validate budget fields — reject non-numeric values and unsafe ranges.
  if (budget_min !== undefined) {
    if (budget_min !== null) {
      const n = Number(budget_min);
      if (!Number.isFinite(n) || n < 0 || n > 1_000_000) {
        return res.status(400).json({ error: "budget_min must be a number between 0 and 1,000,000" });
      }
      updates.budget_min = n;
    } else {
      updates.budget_min = null;
    }
  }
  if (budget_max !== undefined) {
    if (budget_max !== null) {
      const n = Number(budget_max);
      if (!Number.isFinite(n) || n < 0 || n > 1_000_000) {
        return res.status(400).json({ error: "budget_max must be a number between 0 and 1,000,000" });
      }
      updates.budget_max = n;
    } else {
      updates.budget_max = null;
    }
  }

  if (size_prefs !== undefined) {
    if (typeof size_prefs !== "object" || size_prefs === null || Array.isArray(size_prefs)) {
      return res.status(400).json({ error: "size_prefs must be an object" });
    }
    const ALLOWED_SIZE_KEYS = ["body_type", "fit_style", "shoe_size", "top_size", "bottom_size", "dress_size"];
    const cleaned = {};
    for (const key of ALLOWED_SIZE_KEYS) {
      if (key in size_prefs) {
        const val = size_prefs[key];
        if (typeof val === "string" && val.length <= 50) {
          cleaned[key] = val;
        }
      }
    }
    updates.size_prefs = cleaned;
  }

  if (bio !== undefined) {
    if (bio !== null) {
      if (typeof bio !== "string") {
        return res.status(400).json({ error: "bio must be a string" });
      }
      if (bio.length > 200) {
        return res.status(400).json({ error: "bio must be 200 characters or less" });
      }
      updates.bio = bio;
    } else {
      updates.bio = null;
    }
  }

  if (style_interests !== undefined) {
    if (!Array.isArray(style_interests)) {
      return res.status(400).json({ error: "style_interests must be an array" });
    }
    if (style_interests.length > 12) {
      return res.status(400).json({ error: "style_interests can have at most 12 items" });
    }
    // Validate each entry is a string under 50 chars
    const cleaned = style_interests
      .filter(v => typeof v === "string" && v.trim().length > 0 && v.length <= 50)
      .map(v => v.trim());
    updates.style_interests = cleaned;
  }

  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ error: "No fields to update" });
  }

  const { data, error } = await supabase
    .from("profiles")
    .update(updates)
    .eq("id", req.userId)
    .select()
    .single();

  if (error) return res.status(500).json({ error: "Failed to update profile" });
  return res.json(data);
});

// ─── GET /api/user/history ──────────────────────────────────
router.get("/history", requireAuth, async (req, res) => {
  try {
    const { data: profile } = await supabase
      .from("profiles")
      .select("tier, trial_ends_at")
      .eq("id", req.userId)
      .single();

    let tier = profile?.tier || "free";
    if (tier === "trial" && profile.trial_ends_at && new Date(profile.trial_ends_at) < new Date()) {
      tier = "expired";
    }

    let query = supabase
      .from("scans")
      .select("id, scan_name, image_thumbnail, image_url, detected_gender, summary, items, tiers, verdict, created_at")
      .eq("user_id", req.userId)
      .order("created_at", { ascending: false })
      .limit(50);

    if (tier === "free" || tier === "expired") {
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - FREE_HISTORY_DAYS);
      query = query.gte("created_at", cutoff.toISOString());
    }

    const { data: scans, error } = await query;
    if (error) throw error;

    // Get saved scan IDs so frontend can show which scans are liked
    const { data: savedItems } = await supabase
      .from("saved_items")
      .select("scan_id")
      .eq("user_id", req.userId);

    const savedScanIds = new Set((savedItems || []).map(s => s.scan_id).filter(Boolean));

    const enrichedScans = (scans || []).map(s => ({
      ...s,
      is_saved: savedScanIds.has(s.id),
    }));

    return res.json({ scans: enrichedScans, tier });
  } catch (err) {
    console.error("History error:", err.message);
    return res.status(500).json({ error: "Failed to fetch history" });
  }
});

// ─── PATCH /api/user/scan/:id — Rename a scan ──────────────
router.patch("/scan/:id", requireAuth, async (req, res) => {
  const { id } = req.params;
  const { scan_name } = req.body;

  if (scan_name && scan_name.length > 200) {
    return res.status(400).json({ error: "Scan name must be 200 characters or less" });
  }

  const { data, error } = await supabase
    .from("scans")
    .update({ scan_name: scan_name || null })
    .eq("id", id)
    .eq("user_id", req.userId)
    .select("id, scan_name")
    .single();

  if (error) return res.status(500).json({ error: "Failed to rename scan" });
  if (!data) return res.status(404).json({ error: "Scan not found" });
  return res.json(data);
});

// ─── DELETE /api/user/scan/:id — Remove a scan ─────────────
router.delete("/scan/:id", requireAuth, async (req, res) => {
  const { id } = req.params;

  try {
    // Get the scan to find its image URL for cleanup
    const { data: scan } = await supabase
      .from("scans")
      .select("image_url")
      .eq("id", id)
      .eq("user_id", req.userId)
      .single();

    if (!scan) return res.status(404).json({ error: "Scan not found" });

    // Delete associated saved items first (foreign key)
    await supabase.from("saved_items").delete().eq("scan_id", id);

    // Delete the scan
    const { error } = await supabase.from("scans").delete().eq("id", id).eq("user_id", req.userId);
    if (error) throw error;

    // Clean up storage image (best-effort, don't block response)
    if (scan.image_url) {
      try {
        const path = scan.image_url.split("/scan-images/")[1];
        if (path) await supabase.storage.from("scan-images").remove([path]);
      } catch {}
    }

    return res.json({ message: "Scan deleted" });
  } catch (err) {
    console.error("Delete scan error:", err.message);
    return res.status(500).json({ error: "Failed to delete scan" });
  }
});

// ─── POST /api/user/scan/:id/save — Toggle save on a scan ──
router.post("/scan/:id/save", requireAuth, async (req, res) => {
  const { id } = req.params;

  try {
    const { data: existing } = await supabase
      .from("saved_items")
      .select("id")
      .eq("user_id", req.userId)
      .eq("scan_id", id)
      .maybeSingle();

    if (existing) {
      await supabase.from("saved_items").delete().eq("id", existing.id);
      // Atomic decrement — clamps to 0, no read-modify-write race
      await supabase.rpc("decrement_saved_count", { p_user_id: req.userId });
      return res.json({ saved: false });
    }

    // Check tier before attempting the atomic increment
    const { data: profile } = await supabase
      .from("profiles")
      .select("tier")
      .eq("id", req.userId)
      .single();

    const tier = profile?.tier || "free";

    if (tier === "free" || tier === "expired") {
      // Atomic increment — only succeeds when saved_count < FREE_SAVE_LIMIT
      const { data: newCount } = await supabase.rpc("try_increment_saved_count", {
        p_user_id: req.userId,
        p_limit: FREE_SAVE_LIMIT,
      });
      if (newCount == null) {
        return res.status(429).json({ error: "Save limit reached", message: `You've saved ${FREE_SAVE_LIMIT} items. Go Pro for unlimited.` });
      }
    } else {
      // Pro/trial — no limit, increment unconditionally
      await supabase.rpc("try_increment_saved_count", { p_user_id: req.userId, p_limit: 999999 });
    }

    const { data: scan } = await supabase
      .from("scans")
      .select("items")
      .eq("id", id)
      .eq("user_id", req.userId)
      .single();

    await supabase.from("saved_items").insert({
      user_id: req.userId,
      scan_id: id,
      item_data: scan?.items || null,
    });

    return res.json({ saved: true });
  } catch (err) {
    console.error("Toggle save error:", err.message);
    return res.status(500).json({ error: "Failed to toggle save" });
  }
});

// ─── PATCH /api/user/scan/:id/rating — Rate a scan (1-5 stars) ─
router.patch("/scan/:id/rating", requireAuth, async (req, res) => {
  const { id } = req.params;
  const { rating } = req.body;

  if (rating == null || rating < 1 || rating > 5 || !Number.isInteger(rating)) {
    return res.status(400).json({ error: "rating must be an integer 1–5" });
  }

  const { data, error } = await supabase
    .from("scans")
    .update({ rating })
    .eq("id", id)
    .eq("user_id", req.userId)
    .select("id, rating")
    .single();

  if (error) return res.status(500).json({ error: "Failed to save rating" });
  return res.json(data);
});

// ─── POST /api/user/saved ───────────────────────────────────
router.post("/saved", requireAuth, async (req, res) => {
  const { scan_id, item_data, selected_tier, tier_product } = req.body;

  if (!item_data) {
    return res.status(400).json({ error: "Missing item_data" });
  }

  try {
    const { data: profile } = await supabase
      .from("profiles")
      .select("tier")
      .eq("id", req.userId)
      .single();

    const tier = profile?.tier || "free";

    if (tier === "free" || tier === "expired") {
      // Atomic increment — only succeeds when saved_count < FREE_SAVE_LIMIT
      const { data: newCount } = await supabase.rpc("try_increment_saved_count", {
        p_user_id: req.userId,
        p_limit: FREE_SAVE_LIMIT,
      });
      if (newCount == null) {
        return res.status(429).json({ error: "Save limit reached", message: `You've saved ${FREE_SAVE_LIMIT} items. Go Pro for unlimited.`, upgrade_url: "/subscribe" });
      }
    } else {
      // Pro/trial — no limit, increment unconditionally
      await supabase.rpc("try_increment_saved_count", { p_user_id: req.userId, p_limit: 999999 });
    }

    // SECURITY: Verify scan ownership when scan_id is provided — prevents saving references to other users' scans
    if (scan_id) {
      const { data: scanRow } = await supabase.from("scans").select("id").eq("id", scan_id).eq("user_id", req.userId).single();
      if (!scanRow) {
        // Roll back the increment we just applied
        await supabase.rpc("decrement_saved_count", { p_user_id: req.userId });
        return res.status(403).json({ error: "Scan not found" });
      }
    }

    const { data: saved, error } = await supabase
      .from("saved_items")
      .insert({ user_id: req.userId, scan_id: scan_id || null, item_data, selected_tier: selected_tier || null, tier_product: tier_product || null })
      .select("*")
      .single();

    if (error) throw error;

    return res.json(saved);
  } catch (err) {
    console.error("Save error:", err.message);
    return res.status(500).json({ error: "Failed to save item" });
  }
});

// ─── DELETE /api/user/saved/:id ─────────────────────────────
router.delete("/saved/:id", requireAuth, async (req, res) => {
  const { id } = req.params;

  const { error } = await supabase.from("saved_items").delete().eq("id", id).eq("user_id", req.userId);
  if (error) return res.status(500).json({ error: "Failed to delete saved item" });

  // Atomic decrement — clamps to 0, no read-modify-write race
  await supabase.rpc("decrement_saved_count", { p_user_id: req.userId });

  return res.json({ message: "Removed" });
});

// ─── GET /api/user/streak ───────────────────────────────────
router.get("/streak", requireAuth, async (req, res) => {
  try {
    const { data: scans, error } = await supabase
      .from("scans")
      .select("created_at")
      .eq("user_id", req.userId)
      .order("created_at", { ascending: false });

    if (error) throw error;

    if (!scans || scans.length === 0) {
      return res.json({ streak: 0, last_scan_date: null });
    }

    // Deduplicate to unique YYYY-MM-DD dates (all in UTC to avoid timezone drift)
    const uniqueDates = [...new Set(
      scans.map(s => s.created_at.slice(0, 10))
    )].sort((a, b) => b.localeCompare(a)); // descending

    const todayUtc = new Date().toISOString().slice(0, 10);
    const yesterdayUtc = new Date(Date.now() - 86400000).toISOString().slice(0, 10);

    const lastScanDate = uniqueDates[0];

    // Streak only continues if the user scanned today or yesterday
    if (lastScanDate !== todayUtc && lastScanDate !== yesterdayUtc) {
      return res.json({ streak: 0, last_scan_date: lastScanDate });
    }

    // Walk backwards through consecutive days counting the streak
    let streak = 0;
    // Start from today if they scanned today, otherwise start from yesterday
    let cursor = new Date(lastScanDate === todayUtc ? todayUtc : yesterdayUtc);

    for (const date of uniqueDates) {
      const cursorStr = cursor.toISOString().slice(0, 10);
      if (date === cursorStr) {
        streak++;
        // Move cursor back one day for the next iteration
        cursor = new Date(cursor.getTime() - 86400000);
      } else if (date < cursorStr) {
        // Gap in dates — streak is broken
        break;
      }
      // date > cursorStr means we haven't reached the cursor date yet — skip
    }

    return res.json({ streak, last_scan_date: lastScanDate });
  } catch (err) {
    console.error("Streak error:", err.message);
    return res.status(500).json({ error: "Failed to fetch streak" });
  }
});

// ─── GET /api/user/saved ────────────────────────────────────
router.get("/saved", requireAuth, async (req, res) => {
  const { data: items, error } = await supabase
    .from("saved_items")
    .select("*")
    .eq("user_id", req.userId)
    .order("created_at", { ascending: false });

  if (error) return res.status(500).json({ error: "Failed to fetch saved items" });
  return res.json({ items: items || [] });
});

// ─── PATCH /api/user/scan/:scanId/verdict ───────────────────
router.patch("/scan/:scanId/verdict", requireAuth, async (req, res) => {
  const { scanId } = req.params;
  const { verdict } = req.body;

  // Validate UUID format
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(scanId)) {
    return res.status(400).json({ error: "Invalid scan ID" });
  }

  const validVerdicts = ["would_wear", "on_the_fence", "not_for_me", null];
  if (!validVerdicts.includes(verdict)) {
    return res.status(400).json({ error: "Invalid verdict. Must be: would_wear, on_the_fence, not_for_me, or null" });
  }

  try {
    const { data, error } = await supabase
      .from("scans")
      .update({ verdict })
      .eq("id", scanId)
      .eq("user_id", req.userId)
      .select("id, items")
      .single();

    if (error) throw error;
    if (!data) return res.status(404).json({ error: "Scan not found" });

    // Record preference signals for each item in the scan (non-blocking)
    if (verdict && data.items && Array.isArray(data.items)) {
      Promise.all(data.items.map((item, idx) =>
        recordSignal(req.userId, scanId, idx, verdict, item).catch(() => {})
      )).then(() => {
        // Recompute preference profile after enough signals
        computePreferenceProfile(req.userId).catch(() => {});
      });
    }

    return res.json({ verdict });
  } catch (err) {
    console.error("Verdict error:", err.message);
    if (err.code === "PGRST116") return res.status(404).json({ error: "Scan not found" });
    return res.status(500).json({ error: "Failed to set verdict" });
  }
});

// ─── POST /api/user/preference-signal ───────────────────────
// Record a preference signal for a specific item (per-item verdict)
router.post("/preference-signal", requireAuth, async (req, res) => {
  const { scan_id, item_index, verdict, item_data } = req.body;
  if (!verdict || !["would_wear", "on_the_fence", "not_for_me"].includes(verdict)) {
    return res.status(400).json({ error: "Invalid verdict" });
  }
  try {
    const signal = await recordSignal(req.userId, scan_id || null, item_index ?? 0, verdict, item_data || {});
    return res.json({ signal });
  } catch (err) {
    console.error("Preference signal error:", err.message);
    return res.status(500).json({ error: "Failed to record preference" });
  }
});

// ─── GET /api/user/preferences ──────────────────────────────
// Return the user's computed preference profile
router.get("/preferences", requireAuth, async (req, res) => {
  try {
    const profile = await getPreferenceProfile(req.userId);
    return res.json({ preferences: profile });
  } catch (err) {
    console.error("Preferences error:", err.message);
    return res.status(500).json({ error: "Failed to get preferences" });
  }
});

export default router;
