/**
 * Tests for the v5 search-refactor additions in services/products.js:
 *   - buildShoppingQueries
 *   - stripShoppingNoise
 *   - getSynonyms
 *   - synonym scoring path in scoreProduct
 *   - score-floor / text-boost assertions
 *   - scan_id ownership check in POST /saved (structural verification)
 *
 * All three functions are exported via _testExports specifically for this
 * test suite. scoreProduct is also exported there and is called directly so
 * no mocking of the full pipeline is needed.
 *
 * External services (supabase, SerpAPI) are mocked to prevent any real network
 * calls. Tests must pass with no .env file present.
 */

import { describe, it, expect, vi } from "vitest";

// ─── Mock external services so the module can be imported cleanly ──────────
vi.mock("../lib/supabase.js", () => {
  return {
    default: {
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            single: vi.fn().mockResolvedValue({ data: null, error: null }),
            maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
          }),
          lt: vi.fn().mockResolvedValue({ error: null }),
        }),
        insert: vi.fn().mockResolvedValue({ data: null, error: null }),
        upsert: vi.fn().mockResolvedValue({ error: null }),
        delete: vi.fn().mockReturnValue({
          eq: vi.fn().mockResolvedValue({ error: null }),
          lt: vi.fn().mockResolvedValue({ error: null }),
        }),
      }),
    },
  };
});

import {
  _testExports,
} from "../services/products.js";

const { buildShoppingQueries, stripShoppingNoise, getSynonyms, scoreProduct, isVendorPage } = _testExports;

// ═══════════════════════════════════════════════════════════════
// A. buildShoppingQueries
// ═══════════════════════════════════════════════════════════════

describe("buildShoppingQueries", () => {
  it("returns at least 1 query for any valid item", () => {
    const item = { category: "top", subcategory: "hoodie", brand: "", color: "" };
    const queries = buildShoppingQueries(item, "male");
    expect(queries.length).toBeGreaterThanOrEqual(1);
  });

  it("all returned queries are under 80 characters", () => {
    const item = {
      brand: "Ralph Lauren",
      color: "navy",
      subcategory: "dress shirt",
      category: "top",
    };
    const queries = buildShoppingQueries(item, "male");
    for (const q of queries) {
      expect(q.length).toBeLessThan(80);
    }
  });

  it("first query is '{gender} {brand} {subcategory}' when brand is known", () => {
    const item = { brand: "Nike", color: "black", subcategory: "hoodie", category: "top" };
    const queries = buildShoppingQueries(item, "male");
    expect(queries[0]).toBe("men's Nike hoodie");
  });

  it("first query uses 'women's' prefix for female gender", () => {
    const item = { brand: "Zara", color: "white", subcategory: "blouse", category: "top" };
    const queries = buildShoppingQueries(item, "female");
    expect(queries[0]).toBe("women's Zara blouse");
  });

  it("includes a '{gender} {color} {subcategory}' query when color is set", () => {
    const item = { brand: "", color: "red", subcategory: "sneakers", category: "shoes" };
    const queries = buildShoppingQueries(item, "male");
    expect(queries).toContain("men's red sneakers");
  });

  it("does NOT include a brand query when brand is absent", () => {
    const item = { brand: "", color: "blue", subcategory: "chinos", category: "bottom" };
    const queries = buildShoppingQueries(item, "male");
    // No query should look like "men's  chinos" or begin with a double-space
    for (const q of queries) {
      expect(q).not.toMatch(/\s{2,}/);
    }
    // The brand-less query set should not start with a known brand keyword
    expect(queries.every(q => !q.startsWith("men's  "))).toBe(true);
  });

  it("does NOT include a brand query when brand is 'Unidentified'", () => {
    const item = { brand: "Unidentified", color: "grey", subcategory: "joggers", category: "bottom" };
    const queries = buildShoppingQueries(item, "male");
    for (const q of queries) {
      expect(q).not.toContain("Unidentified");
    }
  });

  it("last query is '{gender} {category}' — the broadest nuclear fallback", () => {
    const item = { brand: "Adidas", color: "white", subcategory: "sneakers", category: "shoes" };
    const queries = buildShoppingQueries(item, "male");
    // The last query must be the broadest — just gender + category
    const last = queries[queries.length - 1];
    expect(last).toBe("men's shoes");
  });

  it("nuclear fallback uses 'women's' for female gender", () => {
    const item = { brand: "", color: "black", subcategory: "leggings", category: "bottom" };
    const queries = buildShoppingQueries(item, "female");
    const last = queries[queries.length - 1];
    expect(last).toBe("women's bottom");
  });

  it("returns deduplicated queries — no duplicates in result", () => {
    const item = { brand: "", color: "", subcategory: "jeans", category: "bottom" };
    const queries = buildShoppingQueries(item, "male");
    const unique = [...new Set(queries)];
    expect(queries.length).toBe(unique.length);
  });

  it("works with only category (no subcategory)", () => {
    const item = { brand: "", color: "", subcategory: "", category: "outerwear" };
    const queries = buildShoppingQueries(item, "male");
    expect(queries.length).toBeGreaterThanOrEqual(1);
    expect(queries[0]).toBe("men's outerwear");
  });
});

