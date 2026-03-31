/**
 * outfitOfTheWeek.js — Outfit of the Week generation job for ATTAIR.
 *
 * Called every Monday via cron (POST /api/ootw/generate) or the internal timer.
 *
 * Logic:
 *   1. Compute current ISO week's Monday date.
 *   2. If an OOTW already exists for this week, skip (idempotent).
 *   3. Fetch top 10 trending public scans from the last 7 days.
 *   4. Send scan summaries + items to Claude to write an editorial headline + caption.
 *   5. Insert into `outfit_of_the_week`.
 *   6. Return the generated editorial.
 *
 * Also: sendWeeklyStyleReports() — Sunday push for Pro users with 3 personalized looks.
 */

import supabase from "../lib/supabase.js";
import { sendNotification } from "../services/notifications.js";

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Get the Monday of the current ISO week as YYYY-MM-DD. */
export function getCurrentWeekMonday(now = new Date()) {
  const d = new Date(now);
  const day = d.getUTCDay(); // 0=Sun … 6=Sat
  const diff = day === 0 ? -6 : 1 - day; // shift to Monday
  d.setUTCDate(d.getUTCDate() + diff);
  return d.toISOString().slice(0, 10);
}

/** Trending score — same algorithm as social.js feed */
function trendingScore(saveCount, createdAt) {
  const ageHrs = (Date.now() - new Date(createdAt).getTime()) / (1000 * 60 * 60);
  let recency;
  if (ageHrs <= 24) recency = 1.0;
  else if (ageHrs <= 72) recency = 0.7;
  else if (ageHrs <= 168) recency = 0.4;
  else recency = 0.15;
  return (saveCount + 0.1) * recency;
}

// ─── Claude editorial generation ────────────────────────────────────────────

