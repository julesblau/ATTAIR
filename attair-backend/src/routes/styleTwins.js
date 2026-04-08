import { Router } from "express";
import rateLimit from "express-rate-limit";
import { requireAuth } from "../middleware/auth.js";
import supabase from "../lib/supabase.js";
import { sendNotification } from "../services/notifications.js";

const router = Router();

// Rate limit: 20 req/min per user
const twinsLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  keyGenerator: (req) => req.userId || req.ip,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests — try again in a minute" },
});

// ─── Euclidean distance computation ─────────────────────────

const STYLE_AXES = [
  "classic_vs_trendy",
  "minimal_vs_maximal",
  "casual_vs_formal",
  "budget_vs_luxury",
];

/**
 * Compute Euclidean distance between two style_score objects.
 * Each axis is 1-10 scale. Max distance = sqrt(4 * 9^2) = 18.
 */
export function euclideanDistance(a, b) {
  let sumSq = 0;
  for (const axis of STYLE_AXES) {
    const diff = (a[axis] ?? 5) - (b[axis] ?? 5);
    sumSq += diff * diff;
  }
  return Math.sqrt(sumSq);
}

const MAX_DISTANCE = Math.sqrt(4 * 81); // 18

/**
 * Convert Euclidean distance to a 0-100 match percentage.
 * 0 distance = 100% match, 18 distance = 0% match.
 */
export function distanceToMatchPct(distance) {
  return Math.round(Math.max(0, (1 - distance / MAX_DISTANCE) * 100));
}

/**
 * Find which style axes the two users are closest on.
 * Returns human-readable labels for axes within 2 points of each other.
 */
function getSharedAxes(a, b) {
  const axes = [
    { key: "classic_vs_trendy", low: "Classic", high: "Trendy" },
    { key: "minimal_vs_maximal", low: "Minimal", high: "Maximal" },
    { key: "casual_vs_formal", low: "Casual", high: "Formal" },
    { key: "budget_vs_luxury", low: "Budget", high: "Luxury" },
  ];

  const shared = [];
  for (const { key, low, high } of axes) {
    const diff = Math.abs((a[key] ?? 5) - (b[key] ?? 5));
    if (diff <= 2) {
      const avg = ((a[key] ?? 5) + (b[key] ?? 5)) / 2;
      shared.push(avg <= 4 ? low : avg >= 7 ? high : "Balanced");
    }
  }
  return shared;
}

// ─── GET /api/style-twins ───────────────────────────────────
// Returns 5-10 users with the closest Style DNA match.

router.get("/", requireAuth, twinsLimiter, async (req, res) => {
  try {
    const userId = req.userId;

    // 1. Fetch current user's cached Style DNA
    const { data: myProfile, error: profileErr } = await supabase
      .from("profiles")
      .select("style_dna_cache, display_name")
      .eq("id", userId)
      .single();

    if (profileErr) throw profileErr;

    const myDna = myProfile?.style_dna_cache;
    if (!myDna?.ready || !myDna?.style_score) {
      return res.json({
        ready: false,
        message: "Unlock your Style DNA first to find your Style Twins",
      });
    }

    // 2. Fetch all other profiles that have a style_dna_cache
    const { data: candidates, error: candidatesErr } = await supabase
      .from("profiles")
      .select("id, display_name, bio, avatar_url, style_dna_cache")
      .neq("id", userId)
      .not("style_dna_cache", "is", null);

    if (candidatesErr) throw candidatesErr;

    // 3. Compute distances and filter
    const twins = [];
    for (const profile of candidates || []) {
      const dna = profile.style_dna_cache;
      if (!dna?.ready || !dna?.style_score) continue;

      const distance = euclideanDistance(myDna.style_score, dna.style_score);
      const matchPct = distanceToMatchPct(distance);

      // Only include matches above 50%
      if (matchPct >= 50) {
        twins.push({
          id: profile.id,
          display_name: profile.display_name,
          bio: profile.bio,
          avatar_url: profile.avatar_url,
          match_pct: matchPct,
          archetype: dna.archetype || null,
          traits: (dna.traits || []).slice(0, 2),
          dominant_colors: (dna.stats?.dominant_colors || []).slice(0, 3).map(c => c.value),
          shared_axes: getSharedAxes(myDna.style_score, dna.style_score),
          style_score: dna.style_score || null,
        });
      }
    }

    // 4. Sort by match %, take top 10
    twins.sort((a, b) => b.match_pct - a.match_pct);
    const topTwins = twins.slice(0, 10);

    // 5. Enrich with shared saves (batch — one query for all twin IDs)
    if (topTwins.length > 0) {
      const twinIds = topTwins.map(t => t.id);

      // Fetch current user's saved item names
      const { data: mySaves } = await supabase
        .from("saved_items")
        .select("item_data")
        .eq("user_id", userId);

      const myItemNames = new Set(
        (mySaves || [])
          .map(s => (s.item_data?.name || "").toLowerCase())
          .filter(Boolean)
      );

      if (myItemNames.size > 0) {
        // Batch query: all public saves from all twins
        const { data: twinSaves } = await supabase
          .from("saved_items")
          .select("user_id, item_data")
          .in("user_id", twinIds)
          .eq("visibility", "public");

        // Group by twin ID
        const twinSaveMap = {};
        for (const row of twinSaves || []) {
          if (!twinSaveMap[row.user_id]) twinSaveMap[row.user_id] = [];
          twinSaveMap[row.user_id].push(row.item_data);
        }

        for (const twin of topTwins) {
          const saves = twinSaveMap[twin.id] || [];
          const sharedItems = saves
            .filter(item => myItemNames.has((item?.name || "").toLowerCase()))
            .map(item => item?.name)
            .slice(0, 3);
          twin.shared_saves_count = sharedItems.length;
          twin.shared_saves = sharedItems;
        }
      } else {
        for (const twin of topTwins) {
          twin.shared_saves_count = 0;
          twin.shared_saves = [];
        }
      }
    }

    // 6. Get follower/following status for twins
    if (topTwins.length > 0) {
      const twinIds = topTwins.map(t => t.id);
      const { data: followRows } = await supabase
        .from("follows")
        .select("following_id")
        .eq("follower_id", userId)
        .in("following_id", twinIds);

      const followingSet = new Set((followRows || []).map(r => r.following_id));
      for (const twin of topTwins) {
        twin.is_following = followingSet.has(twin.id);
      }
    }

    return res.json({
      ready: true,
      twins: topTwins,
      my_archetype: myDna.archetype || null,
      my_style_score: myDna.style_score || null,
      total_matches: twins.length,
    });
  } catch (err) {
    console.error("[StyleTwins] Error:", err.message);
    return res.status(500).json({ error: "Failed to find Style Twins" });
  }
});

