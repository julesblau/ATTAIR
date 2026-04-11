#!/usr/bin/env node
/**
 * Crawl real product data from Gen Z brands via Google Shopping API.
 * Creates feed scans with REAL product images, names, and prices.
 *
 * Usage: node scripts/crawl-brands-feed.js
 */

import { createClient } from "@supabase/supabase-js";
import { config } from "dotenv";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import crypto from "crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: join(__dirname, "..", ".env") });

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const SERPAPI_KEY = process.env.SERPAPI_KEY;
const SERPAPI_URL = "https://serpapi.com/search.json";

// ─── Brands × Categories to crawl ─────────────────────────────
const BRAND_QUERIES = [
  // Athleisure
  { brand: "Adanola", queries: ["women's Adanola leggings", "women's Adanola sports bra", "women's Adanola hoodie", "women's Adanola shorts"] },
  { brand: "Skims", queries: ["women's Skims bodysuit", "women's Skims lounge set", "women's Skims dress", "women's Skims hoodie"] },
  { brand: "Lululemon", queries: ["women's Lululemon Align leggings", "men's Lululemon ABC pants", "women's Lululemon Define jacket", "men's Lululemon polo shirt"] },
  { brand: "Vuori", queries: ["men's Vuori joggers", "women's Vuori shorts", "men's Vuori hoodie", "women's Vuori leggings"] },
  { brand: "Alo Yoga", queries: ["women's Alo Yoga leggings", "women's Alo Yoga sports bra", "women's Alo Yoga hoodie", "men's Alo Yoga shorts"] },
  { brand: "Gymshark", queries: ["women's Gymshark leggings", "men's Gymshark tank top", "women's Gymshark sports bra", "men's Gymshark shorts"] },

  // Fast fashion / Trendy
  { brand: "Zara", queries: ["women's Zara blazer", "men's Zara shirt", "women's Zara dress", "men's Zara jeans", "women's Zara heels"] },
  { brand: "Aritzia", queries: ["women's Aritzia blazer", "women's Aritzia trousers", "women's Aritzia tank top", "women's Aritzia dress"] },
  { brand: "Princess Polly", queries: ["women's Princess Polly dress", "women's Princess Polly top", "women's Princess Polly skirt", "women's Princess Polly bodysuit"] },
  { brand: "White Fox", queries: ["women's White Fox hoodie", "women's White Fox sweatpants", "women's White Fox shorts", "women's White Fox dress"] },
  { brand: "Oh Polly", queries: ["women's Oh Polly dress", "women's Oh Polly bodycon", "women's Oh Polly top", "women's Oh Polly set"] },
  { brand: "Free People", queries: ["women's Free People dress", "women's Free People jeans", "women's Free People top", "women's Free People jacket"] },
  { brand: "Revolve", queries: ["women's Revolve dress", "women's Revolve top", "women's Revolve jeans", "women's Revolve heels"] },

  // Premium casual
  { brand: "COS", queries: ["women's COS dress", "men's COS sweater", "women's COS trousers", "men's COS t-shirt", "COS cashmere"] },
  { brand: "Banana Republic", queries: ["men's Banana Republic chinos", "women's Banana Republic blazer", "men's Banana Republic shirt", "women's Banana Republic dress"] },
  { brand: "Massimo Dutti", queries: ["men's Massimo Dutti blazer", "women's Massimo Dutti coat", "men's Massimo Dutti shoes", "women's Massimo Dutti dress"] },
  { brand: "Abercrombie", queries: ["women's Abercrombie jeans", "men's Abercrombie shirt", "women's Abercrombie dress", "men's Abercrombie shorts"] },
  { brand: "Marine Layer", queries: ["men's Marine Layer t-shirt", "women's Marine Layer dress", "men's Marine Layer shorts", "women's Marine Layer sweater"] },
  { brand: "Faherty", queries: ["men's Faherty shirt", "women's Faherty dress", "men's Faherty shorts", "men's Faherty sweater"] },

  // Elevated
  { brand: "Reformation", queries: ["women's Reformation dress", "women's Reformation jeans", "women's Reformation top", "women's Reformation skirt"] },
  { brand: "AllSaints", queries: ["men's AllSaints leather jacket", "women's AllSaints dress", "men's AllSaints t-shirt", "women's AllSaints boots"] },
  { brand: "Reiss", queries: ["men's Reiss blazer", "women's Reiss dress", "men's Reiss trousers", "women's Reiss coat"] },
  { brand: "Sandro", queries: ["women's Sandro dress", "men's Sandro jacket", "women's Sandro skirt", "women's Sandro blouse"] },
  { brand: "Maje", queries: ["women's Maje dress", "women's Maje jacket", "women's Maje skirt", "women's Maje coat"] },

  // Shoes
  { brand: "Nike", queries: ["men's Nike Air Jordan sneakers", "women's Nike Dunk Low", "men's Nike Air Max", "women's Nike Air Force 1"] },
  { brand: "Adidas", queries: ["men's Adidas Samba sneakers", "women's Adidas Gazelle", "men's Adidas Ultraboost", "women's Adidas campus shoes"] },
  { brand: "New Balance", queries: ["men's New Balance 550 sneakers", "women's New Balance 530", "men's New Balance 990", "women's New Balance 2002R"] },
  { brand: "Salomon", queries: ["men's Salomon XT-6 sneakers", "women's Salomon Speedcross", "men's Salomon trail shoes", "Salomon XA Pro"] },

  // Nordstrom (multi-brand retailer)
  { brand: "Nordstrom", queries: ["Nordstrom women's dress", "Nordstrom men's blazer", "Nordstrom women's shoes", "Nordstrom men's sneakers"] },

  // ═══ DESIGNER — Luxury ═══
  { brand: "Gucci", queries: ["Gucci women's bag", "Gucci men's sneakers", "Gucci women's dress", "Gucci men's loafers", "Gucci belt", "Gucci women's sunglasses"] },
  { brand: "Louis Vuitton", queries: ["Louis Vuitton bag", "Louis Vuitton sneakers", "Louis Vuitton wallet", "Louis Vuitton belt"] },
  { brand: "Prada", queries: ["Prada women's bag", "Prada men's shoes", "Prada sunglasses", "Prada women's dress", "Prada men's jacket"] },
  { brand: "Dior", queries: ["Dior bag", "Dior sneakers", "Dior women's dress", "Dior sunglasses", "Dior men's jacket"] },
  { brand: "Balenciaga", queries: ["Balenciaga sneakers", "Balenciaga hoodie", "Balenciaga bag", "Balenciaga t-shirt", "Balenciaga track shoes"] },
  { brand: "Bottega Veneta", queries: ["Bottega Veneta bag", "Bottega Veneta shoes", "Bottega Veneta wallet", "Bottega Veneta boots"] },
  { brand: "Saint Laurent", queries: ["Saint Laurent bag", "Saint Laurent boots", "Saint Laurent leather jacket", "Saint Laurent dress"] },
  { brand: "Burberry", queries: ["Burberry trench coat", "Burberry scarf", "Burberry bag", "Burberry sneakers", "Burberry shirt"] },
  { brand: "Valentino", queries: ["Valentino Rockstud heels", "Valentino bag", "Valentino sneakers", "Valentino dress"] },
  { brand: "Versace", queries: ["Versace men's shirt", "Versace women's dress", "Versace sneakers", "Versace sunglasses"] },
  { brand: "Givenchy", queries: ["Givenchy sneakers", "Givenchy bag", "Givenchy t-shirt", "Givenchy hoodie"] },
  { brand: "Celine", queries: ["Celine bag", "Celine sunglasses", "Celine boots", "Celine wallet"] },
  { brand: "Loewe", queries: ["Loewe bag", "Loewe sneakers", "Loewe wallet", "Loewe sweater"] },
  { brand: "Fendi", queries: ["Fendi bag", "Fendi sneakers", "Fendi belt", "Fendi dress"] },
  { brand: "Alexander McQueen", queries: ["Alexander McQueen sneakers", "Alexander McQueen dress", "Alexander McQueen bag", "Alexander McQueen scarf"] },

  // ═══ DESIGNER — Contemporary ═══
  { brand: "Acne Studios", queries: ["Acne Studios scarf", "Acne Studios jeans", "Acne Studios hoodie", "Acne Studios boots", "Acne Studios sweater"] },
  { brand: "AMI Paris", queries: ["AMI Paris sweater", "AMI Paris t-shirt", "AMI Paris hoodie", "AMI Paris jacket"] },
  { brand: "Isabel Marant", queries: ["Isabel Marant boots", "Isabel Marant dress", "Isabel Marant sneakers", "Isabel Marant jacket"] },
  { brand: "Jacquemus", queries: ["Jacquemus bag", "Jacquemus dress", "Jacquemus shirt", "Jacquemus heels"] },
  { brand: "The Row", queries: ["The Row bag", "The Row shoes", "The Row coat", "The Row sweater"] },
  { brand: "Toteme", queries: ["Toteme coat", "Toteme jeans", "Toteme scarf", "Toteme blazer"] },
  { brand: "Ganni", queries: ["Ganni dress", "Ganni boots", "Ganni top", "Ganni jeans"] },
  { brand: "Staud", queries: ["Staud bag", "Staud dress", "Staud top", "Staud shoes"] },

  // ═══ PREMIUM DENIM ═══
  { brand: "AGOLDE", queries: ["AGOLDE jeans women's", "AGOLDE shorts", "AGOLDE denim jacket", "AGOLDE straight leg jeans"] },
  { brand: "Citizens of Humanity", queries: ["Citizens of Humanity jeans", "Citizens of Humanity wide leg", "Citizens of Humanity shorts"] },
  { brand: "PAIGE", queries: ["PAIGE jeans men's", "PAIGE jeans women's", "PAIGE denim jacket", "PAIGE shorts"] },
  { brand: "Mother Denim", queries: ["Mother Denim jeans women's", "Mother Denim shorts", "Mother Denim flare jeans"] },
  { brand: "Frame", queries: ["Frame jeans women's", "Frame jeans men's", "Frame denim shirt", "Frame Le High straight"] },

  // ═══ MORE SHOES ═══
  { brand: "Dr. Martens", queries: ["Dr Martens boots", "Dr Martens 1460 boots", "Dr Martens platform", "Dr Martens sandals"] },
  { brand: "Birkenstock", queries: ["Birkenstock Boston clogs", "Birkenstock Arizona sandals", "Birkenstock women's", "Birkenstock men's"] },
  { brand: "UGG", queries: ["UGG boots women's", "UGG slippers", "UGG Ultra Mini", "UGG Tasman"] },
  { brand: "Converse", queries: ["Converse Chuck 70", "Converse Run Star Hike", "Converse platform", "Converse high top"] },
  { brand: "Vans", queries: ["Vans Old Skool", "Vans Sk8-Hi", "Vans slip on", "Vans Knu Skool"] },
  { brand: "On Running", queries: ["On Cloud running shoes", "On Cloudmonster", "On Cloudnova", "On Roger shoes"] },
  { brand: "HOKA", queries: ["HOKA Bondi running shoes", "HOKA Clifton", "HOKA Speedgoat trail", "HOKA women's"] },
  { brand: "Stuart Weitzman", queries: ["Stuart Weitzman boots", "Stuart Weitzman heels", "Stuart Weitzman sandals", "Stuart Weitzman flats"] },
  { brand: "Jimmy Choo", queries: ["Jimmy Choo heels", "Jimmy Choo boots", "Jimmy Choo sneakers", "Jimmy Choo bag"] },
  { brand: "Golden Goose", queries: ["Golden Goose sneakers", "Golden Goose Super-Star", "Golden Goose women's", "Golden Goose men's"] },

  // ═══ MORE FASHION ═══
  { brand: "Theory", queries: ["Theory blazer women's", "Theory pants men's", "Theory dress", "Theory coat"] },
  { brand: "Vince", queries: ["Vince sweater", "Vince t-shirt men's", "Vince coat women's", "Vince pants"] },
  { brand: "Rag & Bone", queries: ["Rag Bone jeans", "Rag Bone boots", "Rag Bone jacket", "Rag Bone t-shirt"] },
  { brand: "Club Monaco", queries: ["Club Monaco dress", "Club Monaco blazer", "Club Monaco shirt men's", "Club Monaco sweater"] },
  { brand: "J.Crew", queries: ["J Crew blazer", "J Crew chinos men's", "J Crew dress women's", "J Crew sweater"] },
  { brand: "Madewell", queries: ["Madewell jeans", "Madewell tote bag", "Madewell dress", "Madewell sandals"] },
  { brand: "Anthropologie", queries: ["Anthropologie dress", "Anthropologie blouse", "Anthropologie furniture", "Anthropologie jewelry"] },
  { brand: "Urban Outfitters", queries: ["Urban Outfitters dress", "Urban Outfitters jeans", "Urban Outfitters top", "Urban Outfitters shoes"] },
  { brand: "H&M", queries: ["H&M women's dress", "H&M men's shirt", "H&M blazer", "H&M jeans"] },
  { brand: "Uniqlo", queries: ["Uniqlo men's t-shirt", "Uniqlo women's dress", "Uniqlo jeans", "Uniqlo jacket"] },
  { brand: "Everlane", queries: ["Everlane jeans", "Everlane t-shirt", "Everlane shoes", "Everlane bag"] },
  { brand: "Pangaia", queries: ["Pangaia hoodie", "Pangaia tracksuit", "Pangaia t-shirt", "Pangaia shorts"] },

  // ═══ BAGS & ACCESSORIES ═══
  { brand: "Coach", queries: ["Coach bag", "Coach wallet", "Coach crossbody", "Coach tote bag"] },
  { brand: "Kate Spade", queries: ["Kate Spade bag", "Kate Spade wallet", "Kate Spade crossbody", "Kate Spade tote"] },
  { brand: "Michael Kors", queries: ["Michael Kors bag", "Michael Kors watch", "Michael Kors wallet", "Michael Kors crossbody"] },
  { brand: "Tory Burch", queries: ["Tory Burch bag", "Tory Burch sandals", "Tory Burch wallet", "Tory Burch flats"] },
  { brand: "Ray-Ban", queries: ["Ray-Ban Wayfarer", "Ray-Ban Aviator", "Ray-Ban sunglasses", "Ray-Ban Clubmaster"] },
];

