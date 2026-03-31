/**
 * ootw.js — Outfit of the Week routes for ATTAIRE.
 *
 * GET  /api/ootw/current              — Get the current week's OOTW (auth required)
 * POST /api/ootw/generate             — Trigger OOTW generation (cron/admin)
 * POST /api/ootw/weekly-reports       — Trigger Sunday style reports for Pro users (cron/admin)
 * GET  /api/ootw/:id                  — Get a specific OOTW by ID (auth required)
 */

import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import supabase from "../lib/supabase.js";
import {
  generateOutfitOfTheWeek,
  sendWeeklyStyleReports,
  getCurrentWeekMonday,
} from "../jobs/outfitOfTheWeek.js";

const router = Router();

// ─── GET /api/ootw/current ──────────────────────────────────────────────────
// Returns the current week's OOTW with enriched scan data.
router.get("/current", requireAuth, async (req, res) => {
  try {
    const weekStart = getCurrentWeekMonday();

    const { data: ootw, error } = await supabase
      .from("outfit_of_the_week")
      .select("*")
      .eq("week_start", weekStart)
      .maybeSingle();

    if (error) throw error;
    if (!ootw) {
      return res.json({ ootw: null });
    }

    // Increment view count atomically (non-blocking)
    supabase
      .rpc("increment_ootw_view_count", { ootw_id: ootw.id })
      .then(() => {})
      .catch((err) => console.warn("[OOTW] View count increment failed (non-critical):", err.message));

    // Enrich scan data — fetch the actual scans
    const scanIds = ootw.scan_ids || [];
    let scans = [];

    if (scanIds.length > 0) {
      const { data: scanData } = await supabase
        .from("scans")
        .select("id, user_id, image_url, summary, items, created_at")
        .in("id", scanIds);

      if (scanData) {
        // Get profiles and save counts
        const userIds = [...new Set(scanData.map(s => s.user_id))];

        let profiles = [];
        let saveRows = [];

        if (userIds.length > 0) {
          const [profileResult, saveResult] = await Promise.all([
            supabase.from("profiles").select("id, display_name, avatar_url").in("id", userIds),
            supabase.from("saved_items").select("scan_id").in("scan_id", scanIds),
          ]);

          if (profileResult.error) {
            console.error("[OOTW] Profile fetch error:", profileResult.error.message);
          } else {
            profiles = profileResult.data || [];
          }

          if (saveResult.error) {
            console.error("[OOTW] Save count fetch error:", saveResult.error.message);
          } else {
            saveRows = saveResult.data || [];
          }
        }

        const profileMap = {};
        profiles.forEach(p => { profileMap[p.id] = p; });

        const saveCountMap = {};
        saveRows.forEach(row => {
          if (row.scan_id) saveCountMap[row.scan_id] = (saveCountMap[row.scan_id] || 0) + 1;
        });

        // Maintain the original ranking order
        const scanMap = {};
        scanData.forEach(s => { scanMap[s.id] = s; });

        scans = scanIds
          .map(id => scanMap[id])
          .filter(Boolean)
          .map(s => ({
            id: s.id,
            image_url: s.image_url,
            summary: s.summary,
            item_count: Array.isArray(s.items) ? s.items.length : 0,
            items: s.items,
            created_at: s.created_at,
            save_count: saveCountMap[s.id] || 0,
            user: profileMap[s.user_id] || { display_name: "Anonymous" },
          }));
      }
    }

    return res.json({
      ootw: {
        id: ootw.id,
        week_start: ootw.week_start,
        headline: ootw.headline,
        editorial: ootw.editorial,
        cover_image: ootw.cover_image,
        view_count: ootw.view_count || 0,
        generated_at: ootw.generated_at,
        scans,
      },
    });
  } catch (err) {
    console.error("[OOTW] Current fetch error:", err.message);
    return res.status(500).json({ error: "Failed to fetch Outfit of the Week" });
  }
});

