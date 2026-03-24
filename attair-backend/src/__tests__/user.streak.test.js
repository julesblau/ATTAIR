/**
 * Tests for GET /api/user/streak (routes/user.js)
 *
 * Uses a real Express app + http.createServer so routes run end-to-end.
 *
 * External deps mocked:
 *   - ../lib/supabase.js  (no real DB)
 *   - ../middleware/auth.js (no real Supabase auth)
 *
 * Supabase behaviour is controlled per test by mutating the `.from` function
 * on the default export after importing the module.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import { createServer } from "http";

// ─── Mocks ────────────────────────────────────────────────────────────────
// Use only inline static factories (no captured outer variables in the factory).

vi.mock("../lib/supabase.js", () => ({
  default: {
    // Placeholder `from` — overridden per-test below via the imported module ref.
    from: () => ({ select: () => ({ eq: () => ({ order: () => Promise.resolve({ data: [], error: null }) }) }) }),
  },
}));

vi.mock("../middleware/auth.js", () => ({
  requireAuth: (req, res, next) => {
    // "Bearer NOAUTH" simulates an unauthenticated request.
    const header = req.headers.authorization || "";
    if (!header.startsWith("Bearer ") || header === "Bearer NOAUTH") {
      return res.status(401).json({ error: "Unauthorized" });
    }
    req.userId = header.slice(7);
    next();
  },
}));

// user.js also imports these; provide minimal stubs.
vi.mock("../middleware/rateLimit.js", () => ({
  scanRateLimit: (_req, _res, next) => next(),
  incrementScanCount: () => Promise.resolve(1),
}));

vi.mock("../services/claude.js", () => ({
  identifyClothing: () => Promise.resolve({ gender: "male", summary: "", items: [] }),
  refineItem: () => Promise.resolve({}),
}));

vi.mock("uuid", () => ({ v4: () => "mock-uuid" }));

// ─── Server helpers ───────────────────────────────────────────────────────

async function makeApp() {
  const { default: userRouter } = await import("../routes/user.js");
  const app = express();
  app.use(express.json());
  app.use("/api/user", userRouter);
  return app;
}

function startServer(app) {
  return new Promise((resolve) => {
    const server = createServer(app);
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, port: server.address().port });
    });
  });
}

async function getReq(port, path, authHeader) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    headers: { authorization: authHeader },
  });
  let json;
  try { json = await res.json(); } catch { json = null; }
  return { status: res.status, body: json };
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function daysAgoUtc(n) {
  return new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
}

function makeScan(dateStr) {
  return { created_at: dateStr + "T12:00:00.000Z" };
}

// ─── Tests ────────────────────────────────────────────────────────────────

describe("GET /api/user/streak", () => {
  let server;
  let port;
  let supabaseMod;

  beforeEach(async () => {
    vi.clearAllMocks();

    // Grab the mocked supabase module so we can override `.from` per test
    supabaseMod = (await import("../lib/supabase.js")).default;

    const app = await makeApp();
    const started = await startServer(app);
    server = started.server;
    port = started.port;
  });

  afterEach(() => {
    server.close();
  });

  /** Wire supabase to return the given scan rows (or an error) */
  function setupScans(rows, error) {
    const orderFn = vi.fn().mockResolvedValue({ data: rows, error: error || null });
    const eqFn = vi.fn().mockReturnValue({ order: orderFn });
    const selectFn = vi.fn().mockReturnValue({ eq: eqFn });
    supabaseMod.from = vi.fn().mockReturnValue({ select: selectFn });
  }

  it("returns 401 for unauthenticated request", async () => {
    const { status } = await getReq(port, "/api/user/streak", "Bearer NOAUTH");
    expect(status).toBe(401);
  });

  it("returns streak: 0 when user has no scans", async () => {
    setupScans([]);
    const { status, body } = await getReq(port, "/api/user/streak", "Bearer user-123");
    expect(status).toBe(200);
    expect(body).toMatchObject({ streak: 0, last_scan_date: null });
  });

  it("returns streak: 1 when user has scans only today", async () => {
    const today = daysAgoUtc(0);
    setupScans([makeScan(today)]);
    const { status, body } = await getReq(port, "/api/user/streak", "Bearer user-123");
    expect(status).toBe(200);
    expect(body).toMatchObject({ streak: 1, last_scan_date: today });
  });

  it("returns streak: 1 with multiple scans on same day (deduplication)", async () => {
    const today = daysAgoUtc(0);
    setupScans([makeScan(today), makeScan(today), makeScan(today)]);
    const { body } = await getReq(port, "/api/user/streak", "Bearer user-123");
    expect(body.streak).toBe(1);
  });

  it("returns streak: 2 when user scanned today and yesterday", async () => {
    setupScans([makeScan(daysAgoUtc(0)), makeScan(daysAgoUtc(1))]);
    const { body } = await getReq(port, "/api/user/streak", "Bearer user-123");
    expect(body.streak).toBe(2);
  });

  it("returns streak: 5 for 5 consecutive days ending today", async () => {
    setupScans([0, 1, 2, 3, 4].map((n) => makeScan(daysAgoUtc(n))));
    const { body } = await getReq(port, "/api/user/streak", "Bearer user-123");
    expect(body.streak).toBe(5);
  });

  it("returns streak: 0 when last scan was 3 days ago (gap from today)", async () => {
    setupScans([3, 4, 5].map((n) => makeScan(daysAgoUtc(n))));
    const { body } = await getReq(port, "/api/user/streak", "Bearer user-123");
    expect(body.streak).toBe(0);
  });

  it("breaks streak at a gap — today+yesterday+3daysago → streak: 2", async () => {
    // Day 0 and 1 are consecutive; day 2 is missing; day 3 is present but streak is broken.
    setupScans([0, 1, 3].map((n) => makeScan(daysAgoUtc(n))));
    const { body } = await getReq(port, "/api/user/streak", "Bearer user-123");
    expect(body.streak).toBe(2);
  });

  it("returns streak: 1 when user only scanned yesterday (no scan today)", async () => {
    setupScans([makeScan(daysAgoUtc(1))]);
    const { body } = await getReq(port, "/api/user/streak", "Bearer user-123");
    expect(body.streak).toBe(1);
  });

  it("returns 500 on database error", async () => {
    setupScans(null, new Error("DB failure"));
    const { status } = await getReq(port, "/api/user/streak", "Bearer user-123");
    expect(status).toBe(500);
  });
});
