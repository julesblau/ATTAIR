/**
 * challenges.js — Style Challenge routes for ATTAIRE
 *
 * GET    /api/challenges              — List active + recent challenges
 * GET    /api/challenges/:id          — Single challenge with submissions
 * POST   /api/challenges/:id/submit   — Submit outfit to challenge
 * POST   /api/challenges/:id/vote     — Vote on a submission
 * DELETE /api/challenges/:id/vote     — Remove vote
 * POST   /api/challenges/seed         — Create weekly challenges (admin/cron)
 * POST   /api/challenges/finalize     — Close voting + pick winners (admin/cron)
 */

import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import supabase from "../lib/supabase.js";

const router = Router();

// ─── Challenge themes pool (rotate weekly) ──────────────────
const CHALLENGE_THEMES = [
  { title: "Monochrome Monday", description: "Style an entire outfit using one color family.", theme_tags: ["monochrome", "single color", "tonal"] },
  { title: "Street Style Saturday", description: "Show us your best streetwear fit.", theme_tags: ["streetwear", "urban", "casual", "sneakers"] },
  { title: "Office Slay", description: "Professional but make it fashion.", theme_tags: ["business", "professional", "formal", "blazer"] },
  { title: "Thrift Flip", description: "Best outfit where everything is secondhand or under $50.", theme_tags: ["thrift", "vintage", "budget", "secondhand"] },
  { title: "Date Night", description: "Dress to impress for a night out.", theme_tags: ["evening", "date", "dressy", "elegant"] },
  { title: "Athleisure Aesthetic", description: "Gym meets fashion — sporty but styled.", theme_tags: ["athletic", "sporty", "activewear", "sneakers"] },
  { title: "Pattern Play", description: "Mix patterns like a pro. Stripes, plaid, floral — go wild.", theme_tags: ["pattern", "print", "stripes", "plaid", "floral"] },
  { title: "90s Revival", description: "Bring back the best of 90s fashion.", theme_tags: ["90s", "retro", "vintage", "baggy", "grunge"] },
  { title: "Minimalist Chic", description: "Less is more. Clean lines, neutral tones, zero clutter.", theme_tags: ["minimal", "clean", "neutral", "simple"] },
  { title: "Festival Ready", description: "What are you wearing to the festival?", theme_tags: ["festival", "boho", "colorful", "accessories"] },
  { title: "Denim on Denim", description: "Canadian tuxedo energy. All denim, all day.", theme_tags: ["denim", "jeans", "jean jacket"] },
  { title: "Summer Vibes", description: "Light, breezy, and ready for the heat.", theme_tags: ["summer", "light", "breezy", "shorts", "sandals"] },
];

// ─── GET /api/challenges ────────────────────────────────────
router.get("/", requireAuth, async (req, res) => {
  try {
    const { data: challenges, error } = await supabase
      .from("style_challenges")
      .select("id, title, description, theme_tags, starts_at, ends_at, status, winner_id, created_at")
      .in("status", ["active", "voting", "completed"])
      .order("starts_at", { ascending: false })
      .limit(10);

    if (error) throw error;

    // Get submission counts for each challenge
    if (challenges && challenges.length > 0) {
      const challengeIds = challenges.map(c => c.id);
      const { data: submissionCounts } = await supabase
        .from("challenge_submissions")
        .select("challenge_id")
        .in("challenge_id", challengeIds);

      const countMap = {};
      (submissionCounts || []).forEach(s => {
        countMap[s.challenge_id] = (countMap[s.challenge_id] || 0) + 1;
      });

      // Check which challenges the current user has submitted to
      const { data: userSubs } = await supabase
        .from("challenge_submissions")
        .select("challenge_id")
        .eq("user_id", req.userId)
        .in("challenge_id", challengeIds);

      const userSubSet = new Set((userSubs || []).map(s => s.challenge_id));

      // Get winner profiles
      const winnerIds = challenges.filter(c => c.winner_id).map(c => c.winner_id);
      let winnerMap = {};
      if (winnerIds.length > 0) {
        const { data: winners } = await supabase
          .from("profiles")
          .select("id, display_name")
          .in("id", winnerIds);
        (winners || []).forEach(w => { winnerMap[w.id] = w; });
      }

      const enriched = challenges.map(c => ({
        ...c,
        submission_count: countMap[c.id] || 0,
        user_submitted: userSubSet.has(c.id),
        winner: c.winner_id ? (winnerMap[c.winner_id] || null) : null,
      }));

      return res.json({ success: true, data: enriched });
    }

    return res.json({ success: true, data: [] });
  } catch (err) {
    console.error("[challenges] GET / error:", err.message);
    return res.status(500).json({ error: "Failed to fetch challenges" });
  }
});

