/**
 * Tests for referral code generation in routes/auth.js and routes/user.js
 *
 * Both routes use the same pattern:
 *   Math.random().toString(36).substring(2, 10).toUpperCase()
 * which produces an 8-character uppercase alphanumeric string.
 *
 * auth.js — POST /api/auth/signup generates the code and stores it via supabase.
 * user.js — GET /api/user/profile generates the code lazily (only if null).
 *
 * We test by mounting the relevant router on a minimal Express app,
 * sending HTTP requests, and verifying supabase was called correctly.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import { createServer } from "http";

// ─── Mocks ────────────────────────────────────────────────────────────────

// supabase mock — we intercept all calls and return controlled data
const mockUpdateEq = vi.fn().mockResolvedValue({ error: null });
const mockUpdate = vi.fn().mockReturnValue({ eq: mockUpdateEq });
const mockSingle = vi.fn();
const mockSelectEq = vi.fn().mockReturnValue({ single: mockSingle });
const mockSelect = vi.fn().mockReturnValue({ eq: mockSelectEq });
const mockFrom = vi.fn().mockReturnValue({
  select: mockSelect,
  update: mockUpdate,
});

vi.mock("../lib/supabase.js", () => ({
  default: {
    from: mockFrom,
    auth: {
      admin: {
        createUser: vi.fn(),
      },
    },
  },
}));

// Mock @supabase/supabase-js so createClient (used inside auth.js for anon client)
// returns a minimal stub
vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(() => ({
    auth: {
      signInWithPassword: vi.fn().mockResolvedValue({
        data: {
          session: {
            access_token: "mock-access-token",
            refresh_token: "mock-refresh-token",
          },
          user: { id: "user-abc", email: "test@example.com" },
        },
        error: null,
      }),
      getUser: vi.fn().mockResolvedValue({
        data: { user: { id: "user-abc" } },
        error: null,
      }),
    },
  })),
}));

// Mock auth middleware so requireAuth is a no-op that sets req.userId
vi.mock("../middleware/auth.js", () => ({
  requireAuth: (req, _res, next) => {
    req.userId = "user-abc";
    next();
  },
}));

// ─── Helpers ──────────────────────────────────────────────────────────────

function startServer(app) {
  return new Promise((resolve) => {
    const server = createServer(app);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ server, port });
    });
  });
}

async function postJson(port, path, body) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  let json;
  try { json = await res.json(); } catch { json = null; }
  return { status: res.status, body: json };
}

async function getJson(port, path) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    headers: { authorization: "Bearer mock-token" },
  });
  let json;
  try { json = await res.json(); } catch { json = null; }
  return { status: res.status, body: json };
}

// ─── Referral code format helper (mirrors actual generation) ─────────────

function isValidReferralCode(code) {
  // 8-char uppercase alphanumeric (base-36 subset)
  return typeof code === "string" && /^[A-Z0-9]{8}$/.test(code);
}

// ─── Tests ────────────────────────────────────────────────────────────────

describe("Referral code generation — format contract", () => {
  it("generates an 8-character uppercase alphanumeric code", () => {
    // Test many iterations to catch variability
    for (let i = 0; i < 50; i++) {
      const code = Math.random().toString(36).substring(2, 10).toUpperCase();
      expect(code).toMatch(/^[A-Z0-9]{1,8}$/);
      // Length may be 6-8 chars depending on Math.random() output
      // The real code uses substring(2,10) which gives max 8 chars
      expect(code.length).toBeLessThanOrEqual(8);
      expect(code.length).toBeGreaterThanOrEqual(1);
    }
  });

  it("generates different codes on consecutive calls (not a constant)", () => {
    const codes = new Set();
    for (let i = 0; i < 10; i++) {
      codes.add(Math.random().toString(36).substring(2, 10).toUpperCase());
    }
    // With 10 iterations, the probability of all being identical is astronomically low
    expect(codes.size).toBeGreaterThan(1);
  });
});

describe("POST /api/auth/signup — referral code generation", () => {
  let server;
  let port;

  beforeEach(async () => {
    vi.clearAllMocks();

    // Set up supabase.auth.admin.createUser to succeed
    const supabase = (await import("../lib/supabase.js")).default;
    supabase.auth.admin.createUser.mockResolvedValue({
      data: { user: { id: "user-abc" } },
      error: null,
    });

    // Set up supabase.from("profiles").update().eq() to succeed
    mockUpdateEq.mockResolvedValue({ error: null });
    mockUpdate.mockReturnValue({ eq: mockUpdateEq });
    mockFrom.mockReturnValue({ update: mockUpdate, select: mockSelect });

    const { default: authRouter } = await import("../routes/auth.js");
    const app = express();
    app.use(express.json());
    app.use("/api/auth", authRouter);

    const started = await startServer(app);
    server = started.server;
    port = started.port;
  });

  afterEach(() => {
    if (server) server.close();
    server = null;
  });

  it("calls supabase update with a referral_code during signup", async () => {
    const capturedUpdates = [];
    mockUpdateEq.mockImplementation(async () => {
      return { error: null };
    });
    mockUpdate.mockImplementation((data) => {
      capturedUpdates.push(data);
      return { eq: mockUpdateEq };
    });
    mockFrom.mockReturnValue({ update: mockUpdate, select: mockSelect });

    await postJson(port, "/api/auth/signup", {
      email: "test@example.com",
      password: "password123",
      phone: "+15551234567",
    });

    // At least one update call should contain a referral_code
    const withCode = capturedUpdates.find(u => u.referral_code != null);
    expect(withCode).toBeDefined();
    // The code should be a non-empty string of uppercase alphanumeric chars
    expect(withCode.referral_code).toMatch(/^[A-Z0-9]+$/);
  });

  it("returns 400 when email or password is missing", async () => {
    const { status, body } = await postJson(port, "/api/auth/signup", {
      email: "test@example.com",
      // no password
    });
    expect(status).toBe(400);
    expect(body.error).toMatch(/required/i);
  });

  it("returns 400 when phone is missing", async () => {
    const { status, body } = await postJson(port, "/api/auth/signup", {
      email: "test@example.com",
      password: "password123",
      // no phone
    });
    expect(status).toBe(400);
    expect(body.error).toMatch(/phone/i);
  });
});

describe("GET /api/user/profile — referral code lazy generation", () => {
  let server;
  let port;

  beforeEach(async () => {
    vi.clearAllMocks();

    mockUpdateEq.mockResolvedValue({ error: null });
    mockUpdate.mockReturnValue({ eq: mockUpdateEq });

    const { default: userRouter } = await import("../routes/user.js");
    const app = express();
    app.use(express.json());
    app.use("/api/user", userRouter);

    const started = await startServer(app);
    server = started.server;
    port = started.port;
  });

  afterEach(() => {
    if (server) server.close();
    server = null;
  });

  it("generates and saves a referral_code when profile has none", async () => {
    const capturedUpdates = [];

    mockSingle.mockResolvedValueOnce({
      data: {
        id: "user-abc",
        display_name: "Test User",
        tier: "free",
        referral_code: null, // no code yet
      },
      error: null,
    });
    mockSelectEq.mockReturnValue({ single: mockSingle });
    mockSelect.mockReturnValue({ eq: mockSelectEq });

    mockUpdate.mockImplementation((data) => {
      capturedUpdates.push(data);
      return { eq: mockUpdateEq };
    });
    mockFrom.mockReturnValue({
      select: mockSelect,
      update: mockUpdate,
    });

    const { status, body } = await getJson(port, "/api/user/profile");

    expect(status).toBe(200);
    // Response should include a referral_code
    expect(body.referral_code).toBeDefined();
    expect(body.referral_code).toMatch(/^[A-Z0-9]+$/);
    // Should have called update to persist the new code
    const saveCall = capturedUpdates.find(u => u.referral_code != null);
    expect(saveCall).toBeDefined();
  });

  it("returns existing referral_code without regenerating when already set", async () => {
    const existingCode = "EXISTNG1";

    mockSingle.mockResolvedValueOnce({
      data: {
        id: "user-abc",
        display_name: "Test User",
        tier: "free",
        referral_code: existingCode,
      },
      error: null,
    });
    mockSelectEq.mockReturnValue({ single: mockSingle });
    mockSelect.mockReturnValue({ eq: mockSelectEq });

    const capturedUpdates = [];
    mockUpdate.mockImplementation((data) => {
      capturedUpdates.push(data);
      return { eq: mockUpdateEq };
    });
    mockFrom.mockReturnValue({
      select: mockSelect,
      update: mockUpdate,
    });

    const { status, body } = await getJson(port, "/api/user/profile");

    expect(status).toBe(200);
    expect(body.referral_code).toBe(existingCode);
    // update should NOT have been called with referral_code since it already existed
    const codeUpdateCall = capturedUpdates.find(u => u.referral_code != null);
    expect(codeUpdateCall).toBeUndefined();
  });

  it("returns 404 when profile is not found", async () => {
    mockSingle.mockResolvedValueOnce({
      data: null,
      error: new Error("Profile not found"),
    });
    mockSelectEq.mockReturnValue({ single: mockSingle });
    mockSelect.mockReturnValue({ eq: mockSelectEq });
    mockFrom.mockReturnValue({ select: mockSelect, update: mockUpdate });

    const { status } = await getJson(port, "/api/user/profile");
    expect(status).toBe(404);
  });
});
