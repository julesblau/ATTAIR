import "dotenv/config";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import rateLimit from "express-rate-limit";

import identifyRouter from "./routes/identify.js";
import findProductsRouter from "./routes/findProducts.js";
import userRouter from "./routes/user.js";
import affiliateRouter from "./routes/affiliate.js";
import authRouter from "./routes/auth.js";
import adEventsRouter from "./routes/adEvents.js";
import eventsRouter from "./routes/events.js";
import refineItemRouter from "./routes/refineItem.js";
import suggestPairingsRouter from "./routes/suggestPairings.js";
import seenOnRouter from "./routes/seenOn.js";
import nearbyStoresRouter from "./routes/nearbyStores.js";
import wishlistsRouter from "./routes/wishlists.js";
import paymentsRouter from "./routes/payments.js";
import socialRouter from "./routes/social.js";
import styleDnaRouter from "./routes/styleDna.js";
import priceAlertsRouter from "./routes/priceAlerts.js";
import guestRouter from "./routes/guest.js";
import notificationsRouter from "./routes/notifications.js";
import aiContentRouter from "./routes/aiContent.js";
import challengesRouter from "./routes/challenges.js";
import dupesRouter from "./routes/dupes.js";
import hangerTestRouter from "./routes/hangerTest.js";
import looksRouter from "./routes/looks.js";
import { startContentModeration } from "./jobs/contentModeration.js";
import styleTwinsRouter from "./routes/styleTwins.js";
import ootwRouter from "./routes/ootw.js";
import { startNudgeProcessor } from "./services/notifications.js";

// ─── Validate required env vars ─────────────────────────────
const REQUIRED_ENV = [
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "SUPABASE_ANON_KEY",
  "ANTHROPIC_API_KEY",
  "SERPAPI_KEY",
  "CRON_SECRET",
];

// Stripe keys are optional — payments routes will fail gracefully without them
if (!process.env.STRIPE_SECRET_KEY) console.warn("⚠️  STRIPE_SECRET_KEY not set — payment routes will be unavailable");
if (!process.env.STRIPE_WEBHOOK_SECRET) console.warn("⚠️  STRIPE_WEBHOOK_SECRET not set — webhook verification disabled");

for (const key of REQUIRED_ENV) {
  if (!process.env[key]) {
    console.error(`❌ Missing required env var: ${key}`);
    console.error("   Copy .env.example to .env and fill in your values.");
    process.exit(1);
  }
}

// ─── Express app ────────────────────────────────────────────
const app = express();
const PORT = process.env.PORT || 3000;

// Trust Railway's load balancer (fixes express-rate-limit X-Forwarded-For error)
app.set("trust proxy", 1);

// ─── Middleware ──────────────────────────────────────────────

// Manual CORS — runs before everything, including helmet.
// If CORS_ORIGINS is set, only allow listed origins (plus localhost for dev).
// If unset, reflect any origin (permissive local-dev mode).
const allowedOrigins = process.env.CORS_ORIGINS
  ? process.env.CORS_ORIGINS.split(",").map(o => o.trim())
  : null; // null = permissive mode

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin) {
    if (!allowedOrigins || allowedOrigins.includes(origin) || origin.startsWith("http://localhost")) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Access-Control-Allow-Credentials", "true");
    }
  }
  res.setHeader("Access-Control-Allow-Methods", "GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization,X-Requested-With");
  if (req.method === "OPTIONS") return res.status(204).end();
  next();
});

// helmet — allow cross-origin fetches (CORP must not block our API responses)
app.use(helmet({ crossOriginResourcePolicy: { policy: "cross-origin" } }));

// Stripe webhook requires raw body — MUST be before express.json()
app.use("/api/payments/webhook", express.raw({ type: "application/json" }));

// Body parsing — 10MB limit for base64 images
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

// Logging
app.use(morgan(process.env.NODE_ENV === "production" ? "combined" : "dev"));

// Global IP rate limit — prevent abuse (300 req/min per IP)
const globalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests, please try again later" },
});
app.use("/api/", globalLimiter);

