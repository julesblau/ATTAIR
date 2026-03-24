/**
 * Tests for the occasion allowlist in POST /api/find-products (routes/findProducts.js)
 *
 * Uses a real Express app + http.createServer.
 *
 * The route silently nulls out unrecognised occasion values (no 400).
 * We verify this by spying on findProductsForItems and checking the argument.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import { createServer } from "http";

// ─── Mocks ────────────────────────────────────────────────────────────────

// We need to be able to spy on findProductsForItems, so capture it via hoisting.
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
          single: () => Promise.resolve({ data: { budget_min: null, budget_max: null, size_prefs: {} }, error: null }),
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

describe("POST /api/find-products — occasion allowlist", () => {
  let server;
  let port;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockFindProducts.mockResolvedValue([
      { item_index: 0, tiers: { budget: null, mid: null, premium: null } },
    ]);

    const app = await makeApp();
    const started = await startServer(app);
    server = started.server;
    port = started.port;
  });

  afterEach(() => server.close());

  it("passes valid occasion 'casual' through to findProductsForItems", async () => {
    const { status } = await post(port, {
      items: VALID_ITEMS,
      gender: "male",
      occasion: "casual",
    });
    expect(status).toBe(200);
    expect(mockFindProducts).toHaveBeenCalledOnce();
    // occasion is the 7th argument (index 6) of findProductsForItems
    expect(mockFindProducts.mock.calls[0][6]).toBe("casual");
  });

  it("passes valid occasion 'formal' through to findProductsForItems", async () => {
    const { status } = await post(port, {
      items: VALID_ITEMS,
      gender: "female",
      occasion: "formal",
    });
    expect(status).toBe(200);
    expect(mockFindProducts.mock.calls[0][6]).toBe("formal");
  });

  it("does NOT return 400 for invalid occasion 'party'", async () => {
    const { status } = await post(port, {
      items: VALID_ITEMS,
      gender: "male",
      occasion: "party",
    });
    expect(status).not.toBe(400);
  });

  it("nulls out invalid occasion 'party' before calling findProductsForItems", async () => {
    await post(port, {
      items: VALID_ITEMS,
      gender: "male",
      occasion: "party",
    });
    expect(mockFindProducts).toHaveBeenCalledOnce();
    expect(mockFindProducts.mock.calls[0][6]).toBeNull();
  });

  it("nulls out unknown occasion 'underground_rave'", async () => {
    const { status } = await post(port, {
      items: VALID_ITEMS,
      gender: "female",
      occasion: "underground_rave",
    });
    expect(status).not.toBe(400);
    expect(mockFindProducts.mock.calls[0][6]).toBeNull();
  });

  it("passes null when no occasion is provided", async () => {
    const { status } = await post(port, { items: VALID_ITEMS, gender: "male" });
    expect(status).toBe(200);
    expect(mockFindProducts.mock.calls[0][6]).toBeNull();
  });

  it("returns 400 when items array is missing (unrelated to occasion)", async () => {
    const { status } = await post(port, { gender: "male", occasion: "casual" });
    expect(status).toBe(400);
  });

  it("returns 400 when items array is empty (unrelated to occasion)", async () => {
    const { status } = await post(port, { items: [], gender: "male", occasion: "casual" });
    expect(status).toBe(400);
  });

  it("returns 400 when gender is invalid (unrelated to occasion)", async () => {
    const { status } = await post(port, {
      items: VALID_ITEMS,
      gender: "robot",
      occasion: "casual",
    });
    expect(status).toBe(400);
  });
});
