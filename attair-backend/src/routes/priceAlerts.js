/**
 * priceAlerts.js — Price Drop Alerts routes for ATTAIR Pro subscribers.
 *
 * GET  /api/price-alerts          — List user's alerts, newest first (Pro only)
 * GET  /api/price-alerts/count    — Unseen alert count for badge display (auth required)
 * PATCH /api/price-alerts/:id/seen — Mark a single alert as seen (auth required)
 * POST /api/price-alerts/check    — Trigger the price check job (admin/cron only)
 */

import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import supabase from "../lib/supabase.js";
import { checkPriceDrops } from "../jobs/priceCheck.js";

const router = Router();

// ─── Pro gate helper ─────────────────────────────────────────────────────────

/**
 * Returns true if the profile's tier grants Pro-level access.
 * Handles trial expiry at the route boundary so we don't need a cron to downgrade.
 */
function isProActive(profile) {
  if (!profile) return false;
  if (profile.tier === "pro") return true;
  if (profile.tier === "trial" && profile.trial_ends_at) {
    return new Date(profile.trial_ends_at) > new Date();
  }
  return false;
}

// ─── GET /api/price-alerts ───────────────────────────────────────────────────

router.get("/", requireAuth, async (req, res) => {
  try {
    // Verify Pro status
    const { data: profile, error: profileError } = await supabase
      .from("profiles")
      .select("tier, trial_ends_at")
      .eq("id", req.userId)
      .single();

    if (profileError || !profile) {
      return res.status(404).json({ error: "Profile not found" });
    }

    if (!isProActive(profile)) {
      return res.status(403).json({ error: "Price Drop Alerts is a Pro feature. Upgrade to access it." });
    }

    const { data: alerts, error } = await supabase
      .from("price_alerts")
      .select("id, saved_item_id, product_name, brand, original_price, current_price, drop_percentage, product_url, detected_at, seen")
      .eq("user_id", req.userId)
      .order("detected_at", { ascending: false })
      .limit(50);

    if (error) throw error;

    return res.json({ success: true, data: alerts || [] });
  } catch (err) {
    console.error("[priceAlerts] GET / error:", err.message);
    return res.status(500).json({ error: "Failed to fetch price alerts" });
  }
});

// ─── GET /api/price-alerts/count ────────────────────────────────────────────
// Must be defined before /:id routes to avoid Express treating "count" as an id.

router.get("/count", requireAuth, async (req, res) => {
  try {
    const { count, error } = await supabase
      .from("price_alerts")
      .select("id", { count: "exact", head: true })
      .eq("user_id", req.userId)
      .eq("seen", false);

    if (error) throw error;

    return res.json({ success: true, data: { unseen_count: count ?? 0 } });
  } catch (err) {
    console.error("[priceAlerts] GET /count error:", err.message);
    return res.status(500).json({ error: "Failed to fetch alert count" });
  }
});

// ─── PATCH /api/price-alerts/:id/seen ───────────────────────────────────────

router.patch("/:id/seen", requireAuth, async (req, res) => {
  const { id } = req.params;

  // Validate UUID format
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    return res.status(400).json({ error: "Invalid alert ID" });
  }

  try {
    const { data, error } = await supabase
      .from("price_alerts")
      .update({ seen: true })
      .eq("id", id)
      .eq("user_id", req.userId)  // enforce ownership
      .select("id, seen")
      .single();

    if (error) {
      // PGRST116 = no rows matched — either not found or wrong user
      if (error.code === "PGRST116") {
        return res.status(404).json({ error: "Alert not found" });
      }
      throw error;
    }

    return res.json({ success: true, data });
  } catch (err) {
    console.error("[priceAlerts] PATCH /:id/seen error:", err.message);
    return res.status(500).json({ error: "Failed to mark alert as seen" });
  }
});

// ─── POST /api/price-alerts/check ───────────────────────────────────────────
// Admin/cron trigger. Protected by a shared secret (CRON_SECRET env var).
// Call with: Authorization: Bearer <CRON_SECRET>

router.post("/check", async (req, res) => {
  const cronSecret = process.env.CRON_SECRET;

  // If CRON_SECRET is set, require it. If unset, block the endpoint entirely
  // to avoid accidental open access in production.
  if (!cronSecret) {
    console.error("[priceAlerts] POST /check called but CRON_SECRET is not set — rejecting");
    return res.status(503).json({ error: "Price check endpoint is not configured" });
  }

  const authHeader = req.headers.authorization;
  const provided = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;

  if (!provided || provided !== cronSecret) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  // Run the job asynchronously so Railway's 30s request timeout isn't a problem
  // for large user bases. We return 202 immediately and log results when done.
  res.status(202).json({ success: true, message: "Price check job started" });

  try {
    const summary = await checkPriceDrops();
    console.log("[priceAlerts] POST /check job complete:", JSON.stringify(summary));
  } catch (err) {
    console.error("[priceAlerts] POST /check job error:", err.message);
  }
});

export default router;