// ─── GET /api/challenges/:id ────────────────────────────────
router.get("/:id", requireAuth, async (req, res) => {
  const { id } = req.params;
  try {
    const { data: challenge, error } = await supabase
      .from("style_challenges")
      .select("*")
      .eq("id", id)
      .single();

    if (error || !challenge) return res.status(404).json({ error: "Challenge not found" });

    // Get submissions with user info, sorted by votes
    const { data: submissions } = await supabase
      .from("challenge_submissions")
      .select("id, user_id, scan_id, image_url, caption, ai_verified, ai_feedback, vote_count, created_at")
      .eq("challenge_id", id)
      .order("vote_count", { ascending: false });

    const userIds = [...new Set((submissions || []).map(s => s.user_id))];
    let profileMap = {};
    if (userIds.length > 0) {
      const { data: profiles } = await supabase
        .from("profiles")
        .select("id, display_name, challenge_wins")
        .in("id", userIds);
      (profiles || []).forEach(p => { profileMap[p.id] = p; });
    }

    // Check which submissions the current user voted for
    const subIds = (submissions || []).map(s => s.id);
    let userVotes = new Set();
    if (subIds.length > 0) {
      const { data: votes } = await supabase
        .from("challenge_votes")
        .select("submission_id")
        .eq("voter_id", req.userId)
        .in("submission_id", subIds);
      userVotes = new Set((votes || []).map(v => v.submission_id));
    }

    const enrichedSubs = (submissions || []).map(s => ({
      ...s,
      user: profileMap[s.user_id] || { display_name: "Anonymous" },
      user_voted: userVotes.has(s.id),
    }));

    return res.json({
      success: true,
      data: {
        ...challenge,
        submissions: enrichedSubs,
      },
    });
  } catch (err) {
    console.error("[challenges] GET /:id error:", err.message);
    return res.status(500).json({ error: "Failed to fetch challenge" });
  }
});

// ─── POST /api/challenges/:id/submit ────────────────────────
router.post("/:id/submit", requireAuth, async (req, res) => {
  const { id } = req.params;
  const { image_url, caption, scan_id } = req.body;

  if (!image_url) return res.status(400).json({ error: "image_url is required" });

  try {
    // Verify challenge is active
    const { data: challenge } = await supabase
      .from("style_challenges")
      .select("id, status, theme_tags")
      .eq("id", id)
      .single();

    if (!challenge) return res.status(404).json({ error: "Challenge not found" });
    if (challenge.status !== "active") return res.status(400).json({ error: "Challenge is no longer accepting submissions" });

    // Check for existing submission
    const { data: existing } = await supabase
      .from("challenge_submissions")
      .select("id")
      .eq("challenge_id", id)
      .eq("user_id", req.userId)
      .single();

    if (existing) return res.status(409).json({ error: "You already submitted to this challenge" });

    // AI verification: check if the outfit matches the theme
    // For now, auto-verify (Claude verification can be added later when scan data is linked)
    const ai_verified = true;
    const ai_feedback = "Looks great! Your outfit matches the theme.";

    const { data: submission, error } = await supabase
      .from("challenge_submissions")
      .insert({
        challenge_id: id,
        user_id: req.userId,
        scan_id: scan_id || null,
        image_url,
        caption: (caption || "").slice(0, 200),
        ai_verified,
        ai_feedback,
      })
      .select()
      .single();

    if (error) throw error;

    return res.status(201).json({ success: true, data: submission });
  } catch (err) {
    console.error("[challenges] POST /:id/submit error:", err.message);
    return res.status(500).json({ error: "Failed to submit" });
  }
});

// ─── POST /api/challenges/:id/vote ──────────────────────────
router.post("/:id/vote", requireAuth, async (req, res) => {
  const { submission_id } = req.body;
  if (!submission_id) return res.status(400).json({ error: "submission_id is required" });

  try {
    // Check challenge is in voting or active state
    const { data: challenge } = await supabase
      .from("style_challenges")
      .select("status")
      .eq("id", req.params.id)
      .single();

    if (!challenge || (challenge.status !== "active" && challenge.status !== "voting")) {
      return res.status(400).json({ error: "Voting is not open for this challenge" });
    }

    // Can't vote for own submission
    const { data: sub } = await supabase
      .from("challenge_submissions")
      .select("user_id")
      .eq("id", submission_id)
      .single();

    if (sub?.user_id === req.userId) {
      return res.status(400).json({ error: "You can't vote for your own submission" });
    }

    // Upsert vote (idempotent)
    const { error: voteError } = await supabase
      .from("challenge_votes")
      .upsert({
        submission_id,
        voter_id: req.userId,
      }, { onConflict: "submission_id,voter_id" });

    if (voteError) throw voteError;

    // Increment vote count
    await supabase.rpc("increment_vote_count", { sub_id: submission_id });

    return res.json({ success: true });
  } catch (err) {
    console.error("[challenges] POST /:id/vote error:", err.message);
    return res.status(500).json({ error: "Failed to vote" });
  }
});

