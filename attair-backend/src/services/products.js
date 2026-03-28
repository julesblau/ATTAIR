import supabase from "../lib/supabase.js";
import crypto from "crypto";
import { rerankCandidates } from "./claude.js";

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

// Cache TTLs — shorter for price-sensitive text search, longer for visual matches
const CACHE_TTL_LENS = 12 * 60 * 60 * 1000;   // 12 hours — Lens visual matches are stable
const CACHE_TTL_TEXT = 6 * 60 * 60 * 1000;     // 6 hours — text/Shopping results have price volatility

async function setCache(key, results, ttlMs = CACHE_TTL_TEXT) {
  const now = new Date();
  await supabase.from("product_cache").upsert({
    cache_key: key, results,
    cached_at: now.toISOString(),
    expires_at: new Date(now.getTime() + ttlMs).toISOString(),
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
/**
 * Validate that a Supabase Storage URL is publicly accessible.
 * SerpAPI needs to fetch the image without authentication.
 * Returns true if the URL responds with 200, false otherwise.
 */
async function validateImageUrl(imageUrl) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(imageUrl, { method: "HEAD", signal: controller.signal });
    clearTimeout(timeout);
    if (!res.ok) {
      console.error(`[Lens] IMAGE URL VALIDATION FAILED: HTTP ${res.status} for ${imageUrl.slice(0, 80)}...`);
      console.error("[Lens] This means SerpAPI cannot fetch your image. Check that:");
      console.error("[Lens]   1. Supabase Storage bucket 'scan-images' is set to PUBLIC");
      console.error("[Lens]   2. RLS policies allow anonymous read access");
      console.error("[Lens]   3. The URL is not a signed/private URL");
      return false;
    }
    return true;
  } catch (err) {
    console.error(`[Lens] IMAGE URL VALIDATION ERROR: ${err.message}`);
    return false;
  }
}

async function googleLensSearch(imageUrl) {
  if (!imageUrl) {
    console.warn("[Lens] WARNING: No image URL for Lens search — text-only fallback will run.");
    console.warn("[Lens] Ensure Supabase Storage bucket 'scan-images' is PUBLIC and image upload completes before search.");
    return [];
  }

  // Validate the URL is publicly accessible before wasting a SerpAPI call
  const isAccessible = await validateImageUrl(imageUrl);
  if (!isAccessible) {
    console.error(`[Lens] SKIPPING Lens search — image URL is not publicly accessible. Fix Supabase Storage permissions.`);
    return [];
  }

  // Cache keyed on the image URL — same URL always produces the same Lens results.
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
      await setCache(cacheKey, visualMatches, CACHE_TTL_LENS);
    }
    return visualMatches;
  } catch (err) {
    clearTimeout(timeout);
    console.error(`[Lens] Error: ${err.message}`);
    return [];
  }
}

/**
 * Extended text search — runs additional query variants for deeper coverage.
 * Used in "extended" search mode to supplement the standard 3-query text search.
 *
 * Generates queries the standard search doesn't:
 *   - alt_search (brand-agnostic fallback from Claude)
 *   - Brand + retailer-specific queries (e.g. "Nordstrom Ralph Lauren polo")
 *   - Material + subcategory (e.g. "men's cotton piqué polo")
 *   - Construction detail queries (e.g. "men's half-zip mock neck sweater")
 */
