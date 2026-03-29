/**
 * aiContent.js — Admin routes for AI content management.
 *
 * All routes require CRON_SECRET for authorization.
 *
 * POST /api/ai-content/schedule   — Schedule posts for a target date
 * POST /api/ai-content/publish    — Publish all due posts now
 * GET  /api/ai-content/stats      — Get content queue stats
 */

import { Router } from "express";
import { scheduleContent, publishDuePosts, getContentStats } from "../services/aiContent.js";

const router = Router();

/**
 * Auth check — all AI content routes require CRON_SECRET.
 */
function requireCronSecret(req, res, next) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return res.status(503).json({ error: "AI content endpoints not configured (CRON_SECRET missing)" });
  }

  const authHeader = req.headers.authorization;
  const provided = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;

  if (!provided || provided !== cronSecret) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  next();
}

// ─── POST /api/ai-content/schedule ────────────────────────────
router.post("/schedule", requireCronSecret, async (req, res) => {
  const { date, posts_per_account } = req.body;

  // Default to today if no date provided
  const targetDate = date || new Date().toISOString().split("T")[0];
  const postsPerAccount = Math.min(10, Math.max(1, parseInt(posts_per_account) || 3));

  try {
    const result = await scheduleContent(targetDate, postsPerAccount);
    res.json({ success: true, ...result, target_date: targetDate, posts_per_account: postsPerAccount });
  } catch (err) {
    console.error("[AI Content] Schedule error:", err.message);
    res.status(500).json({ error: "Failed to schedule content" });
  }
});

// ─── POST /api/ai-content/publish ─────────────────────────────
router.post("/publish", requireCronSecret, async (req, res) => {
  // Return immediately, run in background
  res.status(202).json({ success: true, message: "Publishing started" });

  try {
    const result = await publishDuePosts();
    console.log("[AI Content] Publish result:", JSON.stringify(result));
  } catch (err) {
    console.error("[AI Content] Publish error:", err.message);
  }
});

// ─── GET /api/ai-content/stats ────────────────────────────────
router.get("/stats", requireCronSecret, async (req, res) => {
  try {
    const stats = await getContentStats();
    res.json({ success: true, ...stats });
  } catch (err) {
    console.error("[AI Content] Stats error:", err.message);
    res.status(500).json({ error: "Failed to get stats" });
  }
});

export default router;
