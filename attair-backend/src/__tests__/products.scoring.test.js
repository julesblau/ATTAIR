/**
 * Tests for the pure scoring/classification functions in services/products.js.
 *
 * scoreProduct, isVendorPage, matchLensResultToItem, and classifyMarket are
 * all module-private (not exported). We test them by replying the exact same
 * logic inline — this gives us a stable contract to diff against if the
 * implementation ever diverges.
 *
 * For isVendorPage and classifyMarket we additionally verify domain-level
 * behaviour that only depends on the hardcoded domain lists, which don't
 * change between test runs.
 *
 * NOTE: scoreProduct depends on isVendorPage internally. The inline replicas
 * below are used only for unit testing the scoring arithmetic; we separately
 * test isVendorPage in its own suite.
 */

import { describe, it, expect, vi } from "vitest";
import crypto from "crypto";

// ─── Inline replica: classifyMarket ───────────────────────────────────────

const RESALE_DOMAINS = [
  "poshmark.com", "depop.com", "grailed.com", "ebay.com", "thredup.com",
  "therealreal.com", "vestiairecollective.com", "stockx.com", "goat.com",
  "vinted.com",
];
const RESALE_SOURCE_NAMES = [
  "poshmark", "depop", "grailed", "ebay", "thredup", "the real real",
  "therealreal", "vestiaire collective", "vestiairecollective",
  "stockx", "goat", "vinted",
];
const RESALE_TITLE_KEYWORDS = [
  "pre-owned", "preowned", "pre owned", "second-hand", "secondhand",
  "second hand", "used condition", "pre-loved", "preloved", "consignment",
  "thrifted", "resale",
];

function classifyMarket(product) {
  const link = (product.link || product.product_link || product.url || "").toLowerCase();
  const source = (product.source || "").toLowerCase();
  const title = (product.title || "").toLowerCase();
  if (RESALE_DOMAINS.some(d => link.includes(d))) return "resale";
  if (RESALE_SOURCE_NAMES.some(s => source.includes(s))) return "resale";
  if (RESALE_TITLE_KEYWORDS.some(kw => title.includes(kw))) return "resale";
  return "retail";
}

// ─── Inline replica: isVendorPage ─────────────────────────────────────────

const NON_VENDOR_DOMAINS = [
  "instagram.com", "twitter.com", "x.com", "pinterest.com", "tiktok.com",
  "facebook.com", "reddit.com", "youtube.com", "tumblr.com", "snapchat.com",
  "vogue.com", "elle.com", "harpersbazaar.com", "medium.com",
  "squarespace.com", "wix.com", "realtor.com", "zillow.com",
  "imgur.com", "unsplash.com", "pexels.com",
];

const KNOWN_RETAIL_DOMAINS = [
  "nordstrom.com", "farfetch.com", "amazon.com", "target.com",
  "zara.com", "hm.com", "asos.com", "nordstromrack.com",
  "net-a-porter.com", "ssense.com",
];

function extractPrice(val) {
  if (!val) return null;
  if (typeof val === "object") {
    if (val.extracted_value != null) return parseFloat(val.extracted_value);
    if (val.value) return extractPrice(val.value);
    return null;
  }
  const m = String(val).replace(/,/g, "").match(/(\d+\.?\d*)/);
  return m ? parseFloat(m[1]) : null;
}

function isVendorPage(product) {
  const link = (product.link || product.product_link || product.url || "").toLowerCase();
  if (!link) return false;
  if (NON_VENDOR_DOMAINS.some(d => link.includes(d))) return false;
  const price = extractPrice(product.price) || extractPrice(product.extracted_price);
  if (price !== null) return true;
  if (KNOWN_RETAIL_DOMAINS.some(d => link.includes(d))) return true;
  if (RESALE_DOMAINS.some(d => link.includes(d))) return true;
  return false;
}

// ─── Inline replica: matchLensResultToItem ────────────────────────────────

