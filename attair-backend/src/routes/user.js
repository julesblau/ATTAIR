import { Router } from "express";
import { randomBytes } from "crypto";
import { requireAuth } from "../middleware/auth.js";
import supabase from "../lib/supabase.js";

const router = Router();

const FREE_SCAN_LIMIT = 12;
const FREE_SAVE_LIMIT = 20;
const FREE_HISTORY_DAYS = 7;

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

    return res.json({
      tier,
      scans_remaining_today: isUnlimited ? -1 : Math.max(0, FREE_SCAN_LIMIT - scansToday),
      scans_limit: isUnlimited ? -1 : FREE_SCAN_LIMIT,
      saved_count: profile.saved_count || 0,
      saved_limit: isUnlimited ? -1 : FREE_SAVE_LIMIT,
      history_days: isUnlimited ? -1 : FREE_HISTORY_DAYS,
      trial_ends_at: profile.trial_ends_at || null,
      show_ads: tier === "free" || tier === "expired",
    });
  } catch (err) {
    console.error("User status error:", err.message);
    return res.status(500).json({ error: "Failed to fetch status" });
  }
});

// ─── GET /api/user/profile ──────────────────────────────────
router.get("/profile", requireAuth, async (req, res) => {
  const { data: profile, error } = await supabase
    .from("profiles")
    .select("id, display_name, phone, avatar_url, gender_pref, budget_min, budget_max, size_prefs, tier, created_at, referral_code")
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
router.patch("/profile", requireAuth, async (req, res) => {
  const { display_name, phone, avatar_url, gender_pref, budget_min, budget_max, size_prefs } = req.body;

  const updates = {};
  if (display_name !== undefined && display_name.length > 100) {
    return res.status(400).json({ error: "Display name must be 100 characters or less" });
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
      .select("id, scan_name, image_thumbnail, image_url, detected_gender, summary, items, tiers, created_at")
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
      const { data: profile } = await supabase
        .from("profiles")
        .select("saved_count")
        .eq("id", req.userId)
        .single();
      await supabase
        .from("profiles")
        .update({ saved_count: Math.max(0, (profile?.saved_count || 1) - 1) })
        .eq("id", req.userId);
      return res.json({ saved: false });
    }

    const { data: profile } = await supabase
      .from("profiles")
      .select("tier, saved_count")
      .eq("id", req.userId)
      .single();

    const tier = profile?.tier || "free";
    if ((tier === "free" || tier === "expired") && (profile.saved_count || 0) >= FREE_SAVE_LIMIT) {
      return res.status(429).json({ error: "Save limit reached", message: `You've saved ${FREE_SAVE_LIMIT} items. Go Pro for unlimited.` });
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

    await supabase
      .from("profiles")
      .update({ saved_count: (profile.saved_count || 0) + 1 })
      .eq("id", req.userId);

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
      .select("tier, saved_count")
      .eq("id", req.userId)
      .single();

    const tier = profile?.tier || "free";
    if ((tier === "free" || tier === "expired") && (profile.saved_count || 0) >= FREE_SAVE_LIMIT) {
      return res.status(429).json({ error: "Save limit reached", message: `You've saved ${FREE_SAVE_LIMIT} items. Go Pro for unlimited.`, upgrade_url: "/subscribe" });
    }

    const { data: saved, error } = await supabase
      .from("saved_items")
      .insert({ user_id: req.userId, scan_id: scan_id || null, item_data, selected_tier: selected_tier || null, tier_product: tier_product || null })
      .select("id")
      .single();

    if (error) throw error;

    await supabase.from("profiles").update({ saved_count: (profile.saved_count || 0) + 1 }).eq("id", req.userId);

    return res.json({ id: saved.id, message: "Saved" });
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

  const { data: profile } = await supabase.from("profiles").select("saved_count").eq("id", req.userId).single();
  await supabase.from("profiles").update({ saved_count: Math.max(0, (profile?.saved_count || 1) - 1) }).eq("id", req.userId);

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

export default router;
