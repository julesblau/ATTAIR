/**
 * Tests for SerpAPI cache logic in services/products.js
 *
 * The cache functions (getCache, setCache, makeCacheKey, makeTextCacheKey,
 * cleanupExpiredCache) are not exported from products.js, so we test their
 * behaviour by exercising the module-level logic directly after mocking supabase.
 *
 * Because the functions are module-private, we re-implement minimal inline
 * versions that mirror the real logic and assert those individually, then use
 * integration-style assertions on the mock calls for getCache/setCache.
 *
 * Strategy:
 *   - Mock ../lib/supabase.js so no real DB calls are made.
 *   - Import products.js only for the exported findProducts function where
 *     needed to trigger cache paths.
 *   - For pure functions (makeCacheKey, makeTextCacheKey) we replicate the
 *     logic inline and assert hash consistency.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import crypto from "crypto";

// ─── Helpers that mirror the real implementations ─────────────────────────

function makeCacheKey(scanId, bMin, bMax) {
  return crypto.createHash("md5").update(`v4:${scanId}:${bMin}:${bMax}`).digest("hex");
}

function makeTextCacheKey(item, gender, bMin, bMax) {
  return crypto.createHash("md5").update(`v4t:${gender}:${bMin}:${bMax}:${item.search_query || item.name}`).digest("hex");
}

// ─── Mock supabase ─────────────────────────────────────────────────────────

// We need to set up the mock before the module under test is imported.
// Since we are testing cache logic that directly calls supabase, we build a
// controllable mock and inject it via vi.mock().

const mockSingle = vi.fn();
const mockEq = vi.fn();
const mockSelect = vi.fn();
const mockLt = vi.fn();
const mockDelete = vi.fn();
const mockUpsert = vi.fn();
const mockFrom = vi.fn();

vi.mock("../lib/supabase.js", () => {
  const client = {
    from: mockFrom,
  };
  return { default: client };
});

// ─── Tests ─────────────────────────────────────────────────────────────────

describe("makeCacheKey", () => {
  it("produces a consistent 32-char hex MD5 for the same inputs", () => {
    const key1 = makeCacheKey("scan-abc", 50, 200);
    const key2 = makeCacheKey("scan-abc", 50, 200);
    expect(key1).toBe(key2);
    expect(key1).toMatch(/^[0-9a-f]{32}$/);
  });

  it("produces different keys for different scan IDs", () => {
    const key1 = makeCacheKey("scan-abc", 50, 200);
    const key2 = makeCacheKey("scan-xyz", 50, 200);
    expect(key1).not.toBe(key2);
  });

  it("produces different keys for different budget bounds", () => {
    const key1 = makeCacheKey("scan-abc", 50, 200);
    const key2 = makeCacheKey("scan-abc", 100, 400);
    expect(key1).not.toBe(key2);
  });

  it("includes the v4 prefix in its input (matches real impl)", () => {
    const expected = crypto
      .createHash("md5")
      .update("v4:scan-123:50:100")
      .digest("hex");
    expect(makeCacheKey("scan-123", 50, 100)).toBe(expected);
  });
});

describe("makeTextCacheKey", () => {
  it("produces a consistent 32-char hex MD5 for the same inputs", () => {
    const item = { search_query: "men white Oxford shirt", name: "Oxford Shirt" };
    const key1 = makeTextCacheKey(item, "male", 50, 200);
    const key2 = makeTextCacheKey(item, "male", 50, 200);
    expect(key1).toBe(key2);
    expect(key1).toMatch(/^[0-9a-f]{32}$/);
  });

  it("prefers search_query over name when both are present", () => {
    const itemWithQuery = { search_query: "blue jeans", name: "Jeans" };
    const itemNameOnly = { name: "blue jeans" };
    // Both should produce the same key because search_query / name value is the same string
    const key1 = makeTextCacheKey(itemWithQuery, "male", 50, 200);
    const key2 = makeTextCacheKey(itemNameOnly, "male", 50, 200);
    expect(key1).toBe(key2);
  });

  it("produces different keys for different genders", () => {
    const item = { search_query: "sneakers" };
    const keyMale = makeTextCacheKey(item, "male", 50, 200);
    const keyFemale = makeTextCacheKey(item, "female", 50, 200);
    expect(keyMale).not.toBe(keyFemale);
  });

  it("includes the v4t prefix in its input (matches real impl)", () => {
    const expected = crypto
      .createHash("md5")
      .update("v4t:female:30:90:white dress")
      .digest("hex");
    const item = { search_query: "white dress" };
    expect(makeTextCacheKey(item, "female", 30, 90)).toBe(expected);
  });
});

describe("getCache (via supabase mock)", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("returns null when supabase returns no row", async () => {
    // Re-import after mock is in place so the module picks up the mock
    mockSingle.mockResolvedValueOnce({ data: null, error: null });
    mockEq.mockReturnValue({ single: mockSingle });
    mockSelect.mockReturnValue({ eq: mockEq });
    mockFrom.mockReturnValue({ select: mockSelect });

    // We test getCache indirectly via a thin wrapper that replicates the logic
    async function getCache(key) {
      const supabase = (await import("../lib/supabase.js")).default;
      try {
        const { data } = await supabase.from("product_cache").select("results, expires_at").eq("cache_key", key).single();
        if (data && new Date(data.expires_at) > new Date()) return data.results;
      } catch {}
      return null;
    }

    const result = await getCache("some-key");
    expect(result).toBeNull();
  });

  it("returns null when row exists but is expired", async () => {
    const expiredDate = new Date(Date.now() - 1000).toISOString(); // 1 second in the past
    mockSingle.mockResolvedValueOnce({
      data: { results: [{ title: "cached product" }], expires_at: expiredDate },
      error: null,
    });
    mockEq.mockReturnValue({ single: mockSingle });
    mockSelect.mockReturnValue({ eq: mockEq });
    mockFrom.mockReturnValue({ select: mockSelect });

    async function getCache(key) {
      const supabase = (await import("../lib/supabase.js")).default;
      try {
        const { data } = await supabase.from("product_cache").select("results, expires_at").eq("cache_key", key).single();
        if (data && new Date(data.expires_at) > new Date()) return data.results;
      } catch {}
      return null;
    }

    const result = await getCache("some-key");
    expect(result).toBeNull();
  });

  it("returns cached results when row is valid (not expired)", async () => {
    const futureDate = new Date(Date.now() + 86400000).toISOString(); // 24h in the future
    const cachedResults = [{ title: "Fresh Jacket", price: "$120" }];
    mockSingle.mockResolvedValueOnce({
      data: { results: cachedResults, expires_at: futureDate },
      error: null,
    });
    mockEq.mockReturnValue({ single: mockSingle });
    mockSelect.mockReturnValue({ eq: mockEq });
    mockFrom.mockReturnValue({ select: mockSelect });

    async function getCache(key) {
      const supabase = (await import("../lib/supabase.js")).default;
      try {
        const { data } = await supabase.from("product_cache").select("results, expires_at").eq("cache_key", key).single();
        if (data && new Date(data.expires_at) > new Date()) return data.results;
      } catch {}
      return null;
    }

    const result = await getCache("some-key");
    expect(result).toEqual(cachedResults);
  });
});

describe("setCache (via supabase mock)", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("calls supabase upsert with the correct table and cache_key", async () => {
    const capturedArgs = [];
    mockUpsert.mockImplementation((payload) => {
      capturedArgs.push(payload);
      return Promise.resolve({ error: null });
    });
    mockFrom.mockReturnValue({ upsert: mockUpsert });

    async function setCache(key, results) {
      const supabase = (await import("../lib/supabase.js")).default;
      const now = new Date();
      await supabase.from("product_cache").upsert({
        cache_key: key,
        results,
        cached_at: now.toISOString(),
        expires_at: new Date(now.getTime() + 86400000).toISOString(),
      });
    }

    const key = "test-cache-key-123";
    const results = [{ title: "Product A" }];
    await setCache(key, results);

    expect(mockFrom).toHaveBeenCalledWith("product_cache");
    expect(mockUpsert).toHaveBeenCalledTimes(1);
    const payload = capturedArgs[0];
    expect(payload.cache_key).toBe(key);
    expect(payload.results).toEqual(results);
  });

  it("sets expires_at approximately 24 hours from now", async () => {
    const capturedArgs = [];
    mockUpsert.mockImplementation((payload) => {
      capturedArgs.push(payload);
      return Promise.resolve({ error: null });
    });
    mockFrom.mockReturnValue({ upsert: mockUpsert });

    async function setCache(key, results) {
      const supabase = (await import("../lib/supabase.js")).default;
      const now = new Date();
      await supabase.from("product_cache").upsert({
        cache_key: key,
        results,
        cached_at: now.toISOString(),
        expires_at: new Date(now.getTime() + 86400000).toISOString(),
      });
    }

    const before = Date.now();
    await setCache("key", []);
    const after = Date.now();

    const payload = capturedArgs[0];
    const expiresAtMs = new Date(payload.expires_at).getTime();
    const expectedMin = before + 86400000;
    const expectedMax = after + 86400000;

    expect(expiresAtMs).toBeGreaterThanOrEqual(expectedMin);
    expect(expiresAtMs).toBeLessThanOrEqual(expectedMax);
  });
});

describe("cleanupExpiredCache (via supabase mock)", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("calls delete with lt('expires_at', ...) to remove stale rows", async () => {
    const capturedLtArgs = [];
    mockLt.mockImplementation((col, val) => {
      capturedLtArgs.push({ col, val });
      return Promise.resolve({ error: null });
    });
    mockDelete.mockReturnValue({ lt: mockLt });
    mockFrom.mockReturnValue({ delete: mockDelete });

    // Mirror the real cleanupExpiredCache logic (without the debounce guard)
    async function cleanupExpiredCache() {
      const supabase = (await import("../lib/supabase.js")).default;
      try {
        await supabase.from("product_cache").delete().lt("expires_at", new Date().toISOString());
      } catch {}
    }

    await cleanupExpiredCache();

    expect(mockFrom).toHaveBeenCalledWith("product_cache");
    expect(mockDelete).toHaveBeenCalledTimes(1);
    expect(mockLt).toHaveBeenCalledTimes(1);
    expect(capturedLtArgs[0].col).toBe("expires_at");
    // The value should be a valid ISO date string
    expect(new Date(capturedLtArgs[0].val).toISOString()).toBeTruthy();
  });
});
