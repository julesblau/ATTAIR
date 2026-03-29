/**
 * hangerTest.js — Hanger Test daily outfit verdict routes for ATTAIRE
 *
 * POST   /api/cron/hanger-test        — Daily cron: pick outfit + send push
 * GET    /api/hanger-test/today       — Today's outfit + user vote + stats
 * POST   /api/hanger-test/vote        — Record vote, update streak, return results
 * GET    /api/hanger-test/streak      — User's streak info
 * GET    /api/hanger-test/history     — User's past verdicts
 */

import { Router } from "express";
import { requireAuth, optionalAuth } from "../middleware/auth.js";
import supabase from "../lib/supabase.js";
import { sendNotification } from "../services/notifications.js";

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";

const router = Router();

// ── Helper: parse Claude JSON ──────────────────────────────────
function parseJSON(text) {
  let s = text.replace(/```json\s*/gi, "").replace(/```\s*/g, "").trim();
  const fo = s.indexOf("{");
  const fa = s.indexOf("[");
  const start = fo === -1 ? fa : fa === -1 ? fo : Math.min(fo, fa);
  const isArr = s[start] === "[";
  const end = isArr ? s.lastIndexOf("]") : s.lastIndexOf("}");
  if (start !== -1 && end > start) s = s.substring(start, end + 1);
  return JSON.parse(s);
}

// ── Helper: generate style insight via Claude ──────────────────
async function generateStyleInsight(userId) {
  // Get user's recent votes to analyze style preferences
  const { data: votes } = await supabase
    .from("hanger_votes")
    .select(`
      verdict,
      outfit:hanger_outfits(description, style_tags)
    `)
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(30);

  if (!votes || votes.length < 7) return null;

  const wearOutfits = votes.filter(v => v.verdict === "wear").map(v => ({
    description: v.outfit?.description,
    tags: v.outfit?.style_tags,
  }));
  const passOutfits = votes.filter(v => v.verdict === "pass").map(v => ({
    description: v.outfit?.description,
    tags: v.outfit?.style_tags,
  }));

  const prompt = `You are a fashion AI analyzing a user's style preferences based on their daily outfit votes. They voted "Would Wear" or "Pass" on trending outfits.

OUTFITS THEY WOULD WEAR (${wearOutfits.length}):
${wearOutfits.map(o => `- ${o.description} [${(o.tags || []).join(", ")}]`).join("\n")}

OUTFITS THEY PASSED ON (${passOutfits.length}):
${passOutfits.map(o => `- ${o.description} [${(o.tags || []).join(", ")}]`).join("\n")}

Generate a concise, fun style insight. Include:
1. Their dominant style(s) with rough percentages (e.g. "80% streetwear, 20% minimalist")
2. Key patterns: colors they gravitate toward, silhouettes they prefer, brands/vibes they avoid
3. A fun style archetype name (e.g. "The Clean Maximalist", "Urban Minimalist", "Vintage Explorer")

Return JSON only — no markdown:
{
  "insight": "Your style breakdown in 2-3 punchy sentences",
  "archetype": "Fun archetype name",
  "style_breakdown": [
    { "style": "streetwear", "pct": 60 },
    { "style": "minimalist", "pct": 25 },
    { "style": "vintage", "pct": 15 }
  ],
  "favorite_vibes": ["dark tones", "oversized fits", "sneaker-forward"],
  "avoid_vibes": ["preppy", "bright colors", "formal"]
}`;

  try {
    const res = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 600,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    if (!res.ok) return null;
    const data = await res.json();
    const text = data.content?.map(c => c.text || "").join("") || "";
    return parseJSON(text);
  } catch (err) {
    console.error("[HangerTest] Insight generation failed:", err.message);
    return null;
  }
}

