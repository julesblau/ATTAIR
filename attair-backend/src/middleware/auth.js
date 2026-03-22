import { createClient } from "@supabase/supabase-js";

/**
 * Verifies the Supabase access token from the Authorization header.
 * Attaches req.user (auth user) and req.userId.
 * Returns 401 if invalid/missing.
 */
export async function requireAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Missing authorization header" });
  }

  const token = header.slice(7);

  try {
    // Create a one-off client with the user's token to verify it
    const supabaseAuth = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_ANON_KEY,
      { global: { headers: { Authorization: `Bearer ${token}` } } }
    );

    const { data: { user }, error } = await supabaseAuth.auth.getUser(token);
    if (error || !user) {
      return res.status(401).json({ error: "Invalid or expired token" });
    }

    req.user = user;
    req.userId = user.id;
    next();
  } catch (err) {
    console.error("Auth error:", err.message);
    return res.status(401).json({ error: "Authentication failed" });
  }
}

/**
 * Optional auth — if a token is present, tries to verify it.
 * On success: attaches req.user and req.userId.
 * On failure (expired, invalid, missing): continues as anonymous with req.userId = null.
 * NEVER returns 401 — that's the difference from requireAuth.
 */
export async function optionalAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    req.user = null;
    req.userId = null;
    return next();
  }

  const token = header.slice(7);

  try {
    const supabaseAuth = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_ANON_KEY,
      { global: { headers: { Authorization: `Bearer ${token}` } } }
    );

    const { data: { user }, error } = await supabaseAuth.auth.getUser(token);
    if (error || !user) {
      // Token is invalid/expired — continue as anonymous
      req.user = null;
      req.userId = null;
      return next();
    }

    req.user = user;
    req.userId = user.id;
    next();
  } catch (err) {
    // Any error — continue as anonymous, don't block the request
    req.user = null;
    req.userId = null;
    next();
  }
}