// ═══════════════════════════════════════════════════════════════
// B. stripShoppingNoise
// ═══════════════════════════════════════════════════════════════

describe("stripShoppingNoise", () => {
  it("removes 'beautiful' from a query", () => {
    expect(stripShoppingNoise("beautiful blue dress")).toBe("blue dress");
  });

  it("removes 'stylish' from a query", () => {
    expect(stripShoppingNoise("stylish men's chinos")).toBe("men's chinos");
  });

  it("removes 'premium' from a query", () => {
    expect(stripShoppingNoise("premium leather jacket")).toBe("leather jacket");
  });

  it("removes 'comfortable' from a query", () => {
    expect(stripShoppingNoise("comfortable cotton t-shirt")).toBe("cotton t-shirt");
  });

  it("removes 'breathable' from a query", () => {
    expect(stripShoppingNoise("breathable linen shirt")).toBe("linen shirt");
  });

  it("removes 'tailored' from a query", () => {
    expect(stripShoppingNoise("tailored wool blazer")).toBe("wool blazer");
  });

  it("removes multiple noise words in one pass", () => {
    const result = stripShoppingNoise("beautiful stylish premium hoodie");
    expect(result).toBe("hoodie");
  });

  it("preserves real Shopping terms like 'slim fit'", () => {
    const result = stripShoppingNoise("slim fit chinos");
    expect(result).toBe("slim fit chinos");
  });

  it("preserves 'cotton' (a real material keyword)", () => {
    const result = stripShoppingNoise("cotton Oxford shirt");
    expect(result).toBe("cotton Oxford shirt");
  });

  it("preserves brand names unchanged", () => {
    const result = stripShoppingNoise("Nike running shoes");
    expect(result).toBe("Nike running shoes");
  });

  it("collapses extra whitespace after stripping", () => {
    const result = stripShoppingNoise("stylish  beautiful   hoodie");
    // After stripping, no double spaces should remain
    expect(result).not.toMatch(/\s{2,}/);
    expect(result).toBe("hoodie");
  });

  it("handles an empty string without throwing", () => {
    expect(stripShoppingNoise("")).toBe("");
  });

  it("is case-insensitive — removes 'Beautiful' (capitalized)", () => {
    expect(stripShoppingNoise("Beautiful blue coat")).toBe("blue coat");
  });

  it("removes 'luxury' from a query", () => {
    expect(stripShoppingNoise("luxury cashmere scarf")).toBe("cashmere scarf");
  });
});

// ═══════════════════════════════════════════════════════════════
// C. getSynonyms
// ═══════════════════════════════════════════════════════════════

describe("getSynonyms", () => {
  it("returns synonyms for 'chinos' including 'khakis' and 'khaki pants'", () => {
    const syns = getSynonyms("chinos");
    expect(syns).toContain("khakis");
    expect(syns).toContain("khaki pants");
  });

  it("returns synonyms for 'hoodie' including 'hooded sweatshirt' and 'hooded pullover'", () => {
    const syns = getSynonyms("hoodie");
    expect(syns).toContain("hooded sweatshirt");
    expect(syns).toContain("hooded pullover");
  });

  it("returns synonyms for 'sneakers' including 'trainers'", () => {
    const syns = getSynonyms("sneakers");
    expect(syns).toContain("trainers");
  });

  it("returns synonyms for 't-shirt' including 'tee'", () => {
    const syns = getSynonyms("t-shirt");
    expect(syns).toContain("tee");
  });

  it("does NOT include the input term itself in the returned synonyms", () => {
    expect(getSynonyms("chinos")).not.toContain("chinos");
    expect(getSynonyms("hoodie")).not.toContain("hoodie");
    expect(getSynonyms("sneakers")).not.toContain("sneakers");
  });

  it("returns an empty array for a completely unknown term", () => {
    expect(getSynonyms("unicorn-pants")).toEqual([]);
  });

  it("returns an empty array for an empty string", () => {
    expect(getSynonyms("")).toEqual([]);
  });

  it("returns synonyms for 'joggers' including 'sweatpants' and 'track pants'", () => {
    const syns = getSynonyms("joggers");
    expect(syns).toContain("sweatpants");
    expect(syns).toContain("track pants");
  });

  it("returns synonyms for 'blazer' including 'sport coat'", () => {
    const syns = getSynonyms("blazer");
    expect(syns).toContain("sport coat");
  });
});