// ── Helper: generate outfit description via Claude ─────────────
async function generateOutfitDescription(imageUrl, items) {
  const itemsSummary = Array.isArray(items)
    ? items.map(it => `${it.name || it.subcategory || "item"} (${it.color || ""} ${it.material || ""})`.trim()).join(", ")
    : "fashion outfit";

  const prompt = `Write a brief, engaging 1-2 sentence description of this outfit for a daily fashion poll. The outfit contains: ${itemsSummary}. Keep it fun, trendy, and under 120 characters. Also suggest 3-5 style tags.

Return JSON only:
{ "description": "Brief outfit description", "style_tags": ["tag1", "tag2", "tag3"] }`;

  try {
    const res = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 200,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    if (!res.ok) return { description: itemsSummary, style_tags: [] };
    const data = await res.json();
    const text = data.content?.map(c => c.text || "").join("") || "";
    return parseJSON(text);
  } catch {
    return { description: itemsSummary, style_tags: [] };
  }
}

// ═══════════════════════════════════════════════════════════════
// POST /api/cron/hanger-test — Daily cron job
// Selects an outfit from trending scans, creates hanger_outfits entry,
// sends push notification to subscribed users.
// Protected by a simple cron secret or run manually.
// ═══════════════════════════════════════════════════════════════
router.post("/cron/hanger-test", async (req, res) => {
  // Simple auth: check cron secret or allow from Railway cron
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = req.headers.authorization;
  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const today = new Date().toISOString().split("T")[0];

  try {
    // Check if today's outfit already exists
    const { data: existing } = await supabase
      .from("hanger_outfits")
      .select("id")
      .eq("active_date", today)
      .single();

    if (existing) {
      return res.json({ message: "Today's outfit already set", outfit_id: existing.id });
    }

    // Try to find a good scan from the last 7 days with an image
    const { data: trendingScans } = await supabase
      .from("scans")
      .select("id, image_url, summary, items, created_at")
      .eq("visibility", "public")
      .not("image_url", "is", null)
      .gte("created_at", new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString())
      .order("created_at", { ascending: false })
      .limit(20);

    let outfit;

    if (trendingScans && trendingScans.length > 0) {
      // Pick a random scan from trending (avoid always picking the newest)
      const scan = trendingScans[Math.floor(Math.random() * Math.min(trendingScans.length, 10))];

      // Generate description
      const aiResult = await generateOutfitDescription(scan.image_url, scan.items);

      const { data: newOutfit, error: insertError } = await supabase
        .from("hanger_outfits")
        .insert({
          image_url: scan.image_url,
          description: aiResult.description || scan.summary || "Today's trending outfit",
          style_tags: aiResult.style_tags || [],
          source_scan_id: scan.id,
          source_type: "scan",
          active_date: today,
        })
        .select()
        .single();

      if (insertError) throw insertError;
      outfit = newOutfit;
    } else {
      // Fallback: create a curated outfit placeholder
      // In production this would call SerpAPI for trending fashion
      const { data: olderScan } = await supabase
        .from("scans")
        .select("id, image_url, summary, items")
        .eq("visibility", "public")
        .not("image_url", "is", null)
        .order("created_at", { ascending: false })
        .limit(1)
        .single();

      if (!olderScan) {
        return res.status(404).json({ error: "No scans available to create outfit" });
      }

      const aiResult = await generateOutfitDescription(olderScan.image_url, olderScan.items);

      const { data: newOutfit, error: insertError } = await supabase
        .from("hanger_outfits")
        .insert({
          image_url: olderScan.image_url,
          description: aiResult.description || olderScan.summary || "Today's outfit pick",
          style_tags: aiResult.style_tags || [],
          source_scan_id: olderScan.id,
          source_type: "curated",
          active_date: today,
        })
        .select()
        .single();

      if (insertError) throw insertError;
      outfit = newOutfit;
    }

    // Send push notifications to all users with push subscriptions
    const { data: subscribers } = await supabase
      .from("push_subscriptions")
      .select("user_id")
      .limit(1000);

    if (subscribers && subscribers.length > 0) {
      // Deduplicate user IDs
      const userIds = [...new Set(subscribers.map(s => s.user_id))];

      // Send in batches of 50 to avoid overwhelming
      const BATCH_SIZE = 50;
      for (let i = 0; i < userIds.length; i += BATCH_SIZE) {
        const batch = userIds.slice(i, i + BATCH_SIZE);
        await Promise.allSettled(
          batch.map(uid =>
            sendNotification(
              uid,
              "hanger_test",
              "Today's Hanger Test is ready",
              "A new outfit is waiting for your verdict. Would you wear it?",
              { url: "/?hanger=1" }
            )
          )
        );
      }
    }

    res.json({
      success: true,
      outfit_id: outfit.id,
      notifications_sent: subscribers?.length || 0,
    });
  } catch (err) {
    console.error("[HangerTest] Cron error:", err.message);
    res.status(500).json({ error: "Failed to create daily outfit" });
  }
});

