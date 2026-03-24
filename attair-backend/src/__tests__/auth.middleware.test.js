/**
 * Tests for auth middleware (middleware/auth.js)
 *
 * requireAuth and optionalAuth both use createClient from @supabase/supabase-js
 * internally (they create a one-off client per request). We mock the entire
 * @supabase/supabase-js module so no real network calls happen.
 *
 * Test approach:
 *   - Build minimal mock req/res/next objects
 *   - Call the middleware function directly
 *   - Assert on res.status / res.json calls and req mutation
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Mock @supabase/supabase-js ───────────────────────────────────────────
// createClient is called inside each middleware invocation, so we intercept
// it and return a controlled mock client.

const mockGetUser = vi.fn();

vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(() => ({
    auth: {
      getUser: mockGetUser,
    },
  })),
}));

// Import AFTER mocks are registered
const { requireAuth, optionalAuth } = await import("../middleware/auth.js");

// ─── Helpers ──────────────────────────────────────────────────────────────

function makeReqRes(headers = {}) {
  const req = { headers };
  const jsonCalls = [];
  const res = {
    _status: null,
    status(code) {
      this._status = code;
      return this;
    },
    json(payload) {
      jsonCalls.push(payload);
      return this;
    },
    _jsonCalls: jsonCalls,
  };
  const next = vi.fn();
  return { req, res, next };
}

// ─── requireAuth tests ───────────────────────────────────────────────────

describe("requireAuth", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 401 when Authorization header is missing", async () => {
    const { req, res, next } = makeReqRes({});
    await requireAuth(req, res, next);
    expect(res._status).toBe(401);
    expect(res._jsonCalls[0]).toMatchObject({ error: expect.stringMatching(/missing/i) });
    expect(next).not.toHaveBeenCalled();
  });

  it("returns 401 when Authorization header does not start with 'Bearer '", async () => {
    const { req, res, next } = makeReqRes({ authorization: "Basic abc123" });
    await requireAuth(req, res, next);
    expect(res._status).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  it("returns 401 when supabase returns an error (invalid/expired token)", async () => {
    mockGetUser.mockResolvedValueOnce({
      data: { user: null },
      error: new Error("JWT expired"),
    });

    const { req, res, next } = makeReqRes({ authorization: "Bearer bad.jwt.token" });
    await requireAuth(req, res, next);
    expect(res._status).toBe(401);
    expect(res._jsonCalls[0]).toMatchObject({ error: expect.stringMatching(/invalid|expired/i) });
    expect(next).not.toHaveBeenCalled();
  });

  it("returns 401 when supabase returns no error but user is null", async () => {
    mockGetUser.mockResolvedValueOnce({
      data: { user: null },
      error: null,
    });

    const { req, res, next } = makeReqRes({ authorization: "Bearer some.valid.looking.token" });
    await requireAuth(req, res, next);
    expect(res._status).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  it("calls next() and sets req.userId when token is valid", async () => {
    const fakeUser = { id: "user-uuid-abc", email: "test@example.com" };
    mockGetUser.mockResolvedValueOnce({
      data: { user: fakeUser },
      error: null,
    });

    const { req, res, next } = makeReqRes({ authorization: "Bearer valid.jwt.token" });
    await requireAuth(req, res, next);
    expect(next).toHaveBeenCalledOnce();
    expect(req.userId).toBe("user-uuid-abc");
    expect(req.user).toBe(fakeUser);
    expect(res._status).toBeNull();
  });

  it("returns 401 when supabase throws an unexpected exception", async () => {
    mockGetUser.mockRejectedValueOnce(new Error("Network timeout"));

    const { req, res, next } = makeReqRes({ authorization: "Bearer some.token" });
    await requireAuth(req, res, next);
    expect(res._status).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });
});

// ─── optionalAuth tests ──────────────────────────────────────────────────

describe("optionalAuth", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("calls next() and sets req.userId = null when Authorization header is missing", async () => {
    const { req, res, next } = makeReqRes({});
    await optionalAuth(req, res, next);
    expect(next).toHaveBeenCalledOnce();
    expect(req.userId).toBeNull();
    expect(req.user).toBeNull();
    expect(res._status).toBeNull();
  });

  it("calls next() and sets req.userId = null when token is invalid", async () => {
    mockGetUser.mockResolvedValueOnce({
      data: { user: null },
      error: new Error("Invalid JWT"),
    });

    const { req, res, next } = makeReqRes({ authorization: "Bearer bad.token" });
    await optionalAuth(req, res, next);
    expect(next).toHaveBeenCalledOnce();
    expect(req.userId).toBeNull();
    // NEVER returns 401
    expect(res._status).toBeNull();
  });

  it("calls next() and sets req.userId when token is valid", async () => {
    const fakeUser = { id: "user-uuid-xyz", email: "hello@example.com" };
    mockGetUser.mockResolvedValueOnce({
      data: { user: fakeUser },
      error: null,
    });

    const { req, res, next } = makeReqRes({ authorization: "Bearer valid.token" });
    await optionalAuth(req, res, next);
    expect(next).toHaveBeenCalledOnce();
    expect(req.userId).toBe("user-uuid-xyz");
    expect(res._status).toBeNull();
  });

  it("calls next() even when supabase throws", async () => {
    mockGetUser.mockRejectedValueOnce(new Error("Unexpected crash"));

    const { req, res, next } = makeReqRes({ authorization: "Bearer some.token" });
    await optionalAuth(req, res, next);
    expect(next).toHaveBeenCalledOnce();
    expect(req.userId).toBeNull();
    expect(res._status).toBeNull();
  });
});