// ─── GET /api/ootw/my-report ───────────────────────────────────────────────
// Returns the current user's personalized Weekly Style Report (3 looks).
// Pro/trial users only. Returns null if no report exists for this week.
router.get("/my-report", requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    const weekStart = getCurrentWeekMonday();

    // Check user tier
    const { data: profile } = await supabase
      .from("profiles")
      .select("tier, trial_ends_at")
      .eq("id", userId)
      .maybeSingle();

    const isPro = profile && (
      profile.tier === "pro" ||
      (profile.tier === "trial" && profile.trial_ends_at && new Date(profile.trial_ends_at) > new Date())
    );

    if (!isPro) {
      return res.json({ report: null, reason: "not_pro" });
    }

    // Fetch user's report for this week
    const { data: report, error } = await supabase
      .from("weekly_style_reports")
      .select("*")
      .eq("user_id", userId)
      .eq("week_start", weekStart)
      .maybeSingle();

    if (error) throw error;
    if (!report) {
      return res.json({ report: null });
    }

    // Enrich scan data
    const scanIds = report.scan_ids || [];
    let scans = [];

    if (scanIds.length > 0) {
      const { data: scanData } = await supabase
        .from("scans")
        .select("id, user_id, image_url, summary, items, created_at")
        .in("id", scanIds);

      if (scanData) {
        const userIds = [...new Set(scanData.map(s => s.user_id))];

        let profiles = [];
        let saveRows = [];

        if (userIds.length > 0) {
          const [profileResult, saveResult] = await Promise.all([
            supabase.from("profiles").select("id, display_name, avatar_url").in("id", userIds),
            supabase.from("saved_items").select("scan_id").in("scan_id", scanIds),
          ]);

          if (profileResult.error) {
            console.error("[WeeklyReport] Profile fetch error:", profileResult.error.message);
          } else {
            profiles = profileResult.data || [];
          }

          if (saveResult.error) {
            console.error("[WeeklyReport] Save count fetch error:", saveResult.error.message);
          } else {
            saveRows = saveResult.data || [];
          }
        }

        const profileMap = {};
        profiles.forEach(p => { profileMap[p.id] = p; });

        const saveCountMap = {};
        saveRows.forEach(row => {
          if (row.scan_id) saveCountMap[row.scan_id] = (saveCountMap[row.scan_id] || 0) + 1;
        });

        // Maintain original order
        const scanMap = {};
        scanData.forEach(s => { scanMap[s.id] = s; });

        scans = scanIds
          .map(id => scanMap[id])
          .filter(Boolean)
          .map(s => ({
            id: s.id,
            image_url: s.image_url,
            summary: s.summary,
            item_count: Array.isArray(s.items) ? s.items.length : 0,
            items: s.items,
            created_at: s.created_at,
            save_count: saveCountMap[s.id] || 0,
            user: profileMap[s.user_id] || { display_name: "Anonymous" },
          }));
      }
    }

    // Mark as opened if not already
    if (!report.opened_at) {
      supabase
        .from("weekly_style_reports")
        .update({ opened_at: new Date().toISOString() })
        .eq("id", report.id)
        .then(() => {})
        .catch(err => console.warn("[WeeklyReport] opened_at update failed (non-critical):", err.message));
    }

    return res.json({
      report: {
        id: report.id,
        week_start: report.week_start,
        sent_at: report.sent_at,
        scans,
      },
    });
  } catch (err) {
    console.error("[WeeklyReport] my-report error:", err.message);
    return res.status(500).json({ error: "Failed to fetch your weekly report" });
  }
});

// ─── GET /api/ootw/:id ──────────────────────────────────────────────────────
router.get("/:id", requireAuth, async (req, res) => {
  const { id } = req.params;

  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    return res.status(400).json({ error: "Invalid ID" });
  }

  try {
    const { data: ootw, error } = await supabase
      .from("outfit_of_the_week")
      .select("*")
      .eq("id", id)
      .single();

    if (error || !ootw) {
      return res.status(404).json({ error: "Not found" });
    }

    return res.json({ ootw });
  } catch (err) {
    console.error("[OOTW] Fetch error:", err.message);
    return res.status(500).json({ error: "Failed to fetch OOTW" });
  }
});

// ─── POST /api/ootw/generate ────────────────────────────────────────────────
// Trigger OOTW generation — protected by cron key in production.
router.post("/generate", async (req, res) => {
  const cronKey = req.headers["x-cron-key"];
  if (cronKey !== process.env.CRON_SECRET_KEY && process.env.NODE_ENV === "production") {
    return res.status(403).json({ error: "Unauthorized" });
  }

  try {
    const result = await generateOutfitOfTheWeek();
    return res.json(result);
  } catch (err) {
    console.error("[OOTW] Generation error:", err.message);
    return res.status(500).json({ error: "Failed to generate Outfit of the Week. Please try again later." });
  }
});

// ─── POST /api/ootw/weekly-reports ──────────────────────────────────────────
// Trigger Sunday weekly style reports — protected by cron key in production.
router.post("/weekly-reports", async (req, res) => {
  const cronKey = req.headers["x-cron-key"];
  if (cronKey !== process.env.CRON_SECRET_KEY && process.env.NODE_ENV === "production") {
    return res.status(403).json({ error: "Unauthorized" });
  }

  try {
    const summary = await sendWeeklyStyleReports();
    return res.json(summary);
  } catch (err) {
    console.error("[WeeklyReport] Error:", err.message);
    return res.status(500).json({ error: "Failed to send weekly style reports. Please try again later." });
  }
});

export default router;