// ─── Name pools ────────────────────────────────────────────────
const NAMES_F = ["Aaliyah","Bella","Carmen","Deja","Elena","Fatima","Grace","Hana","Iris","Jade","Kaia","Luna","Maya","Nia","Olivia","Priya","Quinn","Rosa","Suki","Talia","Uma","Violet","Winnie","Yara","Zara","Amara","Bianca","Chloe","Diana","Emiko","Freya","Gigi","Harper","Ines","Jada","Keiko","Leila","Mika","Noor","Paloma","Raven","Sasha","Tiana","Valentina","Willow","Yuki","Aria","Sage","Sloane","Margot"];
const NAMES_M = ["Aiden","Blake","Carlos","Dante","Ethan","Felix","Grant","Hugo","Isaac","Jaden","Kai","Liam","Marcus","Nico","Orion","Phoenix","Quincy","Rafael","Soren","Tyler","Uriel","Victor","Wyatt","Xavier","Zayn","Archer","Brooks","Caleb","Diego","Emerson","Finn","Grayson","Hudson","Ivan","Jasper"];
const LAST = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");

const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const uuid = () => crypto.randomUUID();

// Brand → domain mapping for constructing direct vendor links
const BRAND_DOMAINS = {
  adanola: "adanola.com", skims: "skims.com", lululemon: "lululemon.com", vuori: "vuori.com",
  "alo yoga": "aloyoga.com", gymshark: "gymshark.com", zara: "zara.com", aritzia: "aritzia.com",
  "princess polly": "princesspolly.com", "white fox": "whitefoxboutique.com", "oh polly": "ohpolly.com",
  "free people": "freepeople.com", revolve: "revolve.com", cos: "cos.com",
  "banana republic": "bananarepublic.com", "massimo dutti": "massimodutti.com",
  abercrombie: "abercrombie.com", "marine layer": "marinelayer.com", faherty: "faherty.com",
  reformation: "thereformation.com", allsaints: "allsaints.com", reiss: "reiss.com",
  sandro: "sandro-paris.com", maje: "maje.com", nike: "nike.com", adidas: "adidas.com",
  "new balance": "newbalance.com", salomon: "salomon.com", nordstrom: "nordstrom.com",
  gucci: "gucci.com", "louis vuitton": "louisvuitton.com", prada: "prada.com", dior: "dior.com",
  balenciaga: "balenciaga.com", "bottega veneta": "bottegaveneta.com",
  "saint laurent": "ysl.com", burberry: "burberry.com", valentino: "valentino.com",
  versace: "versace.com", givenchy: "givenchy.com", celine: "celine.com", loewe: "loewe.com",
  fendi: "fendi.com", "alexander mcqueen": "alexandermcqueen.com",
  "acne studios": "acnestudios.com", "ami paris": "amiparis.com", "isabel marant": "isabelmarant.com",
  jacquemus: "jacquemus.com", "the row": "therow.com", toteme: "toteme.com", ganni: "ganni.com",
  staud: "staud.clothing", agolde: "agolde.com", "citizens of humanity": "citizensofhumanity.com",
  paige: "paige.com", "mother denim": "motherdenim.com", frame: "frame-store.com",
  "dr. martens": "drmartens.com", birkenstock: "birkenstock.com", ugg: "ugg.com",
  converse: "converse.com", vans: "vans.com", "on running": "on-running.com", hoka: "hoka.com",
  "stuart weitzman": "stuartweitzman.com", "jimmy choo": "jimmychoo.com",
  "golden goose": "goldengoose.com", theory: "theory.com", vince: "vince.com",
  "rag & bone": "rag-bone.com", "club monaco": "clubmonaco.com", "j.crew": "jcrew.com",
  madewell: "madewell.com", anthropologie: "anthropologie.com", "urban outfitters": "urbanoutfitters.com",
  "h&m": "hm.com", uniqlo: "uniqlo.com", everlane: "everlane.com", pangaia: "pangaia.com",
  coach: "coach.com", "kate spade": "katespade.com", "michael kors": "michaelkors.com",
  "tory burch": "toryburch.com", "ray-ban": "ray-ban.com",
};