// ═══════════════════════════════════════════════════════════════
// GET /api/hanger-test/today — Get today's outfit + user vote
// ═══════════════════════════════════════════════════════════════
router.get("/hanger-test/today", optionalAuth, async (req, res) => {
  const today = new Date().toISOString().split("T")[0];

  try {
    // Get today's outfit
    const { data: outfit } = await supabase
      .from("hanger_outfits")
      .select("*")
      .eq("active_date", today)
      .single();

    if (!outfit) {
      return res.json({ outfit: null, message: "No outfit today" });
    }

    // Get community stats
    const totalVotes = outfit.wear_count + outfit.pass_count;
    const wearPct = totalVotes > 0 ? Math.round((outfit.wear_count / totalVotes) * 100) : 50;

    const result = {
      outfit: {
        id: outfit.id,
        image_url: outfit.image_url,
        description: outfit.description,
        style_tags: outfit.style_tags,
        active_date: outfit.active_date,
      },
      stats: {
        wear_count: outfit.wear_count,
        pass_count: outfit.pass_count,
        total_votes: totalVotes,
        wear_pct: wearPct,
        pass_pct: 100 - wearPct,
      },
      user_vote: null,
      streak: null,
    };

    // If authenticated, check if user already voted
    if (req.userId) {
      const { data: vote } = await supabase
        .from("hanger_votes")
        .select("verdict, created_at")
        .eq("user_id", req.userId)
        .eq("outfit_id", outfit.id)
        .single();

      if (vote) {
        result.user_vote = vote.verdict;
      }

      // Get streak info
      const { data: streak } = await supabase
        .from("hanger_streaks")
        .select("*")
        .eq("user_id", req.userId)
        .single();

      if (streak) {
        result.streak = {
          current_streak: streak.current_streak,
          longest_streak: streak.longest_streak,
          total_votes: streak.total_votes,
          taste_badge: streak.taste_badge,
          has_insight: !!streak.style_insight,
        };
      }
    }

    res.json(result);
  } catch (err) {
    console.error("[HangerTest] Today error:", err.message);
    res.status(500).json({ error: "Failed to load today's outfit" });
  }
});

// ═══════════════════════════════════════════════════════════════
// POST /api/hanger-test/vote — Record vote + update streak
// ═══════════════════════════════════════════════════════════════
router.post("/hanger-test/vote", requireAuth, async (req, res) => {
  const { outfit_id, verdict } = req.body;

  if (!outfit_id || !["wear", "pass"].includes(verdict)) {
    return res.status(400).json({ error: "Invalid outfit_id or verdict (wear/pass)" });
  }

  try {
    // Use RPC for atomic vote + streak update
    const { data, error } = await supabase.rpc("record_hanger_vote", {
      p_user_id: req.userId,
      p_outfit_id: outfit_id,
      p_verdict: verdict,
    });

    if (error) {
      // Duplicate vote
      if (error.message?.includes("duplicate") || error.code === "23505") {
        return res.status(409).json({ error: "Already voted on this outfit" });
      }
      throw error;
    }

    const result = {
      success: true,
      stats: {
        wear_count: data.wear_count,
        pass_count: data.pass_count,
        total_votes: data.wear_count + data.pass_count,
        wear_pct: Math.round((data.wear_count / (data.wear_count + data.pass_count)) * 100),
        pass_pct: Math.round((data.pass_count / (data.wear_count + data.pass_count)) * 100),
      },
      streak: {
        current_streak: data.current_streak,
        longest_streak: data.longest_streak,
        total_votes: data.total_votes,
      },
      earned_insight: data.earned_insight,
      earned_badge: data.earned_badge,
      style_insight: null,
    };

    // Generate style insight if they just hit 7-day streak
    if (data.earned_insight) {
      // Check if this is their first insight (free) or if they're pro
      const { data: streakData } = await supabase
        .from("hanger_streaks")
        .select("insight_count")
        .eq("user_id", req.userId)
        .single();

      const { data: profile } = await supabase
        .from("profiles")
        .select("tier")
        .eq("id", req.userId)
        .single();

      const isPro = profile?.tier === "pro" || profile?.tier === "trial";
      const isFirstInsight = (streakData?.insight_count || 0) === 0;

      if (isFirstInsight || isPro) {
        const insight = await generateStyleInsight(req.userId);
        if (insight) {
          // Save insight to streak record
          await supabase
            .from("hanger_streaks")
            .update({
              style_insight: JSON.stringify(insight),
              insight_count: (streakData?.insight_count || 0) + 1,
            })
            .eq("user_id", req.userId);

          result.style_insight = insight;
        }
      } else {
        result.style_insight = { gated: true, message: "Unlock Style Insights with ATTAIRE Pro" };
      }
    }

    res.json(result);
  } catch (err) {
    console.error("[HangerTest] Vote error:", err.message);
    res.status(500).json({ error: "Failed to record vote" });
  }
});

