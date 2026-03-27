/**
 * Tests for PATCH /api/user/scan/:scanId/verdict (routes/user.js)
 *
 * Covers:
 *   A. Sets verdict successfully (would_wear, on_the_fence, not_for_me)
 *   B. Clears verdict with null
 *   C. Returns 400 for invalid verdict value
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

let mockUpdateError = null;

vi.mock("../lib/supabase.js", () => {
  const makeUpdateChain = () => ({
    update: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    // terminal — resolves with the mock error state
    then: undefined,
  });

  // The verdict route does: supabase.from("scans").update({verdict}).eq().eq().select().single()
  let mockScanData = { id: "00000000-0000-0000-0000-000000000001" };
  const mockSingle = vi.fn(async () => ({ data: mockUpdateError ? null : mockScanData, error: mockUpdateError }));
  const mockSelect = vi.fn().mockReturnValue({ single: mockSingle });
  const mockEqTerminal = vi.fn().mockReturnValue({ select: mockSelect });
  const mockEq1 = vi.fn().mockReturnValue({ eq: mockEqTerminal });
  const mockUpdate = vi.fn().mockReturnValue({ eq: mockEq1 });

  const mockFrom = vi.fn().mockImplementation((table) => {
    if (table === "scans") {
      return { update: mockUpdate };
    }
    // user.js also queries "profiles" in some routes — return a generic chain
    return {
      select: vi.fn().mockReturnThis(),
      update: vi.fn().mockReturnThis(),
      eq: vi.fn(async () => ({ data: null, error: null })),
      single: vi.fn(async () => ({ data: null, error: null })),
    };
  });

  return { default: { from: mockFrom } };
});

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

async function patch(port, scanId, body, withAuth = true) {
  const headers = { "content-type": "application/json" };
  if (withAuth) headers.authorization = "Bearer valid-token";
  const res = await fetch(`http://127.0.0.1:${port}/api/user/scan/${scanId}/verdict`, {
    method: "PATCH",
    headers,
    body: JSON.stringify(body),
  });
  let json;
  try { json = await res.json(); } catch { json = null; }
  return { status: res.status, body: json };
}

// ─── Tests ────────────────────────────────────────────────────────────────

describe("PATCH /api/user/scan/:scanId/verdict", () => {
  let server;
  let port;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockUpdateError = null;

    const app = await makeApp();
    const started = await startServer(app);
    server = started.server;
    port = started.port;
  });

  afterEach(() => server.close());

  it("returns 401 without auth token", async () => {
    const { status } = await patch(port, "00000000-0000-0000-0000-000000000001", { verdict: "would_wear" }, false);
    expect(status).toBe(401);
  });

  it("returns 400 for an invalid verdict string", async () => {
    const { status, body } = await patch(port, "00000000-0000-0000-0000-000000000001", { verdict: "love_it" });
    expect(status).toBe(400);
    expect(body.error).toMatch(/invalid verdict/i);
  });

  it("returns 400 for an undefined verdict (missing key)", async () => {
    const { status } = await patch(port, "00000000-0000-0000-0000-000000000001", {});
    expect(status).toBe(400);
  });

  it("returns 400 for a numeric verdict value", async () => {
    const { status } = await patch(port, "00000000-0000-0000-0000-000000000001", { verdict: 5 });
    expect(status).toBe(400);
  });

  it("returns 400 for verdict 'yes'", async () => {
    const { status } = await patch(port, "00000000-0000-0000-0000-000000000001", { verdict: "yes" });
    expect(status).toBe(400);
  });

  it("sets verdict to 'would_wear' successfully", async () => {
    const { status, body } = await patch(port, "00000000-0000-0000-0000-000000000001", { verdict: "would_wear" });
    expect(status).toBe(200);
    expect(body.verdict).toBe("would_wear");
  });

  it("sets verdict to 'on_the_fence' successfully", async () => {
    const { status, body } = await patch(port, "00000000-0000-0000-0000-000000000001", { verdict: "on_the_fence" });
    expect(status).toBe(200);
    expect(body.verdict).toBe("on_the_fence");
  });

  it("sets verdict to 'not_for_me' successfully", async () => {
    const { status, body } = await patch(port, "00000000-0000-0000-0000-000000000001", { verdict: "not_for_me" });
    expect(status).toBe(200);
    expect(body.verdict).toBe("not_for_me");
  });

  it("clears verdict by setting it to null", async () => {
    const { status, body } = await patch(port, "00000000-0000-0000-0000-000000000001", { verdict: null });
    expect(status).toBe(200);
    expect(body.verdict).toBeNull();
  });
});
