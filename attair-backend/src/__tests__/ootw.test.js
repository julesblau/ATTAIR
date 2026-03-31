/**
 * Tests for Outfit of the Week (OOTW) feature.
 *
 * Covers:
 *   A. getCurrentWeekMonday() — correct Monday calculation for various days
 *   B. generateOutfitOfTheWeek() — trending scan selection, idempotency, fallback editorial
 *   C. sendWeeklyStyleReports() — Pro-only targeting, personalization, idempotency per user/week
 *   D. GET /api/ootw/current — returns enriched data, increments view count, requires auth
 *   E. POST /api/ootw/generate — rejects without cron key in production, succeeds with key
 *   F. POST /api/ootw/weekly-reports — rejects without cron key in production, succeeds with key
 *   G. GET /api/ootw/:id — returns specific OOTW, validates UUID, 404 for missing
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import { createServer } from "http";

// ─── Auth mock ─────────────────────────────────────────────────────────────

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

// ─── Notifications mock ────────────────────────────────────────────────────

const mockSendNotification = vi.fn().mockResolvedValue(undefined);
vi.mock("../services/notifications.js", () => ({
  sendNotification: (...args) => mockSendNotification(...args),
}));

// ─── Supabase mock ─────────────────────────────────────────────────────────

// Shared mock state — tests control what each table query returns
let mockOotwData = null;
let mockOotwInsertResult = null;
let mockScansData = [];
let mockProfilesData = [];
let mockSaveRowsData = [];
let mockProUsersData = [];
let mockWeeklyReportExists = null;
let mockSavedItemsData = [];
let mockCandidateScansData = [];

// Track calls for assertions
let insertedRows = [];
let updatedRows = [];

vi.mock("../lib/supabase.js", () => {
  const mockFrom = vi.fn().mockImplementation((table) => {
    if (table === "outfit_of_the_week") {
      return {
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            maybeSingle: vi.fn(async () => ({ data: mockOotwData, error: null })),
            single: vi.fn(async () => {
              if (mockOotwData) return { data: mockOotwData, error: null };
              return { data: null, error: { message: "Not found" } };
            }),
          }),
        }),
        insert: vi.fn().mockImplementation((row) => {
          insertedRows.push({ table, ...row });
          const result = mockOotwInsertResult || { ...row, id: "ootw-gen-1", view_count: 0, generated_at: new Date().toISOString() };
          return {
            select: vi.fn().mockReturnValue({
              single: vi.fn(async () => ({ data: result, error: null })),
            }),
          };
        }),
        update: vi.fn().mockImplementation((data) => {
          updatedRows.push({ table, ...data });
          return {
            eq: vi.fn().mockReturnValue(
              Promise.resolve({ error: null })
            ),
          };
        }),
      };
    }

    if (table === "scans") {
      const candidateChain = {
        not: vi.fn().mockReturnValue({
          gte: vi.fn().mockReturnValue({
            order: vi.fn().mockReturnValue({
              limit: vi.fn(async () => ({ data: mockCandidateScansData, error: null })),
            }),
          }),
        }),
      };
      return {
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            not: vi.fn().mockReturnValue({
              gte: vi.fn().mockReturnValue({
                order: vi.fn().mockReturnValue({
                  limit: vi.fn(async () => ({ data: mockScansData, error: null })),
                }),
              }),
            }),
            // pickPersonalizedLooks: .eq("visibility").neq("user_id").not(...).gte(...).order(...).limit(...)
            neq: vi.fn().mockReturnValue(candidateChain),
          }),
          in: vi.fn(async () => ({ data: mockScansData, error: null })),
          neq: vi.fn().mockReturnValue(candidateChain),
        }),
      };
    }

    if (table === "saved_items") {
      return {
        select: vi.fn().mockReturnValue({
          in: vi.fn(async () => ({ data: mockSaveRowsData, error: null })),
          eq: vi.fn().mockReturnValue({
            order: vi.fn().mockReturnValue({
              limit: vi.fn(async () => ({ data: mockSavedItemsData, error: null })),
            }),
          }),
        }),
      };
    }

    if (table === "profiles") {
      return {
        select: vi.fn().mockReturnValue({
          in: vi.fn(async () => ({ data: mockProfilesData, error: null })),
          or: vi.fn(async () => ({ data: mockProUsersData, error: null })),
        }),
      };
    }

    if (table === "weekly_style_reports") {
      return {
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              maybeSingle: vi.fn(async () => ({ data: mockWeeklyReportExists, error: null })),
            }),
          }),
        }),
        insert: vi.fn().mockImplementation((row) => {
          insertedRows.push({ table, ...row });
          return Promise.resolve({ error: null });
        }),
      };
    }

    // Fallback
    return {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      in: vi.fn(async () => ({ data: [], error: null })),
    };
  });

  return { default: { from: mockFrom } };
});

// ─── Server helpers ────────────────────────────────────────────────────────

async function makeApp() {
  const { default: ootwRouter } = await import("../routes/ootw.js");
  const app = express();
  app.use(express.json());
  app.use("/api/ootw", ootwRouter);
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

async function post(port, path, body = {}, extraHeaders = {}) {
  const headers = { "content-type": "application/json", ...extraHeaders };
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  let json;
  try { json = await res.json(); } catch { json = null; }
  return { status: res.status, body: json };
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function makeScan(id, overrides = {}) {
  return {
    id: id || `scan-${Math.random().toString(36).slice(2, 8)}`,
    user_id: "user-1",
    image_url: `https://img.test/${id}.jpg`,
    summary: "A cool outfit",
    items: [
      { name: "Jacket", category: "outerwear", subcategory: "bomber", brand: "Nike", style_keywords: ["streetwear"] },
      { name: "Jeans", category: "bottoms", subcategory: "denim", brand: "Levi's", style_keywords: ["casual"] },
    ],
    created_at: new Date().toISOString(),
    visibility: "public",
    ...overrides,
  };
}

// ─── Tests: getCurrentWeekMonday ───────────────────────────────────────────

describe("getCurrentWeekMonday", () => {
  let getCurrentWeekMonday;

  beforeEach(async () => {
    const mod = await import("../jobs/outfitOfTheWeek.js");
    getCurrentWeekMonday = mod.getCurrentWeekMonday;
  });

  it("returns Monday for a Monday date", () => {
    // 2026-03-30 is a Monday
    expect(getCurrentWeekMonday(new Date("2026-03-30T12:00:00Z"))).toBe("2026-03-30");
  });

  it("returns Monday for a Wednesday date", () => {
    // 2026-04-01 is a Wednesday → Monday is 2026-03-30
    expect(getCurrentWeekMonday(new Date("2026-04-01T12:00:00Z"))).toBe("2026-03-30");
  });

  it("returns Monday for a Sunday date", () => {
    // 2026-04-05 is a Sunday → Monday is 2026-03-30
    expect(getCurrentWeekMonday(new Date("2026-04-05T12:00:00Z"))).toBe("2026-03-30");
  });

  it("returns Monday for a Saturday date", () => {
    // 2026-04-04 is a Saturday → Monday is 2026-03-30
    expect(getCurrentWeekMonday(new Date("2026-04-04T12:00:00Z"))).toBe("2026-03-30");
  });

  it("defaults to current date when no argument", () => {
    const result = getCurrentWeekMonday();
    // Should return a valid date string in YYYY-MM-DD format
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

// ─── Tests: generateOutfitOfTheWeek ────────────────────────────────────────

describe("generateOutfitOfTheWeek", () => {
  let generateOutfitOfTheWeek;

  beforeEach(async () => {
    vi.clearAllMocks();
    insertedRows = [];
    updatedRows = [];
    mockOotwData = null;
    mockOotwInsertResult = null;
    mockScansData = [];
    mockSaveRowsData = [];

    const mod = await import("../jobs/outfitOfTheWeek.js");
    generateOutfitOfTheWeek = mod.generateOutfitOfTheWeek;
  });

  it("returns existing OOTW without creating a duplicate (idempotency)", async () => {
    mockOotwData = {
      id: "ootw-existing",
      week_start: "2026-03-30",
      headline: "Already Generated",
      editorial: "This already exists.",
      scan_ids: ["scan-1"],
    };

    const result = await generateOutfitOfTheWeek();
    expect(result.created).toBe(false);
    expect(result.ootw.id).toBe("ootw-existing");
    // Should NOT have inserted anything
    expect(insertedRows.filter(r => r.table === "outfit_of_the_week")).toHaveLength(0);
  });

  it("creates OOTW when none exists for the week", async () => {
    mockOotwData = null; // No existing OOTW
    mockScansData = Array.from({ length: 12 }, (_, i) =>
      makeScan(`scan-${i}`, {
        created_at: new Date(Date.now() - i * 3600000).toISOString(),
      })
    );
    mockSaveRowsData = [
      { scan_id: "scan-0" }, { scan_id: "scan-0" }, { scan_id: "scan-0" },
      { scan_id: "scan-1" }, { scan_id: "scan-1" },
      { scan_id: "scan-2" },
    ];

    const result = await generateOutfitOfTheWeek();
    expect(result.created).toBe(true);
    expect(result.ootw).toBeDefined();
    // Should have inserted into outfit_of_the_week
    const ootwInserts = insertedRows.filter(r => r.table === "outfit_of_the_week");
    expect(ootwInserts.length).toBe(1);
    expect(ootwInserts[0].scan_ids).toHaveLength(10); // top 10 of 12
  });

  it("uses fallback editorial when ANTHROPIC_API_KEY is not set", async () => {
    // Ensure no API key
    const original = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;

    mockOotwData = null;
    mockScansData = Array.from({ length: 5 }, (_, i) =>
      makeScan(`scan-fb-${i}`, { created_at: new Date(Date.now() - i * 3600000).toISOString() })
    );
    mockSaveRowsData = [];

    const result = await generateOutfitOfTheWeek();
    expect(result.created).toBe(true);
    // Fallback editorial content
    const insert = insertedRows.find(r => r.table === "outfit_of_the_week");
    expect(insert.headline).toBe("This Week's Top Looks");
    expect(insert.editorial).toContain("community brought the heat");

    // Restore
    if (original) process.env.ANTHROPIC_API_KEY = original;
  });

  it("returns no_scans reason when pool is empty", async () => {
    mockOotwData = null;
    mockScansData = [];

    const result = await generateOutfitOfTheWeek();
    expect(result.created).toBe(false);
    expect(result.reason).toBe("no_scans");
  });

  it("picks cover_image from the top-ranked scan", async () => {
    mockOotwData = null;
    mockScansData = [
      makeScan("scan-top", { image_url: "https://img.test/top.jpg", created_at: new Date().toISOString() }),
      makeScan("scan-second", { image_url: "https://img.test/second.jpg", created_at: new Date(Date.now() - 86400000).toISOString() }),
    ];
    mockSaveRowsData = [
      { scan_id: "scan-top" }, { scan_id: "scan-top" }, { scan_id: "scan-top" },
    ];

    await generateOutfitOfTheWeek();
    const insert = insertedRows.find(r => r.table === "outfit_of_the_week");
    expect(insert.cover_image).toBe("https://img.test/top.jpg");
  });
});

// ─── Tests: sendWeeklyStyleReports ─────────────────────────────────────────

describe("sendWeeklyStyleReports", () => {
  let sendWeeklyStyleReports;

  beforeEach(async () => {
    vi.clearAllMocks();
    insertedRows = [];
    mockOotwData = null;
    mockProUsersData = [];
    mockWeeklyReportExists = null;
    mockSavedItemsData = [];
    mockCandidateScansData = [];
    mockSendNotification.mockResolvedValue(undefined);

    const mod = await import("../jobs/outfitOfTheWeek.js");
    sendWeeklyStyleReports = mod.sendWeeklyStyleReports;
  });

  it("sends reports only to Pro users", async () => {
    mockOotwData = { scan_ids: ["scan-t1", "scan-t2", "scan-t3"] };
    mockProUsersData = [
      { id: "pro-user-1", display_name: "Pro One" },
      { id: "pro-user-2", display_name: "Pro Two" },
    ];
    mockWeeklyReportExists = null; // No existing reports
    mockSavedItemsData = []; // No personalization data — falls back to trending

    const result = await sendWeeklyStyleReports();
    expect(result.sent).toBe(2);
    expect(result.skipped).toBe(0);
    expect(mockSendNotification).toHaveBeenCalledTimes(2);
    // Verify notification type is "weekly_style_report"
    expect(mockSendNotification).toHaveBeenCalledWith(
      "pro-user-1",
      "weekly_style_report",
      "Your Weekly Style Report",
      expect.any(String),
      expect.objectContaining({ type: "weekly_style_report" })
    );
  });

  it("skips users who already received report this week (idempotency)", async () => {
    mockOotwData = { scan_ids: ["scan-t1"] };
    mockProUsersData = [{ id: "pro-already-sent", display_name: "Already Sent" }];
    mockWeeklyReportExists = { id: "existing-report-id" }; // Already sent

    const result = await sendWeeklyStyleReports();
    expect(result.skipped).toBe(1);
    expect(result.sent).toBe(0);
    expect(mockSendNotification).not.toHaveBeenCalled();
  });

  it("returns empty summary when no Pro users exist", async () => {
    mockOotwData = { scan_ids: [] };
    mockProUsersData = [];

    const result = await sendWeeklyStyleReports();
    expect(result.sent).toBe(0);
    expect(result.skipped).toBe(0);
    expect(mockSendNotification).not.toHaveBeenCalled();
  });

  it("records report in weekly_style_reports table", async () => {
    mockOotwData = { scan_ids: ["scan-t1", "scan-t2", "scan-t3"] };
    mockProUsersData = [{ id: "pro-user-record", display_name: "Recorder" }];
    mockWeeklyReportExists = null;
    mockSavedItemsData = [];

    await sendWeeklyStyleReports();
    const reportInserts = insertedRows.filter(r => r.table === "weekly_style_reports");
    expect(reportInserts.length).toBe(1);
    expect(reportInserts[0].user_id).toBe("pro-user-record");
    expect(reportInserts[0].scan_ids).toBeDefined();
  });
});

// ─── Tests: pickPersonalizedLooks ─────────────────────────────────────────

describe("pickPersonalizedLooks", () => {
  let pickPersonalizedLooks;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockSavedItemsData = [];
    mockCandidateScansData = [];

    const mod = await import("../jobs/outfitOfTheWeek.js");
    pickPersonalizedLooks = mod.pickPersonalizedLooks;
  });

  it("falls back to top trending when user has no saved items", async () => {
    mockSavedItemsData = []; // No saved items — no personalization signal

    const result = await pickPersonalizedLooks("user-no-saves", ["t1", "t2", "t3", "t4"]);
    expect(result).toEqual(["t1", "t2", "t3"]);
  });

  it("scores candidates by category/subcategory/style_keyword matching", async () => {
    // User has saved streetwear outerwear items
    mockSavedItemsData = [
      { item_data: { category: "outerwear", subcategory: "bomber", style_keywords: ["streetwear", "urban"] } },
      { item_data: { category: "bottoms", subcategory: "joggers", style_keywords: ["athleisure"] } },
    ];

    // Candidate scans with varying match levels
    mockCandidateScansData = [
      {
        id: "scan-best",
        items: [
          { category: "outerwear", subcategory: "bomber", style_keywords: ["streetwear"] }, // cat:2 + subcat:3 + kw:2 = 7
          { category: "bottoms", subcategory: "joggers", style_keywords: ["athleisure"] },  // cat:2 + subcat:3 + kw:2 = 7
        ],
        summary: "Perfect match scan",
        created_at: new Date().toISOString(),
      },
      {
        id: "scan-mid",
        items: [
          { category: "outerwear", subcategory: "parka", style_keywords: ["minimal"] }, // cat:2 only
        ],
        summary: "Partial match scan",
        created_at: new Date().toISOString(),
      },
      {
        id: "scan-low",
        items: [
          { category: "accessories", subcategory: "hats", style_keywords: ["preppy"] }, // 0 match
        ],
        summary: "No match scan",
        created_at: new Date().toISOString(),
      },
      {
        id: "scan-good",
        items: [
          { category: "outerwear", subcategory: "bomber", style_keywords: ["urban"] }, // cat:2 + subcat:3 + kw:2 = 7
        ],
        summary: "Good match scan",
        created_at: new Date().toISOString(),
      },
    ];

    const result = await pickPersonalizedLooks("user-styled", ["t1", "t2", "t3"]);

    // Should pick top 3 by score: scan-best (14), scan-good (7), scan-mid (2)
    expect(result).toHaveLength(3);
    expect(result[0]).toBe("scan-best");
    // scan-good and scan-mid should be in there (both have score > 0)
    expect(result).toContain("scan-good");
    expect(result).toContain("scan-mid");
    // scan-low has 0 match score, should NOT be included
    expect(result).not.toContain("scan-low");
  });

  it("fills remaining slots from trending when fewer than 3 matches", async () => {
    mockSavedItemsData = [
      { item_data: { category: "outerwear", subcategory: "bomber", style_keywords: ["streetwear"] } },
    ];

    // 3+ candidates but only 1 with a style match
    mockCandidateScansData = [
      {
        id: "scan-match",
        items: [{ category: "outerwear", subcategory: "bomber", style_keywords: ["streetwear"] }],
        summary: "Match",
        created_at: new Date().toISOString(),
      },
      {
        id: "scan-nomatch",
        items: [{ category: "accessories", subcategory: "rings", style_keywords: ["glam"] }],
        summary: "No match",
        created_at: new Date().toISOString(),
      },
      {
        id: "scan-nomatch2",
        items: [{ category: "jewelry", subcategory: "necklace", style_keywords: ["boho"] }],
        summary: "No match either",
        created_at: new Date().toISOString(),
      },
    ];

    const result = await pickPersonalizedLooks("user-partial", ["t1", "t2", "t3"]);

    expect(result).toHaveLength(3);
    expect(result[0]).toBe("scan-match"); // personalized pick
    // Remaining 2 filled from trending
    expect(result).toContain("t1");
    expect(result).toContain("t2");
  });
});

// ─── Tests: Routes ─────────────────────────────────────────────────────────

describe("OOTW Routes", () => {
  let server;
  let port;

  beforeEach(async () => {
    vi.clearAllMocks();
    insertedRows = [];
    updatedRows = [];
    mockOotwData = null;
    mockScansData = [];
    mockProfilesData = [];
    mockSaveRowsData = [];

    const app = await makeApp();
    const started = await startServer(app);
    server = started.server;
    port = started.port;
  });

  afterEach(() => server?.close());

  // ─── GET /api/ootw/current ─────────────────────────────────────────────

  describe("GET /api/ootw/current", () => {
    it("requires auth — returns 401 without token", async () => {
      const { status } = await get(port, "/api/ootw/current", false);
      expect(status).toBe(401);
    });

    it("returns null OOTW when none exists for the week", async () => {
      mockOotwData = null;
      const { status, body } = await get(port, "/api/ootw/current");
      expect(status).toBe(200);
      expect(body.ootw).toBeNull();
    });

    it("returns enriched OOTW data with scans", async () => {
      mockOotwData = {
        id: "ootw-1",
        week_start: "2026-03-30",
        headline: "Test Headline",
        editorial: "Test editorial text.",
        cover_image: "https://img.test/cover.jpg",
        view_count: 42,
        generated_at: "2026-03-30T06:00:00Z",
        scan_ids: ["scan-a", "scan-b"],
      };
      mockScansData = [
        makeScan("scan-a", { user_id: "user-a" }),
        makeScan("scan-b", { user_id: "user-b" }),
      ];
      mockProfilesData = [
        { id: "user-a", display_name: "Alice", avatar_url: null },
        { id: "user-b", display_name: "Bob", avatar_url: null },
      ];
      mockSaveRowsData = [{ scan_id: "scan-a" }, { scan_id: "scan-a" }];

      const { status, body } = await get(port, "/api/ootw/current");
      expect(status).toBe(200);
      expect(body.ootw).toBeDefined();
      expect(body.ootw.headline).toBe("Test Headline");
      expect(body.ootw.editorial).toBe("Test editorial text.");
      expect(body.ootw.scans).toHaveLength(2);
      // First scan should have save_count = 2
      expect(body.ootw.scans[0].save_count).toBe(2);
      // Second scan should have save_count = 0
      expect(body.ootw.scans[1].save_count).toBe(0);
      // User enrichment
      expect(body.ootw.scans[0].user.display_name).toBe("Alice");
    });

    it("increments view count", async () => {
      mockOotwData = {
        id: "ootw-views",
        week_start: "2026-03-30",
        headline: "Views Test",
        editorial: "Testing views.",
        cover_image: null,
        view_count: 10,
        generated_at: "2026-03-30T06:00:00Z",
        scan_ids: [],
      };

      await get(port, "/api/ootw/current");
      // Give the non-blocking update a moment
      await new Promise(r => setTimeout(r, 50));
      expect(updatedRows.some(r => r.table === "outfit_of_the_week" && r.view_count === 11)).toBe(true);
    });
  });

  // ─── GET /api/ootw/:id ────────────────────────────────────────────────

  describe("GET /api/ootw/:id", () => {
    it("requires auth — returns 401 without token", async () => {
      const { status } = await get(port, "/api/ootw/00000000-0000-0000-0000-000000000000", false);
      expect(status).toBe(401);
    });

    it("returns 400 for invalid UUID format", async () => {
      const { status, body } = await get(port, "/api/ootw/not-a-uuid");
      expect(status).toBe(400);
      expect(body.error).toBe("Invalid ID");
    });

    it("returns 404 when OOTW not found", async () => {
      mockOotwData = null;
      const { status } = await get(port, "/api/ootw/00000000-0000-0000-0000-000000000000");
      expect(status).toBe(404);
    });

    it("returns OOTW when found", async () => {
      mockOotwData = {
        id: "00000000-0000-0000-0000-000000000001",
        week_start: "2026-03-30",
        headline: "Found It",
        editorial: "Here it is.",
      };
      const { status, body } = await get(port, "/api/ootw/00000000-0000-0000-0000-000000000001");
      expect(status).toBe(200);
      expect(body.ootw.headline).toBe("Found It");
    });
  });

  // ─── POST /api/ootw/generate ──────────────────────────────────────────

  describe("POST /api/ootw/generate", () => {
    it("rejects without cron key in production", async () => {
      const origEnv = process.env.NODE_ENV;
      const origKey = process.env.CRON_SECRET_KEY;
      process.env.NODE_ENV = "production";
      process.env.CRON_SECRET_KEY = "real-secret";

      const { status, body } = await post(port, "/api/ootw/generate");
      expect(status).toBe(403);
      expect(body.error).toBe("Unauthorized");

      process.env.NODE_ENV = origEnv;
      if (origKey) process.env.CRON_SECRET_KEY = origKey;
      else delete process.env.CRON_SECRET_KEY;
    });

    it("rejects with wrong cron key in production", async () => {
      const origEnv = process.env.NODE_ENV;
      const origKey = process.env.CRON_SECRET_KEY;
      process.env.NODE_ENV = "production";
      process.env.CRON_SECRET_KEY = "correct-key";

      const { status } = await post(port, "/api/ootw/generate", {}, { "x-cron-key": "wrong-key" });
      expect(status).toBe(403);

      process.env.NODE_ENV = origEnv;
      if (origKey) process.env.CRON_SECRET_KEY = origKey;
      else delete process.env.CRON_SECRET_KEY;
    });

    it("succeeds with correct cron key in production", async () => {
      const origEnv = process.env.NODE_ENV;
      const origKey = process.env.CRON_SECRET_KEY;
      process.env.NODE_ENV = "production";
      process.env.CRON_SECRET_KEY = "my-secret";

      // Set up existing OOTW so generate returns quickly (idempotent)
      mockOotwData = { id: "ootw-cron", week_start: "2026-03-30", headline: "Cron", editorial: "Works." };

      const { status, body } = await post(port, "/api/ootw/generate", {}, { "x-cron-key": "my-secret" });
      expect(status).toBe(200);
      expect(body.created).toBe(false);

      process.env.NODE_ENV = origEnv;
      if (origKey) process.env.CRON_SECRET_KEY = origKey;
      else delete process.env.CRON_SECRET_KEY;
    });

    it("succeeds without cron key in non-production", async () => {
      const origEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = "development";

      mockOotwData = { id: "ootw-dev", week_start: "2026-03-30", headline: "Dev", editorial: "Dev mode." };

      const { status, body } = await post(port, "/api/ootw/generate");
      expect(status).toBe(200);

      process.env.NODE_ENV = origEnv;
    });
  });

  // ─── POST /api/ootw/weekly-reports ────────────────────────────────────

  describe("POST /api/ootw/weekly-reports", () => {
    it("rejects without cron key in production", async () => {
      const origEnv = process.env.NODE_ENV;
      const origKey = process.env.CRON_SECRET_KEY;
      process.env.NODE_ENV = "production";
      process.env.CRON_SECRET_KEY = "real-secret";

      const { status, body } = await post(port, "/api/ootw/weekly-reports");
      expect(status).toBe(403);
      expect(body.error).toBe("Unauthorized");

      process.env.NODE_ENV = origEnv;
      if (origKey) process.env.CRON_SECRET_KEY = origKey;
      else delete process.env.CRON_SECRET_KEY;
    });

    it("succeeds with correct cron key in production", async () => {
      const origEnv = process.env.NODE_ENV;
      const origKey = process.env.CRON_SECRET_KEY;
      process.env.NODE_ENV = "production";
      process.env.CRON_SECRET_KEY = "report-secret";

      mockOotwData = { scan_ids: [] };
      mockProUsersData = [];

      const { status, body } = await post(port, "/api/ootw/weekly-reports", {}, { "x-cron-key": "report-secret" });
      expect(status).toBe(200);
      expect(body.sent).toBe(0);

      process.env.NODE_ENV = origEnv;
      if (origKey) process.env.CRON_SECRET_KEY = origKey;
      else delete process.env.CRON_SECRET_KEY;
    });

    it("succeeds without cron key in non-production", async () => {
      const origEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = "development";

      mockOotwData = { scan_ids: [] };
      mockProUsersData = [];

      const { status, body } = await post(port, "/api/ootw/weekly-reports");
      expect(status).toBe(200);

      process.env.NODE_ENV = origEnv;
    });
  });
});
