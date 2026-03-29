/**
 * Tests for the matchLensResultToItem minimum score threshold.
 *
 * The threshold guards against false-positive attributions of Lens results
 * to items. The current threshold is >= 18, meaning:
 *
 *   - Color match alone (10 pts)           → rejected  (< 18)
 *   - Category match alone (10 pts)        → rejected  (< 18)
 *   - Category keyword alone (15 pts)      → rejected  (< 18)
 *   - Partial subcategory match (20 pts)   → accepted  (>= 18)
 *   - Subcategory exact match (30 pts)     → accepted
 *   - Brand match (25 pts)                 → accepted
 *   - Category + color (10 + 10 = 20 pts) → accepted  (>= 18)
 *   - Keyword + color (15 + 10 = 25 pts)  → accepted
 *
 * The threshold was originally 10 (accepting color-only matches), which caused
 * false attributions (e.g. a red bag attributed to a red jacket item).
 * Raising it to >= 18 requires at least one strong garment-type signal in
 * combination with another signal, or a partial/exact subcategory or brand match.
 *
 * Note: the implementation uses wordMatch() (whole-word regex) so a title like
 * "sweaters" does NOT match the subcategory "sweater" via the exact path (since
 * `\bsweater\b` won't match within "sweaters"); the plural handling checks
 * title.includes(sub.slice(0,-1)) but that is also subject to wordMatch.
 *
 * These tests use the _testExports.matchLensResultToItem function from products.js.
 */

import { describe, it, expect, vi } from "vitest";

// ─── Mocks ────────────────────────────────────────────────────────────────

vi.mock("../lib/supabase.js", () => ({
  default: {
    from: () => ({
      select: () => ({
        eq: () => ({
          single: () => Promise.resolve({ data: null, error: null }),
        }),
      }),
    }),
  },
}));

// ─── Import function under test ───────────────────────────────────────────

const { matchLensResultToItem } = await import("../services/products.js").then(
  m => m._testExports
);

// ─── Tests: signals that score below 18 are rejected ─────────────────────

describe("matchLensResultToItem — signals below threshold (< 18) are rejected", () => {
  it("color-only match (10 pts) is rejected — returns -1", () => {
    // "red" matches color field (+10). No garment keyword, no subcategory, no brand.
    // Score = 10 < 18 → return -1.
    const items = [
      { category: "top", subcategory: "blouse", brand: "Unidentified", color: "red" },
    ];
    const result = { title: "Red Abstract Artwork" };
    expect(matchLensResultToItem(result, items)).toBe(-1);
  });

  it("category match alone (10 pts) is rejected — returns -1", () => {
    // "shoes" in title matches category "shoes" (+10).
    // Note: "shoes" also triggers keyword match for "shoe" → +15 more = 25 total.
    // To isolate: use a category with no keywords in the title.
    // "accessory" as category — title "accessory store" → +10 only (no keyword like hat/belt)
    const items = [
      { category: "accessory", subcategory: "", brand: "Unidentified", color: "" },
    ];
    const result = { title: "Accessory Store Display" };
    // Score = 10 (category match) < 18 → -1
    expect(matchLensResultToItem(result, items)).toBe(-1);
  });

  it("category keyword alone (15 pts) is rejected — returns -1", () => {
    // Category "top" + keyword "shirt" in title = +15 (keyword) but cat "top" not in title
    // Score = 15 < 18 → -1
    const items = [
      { category: "top", subcategory: "polo", brand: "Unidentified", color: "" },
    ];
    // "shirt" is in the top keywords map → +15
    // "top" is not in the title → category match = 0
    // Score = 15 < 18 → return -1
    const result = { title: "Dress Shirt Formal Wear" };
    expect(matchLensResultToItem(result, items)).toBe(-1);
  });

  it("completely unrelated title scores 0 and is rejected", () => {
    const items = [
      { category: "shoes", subcategory: "sneaker", brand: "Nike", color: "white" },
    ];
    const result = { title: "Professional Photography Service" };
    expect(matchLensResultToItem(result, items)).toBe(-1);
  });
});

// ─── Tests: signals at or above 18 are accepted ──────────────────────────

