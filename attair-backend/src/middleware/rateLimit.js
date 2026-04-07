import supabase from "../lib/supabase.js";
import { FREE_SCAN_LIMIT, GUEST_SCAN_LIMIT } from "../config/limits.js";

/**
 * Checks and enforces the monthly scan limit using an atomic DB operation.
 *
 * For free/expired users, calls try_increment_scan — a single Postgres function
 * that resets the monthly counter when needed and increments it atomically in
 * one UPDATE ... WHERE count < limit.  If the UPDATE matches no row (limit
 * already reached) the function returns 0 and we return 429.
 *
 * This eliminates the TOCTOU race that existed when the check (SELECT) and
 * the increment (UPDATE) were separate async operations: concurrent requests
 * can no longer both pass the check before either increments.
 *
 * The new scan count is attached to req.profile.scans_today so that
 * identify.js can report the correct scans_remaining to the client without
 * calling incrementScanCount() again.
 *
 * Pro/trial users bypass the limit entirely — no DB write is performed.
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

    // Atomic check-and-increment: returns the new count, or 0 if limit reached.
    // The RPC resets the monthly counter when scans_today_reset differs from
    // the current month, so no separate reset step is needed here.
    const thisMonthUTC = new Date().toISOString().slice(0, 7); // YYYY-MM

    let newCount;
    try {
      const { data, error: rpcError } = await supabase.rpc("try_increment_scan", {
        p_user_id: userId,
        p_today: thisMonthUTC,
        p_limit: FREE_SCAN_LIMIT,
      });
      if (!rpcError && data != null) {
        newCount = data;
      }
    } catch {
      // RPC not yet deployed — fall through to non-atomic path below
    }

    if (newCount == null) {
      // Fallback (pre-migration): non-atomic read then check, no increment yet
      const thisMonthUTC2 = thisMonthUTC;
      let scansToday = profile.scans_today || 0;
      if (profile.scans_today_reset !== thisMonthUTC2) {
        scansToday = 0;
        await supabase
          .from("profiles")
          .update({ scans_today: 0, scans_today_reset: thisMonthUTC2 })
          .eq("id", userId);
      }
      if (scansToday >= FREE_SCAN_LIMIT) {
        return res.status(429).json({
          error: "Monthly scan limit reached",
          message: "You've used all 12 free scans this month. Go Pro for unlimited.",
          scans_remaining: 0,
          scans_limit: FREE_SCAN_LIMIT,
          upgrade_url: "/subscribe",
        });
      }
      req.profile = { ...profile, tier, scans_today: scansToday };
      req.scanAlreadyIncremented = false;
      return next();
    }

    // RPC returned 0 → limit was already reached (no increment occurred)
    if (newCount === 0) {
      return res.status(429).json({
        error: "Monthly scan limit reached",
        message: "You've used all 12 free scans this month. Go Pro for unlimited.",
        scans_remaining: 0,
        scans_limit: FREE_SCAN_LIMIT,
        upgrade_url: "/subscribe",
      });
    }

    // Increment succeeded atomically — pass the new count downstream
    req.profile = { ...profile, tier, scans_today: newCount };
    req.scanAlreadyIncremented = true;
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
  const thisMonthUTC = new Date().toISOString().slice(0, 7); // YYYY-MM

  try {
    // Atomic: reset date + increment in one transaction
    const { data, error } = await supabase.rpc("try_increment_scan", {
      p_user_id: userId,
      p_today: thisMonthUTC,
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
    profile?.scans_today_reset === thisMonthUTC ? (profile.scans_today || 0) : 0;

  await supabase
    .from("profiles")
    .update({
      scans_today: currentCount + 1,
      scans_today_reset: thisMonthUTC,
    })
    .eq("id", userId);

  return currentCount + 1;
}

// ═══════════════════════════════════════════════════════════════
// GUEST RATE LIMIT — IP-based, 3 scans per day, in-memory
// ═══════════════════════════════════════════════════════════════
const guestScans = new Map(); // ip → { count, date }

export function guestRateLimit(req, res, next) {
  const ip = req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.ip || "unknown";
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

  const entry = guestScans.get(ip);
  if (!entry || entry.date !== today) {
    guestScans.set(ip, { count: 1, date: today });
    req.guestScansRemaining = GUEST_SCAN_LIMIT - 1;
    return next();
  }

  if (entry.count >= GUEST_SCAN_LIMIT) {
    return res.status(429).json({
      error: "Guest scan limit reached",
      message: "Sign up for free to keep scanning — you get 12 scans per month!",
      scans_remaining: 0,
    });
  }

  entry.count += 1;
  req.guestScansRemaining = GUEST_SCAN_LIMIT - entry.count;
  next();
}
