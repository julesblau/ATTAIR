import supabase from "../lib/supabase.js";
import crypto from "crypto";

/**
 * ATTAIR Product Search — v4 (Visual-first)
 *
 * Architecture:
 * 1. Google Lens (reverse image search) on the actual photo
 *    → returns real product pages that visually match the outfit
 * 2. Match Lens results to Claude's identified items
 *    → "this product looks like the hoodie Claude identified"
 * 3. Text search fallback for items Lens didn't cover
 * 4. Score everything for relevance, partition into tiers by price
 *
 * This is fundamentally different from v1-v3 which only did text search.
 * Visual search finds products that LOOK like the photo, not just
 * keyword matches. This is what makes the app actually useful.
 */

const SERPAPI_URL = "https://serpapi.com/search.json";

// ─── Budget config ──────────────────────────────────────────
const DEFAULT_BUDGET = { min: 50, max: 100 };

// ─── Market type classification ─────────────────────────────
// Domains that are definitively secondary/resale markets
const RESALE_DOMAINS = [
  "poshmark.com",
  "depop.com",
  "grailed.com",
  "ebay.com",
  "thredup.com",
  "therealreal.com",
  "vestiairecollective.com",
  "stockx.com",
  "goat.com",
  "vinted.com",
  "tradesy.com",
  "mercari.com",
  "offerup.com",
  "fashionphile.com",
  "rebag.com",
  "trove.com",
  "swap.com",
  "kidizen.com",
  "luxurygarage.com",
  "flyp.com",
  "curtsy.com",
  "deserved.com",
  "poshmark.ca",
  "vestiaire.com",
  "snobswap.com",
  "threadflip.com",
  "yerdle.com",
  "second-hand.com",
  "truefacet.com",
  "circa.watches",
  "chrono24.com",
];

// Keyword patterns in title/source that indicate a listing is pre-owned/used
const RESALE_TITLE_KEYWORDS = [
  "pre-owned", "preowned", "pre owned",
  "second-hand", "secondhand", "second hand",
  "used condition", "pre-loved", "preloved", "pre loved",
  "consignment",
  "thrifted",
  "resale",
  "worn once", "worn twice",
  "lightly used", "gently used",
  "like new condition", "good used condition", "great used condition", // resale condition descriptors
];

// Source names that indicate resale (for SerpAPI "source" field)
const RESALE_SOURCE_NAMES = [
  "poshmark", "depop", "grailed", "ebay", "thredup", "the real real",
  "therealreal", "vestiaire collective", "vestiairecollective",
  "stockx", "goat", "vinted", "tradesy", "mercari", "offerup",
  "fashionphile", "rebag", "swap.com", "kidizen", "curtsy",
];

// ─── Quality retailer signals ────────────────────────────────
// Domains whose results reliably land on real, in-stock product pages.
// These get a scoring bonus because they have clean data, correct attribution,
// and a high probability of being a genuine first-hand listing.
const TRUSTED_RETAILER_DOMAINS = new Set([
  "nordstrom.com", "farfetch.com", "ssense.com", "net-a-porter.com",
  "mytheresa.com", "shopbop.com", "revolve.com", "matchesfashion.com",
  "bloomingdales.com", "saksfifthavenue.com", "neimanmarcus.com",
  "bergdorfgoodman.com", "harrods.com", "selfridges.com",
  "luisaviaroma.com", "24s.com", "brownsfashion.com", "cettire.com",
  "madewell.com", "anthropologie.com", "zappos.com", "dsw.com",
  "lululemon.com", "patagonia.com", "thenorthface.com", "rei.com",
  "aritzia.com", "cos.com", "arket.com", "reiss.com",
  "asos.com", "urban outfitters.com", "urbanoutfitters.com",
]);

// Domains with a high incidence of counterfeit goods, extreme knockoffs,
// or misleading product descriptions. Results from these get heavily penalised.
const KNOCKOFF_DOMAINS = [
  "dhgate.com", "aliexpress.com", "alibaba.com", "wish.com",
  "temu.com", "banggood.com", "gearbest.com", "lightinthebox.com",
  "rosegal.com", "dresslily.com", "floryday.com", "jollychic.com",
  "zaful.com",
];

// Title keywords that signal replica / counterfeit listings.
const KNOCKOFF_TITLE_KEYWORDS = [
  "replica", "knockoff", "knock off", "counterfeit", "fake",
  "inspired by", "dupe for", "looks like",
];

/**
 * Classify a product as "resale" (secondary market) or "retail" (first-hand).
 * Uses three signals: URL domain, source name, and title keywords.
 */
function classifyMarket(product) {
  const link = (product.link || product.product_link || product.url || "").toLowerCase();
  const source = (product.source || "").toLowerCase();
  const title = (product.title || "").toLowerCase();

  // 1. Domain match — most reliable signal
  if (RESALE_DOMAINS.some(d => link.includes(d))) return "resale";

  // 2. Source name match (SerpAPI "source" field is the retailer/platform name)
  if (RESALE_SOURCE_NAMES.some(s => source.includes(s))) return "resale";

  // 3. Title keyword match — catches resale listings on mixed platforms
  if (RESALE_TITLE_KEYWORDS.some(kw => title.includes(kw))) return "resale";

  return "retail";
}

/**
 * Returns true if the product is allowed given the user's market preference.
 * marketPref: "both" | "retail" | "resale"
 */
function isAllowedByMarket(product, marketPref) {
  if (!marketPref || marketPref === "both") return true;
  const market = classifyMarket(product);
  return market === marketPref;
}

// ─── Vendor page validation ──────────────────────────────────
//
// The core problem: Google Lens scans the entire web for visually similar
// images. A white shirt on a realtor's portfolio is visually similar to a
// white shirt product photo. We need to positively confirm a URL is a
// shopping page, not just blacklist known bad domains.
//
// Three-layer approach:
//   1. Hard-reject known non-vendor domains (extended denylist)
//   2. Hard-accept known retail domains (large allowlist)
//   3. URL structure heuristics for everything else

// Domains that are definitively NOT shopping pages.
// Any result linking here is rejected regardless of score or price.
const NON_VENDOR_DOMAINS = [
  // Social media
  "instagram.com", "twitter.com", "x.com", "pinterest.com", "tiktok.com",
  "facebook.com", "reddit.com", "youtube.com", "tumblr.com", "snapchat.com",
  "threads.net", "vsco.co", "linkedin.com", "whatsapp.com", "telegram.org",
  // Blogs / media / news / editorial
  "wordpress.com", "blogspot.com", "medium.com", "substack.com",
  "buzzfeed.com", "refinery29.com", "vogue.com", "elle.com",
  "harpersbazaar.com", "gq.com", "esquire.com", "menshealth.com",
  "womenshealthmag.com", "allure.com", "cosmopolitan.com", "glamour.com",
  "huffpost.com", "nytimes.com", "washingtonpost.com", "theguardian.com",
  "wwd.com", "businessoffashion.com", "fashionista.com", "whowhatwear.com",
  "byrdie.com", "popsugar.com", "thecut.com",
  // Portfolio / creative tools (the realtor bug lives here)
  "squarespace.com", "wix.com", "weebly.com", "strikingly.com",
  "cargo.site", "format.com", "pixpa.com", "sitebuilder.com",
  "portfoliobox.net", "zenfolio.com", "smugmug.com", "flickr.com",
  "behance.net", "dribbble.com", "carbonmade.com", "cargocollective.com",
  // Real estate / home
  "realtor.com", "zillow.com", "trulia.com", "redfin.com",
  "homes.com", "homesnap.com", "loopnet.com",
  // Image hosting / stock photo (not product pages)
  "imgur.com", "giphy.com", "unsplash.com", "pexels.com",
  "shutterstock.com", "gettyimages.com", "istockphoto.com", "alamy.com",
  "dreamstime.com", "stocksy.com",
  // Wikis / encyclopedias
  "wikipedia.org", "wikimedia.org", "wikihow.com", "fandom.com",
  // Review / discovery (not direct purchase)
  "yelp.com", "tripadvisor.com", "goodreads.com", "imdb.com",
  // Travel / hospitality
  "expedia.com", "booking.com", "airbnb.com", "vrbo.com", "hotels.com",
  // Depop gallery (search browse pages, not product pages)
  "depop.com/g/",
];

