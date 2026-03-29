/**
 * notifications.js — Push notification routes for ATTAIRE.
 *
 * POST   /api/notifications/subscribe     — Save a push subscription
 * DELETE /api/notifications/unsubscribe   — Remove a push subscription
 * GET    /api/notifications               — Get recent notifications
 * GET    /api/notifications/unread-count  — Get unread notification count
 * PATCH  /api/notifications/read          — Mark notifications as read
 * GET    /api/notifications/vapid-key     — Get VAPID public key for frontend
 * PATCH  /api/notifications/preferences   — Update notification preferences
 */

import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import {
  saveSubscription,
  removeSubscription,
  getNotifications,
  getUnreadCount,
  markRead,
  getVapidPublicKey,
} from "../services/notifications.js";
import supabase from "../lib/supabase.js";

const router = Router();

// ─── GET /api/notifications/vapid-key ─────────────────────────
// Public — frontend needs this to subscribe to push
router.get("/vapid-key", (req, res) => {
  const key = getVapidPublicKey();
  if (!key) {
    return res.status(503).json({ error: "Push notifications not configured" });
  }
  res.json({ vapidPublicKey: key });
});

// ─── POST /api/notifications/subscribe ────────────────────────
router.post("/subscribe", requireAuth, async (req, res) => {
  const { subscription } = req.body;

  if (!subscription || !subscription.endpoint) {
    return res.status(400).json({ error: "Invalid subscription object" });
  }

  try {
    await saveSubscription(req.userId, subscription);
    res.json({ success: true });
  } catch (err) {
    console.error("[Notifications] Subscribe error:", err.message);
    res.status(400).json({ error: err.message });
  }
});

// ─── DELETE /api/notifications/unsubscribe ────────────────────
router.delete("/unsubscribe", requireAuth, async (req, res) => {
  const { endpoint } = req.body;

  if (!endpoint) {
    return res.status(400).json({ error: "Missing endpoint" });
  }

  try {
    await removeSubscription(req.userId, endpoint);
    res.json({ success: true });
  } catch (err) {
    console.error("[Notifications] Unsubscribe error:", err.message);
    res.status(500).json({ error: "Failed to unsubscribe" });
  }
});

// ─── GET /api/notifications ───────────────────────────────────
router.get("/", requireAuth, async (req, res) => {
  const limit = Math.min(50, Math.max(1, parseInt(req.query.limit) || 20));

  try {
    const notifications = await getNotifications(req.userId, limit);
    res.json({ notifications });
  } catch (err) {
    console.error("[Notifications] Fetch error:", err.message);
    res.status(500).json({ error: "Failed to fetch notifications" });
  }
});

// ─── GET /api/notifications/unread-count ──────────────────────
router.get("/unread-count", requireAuth, async (req, res) => {
  try {
    const count = await getUnreadCount(req.userId);
    res.json({ count });
  } catch (err) {
    console.error("[Notifications] Count error:", err.message);
    res.status(500).json({ error: "Failed to get unread count" });
  }
});

// ─── PATCH /api/notifications/read ────────────────────────────
router.patch("/read", requireAuth, async (req, res) => {
  const { notificationIds } = req.body;

  if (!Array.isArray(notificationIds) || notificationIds.length === 0) {
    return res.status(400).json({ error: "notificationIds must be a non-empty array" });
  }

  if (notificationIds.length > 100) {
    return res.status(400).json({ error: "Too many IDs (max 100)" });
  }

  try {
    await markRead(req.userId, notificationIds);
    res.json({ success: true });
  } catch (err) {
    console.error("[Notifications] Mark read error:", err.message);
    res.status(500).json({ error: "Failed to mark notifications as read" });
  }
});

// ─── PATCH /api/notifications/preferences ─────────────────────
router.patch("/preferences", requireAuth, async (req, res) => {
  const { preferences } = req.body;

  if (!preferences || typeof preferences !== "object") {
    return res.status(400).json({ error: "preferences must be an object" });
  }

  // Only allow known preference keys
  const ALLOWED_KEYS = ["price_drops", "style_dna", "social_activity", "new_posts", "weekly_digest"];
  const sanitized = {};
  for (const key of ALLOWED_KEYS) {
    if (key in preferences) {
      sanitized[key] = Boolean(preferences[key]);
    }
  }

  try {
    // Merge with existing prefs
    const { data: profile } = await supabase
      .from("profiles")
      .select("notification_prefs")
      .eq("id", req.userId)
      .single();

    const current = profile?.notification_prefs || {};
    const merged = { ...current, ...sanitized };

    const { error } = await supabase
      .from("profiles")
      .update({ notification_prefs: merged })
      .eq("id", req.userId);

    if (error) throw error;

    res.json({ success: true, preferences: merged });
  } catch (err) {
    console.error("[Notifications] Preferences error:", err.message);
    res.status(500).json({ error: "Failed to update preferences" });
  }
});

export default router;
