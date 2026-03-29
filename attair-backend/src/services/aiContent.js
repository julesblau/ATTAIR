/**
 * aiContent.js — AI account content posting service for ATTAIRE.
 *
 * Manages:
 * - Content library of curated outfits for each AI persona
 * - Scheduling posts throughout the day
 * - Publishing posts as public scans
 * - Notifying followers of new posts
 *
 * Content is curated per persona. Each post creates a real scan entry
 * visible in the public feed and to followers.
 */

import supabase from "../lib/supabase.js";
import { notifyFollowers } from "./notifications.js";
import { CONTENT_LIBRARY } from "../data/aiContentLibrary.js";

/**
 * Get all AI account user IDs from the database.
 */
export async function getAiAccounts() {
  const { data } = await supabase
    .from("profiles")
    .select("id, display_name")
    .eq("is_ai", true);
  return data || [];
}

/**
 * Create a post (scan) for an AI account.
 * Returns the created scan ID.
 */
export async function createAiPost(aiUserId, content) {
  const { summary, detected_gender, items } = content;

  const { data: scan, error } = await supabase
    .from("scans")
    .insert({
      user_id: aiUserId,
      scan_name: summary.slice(0, 60),
      summary,
      detected_gender,
      items,
      visibility: "public",
    })
    .select("id")
    .single();

  if (error) throw error;
  return scan.id;
}

/**
 * Schedule content for AI accounts.
 * Picks random content from each account's library and distributes posts
 * throughout the target date.
 *
 * @param {string} targetDate - ISO date string (YYYY-MM-DD)
 * @param {number} postsPerAccount - Number of posts per account per day (default: 3)
 */
export async function scheduleContent(targetDate, postsPerAccount = 3) {
  const accounts = await getAiAccounts();
  if (accounts.length === 0) {
    console.log("[AI Content] No AI accounts found. Run seedAiAccounts.js first.");
    return { scheduled: 0 };
  }

  let scheduled = 0;

  for (const account of accounts) {
    const library = CONTENT_LIBRARY[account.display_name];
    if (!library || library.length === 0) continue;

    for (let i = 0; i < postsPerAccount; i++) {
      // Distribute posts between 8am and 10pm ET (13:00-03:00 UTC next day)
      const hour = 8 + Math.floor(Math.random() * 14); // 8-21
      const minute = Math.floor(Math.random() * 60);
      const scheduledAt = new Date(`${targetDate}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00-04:00`);

      // Pick a random content piece (with some variation)
      const content = library[Math.floor(Math.random() * library.length)];

      // Check if this exact content was already scheduled for this account today
      const { data: existing } = await supabase
        .from("ai_content_queue")
        .select("id")
        .eq("ai_user_id", account.id)
        .gte("scheduled_at", `${targetDate}T00:00:00Z`)
        .lte("scheduled_at", `${targetDate}T23:59:59Z`);

      if (existing && existing.length >= postsPerAccount) continue;

      const { error } = await supabase
        .from("ai_content_queue")
        .insert({
          ai_user_id: account.id,
          content_data: content,
          scheduled_at: scheduledAt.toISOString(),
        });

      if (!error) scheduled++;
    }
  }

  console.log(`[AI Content] Scheduled ${scheduled} posts for ${targetDate}`);
  return { scheduled };
}

/**
 * Publish all due posts from the content queue.
 * Called by a cron job or manual trigger.
 * Returns summary of what was posted.
 */
export async function publishDuePosts() {
  const now = new Date().toISOString();

  // Get all unposted items that are due
  const { data: duePosts, error } = await supabase
    .from("ai_content_queue")
    .select("id, ai_user_id, content_data")
    .is("posted_at", null)
    .lte("scheduled_at", now)
    .order("scheduled_at", { ascending: true })
    .limit(50); // safety cap

  if (error) {
    console.error("[AI Content] Failed to fetch due posts:", error.message);
    return { posted: 0, errors: [error.message] };
  }

  if (!duePosts || duePosts.length === 0) {
    return { posted: 0, errors: [] };
  }

  let posted = 0;
  const errors = [];

  for (const post of duePosts) {
    try {
      // Create the scan (public post)
      const scanId = await createAiPost(post.ai_user_id, post.content_data);

      // Mark as posted
      await supabase
        .from("ai_content_queue")
        .update({ posted_at: now, scan_id: scanId })
        .eq("id", post.id);

      // Notify followers (non-blocking)
      const { data: profile } = await supabase
        .from("profiles")
        .select("display_name")
        .eq("id", post.ai_user_id)
        .single();

      const name = profile?.display_name || "ATTAIRE Style";
      notifyFollowers(
        post.ai_user_id,
        `New from ${name}`,
        post.content_data.summary?.slice(0, 80) || "Check out this new outfit",
        { url: `/scan/${scanId}` }
      ).catch(() => {});

      posted++;
    } catch (err) {
      console.error(`[AI Content] Failed to post ${post.id}:`, err.message);
      errors.push(`${post.id}: ${err.message}`);
    }
  }

  console.log(`[AI Content] Published ${posted}/${duePosts.length} posts`);
  return { posted, errors };
}

/**
 * Get content stats (for admin visibility).
 */
export async function getContentStats() {
  const accounts = await getAiAccounts();

  const { count: totalQueued } = await supabase
    .from("ai_content_queue")
    .select("id", { count: "exact", head: true })
    .is("posted_at", null);

  const { count: totalPosted } = await supabase
    .from("ai_content_queue")
    .select("id", { count: "exact", head: true })
    .not("posted_at", "is", null);

  return {
    ai_accounts: accounts.length,
    queued: totalQueued || 0,
    posted: totalPosted || 0,
  };
}
