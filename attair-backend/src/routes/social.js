import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import supabase from "../lib/supabase.js";
import { sendNotification } from "../services/notifications.js";

const router = Router();

// ─── Feed scoring helpers ────────────────────────────────────
function recencyScore(createdAt) {
  const ageHours = (Date.now() - new Date(createdAt).getTime()) / (1000 * 60 * 60);
  if (ageHours < 6) return 70;
  if (ageHours < 24) return 60;
  if (ageHours < 72) return 40;
  if (ageHours < 168) return 20;
  return 5;
}

function tasteFeedScore(scanItems, hangerTaste) {
  if (!hangerTaste?.style_breakdown?.length || !scanItems?.length) return 0;
  const tasteMap = {};
  (hangerTaste.style_breakdown || []).forEach(s => { tasteMap[s.style] = s.pct; });

  // Extract style keywords from scan items
  const scanTags = scanItems.flatMap(item => {
    const tags = [];
    if (item.category) tags.push(item.category.toLowerCase());
    if (item.subcategory) tags.push(item.subcategory.toLowerCase());
    if (item.fit) tags.push(item.fit.toLowerCase());
    return tags;
  });

  // Simple keyword matching against taste buckets
  const TASTE_KEYWORDS = {
    streetwear: ["streetwear", "urban", "oversized", "hoodie", "sneaker", "graphic"],
    minimalist: ["minimal", "clean", "simple", "neutral"],
    classic: ["classic", "preppy", "tailored", "blazer", "oxford"],
    bold: ["bold", "statement", "bright", "pattern", "colorful"],
    athleisure: ["athletic", "sporty", "gym", "activewear"],
    vintage: ["vintage", "retro", "thrift"],
  };

  let score = 0;
  for (const [style, keywords] of Object.entries(TASTE_KEYWORDS)) {
    const matches = scanTags.filter(t => keywords.some(k => t.includes(k))).length;
    if (matches > 0 && tasteMap[style]) {
      score += (tasteMap[style] / 100) * matches * 10;
    }
  }
  return Math.min(score, 30); // cap at 30 bonus points
}

// Scans support 'followers' visibility; saved_items and collections only public/private
const VALID_SCAN_VISIBILITY = ["public", "private", "followers"];
const VALID_ITEM_VISIBILITY = ["public", "private"];

// ─── POST /api/social/follow/:userId ────────────────────────
router.post("/social/follow/:userId", requireAuth, async (req, res) => {
  const { userId: targetId } = req.params;

  if (targetId === req.userId) {
    return res.status(400).json({ error: "Cannot follow yourself" });
  }

  try {
    const { error } = await supabase
      .from("follows")
      .insert({ follower_id: req.userId, following_id: targetId });

    if (error) {
      // Unique constraint violation = already following — treat as success
      if (error.code === "23505") {
        return res.json({ following: true });
      }
      throw error;
    }

    // Send push notification to the followed user (non-blocking)
    supabase
      .from("profiles")
      .select("display_name")
      .eq("id", req.userId)
      .single()
      .then(({ data: followerProfile }) => {
        const name = followerProfile?.display_name || "Someone";
        sendNotification(
          targetId,
          "social",
          "New Follower",
          `${name} started following you`,
          { url: `/profile/${req.userId}` }
        ).catch(err => console.warn('[Notif]', err.message));
      });

    return res.json({ following: true });
  } catch (err) {
    console.error("Follow error:", err.message);
    return res.status(500).json({ error: "Failed to follow user" });
  }
});

// ─── DELETE /api/social/follow/:userId ──────────────────────
router.delete("/social/follow/:userId", requireAuth, async (req, res) => {
  const { userId: targetId } = req.params;

  try {
    const { error } = await supabase
      .from("follows")
      .delete()
      .eq("follower_id", req.userId)
      .eq("following_id", targetId);

    if (error) throw error;

    return res.json({ following: false });
  } catch (err) {
    console.error("Unfollow error:", err.message);
    return res.status(500).json({ error: "Failed to unfollow user" });
  }
});

