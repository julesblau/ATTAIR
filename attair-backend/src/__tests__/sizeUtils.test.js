/**
 * Tests for formatSizeQuery (services/sizeUtils.js)
 *
 * Covers:
 *   A. Returns "" for unknown categories
 *   B. Returns "size M" for tops with top_size
 *   C. Returns "size 32x30" for jeans with waist+inseam
 *   D. Returns "size 10" for shoes with shoe_size
 *   E. Returns "" for one_size items (beanie)
 *   F. Returns "" when no user sizes provided
 */

import { describe, it, expect } from "vitest";
import { formatSizeQuery } from "../services/sizeUtils.js";

describe("formatSizeQuery — unknown / missing categories", () => {
  it("returns empty string for an unknown category", () => {
    expect(formatSizeQuery("scarf", { top_size: "M" })).toBe("");
  });

  it("returns empty string for undefined subcategory", () => {
    expect(formatSizeQuery(undefined, { top_size: "M" })).toBe("");
  });

  it("returns empty string for null subcategory", () => {
    expect(formatSizeQuery(null, { top_size: "M" })).toBe("");
  });

  it("returns empty string for empty string subcategory", () => {
    expect(formatSizeQuery("", { shoe_size: "10" })).toBe("");
  });
});

describe("formatSizeQuery — tops (letter sizing)", () => {
  it("returns 'size M' for t-shirt with top_size M", () => {
    expect(formatSizeQuery("t-shirt", { top_size: "M" })).toBe("size M");
  });

  it("returns 'size L' for hoodie with top_size L", () => {
    expect(formatSizeQuery("hoodie", { top_size: "L" })).toBe("size L");
  });

  it("returns 'size XL' for shirt with top_size XL", () => {
    expect(formatSizeQuery("shirt", { top_size: "XL" })).toBe("size XL");
  });

  it("returns 'size S' for sweater with top_size S", () => {
    expect(formatSizeQuery("sweater", { top_size: "S" })).toBe("size S");
  });

  it("returns 'size XL' for jacket with top_size XL", () => {
    expect(formatSizeQuery("jacket", { top_size: "XL" })).toBe("size XL");
  });

  it("falls back to size key when top_size absent", () => {
    expect(formatSizeQuery("t-shirt", { size: "L" })).toBe("size L");
  });

  it("returns empty string for top with no size prefs", () => {
    expect(formatSizeQuery("t-shirt", {})).toBe("");
  });
});

describe("formatSizeQuery — jeans/pants (waist x length sizing)", () => {
  it("returns 'size 32x30' for jeans with waist=32 and inseam=30", () => {
    expect(formatSizeQuery("jeans", { waist: 32, inseam: 30 })).toBe("size 32x30");
  });

  it("returns 'size 34x32' for pants with waist=34 and inseam=32", () => {
    expect(formatSizeQuery("pants", { waist: 34, inseam: 32 })).toBe("size 34x32");
  });

  it("returns 'size 30x30' for trousers with waist=30 and length=30", () => {
    expect(formatSizeQuery("trousers", { waist: 30, length: 30 })).toBe("size 30x30");
  });

  it("returns 'size 32' for jeans with only waist (no inseam)", () => {
    expect(formatSizeQuery("jeans", { waist: 32 })).toBe("size 32");
  });

  it("returns empty string for jeans with no size prefs", () => {
    expect(formatSizeQuery("jeans", {})).toBe("");
  });

  it("returns empty string for jeans with only inseam (no waist)", () => {
    expect(formatSizeQuery("jeans", { inseam: 30 })).toBe("");
  });
});

describe("formatSizeQuery — shoes (numeric sizing)", () => {
  it("returns 'size 10' for sneakers with shoe_size=10", () => {
    expect(formatSizeQuery("sneakers", { shoe_size: 10 })).toBe("size 10");
  });

  it("returns 'size 8.5' for shoes with shoe_size=8.5", () => {
    expect(formatSizeQuery("shoes", { shoe_size: 8.5 })).toBe("size 8.5");
  });

  it("returns 'size 11' for boots with shoe_size=11", () => {
    expect(formatSizeQuery("boots", { shoe_size: 11 })).toBe("size 11");
  });

  it("uses shoe_size_men key for male gender", () => {
    expect(formatSizeQuery("sneakers", { shoe_size_men: 10 }, "male")).toBe("size 10");
  });

  it("uses shoe_size_women key for female gender", () => {
    expect(formatSizeQuery("sneakers", { shoe_size_women: 8 }, "female")).toBe("size 8");
  });

  it("falls back to shoe_size when gender-specific key absent", () => {
    expect(formatSizeQuery("sneakers", { shoe_size: 9 }, "female")).toBe("size 9");
  });

  it("returns empty string for shoes with no size prefs", () => {
    expect(formatSizeQuery("shoes", {})).toBe("");
  });
});

describe("formatSizeQuery — one_size items (beanie)", () => {
  it("returns empty string for beanie regardless of user sizes", () => {
    expect(formatSizeQuery("beanie", { top_size: "M", shoe_size: 10 })).toBe("");
  });

  it("returns empty string for beanie with no user sizes", () => {
    expect(formatSizeQuery("beanie", {})).toBe("");
  });
});

describe("formatSizeQuery — no user sizes provided", () => {
  it("returns empty string for jeans with undefined userSizes", () => {
    expect(formatSizeQuery("jeans", undefined)).toBe("");
  });

  it("returns empty string for sneakers with undefined userSizes", () => {
    expect(formatSizeQuery("sneakers", undefined)).toBe("");
  });

  it("returns empty string for t-shirt with undefined userSizes", () => {
    expect(formatSizeQuery("t-shirt", undefined)).toBe("");
  });

  it("returns empty string for jeans with empty object", () => {
    expect(formatSizeQuery("jeans", {})).toBe("");
  });
});

describe("formatSizeQuery — dress sizing", () => {
  it("returns 'size 8' for dress with dress_size=8", () => {
    expect(formatSizeQuery("dress", { dress_size: 8 })).toBe("size 8");
  });

  it("returns 'size 4' for skirt with dress_size=4", () => {
    expect(formatSizeQuery("skirt", { dress_size: 4 })).toBe("size 4");
  });

  it("returns empty string for dress with no dress_size", () => {
    expect(formatSizeQuery("dress", {})).toBe("");
  });
});

describe("formatSizeQuery — case insensitivity", () => {
  it("matches 'Jeans' (title case) to jeans category", () => {
    expect(formatSizeQuery("Jeans", { waist: 32, inseam: 30 })).toBe("size 32x30");
  });

  it("matches 'SNEAKERS' (all caps) to sneakers category", () => {
    expect(formatSizeQuery("SNEAKERS", { shoe_size: 10 })).toBe("size 10");
  });
});
