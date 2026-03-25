import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import supabase from "../lib/supabase.js";

const router = Router();

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

// ─── GET /api/social/following/:userId ──────────────────────
router.get("/social/following/:userId", requireAuth, async (req, res) => {
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

export default router;
