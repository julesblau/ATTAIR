import { Router } from "express";
import { optionalAuth } from "../middleware/auth.js";
import supabase from "../lib/supabase.js";

const router = Router();

/**
 * POST /api/events
 *
 * Accepts a single event object OR an array of events (for batching).
 * Uses optionalAuth — works for anonymous users too (user_id will be null).
 * Always returns immediately (fire-and-forget writes).
 *
 * Request body (single): { event_type, event_data, scan_id, page, session_id }
 * Request body (array):  [ { event_type, ... }, ... ]
 */
router.post("/", optionalAuth, async (req, res) => {
  const body = req.body;
  const events = Array.isArray(body) ? body : [body];

  const rows = events
    .filter(e => e && typeof e.event_type === "string" && e.event_type.length > 0)
    .map(e => ({
      user_id: req.userId || null,
      session_id: e.session_id || null,
      event_type: e.event_type,
      event_data: e.event_data && typeof e.event_data === "object" ? e.event_data : {},
      scan_id: e.scan_id || null,
      page: e.page || null,
    }));

  if (rows.length === 0) {
    return res.status(400).json({ error: "No valid events provided" });
  }

  // Insert events — fire-and-forget, don't block the response
  supabase.from("user_events").insert(rows).catch(() => {});

  // Update last_active_at for authenticated users (best-effort)
  if (req.userId) {
    supabase
      .from("profiles")
      .update({ last_active_at: new Date().toISOString() })
      .eq("id", req.userId)
      .catch(() => {});
  }

  return res.json({ ok: true });
});

export default router;
