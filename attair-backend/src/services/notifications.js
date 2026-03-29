import webpush from "web-push";
import supabase from "../lib/supabase.js";

/**
 * ATTAIRE Push Notification Service
 *
 * Handles: push subscription management, sending notifications,
 * notification preferences, and notification log.
 *
 * Notification types:
 * - price_drop: price alert on a saved item
 * - style_dna: style DNA report ready
 * - social: someone followed you, liked your scan
 * - new_post: an account you follow posted
 * - digest: weekly summary
 */

// VAPID keys for Web Push — generate once and store in env vars
// Generate with: npx web-push generate-vapid-keys
const VAPID_PUBLIC = process.env.VAPID_PUBLIC_KEY || "";
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY || "";

if (VAPID_PUBLIC && VAPID_PRIVATE) {
  webpush.setVapidDetails(
    "mailto:support@attaire.app",
    VAPID_PUBLIC,
    VAPID_PRIVATE,
  );
}

/**
 * Save a push subscription for a user.
 */
export async function saveSubscription(userId, subscription) {
  const { endpoint, keys } = subscription;
  if (!endpoint || !keys?.p256dh || !keys?.auth) {
    throw new Error("Invalid push subscription");
  }

  await supabase.from("push_subscriptions").upsert({
    user_id: userId,
    endpoint,
    p256dh: keys.p256dh,
    auth: keys.auth,
  }, { onConflict: "user_id,endpoint" });
}

/**
 * Remove a push subscription.
 */
export async function removeSubscription(userId, endpoint) {
  await supabase.from("push_subscriptions")
    .delete()
    .eq("user_id", userId)
    .eq("endpoint", endpoint);
}

/**
 * Send a push notification to a specific user.
 * Respects notification preferences.
 */
export async function sendNotification(userId, type, title, body, data = {}) {
  // Check user's notification preferences
  const { data: profile } = await supabase
    .from("profiles")
    .select("notification_prefs")
    .eq("id", userId)
    .single();

  const prefs = profile?.notification_prefs || {};
  const prefMap = {
    price_drop: "price_drops",
    style_dna: "style_dna",
    social: "social_activity",
    style_twins: "style_twins",
    new_post: "new_posts",
    digest: "weekly_digest",
    hanger_test: "hanger_test",
    follow_up: "follow_up_nudges",
  };

  if (prefs[prefMap[type]] === false) {
    console.log(`[Notif] Skipped ${type} for ${userId} — disabled in prefs`);
    return;
  }

  // Get all subscriptions for this user
  const { data: subs } = await supabase
    .from("push_subscriptions")
    .select("endpoint, p256dh, auth")
    .eq("user_id", userId);

  if (!subs || subs.length === 0) return;

  // Log the notification
  await supabase.from("notification_log").insert({
    user_id: userId,
    type,
    title,
    body,
    data,
  });

  // Send to all subscriptions
  const payload = JSON.stringify({ title, body, url: data.url || "/" });

  for (const sub of subs) {
    try {
      await webpush.sendNotification({
        endpoint: sub.endpoint,
        keys: { p256dh: sub.p256dh, auth: sub.auth },
      }, payload);
    } catch (err) {
      // Remove expired/invalid subscriptions
      if (err.statusCode === 410 || err.statusCode === 404) {
        await supabase.from("push_subscriptions")
          .delete()
          .eq("user_id", userId)
          .eq("endpoint", sub.endpoint);
      }
      console.error(`[Notif] Push error: ${err.message}`);
    }
  }
}

/**
 * Send notification to all followers of a user (for new post alerts).
 */
export async function notifyFollowers(userId, title, body, data = {}) {
  const { data: followers } = await supabase
    .from("follows")
    .select("follower_id")
    .eq("following_id", userId);

  if (!followers) return;

  await Promise.all(
    followers.map(f => sendNotification(f.follower_id, "new_post", title, body, data).catch(() => {}))
  );
}

