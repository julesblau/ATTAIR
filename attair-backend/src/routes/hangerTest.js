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

// ── Helper: archetype classification ─────────────────────────────
const ARCHETYPE_KEYWORDS = {
  streetwear: ["streetwear", "urban", "street", "oversized", "sneaker", "hoodie", "graphic"],
  minimalist: ["minimal", "clean", "simple", "monochrome", "neutral", "understated"],
  classic: ["classic", "preppy", "traditional", "tailored", "polo", "blazer", "oxford"],
  bold: ["bold", "maximal", "statement", "bright", "pattern", "colorful", "eclectic"],
  athleisure: ["athletic", "athleisure", "sporty", "gym", "activewear", "running"],
  vintage: ["vintage", "retro", "thrift", "90s", "80s", "70s", "secondhand"],
  formal: ["formal", "suit", "dress", "evening", "business", "professional"],
  coastal: ["coastal", "beach", "summer", "linen", "resort", "relaxed"],
};

function classifyArchetype(styleTags) {
  if (!styleTags?.length) return "eclectic";
  const scores = {};
  for (const [arch, keywords] of Object.entries(ARCHETYPE_KEYWORDS)) {
    scores[arch] = styleTags.filter(t => keywords.some(k => t.toLowerCase().includes(k))).length;
  }
  const best = Object.entries(scores).sort((a, b) => b[1] - a[1])[0];
  return best[1] > 0 ? best[0] : "eclectic";
}

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
    // Check if today's outfits already exist
    const { data: existing } = await supabase
      .from("hanger_outfits")
      .select("id")
      .eq("active_date", today);

    if (existing && existing.length >= 5) {
      return res.json({ message: "Today's outfits already set", outfit_ids: existing.map(o => o.id) });
    }

    // Try to find good scans from the last 7 days with an image
    const { data: trendingScans } = await supabase
      .from("scans")
      .select("id, image_url, summary, items, created_at")
      .eq("visibility", "public")
      .not("image_url", "is", null)
      .gte("created_at", new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString())
      .order("created_at", { ascending: false })
      .limit(50);

    let candidateScans = trendingScans || [];

    // Fallback: if not enough recent scans, pull older ones
    if (candidateScans.length < 5) {
      const { data: olderScans } = await supabase
        .from("scans")
        .select("id, image_url, summary, items")
        .eq("visibility", "public")
        .not("image_url", "is", null)
        .order("created_at", { ascending: false })
        .limit(50);
      // Merge, dedup by id
      const existingIds = new Set(candidateScans.map(s => s.id));
      for (const s of olderScans || []) {
        if (!existingIds.has(s.id)) candidateScans.push(s);
      }
    }

    if (candidateScans.length === 0) {
      return res.status(404).json({ error: "No scans available to create outfits" });
    }

    // Generate descriptions + classify archetypes for candidates
    // Process up to 15 candidates to get enough diversity
    const processLimit = Math.min(candidateScans.length, 15);
    const processed = [];
    for (let i = 0; i < processLimit; i++) {
      const scan = candidateScans[i];
      const aiResult = await generateOutfitDescription(scan.image_url, scan.items);
      const archetype = classifyArchetype(aiResult.style_tags || []);
      processed.push({ scan, aiResult, archetype });
    }

    // Greedy diverse selection: pick from different archetype buckets
    const selected = [];
    const usedArchetypes = new Set();
    const usedScanIds = new Set((existing || []).map(e => e.id));

    // First pass: one from each unique archetype
    for (const p of processed) {
      if (selected.length >= 5) break;
      if (usedScanIds.has(p.scan.id)) continue;
      if (!usedArchetypes.has(p.archetype)) {
        usedArchetypes.add(p.archetype);
        selected.push(p);
      }
    }

    // Second pass: fill remaining slots
    for (const p of processed) {
      if (selected.length >= 5) break;
      if (usedScanIds.has(p.scan.id)) continue;
      if (!selected.includes(p)) {
        selected.push(p);
      }
    }

    // Insert all selected outfits with batch positions
    const startPosition = (existing || []).length + 1;
    const insertedOutfits = [];
    for (let i = 0; i < selected.length; i++) {
      const { scan, aiResult, archetype } = selected[i];
      const { data: newOutfit, error: insertError } = await supabase
        .from("hanger_outfits")
        .insert({
          image_url: scan.image_url,
          description: aiResult.description || scan.summary || "Today's trending outfit",
          style_tags: aiResult.style_tags || [],
          style_archetype: archetype,
          source_scan_id: scan.id,
          source_type: "scan",
          active_date: today,
          batch_position: startPosition + i,
        })
        .select()
        .single();

      if (insertError) {
        console.error(`[HangerTest] Insert outfit ${i + 1} error:`, insertError.message);
        continue;
      }
      insertedOutfits.push(newOutfit);
    }

    if (insertedOutfits.length === 0) {
      return res.status(500).json({ error: "Failed to insert any outfits" });
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
              "5 new outfits are waiting for your verdict",
              { url: "/?hanger=1" }
            )
          )
        );
      }
    }

    res.json({
      success: true,
      outfit_ids: insertedOutfits.map(o => o.id),
      outfits_created: insertedOutfits.length,
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
    // Fetch all outfits for today
    const { data: outfits } = await supabase
      .from("hanger_outfits")
      .select("*")
      .eq("active_date", today)
      .order("batch_position", { ascending: true });

    if (!outfits || outfits.length === 0) {
      return res.json({ outfits: [], message: "No outfits today" });
    }

    // Get stats for all outfits
    const statsMap = {};
    for (const o of outfits) {
      const total = o.wear_count + o.pass_count;
      statsMap[o.id] = {
        wear_pct: total > 0 ? Math.round((o.wear_count / total) * 100) : 50,
        pass_pct: total > 0 ? Math.round((o.pass_count / total) * 100) : 50,
        total_votes: total,
      };
    }

    const result = {
      outfits,
      user_votes: {},
      stats: statsMap,
      cadence: null,
      streak: null,
      taste_profile: null,
    };

    // If authenticated, fetch user-specific data
    if (req.userId) {
      // Fetch all user votes for today's outfits
      const outfitIds = outfits.map(o => o.id);
      const { data: votes } = await supabase
        .from("hanger_votes")
        .select("outfit_id, verdict")
        .eq("user_id", req.userId)
        .in("outfit_id", outfitIds);

      const userVotes = {};
      (votes || []).forEach(v => { userVotes[v.outfit_id] = v.verdict; });
      result.user_votes = userVotes;

      // Get cadence info from streak
      const { data: streak } = await supabase
        .from("hanger_streaks")
        .select("*")
        .eq("user_id", req.userId)
        .maybeSingle();

      const votesToday = (streak?.cadence_date === today) ? (streak?.cadence_votes_today || 0) : 0;

      // Compute next midnight UTC
      const now = new Date();
      const nextReset = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0));

      result.cadence = {
        votes_today: votesToday,
        total: outfits.length,
        completed: votesToday >= outfits.length,
        next_reset: nextReset.toISOString(),
      };

      if (streak) {
        const yesterday = new Date(Date.now() - 86400000).toISOString().split("T")[0];
        const isActive = streak.last_vote_date === today || streak.last_vote_date === yesterday;
        result.streak = {
          current_streak: isActive ? streak.current_streak : 0,
          longest_streak: streak.longest_streak,
          total_votes: streak.total_votes,
          taste_badge: streak.taste_badge,
        };
      }

      // Get taste profile
      const { data: taste } = await supabase
        .from("hanger_taste_profiles")
        .select("*")
        .eq("user_id", req.userId)
        .maybeSingle();

      if (taste) {
        result.taste_profile = {
          style_breakdown: taste.style_breakdown,
          archetype: taste.archetype,
          wear_rate: taste.wear_rate,
        };
      }
    }

    res.json(result);
  } catch (err) {
    console.error("[HangerTest] Today error:", err.message);
    res.status(500).json({ error: "Failed to load today's outfits" });
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
    // Get voter's archetype from style DNA cache
    const { data: voterProfile } = await supabase
      .from("profiles")
      .select("style_dna_cache")
      .eq("id", req.userId)
      .maybeSingle();
    const voterArchetype = voterProfile?.style_dna_cache?.archetype?.toLowerCase()?.split(" ").pop() || null;

    // Use RPC for atomic vote + streak update (with archetype)
    const { data, error } = await supabase.rpc("record_hanger_vote", {
      p_user_id: req.userId,
      p_outfit_id: outfit_id,
      p_verdict: verdict,
      p_voter_archetype: voterArchetype,
    });

    if (error) {
      // Duplicate vote
      if (error.message?.includes("duplicate") || error.code === "23505") {
        return res.status(409).json({ error: "Already voted on this outfit" });
      }
      throw error;
    }

    // Get tranche stats if voter has archetype
    let trancheStats = null;
    if (voterArchetype) {
      const { data: ts } = await supabase.rpc("get_hanger_tranche_stats", {
        p_outfit_id: outfit_id,
        p_archetype: voterArchetype,
      });
      trancheStats = ts;
    }

    // Check if cadence completed (5th vote)
    const cadenceComplete = data.cadence_votes_today >= 5;
    let tasteProfile = null;
    if (cadenceComplete) {
      tasteProfile = await recomputeTasteProfile(req.userId);
    }

    const total = data.wear_count + data.pass_count;

    const result = {
      success: true,
      stats: {
        wear_pct: total > 0 ? Math.round((data.wear_count / total) * 100) : 50,
        pass_pct: total > 0 ? Math.round((data.pass_count / total) * 100) : 50,
        total_votes: total,
      },
      tranche_stats: trancheStats,
      cadence: {
        votes_today: data.cadence_votes_today,
        total: 5,
        completed: cadenceComplete,
      },
      streak: {
        current_streak: data.current_streak,
        longest_streak: data.longest_streak,
        total_votes: data.total_votes,
      },
      earned_insight: data.earned_insight,
      earned_badge: data.earned_badge,
      taste_profile_updated: cadenceComplete,
      taste_profile: tasteProfile,
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
        .select("tier, trial_ends_at")
        .eq("id", req.userId)
        .single();

      const isPro = profile?.tier === "pro" || profile?.tier === "trial";

      // 7-day streak reward: 48h Pro trial for free users (one-time only)
      const currentTier = profile?.tier;
      if ((currentTier === "free" || !currentTier) && !profile?.trial_ends_at) {
        const trialEnd = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();
        await supabase
          .from("profiles")
          .update({ tier: "trial", trial_ends_at: trialEnd })
          .eq("id", req.userId);
        profile.tier = "trial";
        result.earned_trial = true;
        result.trial_ends_at = trialEnd;
      }

      const isFirstInsight = (streakData?.insight_count || 0) === 0;

      if (isFirstInsight || isPro) {
        const insight = await generateStyleInsight(req.userId);
        if (insight) {
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

// ── Helper: recompute taste profile from vote history ─────────
async function recomputeTasteProfile(userId) {
  // Fetch last 50 votes with outfit data
  const { data: votes } = await supabase
    .from("hanger_votes")
    .select("verdict, outfit_id, hanger_outfits(style_tags, style_archetype, description)")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(50);

  if (!votes?.length) return null;

  const wearOutfits = votes.filter(v => v.verdict === "wear");
  const passOutfits = votes.filter(v => v.verdict === "pass");
  const wearRate = Math.round((wearOutfits.length / votes.length) * 100 * 100) / 100;

  // Count style archetype frequencies in wear votes
  const archCounts = {};
  wearOutfits.forEach(v => {
    const arch = v.hanger_outfits?.style_archetype || "eclectic";
    archCounts[arch] = (archCounts[arch] || 0) + 1;
  });
  const totalWear = wearOutfits.length || 1;
  const styleBreakdown = Object.entries(archCounts)
    .map(([style, count]) => ({ style, pct: Math.round((count / totalWear) * 100) }))
    .sort((a, b) => b.pct - a.pct);

  // Determine archetype from top style
  const topStyle = styleBreakdown[0]?.style || "eclectic";
  const archetypeMap = {
    streetwear: "The Street Style Maven",
    minimalist: "The Urban Minimalist",
    classic: "The Timeless Classic",
    bold: "The Statement Maker",
    athleisure: "The Active Stylist",
    vintage: "The Vintage Curator",
    formal: "The Refined Professional",
    coastal: "The Coastal Cool",
    eclectic: "The Free Spirit",
  };
  const archetype = archetypeMap[topStyle] || "The Free Spirit";

  // Collect vibes from wear vs pass tags
  const wearTags = wearOutfits.flatMap(v => v.hanger_outfits?.style_tags || []);
  const passTags = passOutfits.flatMap(v => v.hanger_outfits?.style_tags || []);
  const wearTagCounts = {};
  wearTags.forEach(t => { wearTagCounts[t] = (wearTagCounts[t] || 0) + 1; });
  const passTagCounts = {};
  passTags.forEach(t => { passTagCounts[t] = (passTagCounts[t] || 0) + 1; });

  const favoriteVibes = Object.entries(wearTagCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([tag]) => tag);
  const avoidVibes = Object.entries(passTagCounts)
    .filter(([tag]) => !wearTagCounts[tag] || wearTagCounts[tag] < passTagCounts[tag])
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([tag]) => tag);

  const profile = {
    style_breakdown: styleBreakdown,
    archetype,
    favorite_vibes: favoriteVibes,
    avoid_vibes: avoidVibes,
    wear_rate: wearRate,
    total_votes: votes.length,
  };

  // Upsert taste profile
  await supabase.from("hanger_taste_profiles").upsert({
    user_id: userId,
    ...profile,
    last_computed: new Date().toISOString(),
  }, { onConflict: "user_id" });

  // Update profiles cache for feed/search
  await supabase.from("profiles").update({
    hanger_taste_cache: { style_breakdown: styleBreakdown, favorite_vibes: favoriteVibes, avoid_vibes: avoidVibes, wear_rate: wearRate },
  }).eq("id", userId);

  return profile;
}

// ═══════════════════════════════════════════════════════════════
// GET /api/hanger-test/taste-profile — User's taste profile
// ═══════════════════════════════════════════════════════════════
router.get("/hanger-test/taste-profile", requireAuth, async (req, res) => {
  try {
    const { data: taste } = await supabase
      .from("hanger_taste_profiles")
      .select("*")
      .eq("user_id", req.userId)
      .maybeSingle();

    if (!taste) return res.json({ ready: false });

    // Check user tier for gating
    const { data: userStatus } = await supabase
      .from("profiles")
      .select("tier")
      .eq("id", req.userId)
      .maybeSingle();
    const isPro = userStatus?.tier === "pro" || userStatus?.tier === "trial";

    return res.json({
      ready: true,
      archetype: taste.archetype,
      style_breakdown: isPro ? taste.style_breakdown : (taste.style_breakdown || []).slice(0, 3),
      wear_rate: taste.wear_rate,
      total_votes: taste.total_votes,
      favorite_vibes: isPro ? taste.favorite_vibes : null,
      avoid_vibes: isPro ? taste.avoid_vibes : null,
      is_pro_gated: !isPro,
    });
  } catch (err) {
    console.error("[HangerTest] Taste profile error:", err.message);
    return res.status(500).json({ error: "Failed to load taste profile" });
  }
});

// ═══════════════════════════════════════════════════════════════
// GET /api/hanger-test/tranche/:outfitId — Tranche stats
// ═══════════════════════════════════════════════════════════════
router.get("/hanger-test/tranche/:outfitId", requireAuth, async (req, res) => {
  try {
    const { outfitId } = req.params;

    // Get user's archetype
    const { data: profile } = await supabase
      .from("profiles")
      .select("style_dna_cache")
      .eq("id", req.userId)
      .maybeSingle();
    const userArchetype = profile?.style_dna_cache?.archetype?.toLowerCase()?.split(" ").pop() || null;

    const { data: stats } = await supabase.rpc("get_hanger_tranche_stats", {
      p_outfit_id: outfitId,
      p_archetype: userArchetype || "none",
    });

    return res.json({ ...stats, user_tranche: userArchetype });
  } catch (err) {
    console.error("[HangerTest] Tranche stats error:", err.message);
    return res.status(500).json({ error: "Failed to load tranche stats" });
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
