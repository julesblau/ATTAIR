/**
 * Tests for the Stripe webhook handler in routes/payments.js
 *
 * We test the /webhook POST route in isolation by:
 *   1. Mocking stripe (so no real Stripe SDK calls happen)
 *   2. Mocking ../lib/supabase.js (no real DB calls)
 *   3. Mocking ../middleware/auth.js (requireAuth is not called on the webhook)
 *   4. Creating a minimal Express app that mounts the router
 *   5. Sending requests via the in-process fetch API (Node 18+)
 *
 * The webhook route uses express.raw() body parser. We replicate that by
 * sending a Buffer as the request body in our test helper.
 */

import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import express from "express";
import { createServer } from "http";

// ─── Mocks must be declared before importing the router ───────────────────

// Mock supabase — supports both update chains (checkout.session.completed)
// and select → eq → single chains (subscription.deleted, payment_failed)
const mockSupabaseUpdate = vi.fn().mockReturnThis();
const mockSupabaseEq = vi.fn().mockResolvedValue({ error: null });
const mockSupabaseSingle = vi.fn().mockResolvedValue({ data: { id: "user-uuid-from-customer" }, error: null });
const mockSupabaseSelectEq = vi.fn().mockReturnValue({ single: mockSupabaseSingle });
const mockSupabaseSelect = vi.fn().mockReturnValue({ eq: mockSupabaseSelectEq });
const mockSupabaseFrom = vi.fn().mockReturnValue({
  update: mockSupabaseUpdate,
  select: mockSupabaseSelect,
  eq: mockSupabaseEq,
});
mockSupabaseUpdate.mockReturnValue({ eq: mockSupabaseEq });

vi.mock("../lib/supabase.js", () => ({
  default: { from: mockSupabaseFrom },
}));

// Mock the auth middleware so it never blocks our test calls
vi.mock("../middleware/auth.js", () => ({
  requireAuth: (_req, _res, next) => next(),
}));

// Track constructEvent calls so we can control what it returns per test
const mockConstructEvent = vi.fn();

vi.mock("stripe", () => {
  return {
    default: class MockStripe {
      constructor() {
        this.webhooks = { constructEvent: mockConstructEvent };
        this.checkout = {
          sessions: {
            create: vi.fn().mockResolvedValue({ url: "https://checkout.stripe.com/test" }),
          },
        };
        this.auth = { admin: { getUserById: vi.fn().mockResolvedValue({ data: { user: null } }) } };
      }
    },
  };
});

// ─── Helpers ──────────────────────────────────────────────────────────────

async function makeApp() {
  const { default: paymentsRouter } = await import("../routes/payments.js");
  const app = express();
  // Webhook needs raw body
  app.use("/api/payments/webhook", express.raw({ type: "*/*" }));
  app.use("/api/payments", paymentsRouter);
  return app;
}

function startServer(app) {
  return new Promise((resolve) => {
    const server = createServer(app);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ server, port });
    });
  });
}

async function post(port, path, body, headers = {}) {
  const raw = Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...headers,
    },
    body: raw,
  });
  let json;
  try { json = await res.json(); } catch { json = null; }
  return { status: res.status, body: json };
}

// ─── Test suite ───────────────────────────────────────────────────────────