async function generateEditorial(scans) {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("[OOTW] ANTHROPIC_API_KEY not set — using fallback editorial");
    return {
      headline: "This Week's Top Looks",
      editorial: "The community brought the heat this week. From street-ready layers to clean minimalist fits, here are the 10 outfits that turned the most heads.",
    };
  }

  const scanSummaries = scans.map((s, i) => {
    const items = Array.isArray(s.items) ? s.items : [];
    const itemList = items.slice(0, 4).map(it =>
      `${it.brand && it.brand !== "Unidentified" ? it.brand + " " : ""}${it.name || it.subcategory || "item"}`
    ).join(", ");
    return `${i + 1}. "${s.summary || "Outfit"}" — ${itemList || "mixed pieces"} (${s.save_count} saves)`;
  }).join("\n");

  const prompt = `You are a fashion editor at a trendy digital magazine (think Highsnobiety × Depop × TikTok style). Write an editorial caption for this week's "Outfit of the Week" feature on ATTAIRE, a Gen-Z fashion app.

Here are this week's top 10 trending outfits scanned by the community:
${scanSummaries}

Return ONLY valid JSON (no markdown, no backticks):
{
  "headline": "Short punchy headline, 3-8 words, editorial voice (e.g. 'Layering Season Just Peaked', 'The Streets Are Speaking')",
  "editorial": "2-3 sentence editorial caption. Energetic, aspirational, Gen-Z tone. Reference 1-2 specific trends you notice across the looks. End with something that makes the reader want to tap and explore. No emojis. Under 280 characters."
}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);

  try {
    const res = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 400,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    clearTimeout(timeout);
    if (!res.ok) throw new Error(`Anthropic API ${res.status}`);

    const data = await res.json();
    const text = data.content?.map(c => c.text || "").join("") || "";

    // Parse JSON from response
    let s = text.replace(/```json\s*/gi, "").replace(/```\s*/g, "").trim();
    const start = s.indexOf("{");
    const end = s.lastIndexOf("}");
    if (start !== -1 && end > start) s = s.substring(start, end + 1);
    const parsed = JSON.parse(s);

    return {
      headline: (parsed.headline || "This Week's Top Looks").slice(0, 100),
      editorial: (parsed.editorial || "").slice(0, 500),
    };
  } catch (err) {
    clearTimeout(timeout);
    console.error(`[OOTW] Editorial generation failed: ${err.message}`);
    return {
      headline: "This Week's Top Looks",
      editorial: "The community brought the heat this week. From street-ready layers to clean minimalist fits, here are the 10 outfits that turned the most heads.",
    };
  }
}

// ─── Main OOTW job ──────────────────────────────────────────────────────────

/**
 * Generate Outfit of the Week for the current week.
 * Idempotent — if already generated for this week, returns existing.
 */
export async function generateOutfitOfTheWeek() {
  const weekStart = getCurrentWeekMonday();
  console.log(`[OOTW] Generating for week of ${weekStart}`);

  // Check if already generated
  const { data: existing } = await supabase
    .from("outfit_of_the_week")
    .select("*")
    .eq("week_start", weekStart)
    .maybeSingle();

  if (existing) {
    console.log(`[OOTW] Already exists for ${weekStart} — skipping`);
    return { created: false, ootw: existing };
  }

  // Fetch public scans from the last 7 days
  const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const { data: pool, error: poolErr } = await supabase
    .from("scans")
    .select("id, user_id, image_url, summary, items, created_at, visibility")
    .eq("visibility", "public")
    .not("image_url", "is", null)
    .gte("created_at", cutoff)
    .order("created_at", { ascending: false })
    .limit(200);

  if (poolErr) throw new Error(`Failed to fetch scans: ${poolErr.message}`);

  if (!pool || pool.length === 0) {
    console.log("[OOTW] No public scans in the last 7 days — skipping");
    return { created: false, reason: "no_scans" };
  }

  // Get save counts
  const poolIds = pool.map(s => s.id);
  const { data: saveRows } = await supabase
    .from("saved_items")
    .select("scan_id")
    .in("scan_id", poolIds);

  const saveCountMap = {};
  (saveRows || []).forEach(row => {
    if (row.scan_id) saveCountMap[row.scan_id] = (saveCountMap[row.scan_id] || 0) + 1;
  });

  // Score and sort — pick top 10
  const scored = pool.map(s => ({
    ...s,
    save_count: saveCountMap[s.id] || 0,
    score: trendingScore(saveCountMap[s.id] || 0, s.created_at),
  }));
  scored.sort((a, b) => b.score - a.score);
  const top10 = scored.slice(0, 10);

  if (top10.length === 0) {
    console.log("[OOTW] No scoreable scans — skipping");
    return { created: false, reason: "no_scans" };
  }

  // Generate editorial with Claude
  const { headline, editorial } = await generateEditorial(top10);

  // Insert
  const scanIds = top10.map(s => s.id);
  const coverImage = top10[0].image_url || null;

  const { data: ootw, error: insertErr } = await supabase
    .from("outfit_of_the_week")
    .insert({
      week_start: weekStart,
      scan_ids: scanIds,
      editorial,
      headline,
      cover_image: coverImage,
    })
    .select()
    .single();

  if (insertErr) throw new Error(`Failed to insert OOTW: ${insertErr.message}`);

  console.log(`[OOTW] Created for ${weekStart}: "${headline}" with ${scanIds.length} scans`);
  return { created: true, ootw };
}

// ─── Weekly Style Report (Sunday push for Pro users) ────────────────────────

/**
 * Pick 3 personalized looks for a Pro user based on their style history.
 * Falls back to top trending if insufficient data.
 */
async function pickPersonalizedLooks(userId, topTrendingIds) {
  // Get user's recent saved item categories/styles for matching
  const { data: savedItems } = await supabase
    .from("saved_items")
    .select("item_data")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(20);

  // Extract style keywords from saved items
  const styleKeywords = new Set();
  const categories = new Set();
  (savedItems || []).forEach(si => {
    const d = si.item_data;
    if (!d) return;
    if (d.category) categories.add(d.category);
    if (d.subcategory) categories.add(d.subcategory);
    if (Array.isArray(d.style_keywords)) d.style_keywords.forEach(k => styleKeywords.add(k));
  });

  if (categories.size === 0 && styleKeywords.size === 0) {
    // No personalization signal — return top 3 trending
    return topTrendingIds.slice(0, 3);
  }

  // Fetch recent public scans that match user's style
  const cutoff = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();
  const { data: candidates } = await supabase
    .from("scans")
    .select("id, items, summary, created_at")
    .eq("visibility", "public")
    .neq("user_id", userId)
    .not("image_url", "is", null)
    .gte("created_at", cutoff)
    .order("created_at", { ascending: false })
    .limit(100);

  if (!candidates || candidates.length < 3) {
    return topTrendingIds.slice(0, 3);
  }

  // Score candidates by style match
  const scoredCandidates = candidates.map(scan => {
    let matchScore = 0;
    const items = Array.isArray(scan.items) ? scan.items : [];
    for (const item of items) {
      if (item.category && categories.has(item.category)) matchScore += 2;
      if (item.subcategory && categories.has(item.subcategory)) matchScore += 3;
      if (Array.isArray(item.style_keywords)) {
        for (const kw of item.style_keywords) {
          if (styleKeywords.has(kw)) matchScore += 2;
        }
      }
    }
    return { id: scan.id, matchScore };
  });

  scoredCandidates.sort((a, b) => b.matchScore - a.matchScore);

  // Take top 3 with score > 0, fill remainder from trending
  const personalized = scoredCandidates
    .filter(c => c.matchScore > 0)
    .slice(0, 3)
    .map(c => c.id);

  while (personalized.length < 3 && topTrendingIds.length > 0) {
    const fallback = topTrendingIds.find(id => !personalized.includes(id));
    if (fallback) personalized.push(fallback);
    else break;
  }

  return personalized.slice(0, 3);
}

/**
 * Send "Weekly Style Report" push notifications to all Pro users.
 * Each Pro user gets 3 personalized looks based on their saved items.
 * Idempotent per user per week.
 */
export async function sendWeeklyStyleReports() {
  const weekStart = getCurrentWeekMonday();
  console.log(`[WeeklyReport] Sending for week of ${weekStart}`);

  const summary = { sent: 0, skipped: 0, errors: [] };

  // Get current OOTW for fallback trending IDs
  const { data: ootw } = await supabase
    .from("outfit_of_the_week")
    .select("scan_ids")
    .eq("week_start", weekStart)
    .maybeSingle();

  const topTrendingIds = ootw?.scan_ids || [];

  // Find all active Pro users
  const now = new Date().toISOString();
  const { data: proUsers, error: proErr } = await supabase
    .from("profiles")
    .select("id, display_name")
    .or(`tier.eq.pro,and(tier.eq.trial,trial_ends_at.gt.${now})`);

  if (proErr) {
    console.error(`[WeeklyReport] Failed to fetch Pro users: ${proErr.message}`);
    summary.errors.push(proErr.message);
    return summary;
  }

  if (!proUsers || proUsers.length === 0) {
    console.log("[WeeklyReport] No active Pro users — skipping");
    return summary;
  }

  console.log(`[WeeklyReport] Processing ${proUsers.length} Pro user(s)`);

  for (const user of proUsers) {
    try {
      // Check if already sent this week
      const { data: existingReport } = await supabase
        .from("weekly_style_reports")
        .select("id")
        .eq("user_id", user.id)
        .eq("week_start", weekStart)
        .maybeSingle();

      if (existingReport) {
        summary.skipped++;
        continue;
      }

      // Pick 3 personalized looks
      const lookIds = await pickPersonalizedLooks(user.id, topTrendingIds);

      if (lookIds.length === 0) {
        summary.skipped++;
        continue;
      }

      // Record the report
      await supabase.from("weekly_style_reports").insert({
        user_id: user.id,
        week_start: weekStart,
        scan_ids: lookIds,
      });

      // Send push notification
      await sendNotification(
        user.id,
        "weekly_style_report",
        "Your Weekly Style Report",
        "3 looks picked just for you this week. Tap to see your personalized picks.",
        { url: "/weekly-report", type: "weekly_style_report", scan_ids: lookIds }
      );

      summary.sent++;
    } catch (err) {
      console.error(`[WeeklyReport] Error for user ${user.id}: ${err.message}`);
      summary.errors.push(`${user.id}: ${err.message}`);
    }
  }

  console.log(`[WeeklyReport] Done — sent: ${summary.sent}, skipped: ${summary.skipped}, errors: ${summary.errors.length}`);
  return summary;
}