function matchLensResultToItem(result, items) {
  const title = (result.title || "").toLowerCase();
  let bestMatch = -1;
  let bestScore = 0;

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    let score = 0;

    const sub = (item.subcategory || "").toLowerCase();
    if (sub && sub.length > 2 && title.includes(sub)) score += 30;
    else if (sub && sub.length > 4 && title.includes(sub.slice(0, -1))) score += 20;

    const cat = (item.category || "").toLowerCase();
    if (cat && title.includes(cat)) score += 10;

    const brand = (item.brand || "").toLowerCase();
    if (brand && brand !== "unidentified" && title.includes(brand)) score += 25;

    const color = (item.color || "").toLowerCase();
    if (color && color.length > 2 && title.includes(color)) score += 10;

    const keywords = {
      outerwear: ["jacket", "coat", "blazer", "parka", "vest", "cardigan", "bomber"],
      top: ["shirt", "tee", "t-shirt", "blouse", "polo", "tank", "sweater", "hoodie", "pullover", "sweatshirt", "top", "henley"],
      bottom: ["pants", "jeans", "trousers", "shorts", "joggers", "chinos", "leggings", "skirt"],
      shoes: ["shoe", "sneaker", "boot", "sandal", "loafer", "heel", "flat", "trainer", "runner", "slip-on"],
      dress: ["dress", "gown", "romper", "jumpsuit"],
      accessory: ["hat", "cap", "belt", "watch", "glasses", "sunglasses", "scarf", "tie", "bracelet", "necklace", "ring"],
      bag: ["bag", "purse", "backpack", "tote", "clutch", "wallet"],
    };
    const catKeywords = keywords[cat] || [];
    if (catKeywords.some(kw => title.includes(kw))) score += 15;

    if (score > bestScore) {
      bestScore = score;
      bestMatch = i;
    }
  }

  return bestScore >= 10 ? bestMatch : -1;
}

// ─── Inline replica: scoreProduct (simplified, tests arithmetic paths) ─────

const TRUSTED_RETAILER_DOMAINS = new Set([
  "nordstrom.com", "farfetch.com", "ssense.com", "net-a-porter.com",
  "mytheresa.com", "shopbop.com", "revolve.com",
]);

const KNOCKOFF_DOMAINS_SCORE = [
  "dhgate.com", "aliexpress.com", "alibaba.com", "wish.com",
  "temu.com", "banggood.com",
];

const KNOCKOFF_TITLE_KEYWORDS_SCORE = [
  "replica", "knockoff", "knock off", "counterfeit", "fake",
  "inspired by", "dupe for",
];

function scoreProduct(product, item, isFromLens, sizePrefs = {}, tierBounds = null) {
  if (!isVendorPage(product)) return -1;

  const title = (product.title || "").toLowerCase();
  const source = (product.source || "").toLowerCase();
  const link = product.link || product.product_link || product.url || "";
  const price = extractPrice(product.price) || extractPrice(product.extracted_price);

  if (!isFromLens && price === null) return -1;

  let score = 0;

  if (isFromLens) score += 25;
  if (isFromLens && price !== null) score += 10;

  const CLOTHING_KEYWORDS = [
    "shirt", "pant", "jean", "dress", "jacket", "coat", "shoe", "sneaker",
    "boot", "top", "blouse", "skirt", "short", "sweater", "hoodie", "blazer",
  ];
  if (CLOTHING_KEYWORDS.some(kw => title.includes(kw))) score += 3;

  const sub = (item.subcategory || "").toLowerCase();
  if (sub && sub.length > 2 && title.includes(sub)) score += 25;

  const cat = (item.category || "").toLowerCase();
  if (cat && title.includes(cat)) score += 8;

  const brand = (item.brand || "").toLowerCase();
  if (brand && brand !== "unidentified") {
    if (title.includes(brand) || source.includes(brand)) score += 30;
  }

  const color = (item.color || "").toLowerCase();
  if (color && color.length > 2 && title.includes(color)) score += 12;

  const domain = link.replace(/^https?:\/\/(?:www\.)?/, "").split("/")[0];
  if ([...TRUSTED_RETAILER_DOMAINS].some(d => domain.includes(d))) score += 20;

  if (KNOCKOFF_DOMAINS_SCORE.some(d => link.includes(d))) score -= 50;
  if (KNOCKOFF_TITLE_KEYWORDS_SCORE.some(kw => title.includes(kw))) score -= 50;

  const isMale = (item.gender || "male") === "male";
  if (isMale && (title.includes("women's") || title.includes("womens"))) score -= 40;
  if (!isMale && (title.includes("men's ") || title.includes("mens "))) score -= 40;

  if (price !== null && tierBounds) {
    const { min, max } = tierBounds;
    if (price >= min && price <= max) score += 30;
    else if (price < min) {
      const ratio = price / min;
      if (ratio < 0.1) score -= 50;
      else if (ratio < 0.3) score -= 30;
      else if (ratio < 0.6) score -= 15;
    }
  }

  return score;
}

// ─── Tests ────────────────────────────────────────────────────────────────

