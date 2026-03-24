/**
 * Tests for the scanRateLimit middleware (middleware/rateLimit.js)
 *
 * The middleware:
 *   1. Requires req.userId (set by requireAuth before it runs)
 *   2. Fetches the profile from supabase
 *   3. Pro/trial users bypass the limit → calls next()
 *   4. Free/expired users with scansToday < 12 → calls next()
 *   5. Free/expired users with scansToday >= 12 → returns 429
 *
 * We mock ../lib/supabase.js to control what the profile query returns.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Mock supabase ─────────────────────────────────────────────────────────

const mockSingle = vi.fn();
const mockEqChain = vi.fn().mockReturnValue({ single: mockSingle });
const mockSelectChain = vi.fn().mockReturnValue({ eq: mockEqChain });
const mockUpdateEq = vi.fn().mockResolvedValue({ error: null });
const mockUpdateChain = vi.fn().mockReturnValue({ eq: mockUpdateEq });
const mockFrom = vi.fn();

vi.mock("../lib/supabase.js", () => ({
  default: { from: mockFrom },
}));

const { scanRateLimit } = await import("../middleware/rateLimit.js");

// ─── Helpers ──────────────────────────────────────────────────────────────

const TODAY_UTC = new Date().toISOString().slice(0, 7); // YYYY-MM (monthly reset)

function makeReqRes(userId = "user-123") {
  const req = { userId };
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

function setupFromMock(profileData) {
  mockSingle.mockResolvedValueOnce({ data: profileData, error: null });
  mockEqChain.mockReturnValue({ single: mockSingle });
  mockSelectChain.mockReturnValue({ eq: mockEqChain });

  // For the update calls (reset / tier-expiry writes)
  mockUpdateEq.mockResolvedValue({ error: null });
  mockUpdateChain.mockReturnValue({ eq: mockUpdateEq });

  mockFrom.mockReturnValue({
    select: mockSelectChain,
    update: mockUpdateChain,
  });
}

// ─── Tests ────────────────────────────────────────────────────────────────

describe("scanRateLimit", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default mockFrom so .update().eq() calls don't throw
    mockUpdateEq.mockResolvedValue({ error: null });
    mockUpdateChain.mockReturnValue({ eq: mockUpdateEq });
    mockFrom.mockReturnValue({
      select: mockSelectChain,
      update: mockUpdateChain,
    });
  });

  it("returns 401 when req.userId is missing", async () => {
    const { req, res, next } = makeReqRes(null);
    req.userId = undefined;
    await scanRateLimit(req, res, next);
    expect(res._status).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  it("returns 404 when profile is not found", async () => {
    mockSingle.mockResolvedValueOnce({ data: null, error: new Error("not found") });
    mockEqChain.mockReturnValue({ single: mockSingle });
    mockSelectChain.mockReturnValue({ eq: mockEqChain });
    mockFrom.mockReturnValue({ select: mockSelectChain, update: mockUpdateChain });

    const { req, res, next } = makeReqRes();
    await scanRateLimit(req, res, next);
    expect(res._status).toBe(404);
    expect(next).not.toHaveBeenCalled();
  });

  it("calls next() for a pro user without checking scan count", async () => {
    setupFromMock({
      tier: "pro",
      scans_today: 999,
      scans_today_reset: TODAY_UTC,
      trial_ends_at: null,
    });

    const { req, res, next } = makeReqRes();
    await scanRateLimit(req, res, next);
    expect(next).toHaveBeenCalledOnce();
    expect(res._status).toBeNull();
  });

  it("calls next() for a trial user without checking scan count", async () => {
    const futureDate = new Date(Date.now() + 86400000 * 5).toISOString();
    setupFromMock({
      tier: "trial",
      scans_today: 50,
      scans_today_reset: TODAY_UTC,
      trial_ends_at: futureDate,
    });

    const { req, res, next } = makeReqRes();
    await scanRateLimit(req, res, next);
    expect(next).toHaveBeenCalledOnce();
    expect(res._status).toBeNull();
  });

  it("calls next() for a free user with scans_today = 0 (under limit)", async () => {
    setupFromMock({
      tier: "free",
      scans_today: 0,
      scans_today_reset: TODAY_UTC,
      trial_ends_at: null,
    });

    const { req, res, next } = makeReqRes();
    await scanRateLimit(req, res, next);
    expect(next).toHaveBeenCalledOnce();
    expect(res._status).toBeNull();
  });

  it("calls next() for a free user with scans_today = 11 (one scan remaining)", async () => {
    setupFromMock({
      tier: "free",
      scans_today: 11,
      scans_today_reset: TODAY_UTC,
      trial_ends_at: null,
    });

    const { req, res, next } = makeReqRes();
    await scanRateLimit(req, res, next);
    expect(next).toHaveBeenCalledOnce();
    expect(res._status).toBeNull();
  });

  it("returns 429 for a free user who has used all 12 scans this month", async () => {
    setupFromMock({
      tier: "free",
      scans_today: 12,
      scans_today_reset: TODAY_UTC,
      trial_ends_at: null,
    });

    const { req, res, next } = makeReqRes();
    await scanRateLimit(req, res, next);
    expect(res._status).toBe(429);
    expect(res._jsonCalls[0]).toMatchObject({
      error: expect.stringMatching(/limit/i),
      scans_remaining: 0,
      scans_limit: 12,
    });
    expect(next).not.toHaveBeenCalled();
  });

  it("returns 429 for an expired user who has used all 12 scans this month", async () => {
    setupFromMock({
      tier: "expired",
      scans_today: 12,
      scans_today_reset: TODAY_UTC,
      trial_ends_at: null,
    });

    const { req, res, next } = makeReqRes();
    await scanRateLimit(req, res, next);
    expect(res._status).toBe(429);
    expect(next).not.toHaveBeenCalled();
  });

  it("resets scans_today to 0 when reset month is in the past and calls next()", async () => {
    setupFromMock({
      tier: "free",
      scans_today: 12,
      scans_today_reset: "2020-01", // old reset month
      trial_ends_at: null,
    });

    const { req, res, next } = makeReqRes();
    await scanRateLimit(req, res, next);
    // After reset, scansToday = 0 which is under the limit → next() should be called
    expect(next).toHaveBeenCalledOnce();
    // The update for the reset should have been called
    expect(mockFrom).toHaveBeenCalledWith("profiles");
  });

  it("attaches req.profile for downstream handlers", async () => {
    setupFromMock({
      tier: "free",
      scans_today: 1,
      scans_today_reset: TODAY_UTC,
      trial_ends_at: null,
    });

    const { req, res, next } = makeReqRes();
    await scanRateLimit(req, res, next);
    expect(next).toHaveBeenCalledOnce();
    expect(req.profile).toBeDefined();
    expect(req.profile.tier).toBe("free");
  });
});
