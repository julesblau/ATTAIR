/**
 * Tests for Style Twins feature (routes/styleTwins.js)
 *
 * Covers:
 *   A. Euclidean distance computation correctness
 *   B. Match percentage conversion
 *   C. GET /api/style-twins requires auth (returns 401 without token)
 *   D. GET /api/style-twins returns not-ready when user has no Style DNA
 *   E. GET /api/style-twins returns twins sorted by match %
 *   F. GET /api/style-twins/shared-save-check requires auth
 *   G. POST /api/style-twins/weekly-notify rejects unauthorized calls in production
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import { createServer } from "http";

// ─── Unit tests for distance functions (no mocking needed) ────

// Import exported helpers directly
import { euclideanDistance, distanceToMatchPct } from "../routes/styleTwins.js";

describe("Euclidean distance computation", () => {
  it("returns 0 for identical style scores", () => {
    const a = { classic_vs_trendy: 5, minimal_vs_maximal: 5, casual_vs_formal: 5, budget_vs_luxury: 5 };
    const b = { ...a };
    expect(euclideanDistance(a, b)).toBe(0);
  });

  it("returns max distance (18) for opposite extremes", () => {
    const a = { classic_vs_trendy: 1, minimal_vs_maximal: 1, casual_vs_formal: 1, budget_vs_luxury: 1 };
    const b = { classic_vs_trendy: 10, minimal_vs_maximal: 10, casual_vs_formal: 10, budget_vs_luxury: 10 };
    expect(euclideanDistance(a, b)).toBe(18);
  });

  it("computes correct distance for single axis difference", () => {
    const a = { classic_vs_trendy: 3, minimal_vs_maximal: 5, casual_vs_formal: 5, budget_vs_luxury: 5 };
    const b = { classic_vs_trendy: 7, minimal_vs_maximal: 5, casual_vs_formal: 5, budget_vs_luxury: 5 };
    expect(euclideanDistance(a, b)).toBe(4); // sqrt(16) = 4
  });

  it("computes correct distance for multi-axis difference", () => {
    const a = { classic_vs_trendy: 2, minimal_vs_maximal: 3, casual_vs_formal: 4, budget_vs_luxury: 5 };
    const b = { classic_vs_trendy: 5, minimal_vs_maximal: 7, casual_vs_formal: 4, budget_vs_luxury: 8 };
    // diff: 3, 4, 0, 3 => 9 + 16 + 0 + 9 = 34 => sqrt(34) ≈ 5.831
    const dist = euclideanDistance(a, b);
    expect(dist).toBeCloseTo(Math.sqrt(34), 5);
  });

  it("defaults missing axes to 5 (neutral)", () => {
    const a = { classic_vs_trendy: 5 }; // missing 3 axes
    const b = { classic_vs_trendy: 5 }; // missing 3 axes
    expect(euclideanDistance(a, b)).toBe(0);
  });
});

describe("distanceToMatchPct", () => {
  it("returns 100 for zero distance", () => {
    expect(distanceToMatchPct(0)).toBe(100);
  });

  it("returns 0 for max distance (18)", () => {
    expect(distanceToMatchPct(18)).toBe(0);
  });

  it("returns 50 for half max distance", () => {
    expect(distanceToMatchPct(9)).toBe(50);
  });

  it("returns a value between 0 and 100 for typical distances", () => {
    const pct = distanceToMatchPct(4.5);
    expect(pct).toBeGreaterThan(0);
    expect(pct).toBeLessThan(100);
    expect(pct).toBe(75); // 1 - 4.5/18 = 0.75
  });

  it("never returns negative", () => {
    expect(distanceToMatchPct(100)).toBe(0);
  });
});

// ─── Route integration tests ────────────────────────────────

// Mock auth
vi.mock("../middleware/auth.js", () => ({
  requireAuth: (req, res, next) => {
    const auth = req.headers?.authorization;
    if (!auth || !auth.startsWith("Bearer ")) {
      return res.status(401).json({ error: "Missing or invalid token" });
    }
    req.userId = "user-me";
    next();
  },
  optionalAuth: (req, res, next) => {
    req.userId = null;
    next();
  },
}));

// Mock notification service
vi.mock("../services/notifications.js", () => ({
  sendNotification: vi.fn().mockResolvedValue(undefined),
}));

// Mock Supabase — configurable per test
let mockProfileData = null;
let mockCandidates = [];
let mockMySaves = [];
let mockTwinSaves = [];
let mockFollowRows = [];

vi.mock("../lib/supabase.js", () => {
  const buildChain = (finalData) => {
    const chain = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      neq: vi.fn().mockReturnThis(),
      not: vi.fn().mockReturnThis(),
      in: vi.fn().mockReturnThis(),
      single: vi.fn().mockImplementation(() => {
        return Promise.resolve({ data: mockProfileData, error: null });
      }),
      then: undefined,
    };
    // Make chain awaitable
    chain.eq.mockImplementation(() => {
      const inner = { ...chain };
      inner.eq = vi.fn().mockReturnValue({
        ...chain,
        single: vi.fn().mockResolvedValue({ data: mockProfileData, error: null }),
      });
      inner.single = vi.fn().mockResolvedValue({ data: mockProfileData, error: null });
      return inner;
    });
    return chain;
  };

  const mockFrom = vi.fn().mockImplementation((table) => {
    if (table === "profiles") {
      return {
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            single: vi.fn().mockResolvedValue({ data: mockProfileData, error: null }),
          }),
          neq: vi.fn().mockReturnValue({
            not: vi.fn().mockResolvedValue({ data: mockCandidates, error: null }),
          }),
        }),
      };
    }
    if (table === "saved_items") {
      return {
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            eq: vi.fn().mockResolvedValue({ data: mockTwinSaves, error: null }),
          }),
          in: vi.fn().mockReturnValue({
            eq: vi.fn().mockResolvedValue({ data: mockTwinSaves, error: null }),
          }),
        }),
      };
    }
    if (table === "follows") {
      return {
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            in: vi.fn().mockResolvedValue({ data: mockFollowRows, error: null }),
          }),
        }),
      };
    }
    return buildChain(null);
  });

  return { default: { from: mockFrom } };
});

// ─── Server helpers ─────────────────────────────────────────

async function makeApp() {
  const { default: styleTwinsRouter } = await import("../routes/styleTwins.js");
  const app = express();
  app.use(express.json());
  app.use("/api/style-twins", styleTwinsRouter);
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

async function request(port, method, path, body = null, withAuth = true, headers = {}) {
  const h = { "content-type": "application/json", ...headers };
  if (withAuth) h.authorization = "Bearer valid-token";

  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: h,
    body: body ? JSON.stringify(body) : undefined,
  });
  let json;
  try { json = await res.json(); } catch { json = null; }
  return { status: res.status, body: json };
}

// ─── Route tests ────────────────────────────────────────────

describe("GET /api/style-twins — auth", () => {
  let server;
  let port;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockProfileData = null;
    mockCandidates = [];
    const app = await makeApp();
    const started = await startServer(app);
    server = started.server;
    port = started.port;
  });

  afterEach(() => server.close());

  it("returns 401 without auth token", async () => {
    const { status } = await request(port, "GET", "/api/style-twins", null, false);
    expect(status).toBe(401);
  });

  it("returns not-ready when user has no Style DNA", async () => {
    mockProfileData = { style_dna_cache: null };
    const { status, body } = await request(port, "GET", "/api/style-twins");
    expect(status).toBe(200);
    expect(body.ready).toBe(false);
  });

  it("returns twins sorted by match percentage (highest first)", async () => {
    // Set up user's own profile with Style DNA
    const myScore = { classic_vs_trendy: 5, minimal_vs_maximal: 5, casual_vs_formal: 5, budget_vs_luxury: 5 };
    mockProfileData = {
      style_dna_cache: {
        ready: true,
        style_score: myScore,
        archetype: "Modern Classic",
        traits: ["Minimalist", "Chic"],
        stats: { dominant_colors: [{ value: "#000" }] },
      },
      display_name: "Me",
    };

    // Set up candidates with varying distances from the user
    // Closest twin: scores are [5,5,5,6] — distance ≈ 1 → ~94%
    // Middle twin: scores are [5,5,7,7] — distance ≈ 2.83 → ~84%
    // Farthest twin (still >50%): scores are [5,8,8,5] — distance ≈ 4.24 → ~76%
    // Below threshold (<50%): scores are [1,1,1,1] — distance ≈ 8 → ~56%... actually lets make it fail: [10,10,10,10] → distance=10 → ~44%
    mockCandidates = [
      {
        id: "twin-far",
        display_name: "Farthest",
        bio: "bio3",
        avatar_url: null,
        style_dna_cache: {
          ready: true,
          style_score: { classic_vs_trendy: 5, minimal_vs_maximal: 8, casual_vs_formal: 8, budget_vs_luxury: 5 },
          archetype: "Bold Explorer",
          traits: ["Bold"],
          stats: { dominant_colors: [{ value: "#f00" }] },
        },
      },
      {
        id: "twin-close",
        display_name: "Closest",
        bio: "bio1",
        avatar_url: null,
        style_dna_cache: {
          ready: true,
          style_score: { classic_vs_trendy: 5, minimal_vs_maximal: 5, casual_vs_formal: 5, budget_vs_luxury: 6 },
          archetype: "Modern Classic",
          traits: ["Minimalist"],
          stats: { dominant_colors: [{ value: "#111" }] },
        },
      },
      {
        id: "twin-mid",
        display_name: "Middle",
        bio: "bio2",
        avatar_url: null,
        style_dna_cache: {
          ready: true,
          style_score: { classic_vs_trendy: 5, minimal_vs_maximal: 5, casual_vs_formal: 7, budget_vs_luxury: 7 },
          archetype: "Refined Edge",
          traits: ["Refined"],
          stats: { dominant_colors: [{ value: "#222" }] },
        },
      },
      {
        id: "twin-excluded",
        display_name: "TooFar",
        bio: "bio4",
        avatar_url: null,
        style_dna_cache: {
          ready: true,
          style_score: { classic_vs_trendy: 10, minimal_vs_maximal: 10, casual_vs_formal: 10, budget_vs_luxury: 10 },
          archetype: "Wild Card",
          traits: ["Wild"],
          stats: { dominant_colors: [{ value: "#999" }] },
        },
      },
    ];

    mockTwinSaves = [];
    mockFollowRows = [];

    const { status, body } = await request(port, "GET", "/api/style-twins");
    expect(status).toBe(200);
    expect(body.ready).toBe(true);

    // Should exclude the too-far twin (<50% match)
    const twinIds = body.twins.map(t => t.id);
    expect(twinIds).not.toContain("twin-excluded");

    // Should have 3 twins
    expect(body.twins.length).toBe(3);

    // Must be sorted highest match first
    expect(body.twins[0].id).toBe("twin-close");
    expect(body.twins[1].id).toBe("twin-mid");
    expect(body.twins[2].id).toBe("twin-far");

    // Verify match percentages are descending
    for (let i = 1; i < body.twins.length; i++) {
      expect(body.twins[i - 1].match_pct).toBeGreaterThanOrEqual(body.twins[i].match_pct);
    }

    // Verify archetype is passed through
    expect(body.my_archetype).toBe("Modern Classic");
    expect(body.total_matches).toBe(3);
  });
});

describe("GET /api/style-twins/shared-save-check — auth", () => {
  let server;
  let port;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockProfileData = null;
    const app = await makeApp();
    const started = await startServer(app);
    server = started.server;
    port = started.port;
  });

  afterEach(() => server.close());

  it("returns 401 without auth token", async () => {
    const { status } = await request(port, "GET", "/api/style-twins/shared-save-check?item_name=test", null, false);
    expect(status).toBe(401);
  });

  it("returns match:false for empty item_name", async () => {
    const { body } = await request(port, "GET", "/api/style-twins/shared-save-check?item_name=");
    expect(body.match).toBe(false);
  });
});

describe("POST /api/style-twins/weekly-notify", () => {
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

  it("allows calls without cron key in non-production", async () => {
    // In test env (not production), the cron key check is skipped
    const { status } = await request(port, "POST", "/api/style-twins/weekly-notify", null, false);
    expect(status).not.toBe(401);
  });

  it("rejects unauthenticated calls in production mode", async () => {
    const originalEnv = process.env.NODE_ENV;
    const originalCronKey = process.env.CRON_SECRET_KEY;
    try {
      process.env.NODE_ENV = "production";
      process.env.CRON_SECRET_KEY = "real-secret-key";

      // No cron key header → should be rejected
      const { status: noKey } = await request(port, "POST", "/api/style-twins/weekly-notify", null, false);
      expect(noKey).toBe(401);

      // Wrong cron key → should also be rejected
      const { status: wrongKey } = await request(
        port, "POST", "/api/style-twins/weekly-notify", null, false,
        { "x-cron-key": "wrong-key" }
      );
      expect(wrongKey).toBe(401);

      // Correct cron key → should be allowed
      const { status: correctKey } = await request(
        port, "POST", "/api/style-twins/weekly-notify", null, false,
        { "x-cron-key": "real-secret-key" }
      );
      expect(correctKey).not.toBe(401);
    } finally {
      process.env.NODE_ENV = originalEnv;
      if (originalCronKey !== undefined) {
        process.env.CRON_SECRET_KEY = originalCronKey;
      } else {
        delete process.env.CRON_SECRET_KEY;
      }
    }
  });
});
