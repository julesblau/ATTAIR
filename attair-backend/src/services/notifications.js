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
    new_post: "new_posts",
    digest: "weekly_digest",
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