// Category detection from query/title
function detectCategory(text) {
  const t = text.toLowerCase();
  if (/dress|gown|romper|jumpsuit/.test(t)) return { category: "dress", subcategory: t.match(/midi|maxi|mini|bodycon|wrap|shirt/)?.[0] + " dress" || "dress" };
  if (/blazer|jacket|coat|parka|bomber/.test(t)) return { category: "outerwear", subcategory: t.match(/blazer|jacket|coat|parka|bomber/)?.[0] || "jacket" };
  if (/hoodie|sweatshirt|pullover/.test(t)) return { category: "top", subcategory: t.match(/hoodie|sweatshirt|pullover/)?.[0] || "hoodie" };
  if (/top|blouse|shirt|tee|t-shirt|tank|crop|polo|bodysuit/.test(t)) return { category: "top", subcategory: t.match(/blouse|shirt|tee|t-shirt|tank|crop top|polo|bodysuit|sports bra/)?.[0] || "top" };
  if (/sweater|cardigan|knit/.test(t)) return { category: "top", subcategory: t.match(/sweater|cardigan/)?.[0] || "sweater" };
  if (/jean|denim|pants|trousers|chinos|joggers|leggings|shorts|skirt/.test(t)) return { category: "bottom", subcategory: t.match(/jeans|pants|trousers|chinos|joggers|leggings|shorts|skirt/)?.[0] || "pants" };
  if (/sneaker|shoe|boot|heel|sandal|loafer|flat|slide|mule/.test(t)) return { category: "shoes", subcategory: t.match(/sneakers?|boots?|heels?|sandals?|loafers?|flats?|slides?|mules?/)?.[0] || "shoes" };
  if (/bag|purse|tote|clutch/.test(t)) return { category: "bag", subcategory: t.match(/bag|purse|tote|clutch/)?.[0] || "bag" };
  return { category: "top", subcategory: "top" };
}