// Stricter limit on auth endpoints (20 req/min per IP)
const authLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  message: { error: "Too many auth attempts, please wait" },
});
app.use("/api/auth/", authLimiter);

// ─── Browser cache headers for read-only endpoints ─────────
const cacheHeaders = (maxAge, scope = 'private') => (req, res, next) => {
  if (req.method === 'GET') {
    res.set('Cache-Control', `${scope}, max-age=${maxAge}`);
  }
  next();
};

app.use('/api/stats', cacheHeaders(300, 'public'));           // 5 min, public (no auth)
app.use('/api/feed', cacheHeaders(60, 'private'));            // 1 min, private
app.use('/api/user/history', cacheHeaders(300, 'private'));   // 5 min
app.use('/api/user/saved', cacheHeaders(120, 'private'));     // 2 min
app.use('/api/wishlists', cacheHeaders(300, 'private'));      // 5 min
app.use('/api/user/style-dna', cacheHeaders(3600, 'private')); // 1 hr
app.use('/api/hanger-test/today', cacheHeaders(60, 'private')); // 1 min

// ─── Routes ─────────────────────────────────────────────────
app.use("/api/auth", authRouter);
app.use("/api/guest", guestRouter);
app.use("/api/identify", identifyRouter);
app.use("/api/find-products", findProductsRouter);
app.use("/api/user/style-dna", styleDnaRouter);
app.use("/api/user", userRouter);
app.use("/api/go", affiliateRouter);
app.use("/api/ad-events", adEventsRouter);
app.use("/api/events", eventsRouter);
app.use("/api/refine-item", refineItemRouter);
app.use("/api/suggest-pairings", suggestPairingsRouter);
app.use("/api/seen-on", seenOnRouter);
app.use("/api/nearby-stores", nearbyStoresRouter);
app.use("/api/wishlists", wishlistsRouter);
app.use("/api/payments", paymentsRouter);
app.use("/api/price-alerts", priceAlertsRouter);
app.use("/api/notifications", notificationsRouter);
app.use("/api/ai-content", aiContentRouter);
app.use("/api/challenges", challengesRouter);
app.use("/api/dupes", dupesRouter);
app.use("/api/looks", looksRouter);
app.use("/api/style-twins", styleTwinsRouter);
app.use("/api/ootw", ootwRouter);
app.use("/api", hangerTestRouter);
app.use("/api", socialRouter);

// ─── Public stats (no auth — used by onboarding) ──────────
import supabase from "./lib/supabase.js";

// Cache scan count for 5 min, but shuffle recent scans fresh each time
let statsScanCount = { count: 0, ts: 0 };
app.get("/api/stats", async (req, res) => {
  try {
    // Cache just the scan count (expensive query)
    if (!statsScanCount.count || Date.now() - statsScanCount.ts > 5 * 60 * 1000) {
      const { count } = await supabase.from("scans").select("*", { count: "exact", head: true });
      statsScanCount = { count: count || 0, ts: Date.now() };
    }

    // Grab male + female scans separately so guest feed is balanced
    const [{ data: maleScans }, { data: femaleScans }] = await Promise.all([
      supabase.from("scans").select("id, user_id, image_url, summary, items, created_at")
        .eq("visibility", "public").eq("detected_gender", "male")
        .not("image_url", "is", null).order("created_at", { ascending: false }).limit(20),
      supabase.from("scans").select("id, user_id, image_url, summary, items, created_at")
        .eq("visibility", "public").eq("detected_gender", "female")
        .not("image_url", "is", null).order("created_at", { ascending: false }).limit(20),
    ]);

    // 10 male + 10 female, shuffled together
    const mPool = (maleScans || []).sort(() => Math.random() - 0.5).slice(0, 10);
    const fPool = (femaleScans || []).sort(() => Math.random() - 0.5).slice(0, 10);
    const pool = [...mPool, ...fPool].sort(() => Math.random() - 0.5);

    // Fetch display names for the scans
    const userIds = [...new Set(pool.map(s => s.user_id).filter(Boolean))];
    const profileMap = {};
    if (userIds.length > 0) {
      const { data: profiles } = await supabase
        .from("profiles")
        .select("id, display_name")
        .in("id", userIds);
      (profiles || []).forEach(p => { profileMap[p.id] = p.display_name; });
    }

    const result = {
      total_scans: statsScanCount.count + 500,
      recent_scans: pool.map(s => ({
        id: s.id,
        image_url: s.image_url,
        summary: s.summary,
        item_count: Array.isArray(s.items) ? s.items.length : 0,
        user_name: profileMap[s.user_id] || null,
      })),
    };
    res.json(result);
  } catch (err) {
    console.error("[STATS]", err.message);
    res.json({ total_scans: 500, recent_scans: [] }); // graceful fallback
  }
});