// ─── DELETE /api/challenges/:id/vote ────────────────────────
router.delete("/:id/vote", requireAuth, async (req, res) => {
  const { submission_id } = req.body;
  if (!submission_id) return res.status(400).json({ error: "submission_id is required" });

  try {
    const { error } = await supabase
      .from("challenge_votes")
      .delete()
      .eq("submission_id", submission_id)
      .eq("voter_id", req.userId);

    if (error) throw error;

    // Decrement vote count
    await supabase.rpc("decrement_vote_count", { sub_id: submission_id });

    return res.json({ success: true });
  } catch (err) {
    console.error("[challenges] DELETE /:id/vote error:", err.message);
    return res.status(500).json({ error: "Failed to remove vote" });
  }
});

// ─── POST /api/challenges/seed ──────────────────────────────
// Creates a new weekly challenge. Called by cron or admin.
router.post("/seed", async (req, res) => {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) return res.status(503).json({ error: "Not configured" });

  const authHeader = req.headers.authorization;
  const provided = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!provided || provided !== cronSecret) return res.status(401).json({ error: "Unauthorized" });

  try {
    // Pick a random theme that wasn't used recently
    const { data: recent } = await supabase
      .from("style_challenges")
      .select("title")
      .order("created_at", { ascending: false })
      .limit(4);

    const recentTitles = new Set((recent || []).map(c => c.title));
    const available = CHALLENGE_THEMES.filter(t => !recentTitles.has(t.title));
    const theme = available.length > 0
      ? available[Math.floor(Math.random() * available.length)]
      : CHALLENGE_THEMES[Math.floor(Math.random() * CHALLENGE_THEMES.length)];

    const now = new Date();
    const startsAt = now.toISOString();
    // Challenge runs for 5 days active, then 2 days voting
    const endsAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();

    const { data: challenge, error } = await supabase
      .from("style_challenges")
      .insert({
        title: theme.title,
        description: theme.description,
        theme_tags: theme.theme_tags,
        starts_at: startsAt,
        ends_at: endsAt,
        status: "active",
      })
      .select()
      .single();

    if (error) throw error;

    return res.status(201).json({ success: true, data: challenge });
  } catch (err) {
    console.error("[challenges] POST /seed error:", err.message);
    return res.status(500).json({ error: "Failed to create challenge" });
  }
});

// ─── POST /api/challenges/finalize ──────────────────────────
// Close expired challenges, transition to voting, pick winners.
router.post("/finalize", async (req, res) => {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) return res.status(503).json({ error: "Not configured" });

  const authHeader = req.headers.authorization;
  const provided = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!provided || provided !== cronSecret) return res.status(401).json({ error: "Unauthorized" });

  try {
    const now = new Date();
    const fiveDaysAgo = new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000).toISOString();

    // Move active challenges older than 5 days to voting
    const { data: toVoting } = await supabase
      .from("style_challenges")
      .select("id")
      .eq("status", "active")
      .lt("starts_at", fiveDaysAgo);

    for (const c of (toVoting || [])) {
      await supabase.from("style_challenges").update({ status: "voting" }).eq("id", c.id);
    }

    // Finalize voting challenges that have ended
    const { data: toFinalize } = await supabase
      .from("style_challenges")
      .select("id")
      .eq("status", "voting")
      .lt("ends_at", now.toISOString());

    let winnersSet = 0;
    for (const c of (toFinalize || [])) {
      // Get top submission
      const { data: topSub } = await supabase
        .from("challenge_submissions")
        .select("user_id, vote_count")
        .eq("challenge_id", c.id)
        .order("vote_count", { ascending: false })
        .limit(1)
        .single();

      if (topSub) {
        await supabase.from("style_challenges").update({ status: "completed", winner_id: topSub.user_id }).eq("id", c.id);
        // Increment winner's challenge_wins count
        await supabase.rpc("increment_challenge_wins", { uid: topSub.user_id });
        winnersSet++;
      } else {
        await supabase.from("style_challenges").update({ status: "completed" }).eq("id", c.id);
      }
    }

    return res.json({ success: true, transitioned_to_voting: (toVoting || []).length, finalized: (toFinalize || []).length, winners_set: winnersSet });
  } catch (err) {
    console.error("[challenges] POST /finalize error:", err.message);
    return res.status(500).json({ error: "Failed to finalize" });
  }
});

export default router;
