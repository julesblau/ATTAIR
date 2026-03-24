import { Router } from "express";
import { createClient } from "@supabase/supabase-js";
import { randomBytes } from "crypto";
import supabase from "../lib/supabase.js";

const router = Router();

/**
 * GET /api/auth/config
 * Returns the Supabase public config needed for OAuth on the frontend.
 * The anon key is public by design — it's safe to expose.
 */
router.get("/config", (req, res) => {
  res.json({
    supabase_url: process.env.SUPABASE_URL,
    supabase_anon_key: process.env.SUPABASE_ANON_KEY,
  });
});

/**
 * POST /api/auth/signup
 * Body: { email, password, display_name?, phone, gender_pref?, budget_min?, budget_max? }
 */
router.post("/signup", async (req, res) => {
  const { email, password, display_name, phone, gender_pref, budget_min, budget_max } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: "Email and password are required" });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: "Password must be at least 6 characters" });
  }
  if (!phone) {
    return res.status(400).json({ error: "Phone number is required" });
  }

  // SECURITY: Validate budget fields — reject non-numeric values and unsafe ranges to prevent
  // type confusion in downstream DB writes and AI prompt construction.
  if (budget_min != null) {
    const n = Number(budget_min);
    if (!Number.isFinite(n) || n < 0 || n > 1_000_000) {
      return res.status(400).json({ error: "budget_min must be a number between 0 and 1,000,000" });
    }
  }
  if (budget_max != null) {
    const n = Number(budget_max);
    if (!Number.isFinite(n) || n < 0 || n > 1_000_000) {
      return res.status(400).json({ error: "budget_max must be a number between 0 and 1,000,000" });
    }
  }

  try {
    // Create auth user via service role
    const { data, error } = await supabase.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });

    if (error) {
      return res.status(400).json({ error: error.message });
    }

    const userId = data.user.id;

    // Update profile with preferences + name/phone
    const profileUpdates = { phone };
    if (display_name) profileUpdates.display_name = display_name;
    if (gender_pref) profileUpdates.gender_pref = gender_pref;
    if (budget_min != null) profileUpdates.budget_min = budget_min;
    if (budget_max != null) profileUpdates.budget_max = budget_max;
    // Use crypto.randomBytes for referral code generation to ensure cryptographically random output.
    // 5 bytes → 10 hex characters → 40 bits of entropy. Codes are uppercased hex for readability.
    profileUpdates.referral_code = randomBytes(5).toString("hex").toUpperCase();

    await supabase
      .from("profiles")
      .update(profileUpdates)
      .eq("id", userId);

    // Sign in to get tokens
    const anonClient = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_ANON_KEY
    );

    const { data: session, error: signInErr } =
      await anonClient.auth.signInWithPassword({ email, password });

    if (signInErr) {
      return res.status(400).json({ error: signInErr.message });
    }

    return res.json({
      user: { id: userId, email },
      access_token: session.session.access_token,
      refresh_token: session.session.refresh_token,
    });
  } catch (err) {
    console.error("Signup error:", err.message);
    return res.status(500).json({ error: "Signup failed" });
  }
});

/**
 * POST /api/auth/login
 * Body: { email, password }
 */
router.post("/login", async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: "Email and password are required" });
  }

  try {
    const anonClient = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_ANON_KEY
    );

    const { data, error } = await anonClient.auth.signInWithPassword({
      email,
      password,
    });

    if (error) {
      return res.status(401).json({ error: error.message });
    }

    return res.json({
      user: { id: data.user.id, email: data.user.email },
      access_token: data.session.access_token,
      refresh_token: data.session.refresh_token,
    });
  } catch (err) {
    console.error("Login error:", err.message);
    return res.status(500).json({ error: "Login failed" });
  }
});

/**
 * POST /api/auth/refresh
 * Body: { refresh_token }
 */
router.post("/refresh", async (req, res) => {
  const { refresh_token } = req.body;

  if (!refresh_token) {
    return res.status(400).json({ error: "Missing refresh_token" });
  }

  try {
    const anonClient = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_ANON_KEY
    );

    const { data, error } = await anonClient.auth.refreshSession({
      refresh_token,
    });

    if (error) {
      return res.status(401).json({ error: error.message });
    }

    return res.json({
      access_token: data.session.access_token,
      refresh_token: data.session.refresh_token,
    });
  } catch (err) {
    return res.status(500).json({ error: "Token refresh failed" });
  }
});

export default router;