describe("POST /api/payments/webhook", () => {
  let app;
  let server;
  let port;

  beforeEach(async () => {
    vi.resetAllMocks();
    // Re-apply mock chain defaults after reset
    mockSupabaseEq.mockResolvedValue({ error: null });
    mockSupabaseSingle.mockResolvedValue({ data: { id: "user-uuid-from-customer" }, error: null });
    mockSupabaseSelectEq.mockReturnValue({ single: mockSupabaseSingle });
    mockSupabaseSelect.mockReturnValue({ eq: mockSupabaseSelectEq });
    mockSupabaseUpdate.mockReturnValue({ eq: mockSupabaseEq });
    mockSupabaseFrom.mockReturnValue({ update: mockSupabaseUpdate, select: mockSupabaseSelect, eq: mockSupabaseEq });

    // STRIPE_SECRET_KEY must be set so getStripe() inside payments.js doesn't
    // throw before it can reach webhooks.constructEvent (which we mock).
    process.env.STRIPE_SECRET_KEY = "sk_test_placeholder";

    // Build a fresh app for each test (vi.resetAllMocks clears module state)
    app = await makeApp();
    const started = await startServer(app);
    server = started.server;
    port = started.port;
  });

  afterAll(() => {
    if (server) server.close();
    delete process.env.STRIPE_SECRET_KEY;
  });

  it("returns 500 when STRIPE_WEBHOOK_SECRET is not set", async () => {
    const saved = process.env.STRIPE_WEBHOOK_SECRET;
    delete process.env.STRIPE_WEBHOOK_SECRET;

    const { status, body } = await post(port, "/api/payments/webhook", {});
    expect(status).toBe(500);
    expect(body.error).toMatch(/not configured/i);

    if (saved !== undefined) process.env.STRIPE_WEBHOOK_SECRET = saved;
  });

  it("returns 400 when Stripe signature verification fails", async () => {
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_test_secret";
    mockConstructEvent.mockImplementation(() => {
      throw new Error("No signatures found matching the expected signature for payload.");
    });

    const { status, body } = await post(
      port,
      "/api/payments/webhook",
      Buffer.from("raw-payload"),
      { "stripe-signature": "bad-sig" }
    );

    expect(status).toBe(400);
    expect(body.error).toMatch(/Webhook signature verification failed/i);

    delete process.env.STRIPE_WEBHOOK_SECRET;
  });

  it("calls supabase update with tier='pro' on checkout.session.completed", async () => {
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_test_secret";

    const event = {
      type: "checkout.session.completed",
      data: {
        object: {
          metadata: { user_id: "user-uuid-123" },
        },
      },
    };
    mockConstructEvent.mockReturnValue(event);

    const mockEqFn = vi.fn().mockResolvedValue({ error: null });
    const mockUpdateFn = vi.fn().mockReturnValue({ eq: mockEqFn });
    mockSupabaseFrom.mockReturnValue({ update: mockUpdateFn });

    const { status, body } = await post(
      port,
      "/api/payments/webhook",
      Buffer.from("raw-payload"),
      { "stripe-signature": "t=123,v1=abc" }
    );

    expect(status).toBe(200);
    expect(body.received).toBe(true);
    expect(mockSupabaseFrom).toHaveBeenCalledWith("profiles");
    expect(mockUpdateFn).toHaveBeenCalledWith(
      expect.objectContaining({ tier: "pro" })
    );
    expect(mockEqFn).toHaveBeenCalledWith("id", "user-uuid-123");

    delete process.env.STRIPE_WEBHOOK_SECRET;
  });

  it("returns 200 and does not crash on customer.subscription.deleted", async () => {
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_test_secret";

    const event = {
      type: "customer.subscription.deleted",
      data: { object: { customer: "cus_abc123" } },
    };
    mockConstructEvent.mockReturnValue(event);

    const { status, body } = await post(
      port,
      "/api/payments/webhook",
      Buffer.from("raw-payload"),
      { "stripe-signature": "t=123,v1=abc" }
    );

    expect(status).toBe(200);
    expect(body.received).toBe(true);

    delete process.env.STRIPE_WEBHOOK_SECRET;
  });

  it("returns 200 and does not crash on invoice.payment_failed", async () => {
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_test_secret";

    const event = {
      type: "invoice.payment_failed",
      data: { object: { customer: "cus_xyz456" } },
    };
    mockConstructEvent.mockReturnValue(event);

    const { status, body } = await post(
      port,
      "/api/payments/webhook",
      Buffer.from("raw-payload"),
      { "stripe-signature": "t=123,v1=abc" }
    );

    expect(status).toBe(200);
    expect(body.received).toBe(true);

    delete process.env.STRIPE_WEBHOOK_SECRET;
  });

  it("always returns 200 after valid events", async () => {
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_test_secret";

    // Unknown event type — should still return 200
    const event = {
      type: "payment_intent.created",
      data: { object: {} },
    };
    mockConstructEvent.mockReturnValue(event);

    const { status } = await post(
      port,
      "/api/payments/webhook",
      Buffer.from("raw-payload"),
      { "stripe-signature": "t=123,v1=abc" }
    );

    expect(status).toBe(200);

    delete process.env.STRIPE_WEBHOOK_SECRET;
  });
});
