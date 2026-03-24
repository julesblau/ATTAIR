/**
 * Tests for field length caps in user.js and wishlists.js
 *
 * Uses a real Express app + http.createServer.
 *
 * Covers:
 *   D1. PATCH /api/user/profile   — display_name > 100 chars → 400
 *   D2. PATCH /api/user/scan/:id  — scan_name > 200 chars → 400
 *   D3. POST  /api/wishlists      — name > 100 chars → 400
 *   D4. PATCH /api/wishlists/:id  — name > 100 chars → 400
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import { createServer } from "http";

// ─── Mocks ────────────────────────────────────────────────────────────────

vi.mock("../lib/supabase.js", () => ({
  default: {
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            select: () => ({
              single: () => Promise.resolve({ data: { id: "x" }, error: null }),
            }),
            single: () => Promise.resolve({ data: { id: "x" }, error: null }),
          }),
          single: () => Promise.resolve({ data: { id: "x" }, error: null }),
        }),
      }),
      update: () => ({
        eq: () => ({
          eq: () => ({
            select: () => ({
              single: () => Promise.resolve({ data: { id: "x", display_name: "Alice" }, error: null }),
            }),
          }),
          select: () => ({
            single: () => Promise.resolve({ data: { id: "x" }, error: null }),
          }),
        }),
      }),
      insert: () => ({
        select: () => ({
          single: () => Promise.resolve({
            data: { id: "wl-1", name: "My List", created_at: new Date().toISOString() },
            error: null,
          }),
        }),
      }),
    }),
  },
}));

vi.mock("../middleware/auth.js", () => ({
  requireAuth: (req, _res, next) => {
    req.userId = "user-test";
    next();
  },
}));

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

async function makeUserApp() {
  const { default: userRouter } = await import("../routes/user.js");
  const app = express();
  app.use(express.json());
  app.use("/api/user", userRouter);
  return app;
}

async function makeWishlistsApp() {
  const { default: wishlistsRouter } = await import("../routes/wishlists.js");
  const app = express();
  app.use(express.json());
  app.use("/api/wishlists", wishlistsRouter);
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

async function patch(port, path, body) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: "PATCH",
    headers: { "content-type": "application/json", authorization: "Bearer valid-token" },
    body: JSON.stringify(body),
  });
  let json;
  try { json = await res.json(); } catch { json = null; }
  return { status: res.status, body: json };
}

async function postReq(port, path, body) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer valid-token" },
    body: JSON.stringify(body),
  });
  let json;
  try { json = await res.json(); } catch { json = null; }
  return { status: res.status, body: json };
}

// ─── Tests: display_name cap ───────────────────────────────────────────────

describe("PATCH /api/user/profile — display_name length cap", () => {
  let server;
  let port;

  beforeEach(async () => {
    const app = await makeUserApp();
    const started = await startServer(app);
    server = started.server;
    port = started.port;
  });

  afterEach(() => server.close());

  it("rejects display_name > 100 chars with 400", async () => {
    const { status, body } = await patch(port, "/api/user/profile", {
      display_name: "a".repeat(101),
    });
    expect(status).toBe(400);
    expect(body.error).toMatch(/100/i);
  });

  it("accepts display_name of exactly 100 chars (no 400)", async () => {
    const { status } = await patch(port, "/api/user/profile", {
      display_name: "a".repeat(100),
    });
    expect(status).not.toBe(400);
  });

  it("accepts a short display_name (no 400)", async () => {
    const { status } = await patch(port, "/api/user/profile", {
      display_name: "Alice",
    });
    expect(status).not.toBe(400);
  });
});

// ─── Tests: scan_name cap ──────────────────────────────────────────────────

describe("PATCH /api/user/scan/:id — scan_name length cap", () => {
  let server;
  let port;

  beforeEach(async () => {
    const app = await makeUserApp();
    const started = await startServer(app);
    server = started.server;
    port = started.port;
  });

  afterEach(() => server.close());

  it("rejects scan_name > 200 chars with 400", async () => {
    const { status, body } = await patch(port, "/api/user/scan/scan-1", {
      scan_name: "x".repeat(201),
    });
    expect(status).toBe(400);
    expect(body.error).toMatch(/200/i);
  });

  it("accepts scan_name of exactly 200 chars (no 400)", async () => {
    const { status } = await patch(port, "/api/user/scan/scan-1", {
      scan_name: "x".repeat(200),
    });
    expect(status).not.toBe(400);
  });

  it("accepts a short scan_name (no 400)", async () => {
    const { status } = await patch(port, "/api/user/scan/scan-1", {
      scan_name: "Morning outfit",
    });
    expect(status).not.toBe(400);
  });
});

// ─── Tests: wishlist name cap on create ───────────────────────────────────

describe("POST /api/wishlists — wishlist name length cap", () => {
  let server;
  let port;

  beforeEach(async () => {
    const app = await makeWishlistsApp();
    const started = await startServer(app);
    server = started.server;
    port = started.port;
  });

  afterEach(() => server.close());

  it("rejects wishlist name > 100 chars with 400", async () => {
    const { status, body } = await postReq(port, "/api/wishlists", {
      name: "W".repeat(101),
    });
    expect(status).toBe(400);
    expect(body.error).toMatch(/100/i);
  });

  it("accepts wishlist name of exactly 100 chars (no 400)", async () => {
    const { status } = await postReq(port, "/api/wishlists", {
      name: "W".repeat(100),
    });
    expect(status).not.toBe(400);
  });

  it("rejects empty wishlist name with 400", async () => {
    const { status } = await postReq(port, "/api/wishlists", { name: "" });
    expect(status).toBe(400);
  });

  it("accepts a normal wishlist name (no 400)", async () => {
    const { status } = await postReq(port, "/api/wishlists", { name: "Summer Fits" });
    expect(status).not.toBe(400);
  });
});

// ─── Tests: wishlist name cap on rename ───────────────────────────────────

describe("PATCH /api/wishlists/:id — wishlist rename length cap", () => {
  let server;
  let port;

  beforeEach(async () => {
    const app = await makeWishlistsApp();
    const started = await startServer(app);
    server = started.server;
    port = started.port;
  });

  afterEach(() => server.close());

  it("rejects rename > 100 chars with 400", async () => {
    const { status, body } = await patch(port, "/api/wishlists/wl-1", {
      name: "W".repeat(101),
    });
    expect(status).toBe(400);
    expect(body.error).toMatch(/100/i);
  });

  it("accepts rename of exactly 100 chars (no 400)", async () => {
    const { status } = await patch(port, "/api/wishlists/wl-1", {
      name: "W".repeat(100),
    });
    expect(status).not.toBe(400);
  });

  it("rejects empty rename with 400", async () => {
    const { status } = await patch(port, "/api/wishlists/wl-1", { name: "" });
    expect(status).toBe(400);
  });
});