async function extendedTextSearch(item, gender, tierBounds) {
  const g = gender === "female" ? "women's" : "men's";
  const queries = [];

  // alt_search — Claude's brand-agnostic fallback (not used in standard search)
  if (item.alt_search) {
    const alt = stripShoppingNoise(cleanForSearch(item.alt_search));
    const q = hasGenderPrefix(alt) ? alt : `${g} ${alt}`;
    if (q.length <= 80) queries.push(q);
  }

  // Material + subcategory — finds items by fabric rather than brand
  const material = (item.material || "").toLowerCase();
  const sub = (item.subcategory || "").trim();
  if (material && sub) {
    // Extract the most specific material word (skip "heavyweight", "lightweight", etc.)
    const matWords = material.split(/\s+/).filter(w => w.length > 3 && !["lightweight", "heavyweight", "midweight"].includes(w));
    const keyMaterial = matWords.slice(-2).join(" "); // last 2 words tend to be the fabric type
    if (keyMaterial) {
      const matQuery = `${g} ${keyMaterial} ${sub}`.slice(0, 80);
      queries.push(matQuery);
    }
  }

  // Construction detail query — finds items by specific features
  const construction = (item.construction_details || "").toLowerCase();
  if (construction && sub) {
    const constructionWords = construction.split(/[,]+/).map(s => s.trim()).filter(s => s.length > 3);
    if (constructionWords.length > 0) {
      const detailQuery = `${g} ${constructionWords[0]} ${sub}`.slice(0, 80);
      queries.push(detailQuery);
    }
  }

  // Brand + top retailer query (if brand is known)
  const brand = item.brand && item.brand !== "Unidentified" ? item.brand.trim() : "";
  if (brand && (item.brand_confidence === "confirmed" || item.brand_confidence === "high")) {
    const retailers = ["Nordstrom", "SSENSE", "Farfetch"];
    const retailerQuery = `${retailers[0]} ${brand} ${sub || item.category}`.slice(0, 80);
    queries.push(retailerQuery);
  }

  // Deduplicate
  const uniqueQueries = [...new Set(queries.filter(Boolean))].slice(0, 3);
  if (uniqueQueries.length === 0) return [];

  console.log(`[ExtendedText] "${item.name}" → ${uniqueQueries.map(q => `"${q}"`).join(" | ")}`);

  const priceCeil = tierBounds.max > DEFAULT_BUDGET.max ? tierBounds.max : null;
  const allResults = [];
  const batches = await Promise.all(uniqueQueries.map(q => textSearch(q, null, priceCeil).catch(() => [])));
  for (const batch of batches) allResults.push(...batch);
  return allResults;
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
 * Adjectives and descriptors that Claude's AI output commonly produces but
 * that Google Shopping does NOT index on product titles. Including them in a
 * query shrinks the result set dramatically — or returns 0 results — because
 * Shopping tries to match all tokens.
 *
 * These are stripped by stripShoppingNoise() before any Shopping API call.
 * Words must be whole-word matched (surrounded by \b) to avoid stripping
 * meaningful substrings (e.g. "light" inside "lightweight" is stripped, but
 * we use word boundaries so "lights" won't strip the word "light" inside
 * "highlights").
 *
 * When adding words: prefer the base/root form; the regex strips them
 * case-insensitively with word-boundary anchors.
 */
const SHOPPING_NOISE_WORDS = [
  // Subjective style adjectives — not indexed by Shopping
  "beautifully", "beautiful", "stylish", "stylishly", "elegant", "elegantly",
  "classic", "classical", "timeless", "sophisticated", "chic",
  "comfortable", "comfortably", "cozy", "cosy",
  "premium", "quality", "luxurious", "luxury",
  "lightweight", "light-weight", "breathable",
  "tailored", "well-tailored", "perfectly tailored",
  "versatile", "effortless", "effortlessly",
  "minimal", "minimalist", "minimalistic",
  "trendy", "fashionable",
  "everyday", // "everyday" dilutes Shopping queries — use occasion modifiers instead
  // Occasion/use-case phrases that are NOT Shopping product attributes
  "for any occasion", "all occasions", "day to night",
  // Filler words that add no Shopping signal
  "great", "nice", "perfect", "ideal", "excellent",
  "modern", "contemporary",
  "high quality", "high-quality",
];

/**
 * Remove AI-generated adjectives and filler words that Google Shopping does
 * not index. After stripping, collapse extra whitespace.
 *
 * This is applied on top of cleanForSearch() — use both together for queries
 * that come from Claude's search_query field.
 *
 * @param {string} q - Query string
 * @returns {string} Cleaned query string
 */
function stripShoppingNoise(q) {
  let out = q;
  for (const word of SHOPPING_NOISE_WORDS) {
    // Escape any regex metacharacters in the noise word (e.g. hyphens)
    const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    out = out.replace(new RegExp(`\\b${escaped}\\b`, "gi"), "");
  }
  return out.replace(/\s{2,}/g, " ").trim();
}

/**
 * Build a ranked set of Shopping-optimised queries for a single item.
 *
 * Unlike the original textSearchForItem query builder, these queries are
 * short and use only tokens that Google Shopping actually indexes. The
 * queries are ordered from most specific to broadest so that if the first
 * query returns 0 results, subsequent ones definitely will.
 *
 * The final "nuclear fallback" query ({gender} {category}) is guaranteed to
 * return results for any valid clothing category.
 *
 * Query order and reasoning:
 *   1. Brand + subcategory  → most specific; will miss no-brand photos
 *   2. Color + subcategory  → still specific but works without a brand
 *   3. Subcategory alone    → reliable for common garment types
 *   4. Category alone       → nuclear fallback; ALWAYS returns results
 *
 * Queries 1–3 include the gender prefix because Shopping uses it as a
 * hard filter on the product catalog. Query 4 (the nuclear fallback) also
 * includes the gender prefix for the same reason.
 *
 * @param {object} item   - Identified clothing item with .brand, .color, .subcategory, .category
 * @param {string} gender - "male" | "female"
 * @returns {string[]} Array of 2–4 distinct query strings, shortest-first
 */
function buildShoppingQueries(item, gender) {
  const g = gender === "female" ? "women's" : "men's";
  const brand = item.brand && item.brand !== "Unidentified" ? item.brand.trim() : "";
  const color = (item.color || "").trim();
  const sub = (item.subcategory || "").trim();
  const cat = (item.category || "").trim();

  const queries = [];

  // Query 1: Brand + subcategory (only when brand is known)
  if (brand && sub) queries.push(`${g} ${brand} ${sub}`);
  else if (brand && cat) queries.push(`${g} ${brand} ${cat}`);

  // Query 2: Color + subcategory (skip if color is empty or redundant)
  if (color && sub) queries.push(`${g} ${color} ${sub}`);
  else if (color && cat) queries.push(`${g} ${color} ${cat}`);

  // Query 3: Subcategory (or category) alone — reliable fallback
  if (sub) queries.push(`${g} ${sub}`);
  else if (cat) queries.push(`${g} ${cat}`);

  // Query 4: Nuclear fallback — bare category ALWAYS returns results.
  // Only added when subcategory is present (otherwise query 3 already covers this).
  if (sub && cat && !queries.some(q => q === `${g} ${cat}`)) {
    queries.push(`${g} ${cat}`);
  }

  // Deduplicate while preserving order
  return [...new Set(queries.filter(Boolean))];
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
async function textSearchForItem(item, gender, tierBounds, sizePrefs = {}, occasion = null, searchNotes = null, customOccasionModifiers = null) {
  const g = gender === "female" ? "women's" : "men's";
  // Normalise: guard against non-string values, collapse whitespace.
  const notes = typeof searchNotes === "string" ? searchNotes.trim() : "";

  // Maximum total query length for Google Shopping API.
  // CHANGED: reduced from 150 to 80. Google Shopping degrades noticeably beyond
  // ~80 characters — extra tokens dilute the query signal and can return 0 results
  // when the tail tokens are non-indexed adjectives from Claude's AI output.
  // Query A now also runs through stripShoppingNoise() to remove adjectives before
  // the 80-char limit is applied.
  const MAX_QUERY_LEN = 80;

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

  const occasionTerm = occasion ? OCCASION_MODIFIERS[occasion] || null : (customOccasionModifiers || null);

  const queries = [];

  // ── Query A: Claude's search_query, cleaned and correctly gender-prefixed ──
  // Two-pass cleaning: cleanForSearch() removes occasion/negation phrases, then
  // stripShoppingNoise() removes AI-generated adjectives that Shopping doesn't index.
  // searchNotes is appended when it fits within the new 80-char limit.
  if (item.search_query) {
    const cleaned = stripShoppingNoise(cleanForSearch(item.search_query));
    let q = hasGenderPrefix(cleaned) ? cleaned : `${g} ${cleaned}`;
    if (bodyTerm && !q.toLowerCase().includes(bodyTerm)) q = `${bodyTerm} ${q}`;
    // Append occasion modifier when set (only if not already present in query)
    if (occasionTerm && !q.toLowerCase().includes(occasionTerm.split(" ")[0])) q = `${q} ${occasionTerm}`;
    q = q.replace(/\s{2,}/g, " ").trim();
    // Truncate to MAX_QUERY_LEN before appending notes (keeps the query tight)
    if (q.length > MAX_QUERY_LEN) q = q.slice(0, MAX_QUERY_LEN).trim();
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

  // ── Query B2: alt_search — Claude's brand-agnostic alternative ──
  // This is a separate search query Claude generates specifically for finding
  // similar items regardless of brand. Useful when brand search fails or when
  // the brand is unidentified.
  if (item.alt_search && item.alt_search !== item.search_query) {
    const altCleaned = stripShoppingNoise(cleanForSearch(item.alt_search));
    const altQ = hasGenderPrefix(altCleaned) ? altCleaned : `${g} ${altCleaned}`;
    if (altQ.length <= MAX_QUERY_LEN && !queries.some(q => q.toLowerCase() === altQ.toLowerCase())) {
      queries.push(altQ);
    }
  }

  // ── Queries C/D/E: buildShoppingQueries — short, Shopping-indexed fallbacks ──
  //
  // buildShoppingQueries() generates up to 4 progressively broader queries:
  //   C: {gender} {brand} {subcategory}
  //   D: {gender} {color} {subcategory}
  //   E: {gender} {subcategory}
  //   F: {gender} {category}    ← nuclear fallback, ALWAYS returns results
  //
  // These replace the old Query C/D pair. They are shorter, Shopping-indexed, and
  // guaranteed to produce results because the broadest form is just gender + category.
  // searchNotes are appended to the first Shopping query that has room (≤ 80 chars).
  const shoppingFallbacks = buildShoppingQueries(item, gender);
  let notesInjected = false;
  for (const sq of shoppingFallbacks) {
    if (!queries.some(q => q.toLowerCase() === sq.toLowerCase())) {
      // Inject searchNotes into the first fallback that has room
      if (notes && !notesInjected && !sq.toLowerCase().includes(notes.toLowerCase())) {
        const withNotes = `${sq} ${notes}`;
        if (withNotes.length <= MAX_QUERY_LEN) {
          queries.push(withNotes);
          notesInjected = true;
          continue;
        }
      }
      queries.push(sq);
    }
  }

  // Also include the full-descriptor query (fit + size) if distinct and short enough
  const occasionSuffix = occasionTerm ? ` ${occasionTerm}` : "";
  const bodyPrefix = bodyTerm ? `${bodyTerm} ` : "";
  const fitSuffix = fitTerm ? ` ${fitTerm}` : "";
  const sizeSuffix = sizeTerm ? ` size ${sizeTerm}` : "";
  const fullDesc = `${g} ${bodyPrefix}${item.subcategory || item.category} ${item.color || ""}${fitSuffix}${sizeSuffix}${occasionSuffix}`.replace(/\s+/g, " ").trim();
  if (fullDesc.length <= MAX_QUERY_LEN && !queries.some(q => q.toLowerCase() === fullDesc.toLowerCase())) {
    queries.push(fullDesc);
  }

  // Run up to 3 unique queries concurrently.
  // We prioritise the first 3 as they are most specific. If those return 0 results
  // the broadest fallback (last element from buildShoppingQueries) is guaranteed to
  // return something, so we cap at 3 to avoid unnecessary API calls.
  const uniqueQueries = [...new Set(queries.filter(Boolean))].slice(0, 3);
  console.log(`[TextFallback] "${item.name}" → ${uniqueQueries.map(q => `"${q}"`).join(" | ")} budget=$${tierBounds.min}-$${tierBounds.max}${notes ? ` notes="${notes}"` : ""}`);

  const priceCeil = tierBounds.max > DEFAULT_BUDGET.max ? tierBounds.max : null;

  const allResults = [];
  const batches = await Promise.all(uniqueQueries.map(q => textSearch(q, null, priceCeil).catch(() => [])));
  for (const batch of batches) allResults.push(...batch);

  return allResults;
}

// ═════════════════════════════════════════════════════════════
// SYNONYM MAP — Common garment name equivalences
// ═════════════════════════════════════════════════════════════
//
// Retailers and Claude's AI output use different names for the same garment.
// "chinos" ≠ "khakis" in a string comparison, but they ARE the same product.
// Without synonyms, a product titled "khaki pants" scores 0 for subcategory
// match when the identified item is "chinos" — causing it to be filtered out
// even though it is a correct result.
//
// Each entry is a synonym group (array of equivalent terms). During scoring,
// if the product title contains any synonym of the item's subcategory, we
// award +20 (slightly less than the +25 exact match, to preserve ranking order
// while still keeping synonym matches well above the score > 0 gate).
//
// How to maintain this list:
//   - Add groups when you observe mismatches in product search logs.
//   - Keep terms lowercase (matching is done on lowercased title).
//   - Terms must be 3+ chars to avoid false-positive partial matches.
//   - Prefer the retailer-facing term as the first entry in each group.
const GARMENT_SYNONYMS = [
  ["chinos", "khakis", "khaki pants", "chino trousers"],
  ["hoodie", "hooded sweatshirt", "hooded pullover", "zip-up hoodie"],
  ["sneakers", "trainers", "running shoes", "athletic shoes", "tennis shoes"],
  ["t-shirt", "tee", "tee shirt", "crew neck tee", "crewneck tee"],
  ["blazer", "sport coat", "sports coat", "suit jacket", "sport jacket"],
  ["joggers", "sweatpants", "track pants", "jogging pants", "tracksuit bottoms"],
  ["polo", "polo shirt", "polo top"],
  ["dress shirt", "button-down", "button-up", "button down shirt", "button up shirt", "oxford shirt"],
  ["bomber", "bomber jacket", "flight jacket"],
  ["parka", "winter jacket", "puffy jacket", "puffer jacket", "down jacket"],
  ["loafers", "slip-ons", "slip on shoes", "moccasins"],
  ["sandals", "slides", "flip-flops", "flip flops", "thongs"],
  ["cardigan", "knit sweater", "open-front sweater"],
  ["tank top", "sleeveless top", "muscle tee", "singlet"],
  ["leggings", "tights", "running tights"],
  ["windbreaker", "rain jacket", "shell jacket", "anorak", "cagoule"],
  ["jeans", "denim pants", "denim trousers", "denim jeans"],
  ["shorts", "short pants", "board shorts", "chino shorts"],
  ["sweatshirt", "crewneck sweatshirt", "crew neck sweatshirt", "pullover sweatshirt"],
  ["vest", "gilet", "puffer vest", "down vest", "quilted vest"],
  ["boots", "ankle boots", "chelsea boots", "combat boots"],
  ["coat", "overcoat", "topcoat", "wool coat", "trench coat"],
];

/**
 * Given an item's subcategory string, return all known synonyms (lowercased).
 * Returns an empty array if the subcategory is not in the synonym map.
 *
 * @param {string} subcategory - Item subcategory (already lowercased)
 * @returns {string[]} All synonyms for the given subcategory (excluding itself)
 */
function getSynonyms(subcategory) {
  if (!subcategory) return [];
  for (const group of GARMENT_SYNONYMS) {
    // Check if any term in the group matches (substring or exact)
    const match = group.some(term => subcategory.includes(term) || term.includes(subcategory));
    if (match) {
      // Return all terms in this group except the subcategory itself
      return group.filter(term => term !== subcategory);
    }
  }
  return [];
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
      else {
        // ── Synonym match ──────────────────────────────────────
        // Claude and retailers use different names for the same garment.
        // "chinos" vs "khaki pants", "hoodie" vs "hooded sweatshirt", etc.
        // Award +20 for a synonym match — slightly less than exact (+25) to
        // preserve ranking order while still surfacing correct results.
        // Without this, synonym-titled products score 0 and get filtered out
        // even though they are correct matches for the identified item.
        const synonyms = getSynonyms(sub);
        if (synonyms.some(syn => title.includes(syn))) score += 20; // synonym match
      }
    }
  }

  // ── Category match ───────────────────────────────────────────
  const cat = (item.category || "").toLowerCase();
  if (cat && title.includes(cat)) score += 8;

  // Brand match — check exact brand, partial brand words, and product line
  const brand = (item.brand || "").toLowerCase();
  if (brand && brand !== "unidentified") {
    if (title.includes(brand) || source.includes(brand)) {
      score += 30; // exact brand match
    } else {
      // Partial brand match for multi-word brands (e.g. "Ralph Lauren" → check "Ralph" and "Lauren")
      const brandWords = brand.split(/\s+/).filter(w => w.length > 3);
      if (brandWords.length > 1 && brandWords.some(w => title.includes(w) || source.includes(w))) {
        score += 15; // partial brand word match
      }
    }
    const line = (item.product_line || "").toLowerCase();
    if (line && line.length > 2 && title.includes(line)) score += 20;
  }

  // Color match — check full color and individual color words
  const color = (item.color || "").toLowerCase();
  if (color && color.length > 2) {
    if (title.includes(color)) {
      score += 12; // exact color match (e.g. "heather grey")
    } else {
      // Multi-word color: "heather grey" → check "heather" and "grey" independently
      const colorWords = color.split(/\s+/).filter(w => w.length > 2);
      const colorMatches = colorWords.filter(w => title.includes(w)).length;
      if (colorMatches >= 2) score += 10;
      else if (colorMatches === 1 && colorWords.length <= 2) score += 6; // single match on a short color
    }
  }

  // Material match — check individual material words for compound materials
  const material = (item.material || "").toLowerCase();
  if (material && material.length > 3) {
    if (title.includes(material)) {
      score += 5;
    } else {
      // "heavyweight cotton french terry" → check "cotton", "french terry", "terry"
      const matWords = material.split(/\s+/).filter(w => w.length > 3);
      const matMatches = matWords.filter(w => title.includes(w)).length;
      if (matMatches >= 2) score += 4;
      else if (matMatches === 1) score += 2;
    }
  }

  // ── Style keywords match ─────────────────────────────────
  // Claude returns style_keywords (e.g. "streetwear", "minimalist", "preppy") but
  // these were previously unused. Now we check if the product title or source
  // contains any of these keywords for a small relevance bonus.
  const styleKws = Array.isArray(item.style_keywords) ? item.style_keywords : [];
  if (styleKws.length > 0) {
    const kwMatches = styleKws.filter(kw => {
      const kwLower = (kw || "").toLowerCase();
      return kwLower.length > 3 && (title.includes(kwLower) || source.includes(kwLower));
    }).length;
    if (kwMatches >= 2) score += 8;
    else if (kwMatches === 1) score += 4;
  }

  // ── Construction details match ───────────────────────────
  // New field from improved Vision prompt — check for specific construction features
  const construction = (item.construction_details || "").toLowerCase();
  if (construction && construction.length > 5) {
    const constructionWords = construction.split(/[,\s]+/).filter(w => w.length > 3);
    const constMatches = constructionWords.filter(w => title.includes(w)).length;
    if (constMatches >= 2) score += 6;
    else if (constMatches === 1) score += 3;
  }

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
  if (isMale && /\bwomen'?s\b/i.test(title)) score -= 40;
  if (!isMale && /\bmen'?s\b/i.test(title) && !/\bwomen'?s\b/i.test(title)) score -= 40;
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

  // Tier context — explain why this product is in this tier
  const tierLabels = { budget: "save pick", mid: "best match", premium: "splurge pick" };
  const tierLabel = tierLabels[tier] || tier;

  if (reasons.length) {
    return `${tierLabel} · ${reasons.join(" · ")}`;
  }
  return `${tierLabel} · ${item.subcategory || item.category}${price ? ` · $${price.toFixed(0)}` : ""}`;
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
// ── Effectiveness audit (v4.3, 2026-03-24) ──────────────────────────────────
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
//   night_out: "cocktail party"   [FIXED in v4.3 from "going out nightlife"]
//     "going out" and "nightlife" are not product-attribute terms in the
//     Google Shopping index. Retailers label evening garments "cocktail",
//     "party", or "evening". "cocktail party" uses two genuine Shopping
//     attribute tokens and surfaces bodycon dresses, blazers, and sequin tops
//     without locking to a venue type.
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
//   wedding: "wedding guest elegant"   [NEW in v4.3]
//     "wedding" alone returns bridal gowns. Adding "guest" steers results
//     toward guest-appropriate attire. "elegant" is a recognised Shopping
//     attribute that filters out overly casual options.
//
//   date: "date night going out"   [NEW in v4.3]
//     "date night" is heavily indexed by fashion retailers and maps to the
//     correct garment style (fitted dresses, nice tops, smart trousers).
//     "going out" is a recognised style tag on ASOS/Revolve/Nordstrom.
//
//   beach: "beach resort vacation"   [NEW in v4.3]
//     "beach" alone matches towels and surfboards. "resort" is a recognised
//     Shopping category for holiday/warm-weather apparel. "vacation" broadens
//     to cover sundresses, swim shorts, and cover-ups correctly.
//
//   smart_casual: "smart casual"   [NEW in v4.3]
//     "smart casual" is a widely indexed style attribute on major retailers.
//     It bridges work and casual without being over-formal. Useful for
//     restaurant dinners, events with no strict dress code.
//
//   festival: "festival boho"   [NEW in v4.3]
//     "festival" is a recognised Shopping occasion tag (ASOS, PrettyLittleThing,
//     Urban Outfitters). "boho" captures the dominant aesthetic without
//     over-constraining to a specific garment type.
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
//
// ── budget_min / budget_max ──────────────────────────────────────────────────
//   Budget values are used in TWO ways:
//     1. textSearch(): a price CEILING of 1.5 × budget_max is passed as the
//        Google Shopping tbs parameter (ppr_max). There is currently NO price
//        floor passed — Google Shopping's ppr_min parameter is not used in
//        textSearch(), only in the fallbackTier() Google Shopping URL helper.
//        FUTURE IMPROVEMENT: pass ppr_min = budget_min × 0.5 to textSearch()
//        to reduce returns that are implausibly cheap for the user's budget.
//     2. Tier partitioning (scoreProduct + findProductsForItems): results are
//        sorted into budget/mid/premium tiers based on whether their price is
//        below, within, or above the min–max range. A +30 score bonus is also
//        applied for products priced within the range. So budget DOES affect
//        which products surface at the top of each tier.
//   The budget does NOT act as a hard filter — products outside the range are
//   still returned (in a different tier) rather than excluded. This is
//   intentional: we want to show alternatives across price points.
//
// ── body_type / fit_style ────────────────────────────────────────────────────
//   body_type and fit_style affect search in two places:
//     - Query A: bodyTerm (e.g. "petite") is prepended to Claude's search_query
//       when the query does not already contain it.
//     - Query D: bodyTerm prefix + fitTerm suffix + sizeTerm suffix are applied
//       as a full-descriptor broadening query. This query is only added if it
//       is distinct from Query C.
//   They are NOT injected into Query B (brand query) or Query C (simple
//   descriptor) intentionally — adding body type to brand or simple queries
//   tends to narrow results too aggressively for brand-specific searches.
//
// ── size_prefs.sizes (clothing sizes) ───────────────────────────────────────
//   getSizeTermForItem() maps garment category → size value from sizePrefs.sizes.
//   The size is appended to Query D only (e.g. "size M"). It is excluded from
//   Queries A/B/C because:
//     - Google Shopping does not always index exact sizes in listing titles.
//     - Adding a size to Query A or C would silently eliminate all results whose
//       size is in a separate facet (not title text), causing empty tiers.
//   FUTURE IMPROVEMENT: Use the Google Shopping "size" filter facet parameter
//   (currently undocumented in SerpAPI) rather than appending to query text.
const OCCASION_MODIFIERS = {
  casual:       "casual",
  work:         "business professional",
  night_out:    "cocktail party",           // v4.3: was "going out nightlife" — not indexed Shopping terms
  athletic:     "activewear",
  formal:       "formal",
  outdoor:      "outdoor",
  wedding:      "wedding guest elegant",    // v4.3 new: steers away from bridal toward guest attire
  date:         "date night going out",     // v4.3 new: heavily indexed on major retailers
  beach:        "beach resort vacation",    // v4.3 new: "beach" alone matches towels/surfboards
  smart_casual: "smart casual",             // v4.3 new: bridges work/casual, widely indexed
  festival:     "festival boho",            // v4.3 new: recognised occasion tag on ASOS/UO/PLT
};

/**
 * Main product search orchestration.
 *
 * @param {string} searchMode - "fast" (default, quick parallel search) or "extended" (deeper search + AI re-ranking)
 *   Fast: Lens on full image + 3 text queries per item. ~5-10s.
 *   Extended: Lens on full image + per-item Lens + 3 text queries + AI re-ranking. ~15-25s.
 */
export async function findProductsForItems(items, gender, budgetMin, budgetMax, imageUrl, sizePrefs = {}, occasion = null, searchNotes = null, customOccasionModifiers = null, searchMode = "fast") {
  console.log(`[Search] Mode: ${searchMode} | Items: ${items.length} | Image: ${!!imageUrl} | Occasion: ${occasion || "none"}`);
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
  // Each item gets a pool of matched products.
  // textQueryCount is stored for telemetry (search_quality log).
  const itemPools = items.map(() => ({ lens: [], text: [], textQueryCount: 0 }));

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
    const pricedLens = itemPools[i].lens.filter(r => {
      const p = extractPrice(r.price) || extractPrice(r.extracted_price);
      return p !== null;
    });

    // Standard text search if < 3 priced Lens results
    if (pricedLens.length < 3) {
      const textResults = await textSearchForItem(item, gender, getItemTierBounds(item), getItemSizePrefs(item), occasion, searchNotes, customOccasionModifiers);
      itemPools[i].text = textResults;
      itemPools[i].textQueryCount = Math.min(3, 1 + (item.brand && item.brand !== "Unidentified" ? 1 : 0) + 1);
      console.log(`[Match] "${item.name}" ← ${textResults.length} text results (supplementing ${itemPools[i].lens.length} Lens, ${pricedLens.length} with price)`);
    }

    // Extended mode: run additional query variants (alt_search, material-based, construction-based, retailer-specific)
    if (searchMode === "extended") {
      const extResults = await extendedTextSearch(item, gender, getItemTierBounds(item));
      if (extResults.length > 0) {
        // Merge into text pool, dedup by URL
        const existingUrls = new Set(itemPools[i].text.map(r => r.link || r.product_link || ""));
        const newResults = extResults.filter(r => {
          const url = r.link || r.product_link || "";
          return url && !existingUrls.has(url);
        });
        itemPools[i].text.push(...newResults);
        itemPools[i].textQueryCount += 3;
        console.log(`[ExtendedText] "${item.name}" ← ${newResults.length} new results (${extResults.length} total, ${extResults.length - newResults.length} dupes)`);
      }
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

    // Determine whether Lens produced any results for this item.
    // When Lens returns 0 matches, text results lose their only competition —
    // but they also start from 0 base score while Lens results would have gotten
    // a +25 bonus. To compensate, we boost text results by +15 when there are
    // no Lens matches for this item. This is applied AFTER scoreProduct so it
    // doesn't interfere with the existing scoring arithmetic.
    // Note: isFromLens is false for all products in pool.text, so this bonus
    // only applies to text results (correct — Lens results already get +25).
    const hasLensMatchesForItem = pool.lens.length > 0;

    // Score everything
    const allScored = marketFiltered
      .map(({ product, isLens }) => {
        let score = scoreProduct(product, item, isLens, itemSizePrefs, itemTierBounds);
        // No-lens text bonus: when Lens produced nothing for this item, text
        // results from trusted retailers get +10 to compensate for the missing
        // Lens base bonus (+25). We use a smaller number (+10 not +15) to avoid
        // accidentally promoting low-quality text results over each other.
        // This only applies to text results (isLens === false) and only when
        // the item has zero Lens matches.
        if (!isLens && !hasLensMatchesForItem && score > 0) {
          const link = product.link || product.product_link || product.url || "";
          const isTrusted = TRUSTED_RETAILER_DOMAINS.has(
            link.replace(/^https?:\/\/(?:www\.)?/, "").split("/")[0]
          );
          if (isTrusted) score += 10;
          else score += 5; // smaller bonus for unknown domains
        }
        return {
          product,
          isLens,
          score,
          price: extractPrice(product.price) || extractPrice(product.extracted_price),
        };
      })
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

    // Top resale products (up to 6, already scored and deduped)
    const resaleFormatted = resaleScored.slice(0, 6).map(s => {
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
      tiers.mid.push(...pickTopN(midCompanions.slice(0, 15), 5, "mid"));

      // Budget = best-scored retail cheaper than original
      const origPrice = original.price || itemTierBounds.min;
      const cheaper = pricedRetail
        .filter(s => !usedUrls.has(getUrl(s)) && s.price < origPrice && s.price >= origPrice * 0.15)
        .sort((a, b) => b.score - a.score);
      tiers.budget.push(...pickTopN(cheaper, 6, "budget"));

      // Premium = most expensive above original
      const pricier = pricedRetail
        .filter(s => !usedUrls.has(getUrl(s)) && s.price > origPrice)
        .sort((a, b) => b.price - a.price);
      tiers.premium.push(...pickTopN(pricier, 6, "premium"));

      // Fill any still-empty tiers with unpriced Lens results
      if (!tiers.budget.length) tiers.budget.push(...pickTopN(unpricedRetail, 6, "budget"));
      if (!tiers.premium.length) tiers.premium.push(...pickTopN(unpricedRetail, 6, "premium"));

    } else {
      // ── NO ORIGINAL: partition by price, return up to 6 per tier ──
      const budgetPool = pricedRetail.filter(s => s.price < itemTierBounds.min).sort((a, b) => b.score - a.score);
      const midPool = pricedRetail.filter(s => s.price >= itemTierBounds.min && s.price <= itemTierBounds.max).sort((a, b) => b.score - a.score);
      const premiumPool = pricedRetail.filter(s => s.price > itemTierBounds.max).sort((a, b) => b.score - a.score);

      tiers.budget.push(...pickTopN(budgetPool, 6, "budget"));
      tiers.mid.push(...pickTopN(midPool, 6, "mid"));
      tiers.premium.push(...pickTopN(premiumPool, 6, "premium"));

      // Widen budget tier only
      if (!tiers.budget.length) tiers.budget.push(...pickTopN(pricedRetail, 6, "budget"));
      if (!tiers.budget.length) tiers.budget.push(...pickTopN(unpricedRetail, 6, "budget"));

      // For mid and premium: fall back to unpriced Lens results only
      if (!tiers.mid.length) tiers.mid.push(...pickTopN(unpricedRetail, 6, "mid"));
      if (!tiers.premium.length) tiers.premium.push(...pickTopN(unpricedRetail, 6, "premium"));
    }

    const brandVerified = item.brand && item.brand !== "Unidentified" &&
      [...tiers.budget, ...tiers.mid, ...tiers.premium].some(t => t?.is_identified_brand);

    // When ALL tiers are empty, show a single unified fallback instead of three
    // separate Google Shopping links with different price filters
    const allEmpty = !tiers.budget.length && !tiers.mid.length && !tiers.premium.length;
    const singleFallback = allEmpty ? [fallbackTier(item, "mid", itemTierBounds)] : null;

    return {
      item_index: rawItem._scan_item_index ?? i,
      brand_verified: brandVerified,
      tiers: {
        budget: tiers.budget.length ? tiers.budget : (singleFallback ? [] : [fallbackTier(item, "budget", itemTierBounds)]),
        mid: tiers.mid.length ? tiers.mid : (singleFallback || [fallbackTier(item, "mid", itemTierBounds)]),
        premium: tiers.premium.length ? tiers.premium : (singleFallback ? [] : [fallbackTier(item, "premium", itemTierBounds)]),
        resale: resaleFormatted,
      },
      _item: item, // carry forward for re-ranking
    };
  });

  // ── Step 5 (extended mode only): AI Re-ranking ───────────
  // Send top candidates to Claude for style/vibe evaluation.
  // This re-sorts within tiers based on style match, not just keyword score.
  if (searchMode === "extended") {
    console.log("[Rerank] Running AI re-ranking on all items...");
    const rerankPromises = output.map(async (result) => {
      const item = result._item;
      if (!item) return;

      // Collect all real products across tiers (skip fallback links)
      const allProducts = [
        ...result.tiers.budget,
        ...result.tiers.mid,
        ...result.tiers.premium,
      ].filter(p => p.is_product_page !== false);

      if (allProducts.length === 0) return;

      // Send up to 15 candidates to Claude for re-ranking (cost control)
      const toRerank = allProducts.slice(0, 15);
      const reranked = await rerankCandidates(item, toRerank, occasion);

      // Build a map of URL → ai_score for re-sorting within tiers
      const aiScoreMap = new Map();
      for (const r of reranked) {
        if (r.url) aiScoreMap.set(r.url, { score: r.ai_score || 50, reason: r.ai_reason || "" });
      }

      // Re-sort each tier by AI score (descending), keeping fallback links at end
      for (const tierName of ["budget", "mid", "premium"]) {
        const tier = result.tiers[tierName];
        if (!tier || tier.length <= 1) continue;
        tier.sort((a, b) => {
          const aScore = aiScoreMap.get(a.url)?.score ?? 50;
          const bScore = aiScoreMap.get(b.url)?.score ?? 50;
          return bScore - aScore;
        });
        // Annotate top result with AI reason if available
        if (tier[0]?.url && aiScoreMap.has(tier[0].url)) {
          const ai = aiScoreMap.get(tier[0].url);
          if (ai.reason) {
            const combined = `${tier[0].why} · ${ai.reason}`;
            tier[0].why = combined.length > 120 ? combined.slice(0, 117) + "…" : combined;
          }
        }
      }
    });
    await Promise.all(rerankPromises);
    console.log("[Rerank] AI re-ranking complete.");
  }

  // Clean up internal fields before returning
  for (const result of output) {
    delete result._item;
  }

  // ── Search quality telemetry ─────────────────────────────────
  // Structured log emitted after every search request. Surfaces 0-result bugs,
  // Lens failure patterns, and fallback usage in production logs.
  // Parse with: jq 'select(.event == "search_quality")' from your log aggregator.
  const lensVendorResults = lensResults.filter(r => isVendorPage(r)).length;
  const telemetry = {
    event: "search_quality",
    searchMode,
    imageUrl: !!imageUrl,
    lensAttempted: !!imageUrl,
    lensResultsTotal: lensResults.length,
    lensVendorResults,
    items: items.map((item, i) => {
      const tierResult = output[i];
      const budgetTier = tierResult?.tiers?.budget ?? [];
      const midTier = tierResult?.tiers?.mid ?? [];
      const premiumTier = tierResult?.tiers?.premium ?? [];
      return {
        name: item.name,
        lensMatches: itemPools[i].lens.length,
        textQueries: itemPools[i].textQueryCount,
        textResults: itemPools[i].text.length,
        finalTiers: {
          budget: budgetTier.length,
          mid: midTier.length,
          premium: premiumTier.length,
          // hasFallback = true when ALL results in a tier are Google Shopping
          // fallback links (is_product_page === false) — indicates 0 real products found.
          hasFallback:
            (budgetTier.length > 0 && budgetTier.every(t => t?.is_product_page === false)) ||
            (midTier.length > 0 && midTier.every(t => t?.is_product_page === false)) ||
            (premiumTier.length > 0 && premiumTier.every(t => t?.is_product_page === false)),
        },
      };
    }),
  };
  console.log(JSON.stringify(telemetry));

  // Warn when ALL tiers for ANY item are pure fallback Shopping links.
  // This means 0 real products were found — the search completely failed for that item.
  const allFallbackItems = telemetry.items.filter(t => t.finalTiers.hasFallback);
  if (allFallbackItems.length > 0) {
    console.warn(
      `[search_quality] WARN: ${allFallbackItems.length}/${items.length} items have only fallback results: ` +
      allFallbackItems.map(t => `"${t.name}"`).join(", ")
    );
  }

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
  // v5 additions — exposed for unit testing the new query builder functions
  buildShoppingQueries,
  stripShoppingNoise,
  getSynonyms,
};