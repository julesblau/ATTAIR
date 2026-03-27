/**
 * Tests for GET /api/scan/:scanId/public (routes/social.js)
 *
 * Covers:
 *   A. Returns scan data for public scans
 *   B. Returns 404 for non-existent scan
 *   C. Returns 400 for invalid UUID format
 *   D. Does NOT require auth (works without token)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import { createServer } from "http";

// ─── Auth mock ────────────────────────────────────────────────────────────
// The public scan endpoint does NOT use requireAuth, but the social router
// imports it, so we still need the mock to avoid real Supabase calls.

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

const VALID_UUID = "550e8400-e29b-41d4-a716-446655440000";

let mockScanData = null;
let mockScanError = null;
let mockProfileData = null;

vi.mock("../lib/supabase.js", () => {
  const mockFrom = vi.fn().mockImplementation((table) => {
    if (table === "scans") {
      return {
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        single: vi.fn(async () => ({ data: mockScanData, error: mockScanError })),
      };
    }
    if (table === "profiles") {
      return {
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        single: vi.fn(async () => ({ data: mockProfileData, error: null })),
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

async function get(port, scanId, withAuth = false) {
  const headers = { "content-type": "application/json" };
  if (withAuth) headers.authorization = "Bearer valid-token";
  const res = await fetch(`http://127.0.0.1:${port}/api/scan/${scanId}/public`, {
    method: "GET",
    headers,
  });
  let json;
  try { json = await res.json(); } catch { json = null; }
  return { status: res.status, body: json };
}

// ─── Tests ────────────────────────────────────────────────────────────────

describe("GET /api/scan/:scanId/public", () => {
  let server;
  let port;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockScanData = null;
    mockScanError = null;
    mockProfileData = null;

    const app = await makeApp();
    const started = await startServer(app);
    server = started.server;
    port = started.port;
  });

  afterEach(() => server.close());

  it("returns 400 for an invalid UUID format (not a UUID)", async () => {
    const { status, body } = await get(port, "not-a-uuid");
    expect(status).toBe(400);
    expect(body.error).toMatch(/invalid scan id/i);
  });

  it("returns 400 for a short random string that is not a UUID", async () => {
    const { status } = await get(port, "abc123");
    expect(status).toBe(400);
  });

  it("returns 400 for a UUID with wrong structure (wrong groups)", async () => {
    const { status } = await get(port, "550e8400-e29b-41d4-a716");
    expect(status).toBe(400);
  });

  it("returns 404 when scan does not exist", async () => {
    mockScanData = null;
    mockScanError = { message: "No rows returned" };

    const { status, body } = await get(port, VALID_UUID);
    expect(status).toBe(404);
    expect(body.error).toMatch(/not found|not public/i);
  });

  it("returns 404 when scan query returns no data without error", async () => {
    mockScanData = null;
    mockScanError = null;

    const { status } = await get(port, VALID_UUID);
    expect(status).toBe(404);
  });

  it("returns scan data for a public scan without requiring auth", async () => {
    mockScanData = {
      id: VALID_UUID,
      user_id: "user-owner",
      image_url: "https://example.com/outfit.jpg",
      summary: "Cool streetwear look",
      items: [{ name: "Hoodie" }],
      created_at: "2026-03-27T00:00:00Z",
      visibility: "public",
    };
    mockProfileData = { display_name: "StyleKing" };

    // Note: withAuth = false — no token supplied
    const { status, body } = await get(port, VALID_UUID, false);
    expect(status).toBe(200);
    expect(body).toHaveProperty("id", VALID_UUID);
    expect(body).toHaveProperty("image_url");
    expect(body).toHaveProperty("summary");
    expect(body).toHaveProperty("items");
    expect(body).toHaveProperty("created_at");
    expect(body).toHaveProperty("user_display_name");
  });

  it("works with auth token as well (auth is optional)", async () => {
    mockScanData = {
      id: VALID_UUID,
      user_id: "user-owner",
      image_url: null,
      summary: "Outfit of the day",
      items: [],
      created_at: "2026-03-27T00:00:00Z",
      visibility: "public",
    };
    mockProfileData = { display_name: "Jane" };

    const { status } = await get(port, VALID_UUID, true);
    expect(status).toBe(200);
  });

  it("returns 'Anonymous' when profile has no display_name", async () => {
    mockScanData = {
      id: VALID_UUID,
      user_id: "user-owner",
      image_url: null,
      summary: null,
      items: [],
      created_at: "2026-03-27T00:00:00Z",
      visibility: "public",
    };
    mockProfileData = null;

    const { status, body } = await get(port, VALID_UUID);
    expect(status).toBe(200);
    expect(body.user_display_name).toBe("Anonymous");
  });

  it("accepts a valid UUID with mixed case", async () => {
    const mixedCaseUuid = "550E8400-E29B-41D4-A716-446655440000";
    mockScanData = {
      id: mixedCaseUuid,
      user_id: "user-owner",
      image_url: null,
      summary: null,
      items: [],
      created_at: "2026-03-27T00:00:00Z",
      visibility: "public",
    };
    mockProfileData = { display_name: "MixedCase" };

    const { status } = await get(port, mixedCaseUuid);
    expect(status).toBe(200);
  });
});
