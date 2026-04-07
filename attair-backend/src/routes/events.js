import { Router } from "express";
import rateLimit from "express-rate-limit";
import { optionalAuth } from "../middleware/auth.js";
import supabase from "../lib/supabase.js";

const router = Router();

const EVENTS_MAX_BATCH = 50;
const EVENT_NAME_MAX_LEN = 100;
const EVENT_METADATA_MAX_BYTES = 1024; // 1 KB

// 10 requests per minute per IP on the events endpoint
const eventsLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many event requests, please slow down" },
});

/**
 * POST /api/events
 *
 * Accepts a single event object OR an array of events (for batching).
 * Uses optionalAuth — works for anonymous users too (user_id will be null).
 * Always returns immediately (fire-and-forget writes).
 *
 * Request body (single): { event_type, event_data, scan_id, page, session_id }
 * Request body (array):  [ { event_type, ... }, ... ]
 *
 * Limits: max 50 events per request, event_name <= 100 chars, metadata <= 1 KB.
 */
router.post("/", eventsLimiter, optionalAuth, async (req, res) => {
  const body = req.body;
  const rawEvents = Array.isArray(body) ? body : [body];

  // Validate batch is non-empty
  if (rawEvents.length === 0) {
    return res.status(400).json({ error: "events must be a non-empty array" });
  }

  // Cap batch size
  if (rawEvents.length > EVENTS_MAX_BATCH) {
    return res.status(400).json({ error: `Maximum ${EVENTS_MAX_BATCH} events per request` });
  }

  // Validate each event has a valid event_type
  for (const event of rawEvents) {
    if (!event || typeof event.event_type !== "string" || event.event_type.length === 0 || event.event_type.length > EVENT_NAME_MAX_LEN) {
      return res.status(400).json({ error: "Each event must have an event_type (string, max 100 chars)" });
    }
    if (event.event_data && typeof event.event_data === "object") {
      const serialised = JSON.stringify(event.event_data);
      if (Buffer.byteLength(serialised, "utf8") > EVENT_METADATA_MAX_BYTES) {
        return res.status(400).json({ error: "event_data exceeds maximum size (1 KB)" });
      }
    }
  }

  const events = rawEvents;

  const rows = events
    .filter(e => e && typeof e.event_type === "string" && e.event_type.length > 0)
    .map(e => {
      // Truncate event_type to the allowed maximum
      const eventType = e.event_type.slice(0, EVENT_NAME_MAX_LEN);

      // Truncate metadata: serialise, check byte length, fall back to empty object
      let eventData = {};
      if (e.event_data && typeof e.event_data === "object") {
        const serialised = JSON.stringify(e.event_data);
        if (Buffer.byteLength(serialised, "utf8") <= EVENT_METADATA_MAX_BYTES) {
          eventData = e.event_data;
        }
        // If over 1 KB, silently drop the metadata to prevent DB bloat
      }

      return {
        user_id: req.userId || null,
        session_id: e.session_id || null,
        event_type: eventType,
        event_data: eventData,
        scan_id: e.scan_id || null,
        page: e.page || null,
      };
    });

  if (rows.length === 0) {
    return res.status(400).json({ error: "No valid events provided" });
  }

  // Insert events — fire-and-forget, don't block the response
  (async () => { try { await supabase.from("user_events").insert(rows); } catch {} })();

  // Update last_active_at for authenticated users (best-effort)
  if (req.userId) {
    (async () => {
      try {
        await supabase.from("profiles").update({ last_active_at: new Date().toISOString() }).eq("id", req.userId);
      } catch {}
    })();
  }

  return res.json({ ok: true });
});

export default router;