// ═══════════════════════════════════════════════════════════════
// D. Synonym scoring in scoreProduct
// ═══════════════════════════════════════════════════════════════

describe("scoreProduct — synonym scoring", () => {
  // Use a neutral non-trusted domain so we can isolate synonym scoring
  // without the +20 trusted retailer bonus interfering with the comparison.
  const vendorBase = {
    link: "https://www.someboutique.com/products/item/123",
    price: "$80",
    source: "SomeBoutique",
  };

  it("'khaki pants' title scores > 0 when item subcategory is 'chinos'", () => {
    const product = { ...vendorBase, title: "men's khaki pants slim fit" };
    const item = { subcategory: "chinos", category: "bottom", brand: "", color: "", gender: "male" };
    const score = scoreProduct(product, item, false);
    expect(score).toBeGreaterThan(0);
  });

  it("'hooded sweatshirt' title scores > 0 when item subcategory is 'hoodie'", () => {
    const product = { ...vendorBase, title: "men's hooded sweatshirt pullover" };
    const item = { subcategory: "hoodie", category: "top", brand: "", color: "", gender: "male" };
    const score = scoreProduct(product, item, false);
    expect(score).toBeGreaterThan(0);
  });

  it("synonym match (+20) is less than exact subcategory match (+25)", () => {
    const itemChinos = { subcategory: "chinos", category: "bottom", brand: "", color: "", gender: "male" };

    // Exact match: title contains "chinos"
    const exactProduct = { ...vendorBase, title: "men's chinos slim fit" };
    const exactScore = scoreProduct(exactProduct, itemChinos, false);

    // Synonym match: title contains "khaki pants" (a synonym for chinos)
    const synonymProduct = { ...vendorBase, title: "men's khaki pants regular fit" };
    const synonymScore = scoreProduct(synonymProduct, itemChinos, false);

    // Exact match must score higher than synonym match
    expect(exactScore).toBeGreaterThan(synonymScore);
    // The synonym score must still be positive (not filtered out)
    expect(synonymScore).toBeGreaterThan(0);
  });

  it("synonym match awards +20 (verified by arithmetic)", () => {
    // Product whose title contains only a synonym — no brand, color, or category match
    const product = { ...vendorBase, title: "khaki pants" };
    const item = { subcategory: "chinos", category: "bottom", brand: "", color: "", gender: "male" };
    const score = scoreProduct(product, item, false);

    // Expected: clothing keyword baseline (+3 for "pant") + synonym match (+20) = 23
    // "khaki pants" contains "pant" so the clothing baseline fires
    expect(score).toBe(23);
  });

  it("synonym match for 'trainers' when item subcategory is 'sneakers'", () => {
    const product = { ...vendorBase, title: "men's white trainers low top" };
    const item = { subcategory: "sneakers", category: "shoes", brand: "", color: "", gender: "male" };
    const score = scoreProduct(product, item, false);
    expect(score).toBeGreaterThan(0);
  });
});

// ═══════════════════════════════════════════════════════════════
// E. Score floor / text boost tests
// ═══════════════════════════════════════════════════════════════

