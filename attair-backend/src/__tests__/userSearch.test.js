/**
 * Tests for GET /api/users/search (routes/social.js)
 *
 * Covers:
 *   A. Returns 200 with { users } shape
 *   B. Returns 400 when q is missing or too short (< 2 chars)
 *   C. Returns 400 when q is over 100 chars
 *   D. Each user has id, display_name, bio, follower_count
 *   E. Requires auth (401 without token)
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

let mockSearchResults = [];
let mockFollowerCount = 5;

vi.mock("../lib/supabase.js", () => {
  const mockFrom = vi.fn().mockImplementation((table) => {
    if (table === "profiles") {
      return {
        select: vi.fn().mockReturnThis(),
        ilike: vi.fn().mockReturnThis(),
        neq: vi.fn().mockReturnThis(),
        limit: vi.fn(async () => ({ data: mockSearchResults, error: null })),
      };
    }
    if (table === "follows") {
      // For follower count queries: .select("*", { count: "exact", head: true }).eq(...)
      const countResult = { count: mockFollowerCount, error: null };
      return {
        select: vi.fn().mockReturnThis(),
        eq: vi.fn(async () => countResult),
      };
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

async function get(port, query = {}, withAuth = true) {
  const params = new URLSearchParams(query);
  const headers = { "content-type": "application/json" };
  if (withAuth) headers.authorization = "Bearer valid-token";
  const res = await fetch(`http://127.0.0.1:${port}/api/users/search?${params}`, {
    method: "GET",
    headers,
  });
  let json;
  try { json = await res.json(); } catch { json = null; }
  return { status: res.status, body: json };
}

// ─── Tests ────────────────────────────────────────────────────────────────

describe("GET /api/users/search", () => {
  let server;
  let port;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockSearchResults = [];
    mockFollowerCount = 5;

    const app = await makeApp();
    const started = await startServer(app);
    server = started.server;
    port = started.port;
  });

  afterEach(() => server.close());

  it("returns 401 without auth token", async () => {
    const { status } = await get(port, { q: "test" }, false);
    expect(status).toBe(401);
  });

  it("returns 400 when q is missing", async () => {
    const { status, body } = await get(port, {});
    expect(status).toBe(400);
    expect(body.error).toBeTruthy();
  });

  it("returns 400 when q is empty string", async () => {
    const { status } = await get(port, { q: "" });
    expect(status).toBe(400);
  });

  it("returns 400 when q is only 1 character", async () => {
    const { status, body } = await get(port, { q: "a" });
    expect(status).toBe(400);
    expect(body.error).toMatch(/2 characters/i);
  });

  it("returns 400 when q is over 100 characters", async () => {
    const { status, body } = await get(port, { q: "x".repeat(101) });
    expect(status).toBe(400);
    expect(body.error).toMatch(/too long/i);
  });

  it("returns 200 with { users } shape for valid query", async () => {
    mockSearchResults = [
      { id: "user-1", display_name: "Alice", bio: "Fashion lover" },
    ];

    const { status, body } = await get(port, { q: "al" });
    expect(status).toBe(200);
    expect(body).toHaveProperty("users");
    expect(Array.isArray(body.users)).toBe(true);
  });

  it("returns empty users array when no matches", async () => {
    mockSearchResults = [];

    const { status, body } = await get(port, { q: "xyz" });
    expect(status).toBe(200);
    expect(body.users).toEqual([]);
  });

  it("each user has id, display_name, bio, follower_count", async () => {
    mockSearchResults = [
      { id: "user-2", display_name: "Bob", bio: "Style enthusiast" },
    ];
    mockFollowerCount = 12;

    const { status, body } = await get(port, { q: "bo" });
    expect(status).toBe(200);
    expect(body.users).toHaveLength(1);

    const user = body.users[0];
    expect(user).toHaveProperty("id", "user-2");
    expect(user).toHaveProperty("display_name", "Bob");
    expect(user).toHaveProperty("bio", "Style enthusiast");
    expect(user).toHaveProperty("follower_count");
    expect(typeof user.follower_count).toBe("number");
  });

  it("accepts a query of exactly 2 characters", async () => {
    mockSearchResults = [];
    const { status } = await get(port, { q: "ab" });
    expect(status).toBe(200);
  });

  it("accepts a query of exactly 100 characters", async () => {
    mockSearchResults = [];
    const { status } = await get(port, { q: "a".repeat(100) });
    expect(status).toBe(200);
  });
});