// Domains that are definitively shopping/retail pages.
// A result from here is accepted even without a price in the data.
const KNOWN_RETAIL_DOMAINS = [
  // ── Department stores ──
  "nordstrom.com", "nordstromrack.com", "macys.com", "bloomingdales.com",
  "saksfifthavenue.com", "saks.com", "neimanmarcus.com", "bergdorfgoodman.com",
  "dillards.com", "kohls.com", "jcpenney.com", "belk.com", "lordandtaylor.com",
  "houseoffraser.co.uk", "johnlewis.com", "selfridges.com", "harrods.com",
  "libertylondon.com", "galerieslafayette.com", "elcorteingles.es",
  // ── Mass market ──
  "amazon.com", "amazon.co.uk", "amazon.ca", "amazon.de", "amazon.fr",
  "amazon.es", "amazon.it", "amazon.co.jp", "amazon.com.au", "amazon.com.mx",
  "target.com", "walmart.com", "costco.com", "samsclub.com",
  // ── Fast fashion / high street ──
  "hm.com", "zara.com", "uniqlo.com", "asos.com", "boohoo.com",
  "nastygal.com", "prettylittlething.com", "fashionnova.com",
  "shein.com", "romwe.com", "missguided.com",
  // NOTE: zaful.com intentionally omitted — it is listed in KNOCKOFF_DOMAINS and
  // should not be hard-accepted as a trusted retail domain. Its knockoff penalty
  // in scoreProduct already handles it, but accepting it in isVendorPage would
  // allow it to bypass the non-vendor gate entirely on unpriced results.
  "primark.com", "newlook.com", "riverisland.com", "next.co.uk",
  "matalan.co.uk", "peacocks.co.uk",
  // ── Gap family ──
  "gap.com", "oldnavy.com", "bananarepublic.com", "athleta.com",
  // ── American specialty / mid-market ──
  "jcrew.com", "madewell.com", "anthropologie.com", "freepeople.com",
  "urbanoutfitters.com", "abercrombie.com", "hollisterco.com",
  "ae.com", "americaneagle.com", "express.com", "forever21.com",
  "victoriassecret.com", "soma.com", "cacique.com",
  "whitehouseblackmarket.com", "chicos.com", "talbot.com", "talbots.com",
  "loft.com", "anntaylor.com", "dressbarn.com", "torrid.com", "lanebryant.com",
  "maurices.com", "cato.com", "catherines.com",
  // ── Workwear / tailoring ──
  "suitsupply.com", "indochino.com", "ministryofsupply.com",
  "bonobos.com", "untuckit.com", "mizzenandmain.com",
  "hugoboss.com", "calvinklein.com", "thomaspink.com",
  // ── Contemporary / premium ──
  "theory.com", "vince.com", "ragandbone.com", "rag-bone.com",
  "allsaints.com", "clubmonaco.com", "reiss.com", "hobbs.com",
  "cos.com", "arket.com", "monki.com", "weekday.com",
  "frenchconnection.com", "warehouse.co.uk", "oasis-stores.com",
  "reformation.com", "retrofete.com", "loefflerrandall.com",
  // ── Denim ──
  "levi.com", "levis.com", "wrangler.com", "lee.com", "dickies.com",
  "agolde.com", "citizens.com", "citizensofhumanity.com",
  "framestore.com", "frame-store.com", "dl1961.com", "paige.com",
  "good-american.com", "goodamerican.com", "moussy-vintage.com",
  "motherdenim.com", "joesdenim.com",
  // ── Luxury ──
  "gucci.com", "louisvuitton.com", "prada.com", "chanel.com",
  "hermes.com", "hermesworld.com", "burberry.com", "balenciaga.com",
  "valentino.com", "versace.com", "givenchy.com", "lanvin.com",
  "loewe.com", "offwhite.com", "off---white.com", "bottegaveneta.com",
  "alexandermcqueen.com", "stellamccartney.com", "viviennewestwood.com",
  "rickowens.eu", "jilsander.com", "acnestudios.com", "a-cold-wall.com",
  "ami-paris.com", "maison-kitsune.com", "maisonmargiela.com",
  "isabelmarant.com", "sandro-paris.com", "maje.com", "ba-sh.com",
  "jacquemus.com", "coperni.co", "ganni.com", "rotate-birger-christensen.com",
  // ── Luxury multi-brand ──
  "net-a-porter.com", "mytheresa.com", "ssense.com", "farfetch.com",
  "matchesfashion.com", "shopbop.com", "revolve.com", "fwrd.com",
  "luisaviaroma.com", "brownsfashion.com", "cettire.com",
  "theoutnet.com", "yoox.com", "24s.com", "italist.com",
  "vestiairecollective.com", "therealreal.com", "1stdibs.com",
  // ── Activewear ──
  "lululemon.com", "fabletics.com", "gymshark.com", "vuori.com",
  "rhone.com", "alo.com", "aloyoga.com", "apl.com", "setactiveclothing.com",
  "beyond-yoga.com", "onzie.com", "manduka.com", "oiselle.com",
  "sweaty-betty.com", "sweatybetty.com", "icebreaker.com",
  // ── Sneakers / footwear ──
  "nike.com", "adidas.com", "newbalance.com", "converse.com", "vans.com",
  "puma.com", "reebok.com", "underarmour.com", "asics.com", "saucony.com",
  "hoka.com", "hokaoneone.com", "on-running.com", "brooks.com",
  "zappos.com", "dsw.com", "footlocker.com", "finishline.com",
  "stevemadden.com", "aldo.com", "aldoshoes.com", "clarks.com",
  "skechers.com", "ecco.com", "drmartens.com", "ugg.com",
  "sorel.com", "birkenstock.com", "crocs.com", "tods.com",
  "christianlouboutin.com", "jimmychoo.com", "manoloblahnik.com",
  "stuartweitzman.com", "samedelman.com", "stevemadden.com",
  "geox.com", "fitflop.com", "havaianas.com", "hunter.com",
  "hunterboots.com", "penguinboots.com",
  // ── Outdoors / heritage ──
  "columbia.com", "thenorthface.com", "patagonia.com", "rei.com",
  "arcteryx.com", "salomon.com", "timberland.com", "carhartt.com",
  "pendleton-usa.com", "woolrich.com", "filson.com", "orvis.com",
  "mountainhardwear.com", "marmot.com", "blackdiamondequipment.com",
  // ── Accessories ──
  "coach.com", "katespade.com", "michaelkors.com",
  "toryburch.com", "furla.com", "mulberry.com", "longchamp.com",
  // NOTE: "tory burch.com" (with a space) was previously listed here — it can never
  // match a URL because URLs do not contain spaces. Removed; "toryburch.com" above
  // is the correct entry and provides full coverage.
  "samsonite.com", "tumi.com", "herschel.com", "fjallraven.com",
  "sunglasshut.com", "lenscrafters.com", "warbyparker.com",
  // ── Men's focused ──
  "ralphlauren.com", "tommyhilfiger.com", "izod.com",
  "lacoste.com", "fred-perry.com", "fredperry.com",
  "nautical.com", "hackett.com", "barkmale.com",
  "thetiebar.com", "paulsmith.com",
  // ── Sustainable / vintage ──
  "pangaia.com", "tentree.com", "patagonia.com", "pranaclothing.com",
  "eileen-fisher.com", "eileenfisher.com",
  // ── Plus size ──
  "eloquii.com", "curvissa.com", "simply-be.co.uk",
  // ── Subscription / styling ──
  "stitchfix.com", "trunkclub.com", "threadup.com",
  // ── UK / EU market ──
  "marksandspencer.com", "debenhams.com", "topshop.com",
  "boohoo.com", "fatface.com", "seasalt.com", "joules.com",
  "boden.co.uk", "laithwaites.co.uk",
  // ── Marketplace (vendor storefronts count as retail) ──
  "etsy.com",   // handmade / indie — product pages are valid
];