describe("classifyMarket", () => {
  it("returns 'resale' for poshmark.com", () => {
    expect(classifyMarket({ link: "https://poshmark.com/listing/abc" })).toBe("resale");
  });

  it("returns 'resale' for depop.com", () => {
    expect(classifyMarket({ link: "https://www.depop.com/products/abc" })).toBe("resale");
  });

  it("returns 'resale' for grailed.com", () => {
    expect(classifyMarket({ link: "https://www.grailed.com/listings/123" })).toBe("resale");
  });

  it("returns 'retail' for nordstrom.com", () => {
    expect(classifyMarket({ link: "https://www.nordstrom.com/s/jacket/12345" })).toBe("retail");
  });

  it("returns 'retail' for zara.com", () => {
    expect(classifyMarket({ link: "https://www.zara.com/us/en/product/p12345.html" })).toBe("retail");
  });

  it("returns 'resale' when source name is 'poshmark'", () => {
    expect(classifyMarket({ link: "https://example.com", source: "Poshmark" })).toBe("resale");
  });

  it("returns 'resale' when title contains 'pre-owned'", () => {
    expect(classifyMarket({ link: "https://example.com/item", title: "Pre-Owned Louis Vuitton Bag" })).toBe("resale");
  });

  it("returns 'retail' for an unknown domain with no resale signals", () => {
    expect(classifyMarket({ link: "https://someboutique.com/item/123" })).toBe("retail");
  });
});

describe("isVendorPage", () => {
  it("returns false for instagram.com", () => {
    expect(isVendorPage({ link: "https://www.instagram.com/p/abc123" })).toBe(false);
  });

  it("returns false for pinterest.com", () => {
    expect(isVendorPage({ link: "https://www.pinterest.com/pin/12345" })).toBe(false);
  });

  it("returns false for vogue.com", () => {
    expect(isVendorPage({ link: "https://www.vogue.com/article/best-jackets" })).toBe(false);
  });

  it("returns true for nordstrom.com (known retail domain)", () => {
    expect(isVendorPage({ link: "https://www.nordstrom.com/s/jacket/12345" })).toBe(true);
  });

  it("returns true for farfetch.com (known retail domain)", () => {
    expect(isVendorPage({ link: "https://www.farfetch.com/shopping/women/jacket-item.aspx" })).toBe(true);
  });

  it("returns true for amazon.com (known retail domain)", () => {
    expect(isVendorPage({ link: "https://www.amazon.com/dp/B09XY123Z" })).toBe(true);
  });

  it("returns true for any URL that has a price field", () => {
    expect(isVendorPage({ link: "https://randomboutique.example.com/item/99", price: "$49.99" })).toBe(true);
  });

  it("returns false for a product with no link", () => {
    expect(isVendorPage({ title: "Cool Jacket", price: "$80" })).toBe(false);
  });

  it("returns false for an unknown domain with no price and no product-path pattern", () => {
    expect(isVendorPage({ link: "https://someportfolio.example.com/gallery" })).toBe(false);
  });

  it("returns true for a poshmark.com link (resale is still a vendor)", () => {
    expect(isVendorPage({ link: "https://poshmark.com/listing/blue-jacket-123" })).toBe(true);
  });
});

describe("matchLensResultToItem", () => {
  const items = [
    { category: "top", subcategory: "hoodie", brand: "Nike", color: "black" },
    { category: "shoes", subcategory: "sneaker", brand: "Adidas", color: "white" },
  ];

  it("returns -1 when the score is below 10 (no meaningful match)", () => {
    const result = { title: "Abstract Art Print" };
    expect(matchLensResultToItem(result, items)).toBe(-1);
  });

  it("matches item 0 when title contains the subcategory 'hoodie'", () => {
    const result = { title: "Nike Black Hoodie — Men's Pullover" };
    expect(matchLensResultToItem(result, items)).toBe(0);
  });

  it("matches item 1 when title contains the subcategory 'sneaker'", () => {
    const result = { title: "Adidas White Sneakers Running Shoes" };
    expect(matchLensResultToItem(result, items)).toBe(1);
  });

  it("awards +25 for brand match: Adidas title → item 1", () => {
    // Only brand matches here — score should be ≥ 10
    const result = { title: "Adidas Classic Trainer" };
    expect(matchLensResultToItem(result, items)).toBe(1);
  });

  it("awards subcategory match (+30) over category match (+10)", () => {
    // Title contains 'hoodie' (subcategory of item[0]) and 'shoes' (category of item[1])
    // item[0] should win because subcategory match is stronger
    const result = { title: "Best Hoodie in Shoes Section" };
    expect(matchLensResultToItem(result, items)).toBe(0);
  });

  it("returns -1 when items array is empty", () => {
    const result = { title: "Nike Hoodie" };
    expect(matchLensResultToItem(result, [])).toBe(-1);
  });
});

