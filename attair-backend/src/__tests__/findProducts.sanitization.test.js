/**
 * Tests for occasion sanitization in POST /api/find-products (routes/findProducts.js)
 *
 * The route sanitizes the raw occasion string before use:
 *   - trims whitespace
 *   - caps at 100 chars
 *   - strips all characters except a-z A-Z 0-9 space _ -
 *
 * Valid occasions from VALID_OCCASIONS pass through as-is.
 * Sanitized but unknown occasions go to Claude for custom modifiers.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import { createServer } from "http";

// ─── Mocks ────────────────────────────────────────────────────────────────

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

// Capture what occasion string was passed to Claude
let lastClaudeOccasion = null;

vi.mock("@anthropic-ai/sdk", () => ({
  default: class MockAnthropic {
    constructor() {}
    messages = {
      create: vi.fn().mockImplementation(async (opts) => {
        // Extract the occasion string from the prompt content
        const content = opts?.messages?.[0]?.content || "";
        const match = content.match(/for: '([^']+)'/);
        lastClaudeOccasion = match ? match[1] : null;
        return { content: [{ text: "stylish, modern, trendy" }] };
      }),
    };
  },
}));

// ─── Server helpers ───────────────────────────────────────────────────────

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

const VALID_ITEMS = [{ name: "T-Shirt", category: "top" }];

// ─── Tests ────────────────────────────────────────────────────────────────

describe("POST /api/find-products — occasion sanitization", () => {
  let server;
  let port;

  beforeEach(async () => {
    vi.clearAllMocks();
    lastClaudeOccasion = null;
    mockFindProducts.mockResolvedValue([
      { item_index: 0, tiers: { budget: null, mid: null, premium: null } },
    ]);
    const app = await makeApp();
    const started = await startServer(app);
    server = started.server;
    port = started.port;
  });

  afterEach(() => server.close());

  it("strips dangerous characters like < > & from occasion before passing to Claude", async () => {
    await post(port, {
      items: VALID_ITEMS,
      gender: "male",
      occasion: "<script>alert(1)</script>",
    });
    // The sanitized string should have had < > / stripped, leaving only safe chars
    // "scriptalert1script" or similar — importantly no angle brackets or slashes
    expect(lastClaudeOccasion).not.toBeNull();
    expect(lastClaudeOccasion).not.toContain("<");
    expect(lastClaudeOccasion).not.toContain(">");
    expect(lastClaudeOccasion).not.toContain("/");
    expect(lastClaudeOccasion).not.toContain("(");
    expect(lastClaudeOccasion).not.toContain(")");
  });

  it("strips SQL injection characters from occasion", async () => {
    await post(port, {
      items: VALID_ITEMS,
      gender: "male",
      occasion: "'; DROP TABLE users; --",
    });
    expect(lastClaudeOccasion).not.toBeNull();
    expect(lastClaudeOccasion).not.toContain("'");
    expect(lastClaudeOccasion).not.toContain(";");
  });

  it("caps occasion at 100 chars before passing to Claude", async () => {
    const longOccasion = "a".repeat(200);
    await post(port, {
      items: VALID_ITEMS,
      gender: "female",
      occasion: longOccasion,
    });
    // lastClaudeOccasion should be at most 100 chars
    if (lastClaudeOccasion !== null) {
      expect(lastClaudeOccasion.length).toBeLessThanOrEqual(100);
    }
  });

  it("allows underscores and hyphens in occasion (used in VALID_OCCASIONS)", async () => {
    // "night_out" is in VALID_OCCASIONS and should pass through to findProductsForItems
    await post(port, {
      items: VALID_ITEMS,
      gender: "male",
      occasion: "night_out",
    });
    expect(mockFindProducts).toHaveBeenCalledOnce();
    expect(mockFindProducts.mock.calls[0][6]).toBe("night_out");
  });

  it("passes valid occasion 'wedding' directly (no Claude call)", async () => {
    await post(port, {
      items: VALID_ITEMS,
      gender: "female",
      occasion: "wedding",
    });
    // Valid occasion → passes straight through, Claude is not called
    expect(lastClaudeOccasion).toBeNull();
    expect(mockFindProducts.mock.calls[0][6]).toBe("wedding");
  });

  it("all VALID_OCCASIONS pass through without going to Claude", async () => {
    const VALID_OCCASIONS = [
      "casual", "work", "night_out", "athletic", "formal", "outdoor",
      "wedding", "date", "beach", "smart_casual", "festival",
    ];

    for (const occ of VALID_OCCASIONS) {
      vi.clearAllMocks();
      lastClaudeOccasion = null;
      mockFindProducts.mockResolvedValue([
        { item_index: 0, tiers: { budget: null, mid: null, premium: null } },
      ]);

      const { status } = await post(port, {
        items: VALID_ITEMS,
        gender: "male",
        occasion: occ,
      });

      expect(status).toBe(200);
      expect(mockFindProducts.mock.calls[0][6]).toBe(occ);
      // Claude should NOT have been called for a known occasion
      expect(lastClaudeOccasion).toBeNull();
    }
  });
});