// ═══════════════════════════════════════════════════════════════
// GET /api/hanger-test/streak — Get user's streak info
// ═══════════════════════════════════════════════════════════════
router.get("/hanger-test/streak", requireAuth, async (req, res) => {
  try {
    const { data: streak } = await supabase
      .from("hanger_streaks")
      .select("*")
      .eq("user_id", req.userId)
      .single();

    if (!streak) {
      return res.json({
        current_streak: 0,
        longest_streak: 0,
        total_votes: 0,
        taste_badge: false,
        style_insight: null,
      });
    }

    // Check if streak is still active (last vote was yesterday or today)
    const today = new Date().toISOString().split("T")[0];
    const yesterday = new Date(Date.now() - 86400000).toISOString().split("T")[0];
    const isActive = streak.last_vote_date === today || streak.last_vote_date === yesterday;

    res.json({
      current_streak: isActive ? streak.current_streak : 0,
      longest_streak: streak.longest_streak,
      total_votes: streak.total_votes,
      taste_badge: streak.taste_badge,
      style_insight: streak.style_insight ? JSON.parse(streak.style_insight) : null,
      last_vote_date: streak.last_vote_date,
    });
  } catch (err) {
    console.error("[HangerTest] Streak error:", err.message);
    res.status(500).json({ error: "Failed to load streak" });
  }
});

// ═══════════════════════════════════════════════════════════════
// GET /api/hanger-test/history — User's past verdicts
// ═══════════════════════════════════════════════════════════════
router.get("/hanger-test/history", requireAuth, async (req, res) => {
  const limit = Math.min(50, Math.max(1, parseInt(req.query.limit) || 20));
  const offset = Math.max(0, parseInt(req.query.offset) || 0);

  try {
    const { data: votes, error } = await supabase
      .from("hanger_votes")
      .select(`
        id,
        verdict,
        created_at,
        outfit:hanger_outfits(id, image_url, description, style_tags, active_date, wear_count, pass_count)
      `)
      .eq("user_id", req.userId)
      .order("created_at", { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) throw error;

    const history = (votes || []).map(v => {
      const total = (v.outfit?.wear_count || 0) + (v.outfit?.pass_count || 0);
      return {
        id: v.id,
        verdict: v.verdict,
        voted_at: v.created_at,
        outfit: v.outfit ? {
          id: v.outfit.id,
          image_url: v.outfit.image_url,
          description: v.outfit.description,
          style_tags: v.outfit.style_tags,
          date: v.outfit.active_date,
          wear_pct: total > 0 ? Math.round((v.outfit.wear_count / total) * 100) : 50,
        } : null,
      };
    });

    res.json({ history });
  } catch (err) {
    console.error("[HangerTest] History error:", err.message);
    res.status(500).json({ error: "Failed to load history" });
  }
});

export default router;