// Detect gender from query
function detectGender(query) {
  if (/women|woman|her|she/.test(query.toLowerCase())) return "female";
  if (/men|man|his|he/.test(query.toLowerCase())) return "male";
  return Math.random() > 0.5 ? "female" : "male";
}

// ─── SerpAPI search ────────────────────────────────────────────
async function searchProducts(query) {
  const params = new URLSearchParams({
    engine: "google_shopping",
    q: query,
    api_key: SERPAPI_KEY,
    hl: "en",
    gl: "us",
    num: "20",
  });

  try {
    const res = await fetch(`${SERPAPI_URL}?${params}`);
    if (!res.ok) return [];
    const data = await res.json();
    return (data.shopping_results || []).filter(r => r.thumbnail && r.title);
  } catch {
    return [];
  }
}

// Wait helper
const wait = (ms) => new Promise(r => setTimeout(r, ms));

// Resolve direct vendor URL from immersive product API
async function resolveVendorUrl(token) {
  if (!token) return null;
  try {
    const params = new URLSearchParams({
      engine: "google_immersive_product",
      page_token: token,
      api_key: SERPAPI_KEY,
    });
    const res = await fetch(`${SERPAPI_URL}?${params}`);
    if (!res.ok) return null;
    const data = await res.json();
    const stores = data.product_results?.stores || [];
    const direct = stores.find(s => s.link && !s.link.includes("google.com"));
    return direct?.link || null;
  } catch { return null; }
}

