/**
 * Tests for GET /api/nearby-stores (routes/nearbyStores.js)
 *
 * Covers:
 *   A. brand > 100 chars → 400
 *   B. category > 100 chars → 400
 *   C. Missing lat/lng → 400
 *   D. Invalid lat/lng values → 400
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import { createServer } from "http";

// ─── Mocks ────────────────────────────────────────────────────────────────

vi.mock("../middleware/auth.js", () => ({
  requireAuth: (req, _res, next) => {
    req.userId = "user-test";
    next();
  },
}));

// ─── Server helpers ───────────────────────────────────────────────────────

async function makeApp() {
  const { default: nearbyStoresRouter } = await import("../routes/nearbyStores.js");
  const app = express();
  app.use(express.json());
  app.use("/api/nearby-stores", nearbyStoresRouter);
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

async function get(port, query) {
  const params = new URLSearchParams(query);
  const res = await fetch(`http://127.0.0.1:${port}/api/nearby-stores?${params}`, {
    headers: { authorization: "Bearer valid-token" },
  });
  let json;
  try { json = await res.json(); } catch { json = null; }
  return { status: res.status, body: json };
}

// ─── Tests ────────────────────────────────────────────────────────────────

describe("GET /api/nearby-stores — length caps and validation", () => {
  let server;
  let port;

  beforeEach(async () => {
    const app = await makeApp();
    const started = await startServer(app);
    server = started.server;
    port = started.port;
  });

  afterEach(() => server.close());

  it("returns 400 when brand > 100 chars", async () => {
    const { status, body } = await get(port, {
      brand: "B".repeat(101),
      lat: "40.71",
      lng: "-74.00",
    });
    expect(status).toBe(400);
    expect(body.error).toMatch(/100/i);
  });

  it("returns 400 when category > 100 chars", async () => {
    const { status, body } = await get(port, {
      category: "C".repeat(101),
      lat: "40.71",
      lng: "-74.00",
    });
    expect(status).toBe(400);
    expect(body.error).toMatch(/100/i);
  });

  it("accepts brand of exactly 100 chars", async () => {
    // SerpAPI fetch will fail (no key), route returns { stores: [] }, not 400
    const { status } = await get(port, {
      brand: "B".repeat(100),
      lat: "40.71",
      lng: "-74.00",
    });
    expect(status).not.toBe(400);
  });

  it("returns 400 when lat is missing", async () => {
    const { status } = await get(port, { brand: "Nike", lng: "-74.00" });
    expect(status).toBe(400);
  });

  it("returns 400 when lng is missing", async () => {
    const { status } = await get(port, { brand: "Nike", lat: "40.71" });
    expect(status).toBe(400);
  });

  it("returns 400 for non-numeric lat", async () => {
    const { status, body } = await get(port, {
      brand: "Nike",
      lat: "not-a-number",
      lng: "-74.00",
    });
    expect(status).toBe(400);
    expect(body.error).toMatch(/lat/i);
  });

  it("returns 400 for lat out of range (> 90)", async () => {
    const { status } = await get(port, {
      brand: "Nike",
      lat: "91",
      lng: "-74.00",
    });
    expect(status).toBe(400);
  });

  it("returns 400 for lng out of range (< -180)", async () => {
    const { status } = await get(port, {
      brand: "Nike",
      lat: "40.71",
      lng: "-181",
    });
    expect(status).toBe(400);
  });
});
