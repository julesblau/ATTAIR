/**
 * Tests for social routes (routes/social.js)
 *
 * Covers:
 *   A. POST /api/social/follow/:userId requires auth (returns 401 without token)
 *   B. DELETE /api/social/follow/:userId requires auth
 *   C. GET /api/social/profile/:userId requires auth
 *   D. PATCH /api/social/scans/:scanId/visibility requires auth
 *   E. Visibility must be one of 'public', 'private', 'followers' for scans
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import { createServer } from "http";

// ─── Mocks ────────────────────────────────────────────────────────────────

// Use the real auth middleware behaviour: no Authorization header → 401
vi.mock("../middleware/auth.js", async () => {
  const { default: real } = await vi.importActual("../middleware/auth.js");
  return { requireAuth: real.requireAuth ?? real };
});

// Override the above — we need a controllable auth mock that returns 401
// without a token but passes with one, without hitting Supabase.
// We achieve this with a simple header check.
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

// Build a chainable Supabase mock that resolves successfully for all operations
const makeChain = () => {
  const chain = {
    select: vi.fn().mockReturnThis(),
    insert: vi.fn().mockReturnThis(),
    update: vi.fn().mockReturnThis(),
    delete: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    in: vi.fn().mockReturnThis(),
    order: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
    single: vi.fn().mockResolvedValue({
      data: { id: "scan-1", visibility: "public" },
      error: null,
    }),
    // Promise resolution for delete/insert chains without .single()
    then: undefined,
  };
  // Make the chain itself thenable so await supabase.from(...).delete()... works
  chain.eq.mockImplementation(() => {
    const inner = { ...chain };
    inner.eq = vi.fn().mockImplementation(() => {
      // terminal eq — return a resolved promise
      return Promise.resolve({ error: null });
    });
    return inner;
  });
  return chain;
};

vi.mock("../lib/supabase.js", () => {
  const profileData = {
    id: "user-target",
    display_name: "Test User",
    bio: null,
    avatar_url: null,
    style_interests: [],
    created_at: new Date().toISOString(),
  };

  const mockSingle = vi.fn().mockResolvedValue({ data: profileData, error: null });
  const mockMaybeSingle = vi.fn().mockResolvedValue({ data: null, error: null });
  const mockInsert = vi.fn().mockResolvedValue({ error: null });
  const mockDeleteEqEq = vi.fn().mockResolvedValue({ error: null });
  const mockDeleteEq = vi.fn().mockReturnValue({ eq: mockDeleteEqEq });
  const mockDelete = vi.fn().mockReturnValue({ eq: mockDeleteEq });

  // Scan visibility update chain: .update().eq().eq().select().single()
  const mockSelectSingle = vi.fn().mockReturnValue({ single: mockSingle });
  const mockUpdateEqEq = vi.fn().mockReturnValue({ select: mockSelectSingle });
  const mockUpdateEq = vi.fn().mockReturnValue({ eq: mockUpdateEqEq });
  const mockUpdate = vi.fn().mockReturnValue({ eq: mockUpdateEq });

  // Profile select chain: .select().eq().single()
  const mockProfileSelectEq = vi.fn().mockReturnValue({ single: mockSingle });
  const mockProfileSelect = vi.fn().mockReturnValue({ eq: mockProfileSelectEq });

  // Follower/following count chain: .select().eq()  resolves with { count: 0 }
  const mockCountResolve = vi.fn().mockResolvedValue({ count: 0, error: null });
  const mockCountEq = vi.fn().mockReturnValue(mockCountResolve);
  const mockCountSelectObj = { eq: mockCountEq };

  // follows check: .select().eq().eq().maybeSingle()
  const mockFollowsEqMaybe = vi.fn().mockReturnValue({ maybeSingle: mockMaybeSingle });
  const mockFollowsEq = vi.fn().mockReturnValue({ eq: mockFollowsEqMaybe });

  // Scans/saved_items/wishlists for profile page
  const mockInResult = vi.fn().mockResolvedValue({ data: [], error: null });
  const mockLimitResult = vi.fn().mockReturnValue({ then: mockInResult });
  const mockOrderResult = vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue({ data: [], error: null }) });
  const mockInChain = vi.fn().mockReturnValue({
    order: vi.fn().mockReturnValue({
      limit: vi.fn().mockResolvedValue({ data: [], error: null }),
    }),
  });

  let callCount = 0;
  const mockFrom = vi.fn().mockImplementation((table) => {
    if (table === "follows") {
      return {
        insert: mockInsert,
        delete: mockDelete,
        select: vi.fn().mockImplementation((fields, opts) => {
          if (opts?.count === "exact") return mockCountSelectObj;
          return { eq: mockFollowsEq };
        }),
        eq: vi.fn().mockReturnThis(),
      };
    }
    if (table === "profiles") {
      return {
        select: mockProfileSelect,
        update: mockUpdate,
      };
    }
    if (table === "scans") {
      return {
        update: mockUpdate,
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            in: mockInChain,
          }),
        }),
      };
    }
    // saved_items / wishlists
    return {
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          in: mockInChain,
        }),
      }),
    };
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

async function request(port, method, path, body = null, withAuth = true) {
  const headers = { "content-type": "application/json" };
  if (withAuth) headers.authorization = "Bearer valid-token";

  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  let json;
  try { json = await res.json(); } catch { json = null; }
  return { status: res.status, body: json };
}

// ─── Tests ────────────────────────────────────────────────────────────────

describe("Social routes — auth required", () => {
  let server;
  let port;

  beforeEach(async () => {
    vi.clearAllMocks();
    const app = await makeApp();
    const started = await startServer(app);
    server = started.server;
    port = started.port;
  });

  afterEach(() => server.close());

  it("POST /api/social/follow/:userId returns 401 without token", async () => {
    const { status } = await request(port, "POST", "/api/social/follow/other-user", null, false);
    expect(status).toBe(401);
  });

  it("DELETE /api/social/follow/:userId returns 401 without token", async () => {
    const { status } = await request(port, "DELETE", "/api/social/follow/other-user", null, false);
    expect(status).toBe(401);
  });

  it("GET /api/social/profile/:userId returns 401 without token", async () => {
    const { status } = await request(port, "GET", "/api/social/profile/some-user", null, false);
    expect(status).toBe(401);
  });

  it("PATCH /api/social/scans/:scanId/visibility returns 401 without token", async () => {
    const { status } = await request(
      port, "PATCH", "/api/social/scans/scan-1/visibility",
      { visibility: "public" }, false
    );
    expect(status).toBe(401);
  });

  it("POST /api/social/follow/:userId succeeds with valid token (200 or 500 from mock)", async () => {
    const { status } = await request(port, "POST", "/api/social/follow/other-user", null, true);
    // Auth passes; result depends on mock db — accept any non-401
    expect(status).not.toBe(401);
  });

  it("DELETE /api/social/follow/:userId succeeds with valid token", async () => {
    const { status } = await request(port, "DELETE", "/api/social/follow/other-user", null, true);
    expect(status).not.toBe(401);
  });
});

describe("PATCH /api/social/scans/:scanId/visibility — visibility validation", () => {
  let server;
  let port;

  beforeEach(async () => {
    vi.clearAllMocks();
    const app = await makeApp();
    const started = await startServer(app);
    server = started.server;
    port = started.port;
  });

  afterEach(() => server.close());

  it("returns 400 for invalid visibility 'secret'", async () => {
    const { status, body } = await request(
      port, "PATCH", "/api/social/scans/scan-1/visibility",
      { visibility: "secret" }, true
    );
    expect(status).toBe(400);
    expect(body.error).toMatch(/visibility/i);
  });

  it("returns 400 for invalid visibility 'everyone'", async () => {
    const { status } = await request(
      port, "PATCH", "/api/social/scans/scan-1/visibility",
      { visibility: "everyone" }, true
    );
    expect(status).toBe(400);
  });

  it("returns 400 for missing visibility field", async () => {
    const { status } = await request(
      port, "PATCH", "/api/social/scans/scan-1/visibility",
      {}, true
    );
    expect(status).toBe(400);
  });

  it("accepts visibility 'public'", async () => {
    const { status } = await request(
      port, "PATCH", "/api/social/scans/scan-1/visibility",
      { visibility: "public" }, true
    );
    expect(status).not.toBe(400);
  });

  it("accepts visibility 'private'", async () => {
    const { status } = await request(
      port, "PATCH", "/api/social/scans/scan-1/visibility",
      { visibility: "private" }, true
    );
    expect(status).not.toBe(400);
  });

  it("accepts visibility 'followers'", async () => {
    const { status } = await request(
      port, "PATCH", "/api/social/scans/scan-1/visibility",
      { visibility: "followers" }, true
    );
    expect(status).not.toBe(400);
  });
});