/**
 * Get unread notification count for a user.
 */
export async function getUnreadCount(userId) {
  const { count } = await supabase
    .from("notification_log")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .is("read_at", null);
  return count || 0;
}

/**
 * Get recent notifications for a user.
 */
export async function getNotifications(userId, limit = 20) {
  const { data } = await supabase
    .from("notification_log")
    .select("*")
    .eq("user_id", userId)
    .order("sent_at", { ascending: false })
    .limit(limit);
  return data || [];
}

/**
 * Mark notifications as read.
 */
export async function markRead(userId, notificationIds) {
  await supabase
    .from("notification_log")
    .update({ read_at: new Date().toISOString() })
    .eq("user_id", userId)
    .in("id", notificationIds);
}

/**
 * Get the VAPID public key for the frontend to use when subscribing.
 */
export function getVapidPublicKey() {
  return VAPID_PUBLIC;
}

// ═══════════════════════════════════════════════════════════════════════
// Follow-up Nudge System
//
// When the AI sends results that need user input (scan results, refinement
// questions, etc.), the frontend schedules a nudge. If the user doesn't
// interact within 10-15 minutes, the system sends a push notification
// bringing them back.
//
// In-memory queue — fine for single-server. Nudges are ephemeral by nature
// (they only matter for the current session).
// ═══════════════════════════════════════════════════════════════════════

/**
 * Pending nudges map: userId → { scanId, context, fireAt, itemName, sent }
 * Each user has at most one pending nudge at a time (latest wins).
 */
const pendingNudges = new Map();

/** Nudge delay range in ms: 10–15 minutes */
const NUDGE_MIN_MS = 10 * 60 * 1000;
const NUDGE_MAX_MS = 15 * 60 * 1000;

function randomNudgeDelay() {
  return NUDGE_MIN_MS + Math.floor(Math.random() * (NUDGE_MAX_MS - NUDGE_MIN_MS));
}

/** Nudge message templates — picks one at random for variety */
const NUDGE_MESSAGES = [
  { title: "Your outfit results are waiting", body: "We found some great matches — come take a look ��" },
  { title: "Still thinking?", body: "Your scan results are ready. Tap to check them out." },
  { title: "Don't leave your fit hanging", body: "We identified your pieces — pick your favorites before they sell out." },
  { title: "Quick reminder", body: "Your style matches are waiting. Swipe through your results!" },
  { title: "Your AI stylist has picks for you", body: "Come back and see what we found for your outfit." },
];

/**
 * Schedule a follow-up nudge for a user.
 * Replaces any existing pending nudge for that user.
 *
 * @param {string} userId
 * @param {string} scanId - Current scan context
 * @param {string} context - "scan_results" | "refinement" | "pairings"
 * @param {string} [itemName] - Optional item name for personalized nudge
 */
export function scheduleNudge(userId, scanId, context = "scan_results", itemName = null) {
  if (!userId) return;

  const fireAt = Date.now() + randomNudgeDelay();

  pendingNudges.set(userId, {
    scanId,
    context,
    itemName,
    fireAt,
    sent: false,
    createdAt: Date.now(),
  });

  console.log(`[Nudge] Scheduled for user ${userId.slice(0, 8)}… in ${Math.round((fireAt - Date.now()) / 60000)}min (context: ${context})`);
}

/**
 * Cancel a pending nudge for a user.
 * Called when the user interacts (refines, saves, clicks a product, etc.).
 *
 * @param {string} userId
 * @param {string} [scanId] - If provided, only cancel if it matches the pending scan
 */
export function cancelNudge(userId, scanId = null) {
  if (!userId) return;

  const existing = pendingNudges.get(userId);
  if (!existing) return;

  // If scanId specified, only cancel if it matches
  if (scanId && existing.scanId !== scanId) return;

  pendingNudges.delete(userId);
  console.log(`[Nudge] Cancelled for user ${userId.slice(0, 8)}…`);
}

