/**
 * Tests for the seenOn interests param in GET /api/seen-on.
 *
 * Covers:
 *   1. Valid interest names are accepted and produce personalized queries
 *   2. Unknown/invalid interest names are silently ignored (fall through to default)
 *   3. A mix of valid and invalid interests uses only the valid ones
 *   4. interests param is comma-separated; up to 3 SerpAPI calls are made
 *   5. Default (no interests) falls back to generic celebrity/street style query
 *   6. All 8 known interest categories are recognized
 *
 * These tests intercept the SerpAPI fetch call to verify which query was built
 * and to prevent actual network calls. We follow the same pattern used in
 * seenOn.routes.test.js (INTEREST_QUERY_MAP content describe block).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import { createServer } from "http";
import { createRequire } from "module";

const require = createRequire(import.meta.url);

// ─── Auth mock ────────────────────────────────────────────────────────────

vi.mock("../middleware/auth.js", () => ({
  requireAuth: (req, _res, next) => {
    req.userId = "user-test";
    next();
  },
}));

// ─── Helpers ──────────────────────────────────────────────────────────────

/**
 * Build and start a fresh seenOn app.
 * vi.resetModules() is called before each to pick up a freshly imported route
 * (necessary because the fetch mock must be installed before module init).
 */
async function buildAndStart(fetchMock) {
  // Patch global fetch before importing the route module
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetchMock || vi.fn(async () => ({ ok: false }));

  vi.resetModules();
  const { default: seenOnRouter } = await import("../routes/seenOn.js");
  const app = express();
  app.use(express.json());
  app.use("/api/seen-on", seenOnRouter);

  const server = await new Promise((resolve) => {
    const s = createServer(app);
    s.listen(0, "127.0.0.1", () => resolve(s));
  });
  const port = server.address().port;

  return { server, port, originalFetch };
}

/** Make an HTTP GET using node:http to avoid globalThis.fetch being intercepted. */
function httpGet(port, path) {
  return new Promise((resolve, reject) => {
    const http = require("http");
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path,
        method: "GET",
        headers: { authorization: "Bearer valid-token" },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
          catch { resolve({ status: res.statusCode, body: null }); }
        });
      }
    );
    req.on("error", reject);
    req.end();
  });
}

// ─── Tests: all 8 known interests are recognized ─────────────────────────

describe("GET /api/seen-on — all known interest categories are accepted", () => {
  const KNOWN_INTERESTS = [
    "Actors & Actresses",
    "Musicians & K-Pop",
    "Athletes",
    "TikTok Creators",
    "Instagram Influencers",
    "Streamers & YouTubers",
    "Fashion Icons & Models",
    "Street Style",
  ];

  for (const interest of KNOWN_INTERESTS) {
    it(`recognized interest: "${interest}" triggers a personalized SerpAPI query`, async () => {
      const capturedUrls = [];
      const fetchMock = vi.fn(async (url) => {
        capturedUrls.push(url.toString());
        return { ok: false };
      });

      const { server, port, originalFetch } = await buildAndStart(fetchMock);

      const encodedInterest = encodeURIComponent(interest);
      await httpGet(port, `/api/seen-on?name=Air+Force+1&interests=${encodedInterest}`);

      globalThis.fetch = originalFetch;
      server.close();

      // A SerpAPI call must have been made (personalized mode)
      const serpUrl = capturedUrls.find(u => u.includes("serpapi.com"));
      expect(serpUrl).toBeTruthy();
      // The query should contain the item name
      const q = new URL(serpUrl).searchParams.get("q");
      expect(q).toContain("Air Force 1");
    });
  }
});

// ─── Tests: unknown interests silently fall through to default ────────────

