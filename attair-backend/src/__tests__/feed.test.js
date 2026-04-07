/**
 * Tests for GET /api/feed (routes/social.js)
 *
 * Covers:
 *   A. Returns 200 with { scans, page, has_more } shape
 *   B. Paginates correctly (page param)
 *   C. Returns empty array when no public scans exist
 *   D. Requires auth (401 without token)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import { createServer } from "http";

// ─── Auth mock ────────────────────────────────────────────────────────────

vi.mock("../middleware/auth.js", () => ({
  requireAuth: (req, res, next) => {
    const auth = req.headers?.authorization;
    if (!auth || !auth.startsWith("Bearer ")) {
      return res.status(401).json({ error: "Missing or invalid token" });
    }
    req.userId = "user-authed";
    next();
  },
}));

// ─── Supabase mock ────────────────────────────────────────────────────────

// Shared mock state so tests can control what each query returns
let mockFollowingData = [];
let mockScansData = [];
let mockProfilesData = [];
let mockFollowCountData = 0;

vi.mock("../lib/supabase.js", () => {
  const makeRangeChain = () => {
    const chain = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      in: vi.fn().mockReturnThis(),
      neq: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      range: vi.fn(async () => ({ data: mockScansData, error: null })),
    };
    return chain;
  };

  const makeProfilesChain = () => ({
    select: vi.fn().mockReturnValue({
      in: vi.fn(async () => ({ data: mockProfilesData, error: null })),
      eq: vi.fn().mockReturnValue({
        maybeSingle: vi.fn(async () => ({ data: null, error: null })),
      }),
    }),
  });

  const makeSavedItemsChain = () => ({
    select: vi.fn().mockReturnThis(),
    in: vi.fn(async () => ({ data: [], error: null })),
  });

  const mockFrom = vi.fn().mockImplementation((table) => {
    if (table === "follows") {
      return {
        select: vi.fn().mockReturnThis(),
        eq: vi.fn(async () => ({ data: mockFollowingData, error: null })),
      };
    }
    if (table === "scans") {
      return makeRangeChain();
    }
    if (table === "profiles") {
      return makeProfilesChain();
    }
    if (table === "saved_items") {
      return makeSavedItemsChain();
    }
    return {};
  });

  return { default: { from: mockFrom } };
});

// ─── Server helpers ───────────────────────────────────────────────────────

async function makeApp() {
  const { default: socialRouter } = await import("../routes/social.js");
  const app = express();
  app.use(express.json());
  app.use("/api", socialRouter);
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

async function get(port, path, withAuth = true) {
  const headers = { "content-type": "application/json" };
  if (withAuth) headers.authorization = "Bearer valid-token";
  const res = await fetch(`http://127.0.0.1:${port}${path}`, { method: "GET", headers });
  let json;
  try { json = await res.json(); } catch { json = null; }
  return { status: res.status, body: json };
}

// ─── Tests ────────────────────────────────────────────────────────────────

describe("GET /api/feed", () => {
  let server;
  let port;

  beforeEach(async () => {
    vi.clearAllMocks();
    // Reset shared mock state
    mockFollowingData = [];
    mockScansData = [];
    mockProfilesData = [];
    mockFollowCountData = 0;

    const app = await makeApp();
    const started = await startServer(app);
    server = started.server;
    port = started.port;
  });

  afterEach(() => server.close());

  it("returns 401 without auth token", async () => {
    const { status } = await get(port, "/api/feed", false);
    expect(status).toBe(401);
  });

  it("returns 200 with { scans, page, has_more } shape when no follows", async () => {
    mockFollowingData = [];
    mockScansData = [];

    const { status, body } = await get(port, "/api/feed");
    expect(status).toBe(200);
    expect(body).toHaveProperty("scans");
    expect(body).toHaveProperty("page");
    expect(body).toHaveProperty("has_more");
    expect(Array.isArray(body.scans)).toBe(true);
  });

  it("returns empty scans array when no public scans exist", async () => {
    mockFollowingData = [];
    mockScansData = [];

    const { status, body } = await get(port, "/api/feed");
    expect(status).toBe(200);
    expect(body.scans).toEqual([]);
    expect(body.has_more).toBe(false);
  });

  it("returns scans with enriched user info when public scans exist", async () => {
    mockFollowingData = [];
    mockProfilesData = [{ id: "user-1", display_name: "Test User", bio: "A bio" }];
    mockScansData = [
      {
        id: "scan-abc",
        user_id: "user-1",
        image_url: "https://example.com/img.jpg",
        summary: "A cool outfit",
        items: [{ name: "Jacket" }],
        created_at: "2026-03-27T00:00:00Z",
        visibility: "public",
      },
    ];

    const { status, body } = await get(port, "/api/feed");
    expect(status).toBe(200);
    expect(body.scans).toHaveLength(1);
    expect(body.scans[0]).toHaveProperty("id", "scan-abc");
    expect(body.scans[0]).toHaveProperty("user");
    expect(body.page).toBe(1);
  });

  it("defaults to page 1", async () => {
    mockFollowingData = [];
    mockScansData = [];

    const { body } = await get(port, "/api/feed");
    expect(body.page).toBe(1);
  });

  it("respects page query param", async () => {
    mockFollowingData = [];
    mockScansData = [];

    const { status, body } = await get(port, "/api/feed?page=3");
    expect(status).toBe(200);
    expect(body.page).toBe(3);
  });

  it("has_more is true when scans count equals the limit", async () => {
    // Default limit is 20 — fill exactly 20 scans to trigger has_more = true
    mockFollowingData = [];
    mockProfilesData = [{ id: "user-1", display_name: "User One", bio: null }];
    mockScansData = Array.from({ length: 20 }, (_, i) => ({
      id: `scan-${i}`,
      user_id: "user-1",
      image_url: null,
      summary: null,
      items: [],
      created_at: "2026-03-27T00:00:00Z",
      visibility: "public",
    }));

    const { body } = await get(port, "/api/feed?limit=20");
    expect(body.has_more).toBe(true);
  });
});