// URL path patterns that strongly suggest a product page, regardless of domain.
// Used as a fallback for domains not on the known list.
const PRODUCT_URL_PATTERNS = [
  /\/product[s]?\//i,
  /\/p\//i,
  /\/dp\//i,           // Amazon product detail
  /\/item[s]?\//i,
  /\/buy\//i,
  /\/catalog[ue]?\//i,
  /\/listing[s]?\//i,
  /\/store\//i,
  /\/shop\//i,
  /\/goods\//i,
  /\/detail\//i,
  /\/pdp\//i,          // product detail page
  /[?&](sku|pid|product[-_]?id|item[-_]?id|variant)=/i,
  /\/[a-z0-9][\w-]+-\d{5,}/i,  // slug ending with product ID (≥5 digits)
  /\.(html?|aspx?)(\?|$)/i,     // explicit page extension (many retail CMS)
];

/**
 * Returns true if the product link points to a genuine vendor/shopping page.
 *
 * Decision tree:
 *   1. No link → false
 *   2. Link is on NON_VENDOR_DOMAINS → false  (hard reject)
 *   3. Has a price → true  (vendors always have prices; the strongest signal)
 *   4. Domain is on KNOWN_RETAIL_DOMAINS → true  (trusted retailer)
 *   5. URL path matches a product page pattern → true  (structural heuristic)
 *   6. Otherwise → false  (unknown domain, no price, no product path = reject)
 *
 * Note: resale domains pass this check — they ARE vendors (secondary market).
 * Market preference filtering is separate.
 */
function isVendorPage(product) {
  const link = (product.link || product.product_link || product.url || "").toLowerCase();
  if (!link) return false;

  // 1. Hard reject: known non-vendor domains
  if (NON_VENDOR_DOMAINS.some(d => link.includes(d))) return false;

  // 2. Has a price → it's a product listing (any legitimate product page has a price)
  const price = extractPrice(product.price) || extractPrice(product.extracted_price);
  if (price !== null) return true;

  // 3. Domain is a known retailer (accept even if price wasn't scraped)
  if (KNOWN_RETAIL_DOMAINS.some(d => link.includes(d))) return true;

  // 4. Resale platforms are also valid vendors
  if (RESALE_DOMAINS.some(d => link.includes(d))) return true;

  // 5. URL path looks like a product page on an unknown domain
  if (PRODUCT_URL_PATTERNS.some(p => p.test(link))) return true;

  // 6. Source name matches a known retailer (SerpAPI sometimes populates this
  //    even when the domain is a subdomain or CDN URL we don't recognise)
  const source = (product.source || "").toLowerCase();
  const knownSource = KNOWN_RETAIL_DOMAINS.some(d => {
    const base = d.replace(/^www\./, "").replace(/\.(com|co\.\w+|net|org|io|us|uk)$/, "");
    return source.includes(base) && base.length > 3;
  });
  if (knownSource) return true;

  // Unknown domain, no price, no product URL pattern — almost certainly not a shop
  return false;
}

// ─── Size preference helpers ────────────────────────────────
const BODY_TYPE_TERMS = {
  petite: "petite",
  tall: "tall",
  plus: "plus size",
  big_tall: "big & tall",
  athletic: "athletic fit",
  curvy: "curvy",
};
const BODY_TYPE_OPPOSITES = {
  petite: ["plus size", "big & tall"],
  plus: ["petite"],
  big_tall: ["petite"],
};
const FIT_TERMS = {
  slim: "slim fit",
  fitted: "fitted",
  relaxed: "relaxed fit",
  oversized: "oversized",
  flowy: "flowy",
};

function getSizeTermForItem(item, sizePrefs) {
  const sizes = sizePrefs?.sizes;
  if (!sizes) return null;
  const cat = (item.category || "").toLowerCase();
  const sub = (item.subcategory || "").toLowerCase();
  const combined = cat + " " + sub;
  if (["top", "shirt", "tee", "blouse", "polo", "sweater", "hoodie", "pullover", "sweatshirt"].some(k => combined.includes(k))) return sizes.tops || null;
  if (["jean", "denim"].some(k => combined.includes(k))) return sizes.jeans || sizes.bottoms || null;
  if (["short"].some(k => combined.includes(k))) return sizes.shorts || sizes.bottoms || null;
  if (["pant", "trouser", "chino", "legging", "bottom"].some(k => combined.includes(k))) return sizes.bottoms || null;
  if (["dress", "gown", "romper", "jumpsuit"].some(k => combined.includes(k))) return sizes.dresses || null;
  if (["outerwear", "jacket", "coat", "blazer", "parka", "bomber"].some(k => combined.includes(k))) return sizes.outerwear || null;
  if (["shoe", "sneaker", "boot", "sandal", "loafer", "heel", "flat", "trainer"].some(k => combined.includes(k))) return sizes.shoes || null;
  if (["sock"].some(k => combined.includes(k))) return sizes.socks || null;
  return null;
}

function getTierBounds(budgetMin, budgetMax) {
  let min = budgetMin != null && budgetMin > 0 ? budgetMin : DEFAULT_BUDGET.min;
  let max = budgetMax != null && budgetMax > 0 ? budgetMax : DEFAULT_BUDGET.max;
  if (max <= min) max = min * 2;
  return { min, max };
}

// ─── Cache ──────────────────────────────────────────────────
let _lastCleanup = 0;
async function cleanupExpiredCache() {
  if (Date.now() - _lastCleanup < 3600000) return;
  _lastCleanup = Date.now();
  try { await supabase.from("product_cache").delete().lt("expires_at", new Date().toISOString()); } catch {}
}

function makeCacheKey(scanId, bMin, bMax) {
  return crypto.createHash("md5").update(`v4:${scanId}:${bMin}:${bMax}`).digest("hex");
}

/**
 * Build a deterministic cache key for a text-search result set.
 *
 * searchNotes is included in the hash so that different caller-supplied notes
 * never collide on the same cache entry ("cache poisoning across notes").
 * When searchNotes is absent the key is identical to the pre-v4.1 key, so
 * existing warm cache entries remain valid.
 *
 * @param {object} item        - Identified clothing item (needs .search_query or .name)
 * @param {string} gender      - "male" | "female"
 * @param {number} bMin        - Budget minimum
 * @param {number} bMax        - Budget maximum
 * @param {string} [searchNotes] - Optional free-text search refinement
 */
function makeTextCacheKey(item, gender, bMin, bMax, searchNotes = "") {
  const notesSeg = searchNotes ? `:${searchNotes.trim().toLowerCase()}` : "";
  return crypto.createHash("md5").update(`v4t:${gender}:${bMin}:${bMax}:${item.search_query || item.name}${notesSeg}`).digest("hex");
}

async function getCache(key) {
  try {
    const { data } = await supabase.from("product_cache").select("results, expires_at").eq("cache_key", key).single();
    if (data && new Date(data.expires_at) > new Date()) return data.results;
  } catch {}
  return null;
}

async function setCache(key, results) {
  const now = new Date();
  await supabase.from("product_cache").upsert({
    cache_key: key, results,
    cached_at: now.toISOString(),
    expires_at: new Date(now.getTime() + 86400000).toISOString(),
  });
}

// ─── Price extraction (handles both Shopping and Lens formats) ─
function extractPrice(val) {
  if (!val) return null;
  // Lens sometimes returns price as an object: { value: "$118.00", extracted_value: 118 }
  if (typeof val === "object") {
    if (val.extracted_value != null) return parseFloat(val.extracted_value);
    if (val.value) return extractPrice(val.value);
    return null;
  }
  const m = String(val).replace(/,/g, "").match(/(\d+\.?\d*)/);
  return m ? parseFloat(m[1]) : null;
}