// ─── Main ──────────────────────────────────────────────────────
async function run() {
  console.log(`\nCrawling ${BRAND_QUERIES.length} brands × ~4 queries each...\n`);

  // Get or create AI accounts
  const { data: accounts } = await supabase.from("profiles").select("id, display_name, gender_pref").eq("is_ai", true).limit(200);
  const allAccounts = accounts || [];
  console.log(`${allAccounts.length} AI accounts available\n`);

  let totalScans = 0;
  let totalProducts = 0;
  let totalApiCalls = 0;

  // Clear old seeded scans (replace with vendor-link versions)
  console.log("Clearing old seeded scans...");
  const aiIds = allAccounts.map(a => a.id);
  if (aiIds.length > 0) {
    for (let i = 0; i < aiIds.length; i += 20) {
      const batch = aiIds.slice(i, i + 20);
      await supabase.from("scans").delete().in("user_id", batch);
    }
    console.log("Cleared old scans.\n");
  }

  for (const brandConfig of BRAND_QUERIES) {
    const { brand, queries } = brandConfig;
    console.log(`\n═══ ${brand} ═══`);

    for (const query of queries) {
      totalApiCalls++;
      const products = await searchProducts(query);
      console.log(`  "${query}" → ${products.length} products`);

      if (products.length === 0) continue;

      const gender = detectGender(query);
      const matchingAccounts = allAccounts.filter(a =>
        (gender === "female" && a.gender_pref === "female") ||
        (gender === "male" && a.gender_pref === "male")
      );

      // Create 1 scan per product — resolve vendor URLs in parallel batches
      const productsToProcess = products.slice(0, 10); // 10 per query to manage API calls

      // Resolve vendor URLs in parallel (batch of 5 at a time)
      const vendorUrls = [];
      for (let b = 0; b < productsToProcess.length; b += 5) {
        const batch = productsToProcess.slice(b, b + 5);
        const urls = await Promise.all(batch.map(p => resolveVendorUrl(p.immersive_product_page_token)));
        vendorUrls.push(...urls);
        totalApiCalls += batch.length;
      }

      const scans = [];
      for (let pi = 0; pi < productsToProcess.length; pi++) {
        const product = productsToProcess[pi];
        // Use resolved vendor URL, or construct from source domain, or use product_link as last resort
        let vendorUrl = vendorUrls[pi];
        if (!vendorUrl && product.source) {
          // Construct a search URL on the retailer's own site
          const sourceDomain = BRAND_DOMAINS[product.source.toLowerCase()] || BRAND_DOMAINS[brand.toLowerCase()];
          if (sourceDomain) vendorUrl = `https://${sourceDomain}`;
        }
        if (!vendorUrl) vendorUrl = product.product_link; // Google redirect fallback
        if (!vendorUrl) continue;

        const account = pick(matchingAccounts.length > 0 ? matchingAccounts : allAccounts);
        const price = product.extracted_price || product.price;
        const priceNum = typeof price === "number" ? price : parseFloat(String(price).replace(/[^0-9.]/g, "")) || null;
        const { category, subcategory } = detectCategory(product.title);

        const item = {
          name: product.title.slice(0, 80),
          brand: brand,
          brand_confidence: "high",
          category,
          subcategory,
          color: "",
          material: "",
          fit: "regular",
          search_query: query,
          style_keywords: [],
          price_range: priceNum ? `$${Math.round(priceNum * 0.8)} - $${Math.round(priceNum * 1.2)}` : "",
          position_y: 0.4,
          visibility_pct: 90,
          identification_confidence: 75,
          alt_search: query,
          construction_details: "",
          url: vendorUrl, // DIRECT vendor link
          price: priceNum ? `$${priceNum.toFixed(2)}` : null,
        };

        scans.push({
          id: uuid(),
          user_id: account.id,
          image_url: product.thumbnail,
          image_thumbnail: product.thumbnail,
          detected_gender: gender,
          summary: product.title.slice(0, 120),
          items: [item],
          tiers: null,
          visibility: "public",
          created_at: new Date(Date.now() - Math.floor(Math.random() * 14 * 24 * 60 * 60 * 1000)).toISOString(),
        });
      }

      if (scans.length > 0) {
        const { error } = await supabase.from("scans").insert(scans);
        if (error) {
          console.error(`    Error: ${error.message}`);
        } else {
          totalScans += scans.length;
          totalProducts += scans.length;
          process.stdout.write(`    → ${scans.length} scans created (${totalScans} total)\n`);
        }
      }

      // Rate limit: 250ms between API calls
      await wait(250);
    }
  }

  console.log(`\n════════════════════════════════════════`);
  console.log(`Done!`);
  console.log(`  SerpAPI calls: ${totalApiCalls}`);
  console.log(`  Scans created: ${totalScans}`);
  console.log(`  Real product images: ${totalProducts}`);
  console.log(`════════════════════════════════════════\n`);
}

run().catch(err => { console.error("Fatal:", err.message); process.exit(1); });