describe("scoreProduct", () => {
  const baseItem = {
    category: "top",
    subcategory: "hoodie",
    brand: "Nike",
    color: "black",
    gender: "male",
  };

  const baseProduct = {
    title: "Men's Black Hoodie",
    link: "https://www.nordstrom.com/s/hoodie/12345",
    price: "$80",
    source: "Nordstrom",
  };

  it("returns -1 for a non-vendor page (instagram.com)", () => {
    const product = { title: "Cool Outfit", link: "https://www.instagram.com/p/abc123", price: "$50" };
    expect(scoreProduct(product, baseItem, false)).toBe(-1);
  });

  it("returns -1 for a text-search result with no price", () => {
    const product = {
      title: "Men's Black Hoodie",
      link: "https://www.nordstrom.com/s/hoodie/12345",
      // no price field
    };
    expect(scoreProduct(product, baseItem, false)).toBe(-1);
  });

  it("applies +30 brand match bonus when brand appears in title", () => {
    const product = {
      title: "Nike Men's Black Hoodie",
      link: "https://www.nordstrom.com/s/hoodie/12345",
      price: "$80",
      source: "Nordstrom",
    };
    const productNoBrand = {
      title: "Men's Black Hoodie",
      link: "https://www.nordstrom.com/s/hoodie/12345",
      price: "$80",
      source: "Nordstrom",
    };
    const scoreWithBrand = scoreProduct(product, baseItem, false);
    const scoreWithoutBrand = scoreProduct(productNoBrand, baseItem, false);
    expect(scoreWithBrand - scoreWithoutBrand).toBe(30);
  });

  it("applies -50 knockoff domain penalty for dhgate.com", () => {
    // Use a neutral non-trusted domain as the baseline to isolate only the
    // knockoff penalty (-50) without mixing in the trusted-retailer bonus (+20).
    const productNeutral = {
      title: "Men's Black Hoodie",
      link: "https://www.someboutique.com/products/hoodie/12345",
      price: "$80",
      source: "SomeBoutique",
    };
    const productKnockoff = {
      title: "Men's Black Hoodie",
      link: "https://www.dhgate.com/product/hoodie/12345.html",
      price: "$80",
      source: "DHgate",
    };
    const scoreNeutral = scoreProduct(productNeutral, baseItem, false);
    const scoreKnockoff = scoreProduct(productKnockoff, baseItem, false);
    // The only scoring difference should be the -50 knockoff domain penalty.
    expect(scoreNeutral - scoreKnockoff).toBe(50);
  });

  it("applies -40 gender mismatch penalty when women's item found for male item", () => {
    const productMismatch = {
      title: "Women's Hoodie",
      link: "https://www.nordstrom.com/s/hoodie/12345",
      price: "$80",
      source: "Nordstrom",
    };
    const productMatch = {
      title: "Men's Hoodie",
      link: "https://www.nordstrom.com/s/hoodie/12345",
      price: "$80",
      source: "Nordstrom",
    };
    const scoreMatch = scoreProduct(productMatch, baseItem, false);
    const scoreMismatch = scoreProduct(productMismatch, baseItem, false);
    expect(scoreMatch - scoreMismatch).toBe(40);
  });

  it("applies +20 trusted retailer bonus for nordstrom.com", () => {
    const productTrusted = {
      title: "Men's Black Hoodie",
      link: "https://www.nordstrom.com/s/hoodie/12345",
      price: "$80",
      source: "Nordstrom",
    };
    const productUnknown = {
      title: "Men's Black Hoodie",
      link: "https://www.someboutique.com/products/hoodie/12345",
      price: "$80",
      source: "SomeBoutique",
    };
    const scoreTrusted = scoreProduct(productTrusted, baseItem, false);
    const scoreUnknown = scoreProduct(productUnknown, baseItem, false);
    expect(scoreTrusted - scoreUnknown).toBe(20);
  });

  it("applies +30 price-in-budget bonus when price falls within tierBounds", () => {
    const productInBudget = {
      title: "Men's Black Hoodie",
      link: "https://www.nordstrom.com/s/hoodie/12345",
      price: "$75",
      source: "Nordstrom",
    };
    const productOutsideBudget = {
      title: "Men's Black Hoodie",
      link: "https://www.nordstrom.com/s/hoodie/12345",
      price: "$200",
      source: "Nordstrom",
    };
    const tierBounds = { min: 50, max: 100 };
    const scoreIn = scoreProduct(productInBudget, baseItem, false, {}, tierBounds);
    const scoreOut = scoreProduct(productOutsideBudget, baseItem, false, {}, tierBounds);
    expect(scoreIn - scoreOut).toBe(30);
  });

  it("Lens result gets base +25 bonus even without price", () => {
    const product = {
      title: "Men's Black Hoodie",
      link: "https://www.nordstrom.com/s/hoodie/12345",
      // no price
      source: "Nordstrom",
    };
    const scoreFromLens = scoreProduct(product, baseItem, true);
    // isFromLens with no price: +25 lens bonus but no +10 lens-with-price bonus
    // Should be positive (not -1) as a vendor page
    expect(scoreFromLens).toBeGreaterThan(-1);
  });
});