// ═════════════════════════════════════════════════════════════
// STEP 1: Google Lens — Visual reverse image search
// ═════════════════════════════════════════════════════════════
async function googleLensSearch(imageUrl) {
  if (!imageUrl) {
    console.log("[Lens] No image URL provided, skipping visual search");
    return [];
  }

  // Cache keyed on the image URL — same URL always produces the same Lens results.
  // Using an md5 prefix so the key stays short and DB-friendly.
  const cacheKey = crypto.createHash("md5").update(`lens:${imageUrl}`).digest("hex");
  const cached = await getCache(cacheKey);
  if (cached) {
    console.log(`[cache] HIT: ${cacheKey}`);
    return cached;
  }
  console.log(`[cache] MISS: ${cacheKey}`);

  console.log(`\n[Lens] Searching with image: ${imageUrl.slice(0, 80)}...`);

  const params = new URLSearchParams({
    engine: "google_lens",
    url: imageUrl,
    api_key: process.env.SERPAPI_KEY,
  });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);

  try {
    const res = await fetch(`${SERPAPI_URL}?${params}`, { signal: controller.signal });
    clearTimeout(timeout);

    if (!res.ok) {
      const text = await res.text();
      console.error(`[Lens] HTTP ${res.status}: ${text.slice(0, 200)}`);
      return [];
    }

    const data = await res.json();

    // Google Lens returns visual_matches (product pages that look like the image)
    const visualMatches = data.visual_matches || [];
    console.log(`[Lens] Got ${visualMatches.length} visual matches`);

    if (visualMatches.length > 0) {
      const s = visualMatches[0];
      console.log(`[Lens] Sample: "${(s.title || "").slice(0, 60)}" source=${s.source} price=${JSON.stringify(s.price)} link=${!!(s.link || s.product_link || s.url)}`);
    }

    // Persist results before returning so the cache is warm for identical image URLs.
    // Only cache non-empty results — an empty array may be a transient API failure
    // and we do not want to lock out a valid retry for 24 hours.
    if (visualMatches.length > 0) {
      await setCache(cacheKey, visualMatches);
    }
    return visualMatches;
  } catch (err) {
    clearTimeout(timeout);
    console.error(`[Lens] Error: ${err.message}`);
    return [];
  }
}

// ═════════════════════════════════════════════════════════════
// STEP 2: Match Lens results to identified items
// ═════════════════════════════════════════════════════════════
// Each Lens result is a product. We figure out which identified
// item it corresponds to based on category/subcategory keywords.

function matchLensResultToItem(result, items) {
  const title = (result.title || "").toLowerCase();
  let bestMatch = -1;
  let bestScore = 0;

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    let score = 0;

    // Subcategory match (most specific)
    const sub = (item.subcategory || "").toLowerCase();
    if (sub && sub.length > 2 && title.includes(sub)) score += 30;
    // Handle plurals: "sneaker" matches "sneakers"
    else if (sub && sub.length > 4 && title.includes(sub.slice(0, -1))) score += 20;

    // Category match (broader)
    const cat = (item.category || "").toLowerCase();
    if (cat && title.includes(cat)) score += 10;

    // Brand match
    const brand = (item.brand || "").toLowerCase();
    if (brand && brand !== "unidentified" && title.includes(brand)) score += 25;

    // Color match
    const color = (item.color || "").toLowerCase();
    if (color && color.length > 2 && title.includes(color)) score += 10;

    // Common clothing keywords to help disambiguate
    const keywords = {
      outerwear: ["jacket", "coat", "blazer", "parka", "vest", "cardigan", "bomber"],
      top: ["shirt", "tee", "t-shirt", "blouse", "polo", "tank", "sweater", "hoodie", "pullover", "sweatshirt", "top", "henley"],
      bottom: ["pants", "jeans", "trousers", "shorts", "joggers", "chinos", "leggings", "skirt"],
      shoes: ["shoe", "sneaker", "boot", "sandal", "loafer", "heel", "flat", "trainer", "runner", "slip-on"],
      dress: ["dress", "gown", "romper", "jumpsuit"],
      accessory: ["hat", "cap", "belt", "watch", "glasses", "sunglasses", "scarf", "tie", "bracelet", "necklace", "ring"],
      bag: ["bag", "purse", "backpack", "tote", "clutch", "wallet"],
    };

    // Check if the title contains keywords for this item's category
    const catKeywords = keywords[cat] || [];
    if (catKeywords.some(kw => title.includes(kw))) score += 15;

    if (score > bestScore) {
      bestScore = score;
      bestMatch = i;
    }
  }

  // Require at least a minimal match (category or subcategory)
  return bestScore >= 10 ? bestMatch : -1;
}

// ═════════════════════════════════════════════════════════════
// STEP 3: Text search fallback (for items Lens didn't cover)
// ═════════════════════════════════════════════════════════════
async function textSearch(query, _priceMin, priceMax) {
  // Cache keyed on query + priceMax — the same query with the same price ceiling
  // always hits the same Shopping results page, so this is a safe cache key.
  // priceMax defaults to 0 in the key when unset so keys stay deterministic.
  const cacheKey = crypto.createHash("md5").update(`text:${query}:${priceMax || 0}`).digest("hex");
  const cached = await getCache(cacheKey);
  if (cached) {
    console.log(`[cache] HIT: ${cacheKey}`);
    return cached;
  }
  console.log(`[cache] MISS: ${cacheKey}`);

  const params = new URLSearchParams({
    engine: "google_shopping",
    q: query,
    api_key: process.env.SERPAPI_KEY,
    hl: "en",
    gl: "us",
    num: "20",
  });
  // Add a price ceiling when a budget is set — this keeps premium headroom but avoids
  // stripping all results for common items that have no products at the floor price.
  if (priceMax != null) {
    params.set("tbs", `price:1,ppr_max:${Math.ceil(priceMax * 1.5)}`);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);

  try {
    console.log(`  [Text] Query: "${query}"`);
    const res = await fetch(`${SERPAPI_URL}?${params}`, { signal: controller.signal });
    clearTimeout(timeout);
    if (!res.ok) return [];
    const data = await res.json();
    const results = data.shopping_results || [];
    console.log(`  [Text] Got ${results.length} results`);

    // Persist non-empty results before returning. Empty arrays are skipped for
    // the same reason as in googleLensSearch — a transient API error should not
    // poison the cache for 24 hours.
    if (results.length > 0) {
      await setCache(cacheKey, results);
    }
    return results;
  } catch (err) {
    clearTimeout(timeout);
    console.error(`  [Text] Error: ${err.message}`);
    return [];
  }
}

// ─── Search query helpers ────────────────────────────────────

/**
 * Normalize typographic/Unicode apostrophes to straight apostrophes so that
 * Claude's AI-generated queries (which use curly quotes) compare correctly
 * to our plain-ASCII gender-prefix strings.
 */
function normalizeApostrophes(str) {
  return str.replace(/[\u2018\u2019\u201A\u201B\u2032]/g, "'");
}

/**
 * Detect whether a query already has a gender prefix.
 * Uses a word-boundary regex so "men's", "mens", "women's", "womens" all match,
 * regardless of apostrophe style (handled by normalizeApostrophes first).
 */
function hasGenderPrefix(q) {
  return /\b(men'?s?|women'?s?|boys?|girls?)\b/i.test(normalizeApostrophes(q));
}

/**
 * Strip qualifiers that confuse shopping search engines.
 * Google Shopping doesn't understand style negations or occasion phrases —
 * worse, "no tie" causes it to return actual neckties.
 */
