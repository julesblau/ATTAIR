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

/**
 * Full personalized feed scoring — uses preferences, style DNA, brand affinities,
 * attribute affinities, and price profiles to rank feed items for this specific user.
 *
 * @param {Array} scanItems - items array from a feed scan
 * @param {object} ctx - personalization context (all user data)
 * @returns {number} personalization score (0-80)
 */
function personalizedFeedScore(scanItems, ctx) {
  if (!scanItems?.length) return 0;
  let score = 0;

  // ── 1. Brand affinity (up to ±20) ────────────────────────
  if (ctx.brandAffinities && Object.keys(ctx.brandAffinities).length > 0) {
    let brandScore = 0;
    let brandMatches = 0;
    for (const item of scanItems) {
      const brand = (item.brand || "").toLowerCase();
      if (!brand) continue;
      // Check exact match or partial match
      for (const [affinBrand, aff] of Object.entries(ctx.brandAffinities)) {
        if (brand.includes(affinBrand.toLowerCase()) || affinBrand.toLowerCase().includes(brand)) {
          brandScore += aff.affinity_score * 25; // range ~-20 to +20
          brandMatches++;
          break;
        }
      }
    }
    if (brandMatches > 0) score += Math.max(-20, Math.min(20, brandScore / brandMatches));
  } else if (ctx.prefProfile) {
    // Fallback to preference profile brand lists
    for (const item of scanItems) {
      const brand = (item.brand || "").toLowerCase();
      if (!brand) continue;
      if (ctx.prefProfile.liked_brands?.some(b => brand.includes(b.toLowerCase()))) score += 15;
      if (ctx.prefProfile.avoided_brands?.some(b => brand.includes(b.toLowerCase()))) score -= 12;
    }
    score = Math.max(-20, Math.min(20, score));
  }

  // ── 2. Category preference (up to ±15) ───────────────────
  if (ctx.prefProfile) {
    let catScore = 0;
    for (const item of scanItems) {
      const cat = (item.category || "").toLowerCase();
      if (!cat) continue;
      if (ctx.prefProfile.preferred_categories?.includes(cat)) catScore += 12;
      if (ctx.prefProfile.avoided_categories?.includes(cat)) catScore -= 10;
    }
    score += Math.max(-15, Math.min(15, catScore));
  }

  // ── 3. Style DNA match (up to +20) ───────────────────────
  if (ctx.styleDna?.style_breakdown?.length) {
    const tasteMap = {};
    ctx.styleDna.style_breakdown.forEach(s => { tasteMap[s.style?.toLowerCase()] = s.pct; });

    const TASTE_KEYWORDS = {
      streetwear: ["streetwear", "urban", "oversized", "hoodie", "sneaker", "graphic", "cargo"],
      minimalist: ["minimal", "clean", "simple", "neutral", "basic", "understated"],
      classic: ["classic", "preppy", "tailored", "blazer", "oxford", "polo", "chino"],
      bold: ["bold", "statement", "bright", "pattern", "colorful", "print"],
      athleisure: ["athletic", "sporty", "gym", "activewear", "legging", "jogger", "track"],
      vintage: ["vintage", "retro", "thrift", "90s", "y2k"],
      elegant: ["elegant", "formal", "dress", "silk", "satin", "gown"],
      casual: ["casual", "relaxed", "lounge", "comfort", "everyday"],
    };

    const scanTags = scanItems.flatMap(it => {
      const tags = [];
      if (it.category) tags.push(it.category.toLowerCase());
      if (it.subcategory) tags.push(it.subcategory.toLowerCase());
      if (it.fit) tags.push(it.fit.toLowerCase());
      (it.style_keywords || []).forEach(k => tags.push(k.toLowerCase()));
      return tags;
    });

    let styleScore = 0;
    for (const [style, keywords] of Object.entries(TASTE_KEYWORDS)) {
      const matches = scanTags.filter(t => keywords.some(k => t.includes(k))).length;
      if (matches > 0 && tasteMap[style]) {
        styleScore += (tasteMap[style] / 100) * matches * 8;
      }
    }
    score += Math.min(styleScore, 20);
  }

  // ── 4. Color preference (up to ±8) ───────────────────────
  if (ctx.prefProfile?.color_preferences) {
    const posColors = ctx.prefProfile.color_preferences.positive || [];
    const negColors = ctx.prefProfile.color_preferences.negative || [];
    let colorScore = 0;
    for (const item of scanItems) {
      const color = (item.color || "").toLowerCase();
      if (!color) continue;
      if (posColors.some(c => color.includes(c))) colorScore += 6;
      if (negColors.some(c => color.includes(c))) colorScore -= 5;
    }
    score += Math.max(-8, Math.min(8, colorScore));
  }

  // ── 5. Price fit (up to ±12) ─────────────────────────────
  if (ctx.priceProfiles && Object.keys(ctx.priceProfiles).length > 0) {
    let priceScore = 0;
    let priceMatches = 0;
    for (const item of scanItems) {
      const cat = (item.category || "").toLowerCase();
      const priceStr = item.price || item.price_range || "";
      const nums = String(priceStr).match(/\d+/g);
      if (!nums || !cat) continue;
      const price = nums.length >= 2
        ? (parseFloat(nums[0]) + parseFloat(nums[1])) / 2
        : parseFloat(nums[0]);
      if (isNaN(price) || price <= 0) continue;

      const pp = ctx.priceProfiles[cat];
      if (pp && pp.sweet_spot > 0 && pp.std_dev > 0) {
        const z = (price - pp.sweet_spot) / pp.std_dev;
        priceScore += Math.exp(-0.5 * z * z) * 12; // Gaussian: peak +12 at sweet spot
        priceMatches++;
      }
    }
    if (priceMatches > 0) score += Math.min(12, priceScore / priceMatches);
  }

  // ── 6. Attribute affinities (up to +10) ──────────────────
  if (ctx.attrAffinities && Object.keys(ctx.attrAffinities).length > 0) {
    let attrScore = 0;
    let attrCount = 0;
    for (const item of scanItems) {
      const attrs = [item.color, item.material, item.category, item.subcategory, ...(item.style_keywords || [])].filter(Boolean);
      for (const attr of attrs) {
        const key = attr.toLowerCase();
        if (ctx.attrAffinities[key] !== undefined) {
          attrScore += ctx.attrAffinities[key];
          attrCount++;
        }
      }
    }
    if (attrCount > 0) score += Math.max(-5, Math.min(10, (attrScore / attrCount) * 20));
  }

  // ── 7. Style keyword match from preferences (up to +5) ──
  if (ctx.prefProfile?.style_keywords?.length) {
    const userKws = ctx.prefProfile.style_keywords.map(k => k.toLowerCase());
    const scanKws = scanItems.flatMap(it => (it.style_keywords || []).map(k => k.toLowerCase()));
    const matches = scanKws.filter(k => userKws.some(uk => k.includes(uk) || uk.includes(k))).length;
    score += Math.min(matches * 3, 5);
  }

  return Math.max(0, Math.min(80, score));
}

