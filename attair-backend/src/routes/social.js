import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import supabase from "../lib/supabase.js";

const router = Router();

const VALID_VISIBILITY = ["public", "private", "followers"];

// ─── POST /api/follow/:userId ────────────────────────────────
router.post("/follow/:userId", requireAuth, async (req, res) => {
  const { userId: targetId } = req.params;

  if (targetId === req.userId) {
    return res.status(400).json({ error: "Cannot follow yourself" });
  }

  try {
    const { error } = await supabase
      .from("follows")
      .insert({ follower_id: req.userId, following_id: targetId });

    if (error) {
      // Postgres unique constraint violation = already following
      if (error.code === "23505") {
        return res.status(409).json({ error: "Already following this user" });
      }
      throw error;
    }

    return res.json({ following: true });
  } catch (err) {
    console.error("Follow error:", err.message);
    return res.status(500).json({ error: "Failed to follow user" });
  }
});

// ─── DELETE /api/follow/:userId ──────────────────────────────
router.delete("/follow/:userId", requireAuth, async (req, res) => {
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

// ─── GET /api/followers/:userId ──────────────────────────────
router.get("/followers/:userId", requireAuth, async (req, res) => {
  const { userId: targetId } = req.params;

  try {
    const { data, error } = await supabase
      .from("follows")
      .select("follower_id, profiles!follows_follower_id_fkey(display_name, avatar_url)")
      .eq("following_id", targetId);

    if (error) throw error;

    const followers = (data || []).map(row => ({
      id: row.follower_id,
      display_name: row.profiles?.display_name || null,
      avatar_url: row.profiles?.avatar_url || null,
    }));

    return res.json({ followers, count: followers.length });
  } catch (err) {
    console.error("Followers error:", err.message);
    return res.status(500).json({ error: "Failed to fetch followers" });
  }
});

// ─── GET /api/following/:userId ──────────────────────────────
router.get("/following/:userId", requireAuth, async (req, res) => {
  const { userId: targetId } = req.params;

  try {
    const { data, error } = await supabase
      .from("follows")
      .select("following_id, profiles!follows_following_id_fkey(display_name, avatar_url)")
      .eq("follower_id", targetId);

    if (error) throw error;

    const following = (data || []).map(row => ({
      id: row.following_id,
      display_name: row.profiles?.display_name || null,
      avatar_url: row.profiles?.avatar_url || null,
    }));

    return res.json({ following, count: following.length });
  } catch (err) {
    console.error("Following error:", err.message);
    return res.status(500).json({ error: "Failed to fetch following" });
  }
});

// ─── GET /api/profile/:userId ────────────────────────────────
router.get("/profile/:userId", requireAuth, async (req, res) => {
  const { userId: targetId } = req.params;
  const isSelf = req.userId === targetId;

  try {
    // Fetch profile basics
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

    // Check whether req.userId follows targetId (for 'followers' visibility)
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

    // Determine which visibility levels are readable
    // Self: all. Follower: public + followers. Others: public only.
    const allowedVisibilities = isSelf
      ? ["public", "private", "followers"]
      : isFollowing
        ? ["public", "followers"]
        : ["public"];

    // Public scans
    let scansQuery = supabase
      .from("scans")
      .select("id, scan_name, image_thumbnail, created_at, visibility")
      .eq("user_id", targetId)
      .in("visibility", allowedVisibilities)
      .order("created_at", { ascending: false })
      .limit(20);

    const { data: scans } = await scansQuery;

    // Public saved items
    const { data: savedItems } = await supabase
      .from("saved_items")
      .select("id, item_data, selected_tier, created_at, visibility")
      .eq("user_id", targetId)
      .in("visibility", allowedVisibilities)
      .order("created_at", { ascending: false })
      .limit(20);

    // Public wishlists / collections
    const { data: wishlists } = await supabase
      .from("wishlists")
      .select("id, name, visibility, created_at")
      .eq("user_id", targetId)
      .in("visibility", allowedVisibilities)
      .order("created_at", { ascending: false });

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
      scans: scans || [],
      saved_items: savedItems || [],
      collections: wishlists || [],
    });
  } catch (err) {
    console.error("Public profile error:", err.message);
    return res.status(500).json({ error: "Failed to fetch profile" });
  }
});

// ─── PATCH /api/scans/:scanId/visibility ─────────────────────
router.patch("/scans/:scanId/visibility", requireAuth, async (req, res) => {
  const { scanId } = req.params;
  const { visibility } = req.body;

  if (!VALID_VISIBILITY.includes(visibility)) {
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

// ─── PATCH /api/saved-items/:itemId/visibility ───────────────
router.patch("/saved-items/:itemId/visibility", requireAuth, async (req, res) => {
  const { itemId } = req.params;
  const { visibility } = req.body;

  if (!VALID_VISIBILITY.includes(visibility)) {
    return res.status(400).json({ error: "visibility must be 'public', 'private', or 'followers'" });
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

// ─── PATCH /api/collections/:collectionId/visibility ─────────
router.patch("/collections/:collectionId/visibility", requireAuth, async (req, res) => {
  const { collectionId } = req.params;
  const { visibility } = req.body;

  if (!VALID_VISIBILITY.includes(visibility)) {
    return res.status(400).json({ error: "visibility must be 'public', 'private', or 'followers'" });
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

export default router;
