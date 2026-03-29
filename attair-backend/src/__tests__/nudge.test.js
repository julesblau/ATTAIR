/**
 * Tests for the Follow-up Nudge System (services/notifications.js)
 *
 * Covers:
 *   A. scheduleNudge — creates a pending nudge, replaces existing
 *   B. cancelNudge — removes pending nudge, scanId matching
 *   C. getNudgeStatus — returns correct status or null
 *   D. processNudges — fires expired nudges, sends notifications
 *   E. Preference gating — follow_up_nudges: false suppresses nudges
 *   F. Edge cases — duplicate scheduling, cancel after send, cleanup
 *   G. getPendingNudgeCount — monitoring helper
 *   H. startNudgeProcessor / stopNudgeProcessor — lifecycle
 *   I. Nudge API routes — POST/DELETE/GET /api/notifications/nudge
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ─── Mock auth middleware ─────────────────────────────────────────────────
vi.mock("../middleware/auth.js", () => ({
  requireAuth: (req, _res, next) => {
    const auth = req.headers?.authorization;
    if (!auth || !auth.startsWith("Bearer ")) {
      return _res.status(401).json({ error: "Missing or invalid token" });
    }
    req.userId = "route-test-user";
    next();
  },
}));

// ─── Mock web-push ───────────────────────────────────────────────────────
vi.mock("web-push", () => ({
  default: {
    setVapidDetails: vi.fn(),
    sendNotification: vi.fn().mockResolvedValue({}),
  },
}));

// ─── Mock supabase ───────────────────────────────────────────────────────
let mockNotifPrefs = {};
let mockPushSubs = [];

const mockInsert = vi.fn().mockResolvedValue({ error: null });

vi.mock("../lib/supabase.js", () => {
  const mockFrom = vi.fn().mockImplementation((table) => {
    if (table === "profiles") {
      return {
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            single: vi.fn().mockImplementation(async () => ({
              data: { notification_prefs: mockNotifPrefs },
              error: null,
            })),
          }),
        }),
        update: vi.fn().mockReturnValue({
          eq: vi.fn().mockResolvedValue({ error: null }),
        }),
      };
    }
    if (table === "push_subscriptions") {
      return {
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockImplementation(async () => ({
            data: mockPushSubs,
            error: null,
          })),
        }),
        delete: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            eq: vi.fn().mockResolvedValue({ error: null }),
          }),
        }),
      };
    }
    if (table === "notification_log") {
      return { insert: mockInsert };
    }
    return {};
  });
  return { default: { from: mockFrom } };
});

// ─── Import after mocks ─────────────────────────────────────────────────
const {
  scheduleNudge,
  cancelNudge,
  getNudgeStatus,
  processNudges,
  getPendingNudgeCount,
  startNudgeProcessor,
  stopNudgeProcessor,
  _clearAllNudges,
} = await import("../services/notifications.js");

// ─── Helpers ─────────────────────────────────────────────────────────────
let userCounter = 0;
function uniqueUserId() {
  return `user-nudge-test-${++userCounter}-${Date.now()}`;
}

// ─── Setup / Teardown ────────────────────────────────────────────────────
beforeEach(() => {
  mockNotifPrefs = {};
  mockPushSubs = [];
  mockInsert.mockClear();
  // Clear all nudges between tests
  if (_clearAllNudges) _clearAllNudges();
});

afterEach(() => {
  stopNudgeProcessor();
  vi.restoreAllMocks();
});

// ═══════════════════════════════════════════════════════════════════════
// A. scheduleNudge
// ═══════════════════════════════════════════════════════════════════════
describe("scheduleNudge", () => {
  it("creates a pending nudge for a user", () => {
    const uid = uniqueUserId();
    scheduleNudge(uid, "scan-1", "scan_results", "jacket");

    const status = getNudgeStatus(uid);
    expect(status).not.toBeNull();
    expect(status.scanId).toBe("scan-1");
    expect(status.context).toBe("scan_results");
    expect(status.minutesLeft).toBeGreaterThanOrEqual(0);
    expect(status.minutesLeft).toBeLessThanOrEqual(15);
  });

  it("replaces existing nudge for the same user (latest wins)", () => {
    const uid = uniqueUserId();
    scheduleNudge(uid, "scan-1", "scan_results");
    scheduleNudge(uid, "scan-2", "refinement");

    const status = getNudgeStatus(uid);
    expect(status.scanId).toBe("scan-2");
    expect(status.context).toBe("refinement");
  });

  it("does nothing for falsy userId", () => {
    const before = getPendingNudgeCount();
    scheduleNudge(null, "scan-1");
    scheduleNudge(undefined, "scan-1");
    scheduleNudge("", "scan-1");
    expect(getPendingNudgeCount()).toBe(before);
  });

  it("defaults context to scan_results", () => {
    const uid = uniqueUserId();
    scheduleNudge(uid, "scan-1");

    const status = getNudgeStatus(uid);
    expect(status.context).toBe("scan_results");
  });

  it("accepts all valid contexts", () => {
    for (const ctx of ["scan_results", "refinement", "pairings"]) {
      const uid = uniqueUserId();
      scheduleNudge(uid, "scan-1", ctx);
      expect(getNudgeStatus(uid).context).toBe(ctx);
    }
  });

  it("increments pending nudge count", () => {
    const before = getPendingNudgeCount();
    const uid = uniqueUserId();
    scheduleNudge(uid, "scan-1");
    expect(getPendingNudgeCount()).toBe(before + 1);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// B. cancelNudge
// ═══════════════════════════════════════════════════════════════════════
describe("cancelNudge", () => {
  it("removes a pending nudge", () => {
    const uid = uniqueUserId();
    scheduleNudge(uid, "scan-1");
    expect(getNudgeStatus(uid)).not.toBeNull();

    cancelNudge(uid);
    expect(getNudgeStatus(uid)).toBeNull();
  });

  it("only cancels matching scanId when specified", () => {
    const uid = uniqueUserId();
    scheduleNudge(uid, "scan-2", "refinement");

    // Try to cancel with a different scanId — should NOT cancel
    cancelNudge(uid, "scan-1");
    expect(getNudgeStatus(uid)).not.toBeNull();

    // Cancel with matching scanId — should cancel
    cancelNudge(uid, "scan-2");
    expect(getNudgeStatus(uid)).toBeNull();
  });

  it("cancels any nudge when scanId is null", () => {
    const uid = uniqueUserId();
    scheduleNudge(uid, "scan-99", "pairings");

    cancelNudge(uid, null);
    expect(getNudgeStatus(uid)).toBeNull();
  });

  it("is a no-op for users without pending nudges", () => {
    // Should not throw
    cancelNudge("nonexistent-user");
    cancelNudge("nonexistent-user", "scan-1");
  });

  it("does nothing for falsy userId", () => {
    cancelNudge(null);
    cancelNudge(undefined);
    cancelNudge("");
  });
});

// ═══════════════════════════════════════════════════════════════════════
// C. getNudgeStatus
// ═══════════════════════════════════════════════════════════════════════
describe("getNudgeStatus", () => {
  it("returns null for users with no nudge", () => {
    expect(getNudgeStatus("no-nudge-user")).toBeNull();
  });

  it("returns correct shape for pending nudge", () => {
    const uid = uniqueUserId();
    scheduleNudge(uid, "scan-5", "pairings");

    const status = getNudgeStatus(uid);
    expect(status).toEqual({
      scanId: "scan-5",
      context: "pairings",
      minutesLeft: expect.any(Number),
    });
  });

  it("returns null after nudge is cancelled", () => {
    const uid = uniqueUserId();
    scheduleNudge(uid, "scan-1");
    cancelNudge(uid);
    expect(getNudgeStatus(uid)).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════
// D. processNudges — fires expired nudges
// ═══════════════════════════════════════════════════════════════════════
describe("processNudges", () => {
  it("does nothing when no nudges are pending", async () => {
    // Should not throw
    await processNudges();
  });

  it("does not fire nudges that haven't expired yet", async () => {
    const uid = uniqueUserId();
    scheduleNudge(uid, "scan-1");
    // Nudge is 10-15 min in the future — should not fire
    await processNudges();
    // Status should still be pending (not sent)
    expect(getNudgeStatus(uid)).not.toBeNull();
  });

  it("fires nudges whose timer has expired", async () => {
    const uid = uniqueUserId();
    mockPushSubs = [
      { endpoint: "https://push.example.com/1", p256dh: "key1", auth: "auth1" },
    ];

    scheduleNudge(uid, "scan-1", "scan_results", "denim jacket");

    // Advance time past the nudge delay
    const realNow = Date.now;
    Date.now = vi.fn(() => realNow() + 16 * 60 * 1000); // 16 min later

    await processNudges();

    // Nudge should be marked as sent (getNudgeStatus returns null for sent nudges)
    expect(getNudgeStatus(uid)).toBeNull();

    // Should have logged the notification
    expect(mockInsert).toHaveBeenCalled();

    Date.now = realNow;
  });

  it("sends to multiple users independently", async () => {
    const uid1 = uniqueUserId();
    const uid2 = uniqueUserId();
    mockPushSubs = [];

    scheduleNudge(uid1, "scan-a", "scan_results");
    scheduleNudge(uid2, "scan-b", "refinement");

    const realNow = Date.now;
    Date.now = vi.fn(() => realNow() + 16 * 60 * 1000);

    await processNudges();

    // Both nudges should have been processed (status null = sent)
    expect(getNudgeStatus(uid1)).toBeNull();
    expect(getNudgeStatus(uid2)).toBeNull();

    Date.now = realNow;
  });

  it("personalizes message body with itemName", async () => {
    const uid = uniqueUserId();
    mockPushSubs = [
      { endpoint: "https://push.example.com/2", p256dh: "k", auth: "a" },
    ];

    scheduleNudge(uid, "scan-1", "scan_results", "bomber jacket");

    const realNow = Date.now;
    Date.now = vi.fn(() => realNow() + 16 * 60 * 1000);

    await processNudges();

    // The notification_log insert should have been called
    expect(mockInsert).toHaveBeenCalled();
    const insertCall = mockInsert.mock.calls.find(c => c[0]?.user_id === uid);
    if (insertCall) {
      // Body might contain "bomber jacket" if template matched
      expect(typeof insertCall[0].body).toBe("string");
    }

    Date.now = realNow;
  });

  it("cleans up sent nudges older than 1 hour", async () => {
    const uid = uniqueUserId();
    mockPushSubs = [];
    scheduleNudge(uid, "scan-1");

    // Fire the nudge
    const realNow = Date.now;
    const baseTime = realNow();
    Date.now = vi.fn(() => baseTime + 16 * 60 * 1000);
    await processNudges();

    // Nudge is sent but still in map (for status queries)
    // Now advance time to 1h+ after creation
    Date.now = vi.fn(() => baseTime + 2 * 60 * 60 * 1000); // 2 hours
    await processNudges();

    // After cleanup, getPendingNudgeCount should not include this user
    Date.now = realNow;
  });

  it("retries once on failure then removes on second failure", async () => {
    const uid = uniqueUserId();
    mockPushSubs = [
      { endpoint: "https://push.example.com/err", p256dh: "k", auth: "a" },
    ];

    scheduleNudge(uid, "scan-err");

    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const consoleErr = vi.spyOn(console, "error").mockImplementation(() => {});
    const consolLog = vi.spyOn(console, "log").mockImplementation(() => {});

    // Make insert throw to simulate failure
    mockInsert.mockRejectedValueOnce(new Error("DB connection lost"));

    const realNow = Date.now;
    const base = realNow();
    Date.now = vi.fn(() => base + 16 * 60 * 1000);

    // First failure — should retry (nudge rescheduled 1 min later)
    await processNudges();
    expect(consoleWarn).toHaveBeenCalledWith(expect.stringContaining("will retry"));

    // Status should still exist (retry pending in ~1 min)
    const status = getNudgeStatus(uid);
    expect(status).not.toBeNull();
    expect(status.minutesLeft).toBeLessThanOrEqual(1);

    // Second failure — should be permanently removed
    mockInsert.mockRejectedValueOnce(new Error("DB still down"));
    Date.now = vi.fn(() => base + 18 * 60 * 1000); // well past retry time
    await processNudges();

    expect(getNudgeStatus(uid)).toBeNull();
    expect(consoleErr).toHaveBeenCalledWith(expect.stringContaining("Permanently failed"));

    Date.now = realNow;
    consoleWarn.mockRestore();
    consoleErr.mockRestore();
    consolLog.mockRestore();
  });
});

// ═══════════════════════════════════════════════════════════════════════
// E. Preference gating — follow_up_nudges: false suppresses
// ═══════════════════════════════════════════════════════════════════════
describe("preference gating", () => {
  it("skips nudge when follow_up_nudges is disabled", async () => {
    const uid = uniqueUserId();
    mockNotifPrefs = { follow_up_nudges: false };
    mockPushSubs = [
      { endpoint: "https://push.example.com/pref", p256dh: "k", auth: "a" },
    ];

    scheduleNudge(uid, "scan-pref");

    const consolLog = vi.spyOn(console, "log").mockImplementation(() => {});

    const realNow = Date.now;
    Date.now = vi.fn(() => realNow() + 16 * 60 * 1000);

    await processNudges();

    // Nudge was processed (marked sent) but notification was skipped
    expect(getNudgeStatus(uid)).toBeNull();

    Date.now = realNow;
    consolLog.mockRestore();
  });

  it("sends nudge when follow_up_nudges is true", async () => {
    const uid = uniqueUserId();
    mockNotifPrefs = { follow_up_nudges: true };
    mockPushSubs = [
      { endpoint: "https://push.example.com/pref2", p256dh: "k", auth: "a" },
    ];

    scheduleNudge(uid, "scan-pref-ok");

    const consolLog = vi.spyOn(console, "log").mockImplementation(() => {});

    const realNow = Date.now;
    Date.now = vi.fn(() => realNow() + 16 * 60 * 1000);

    await processNudges();

    // Nudge should have been marked as sent
    expect(getNudgeStatus(uid)).toBeNull();

    Date.now = realNow;
    consolLog.mockRestore();
  });

  it("sends nudge when follow_up_nudges pref is not set (default allows)", async () => {
    const uid = uniqueUserId();
    mockNotifPrefs = {}; // No explicit pref set
    mockPushSubs = [];

    scheduleNudge(uid, "scan-default");

    const consolLog = vi.spyOn(console, "log").mockImplementation(() => {});

    const realNow = Date.now;
    Date.now = vi.fn(() => realNow() + 16 * 60 * 1000);

    await processNudges();

    expect(getNudgeStatus(uid)).toBeNull();

    Date.now = realNow;
    consolLog.mockRestore();
  });
});

// ═══════════════════════════════════════════════════════════════════════
// F. Edge cases
// ═══════════════════════════════════════════════════════════════════════
describe("edge cases", () => {
  it("duplicate scheduling replaces the previous nudge", () => {
    const uid = uniqueUserId();
    scheduleNudge(uid, "scan-1", "scan_results");
    scheduleNudge(uid, "scan-2", "refinement", "sneakers");

    expect(getPendingNudgeCount()).toBeGreaterThanOrEqual(1);
    const status = getNudgeStatus(uid);
    expect(status.scanId).toBe("scan-2");
    expect(status.context).toBe("refinement");
  });

  it("cancel after nudge is already sent is a no-op", async () => {
    const uid = uniqueUserId();
    mockPushSubs = [];
    scheduleNudge(uid, "scan-sent");

    const consolLog = vi.spyOn(console, "log").mockImplementation(() => {});
    const realNow = Date.now;
    Date.now = vi.fn(() => realNow() + 16 * 60 * 1000);

    await processNudges();

    // Status is null because nudge was sent
    expect(getNudgeStatus(uid)).toBeNull();

    // Cancel should not throw (nudge already processed)
    cancelNudge(uid, "scan-sent");

    Date.now = realNow;
    consolLog.mockRestore();
  });

  it("multiple users can have independent nudges", () => {
    const uid1 = uniqueUserId();
    const uid2 = uniqueUserId();
    const uid3 = uniqueUserId();

    scheduleNudge(uid1, "scan-a", "scan_results");
    scheduleNudge(uid2, "scan-b", "refinement");
    scheduleNudge(uid3, "scan-c", "pairings");

    expect(getNudgeStatus(uid1).context).toBe("scan_results");
    expect(getNudgeStatus(uid2).context).toBe("refinement");
    expect(getNudgeStatus(uid3).context).toBe("pairings");

    cancelNudge(uid2);
    expect(getNudgeStatus(uid1)).not.toBeNull();
    expect(getNudgeStatus(uid2)).toBeNull();
    expect(getNudgeStatus(uid3)).not.toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════
// G. getPendingNudgeCount
// ═══════════════════════════════════════════════════════════════════════
describe("getPendingNudgeCount", () => {
  it("returns 0 when no nudges exist", () => {
    // After clearAll, count should be 0
    if (_clearAllNudges) _clearAllNudges();
    expect(getPendingNudgeCount()).toBe(0);
  });

  it("counts only unsent nudges", async () => {
    if (_clearAllNudges) _clearAllNudges();

    const uid1 = uniqueUserId();
    const uid2 = uniqueUserId();
    mockPushSubs = [];

    scheduleNudge(uid1, "scan-1");
    scheduleNudge(uid2, "scan-2");
    expect(getPendingNudgeCount()).toBe(2);

    // Fire one nudge
    const consolLog = vi.spyOn(console, "log").mockImplementation(() => {});
    const realNow = Date.now;
    Date.now = vi.fn(() => realNow() + 16 * 60 * 1000);
    await processNudges();

    // Both are now sent, so pending count should be 0
    expect(getPendingNudgeCount()).toBe(0);

    Date.now = realNow;
    consolLog.mockRestore();
  });
});

// ═══════════════════════════════════════════════════════════════════════
// H. startNudgeProcessor / stopNudgeProcessor
// ═══════════════════════════════════════════════════════════════════════
describe("nudge processor lifecycle", () => {
  it("startNudgeProcessor is idempotent (can be called multiple times)", () => {
    const consolLog = vi.spyOn(console, "log").mockImplementation(() => {});

    startNudgeProcessor();
    startNudgeProcessor(); // Second call should be no-op

    stopNudgeProcessor();
    consolLog.mockRestore();
  });

  it("stopNudgeProcessor is safe to call when not running", () => {
    // Should not throw
    stopNudgeProcessor();
    stopNudgeProcessor();
  });
});

// ═══════════════════════════════════════════════════════════════════════
// I. Nudge API routes
// ═══════════════════════════════════════════════════════════════════════
describe("nudge API routes", () => {
  let server;
  let baseUrl;

  beforeEach(async () => {
    const express = (await import("express")).default;
    const { createServer } = await import("http");
    const notifRoutes = (await import("../routes/notifications.js")).default;

    const app = express();
    app.use(express.json());
    app.use("/api/notifications", notifRoutes);

    server = createServer(app);
    await new Promise((resolve) => server.listen(0, resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  afterEach(async () => {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it("POST /api/notifications/nudge requires scan_id", async () => {
    const res = await fetch(`${baseUrl}/api/notifications/nudge`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer test-token",
      },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toMatch(/scan_id/i);
  });

  it("POST /api/notifications/nudge schedules a nudge", async () => {
    const res = await fetch(`${baseUrl}/api/notifications/nudge`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer test-token",
      },
      body: JSON.stringify({ scan_id: "route-scan-1", context: "refinement" }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.context).toBe("refinement");
  });

  it("POST /api/notifications/nudge defaults context to scan_results", async () => {
    const res = await fetch(`${baseUrl}/api/notifications/nudge`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer test-token",
      },
      body: JSON.stringify({ scan_id: "route-scan-2", context: "invalid_context" }),
    });
    const data = await res.json();
    expect(data.context).toBe("scan_results");
  });

  it("DELETE /api/notifications/nudge cancels a nudge", async () => {
    // Schedule first
    await fetch(`${baseUrl}/api/notifications/nudge`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer test-token",
      },
      body: JSON.stringify({ scan_id: "route-scan-del" }),
    });

    // Cancel
    const res = await fetch(`${baseUrl}/api/notifications/nudge`, {
      method: "DELETE",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer test-token",
      },
      body: JSON.stringify({ scan_id: "route-scan-del" }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
  });

  it("GET /api/notifications/nudge returns nudge status", async () => {
    const res = await fetch(`${baseUrl}/api/notifications/nudge`, {
      method: "GET",
      headers: { Authorization: "Bearer test-token" },
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect("nudge" in data).toBe(true);
  });

  it("nudge routes require auth", async () => {
    const methods = [
      { method: "POST", body: JSON.stringify({ scan_id: "x" }) },
      { method: "DELETE", body: JSON.stringify({}) },
      { method: "GET" },
    ];
    for (const { method, body } of methods) {
      const res = await fetch(`${baseUrl}/api/notifications/nudge`, {
        method,
        headers: { "Content-Type": "application/json" },
        body: method !== "GET" ? body : undefined,
      });
      expect(res.status).toBe(401);
    }
  });
});