// ─── Share link with OG meta (crawlers + redirect) ─────────
const FRONTEND_URL = process.env.FRONTEND_URL || "https://attaire.app";

app.get("/share/:scanId", async (req, res) => {
  const { scanId } = req.params;

  // Validate UUID
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(scanId)) {
    return res.redirect(FRONTEND_URL);
  }

  try {
    const { data: scan } = await supabase
      .from("scans")
      .select("id, image_url, summary, items, user_id, visibility")
      .eq("id", scanId)
      .eq("visibility", "public")
      .single();

    if (!scan) return res.redirect(`${FRONTEND_URL}/scan/${scanId}`);

    const { data: profile } = await supabase
      .from("profiles")
      .select("display_name")
      .eq("id", scan.user_id)
      .single();

    const userName = profile?.display_name || "Someone";
    const itemCount = Array.isArray(scan.items) ? scan.items.length : 0;
    const title = `${userName}'s outfit on ATTAIRE`;
    const description = scan.summary || `${itemCount} items identified — find where to buy them`;
    const imageUrl = scan.image_url || "";
    const canonicalUrl = `${FRONTEND_URL}/scan/${scanId}`;

    // Escape HTML in dynamic values
    const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${esc(title)}</title>
  <meta name="description" content="${esc(description)}">
  <meta property="og:type" content="website">
  <meta property="og:title" content="${esc(title)}">
  <meta property="og:description" content="${esc(description)}">
  <meta property="og:image" content="${esc(imageUrl)}">
  <meta property="og:url" content="${esc(canonicalUrl)}">
  <meta property="og:site_name" content="ATTAIRE">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${esc(title)}">
  <meta name="twitter:description" content="${esc(description)}">
  <meta name="twitter:image" content="${esc(imageUrl)}">
  <meta http-equiv="refresh" content="0;url=${esc(canonicalUrl)}">
  <style>body{font-family:system-ui;background:#000;color:#fff;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}a{color:#C9A96E}</style>
</head>
<body>
  <div style="text-align:center;padding:20px">
    <p>Redirecting to ATTAIRE...</p>
    <a href="${esc(canonicalUrl)}">Open outfit</a>
  </div>
  <script>window.location.replace(${JSON.stringify(canonicalUrl)});</script>
</body>
</html>`);
  } catch (err) {
    console.error("[SHARE]", err.message);
    res.redirect(`${FRONTEND_URL}/scan/${scanId}`);
  }
});

// Health check
app.get("/", (req, res) => {
  res.json({
    service: "ATTAIR API",
    version: "1.0.0",
    status: "ok",
    timestamp: new Date().toISOString(),
  });
});

app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

// 404
app.use((req, res) => {
  res.status(404).json({ error: "Not found" });
});

// Global error handler
app.use((err, req, res, next) => {
  console.error("Unhandled error:", err);
  res.status(500).json({
    error: "Internal server error",
    ...(process.env.NODE_ENV !== "production" && { message: err.message }),
  });
});

// ─── Start ──────────────────────────────────────────────────
const server = app.listen(PORT, "0.0.0.0", () => {
  console.log(`
  ╔═════════════════════════════════════════╗
  ║   ATTAIR API Server                     ║
  ║   Port: ${String(PORT).padEnd(31)}║
  ║   Env:  ${String(process.env.NODE_ENV || "development").padEnd(31)}║
  ╚═════════════════════════════════════════╝
  `);

  // Start the follow-up nudge processor (checks every 60s)
  startNudgeProcessor();

  // ─── Weekly Style Twins cron ──────────────────────────────
  // Runs every 7 days (604800000 ms). On startup, schedule first
  // check after 60s, then repeat weekly. In production this could
  // also be triggered by an external cron service via POST /api/style-twins/weekly-notify.
  //
  // NOTE: These cron jobs use localhost self-calls rather than direct function
  // invocation. This keeps route auth (x-cron-key) exercised and avoids
  // importing route handler internals. The trade-off is fragility in
  // containerized environments where 127.0.0.1 may not resolve as expected.
  const WEEKLY_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
  const runWeeklyTwinsNotify = async () => {
    try {
      const url = `http://127.0.0.1:${PORT}/api/style-twins/weekly-notify`;
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-cron-key": process.env.CRON_SECRET,
        },
      });
      if (!res.ok) {
        console.error(`[Cron] Style Twins weekly notify HTTP ${res.status}`);
        return;
      }
      const data = await res.json();
      console.log(`[Cron] Style Twins weekly notify: notified=${data.notified || 0}`);
    } catch (err) {
      console.error("[Cron] Style Twins weekly notify failed:", err.message);
    }
  };
  // First run after 60s (let server fully warm up), then every 7 days
  setTimeout(() => {
    runWeeklyTwinsNotify();
    setInterval(runWeeklyTwinsNotify, WEEKLY_MS);
  }, 60_000);
  console.log("  📅 Style Twins weekly cron scheduled (every 7 days)");

  // ─── Outfit of the Week cron (Monday) ────────────────────
  // Generates editorial every Monday. Also runs on startup after 90s.
  const runOOTWGenerate = async () => {
    // Only fire on Mondays (day 1)
    if (new Date().getUTCDay() !== 1) return;
    try {
      const url = `http://127.0.0.1:${PORT}/api/ootw/generate`;
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-cron-key": process.env.CRON_SECRET,
        },
      });
      if (!res.ok) {
        console.error(`[Cron] OOTW generate HTTP ${res.status}`);
        return;
      }
      const data = await res.json();
      console.log(`[Cron] OOTW generate: created=${data.created || false}`);
    } catch (err) {
      console.error("[Cron] OOTW generate failed:", err.message);
    }
  };
  // First run after 90s, then every 24h (idempotent — only creates once per week)
  setTimeout(() => {
    runOOTWGenerate();
    setInterval(runOOTWGenerate, 24 * 60 * 60 * 1000);
  }, 90_000);
  console.log("  📅 Outfit of the Week cron scheduled (daily check, generates Mondays)");

  // ─── Weekly Style Report cron (Sunday) ───────────────────
  // Sends personalized push to Pro users. Runs daily, idempotent per user per week.
  const runWeeklyReports = async () => {
    // Only fire on Sundays (day 0)
    if (new Date().getUTCDay() !== 0) return;
    try {
      const url = `http://127.0.0.1:${PORT}/api/ootw/weekly-reports`;
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-cron-key": process.env.CRON_SECRET,
        },
      });
      if (!res.ok) {
        console.error(`[Cron] Weekly Style Reports HTTP ${res.status}`);
        return;
      }
      const data = await res.json();
      console.log(`[Cron] Weekly Style Reports: sent=${data.sent || 0}`);
    } catch (err) {
      console.error("[Cron] Weekly Style Reports failed:", err.message);
    }
  };
  // Check daily at ~10:00 UTC (runs only on Sundays)
  setTimeout(() => {
    runWeeklyReports();
    setInterval(runWeeklyReports, 24 * 60 * 60 * 1000);
  }, 120_000);
  console.log("  📅 Weekly Style Report cron scheduled (Sundays)");

  // ─── Content moderation ─────────────────────────────────
  startContentModeration();
});

// Graceful shutdown
const shutdown = (signal) => {
  console.log(`${signal} received, shutting down gracefully...`);
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
  setTimeout(() => {
    console.error('Forced shutdown after timeout');
    process.exit(1);
  }, 10000);
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

export default app;