// ─── GET /api/social/followers/:userId ──────────────────────
router.get("/social/followers/:userId", requireAuth, async (req, res) => {
  const { userId: targetId } = req.params;
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = 50;
  const offset = (page - 1) * limit;

  try {
    // Check target profile privacy before exposing the list
    const { data: targetProfile, error: profileErr } = await supabase
      .from("profiles")
      .select("is_private")
      .eq("id", targetId)
      .single();

    if (profileErr || !targetProfile) {
      return res.status(404).json({ error: "Profile not found" });
    }

    const isSelf = req.userId === targetId;
    if (!isSelf && targetProfile.is_private) {
      // Private profile — return only the count, not the list
      const { count } = await supabase
        .from("follows")
        .select("*", { count: "exact", head: true })
        .eq("following_id", targetId);
      return res.json({ count: count || 0 });
    }

    const { data, error } = await supabase
      .from("follows")
      .select("follower_id, profiles!follows_follower_id_fkey(display_name, avatar_url)")
      .eq("following_id", targetId)
      .range(offset, offset + limit - 1);

    if (error) throw error;

    const followers = (data || []).map(row => ({
      id: row.follower_id,
      display_name: row.profiles?.display_name || null,
      avatar_url: row.profiles?.avatar_url || null,
    }));

    return res.json({ followers, count: followers.length, page });
  } catch (err) {
    console.error("Followers error:", err.message);
    return res.status(500).json({ error: "Failed to fetch followers" });
  }
});

// ─── GET /api/social/following/:userId ──────────────────────
router.get("/social/following/:userId", requireAuth, async (req, res) => {
  const { userId: targetId } = req.params;
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = 50;
  const offset = (page - 1) * limit;

  try {
    // Check target profile privacy before exposing the list
    const { data: targetProfile, error: profileErr } = await supabase
      .from("profiles")
      .select("is_private")
      .eq("id", targetId)
      .single();

    if (profileErr || !targetProfile) {
      return res.status(404).json({ error: "Profile not found" });
    }

    const isSelf = req.userId === targetId;
    if (!isSelf && targetProfile.is_private) {
      // Private profile — return only the count, not the list
      const { count } = await supabase
        .from("follows")
        .select("*", { count: "exact", head: true })
        .eq("follower_id", targetId);
      return res.json({ count: count || 0 });
    }

    const { data, error } = await supabase
      .from("follows")
      .select("following_id, profiles!follows_following_id_fkey(display_name, avatar_url)")
      .eq("follower_id", targetId)
      .range(offset, offset + limit - 1);

    if (error) throw error;

    const following = (data || []).map(row => ({
      id: row.following_id,
      display_name: row.profiles?.display_name || null,
      avatar_url: row.profiles?.avatar_url || null,
    }));

    return res.json({ following, count: following.length, page });
  } catch (err) {
    console.error("Following error:", err.message);
    return res.status(500).json({ error: "Failed to fetch following" });
  }
});

// ─── GET /api/social/profile/:userId ────────────────────────
router.get("/social/profile/:userId", requireAuth, async (req, res) => {
  const { userId: targetId } = req.params;
  const isSelf = req.userId === targetId;

  try {
    const { data: profile, error: profileError } = await supabase
      .from("profiles")
      .select("id, display_name, bio, avatar_url, style_interests, created_at")
      .eq("id", targetId)
      .single();

    if (profileError || !profile) {
      return res.status(404).json({ error: "Profile not found" });
    }

    // Follower / following counts
    const [{ count: followerCount }, { count: followingCount }] = await Promise.all([
      supabase.from("follows").select("*", { count: "exact", head: true }).eq("following_id", targetId),
      supabase.from("follows").select("*", { count: "exact", head: true }).eq("follower_id", targetId),
    ]);

    // Check whether the authenticated user follows the target
    let isFollowing = false;
    if (!isSelf) {
      const { data: followRow } = await supabase
        .from("follows")
        .select("follower_id")
        .eq("follower_id", req.userId)
        .eq("following_id", targetId)
        .maybeSingle();
      isFollowing = !!followRow;
    }

    // Determine which visibility levels the requester may read
    // Self: all. Follower: public + followers. Others: public only.
    const allowedVisibilities = isSelf
      ? ["public", "private", "followers"]
      : isFollowing
        ? ["public", "followers"]
        : ["public"];

    // Fetch scans, saved items, and wishlists in parallel
    const [scansResult, savedResult, wishlistsResult] = await Promise.all([
      supabase
        .from("scans")
        .select("id, scan_name, image_thumbnail, created_at, visibility")
        .eq("user_id", targetId)
        .in("visibility", allowedVisibilities)
        .order("created_at", { ascending: false })
        .limit(20),
      supabase
        .from("saved_items")
        .select("id, item_data, selected_tier, created_at, visibility")
        .eq("user_id", targetId)
        .in("visibility", ["public"])
        .order("created_at", { ascending: false })
        .limit(20),
      supabase
        .from("wishlists")
        .select("id, name, visibility, created_at")
        .eq("user_id", targetId)
        .in("visibility", ["public"])
        .order("created_at", { ascending: false }),
    ]);

    return res.json({
      profile: {
        id: profile.id,
        display_name: profile.display_name,
        bio: profile.bio,
        avatar_url: profile.avatar_url,
        style_interests: profile.style_interests || [],
        created_at: profile.created_at,
      },
      follower_count: followerCount || 0,
      following_count: followingCount || 0,
      is_following: isFollowing,
      scans: scansResult.data || [],
      saved_items: savedResult.data || [],
      collections: wishlistsResult.data || [],
    });
  } catch (err) {
    console.error("Public profile error:", err.message);
    return res.status(500).json({ error: "Failed to fetch profile" });
  }
});

