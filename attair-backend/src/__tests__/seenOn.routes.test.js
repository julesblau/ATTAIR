/**
 * Tests for GET /api/seen-on (routes/seenOn.js)
 *
 * Covers:
 *   A. brand > 100 chars → 400
 *   B. name > 200 chars → 400
 *   C. INTEREST_QUERY_MAP uses brand for TikTok/YouTube queries
 *   D. Athletes query uses "sports star" not "NBA NFL"
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
  const { default: seenOnRouter } = await import("../routes/seenOn.js");
  const app = express();
  app.use(express.json());
  app.use("/api/seen-on", seenOnRouter);
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
  const res = await fetch(`http://127.0.0.1:${port}/api/seen-on?${params}`, {
    headers: { authorization: "Bearer valid-token" },
  });
  let json;
  try { json = await res.json(); } catch { json = null; }
  return { status: res.status, body: json };
}

// ─── Tests: brand/name length caps ────────────────────────────────────────

describe("GET /api/seen-on — length caps", () => {
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
      name: "Air Force 1",
    });
    expect(status).toBe(400);
    expect(body.error).toMatch(/100/i);
  });

  it("returns 400 when name > 200 chars", async () => {
    const { status, body } = await get(port, {
      brand: "Nike",
      name: "N".repeat(201),
    });
    expect(status).toBe(400);
    expect(body.error).toMatch(/200/i);
  });

  it("accepts brand of exactly 100 chars", async () => {
    // SerpAPI fetch will fail (no key) but the route returns an empty array, not 400
    const { status } = await get(port, {
      brand: "B".repeat(100),
      name: "Sneaker",
    });
    expect(status).not.toBe(400);
  });

  it("accepts name of exactly 200 chars", async () => {
    const { status } = await get(port, {
      brand: "Nike",
      name: "N".repeat(200),
    });
    expect(status).not.toBe(400);
  });

  it("returns 400 when both brand and name are missing", async () => {
    const { status } = await get(port, {});
    expect(status).toBe(400);
  });
});

// ─── Tests: INTEREST_QUERY_MAP content ───────────────────────────────────
// We test the query templates by intercepting the SerpAPI fetch call.
// To avoid our global fetch mock also intercepting the in-process HTTP request
// to the test server, we use node:http directly to make the server request
// while the SerpAPI fetch is mocked on globalThis.

describe("INTEREST_QUERY_MAP — query template content", () => {
  /** Make an HTTP GET to the local test server without going through globalThis.fetch */
  function httpGet(port, path) {
    return new Promise((resolve, reject) => {
      const http = require("http");
      const options = {
        hostname: "127.0.0.1",
        port,
        path,
        method: "GET",
        headers: { authorization: "Bearer valid-token" },
      };
      const req = http.request(options, (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
          catch { resolve({ status: res.statusCode, body: null }); }
        });
      });
      req.on("error", reject);
      req.end();
    });
  }

  it("TikTok Creators query includes brand when brand is provided", async () => {
    let capturedUrls = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (url) => {
      capturedUrls.push(url.toString());
      return { ok: false };
    });

    vi.resetModules();
    const app = express();
    const { default: seenOnRouter } = await import("../routes/seenOn.js");
    app.use(express.json());
    app.use("/api/seen-on", seenOnRouter);

    const { server: srv, port: p } = await new Promise((resolve) => {
      const s = createServer(app);
      s.listen(0, "127.0.0.1", () => resolve({ server: s, port: s.address().port }));
    });

    await httpGet(p, "/api/seen-on?brand=Nike&name=Air+Force+1&interests=TikTok+Creators");

    globalThis.fetch = originalFetch;
    srv.close();

    // The captured SerpAPI URL should contain both the brand and name
    const serpUrl = capturedUrls.find(u => u.includes("serpapi.com"));
    expect(serpUrl).toBeTruthy();
    const q = new URL(serpUrl).searchParams.get("q");
    expect(q).toContain("Nike");
    expect(q).toContain("Air Force 1");
  });

  it("Streamers & YouTubers query includes brand when brand is provided", async () => {
    let capturedUrls = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (url) => {
      capturedUrls.push(url.toString());
      return { ok: false };
    });

    vi.resetModules();
    const app = express();
    const { default: seenOnRouter } = await import("../routes/seenOn.js");
    app.use(express.json());
    app.use("/api/seen-on", seenOnRouter);

    const { server: srv, port: p } = await new Promise((resolve) => {
      const s = createServer(app);
      s.listen(0, "127.0.0.1", () => resolve({ server: s, port: s.address().port }));
    });

    await httpGet(p, "/api/seen-on?brand=Adidas&name=Hoodie&interests=Streamers+%26+YouTubers");

    globalThis.fetch = originalFetch;
    srv.close();

    const serpUrl = capturedUrls.find(u => u.includes("serpapi.com"));
    expect(serpUrl).toBeTruthy();
    const q = new URL(serpUrl).searchParams.get("q");
    expect(q).toContain("Adidas");
    expect(q).toContain("Hoodie");
  });

  it("Athletes query uses 'sports star' not 'NBA' or 'NFL'", async () => {
    let capturedUrls = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (url) => {
      capturedUrls.push(url.toString());
      return { ok: false };
    });

    vi.resetModules();
    const app = express();
    const { default: seenOnRouter } = await import("../routes/seenOn.js");
    app.use(express.json());
    app.use("/api/seen-on", seenOnRouter);

    const { server: srv, port: p } = await new Promise((resolve) => {
      const s = createServer(app);
      s.listen(0, "127.0.0.1", () => resolve({ server: s, port: s.address().port }));
    });

    await httpGet(p, "/api/seen-on?brand=Nike&name=Shorts&interests=Athletes");

    globalThis.fetch = originalFetch;
    srv.close();

    const serpUrl = capturedUrls.find(u => u.includes("serpapi.com"));
    expect(serpUrl).toBeTruthy();
    const q = new URL(serpUrl).searchParams.get("q");
    expect(q).toContain("sports star");
    expect(q).not.toMatch(/\bNBA\b/);
    expect(q).not.toMatch(/\bNFL\b/);
  });
});
