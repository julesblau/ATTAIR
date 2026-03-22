import supabase from "../lib/supabase.js";

const FREE_SCAN_LIMIT = 3;

/**
 * Checks and enforces the daily scan limit.
 * - Resets scans_today if the stored reset date is before today (UTC).
 * - Free/expired users: 3 scans/day.
 * - Trial/pro users: unlimited.
 * Attaches req.profile with the user's profile row.
 */
export async function scanRateLimit(req, res, next) {
  const userId = req.userId;
  if (!userId) {
    return res.status(401).json({ error: "Authentication required" });
  }

  try {
    // Fetch profile
    const { data: profile, error } = await supabase
      .from("profiles")
      .select("*")
      .eq("id", userId)
      .single();

    if (error || !profile) {
      return res.status(404).json({ error: "Profile not found" });
    }

    // Check if trial has expired
    let tier = profile.tier;
    if (tier === "trial" && profile.trial_ends_at) {
      if (new Date(profile.trial_ends_at) < new Date()) {
        tier = "expired";
        await supabase
          .from("profiles")
          .update({ tier: "expired" })
          .eq("id", userId);
      }
    }

    // Pro/trial users bypass the limit
    if (tier === "pro" || tier === "trial") {
      req.profile = { ...profile, tier };
      return next();
    }

    // Reset counter if the stored reset date is before today
    const todayUTC = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    let scansToday = profile.scans_today || 0;

    if (profile.scans_today_reset !== todayUTC) {
      scansToday = 0;
      await supabase
        .from("profiles")
        .update({ scans_today: 0, scans_today_reset: todayUTC })
        .eq("id", userId);
    }

    // Enforce limit
    if (scansToday >= FREE_SCAN_LIMIT) {
      return res.status(429).json({
        error: "Daily scan limit reached",
        message: "You've used 3/3 free scans today. Go Pro for unlimited.",
        scans_remaining: 0,
        scans_limit: FREE_SCAN_LIMIT,
        upgrade_url: "/subscribe",
      });
    }

    req.profile = { ...profile, tier, scans_today: scansToday };
    next();
  } catch (err) {
    console.error("Rate limit error:", err.message);
    return res.status(500).json({ error: "Rate limit check failed" });
  }
}

/**
 * After a successful scan, increment the counter atomically.
 * Uses the try_increment_scan Postgres function to prevent race conditions.
 * Falls back to non-atomic increment if the function doesn't exist yet.
 */
export async function incrementScanCount(userId) {
  const todayUTC = new Date().toISOString().slice(0, 10);

  try {
    // Atomic: reset date + increment in one transaction
    const { data, error } = await supabase.rpc("try_increment_scan", {
      p_user_id: userId,
      p_today: todayUTC,
      p_limit: FREE_SCAN_LIMIT,
    });

    if (!error && data != null) return data;
  } catch {
    // RPC not available — fall through to manual increment
  }

  // Fallback: non-atomic (works before migration 002 is run)
  const { data: profile } = await supabase
    .from("profiles")
    .select("scans_today, scans_today_reset")
    .eq("id", userId)
    .single();

  const currentCount =
    profile?.scans_today_reset === todayUTC ? (profile.scans_today || 0) : 0;

  await supabase
    .from("profiles")
    .update({
      scans_today: currentCount + 1,
      scans_today_reset: todayUTC,
    })
    .eq("id", userId);

  return currentCount + 1;
}