// ─── PATCH /api/social/scans/:scanId/visibility ──────────────
router.patch("/social/scans/:scanId/visibility", requireAuth, async (req, res) => {
  const { scanId } = req.params;
  const { visibility } = req.body;

  if (!VALID_SCAN_VISIBILITY.includes(visibility)) {
    return res.status(400).json({ error: "visibility must be 'public', 'private', or 'followers'" });
  }

  try {
    const { data, error } = await supabase
      .from("scans")
      .update({ visibility })
      .eq("id", scanId)
      .eq("user_id", req.userId)
      .select("id, visibility")
      .single();

    if (error) throw error;
    if (!data) return res.status(404).json({ error: "Scan not found" });

    return res.json(data);
  } catch (err) {
    console.error("Scan visibility error:", err.message);
    return res.status(500).json({ error: "Failed to update scan visibility" });
  }
});

// ─── PATCH /api/social/saved-items/:itemId/visibility ────────
router.patch("/social/saved-items/:itemId/visibility", requireAuth, async (req, res) => {
  const { itemId } = req.params;
  const { visibility } = req.body;

  if (!VALID_ITEM_VISIBILITY.includes(visibility)) {
    return res.status(400).json({ error: "visibility must be 'public' or 'private'" });
  }

  try {
    const { data, error } = await supabase
      .from("saved_items")
      .update({ visibility })
      .eq("id", itemId)
      .eq("user_id", req.userId)
      .select("id, visibility")
      .single();

    if (error) throw error;
    if (!data) return res.status(404).json({ error: "Saved item not found" });

    return res.json(data);
  } catch (err) {
    console.error("Saved item visibility error:", err.message);
    return res.status(500).json({ error: "Failed to update saved item visibility" });
  }
});

// ─── PATCH /api/social/collections/:collectionId/visibility ──
router.patch("/social/collections/:collectionId/visibility", requireAuth, async (req, res) => {
  const { collectionId } = req.params;
  const { visibility } = req.body;

  if (!VALID_ITEM_VISIBILITY.includes(visibility)) {
    return res.status(400).json({ error: "visibility must be 'public' or 'private'" });
  }

  try {
    const { data, error } = await supabase
      .from("wishlists")
      .update({ visibility })
      .eq("id", collectionId)
      .eq("user_id", req.userId)
      .select("id, visibility")
      .single();

    if (error) throw error;
    if (!data) return res.status(404).json({ error: "Collection not found" });

    return res.json(data);
  } catch (err) {
    console.error("Collection visibility error:", err.message);
    return res.status(500).json({ error: "Failed to update collection visibility" });
  }
});

// ─── PATCH /api/social/profile ───────────────────────────────
router.patch("/social/profile", requireAuth, async (req, res) => {
  const { bio, display_name } = req.body;

  const updates = {};

  if (display_name !== undefined) {
    if (typeof display_name !== "string") {
      return res.status(400).json({ error: "display_name must be a string" });
    }
    if (display_name.length > 50) {
      return res.status(400).json({ error: "display_name must be 50 characters or less" });
    }
    updates.display_name = display_name;
  }

  if (bio !== undefined) {
    if (bio !== null) {
      if (typeof bio !== "string") {
        return res.status(400).json({ error: "bio must be a string" });
      }
      if (bio.length > 200) {
        return res.status(400).json({ error: "bio must be 200 characters or less" });
      }
      updates.bio = bio;
    } else {
      updates.bio = null;
    }
  }

  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ error: "No fields to update" });
  }

  try {
    const { data, error } = await supabase
      .from("profiles")
      .update(updates)
      .eq("id", req.userId)
      .select("id, display_name, bio, avatar_url, created_at")
      .single();

    if (error) throw error;

    return res.json(data);
  } catch (err) {
    console.error("Social profile update error:", err.message);
    return res.status(500).json({ error: "Failed to update profile" });
  }
});