describe("GET /api/seen-on — unknown interests fall through to default query", () => {
  it("completely unknown interest 'Royalty' triggers default (not personalized) query", async () => {
    const capturedUrls = [];
    const fetchMock = vi.fn(async (url) => {
      capturedUrls.push(url.toString());
      return { ok: false };
    });

    const { server, port, originalFetch } = await buildAndStart(fetchMock);

    await httpGet(port, "/api/seen-on?brand=Nike&name=Sneakers&interests=Royalty");

    globalThis.fetch = originalFetch;
    server.close();

    // The default query should include "celebrity" or "street style"
    const serpUrl = capturedUrls.find(u => u.includes("serpapi.com"));
    expect(serpUrl).toBeTruthy();
    const q = new URL(serpUrl).searchParams.get("q");
    // Default mode: "Nike Sneakers celebrity spotted street style outfit"
    expect(q).toMatch(/celebrity|street style/i);
  });

  it("empty interests string triggers default query", async () => {
    const capturedUrls = [];
    const fetchMock = vi.fn(async (url) => {
      capturedUrls.push(url.toString());
      return { ok: false };
    });

    const { server, port, originalFetch } = await buildAndStart(fetchMock);

    await httpGet(port, "/api/seen-on?brand=Adidas&name=Hoodie&interests=");

    globalThis.fetch = originalFetch;
    server.close();

    const serpUrl = capturedUrls.find(u => u.includes("serpapi.com"));
    expect(serpUrl).toBeTruthy();
    const q = new URL(serpUrl).searchParams.get("q");
    expect(q).toMatch(/celebrity|street style/i);
  });

  it("mix of valid and invalid interests: only valid ones produce queries", async () => {
    const capturedUrls = [];
    const fetchMock = vi.fn(async (url) => {
      capturedUrls.push(url.toString());
      return { ok: false };
    });

    const { server, port, originalFetch } = await buildAndStart(fetchMock);

    // "Athletes" is valid; "Royalty" and "Pets" are not
    const interests = encodeURIComponent("Athletes,Royalty,Pets");
    await httpGet(port, `/api/seen-on?brand=Nike&name=Shorts&interests=${interests}`);

    globalThis.fetch = originalFetch;
    server.close();

    // Only 1 SerpAPI call (for "Athletes"), not 3
    const serpCalls = capturedUrls.filter(u => u.includes("serpapi.com"));
    expect(serpCalls.length).toBe(1);

    // The one query should be from Athletes template (not generic celebrity/street)
    const q = new URL(serpCalls[0]).searchParams.get("q");
    expect(q).toContain("Nike");
    expect(q).toContain("Shorts");
    // Should NOT be the default "celebrity spotted" query
    expect(q).not.toMatch(/celebrity spotted/i);
  });
});

// ─── Tests: interests caps at 3 SerpAPI calls ─────────────────────────────

describe("GET /api/seen-on — interests capped at 3 SerpAPI calls", () => {
  it("providing 4+ valid interests results in only 3 SerpAPI calls", async () => {
    const capturedUrls = [];
    const fetchMock = vi.fn(async (url) => {
      capturedUrls.push(url.toString());
      return { ok: false };
    });

    const { server, port, originalFetch } = await buildAndStart(fetchMock);

    // Provide 4 valid interests
    const interests = encodeURIComponent(
      "Actors & Actresses,Musicians & K-Pop,Athletes,TikTok Creators"
    );
    await httpGet(port, `/api/seen-on?brand=Gucci&name=Loafers&interests=${interests}`);

    globalThis.fetch = originalFetch;
    server.close();

    const serpCalls = capturedUrls.filter(u => u.includes("serpapi.com"));
    expect(serpCalls.length).toBe(3); // capped at 3
  });

  it("providing exactly 3 valid interests results in 3 SerpAPI calls", async () => {
    const capturedUrls = [];
    const fetchMock = vi.fn(async (url) => {
      capturedUrls.push(url.toString());
      return { ok: false };
    });

    const { server, port, originalFetch } = await buildAndStart(fetchMock);

    const interests = encodeURIComponent("Athletes,Street Style,Fashion Icons & Models");
    await httpGet(port, `/api/seen-on?brand=Adidas&name=Track+Pants&interests=${interests}`);

    globalThis.fetch = originalFetch;
    server.close();

    const serpCalls = capturedUrls.filter(u => u.includes("serpapi.com"));
    expect(serpCalls.length).toBe(3);
  });
});

