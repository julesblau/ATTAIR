/**
 * Tests for input validation in POST /api/identify (routes/identify.js)
 *
 * Uses a real Express app + http.createServer so routes run end-to-end.
 *
 * Covers:
 *   A. MIME type allowlist — jpeg/png/webp/gif pass; pdf/html/svg → 400
 *   B. Missing / too-short image field → 400
 *   C. Unauthenticated request → 401
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import { createServer } from "http";

// ─── Mocks ────────────────────────────────────────────────────────────────

vi.mock("../lib/supabase.js", () => ({
  default: {
    from: () => ({
      insert: () => ({
        select: () => ({
          single: () => Promise.resolve({ data: { id: "scan-1" }, error: null }),
        }),
      }),
    }),
    storage: {
      from: () => ({
        upload: () => Promise.resolve({ data: { path: "u/f.jpg" }, error: null }),
        getPublicUrl: () => ({ data: { publicUrl: "https://cdn.example.com/f.jpg" } }),
      }),
    },
  },
}));

vi.mock("../middleware/auth.js", () => ({
  requireAuth: (req, res, next) => {
    const header = req.headers.authorization || "";
    if (!header.startsWith("Bearer ") || header === "Bearer NOAUTH") {
      return res.status(401).json({ error: "Unauthorized" });
    }
    req.userId = "user-abc";
    next();
  },
}));

vi.mock("../middleware/rateLimit.js", () => ({
  scanRateLimit: (req, _res, next) => {
    req.profile = { tier: "free", gender_pref: null, budget_min: null, budget_max: null };
    next();
  },
  incrementScanCount: () => Promise.resolve(1),
}));

vi.mock("../services/claude.js", () => ({
  identifyClothing: () =>
    Promise.resolve({ gender: "male", summary: "Test", items: [] }),
  refineItem: () => Promise.resolve({}),
}));

vi.mock("uuid", () => ({ v4: () => "mock-uuid" }));

// ─── Server helpers ───────────────────────────────────────────────────────

async function makeApp() {
  const { default: identifyRouter } = await import("../routes/identify.js");
  const app = express();
  app.use(express.json({ limit: "20mb" }));
  app.use("/api/identify", identifyRouter);
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

async function post(port, body, authHeader = "Bearer valid-token") {
  const res = await fetch(`http://127.0.0.1:${port}/api/identify`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: authHeader,
    },
    body: JSON.stringify(body),
  });
  let json;
  try { json = await res.json(); } catch { json = null; }
  return { status: res.status, body: json };
}

// A valid base64 string: > 100 chars, passes charset check (/^[A-Za-z0-9+/=\s]+$/)
const VALID_BASE64 = "AAAA".repeat(60); // 240 chars

// ─── Tests ────────────────────────────────────────────────────────────────

describe("POST /api/identify — MIME type allowlist", () => {
  let server;
  let port;

  beforeEach(async () => {
    const app = await makeApp();
    const started = await startServer(app);
    server = started.server;
    port = started.port;
  });

  afterEach(() => server.close());

  it("does NOT reject image/jpeg (200 or 500, not 400)", async () => {
    const { status } = await post(port, { image: VALID_BASE64, mime_type: "image/jpeg" });
    expect(status).not.toBe(400);
  });

  it("does NOT reject image/png (200 or 500, not 400)", async () => {
    const { status } = await post(port, { image: VALID_BASE64, mime_type: "image/png" });
    expect(status).not.toBe(400);
  });

  it("does NOT reject image/webp (200 or 500, not 400)", async () => {
    const { status } = await post(port, { image: VALID_BASE64, mime_type: "image/webp" });
    expect(status).not.toBe(400);
  });

  it("does NOT reject image/gif (200 or 500, not 400)", async () => {
    const { status } = await post(port, { image: VALID_BASE64, mime_type: "image/gif" });
    expect(status).not.toBe(400);
  });

  it("rejects application/pdf with 400", async () => {
    const { status, body } = await post(port, { image: VALID_BASE64, mime_type: "application/pdf" });
    expect(status).toBe(400);
    expect(body.error).toMatch(/invalid image type/i);
  });

  it("rejects text/html with 400", async () => {
    const { status } = await post(port, { image: VALID_BASE64, mime_type: "text/html" });
    expect(status).toBe(400);
  });

  it("rejects image/svg+xml with 400", async () => {
    const { status } = await post(port, { image: VALID_BASE64, mime_type: "image/svg+xml" });
    expect(status).toBe(400);
  });
});

describe("POST /api/identify — missing / invalid image field", () => {
  let server;
  let port;

  beforeEach(async () => {
    const app = await makeApp();
    const started = await startServer(app);
    server = started.server;
    port = started.port;
  });

  afterEach(() => server.close());

  it("rejects missing image field with 400", async () => {
    const { status, body } = await post(port, {});
    expect(status).toBe(400);
    expect(body.error).toMatch(/missing image/i);
  });

  it("rejects empty image string with 400", async () => {
    const { status } = await post(port, { image: "" });
    expect(status).toBe(400);
  });

  it("rejects too-short image string (< 100 chars) with 400", async () => {
    const { status } = await post(port, { image: "AAAA" });
    expect(status).toBe(400);
  });
});

describe("POST /api/identify — auth enforcement", () => {
  let server;
  let port;

  beforeEach(async () => {
    const app = await makeApp();
    const started = await startServer(app);
    server = started.server;
    port = started.port;
  });

  afterEach(() => server.close());

  it("rejects unauthenticated request with 401", async () => {
    const { status } = await post(port, { image: VALID_BASE64 }, "Bearer NOAUTH");
    expect(status).toBe(401);
  });
});