// ─── Trending score helper ───────────────────────────────────
// Score = save_count * recency_multiplier
// Recency: scans from last 24h get 1.0x, 3 days → 0.7x, 7 days → 0.4x, older → 0.15x
function trendingScore(saveCount, createdAt) {
  const ageHrs = (Date.now() - new Date(createdAt).getTime()) / (1000 * 60 * 60);
  let recency;
  if (ageHrs <= 24) recency = 1.0;
  else if (ageHrs <= 72) recency = 0.7;
  else if (ageHrs <= 168) recency = 0.4;
  else recency = 0.15;
  // Base score of 0.1 so new scans with 0 saves still appear (just ranked low)
  return (saveCount + 0.1) * recency;
}

// ─── GET /api/feed ───────────────────────────────────────────
// Supports tabs: "foryou", "following", "trending"
router.get("/feed", requireAuth, async (req, res) => {
  const page = Math.min(Math.max(1, parseInt(req.query.page) || 1), 1000);
  const limit = Math.min(50, Math.max(1, parseInt(req.query.limit) || 20));
  const offset = (page - 1) * limit;
  const tab = req.query.tab || "foryou";

  try {
    // ─── Trending tab: fetch a larger pool, score & sort ────
    if (tab === "trending") {
      // Grab up to 200 recent public scans (pool for scoring)
      const poolSize = Math.min(200, offset + limit + 80);
      const { data: pool, error: poolErr } = await supabase
        .from("scans")
        .select("id, user_id, image_url, summary, items, created_at, visibility")
        .eq("visibility", "public")
        .neq("user_id", req.userId)
        .not("image_url", "is", null)
        .order("created_at", { ascending: false })
        .range(0, poolSize - 1);
      if (poolErr) throw poolErr;

      if (!pool || pool.length === 0) {
        return res.json({ scans: [], page, has_more: false });
      }

      // Get save counts for all pool scans
      const poolIds = pool.map(s => s.id);
      const userIds = [...new Set(pool.map(s => s.user_id))];

      const [{ data: profiles }, { data: saveRows }] = await Promise.all([
        supabase.from("profiles").select("id, display_name, bio").in("id", userIds),
        supabase.from("saved_items").select("scan_id").in("scan_id", poolIds),
      ]);

      const profileMap = {};
      (profiles || []).forEach(p => { profileMap[p.id] = p; });

      const saveCountMap = {};
      (saveRows || []).forEach(row => {
        if (row.scan_id) saveCountMap[row.scan_id] = (saveCountMap[row.scan_id] || 0) + 1;
      });

      // Score and sort
      const scored = pool.map(s => ({
        id: s.id,
        image_url: s.image_url,
        summary: s.summary,
        items: Array.isArray(s.items) ? s.items : [],
        item_count: Array.isArray(s.items) ? s.items.length : 0,
        created_at: s.created_at,
        save_count: saveCountMap[s.id] || 0,
        trending_score: trendingScore(saveCountMap[s.id] || 0, s.created_at),
        user: profileMap[s.user_id] || { display_name: "Anonymous" },
      }));
      scored.sort((a, b) => b.trending_score - a.trending_score);

      const paged = scored.slice(offset, offset + limit);
      return res.json({ scans: paged, page, has_more: scored.length > offset + limit });
    }

    // ─── For You / Following tabs ────────────────────────────
    const { data: following } = await supabase
      .from("follows")
      .select("following_id")
      .eq("follower_id", req.userId);

    const followingIds = (following || []).map(f => f.following_id);

    let query;
    if (tab === "following" && followingIds.length > 0) {
      query = supabase
        .from("scans")
        .select("id, user_id, image_url, summary, items, created_at, visibility")
        .in("user_id", followingIds)
        .eq("visibility", "public")
        .order("created_at", { ascending: false })
        .range(offset, offset + limit - 1);
    } else if (tab === "following") {
      return res.json({ scans: [], page, has_more: false });
    } else {
      // For You — all public scans except own, scored by recency + taste
      query = supabase
        .from("scans")
        .select("id, user_id, image_url, summary, items, created_at, visibility")
        .eq("visibility", "public")
        .neq("user_id", req.userId)
        .order("created_at", { ascending: false })
        .range(offset, offset + limit - 1);
    }

    const { data: scans, error } = await query;
    if (error) throw error;

    if (scans && scans.length > 0) {
      const userIds = [...new Set(scans.map(s => s.user_id))];
      const scanIds = scans.map(s => s.id);

      const [{ data: profiles }, { data: saveRows }] = await Promise.all([
        supabase.from("profiles").select("id, display_name, bio").in("id", userIds),
        supabase.from("saved_items").select("scan_id").in("scan_id", scanIds),
      ]);

      const profileMap = {};
      (profiles || []).forEach(p => { profileMap[p.id] = p; });

      const saveCountMap = {};
      (saveRows || []).forEach(row => {
        if (row.scan_id) saveCountMap[row.scan_id] = (saveCountMap[row.scan_id] || 0) + 1;
      });

      // Fetch user's taste cache for personalization (For You tab only)
      let hangerTaste = null;
      if (tab !== "following") {
        const { data: userProfile } = await supabase
          .from("profiles")
          .select("hanger_taste_cache")
          .eq("id", req.userId)
          .maybeSingle();
        hangerTaste = userProfile?.hanger_taste_cache;
      }

      const enriched = scans.map(s => ({
        id: s.id,
        image_url: s.image_url,
        summary: s.summary,
        items: Array.isArray(s.items) ? s.items : [],
        item_count: Array.isArray(s.items) ? s.items.length : 0,
        created_at: s.created_at,
        save_count: saveCountMap[s.id] || 0,
        user: profileMap[s.user_id] || { display_name: "Anonymous" },
        _score: tab !== "following"
          ? recencyScore(s.created_at) + tasteFeedScore(s.items, hangerTaste)
          : 0,
      }));

      // Sort by personalized score for For You tab (taste + recency)
      if (tab !== "following") {
        enriched.sort((a, b) => b._score - a._score);
      }
      // Remove internal score from response
      enriched.forEach(s => delete s._score);

      return res.json({ scans: enriched, page, has_more: scans.length === limit });
    }

    return res.json({ scans: [], page, has_more: false });
  } catch (err) {
    console.error("Feed error:", err.message);
    return res.status(500).json({ error: "Failed to load feed" });
  }
});