// ─── Tests: no interests param → default query ────────────────────────────

describe("GET /api/seen-on — no interests param uses default query", () => {
  it("no interests param → single generic SerpAPI call with 'celebrity'", async () => {
    const capturedUrls = [];
    const fetchMock = vi.fn(async (url) => {
      capturedUrls.push(url.toString());
      return { ok: false };
    });

    const { server, port, originalFetch } = await buildAndStart(fetchMock);

    await httpGet(port, "/api/seen-on?brand=Nike&name=Air+Force+1");

    globalThis.fetch = originalFetch;
    server.close();

    const serpCalls = capturedUrls.filter(u => u.includes("serpapi.com"));
    expect(serpCalls.length).toBe(1);

    const q = new URL(serpCalls[0]).searchParams.get("q");
    expect(q).toContain("Nike");
    expect(q).toContain("Air Force 1");
    expect(q).toMatch(/celebrity/i);
  });

  it("missing both brand and name returns 400", async () => {
    const { server, port, originalFetch } = await buildAndStart(vi.fn(async () => ({ ok: false })));

    const { status, body } = await httpGet(port, "/api/seen-on");

    globalThis.fetch = originalFetch;
    server.close();

    expect(status).toBe(400);
    expect(body.error).toMatch(/missing/i);
  });
});

// ─── Tests: Actors & Actresses interest includes brand in query ───────────

describe("GET /api/seen-on — Actors & Actresses query includes brand", () => {
  it("Actors & Actresses with brand 'Prada' includes 'Prada' in query", async () => {
    const capturedUrls = [];
    const fetchMock = vi.fn(async (url) => {
      capturedUrls.push(url.toString());
      return { ok: false };
    });

    const { server, port, originalFetch } = await buildAndStart(fetchMock);

    const interests = encodeURIComponent("Actors & Actresses");
    await httpGet(port, `/api/seen-on?brand=Prada&name=Loafers&interests=${interests}`);

    globalThis.fetch = originalFetch;
    server.close();

    const serpUrl = capturedUrls.find(u => u.includes("serpapi.com"));
    expect(serpUrl).toBeTruthy();
    const q = new URL(serpUrl).searchParams.get("q");
    expect(q).toContain("Prada");
    expect(q).toContain("Loafers");
    expect(q).toMatch(/actor|actress/i);
  });
});

// ─── Tests: response shape ────────────────────────────────────────────────

describe("GET /api/seen-on — response always has { appearances } shape", () => {
  it("valid request without interests returns { appearances: [] } when fetch fails", async () => {
    const { server, port, originalFetch } = await buildAndStart(vi.fn(async () => ({ ok: false })));

    const { status, body } = await httpGet(port, "/api/seen-on?brand=Nike&name=Shoes");

    globalThis.fetch = originalFetch;
    server.close();

    expect(status).toBe(200);
    expect(body).toHaveProperty("appearances");
    expect(Array.isArray(body.appearances)).toBe(true);
  });

  it("valid request with interests returns { appearances: [] } when fetch fails", async () => {
    const fetchMock = vi.fn(async () => ({ ok: false }));
    const { server, port, originalFetch } = await buildAndStart(fetchMock);

    const interests = encodeURIComponent("Athletes");
    const { status, body } = await httpGet(
      port,
      `/api/seen-on?brand=Nike&name=Shorts&interests=${interests}`
    );

    globalThis.fetch = originalFetch;
    server.close();

    expect(status).toBe(200);
    expect(body).toHaveProperty("appearances");
    expect(Array.isArray(body.appearances)).toBe(true);
  });
});