// ─── GET /api/style-twins/shared-save-check ─────────────────
// Called after a user saves an item. Checks if any of their style twins
// also saved it. Returns a nudge message if so.

router.get("/shared-save-check", requireAuth, async (req, res) => {
  const itemName = (req.query.item_name || "").trim();
  if (!itemName) return res.json({ match: false });

  try {
    const userId = req.userId;

    // Get user's Style DNA
    const { data: myProfile } = await supabase
      .from("profiles")
      .select("style_dna_cache")
      .eq("id", userId)
      .single();

    const myDna = myProfile?.style_dna_cache;
    if (!myDna?.ready || !myDna?.style_score) {
      return res.json({ match: false });
    }

    // Find top 3 style twins
    const { data: candidates } = await supabase
      .from("profiles")
      .select("id, display_name, style_dna_cache")
      .neq("id", userId)
      .not("style_dna_cache", "is", null);

    const scored = (candidates || [])
      .filter(p => p.style_dna_cache?.ready && p.style_dna_cache?.style_score)
      .map(p => ({
        id: p.id,
        display_name: p.display_name,
        distance: euclideanDistance(myDna.style_score, p.style_dna_cache.style_score),
      }))
      .sort((a, b) => a.distance - b.distance)
      .slice(0, 5);

    if (scored.length === 0) return res.json({ match: false });

    // Check if any of these twins also saved this item
    const twinIds = scored.map(t => t.id);
    const { data: twinSaves } = await supabase
      .from("saved_items")
      .select("user_id, item_data")
      .in("user_id", twinIds)
      .eq("visibility", "public");

    const itemLower = itemName.toLowerCase();
    const matchingTwin = (twinSaves || []).find(
      s => (s.item_data?.name || "").toLowerCase() === itemLower
    );

    if (matchingTwin) {
      const twin = scored.find(t => t.id === matchingTwin.user_id);
      return res.json({
        match: true,
        message: `Your Style Twin ${twin?.display_name || "someone"} also saved this!`,
        twin_name: twin?.display_name || null,
        twin_id: twin?.id || null,
      });
    }

    return res.json({ match: false });
  } catch (err) {
    console.error("[StyleTwins] shared-save-check error:", err.message);
    return res.json({ match: false });
  }
});

// ─── POST /api/style-twins/weekly-notify ────────────────────
// Designed to be called by a cron job. Sends weekly "new style twins"
// notifications to users whose Style DNA changed or who have new matches.

router.post("/weekly-notify", async (req, res) => {
  // Simple API key auth for cron jobs
  const cronKey = req.headers["x-cron-key"];
  if (cronKey !== process.env.CRON_SECRET && process.env.NODE_ENV === "production") {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    // Fetch all profiles with Style DNA
    const { data: allProfiles } = await supabase
      .from("profiles")
      .select("id, display_name, style_dna_cache")
      .not("style_dna_cache", "is", null);

    const withDna = (allProfiles || []).filter(
      p => p.style_dna_cache?.ready && p.style_dna_cache?.style_score
    );

    let notified = 0;

    for (const user of withDna) {
      // Compute how many twins this user has
      let twinCount = 0;
      for (const other of withDna) {
        if (other.id === user.id) continue;
        const distance = euclideanDistance(
          user.style_dna_cache.style_score,
          other.style_dna_cache.style_score
        );
        if (distanceToMatchPct(distance) >= 60) twinCount++;
      }

      if (twinCount > 0) {
        await sendNotification(
          user.id,
          "style_twins",
          "New Style Twins discovered",
          `${twinCount} new style twin${twinCount === 1 ? "" : "s"} discovered. See who shares your taste!`,
          { url: "/discover?tab=twins" }
        ).catch(err => console.warn('[Notif]', err.message));
        notified++;
      }
    }

    return res.json({ ok: true, notified, total_with_dna: withDna.length });
  } catch (err) {
    console.error("[StyleTwins] weekly-notify error:", err.message);
    return res.status(500).json({ error: "Failed to send weekly notifications" });
  }
});

export default router;
