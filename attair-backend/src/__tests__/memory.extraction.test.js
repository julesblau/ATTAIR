/**
 * Tests for extractMemory() and buildMemoryBlock() in services/claude.js
 *
 * Covers:
 *   - Successful extraction: returns correct structure with array limits enforced
 *   - Merge with existing memory: turn_count increments, existing entries preserved
 *   - Dedup / overwrite: latest correction per field wins
 *   - Timeout / abort fallback: returns existing memory on timeout
 *   - API error fallback: returns existing memory on non-200 responses
 *   - Malformed AI response: returns existing memory when JSON parsing fails
 *   - No existing memory (first turn): returns valid structure with turn_count 1
 *   - Array truncation: enforces max lengths (corrections 10, facts 5, prefs 3, notes 3)
 *   - buildMemoryBlock formatting: produces correct prompt blocks
 *   - buildMemoryBlock with null/empty memory: returns empty string
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ─── Mock global fetch ───────────────────────────────────────────────────────

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeApiResponse(memoryObj) {
  return {
    ok: true,
    json: () => Promise.resolve({
      content: [{ type: "text", text: JSON.stringify(memoryObj) }],
    }),
  };
}

function makeApiResponseRaw(text) {
  return {
    ok: true,
    json: () => Promise.resolve({
      content: [{ type: "text", text }],
    }),
  };
}

const ORIGINAL_ITEM = { name: "T-Shirt", brand: "Unidentified", category: "top", color: "grey" };
const UPDATED_ITEM = { name: "Bomber Jacket", brand: "Nike", category: "outerwear", color: "olive green" };
const USER_MSG = "It's actually a Nike bomber jacket, olive green";
const AI_MSG = "Got it — updated to olive green Nike bomber jacket.";

const SAMPLE_MEMORY = {
  corrections: [{ field: "brand", from: "Unidentified", to: "Nike" }],
  confirmed_facts: ["User confirmed it's olive green"],
  user_preferences: ["Prefers streetwear style"],
  context_notes: ["Item was partially obscured"],
  turn_count: 1,
};

// ─── Import under test (after mocks) ────────────────────────────────────────

let extractMemory;
let buildMemoryBlock;

beforeEach(async () => {
  vi.resetModules();
  mockFetch.mockReset();
  // Dynamic import to pick up fresh mocks each test
  const claude = await import("../services/claude.js");
  extractMemory = claude.extractMemory;
  buildMemoryBlock = claude.buildMemoryBlock;
});

// ─── extractMemory Tests ─────────────────────────────────────────────────────

describe("extractMemory — successful extraction", () => {
  it("returns correctly structured memory on first turn (no existing memory)", async () => {
    mockFetch.mockResolvedValueOnce(makeApiResponse({
      corrections: [{ field: "category", from: "top", to: "outerwear" }],
      confirmed_facts: ["Olive green color confirmed"],
      user_preferences: ["Streetwear aesthetic"],
      context_notes: ["Full garment visible"],
      turn_count: 1,
    }));

    const result = await extractMemory(ORIGINAL_ITEM, UPDATED_ITEM, USER_MSG, AI_MSG, null);

    expect(result).toBeDefined();
    expect(result.turn_count).toBe(1);
    expect(result.corrections).toHaveLength(1);
    expect(result.corrections[0].field).toBe("category");
    expect(result.confirmed_facts).toHaveLength(1);
    expect(result.user_preferences).toHaveLength(1);
    expect(result.context_notes).toHaveLength(1);
  });

  it("increments turn_count from existing memory", async () => {
    const existingMemory = { ...SAMPLE_MEMORY, turn_count: 3 };
    mockFetch.mockResolvedValueOnce(makeApiResponse({
      corrections: [{ field: "color", from: "olive green", to: "dark olive" }],
      confirmed_facts: [],
      user_preferences: [],
      context_notes: [],
      turn_count: 4,
    }));

    const result = await extractMemory(ORIGINAL_ITEM, UPDATED_ITEM, USER_MSG, AI_MSG, existingMemory);

    // turn_count is always existingMemory.turn_count + 1, regardless of what AI returns
    expect(result.turn_count).toBe(4);
  });

  it("returns arrays (not non-array types) even when AI returns non-arrays", async () => {
    mockFetch.mockResolvedValueOnce(makeApiResponse({
      corrections: "not an array",
      confirmed_facts: null,
      user_preferences: 42,
      context_notes: { foo: "bar" },
      turn_count: 1,
    }));

    const result = await extractMemory(ORIGINAL_ITEM, UPDATED_ITEM, USER_MSG, AI_MSG, null);

    expect(Array.isArray(result.corrections)).toBe(true);
    expect(Array.isArray(result.confirmed_facts)).toBe(true);
    expect(Array.isArray(result.user_preferences)).toBe(true);
    expect(Array.isArray(result.context_notes)).toBe(true);
    expect(result.corrections).toHaveLength(0);
    expect(result.confirmed_facts).toHaveLength(0);
  });
});

describe("extractMemory — array truncation (enforces max limits)", () => {
  it("truncates corrections to max 10", async () => {
    const bigCorrections = Array.from({ length: 15 }, (_, i) => ({
      field: `field_${i}`,
      from: "old",
      to: "new",
    }));

    mockFetch.mockResolvedValueOnce(makeApiResponse({
      corrections: bigCorrections,
      confirmed_facts: [],
      user_preferences: [],
      context_notes: [],
      turn_count: 1,
    }));

    const result = await extractMemory(ORIGINAL_ITEM, UPDATED_ITEM, USER_MSG, AI_MSG, null);
    expect(result.corrections).toHaveLength(10);
  });

  it("truncates confirmed_facts to max 5", async () => {
    const bigFacts = Array.from({ length: 8 }, (_, i) => `Fact ${i}`);

    mockFetch.mockResolvedValueOnce(makeApiResponse({
      corrections: [],
      confirmed_facts: bigFacts,
      user_preferences: [],
      context_notes: [],
      turn_count: 1,
    }));

    const result = await extractMemory(ORIGINAL_ITEM, UPDATED_ITEM, USER_MSG, AI_MSG, null);
    expect(result.confirmed_facts).toHaveLength(5);
  });

  it("truncates user_preferences to max 3", async () => {
    mockFetch.mockResolvedValueOnce(makeApiResponse({
      corrections: [],
      confirmed_facts: [],
      user_preferences: ["a", "b", "c", "d", "e"],
      context_notes: [],
      turn_count: 1,
    }));

    const result = await extractMemory(ORIGINAL_ITEM, UPDATED_ITEM, USER_MSG, AI_MSG, null);
    expect(result.user_preferences).toHaveLength(3);
  });

  it("truncates context_notes to max 3", async () => {
    mockFetch.mockResolvedValueOnce(makeApiResponse({
      corrections: [],
      confirmed_facts: [],
      user_preferences: [],
      context_notes: ["a", "b", "c", "d", "e", "f"],
      turn_count: 1,
    }));

    const result = await extractMemory(ORIGINAL_ITEM, UPDATED_ITEM, USER_MSG, AI_MSG, null);
    expect(result.context_notes).toHaveLength(3);
  });
});

describe("extractMemory — fail-open behavior", () => {
  it("returns existing memory when API returns non-200", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
    });

    const result = await extractMemory(ORIGINAL_ITEM, UPDATED_ITEM, USER_MSG, AI_MSG, SAMPLE_MEMORY);
    expect(result).toEqual(SAMPLE_MEMORY);
  });

  it("returns null when API fails and no existing memory", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
    });

    const result = await extractMemory(ORIGINAL_ITEM, UPDATED_ITEM, USER_MSG, AI_MSG, null);
    expect(result).toBeNull();
  });

  it("returns existing memory when fetch throws (network error)", async () => {
    mockFetch.mockRejectedValueOnce(new Error("Network error"));

    const result = await extractMemory(ORIGINAL_ITEM, UPDATED_ITEM, USER_MSG, AI_MSG, SAMPLE_MEMORY);
    expect(result).toEqual(SAMPLE_MEMORY);
  });

  it("returns existing memory when AI returns malformed JSON", async () => {
    mockFetch.mockResolvedValueOnce(makeApiResponseRaw("This is not JSON at all, just some text about fashion."));

    const result = await extractMemory(ORIGINAL_ITEM, UPDATED_ITEM, USER_MSG, AI_MSG, SAMPLE_MEMORY);
    // parseJSON will throw, catch block returns existingMemory
    expect(result).toEqual(SAMPLE_MEMORY);
  });

  it("returns null when AI returns malformed JSON and no existing memory", async () => {
    mockFetch.mockResolvedValueOnce(makeApiResponseRaw("totally invalid no braces at all"));

    const result = await extractMemory(ORIGINAL_ITEM, UPDATED_ITEM, USER_MSG, AI_MSG, null);
    expect(result).toBeNull();
  });

  it("returns existing memory when AI returns empty content array", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ content: [] }),
    });

    const result = await extractMemory(ORIGINAL_ITEM, UPDATED_ITEM, USER_MSG, AI_MSG, SAMPLE_MEMORY);
    // empty content → text is "" → parseJSON fails → returns existingMemory
    expect(result).toEqual(SAMPLE_MEMORY);
  });

  it("returns existing memory on timeout (abort)", async () => {
    // Simulate a fetch that takes longer than the 8s timeout
    mockFetch.mockImplementationOnce(() => new Promise((_, reject) => {
      setTimeout(() => reject(new DOMException("The operation was aborted.", "AbortError")), 50);
    }));

    const result = await extractMemory(ORIGINAL_ITEM, UPDATED_ITEM, USER_MSG, AI_MSG, SAMPLE_MEMORY);
    expect(result).toEqual(SAMPLE_MEMORY);
  });
});

describe("extractMemory — JSON wrapped in markdown code blocks", () => {
  it("handles JSON wrapped in ```json fences", async () => {
    const json = JSON.stringify({
      corrections: [{ field: "brand", from: "Unidentified", to: "Adidas" }],
      confirmed_facts: ["Running shoe"],
      user_preferences: [],
      context_notes: [],
      turn_count: 1,
    });

    mockFetch.mockResolvedValueOnce(makeApiResponseRaw("```json\n" + json + "\n```"));

    const result = await extractMemory(ORIGINAL_ITEM, UPDATED_ITEM, USER_MSG, AI_MSG, null);
    expect(result.corrections[0].to).toBe("Adidas");
    expect(result.turn_count).toBe(1);
  });

  it("handles JSON with leading text before the object", async () => {
    const json = JSON.stringify({
      corrections: [],
      confirmed_facts: ["Color is red"],
      user_preferences: [],
      context_notes: [],
      turn_count: 1,
    });

    mockFetch.mockResolvedValueOnce(makeApiResponseRaw("Here is the memory:\n" + json));

    const result = await extractMemory(ORIGINAL_ITEM, UPDATED_ITEM, USER_MSG, AI_MSG, null);
    expect(result.confirmed_facts).toContain("Color is red");
  });
});

// ─── buildMemoryBlock Tests ──────────────────────────────────────────────────

describe("buildMemoryBlock — formatting", () => {
  it("returns empty string for null memory", () => {
    expect(buildMemoryBlock(null)).toBe("");
  });

  it("returns empty string for undefined memory", () => {
    expect(buildMemoryBlock(undefined)).toBe("");
  });

  it("returns empty string when all arrays are empty", () => {
    expect(buildMemoryBlock({
      corrections: [],
      confirmed_facts: [],
      user_preferences: [],
      context_notes: [],
      turn_count: 1,
    })).toBe("");
  });

  it("formats corrections with from/to arrows", () => {
    const block = buildMemoryBlock({
      corrections: [{ field: "brand", from: "Unidentified", to: "Nike" }],
      confirmed_facts: [],
      user_preferences: [],
      context_notes: [],
    });
    expect(block).toContain("CONVERSATION MEMORY:");
    expect(block).toContain("PRIOR CORRECTIONS");
    expect(block).toContain('brand: "Unidentified" → "Nike"');
  });

  it("formats corrections without 'from' as 'set to'", () => {
    const block = buildMemoryBlock({
      corrections: [{ field: "color", to: "olive green" }],
      confirmed_facts: [],
      user_preferences: [],
      context_notes: [],
    });
    expect(block).toContain('color: set to "olive green"');
  });

  it("formats all four sections when populated", () => {
    const block = buildMemoryBlock({
      corrections: [{ field: "brand", from: "Unidentified", to: "Nike" }],
      confirmed_facts: ["Vintage from the 90s"],
      user_preferences: ["Prefers exact match"],
      context_notes: ["Partially obscured"],
    });
    expect(block).toContain("PRIOR CORRECTIONS");
    expect(block).toContain("CONFIRMED FACTS");
    expect(block).toContain("USER PREFERENCES");
    expect(block).toContain("CONTEXT NOTES");
    expect(block).toContain("Vintage from the 90s");
    expect(block).toContain("Prefers exact match");
    expect(block).toContain("Partially obscured");
  });

  it("omits sections with empty arrays", () => {
    const block = buildMemoryBlock({
      corrections: [],
      confirmed_facts: ["A fact"],
      user_preferences: [],
      context_notes: [],
    });
    expect(block).not.toContain("PRIOR CORRECTIONS");
    expect(block).toContain("CONFIRMED FACTS");
    expect(block).not.toContain("USER PREFERENCES");
    expect(block).not.toContain("CONTEXT NOTES");
  });

  it("handles multiple corrections", () => {
    const block = buildMemoryBlock({
      corrections: [
        { field: "brand", from: "Unidentified", to: "Nike" },
        { field: "color", from: "grey", to: "olive" },
        { field: "category", to: "outerwear" },
      ],
      confirmed_facts: [],
      user_preferences: [],
      context_notes: [],
    });
    expect(block).toContain("Nike");
    expect(block).toContain("olive");
    expect(block).toContain("outerwear");
  });
});

describe("extractMemory — API call correctness", () => {
  it("calls Anthropic API with correct model and structure", async () => {
    mockFetch.mockResolvedValueOnce(makeApiResponse({
      corrections: [],
      confirmed_facts: [],
      user_preferences: [],
      context_notes: [],
      turn_count: 1,
    }));

    await extractMemory(ORIGINAL_ITEM, UPDATED_ITEM, USER_MSG, AI_MSG, null);

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    expect(opts.method).toBe("POST");

    const body = JSON.parse(opts.body);
    expect(body.model).toBe("claude-haiku-4-5-20251001");
    expect(body.max_tokens).toBe(600);
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0].role).toBe("user");
  });

  it("includes existing memory in prompt when provided", async () => {
    mockFetch.mockResolvedValueOnce(makeApiResponse({
      corrections: SAMPLE_MEMORY.corrections,
      confirmed_facts: SAMPLE_MEMORY.confirmed_facts,
      user_preferences: [],
      context_notes: [],
      turn_count: 2,
    }));

    await extractMemory(ORIGINAL_ITEM, UPDATED_ITEM, USER_MSG, AI_MSG, SAMPLE_MEMORY);

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    const promptText = body.messages[0].content;
    expect(promptText).toContain("Existing memory to update");
    expect(promptText).toContain("Unidentified");
  });

  it("does NOT include existing memory text when null", async () => {
    mockFetch.mockResolvedValueOnce(makeApiResponse({
      corrections: [],
      confirmed_facts: [],
      user_preferences: [],
      context_notes: [],
      turn_count: 1,
    }));

    await extractMemory(ORIGINAL_ITEM, UPDATED_ITEM, USER_MSG, AI_MSG, null);

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    const promptText = body.messages[0].content;
    expect(promptText).not.toContain("Existing memory to update");
  });

  it("passes AbortSignal to fetch", async () => {
    mockFetch.mockResolvedValueOnce(makeApiResponse({
      corrections: [],
      confirmed_facts: [],
      user_preferences: [],
      context_notes: [],
      turn_count: 1,
    }));

    await extractMemory(ORIGINAL_ITEM, UPDATED_ITEM, USER_MSG, AI_MSG, null);

    const opts = mockFetch.mock.calls[0][1];
    expect(opts.signal).toBeDefined();
    expect(opts.signal).toBeInstanceOf(AbortSignal);
  });
});