describe("matchLensResultToItem — signals at or above threshold (>= 18) are accepted", () => {
  it("subcategory exact match (30 pts) is accepted — returns 0", () => {
    const items = [
      { category: "bottom", subcategory: "jeans", brand: "Unidentified", color: "" },
    ];
    const result = { title: "Classic Jeans Blue" };
    // "jeans" exact subcategory match (+30) >= 18 → accepted
    expect(matchLensResultToItem(result, items)).toBe(0);
  });

  it("brand match (25 pts) is accepted — returns 0", () => {
    const items = [
      { category: "shoes", subcategory: "sneaker", brand: "Nike", color: "white" },
    ];
    const result = { title: "Nike Footwear Collection" };
    // "Nike" brand match (+25) >= 18 → accepted
    expect(matchLensResultToItem(result, items)).toBe(0);
  });

  it("keyword + color match (15 + 10 = 25 pts) is accepted — returns 0", () => {
    const items = [
      { category: "bottom", subcategory: "chinos", brand: "Unidentified", color: "black" },
    ];
    // "pants" is in bottom keywords (+15), "black" matches color (+10)
    // Total = 25 >= 18 → accepted
    const result = { title: "Black Pants Casual" };
    expect(matchLensResultToItem(result, items)).toBe(0);
  });

  it("category + color match (10 + 10 = 20 pts) is accepted — returns 0", () => {
    const items = [
      { category: "bag", subcategory: "tote", brand: "Unidentified", color: "tan" },
    ];
    // "bag" category match (+10), "tan" color match (+10) = 20 >= 18
    // Note: bag category keywords include "bag" → +15 extra = 35 total
    const result = { title: "Tan Bag" };
    expect(matchLensResultToItem(result, items)).toBe(0);
  });

  it("subcategory + color (30 + 10 = 40 pts) is accepted — returns 0", () => {
    const items = [
      { category: "bottom", subcategory: "jeans", brand: "Levi", color: "blue" },
    ];
    const result = { title: "Blue Jeans Relaxed Fit" };
    // "jeans" subcategory +30, "blue" color +10, "jeans" keyword +15 = 55
    expect(matchLensResultToItem(result, items)).toBe(0);
  });
});

// ─── Tests: multi-item disambiguation ────────────────────────────────────

describe("matchLensResultToItem — multi-item disambiguation", () => {
  const items = [
    { category: "top", subcategory: "hoodie", brand: "Unidentified", color: "grey" },
    { category: "shoes", subcategory: "sneaker", brand: "Nike", color: "white" },
  ];

  it("brand 'Nike' matches item[1] over item[0] (25 pts vs 0)", () => {
    const result = { title: "Nike Footwear" };
    // item[1]: brand "Nike" +25; item[0]: no match
    expect(matchLensResultToItem(result, items)).toBe(1);
  });

  it("subcategory 'hoodie' matches item[0] (30+ pts vs item[1])", () => {
    const result = { title: "Grey Hoodie Pullover" };
    // item[0]: "hoodie" subcategory +30, "grey" color +10, "hoodie" keyword +15 = 55
    // item[1]: no meaningful match
    expect(matchLensResultToItem(result, items)).toBe(0);
  });

  it("subcategory 'sneaker' matches item[1] (30+ pts vs item[0])", () => {
    const result = { title: "White Sneaker Running" };
    // item[1]: "sneaker" +30, "white" color +10, "sneaker" keyword +15 = 55
    expect(matchLensResultToItem(result, items)).toBe(1);
  });

  it("empty items array always returns -1", () => {
    const result = { title: "Nike Blue Hoodie Sneakers" };
    expect(matchLensResultToItem(result, [])).toBe(-1);
  });

  it("empty title returns -1 regardless of item signals", () => {
    const result = { title: "" };
    expect(matchLensResultToItem(result, items)).toBe(-1);
  });
});

// ─── Tests: the old threshold of 10 would have incorrectly accepted color-only ──

describe("matchLensResultToItem — documents regression: color-only no longer causes false attribution", () => {
  it("gold clutch result is not attributed to gold jacket item (color-only, rejected)", () => {
    // Before the threshold increase, a gold color match (10 pts) would attribute
    // this bag result to the jacket item. Now it's correctly rejected.
    const items = [
      { category: "outerwear", subcategory: "jacket", brand: "Unidentified", color: "gold" },
    ];
    // Title is about a bag but happens to contain the color "gold"
    // No jacket keywords ("jacket", "coat", etc.) in the title
    const result = { title: "Gold Clutch Evening Bag" };
    // "gold" color match (+10), "bag" is outerwear keyword? No — "bag" is in the bag category.
    // outerwear keywords: jacket, coat, blazer, parka, vest, cardigan, bomber
    // Score for this item: "gold" color +10 = 10. No jacket keyword in "Gold Clutch Evening Bag"
    // 10 < 18 → rejected (correct!)
    expect(matchLensResultToItem(result, items)).toBe(-1);
  });

  it("red bag result is not attributed to red dress item (color-only cross-category)", () => {
    const items = [
      { category: "dress", subcategory: "gown", brand: "Unidentified", color: "red" },
    ];
    // "red" in title matches color (+10), but "purse" is not a dress keyword
    const result = { title: "Red Leather Purse Handbag" };
    // item: "red" color +10, "purse" is in bag keywords (not dress) → +0 for dress item
    // "bag" is bag keyword, not dress keyword
    // Score = 10 < 18 → rejected
    expect(matchLensResultToItem(result, items)).toBe(-1);
  });
});