/**
 * Load all personalization data for a user in parallel.
 * Returns a context object for personalizedFeedScore().
 */
async function loadPersonalizationContext(userId) {
  const [
    { data: profile },
    { data: brandRows },
    { data: priceRows },
    { data: attrRows },
  ] = await Promise.all([
    supabase
      .from("profiles")
      .select("hanger_taste_cache, preference_profile, style_interests")
      .eq("id", userId)
      .maybeSingle(),
    supabase
      .from("user_brand_affinities")
      .select("brand, affinity_score, positive_signals, negative_signals")
      .eq("user_id", userId)
      .order("affinity_score", { ascending: false })
      .limit(50),
    supabase
      .from("user_price_profiles")
      .select("category, sweet_spot, std_dev, hard_max")
      .eq("user_id", userId),
    supabase
      .from("user_attribute_affinities")
      .select("attribute_value, affinity_score")
      .eq("user_id", userId)
      .order("interaction_count", { ascending: false })
      .limit(100),
  ]);

  // Build brand affinity map
  const brandAffinities = {};
  (brandRows || []).forEach(r => { brandAffinities[r.brand] = r; });

  // Build price profile map by category
  const priceProfiles = {};
  (priceRows || []).forEach(r => { priceProfiles[r.category] = r; });

  // Build attribute affinity map
  const attrAffinities = {};
  (attrRows || []).forEach(r => { attrAffinities[r.attribute_value] = r.affinity_score; });

  return {
    styleDna: profile?.hanger_taste_cache || null,
    prefProfile: profile?.preference_profile || null,
    styleInterests: profile?.style_interests || [],
    brandAffinities,
    priceProfiles,
    attrAffinities,
  };
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
    // Load user's gender + full personalization context in parallel
    const [{ data: userPref }, personCtx] = await Promise.all([
      supabase.from("profiles").select("gender_pref").eq("id", req.userId).maybeSingle(),
      (tab === "foryou" || tab === "trending") ? loadPersonalizationContext(req.userId) : Promise.resolve(null),
    ]);
    const genderPref = userPref?.gender_pref; // "male", "female", or null

    // ─── Trending tab: fetch a larger pool, score & sort ────
    if (tab === "trending") {
      // Grab up to 200 recent public scans (pool for scoring)
      const poolSize = Math.min(200, offset + limit + 80);
      let trendingQuery = supabase
        .from("scans")
        .select("id, user_id, image_url, summary, items, created_at, visibility")
        .eq("visibility", "public")
        .neq("user_id", req.userId)
        .not("image_url", "is", null);
      if (genderPref) {
        trendingQuery = trendingQuery.or(`detected_gender.eq.${genderPref},detected_gender.is.null`);
      }
      const { data: pool, error: poolErr } = await trendingQuery
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

      // Score: trending weight + light personalization nudge (20% of personal score)
      const scored = pool.map(s => {
        const items = Array.isArray(s.items) ? s.items : [];
        const tScore = trendingScore(saveCountMap[s.id] || 0, s.created_at);
        const pScore = personCtx ? personalizedFeedScore(items, personCtx) * 0.2 : 0;
        return {
          id: s.id,
          image_url: s.image_url,
          summary: s.summary,
          items,
          item_count: items.length,
          created_at: s.created_at,
          save_count: saveCountMap[s.id] || 0,
          trending_score: tScore + pScore,
          user: profileMap[s.user_id] || { display_name: "Anonymous" },
        };
      });
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
      // For You — fetch a larger pool, score with full personalization, add randomness
      // Pull 4x the page size so we have room to score + shuffle
      const poolSize = Math.min(200, (offset + limit) * 4);
      let fyQuery = supabase
        .from("scans")
        .select("id, user_id, image_url, summary, items, created_at, visibility")
        .eq("visibility", "public")
        .neq("user_id", req.userId)
        .not("image_url", "is", null);
      if (genderPref) {
        fyQuery = fyQuery.or(`detected_gender.eq.${genderPref},detected_gender.is.null`);
      }
      query = fyQuery.order("created_at", { ascending: false }).range(0, poolSize - 1);
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

      const isForYou = tab !== "following";

      const enriched = scans.map(s => {
        const items = Array.isArray(s.items) ? s.items : [];
        // Full personalized score (recency + prefs + brands + price + style + attrs)
        // Plus random jitter (±8) so the feed looks different on every load
        const personScore = isForYou && personCtx
          ? personalizedFeedScore(items, personCtx)
          : 0;
        const jitter = isForYou ? (Math.random() * 16 - 8) : 0; // ±8 random
        return {
          id: s.id,
          image_url: s.image_url,
          summary: s.summary,
          items,
          item_count: items.length,
          created_at: s.created_at,
          save_count: saveCountMap[s.id] || 0,
          user: profileMap[s.user_id] || { display_name: "Anonymous" },
          _score: isForYou
            ? recencyScore(s.created_at) + personScore + jitter
            : 0,
        };
      });

      // Sort by personalized score for For You tab
      if (isForYou) {
        enriched.sort((a, b) => b._score - a._score);
      }
      // Remove internal score from response
      enriched.forEach(s => delete s._score);

      // Page into the scored results
      const paged = isForYou ? enriched.slice(offset, offset + limit) : enriched;

      return res.json({ scans: paged, page, has_more: isForYou ? enriched.length > offset + limit : scans.length === limit });
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