// ─── GET /api/users/search ───────────────────────────────────
// Search users by display_name (min 2 chars, max 100 chars).
router.get("/users/search", requireAuth, async (req, res) => {
  const q = (req.query.q || "").trim();
  if (!q || q.length < 2) {
    return res.status(400).json({ error: "Search query must be at least 2 characters" });
  }
  if (q.length > 100) {
    return res.status(400).json({ error: "Search query too long" });
  }

  try {
    const { data, error } = await supabase
      .from("profiles")
      .select("id, display_name, bio")
      .ilike("display_name", `%${q}%`)
      .neq("id", req.userId)
      .limit(20);

    if (error) throw error;

    // Get follower counts for each result
    const enriched = await Promise.all((data || []).map(async (user) => {
      const { count } = await supabase
        .from("follows")
        .select("*", { count: "exact", head: true })
        .eq("following_id", user.id);

      return {
        id: user.id,
        display_name: user.display_name,
        bio: user.bio,
        follower_count: count || 0
      };
    }));

    return res.json({ users: enriched });
  } catch (err) {
    console.error("User search error:", err.message);
    return res.status(500).json({ error: "Search failed" });
  }
});

// ─── GET /api/scan/:scanId/public ────────────────────────────
// Public scan data — no auth required (share link).
router.get("/scan/:scanId/public", async (req, res) => {
  const { scanId } = req.params;

  // Validate UUID format
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(scanId)) {
    return res.status(400).json({ error: "Invalid scan ID" });
  }

  try {
    const { data: scan, error } = await supabase
      .from("scans")
      .select("id, user_id, image_url, summary, items, created_at, visibility")
      .eq("id", scanId)
      .eq("visibility", "public")
      .single();

    if (error || !scan) {
      return res.status(404).json({ error: "Scan not found or not public" });
    }

    // Get user display_name
    const { data: profile } = await supabase
      .from("profiles")
      .select("display_name")
      .eq("id", scan.user_id)
      .single();

    return res.json({
      id: scan.id,
      image_url: scan.image_url,
      summary: scan.summary,
      items: scan.items,
      created_at: scan.created_at,
      user_display_name: profile?.display_name || "Anonymous"
    });
  } catch (err) {
    console.error("Public scan error:", err.message);
    return res.status(500).json({ error: "Failed to load scan" });
  }
});

export default router;
