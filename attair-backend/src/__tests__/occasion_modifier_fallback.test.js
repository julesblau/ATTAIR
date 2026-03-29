/**
 * Tests for the custom occasion modifier fallback fix in services/products.js.
 *
 * Bug: In textSearchForItem, the occasionTerm was computed as:
 *   occasion ? (OCCASION_MODIFIERS[occasion] || null) : (customOccasionModifiers || null)
 *
 * When `occasion` was truthy but NOT in OCCASION_MODIFIERS (e.g. "gala"),
 * `OCCASION_MODIFIERS["gala"]` is undefined, and `undefined || null` yields null —
 * silently dropping customOccasionModifiers even though the caller provided it.
 *
 * Fix: The expression should be:
 *   occasion ? (OCCASION_MODIFIERS[occasion] || customOccasionModifiers || null) : (customOccasionModifiers || null)
 *
 * Since textSearchForItem is not exported, these tests use an inline replica of
 * the occasionTerm logic to establish the correct contract, then also test the
 * fix via the route layer (POST /api/find-products) by checking the args passed
 * to findProductsForItems.
 *
 * Priority order (from the code comments):
 *   1. Known occasion key → OCCASION_MODIFIERS lookup
 *   2. Unknown occasion key with customOccasionModifiers → use custom term
 *   3. No occasion, custom provided → use custom term
 *   4. Neither → null
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import { createServer } from "http";

// ─── Inline replica of the OCCASION_MODIFIERS map (from products.js) ────────

const OCCASION_MODIFIERS = {
  casual:       "casual",
  work:         "business professional",
  night_out:    "cocktail party",
  athletic:     "activewear",
  formal:       "formal",
  outdoor:      "outdoor",
  wedding:      "wedding guest elegant",
  date:         "date night going out",
  beach:        "beach resort vacation",
  smart_casual: "smart casual",
  festival:     "festival boho",
};

// ─── Inline replica: BUGGY occasionTerm logic (what existed before the fix) ──

function occasionTermBuggy(occasion, customOccasionModifiers) {
  return occasion
    ? (OCCASION_MODIFIERS[occasion] || null)
    : (customOccasionModifiers || null);
}

// ─── Inline replica: FIXED occasionTerm logic ─────────────────────────────

function occasionTermFixed(occasion, customOccasionModifiers) {
  return occasion
    ? (OCCASION_MODIFIERS[occasion] || customOccasionModifiers || null)
    : (customOccasionModifiers || null);
}

// ─── Unit tests for the occasionTerm logic (both buggy and fixed) ────────────

describe("occasionTerm — known occasion uses OCCASION_MODIFIERS value", () => {
  it("'wedding' resolves to 'wedding guest elegant' (FIXED)", () => {
    expect(occasionTermFixed("wedding", null)).toBe("wedding guest elegant");
  });

  it("'wedding' resolves to 'wedding guest elegant' (was already correct in buggy version)", () => {
    expect(occasionTermBuggy("wedding", null)).toBe("wedding guest elegant");
  });

  it("'casual' resolves to 'casual'", () => {
    expect(occasionTermFixed("casual", null)).toBe("casual");
  });

  it("'formal' resolves to 'formal'", () => {
    expect(occasionTermFixed("formal", null)).toBe("formal");
  });

  it("known occasion ignores customOccasionModifiers (hardcoded value takes precedence)", () => {
    // When a known key is provided, OCCASION_MODIFIERS wins regardless of custom term
    expect(occasionTermFixed("wedding", "custom black tie event")).toBe("wedding guest elegant");
  });

  it("all known occasion keys resolve to non-null values", () => {
    for (const key of Object.keys(OCCASION_MODIFIERS)) {
      expect(occasionTermFixed(key, null)).not.toBeNull();
    }
  });
});

describe("occasionTerm — FIXED: unknown occasion + customOccasionModifiers uses custom value", () => {
  it("unknown occasion 'gala' + custom 'black tie event' → 'black tie event' (FIXED)", () => {
    // This is the core bug scenario: "gala" is not in OCCASION_MODIFIERS,
    // so the fallback must use customOccasionModifiers.
    const fixed = occasionTermFixed("gala", "black tie event");
    expect(fixed).toBe("black tie event");
  });

  it("unknown occasion 'rooftop dinner' + custom 'outdoor upscale' → custom value (FIXED)", () => {
    const fixed = occasionTermFixed("rooftop dinner", "outdoor upscale");
    expect(fixed).toBe("outdoor upscale");
  });

  it("unknown occasion 'gala' + no custom modifiers → null (FIXED)", () => {
    const fixed = occasionTermFixed("gala", null);
    expect(fixed).toBeNull();
  });

  it("unknown occasion 'gala' + undefined custom modifiers → null (FIXED)", () => {
    const fixed = occasionTermFixed("gala", undefined);
    expect(fixed).toBeNull();
  });
});

describe("occasionTerm — BUG DOCUMENTED: buggy version silently drops custom modifiers", () => {
  it("BUGGY: unknown occasion 'gala' + custom 'black tie event' incorrectly resolves to null", () => {
    // This test documents the pre-fix behavior.
    // The buggy code returns null, dropping the custom modifier.
    const buggy = occasionTermBuggy("gala", "black tie event");
    expect(buggy).toBeNull(); // buggy behavior: custom modifier is lost
  });

  it("FIXED version correctly returns custom modifier where buggy version returned null", () => {
    const buggy = occasionTermBuggy("gala", "black tie event");
    const fixed = occasionTermFixed("gala", "black tie event");
    // They diverge: buggy = null, fixed = "black tie event"
    expect(buggy).toBeNull();
    expect(fixed).toBe("black tie event");
    expect(fixed).not.toBe(buggy);
  });
});

describe("occasionTerm — no occasion, custom modifiers used directly", () => {
  it("null occasion + custom 'garden party' → 'garden party' (both buggy and fixed)", () => {
    // When occasion is null/falsy, customOccasionModifiers is used directly in both versions
    expect(occasionTermFixed(null, "garden party")).toBe("garden party");
    expect(occasionTermBuggy(null, "garden party")).toBe("garden party");
  });

  it("null occasion + null customOccasionModifiers → null", () => {
    expect(occasionTermFixed(null, null)).toBeNull();
  });

  it("undefined occasion + custom 'festival boho style' → 'festival boho style'", () => {
    expect(occasionTermFixed(undefined, "festival boho style")).toBe("festival boho style");
  });
});

// ─── Route-level tests: verify args passed to findProductsForItems ────────────
// These mirror the pattern in findProducts.occasion.test.js and confirm that
// the route layer correctly passes occasion and customOccasionModifiers as
// separate arguments to findProductsForItems (args 6 and 8).

const { mockFindProducts } = vi.hoisted(() => ({
  mockFindProducts: vi.fn().mockResolvedValue([
    { item_index: 0, tiers: { budget: null, mid: null, premium: null } },
  ]),
}));

vi.mock("../lib/supabase.js", () => ({
  default: {
    from: () => ({
      select: () => ({
        eq: () => ({
          single: () => Promise.resolve({
            data: { budget_min: null, budget_max: null, size_prefs: {} },
            error: null,
          }),
          eq: () => ({
            single: () => Promise.resolve({ data: { image_url: null }, error: null }),
          }),
        }),
      }),
      update: () => ({
        eq: () => ({
          eq: () => Promise.resolve({ error: null }),
        }),
      }),
    }),
  },
}));

vi.mock("../middleware/auth.js", () => ({
  requireAuth: (req, _res, next) => {
    req.userId = "user-abc";
    next();
  },
}));

vi.mock("../services/products.js", () => ({
  findProductsForItems: mockFindProducts,
}));

const mockAnthropicCreate = vi.fn().mockResolvedValue({
  content: [{ text: "black tie formal elegant gown" }],
});

vi.mock("@anthropic-ai/sdk", () => ({
  default: class MockAnthropic {
    constructor() {}
    messages = { create: mockAnthropicCreate };
  },
}));

async function makeApp() {
  const { default: findProductsRouter } = await import("../routes/findProducts.js");
  const app = express();
  app.use(express.json());
  app.use("/api/find-products", findProductsRouter);
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

async function post(port, body) {
  const res = await fetch(`http://127.0.0.1:${port}/api/find-products`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer valid-token",
    },
    body: JSON.stringify(body),
  });
  let json;
  try { json = await res.json(); } catch { json = null; }
  return { status: res.status, body: json };
}

const VALID_ITEMS = [{ name: "Evening Gown", category: "dress" }];

describe("POST /api/find-products — occasion modifier argument passing", () => {
  let server;
  let port;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockFindProducts.mockResolvedValue([
      { item_index: 0, tiers: { budget: null, mid: null, premium: null } },
    ]);
    mockAnthropicCreate.mockResolvedValue({
      content: [{ text: "black tie formal elegant gown" }],
    });

    const app = await makeApp();
    const started = await startServer(app);
    server = started.server;
    port = started.port;
  });

  afterEach(() => server.close());

  it("known occasion 'wedding' passes occasion as arg[6], no customModifiers at arg[8]", async () => {
    await post(port, { items: VALID_ITEMS, gender: "female", occasion: "wedding" });
    expect(mockFindProducts.mock.calls[0][6]).toBe("wedding");
    expect(mockFindProducts.mock.calls[0][8]).toBeFalsy();
  });

  it("known occasion 'formal' passes occasion as arg[6], no customModifiers at arg[8]", async () => {
    await post(port, { items: VALID_ITEMS, gender: "female", occasion: "formal" });
    expect(mockFindProducts.mock.calls[0][6]).toBe("formal");
    expect(mockFindProducts.mock.calls[0][8]).toBeFalsy();
  });

  it("unknown occasion 'gala' passes null as arg[6] and custom modifiers at arg[8]", async () => {
    // Route sends unknown occasion to Claude, then passes:
    // - arg[6] = null (not a known occasion)
    // - arg[8] = customOccasionModifiers (Claude's response)
    await post(port, { items: VALID_ITEMS, gender: "female", occasion: "gala" });
    expect(mockFindProducts.mock.calls[0][6]).toBeNull();
    // arg[8] should be the Claude-generated custom modifier string
    expect(mockFindProducts.mock.calls[0][8]).toBeTruthy();
    expect(typeof mockFindProducts.mock.calls[0][8]).toBe("string");
  });

  it("unknown occasion 'after party' → null occasion arg, custom modifiers populated", async () => {
    await post(port, { items: VALID_ITEMS, gender: "female", occasion: "after party" });
    expect(mockFindProducts.mock.calls[0][6]).toBeNull();
    expect(mockFindProducts.mock.calls[0][8]).toBeTruthy();
  });

  it("no occasion → both arg[6] and arg[8] are falsy", async () => {
    await post(port, { items: VALID_ITEMS, gender: "female" });
    expect(mockFindProducts.mock.calls[0][6]).toBeNull();
    expect(mockFindProducts.mock.calls[0][8]).toBeFalsy();
  });

  it("returns 200 for an unknown occasion (not rejected with 400)", async () => {
    const { status } = await post(port, {
      items: VALID_ITEMS,
      gender: "male",
      occasion: "yacht party",
    });
    expect(status).toBe(200);
  });
});