/**
 * Get nudge status for a user (used by frontend to know if nudge is pending).
 */
export function getNudgeStatus(userId) {
  const nudge = pendingNudges.get(userId);
  if (!nudge || nudge.sent) return null;
  return {
    scanId: nudge.scanId,
    context: nudge.context,
    minutesLeft: Math.max(0, Math.round((nudge.fireAt - Date.now()) / 60000)),
  };
}

/**
 * Process all pending nudges — called every 60 seconds by the server.
 * Fires push notifications for nudges whose timer has expired.
 */
export async function processNudges() {
  const now = Date.now();
  const toFire = [];

  for (const [userId, nudge] of pendingNudges.entries()) {
    if (nudge.sent) {
      // Clean up sent nudges older than 1 hour
      if (now - nudge.createdAt > 60 * 60 * 1000) {
        pendingNudges.delete(userId);
      }
      continue;
    }

    if (now >= nudge.fireAt) {
      toFire.push({ userId, nudge });
    }
  }

  if (toFire.length === 0) return;

  console.log(`[Nudge] Processing ${toFire.length} pending nudge(s)`);

  for (const { userId, nudge } of toFire) {
    try {
      // Pick a random message template
      const template = NUDGE_MESSAGES[Math.floor(Math.random() * NUDGE_MESSAGES.length)];

      // Personalize if we have item name
      let { title, body } = template;
      if (nudge.itemName) {
        body = body.replace("your outfit", `your ${nudge.itemName}`).replace("your pieces", `your ${nudge.itemName}`);
      }

      // Send the push notification (respects user prefs)
      await sendNotification(userId, "follow_up", title, body, {
        url: nudge.scanId ? `/scan/${nudge.scanId}` : "/",
        nudge: true,
        context: nudge.context,
      });

      // Mark as sent (don't delete yet — frontend may query status)
      nudge.sent = true;
      nudge.sentAt = now;

      console.log(`[Nudge] Sent to user ${userId.slice(0, 8)}… (context: ${nudge.context})`);
    } catch (err) {
      const retries = nudge._retries || 0;
      if (retries < 1) {
        // Allow one retry on next processor cycle
        nudge._retries = retries + 1;
        nudge.fireAt = now + 60 * 1000; // Retry in 1 minute
        console.warn(`[Nudge] Failed for user ${userId.slice(0, 8)}…, will retry (attempt ${retries + 1}): ${err.message}`);
      } else {
        // Final failure — remove to avoid infinite retries
        pendingNudges.delete(userId);
        console.error(`[Nudge] Permanently failed for user ${userId.slice(0, 8)}… after ${retries + 1} attempts: ${err.message}`);
      }
    }
  }
}

/** Nudge processor interval handle */
let nudgeInterval = null;

/**
 * Start the nudge processor — runs every 60 seconds.
 * Safe to call multiple times (idempotent).
 */
export function startNudgeProcessor() {
  if (nudgeInterval) return;
  nudgeInterval = setInterval(() => {
    processNudges().catch(err => console.error("[Nudge] Processor error:", err.message));
  }, 60 * 1000);

  // Don't prevent Node from exiting
  if (nudgeInterval.unref) nudgeInterval.unref();

  console.log("[Nudge] Processor started (60s interval)");
}

/**
 * Stop the nudge processor (for tests / graceful shutdown).
 */
export function stopNudgeProcessor() {
  if (nudgeInterval) {
    clearInterval(nudgeInterval);
    nudgeInterval = null;
  }
}

/**
 * Get pending nudge count (for monitoring).
 */
export function getPendingNudgeCount() {
  let count = 0;
  for (const nudge of pendingNudges.values()) {
    if (!nudge.sent) count++;
  }
  return count;
}

/**
 * Clear all pending nudges (for tests / graceful shutdown).
 * @private — exported only for test cleanup
 */
export function _clearAllNudges() {
  pendingNudges.clear();
}