describe("scoreProduct — score floor and text boost", () => {
  it("trusted retailer + subcategory match never scores 0", () => {
    const product = {
      title: "men's hoodie zip-up",
      link: "https://www.nordstrom.com/s/hoodie/99999",
      price: "$90",
      source: "Nordstrom",
    };
    const item = { subcategory: "hoodie", category: "top", brand: "", color: "", gender: "male" };
    const score = scoreProduct(product, item, false);
    expect(score).toBeGreaterThan(0);
  });

  it("clothing keyword baseline (+3) + subcategory match (+25) = 28 for a plain vendor", () => {
    // Neutral domain, no trusted bonus, no brand, no color
    // Title: "men's hoodie" — "hoodie" is both a clothing keyword (+3) and subcategory (+25)
    const product = {
      title: "men's hoodie",
      link: "https://www.someshop.example.com/p/123",
      price: "$60",
    };
    const item = { subcategory: "hoodie", category: "top", brand: "", color: "", gender: "male" };
    const score = scoreProduct(product, item, false);
    // +3 clothing baseline + +25 subcategory = 28 (no trusted bonus, no brand, no color, no cat match)
    expect(score).toBe(28);
  });

  it("score is always > 0 when there is both a subcategory match and a clothing keyword", () => {
    // This verifies the score > 0 gate will never discard a valid subcategory match.
    // Gender is intentionally matched to the title to avoid the -40 mismatch penalty.
    //
    // NOTE: "women's dress" is intentionally excluded from this loop.
    // BUG: The gender mismatch check `title.includes("men's ")` fires a false -40
    // penalty on products titled "women's dress" because "men's " is a substring
    // of "women's ". This is a bug in scoreProduct that needs a word-boundary fix.
    // See the skipped test below for documentation.
    const testCases = [
      { title: "men's shirt", sub: "shirt", cat: "top", gender: "male" },
      { title: "men's jacket", sub: "jacket", cat: "outerwear", gender: "male" },
      { title: "men's sneaker low-top", sub: "sneaker", cat: "shoes", gender: "male" },
    ];

    for (const tc of testCases) {
      const product = {
        title: tc.title,
        link: "https://www.anyvendor.example.com/p/1",
        price: "$50",
      };
      const item = { subcategory: tc.sub, category: tc.cat, brand: "", color: "", gender: tc.gender };
      const score = scoreProduct(product, item, false);
      expect(score).toBeGreaterThan(0);
    }
  });

  it("women's dress no longer gets false-positive gender mismatch penalty (fixed)", () => {
    // FIXED: The gender mismatch check now uses word-boundary regex
    // so "women's" no longer falsely triggers the "men's" penalty.
    const product = {
      title: "women's dress",
      link: "https://www.anyvendor.example.com/p/1",
      price: "$50",
    };
    const item = { subcategory: "dress", category: "dress", brand: "", color: "", gender: "female" };
    const score = scoreProduct(product, item, false);
    // Expected: +3 (clothing) + +25 (subcategory) + +8 (category) = 36
    // Actual: 36 - 40 = -4 due to the bug described above
    expect(score).toBeGreaterThan(0);
  });

  it("a non-vendor page always returns -1 regardless of subcategory match", () => {
    const product = {
      title: "men's hoodie",
      link: "https://www.instagram.com/p/abc123",
      price: "$60",
    };
    const item = { subcategory: "hoodie", category: "top", brand: "", color: "", gender: "male" };
    expect(scoreProduct(product, item, false)).toBe(-1);
  });

  it("a text-search result with no price always returns -1", () => {
    const product = {
      title: "men's hoodie",
      link: "https://www.someshop.example.com/p/123",
      // no price field
    };
    const item = { subcategory: "hoodie", category: "top", brand: "", color: "", gender: "male" };
    expect(scoreProduct(product, item, false)).toBe(-1);
  });
});

// ═══════════════════════════════════════════════════════════════
// F. scan_id ownership check in POST /saved — structural verification
// ═══════════════════════════════════════════════════════════════

describe("POST /saved — scan_id ownership check (structural)", () => {
  it("user.js contains the scan_id ownership check (SECURITY comment)", async () => {
    // Read the route source and assert the ownership guard exists.
    // This is a structural test — it verifies the security check was not
    // accidentally removed during a refactor. It does not require a running
    // server or real database.
    const fs = await import("fs");
    const path = await import("path");
    const routePath = path.resolve(
      new URL(".", import.meta.url).pathname,
      "../../src/routes/user.js"
    );
    const source = fs.readFileSync(routePath, "utf-8");

    // The ownership check must be annotated with a SECURITY comment
    expect(source).toContain("Verify scan ownership");

    // It must also enforce user_id = req.userId on the scans lookup
    expect(source).toContain(".eq(\"user_id\", req.userId)");

    // The 403 status code must be present (forbidden, not just not-found)
    expect(source).toContain("403");
  });

  it("the ownership check block appears inside the POST /saved route handler", async () => {
    const fs = await import("fs");
    const path = await import("path");
    const routePath = path.resolve(
      new URL(".", import.meta.url).pathname,
      "../../src/routes/user.js"
    );
    const source = fs.readFileSync(routePath, "utf-8");

    // The POST /saved route declaration and the ownership check must both exist
    expect(source).toContain('router.post("/saved"');
    expect(source).toContain("scan_id");

    // The check must verify scan belongs to the requesting user before inserting
    // We look for: .eq("id", scan_id).eq("user_id", req.userId)
    expect(source).toContain('.eq("id", scan_id)');
    expect(source).toContain('.eq("user_id", req.userId)');
  });
});