function cleanForSearch(q) {
  return normalizeApostrophes(q)
    .replace(/\bno\s+\w+/gi, "")           // "no tie", "no logo", "no pattern"
    .replace(/\bwithout\s+\w+/gi, "")      // "without collar"
    .replace(/\bfor\s+(work|office|business|formal|casual|evening|day|night)\b/gi, "")
    .replace(/\b(business\s+casual|smart\s+casual|semi-formal|black\s+tie|dress\s+code)\b/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/**
 * Run text-based Shopping searches for a single identified item.
 *
 * Constructs up to 3 distinct queries (A, B, C/D) and runs them concurrently:
 *   A — Claude's search_query, cleaned, gender-prefixed; searchNotes appended when
 *       it fits within the 150-char Shopping query cap and is not already present.
 *   B — Brand + product line (only for high-confidence brand matches)
 *   C — Simple gender + color + subcategory descriptor (safety-net broadening query);
 *       searchNotes also appended here when it fits within the 150-char cap.
 *   D — Full descriptor with fit/body/size (only if distinct from C)
 *
 * @param {object} item          - Identified clothing item
 * @param {string} gender        - "male" | "female"
 * @param {object} tierBounds    - { min, max } price tier
 * @param {object} [sizePrefs]   - Size preferences ({ body_type, fit, sizes })
 * @param {string} [occasion]    - Occasion key (maps to OCCASION_MODIFIERS)
 * @param {string} [searchNotes] - Free-text caller refinement (e.g. "navy blue only").
 *                                 Injected into Query A and Query C when the combined
 *                                 length stays under MAX_QUERY_LEN characters.
 *                                 Baked into the cache key via makeTextCacheKey so
 *                                 different notes never collide on the same cache entry.
 */
async function textSearchForItem(item, gender, tierBounds, sizePrefs = {}, occasion = null, searchNotes = null) {
  const g = gender === "female" ? "women's" : "men's";
  // Normalise: guard against non-string values, collapse whitespace.
  const notes = typeof searchNotes === "string" ? searchNotes.trim() : "";

  // Maximum total query length for Google Shopping API.
  // Tokens beyond ~150 chars are ignored or degrade relevance ranking.
  const MAX_QUERY_LEN = 150;

  const bodyTypes = Array.isArray(sizePrefs.body_type) ? sizePrefs.body_type : (sizePrefs.body_type ? [sizePrefs.body_type] : []);
  const fitStyles = Array.isArray(sizePrefs.fit) ? sizePrefs.fit : (sizePrefs.fit ? [sizePrefs.fit] : []);
  const bodyTerm = BODY_TYPE_TERMS[bodyTypes[0]] || null;
  const fitTerm = FIT_TERMS[fitStyles[0]] || null;

  // sizeTerm is drawn from sizePrefs.sizes (the per-garment-type size map).
  // For footwear items, also check sizePrefs.shoe_size — a separate top-level field
  // that the profile UI collects independently from the general clothing sizes map.
  // If the general sizes map has a shoe entry it takes precedence; shoe_size fills
  // the gap when only the dedicated shoe size field was filled in.
  let sizeTerm = getSizeTermForItem(item, sizePrefs);
  if (!sizeTerm && sizePrefs.shoe_size != null) {
    const combined = ((item.category || "") + " " + (item.subcategory || "")).toLowerCase();
    const isShoeItem = ["shoe", "sneaker", "boot", "sandal", "loafer", "heel", "flat", "trainer"].some(k => combined.includes(k));
    if (isShoeItem) sizeTerm = String(sizePrefs.shoe_size).trim();
  }

  const occasionTerm = occasion ? OCCASION_MODIFIERS[occasion] || null : null;

  const queries = [];

  // ── Query A: Claude's search_query, cleaned and correctly gender-prefixed ──
  // Fixes: (1) Unicode apostrophe → double prefix bug, (2) "no tie" style noise
  // searchNotes is appended here as the most specific refinement signal —
  // but only when: (a) it fits within MAX_QUERY_LEN, and (b) it is not already
  // present in the query (case-insensitive duplicate guard).
  if (item.search_query) {
    const cleaned = cleanForSearch(item.search_query);
    let q = hasGenderPrefix(cleaned) ? cleaned : `${g} ${cleaned}`;
    if (bodyTerm && !q.toLowerCase().includes(bodyTerm)) q = `${bodyTerm} ${q}`;
    // Append occasion modifier when set (only if not already present in query)
    if (occasionTerm && !q.toLowerCase().includes(occasionTerm.split(" ")[0])) q = `${q} ${occasionTerm}`;
    q = q.replace(/\s{2,}/g, " ").trim();
    if (notes && !q.toLowerCase().includes(notes.toLowerCase())) {
      const withNotes = `${q} ${notes}`;
      if (withNotes.length <= MAX_QUERY_LEN) q = withNotes;
    }
    queries.push(q);
  }

  // ── Query B: Brand + product line (high-confidence brands only) ──
  const brand = item.brand && item.brand !== "Unidentified" ? item.brand : "";
  if (brand && (item.brand_confidence === "confirmed" || item.brand_confidence === "high")) {
    queries.push(item.product_line ? `${brand} ${item.product_line}` : `${brand} ${item.name}`);
  }

  // ── Query C: Simple clean descriptor — guaranteed to find results ──
  // Just gender + color + subcategory, no fit/body/size qualifiers.
  // This is the safety net: even if A is too specific, C always works for
  // common items like "men's white dress shirt".
  // searchNotes are also appended here when the descriptor has room, giving
  // the safety-net query the caller's refinement intent without truncation risk.
  const occasionSuffix = occasionTerm ? ` ${occasionTerm}` : "";
  let simpleDesc = `${g} ${item.color || ""} ${item.subcategory || item.category}${occasionSuffix}`.replace(/\s+/g, " ").trim();
  if (notes && !simpleDesc.toLowerCase().includes(notes.toLowerCase())) {
    const withNotes = `${simpleDesc} ${notes}`;
    if (withNotes.length <= MAX_QUERY_LEN) simpleDesc = withNotes;
  }
  if (!queries.some(q => q.toLowerCase() === simpleDesc.toLowerCase())) {
    queries.push(simpleDesc);
  }

  // ── Query D: Full descriptor with fit/body/size (only if distinct from C) ──
  const bodyPrefix = bodyTerm ? `${bodyTerm} ` : "";
  const fitSuffix = fitTerm ? ` ${fitTerm}` : "";
  const sizeSuffix = sizeTerm ? ` size ${sizeTerm}` : "";
  const fullDesc = `${g} ${bodyPrefix}${item.subcategory || item.category} ${item.color || ""}${fitSuffix}${sizeSuffix}`.replace(/\s+/g, " ").trim();
  if (fullDesc !== simpleDesc && !queries.some(q => q.toLowerCase() === fullDesc.toLowerCase())) {
    queries.push(fullDesc);
  }

  // Run up to 3 unique queries concurrently
  const uniqueQueries = [...new Set(queries.filter(Boolean))].slice(0, 3);
  console.log(`[TextFallback] "${item.name}" → ${uniqueQueries.map(q => `"${q}"`).join(" | ")} budget=$${tierBounds.min}-$${tierBounds.max}${notes ? ` notes="${notes}"` : ""}`);

  const priceCeil = tierBounds.max > DEFAULT_BUDGET.max ? tierBounds.max : null;

  const allResults = [];
  const batches = await Promise.all(uniqueQueries.map(q => textSearch(q, null, priceCeil).catch(() => [])));
  for (const batch of batches) allResults.push(...batch);

  return allResults;
}

// ═════════════════════════════════════════════════════════════
// SCORING — How relevant is this product to the identified item?
// ═════════════════════════════════════════════════════════════
function scoreProduct(product, item, isFromLens, sizePrefs = {}, tierBounds = null) {
  const title = (product.title || "").toLowerCase();
  const source = (product.source || "").toLowerCase();
  const link = product.link || product.product_link || product.url || "";
  const price = extractPrice(product.price) || extractPrice(product.extracted_price);

  // Must point to a genuine vendor/shopping page.
  // This is the primary guard against realtor portfolios, blogs, social media,
  // and any other non-commerce page that Google Lens may match visually.
  if (!isVendorPage(product)) return -1;

  // Text search results MUST have a price (otherwise useless for tiering).
  // Lens results without a price are still accepted if they passed isVendorPage —
  // the vendor check above already ensures they're from a legitimate shop.
  if (!isFromLens && price === null) return -1;

  let score = 0;

  // Lens results get a big base bonus — they're visually matched to the actual photo
  if (isFromLens) score += 25;
  // Lens results WITH a price are even more valuable (can be properly tiered)
  if (isFromLens && price !== null) score += 10;

  // ── Clothing keyword baseline ────────────────────────────────
  // Any product from a verified vendor whose title contains a clothing/fashion
  // keyword gets a small base score. This prevents valid items from scoring
  // exactly 0 and being incorrectly discarded by the score > 0 gate.
  const CLOTHING_KEYWORDS = [
    "shirt", "pant", "jean", "dress", "jacket", "coat", "shoe", "sneaker",
    "boot", "top", "blouse", "skirt", "short", "sweater", "hoodie", "blazer",
    "suit", "trouser", "legging", "vest", "cardigan", "polo", "tee", "sock",
    "hat", "cap", "scarf", "belt", "watch", "bag", "purse", "sandal", "loafer",
    "oxford", "chino", "bomber", "parka", "bra", "underwear", "boxer",
  ];
  if (CLOTHING_KEYWORDS.some(kw => title.includes(kw))) score += 3;

  // ── Subcategory match ────────────────────────────────────────
  const sub = (item.subcategory || "").toLowerCase();
  if (sub && sub.length > 2) {
    if (title.includes(sub)) {
      score += 25;                                              // exact: "dress shirt"
    } else if (title.includes(sub + "s")) {
      score += 22;                                              // singular→plural: "sneaker" → "sneakers"
    } else if (sub.endsWith("s") && title.includes(sub.slice(0, -1))) {
      score += 22;                                              // plural→singular: "sneakers" → "sneaker"
    } else {
      // Multi-word subcategory: "dress shirt" — check if all significant words match
      const subWords = sub.split(/\s+/).filter(w => w.length > 3);
      if (subWords.length > 1 && subWords.every(w => title.includes(w))) score += 20;
      else if (subWords.some(w => w.length > 4 && title.includes(w))) score += 10;
    }
  }

  // ── Category match ───────────────────────────────────────────
  const cat = (item.category || "").toLowerCase();
  if (cat && title.includes(cat)) score += 8;

  // Brand match
  const brand = (item.brand || "").toLowerCase();
  if (brand && brand !== "unidentified") {
    if (title.includes(brand) || source.includes(brand)) score += 30;
    const line = (item.product_line || "").toLowerCase();
    if (line && line.length > 2 && title.includes(line)) score += 20;
  }

  // Color match
  const color = (item.color || "").toLowerCase();
  if (color && color.length > 2 && title.includes(color)) score += 12;

  // Material match
  const material = (item.material || "").toLowerCase();
  if (material && material.length > 3 && title.includes(material)) score += 5;

  // ── Trusted retailer bonus ───────────────────────────────────
  // Established retailers with clean product data and high fulfillment confidence.
  const domain = link.replace(/^https?:\/\/(?:www\.)?/, "").split("/")[0];
  if ([...TRUSTED_RETAILER_DOMAINS].some(d => domain.includes(d))) score += 20;

  // ── Knockoff / counterfeit penalties ────────────────────────
  // Hard penalise known knockoff platforms and replica-signalling title keywords.
  if (KNOCKOFF_DOMAINS.some(d => link.includes(d))) score -= 50;
  if (KNOCKOFF_TITLE_KEYWORDS.some(kw => title.includes(kw))) score -= 50;

  // Penalties
  const isMale = (item.gender || "male") === "male";
  if (isMale && (title.includes("women's") || title.includes("womens"))) score -= 40;
  if (!isMale && (title.includes("men's ") || title.includes("mens "))) score -= 40;
  if (/\b(set of|pack of|\d+\s*pack|bundle)\b/i.test(product.title || "")) score -= 25;

  // Size preference scoring (body_type and fit are arrays)
  const bodyTypes = Array.isArray(sizePrefs.body_type) ? sizePrefs.body_type : (sizePrefs.body_type ? [sizePrefs.body_type] : []);
  const fitStyles = Array.isArray(sizePrefs.fit) ? sizePrefs.fit : (sizePrefs.fit ? [sizePrefs.fit] : []);
  for (const bt of bodyTypes) {
    const bodyTerm = BODY_TYPE_TERMS[bt];
    if (bodyTerm && title.includes(bodyTerm.toLowerCase())) { score += 15; break; }
  }
  // Penalise if title mentions a body type incompatible with ALL user preferences
  const allOpposites = bodyTypes.flatMap(bt => BODY_TYPE_OPPOSITES[bt] || []);
  for (const opp of allOpposites) {
    if (title.includes(opp.toLowerCase())) { score -= 25; break; }
  }
  for (const fs of fitStyles) {
    const fitTerm = FIT_TERMS[fs];
    if (fitTerm && title.includes(fitTerm.toLowerCase())) { score += 10; break; }
  }

  // Price proximity — only applied when the user has set a non-default budget
  // Products in the user's target range get a strong bonus; items that are a fraction
  // of the minimum budget get heavily penalised (e.g. a $15 item for a $1000 budget)
  if (price !== null && tierBounds) {
    const { min, max } = tierBounds;
    if (price >= min && price <= max) {
      score += 30; // squarely in the user's target range
    } else if (price < min) {
      const ratio = price / min;
      if (ratio < 0.1) score -= 50;       // way too cheap (e.g. $10 vs $1000 min)
      else if (ratio < 0.3) score -= 30;  // significantly under budget
      else if (ratio < 0.6) score -= 15;  // moderately under budget
    } else if (price > max) {
      const ratio = price / max;
      if (ratio > 5) score -= 20;         // extreme luxury outlier
      else if (ratio > 2) score -= 8;
    }
  }

  return score;
}

// ─── Format for frontend ────────────────────────────────────
function formatProduct(product, isOriginalBrand) {
  const price = extractPrice(product.price) || extractPrice(product.extracted_price);
  return {
    product_name: product.title || "Unknown",
    brand: product.source || "Unknown",
    price: price != null ? `$${price.toFixed(2)}` : "See price →",
    url: product.link || product.product_link || product.url || "",
    image_url: product.thumbnail || product.image || "",
    is_product_page: true,
    is_identified_brand: isOriginalBrand,
    is_resale: classifyMarket(product) === "resale",
    why: "",
  };
}

function explainMatch(product, item, tier, isFromLens) {
  const title = (product.title || "").toLowerCase();
  const source = (product.source || "").toLowerCase();
  const reasons = [];

  if (isFromLens) reasons.push("visual match");

  const brand = (item.brand || "").toLowerCase();
  if (brand !== "unidentified" && (title.includes(brand) || source.includes(brand))) reasons.push("exact brand");

  const line = (item.product_line || "").toLowerCase();
  if (line && line.length > 2 && title.includes(line)) reasons.push(item.product_line);

  const color = (item.color || "").toLowerCase();
  if (color && title.includes(color)) reasons.push(item.color);

  const price = extractPrice(product.price);
  if (price) reasons.push(`$${price.toFixed(0)}`);

  return reasons.length ? reasons.join(" · ") : `${item.subcategory || item.category} — ${tier} tier`;
}

// ─── Google Shopping fallback link ──────────────────────────
function fallbackTier(item, tier, tierBounds) {
  const g = (item.gender || "male") === "female" ? "women's" : "men's";
  // Clean the query exactly like textSearchForItem does — strip qualifiers,
  // normalize apostrophes, and only add the gender prefix if it's not already there.
  const rawQuery = item.search_query || item.name;
  const cleaned = cleanForSearch(rawQuery);
  const fullQuery = hasGenderPrefix(cleaned) ? cleaned : `${g} ${cleaned}`;
  const q = encodeURIComponent(fullQuery);
  const prices = {
    budget: { min: 0, max: tierBounds.min },
    mid: { min: tierBounds.min, max: tierBounds.max },
    premium: { min: tierBounds.max, max: 99999 },
  }[tier];

  const url = prices.max < 99999
    ? `https://www.google.com/search?tbm=shop&q=${q}&tbs=mr:1,price:1,ppr_min:${prices.min},ppr_max:${prices.max}`
    : `https://www.google.com/search?tbm=shop&q=${q}&tbs=mr:1,price:1,ppr_min:${prices.min}`;

  return {
    product_name: `Search: ${item.name}`,
    brand: "Google Shopping",
    price: prices.max < 99999 ? `$${prices.min}–$${prices.max}` : `$${prices.min}+`,
    url, image_url: "",
    is_product_page: false,
    is_identified_brand: false,
    why: "No exact match — tap to search",
  };
}

// ═════════════════════════════════════════════════════════════
// MAIN: Process all items for a scan
// ═════════════════════════════════════════════════════════════
// ─── Occasion → search modifier ─────────────────────────────
// Each modifier is injected into Shopping text queries as a suffix or prefix
// qualifier. Shorter, keyword-focused terms outperform compound phrases in
// Google Shopping because the index matches on discrete tokens — redundant
// words dilute ranking and can confuse the query parser.
//
// Change log (v4.1):
//   casual:    "casual everyday"      → "casual"
//              Reason: "everyday" is redundant; "casual" alone is the recognised
//              Shopping category signal.
//   work:      "office business professional" → "business professional"
//              Reason: "office" duplicates the intent of "business professional";
//              removing it tightens the token budget.
//   night_out: "going out night club" → "going out nightlife"
//              Reason: "night club" is over-specific and conflates the venue with
//              the garment style. "nightlife" is a broader, better-indexed term.
//   athletic:  "athletic gym workout activewear" → "activewear"
//              Reason: "activewear" is a registered Google Shopping product
//              category keyword. The prior compound phrase spread signal across
//              4 tokens and occasionally matched gym equipment listings.
//   formal:    "formal event dress code" → "formal"
//              Reason: "dress code" caused Shopping to return men's dress-code
//              articles and suits rather than the actual garment. "formal" alone
//              maps cleanly to the Shopping taxonomy.
//   outdoor:   "outdoor adventure hiking" → "outdoor"
//              Reason: "adventure" and "hiking" over-specialise; a user wearing
//              an outdoor jacket to a park would miss all results. "outdoor"
//              covers the category without locking to a single activity.
//
// ── Effectiveness audit (v4.2, 2026-03-24) ──────────────────────────────────
//
//   casual: "casual"
//     EFFECTIVE. "casual" is a well-indexed attribute in Google Shopping's
//     product taxonomy. Appending it to a query like "men's white linen shirt"
//     reliably surfaces casual/relaxed fits rather than formal ones.
//
//   work: "business professional"
//     EFFECTIVE. Both tokens are indexed Shopping attributes; the two-word
//     phrase is short enough to not dilute the garment keywords. Surfaces
//     blazers, dress shirts, trousers correctly.
//
//   night_out: "going out nightlife"
//     MARGINAL. Neither "going out" nor "nightlife" appear as standard Google
//     Shopping product-attribute terms. Retailers label garments "party",
//     "cocktail", or "evening" — not "nightlife". In practice this modifier
//     may not change results at all for most queries.
//     FUTURE IMPROVEMENT: Change to "cocktail party" — both words appear as
//     recognised Shopping product attributes and map to the correct garment
//     style (bodycon dresses, blazers, etc.) without over-constraining to a
//     venue type.
//
//   athletic: "activewear"
//     EFFECTIVE. "activewear" is a registered Google Shopping product category
//     node. Appending it strongly filters toward performance/gym garments.
//
//   formal: "formal"
//     EFFECTIVE. Single-token, clean Shopping category signal. Surfaces suits,
//     gowns, and formal accessories as expected.
//
//   outdoor: "outdoor"
//     EFFECTIVE. Broad enough to cover jackets, boots, and base layers without
//     locking to a specific activity. Pairs well with most garment types.
//
// ── Gender prefix strategy ───────────────────────────────────────────────────
//   g = gender === "female" ? "women's" : "men's"
//   "women's" and "men's" are the standard apostrophe forms used by retailers
//   and indexed by Google Shopping. "female"/"male" are not Shopping terms and
//   would degrade results. The hasGenderPrefix guard (regex: \b(men'?s?|women'?s?|
//   boys?|girls?)\b) correctly prevents double-prefixing even when Claude's output
//   uses Unicode curly apostrophes (normalizeApostrophes handles those first).
//
// ── search_notes injection ───────────────────────────────────────────────────
//   search_notes is appended to Query A and Query C when:
//     (a) it is non-empty, (b) the combined length stays under MAX_QUERY_LEN
//     (150 chars), and (c) the note is not already present in the query.
//   It is baked into the text cache key (makeTextCacheKey) so different notes
//   never collide on the same cache entry.
//   STATUS: fully implemented.
//
// ── shoe_size ────────────────────────────────────────────────────────────────
//   sizePrefs.shoe_size is a dedicated numeric field collected by the profile UI.
//   Prior to v4.2 it was silently ignored — getSizeTermForItem only read
//   sizePrefs.sizes.shoes. As of v4.2 it is used as a fallback sizeTerm for
//   shoe-category items in Query D when sizePrefs.sizes.shoes is absent.
//   It does NOT affect Query A or C (to avoid over-constraining those queries).
const OCCASION_MODIFIERS = {
  casual:    "casual",
  work:      "business professional",
  night_out: "going out nightlife",   // FUTURE IMPROVEMENT: change to "cocktail party"
  athletic:  "activewear",
  formal:    "formal",
  outdoor:   "outdoor",
};

export async function findProductsForItems(items, gender, budgetMin, budgetMax, imageUrl, sizePrefs = {}, occasion = null, searchNotes = null) {
  cleanupExpiredCache();
  const defaultTierBounds = getTierBounds(budgetMin, budgetMax);
  const defaultSizePrefs = sizePrefs;

  // Helper: per-item tier bounds from _budget_min/_budget_max, falling back to profile defaults.
  function getItemTierBounds(item) {
    if (item._budget_min != null || item._budget_max != null) {
      return getTierBounds(item._budget_min, item._budget_max);
    }
    return defaultTierBounds;
  }
  function getItemSizePrefs(item) {
    return item._size_prefs != null ? item._size_prefs : defaultSizePrefs;
  }
  // "both" | "retail" | "resale" — defaults to "both" if not specified
  function getItemMarketPref(item) {
    return item._market_pref || "both";
  }

  // ── Step 1: Google Lens on the full image ─────────
  const lensResults = await googleLensSearch(imageUrl);

  // ── Step 2: Match Lens results to identified items ─
  // Each item gets a pool of matched products
  const itemPools = items.map(() => ({ lens: [], text: [] }));

  for (const result of lensResults) {
    const matchIdx = matchLensResultToItem(result, items);
    if (matchIdx >= 0) {
      itemPools[matchIdx].lens.push(result);
    }
  }

  // Log Lens matching
  for (let i = 0; i < items.length; i++) {
    console.log(`[Match] "${items[i].name}" ← ${itemPools[i].lens.length} Lens matches`);
  }

  // ── Step 3: Text search fallback for items with few USEFUL Lens matches
  const textPromises = items.map(async (item, i) => {
    // Count Lens results that actually have prices
    const pricedLens = itemPools[i].lens.filter(r => {
      const p = extractPrice(r.price) || extractPrice(r.extracted_price);
      return p !== null;
    });
    // Text search if we have fewer than 3 priced Lens results
    if (pricedLens.length < 3) {
      const textResults = await textSearchForItem(item, gender, getItemTierBounds(item), getItemSizePrefs(item), occasion, searchNotes);
      itemPools[i].text = textResults;
      console.log(`[Match] "${item.name}" ← ${textResults.length} text results (supplementing ${itemPools[i].lens.length} Lens, ${pricedLens.length} with price)`);
    }
  });
  await Promise.all(textPromises);

  // ── Step 4: Score, tier, and pick for each item ───
  // NEW ARCHITECTURE:
  // 1. Find the ORIGINAL product (brand-matched Lens result) → it gets "mid" tier with ORIGINAL badge
  // 2. Budget = cheaper alternative, Premium = pricier alternative
  // 3. If no original found, fall back to best-in-each-tier as before
  const output = items.map((rawItem, i) => {
    const itemTierBounds = getItemTierBounds(rawItem);
    const itemSizePrefs = getItemSizePrefs(rawItem);
    const itemMarketPref = getItemMarketPref(rawItem);
    const item = { ...rawItem, gender };
    const pool = itemPools[i];
    const brandLower = (item.brand || "").toLowerCase();
    const hasBrand = brandLower && brandLower !== "unidentified";

    // Combine Lens + text results, deduplicate by URL
    const seen = new Set();
    const allProducts = [];

    for (const r of pool.lens) {
      const url = r.link || r.product_link || r.url || "";
      if (url && !seen.has(url)) { seen.add(url); allProducts.push({ product: r, isLens: true }); }
    }
    for (const r of pool.text) {
      const url = r.link || r.product_link || "";
      if (url && !seen.has(url)) { seen.add(url); allProducts.push({ product: r, isLens: false }); }
    }

    // ── Market preference filter ────────────────────────────
    // Apply before scoring so market-excluded products never appear in any tier.
    const marketFiltered = itemMarketPref === "both"
      ? allProducts
      : allProducts.filter(({ product }) => isAllowedByMarket(product, itemMarketPref));

    if (itemMarketPref !== "both") {
      console.log(`[Market] "${item.name}": pref="${itemMarketPref}" — ${allProducts.length} total → ${marketFiltered.length} after filter`);
    }

    // Score everything
    const allScored = marketFiltered
      .map(({ product, isLens }) => ({
        product,
        isLens,
        score: scoreProduct(product, item, isLens, itemSizePrefs, itemTierBounds),
        price: extractPrice(product.price) || extractPrice(product.extracted_price),
      }))
      .filter(s => s.score > 0)
      .sort((a, b) => b.score - a.score);

    // Hard floor: exclude products priced implausibly below the user's budget minimum.
    // e.g. a $15 cap when budget min is $1000 is almost certainly a different product.
    const isCustomBudget = itemTierBounds.min > DEFAULT_BUDGET.min;
    const priceFloor = isCustomBudget ? itemTierBounds.min * 0.15 : 0;

    // ── Separate resale from retail before tiering ──────────
    // Resale products get their own dedicated tier; retail-only pool feeds budget/mid/premium.
    const resaleScored = allScored.filter(s => classifyMarket(s.product) === "resale");
    const retailScored = allScored.filter(s => classifyMarket(s.product) !== "resale");

    // Rebuild retail-only priced/unpriced pools
    const pricedRetail = retailScored.filter(s => s.price !== null && s.price >= priceFloor);
    const unpricedRetail = retailScored.filter(s => s.price === null);

    // Top resale products (up to 3, already scored and deduped)
    const resaleFormatted = resaleScored.slice(0, 3).map(s => {
      const isBrand = hasBrand && (
        (s.product.title || "").toLowerCase().includes(brandLower) ||
        (s.product.source || "").toLowerCase().includes(brandLower)
      );
      const formatted = formatProduct(s.product, isBrand);
      formatted.why = explainMatch(s.product, item, "resale", s.isLens);
      return formatted;
    });

    // ── Find the ORIGINAL product (retail only) ─────────────
    // = Lens result whose title or source matches the identified brand
    let original = null;
    if (hasBrand) {
      original = retailScored.find(s => {
        const t = (s.product.title || "").toLowerCase();
        const src = (s.product.source || "").toLowerCase();
        return s.isLens && (t.includes(brandLower) || src.includes(brandLower));
      });
      if (original) {
        console.log(`[Original] "${item.name}" → FOUND: "${(original.product.title || "").slice(0, 60)}" ${original.price != null ? "$" + original.price : "no-price"} [LENS]`);
      }
    }

    console.log(`[Tier] "${item.name}": ${pricedRetail.length} retail-priced + ${resaleScored.length} resale (bounds: $${itemTierBounds.min}-$${itemTierBounds.max})`);
    if (retailScored.length > 0) {
      for (const s of retailScored.slice(0, 3)) {
        console.log(`  → score=${s.score} ${s.price != null ? "$" + s.price : "no-price"} ${s.isLens ? "[LENS]" : "[TEXT]"} "${(s.product.title || "").slice(0, 55)}"`);
      }
    }

    const usedUrls = new Set();
    function getUrl(s) { return s.product.link || s.product.product_link || s.product.url || ""; }

    function formatAndTrack(s, tier, isBrandMatch) {
      usedUrls.add(getUrl(s));
      const formatted = formatProduct(s.product, isBrandMatch);
      formatted.why = explainMatch(s.product, item, tier, s.isLens);
      return formatted;
    }

    // Pick up to `n` products from candidates, deduped by URL.
    function pickTopN(candidates, n, tier) {
      const results = [];
      for (const s of candidates) {
        if (results.length >= n) break;
        const url = getUrl(s);
        if (!usedUrls.has(url)) {
          const isBrand = hasBrand && (
            (s.product.title || "").toLowerCase().includes(brandLower) ||
            (s.product.source || "").toLowerCase().includes(brandLower)
          );
          results.push(formatAndTrack(s, tier, isBrand));
        }
      }
      return results;
    }

    const tiers = { budget: [], mid: [], premium: [] };

    if (original) {
      // ── ORIGINAL FOUND: place it in mid, alternatives in budget/premium ──
      usedUrls.add(getUrl(original));
      const origFormatted = formatProduct(original.product, true);
      origFormatted.why = explainMatch(original.product, item, "mid", original.isLens);
      tiers.mid = [origFormatted];

      // Pick one more mid-tier product near the same price range
      const midCompanions = pricedRetail
        .filter(s => !usedUrls.has(getUrl(s)) && s.price != null &&
          Math.abs(s.price - (original.price || itemTierBounds.min)) / Math.max(original.price || 1, 1) < 0.5)
        .sort((a, b) => b.score - a.score);
      tiers.mid.push(...pickTopN(midCompanions.slice(0, 5), 1, "mid"));

      // Budget = best-scored retail cheaper than original
      const origPrice = original.price || itemTierBounds.min;
      const cheaper = pricedRetail
        .filter(s => !usedUrls.has(getUrl(s)) && s.price < origPrice && s.price >= origPrice * 0.15)
        .sort((a, b) => b.score - a.score);
      tiers.budget.push(...pickTopN(cheaper, 2, "budget"));

      // Premium = most expensive above original
      const pricier = pricedRetail
        .filter(s => !usedUrls.has(getUrl(s)) && s.price > origPrice)
        .sort((a, b) => b.price - a.price);
      tiers.premium.push(...pickTopN(pricier, 2, "premium"));

      // Fill any still-empty tiers with unpriced Lens results
      if (!tiers.budget.length) tiers.budget.push(...pickTopN(unpricedRetail, 2, "budget"));
      if (!tiers.premium.length) tiers.premium.push(...pickTopN(unpricedRetail, 2, "premium"));

    } else {
      // ── NO ORIGINAL: partition by price as before, return up to 2 per tier ──
      const budgetPool = pricedRetail.filter(s => s.price < itemTierBounds.min).sort((a, b) => b.score - a.score);
      const midPool = pricedRetail.filter(s => s.price >= itemTierBounds.min && s.price <= itemTierBounds.max).sort((a, b) => b.score - a.score);
      const premiumPool = pricedRetail.filter(s => s.price > itemTierBounds.max).sort((a, b) => b.score - a.score);

      tiers.budget.push(...pickTopN(budgetPool, 2, "budget"));
      tiers.mid.push(...pickTopN(midPool, 2, "mid"));
      tiers.premium.push(...pickTopN(premiumPool, 2, "premium"));

      // Widen budget tier only
      if (!tiers.budget.length) tiers.budget.push(...pickTopN(pricedRetail, 2, "budget"));
      if (!tiers.budget.length) tiers.budget.push(...pickTopN(unpricedRetail, 2, "budget"));

      // For mid and premium: fall back to unpriced Lens results only
      if (!tiers.mid.length) tiers.mid.push(...pickTopN(unpricedRetail, 2, "mid"));
      if (!tiers.premium.length) tiers.premium.push(...pickTopN(unpricedRetail, 2, "premium"));
    }

    const brandVerified = item.brand && item.brand !== "Unidentified" &&
      [...tiers.budget, ...tiers.mid, ...tiers.premium].some(t => t?.is_identified_brand);

    return {
      item_index: rawItem._scan_item_index ?? i,
      brand_verified: brandVerified,
      tiers: {
        budget: tiers.budget.length ? tiers.budget : [fallbackTier(item, "budget", itemTierBounds)],
        mid: tiers.mid.length ? tiers.mid : [fallbackTier(item, "mid", itemTierBounds)],
        premium: tiers.premium.length ? tiers.premium : [fallbackTier(item, "premium", itemTierBounds)],
        resale: resaleFormatted,
      },
    };
  });

  return output;
}

// ─── Test exports (only used by vitest, never in production) ─
// These expose pure functions so the test suite can exercise them directly
// without mocking the entire findProductsForItems pipeline.
export const _testExports = {
  scoreProduct,
  isVendorPage,
  matchLensResultToItem,
  classifyMarket,
  extractPrice,
  getTierBounds,
};