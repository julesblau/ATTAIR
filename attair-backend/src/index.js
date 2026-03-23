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

// ─── Validate required env vars ─────────────────────────────
const REQUIRED_ENV = [
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "SUPABASE_ANON_KEY",
  "ANTHROPIC_API_KEY",
  "SERPAPI_KEY",
];

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

// ─── Middleware ──────────────────────────────────────────────
app.use(helmet());

// CORS
const allowedOrigins = (process.env.CORS_ORIGINS || "")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

app.use(
  cors({
    origin: allowedOrigins.length > 0 ? allowedOrigins : true,
    credentials: true,
  })
);

// Body parsing — 10MB limit for base64 images
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

// Logging
app.use(morgan(process.env.NODE_ENV === "production" ? "combined" : "dev"));

// Global IP rate limit — prevent abuse (100 req/min per IP)
const globalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 100,
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

// ─── Routes ─────────────────────────────────────────────────
app.use("/api/auth", authRouter);
app.use("/api/identify", identifyRouter);
app.use("/api/find-products", findProductsRouter);
app.use("/api/user", userRouter);
app.use("/api/go", affiliateRouter);
app.use("/api/ad-events", adEventsRouter);
app.use("/api/events", eventsRouter);
app.use("/api/refine-item", refineItemRouter);
app.use("/api/suggest-pairings", suggestPairingsRouter);
app.use("/api/seen-on", seenOnRouter);
app.use("/api/nearby-stores", nearbyStoresRouter);
app.use("/api/wishlists", wishlistsRouter);

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
app.listen(PORT, "0.0.0.0", () => {
  console.log(`
  ╔═════════════════════════════════════════╗
  ║   ATTAIR API Server                     ║
  ║   Port: ${String(PORT).padEnd(31)}║
  ║   Env:  ${String(process.env.NODE_ENV || "development").padEnd(31)}║
  ╚═════════════════════════════════════════╝
  `);
});

export default app;
