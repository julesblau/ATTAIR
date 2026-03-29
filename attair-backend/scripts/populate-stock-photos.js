#!/usr/bin/env node
/**
 * Populate seeded scans with stock fashion photos from Unsplash.
 * Maps photos to style archetype + gender based on scan summary keywords.
 *
 * Usage: node scripts/populate-stock-photos.js
 */

import { createClient } from "@supabase/supabase-js";
import { config } from "dotenv";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: join(__dirname, "..", ".env") });

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Unsplash CDN URLs — curated fashion photos by style + gender
// Format: https://images.unsplash.com/photo-{id}?w=600&h=800&fit=crop&crop=center
const u = (id) => `https://images.unsplash.com/${id}?w=600&h=800&fit=crop&crop=center`;

const STOCK_PHOTOS = {
  streetwear_m: [
    u("photo-1552374196-1ab2a1c593e8"),  // man streetwear hoodie
    u("photo-1515886657613-9f3515b0c78f"),  // urban male fashion
    u("photo-1571945153237-4929e783af4a"),  // streetwear outfit
    u("photo-1523398002811-999ca8dec234"),  // casual street
    u("photo-1527631746610-bca00a040d60"),  // urban menswear
    u("photo-1600185365483-26d7a4cc7519"),  // hoodie and sneakers
    u("photo-1622519407650-3df9883f76a5"),  // street fashion male
    u("photo-1564564321837-a57b7070ac4f"),  // sneaker outfit
  ],
  streetwear_f: [
    u("photo-1509631179647-0177331693ae"),  // women streetwear
    u("photo-1520367445093-50dc08a59d9d"),  // street style woman
    u("photo-1581044777550-4cfa60707998"),  // urban female fashion
    u("photo-1496747611176-843222e1e57c"),  // casual street woman
    u("photo-1529139574466-a303027c1d8b"),  // street style
    u("photo-1485968579580-b6d095142e6e"),  // urban outfit woman
    u("photo-1583744946564-b52ac1c389c8"),  // oversized hoodie woman
    u("photo-1487222477894-8943e31ef7b2"),  // street casual
  ],
  minimalist_m: [
    u("photo-1507003211169-0a1dd7228f2d"),  // clean menswear
    u("photo-1519085360753-af0119f7cbe7"),  // minimal male outfit
    u("photo-1617137968427-85924c800a22"),  // neutral tones man
    u("photo-1480429370612-2cd423e2e17b"),  // simple clean look
    u("photo-1594938298603-c8148c4dae35"),  // minimal style
    u("photo-1611312449408-fcece27cdbb7"),  // monochrome male
    u("photo-1521572163474-6864f9cf17ab"),  // clean basics
    u("photo-1472842459217-4b3b8e55af02"),  // simple outfit
  ],
  minimalist_f: [
    u("photo-1534528741775-53994a69daeb"),  // minimal woman style
    u("photo-1485462537746-965f33f7f6a7"),  // clean female fashion
    u("photo-1492707892479-7bc8d5a4ee93"),  // neutral woman outfit
    u("photo-1505740420928-5e560c06d30e"),  // simple elegant woman
    u("photo-1504703395950-b89145a5425b"),  // white minimal look
    u("photo-1469334031218-e382a71b716b"),  // clean basics woman
    u("photo-1581338834647-b0fb40704e21"),  // minimal wardrobe
    u("photo-1550639525-c97d455acf70"),  // neutral tones
  ],
  vintage_m: [
    u("photo-1516826957135-700dedea698c"),  // vintage male style
    u("photo-1506794778202-cad84cf45f1d"),  // retro menswear
    u("photo-1548883354-94bcfe321cbb"),  // vintage jacket
    u("photo-1493106819501-66d381c466f3"),  // retro casual
    u("photo-1517941823-815bea90d291"),  // classic vintage
    u("photo-1533808510650-6b0e2e8e9f41"),  // thrift store vibes
    u("photo-1580657018950-c7f7d6a6d990"),  // 70s inspired
    u("photo-1535295972055-1c762f4483e5"),  // vintage denim
  ],
  vintage_f: [
    u("photo-1509319117193-57bab727e09d"),  // vintage woman fashion
    u("photo-1504439904031-93ded9f93e4e"),  // retro dress
    u("photo-1490481651871-ab68de25d43d"),  // vintage style woman
    u("photo-1558618666-fcd25c85f82e"),  // thrift finds
    u("photo-1508427953056-b00b8d78ebf5"),  // retro look
    u("photo-1502716119720-b23a1e3b4c31"),  // vintage outfit
    u("photo-1544005313-94ddf0286df2"),  // classic vintage woman
    u("photo-1517841905240-472988babdf9"),  // 90s revival
  ],
  preppy_m: [
    u("photo-1507680434567-5739c80be1ac"),  // preppy menswear
    u("photo-1617196034796-73dfa7b1fd56"),  // polo casual
    u("photo-1520975954732-35dd22299614"),  // smart casual male
    u("photo-1617127365659-c47fa864d8bc"),  // chinos look
    u("photo-1560243563-062bfc001d68"),  // clean cut style
    u("photo-1580894742597-87bc8789db3d"),  // campus look
    u("photo-1499714608240-22fc6ad53fb2"),  // classic prep
    u("photo-1544027993-836c4682cc82"),  // blazer casual
  ],
  preppy_f: [
    u("photo-1515886657613-9f3515b0c78f"),  // preppy woman
    u("photo-1524504388940-b1c1722653e1"),  // smart casual woman
    u("photo-1539109136881-3be0616acf4b"),  // campus style woman
    u("photo-1583396080252-e7236e2a0b2d"),  // clean feminine
    u("photo-1502823403499-6ccfcf4fb453"),  // preppy dress
    u("photo-1494790108377-be9c29b29330"),  // polished look
    u("photo-1585487000160-6ebcfceb0d44"),  // classic woman
    u("photo-1487222477894-8943e31ef7b2"),  // prep casual
  ],
  athleisure_m: [
    u("photo-1571019613454-1cb2f99b2d8b"),  // athletic male
    u("photo-1581009146145-b5ef050c2e1e"),  // sporty style man
    u("photo-1517836357463-d25dfeac3438"),  // gym casual
    u("photo-1612872087720-bb876e2e67d1"),  // jogger outfit
    u("photo-1544367567-0f2fcb009e0b"),  // sport casual
    u("photo-1576610616656-d3aa5d1f4534"),  // athleisure fit
    u("photo-1518459031867-a89b944bffe4"),  // running outfit
    u("photo-1590556409324-aa1d726e5c3c"),  // sneaker athletic
  ],
  athleisure_f: [
    u("photo-1518310383802-640c2de311b2"),  // athletic woman
    u("photo-1571019614242-c5c5dee9f50b"),  // sporty woman outfit
    u("photo-1506629082955-511b1aa562c8"),  // yoga casual
    u("photo-1517836357463-d25dfeac3438"),  // gym style woman
    u("photo-1594381898411-846e7d193883"),  // athleisure woman
    u("photo-1583454110551-21f2fa2afe61"),  // legging outfit
    u("photo-1526506118085-60ce8714f8c5"),  // sporty casual
    u("photo-1549576490-b0b4831ef60a"),  // fitness fashion
  ],
  luxury_m: [
    u("photo-1617137968427-85924c800a22"),  // luxury menswear
    u("photo-1507003211169-0a1dd7228f2d"),  // designer look
    u("photo-1519085360753-af0119f7cbe7"),  // tailored suit
    u("photo-1591047139829-d91aecb6caea"),  // luxury casual
    u("photo-1593030761757-71fae45fa0e7"),  // designer brand
    u("photo-1620012253295-c15cc3e65df4"),  // upscale menswear
    u("photo-1521572163474-6864f9cf17ab"),  // refined style
    u("photo-1583743814966-8936f5b7be1a"),  // premium outfit
  ],
  luxury_f: [
    u("photo-1550639525-c97d455acf70"),  // luxury woman fashion
    u("photo-1485462537746-965f33f7f6a7"),  // designer woman outfit
    u("photo-1509631179647-0177331693ae"),  // high fashion woman
    u("photo-1518577915332-c2a19f149a75"),  // luxury dress
    u("photo-1469334031218-e382a71b716b"),  // designer look
    u("photo-1490481651871-ab68de25d43d"),  // elegant style
    u("photo-1515886657613-9f3515b0c78f"),  // upscale fashion
    u("photo-1492707892479-7bc8d5a4ee93"),  // refined woman
  ],
  casual_m: [
    u("photo-1552374196-1ab2a1c593e8"),  // casual male
    u("photo-1600185365483-26d7a4cc7519"),  // relaxed outfit
    u("photo-1523398002811-999ca8dec234"),  // everyday style
    u("photo-1480429370612-2cd423e2e17b"),  // casual basics
    u("photo-1564564321837-a57b7070ac4f"),  // t-shirt jeans
    u("photo-1594938298603-c8148c4dae35"),  // easy casual
    u("photo-1472842459217-4b3b8e55af02"),  // laid back
    u("photo-1535295972055-1c762f4483e5"),  // weekend wear
  ],
  casual_f: [
    u("photo-1496747611176-843222e1e57c"),  // casual woman
    u("photo-1529139574466-a303027c1d8b"),  // relaxed woman outfit
    u("photo-1504439904031-93ded9f93e4e"),  // everyday woman
    u("photo-1487222477894-8943e31ef7b2"),  // easy outfit
    u("photo-1517841905240-472988babdf9"),  // weekend look
    u("photo-1581338834647-b0fb40704e21"),  // casual chic
    u("photo-1524504388940-b1c1722653e1"),  // simple style
    u("photo-1534528741775-53994a69daeb"),  // everyday chic
  ],
  edgy_m: [
    u("photo-1548883354-94bcfe321cbb"),  // edgy male
    u("photo-1516826957135-700dedea698c"),  // dark style man
    u("photo-1533808510650-6b0e2e8e9f41"),  // grunge male
    u("photo-1580657018950-c7f7d6a6d990"),  // alternative style
    u("photo-1506794778202-cad84cf45f1d"),  // bold look
    u("photo-1571945153237-4929e783af4a"),  // punk inspired
    u("photo-1493106819501-66d381c466f3"),  // dark aesthetic
    u("photo-1517941823-815bea90d291"),  // leather jacket
  ],
  edgy_f: [
    u("photo-1509319117193-57bab727e09d"),  // edgy woman
    u("photo-1558618666-fcd25c85f82e"),  // dark woman fashion
    u("photo-1544005313-94ddf0286df2"),  // grunge woman
    u("photo-1520367445093-50dc08a59d9d"),  // alternative woman
    u("photo-1581044777550-4cfa60707998"),  // bold woman
    u("photo-1508427953056-b00b8d78ebf5"),  // punk aesthetic
    u("photo-1485968579580-b6d095142e6e"),  // leather look
    u("photo-1583744946564-b52ac1c389c8"),  // dark style woman
  ],
  korean_m: [
    u("photo-1611312449408-fcece27cdbb7"),  // korean male fashion
    u("photo-1507003211169-0a1dd7228f2d"),  // clean asian style
    u("photo-1519085360753-af0119f7cbe7"),  // minimal korean
    u("photo-1594938298603-c8148c4dae35"),  // k-fashion male
    u("photo-1617137968427-85924c800a22"),  // layered korean
    u("photo-1521572163474-6864f9cf17ab"),  // clean cut
    u("photo-1480429370612-2cd423e2e17b"),  // soft boy aesthetic
    u("photo-1472842459217-4b3b8e55af02"),  // korean casual
  ],
  korean_f: [
    u("photo-1534528741775-53994a69daeb"),  // korean woman fashion
    u("photo-1505740420928-5e560c06d30e"),  // k-fashion woman
    u("photo-1469334031218-e382a71b716b"),  // soft girl aesthetic
    u("photo-1504703395950-b89145a5425b"),  // minimal korean woman
    u("photo-1492707892479-7bc8d5a4ee93"),  // clean k-style
    u("photo-1550639525-c97d455acf70"),  // layered feminine
    u("photo-1485462537746-965f33f7f6a7"),  // korean chic
    u("photo-1581338834647-b0fb40704e21"),  // elegant k-fashion
  ],
  workwear_m: [
    u("photo-1560243563-062bfc001d68"),  // workwear male
    u("photo-1507680434567-5739c80be1ac"),  // utility style
    u("photo-1535295972055-1c762f4483e5"),  // denim workwear
    u("photo-1544027993-836c4682cc82"),  // rugged style
    u("photo-1580894742597-87bc8789db3d"),  // boots and denim
    u("photo-1523398002811-999ca8dec234"),  // construction casual
    u("photo-1600185365483-26d7a4cc7519"),  // heritage brand
    u("photo-1499714608240-22fc6ad53fb2"),  // canvas jacket
  ],
  workwear_f: [
    u("photo-1539109136881-3be0616acf4b"),  // workwear woman
    u("photo-1583396080252-e7236e2a0b2d"),  // utility woman
    u("photo-1502823403499-6ccfcf4fb453"),  // denim on denim
    u("photo-1494790108377-be9c29b29330"),  // rugged feminine
    u("photo-1585487000160-6ebcfceb0d44"),  // heritage woman
    u("photo-1524504388940-b1c1722653e1"),  // boots outfit
    u("photo-1529139574466-a303027c1d8b"),  // canvas style
    u("photo-1496747611176-843222e1e57c"),  // utility chic
  ],
};

// Keyword mapping: summary keywords → style archetype
const STYLE_KEYWORDS = {
  streetwear: ["street", "hoodie", "sneaker", "urban", "oversized", "graphic", "cargo", "hip hop"],
  minimalist: ["minimal", "clean", "neutral", "monochrome", "simple", "understated", "muted", "basics", "capsule"],
  vintage: ["vintage", "retro", "thrift", "70s", "80s", "90s", "secondhand", "revival", "classic denim"],
  preppy: ["preppy", "polo", "blazer", "chino", "campus", "ivy", "loafer", "button-down", "tailored casual"],
  athleisure: ["athletic", "sport", "yoga", "gym", "jogger", "runner", "legging", "sneaker", "active", "performance"],
  luxury: ["luxury", "designer", "premium", "silk", "cashmere", "high-end", "upscale", "refined", "couture", "tailored"],
  casual: ["casual", "relaxed", "everyday", "weekend", "laid back", "easy", "comfortable", "t-shirt", "basic"],
  edgy: ["edgy", "dark", "leather", "punk", "grunge", "alternative", "bold", "chain", "distressed", "moto"],
  korean: ["korean", "k-fashion", "k-style", "seoul", "asian", "layered knit", "soft", "oversized blazer"],
  workwear: ["work", "utility", "canvas", "denim jacket", "boots", "rugged", "heritage", "carhartt", "tool"],
};

function detectStyle(summary) {
  const lower = (summary || "").toLowerCase();
  let bestStyle = "casual";
  let bestScore = 0;

  for (const [style, keywords] of Object.entries(STYLE_KEYWORDS)) {
    let score = 0;
    for (const kw of keywords) {
      if (lower.includes(kw)) score++;
    }
    if (score > bestScore) {
      bestScore = score;
      bestStyle = style;
    }
  }
  return bestStyle;
}

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

async function main() {
  console.log("Fetching scans with null image_url...");

  // Fetch all scans with null image_url
  let allScans = [];
  let page = 0;
  const pageSize = 1000;

  while (true) {
    const { data, error } = await supabase
      .from("scans")
      .select("id, summary, detected_gender")
      .is("image_url", null)
      .range(page * pageSize, (page + 1) * pageSize - 1);

    if (error) {
      console.error("Query error:", error.message);
      break;
    }
    if (!data || data.length === 0) break;
    allScans = allScans.concat(data);
    if (data.length < pageSize) break;
    page++;
  }

  console.log(`Found ${allScans.length} scans with null image_url.`);
  if (allScans.length === 0) {
    console.log("Nothing to update.");
    return;
  }

  // Track usage to ensure variety
  const usageCounts = {};

  // Assign photos
  const updates = allScans.map(scan => {
    const style = detectStyle(scan.summary);
    const genderSuffix = scan.detected_gender === "female" ? "_f" : "_m";
    const key = `${style}${genderSuffix}`;
    const photos = STOCK_PHOTOS[key] || STOCK_PHOTOS[`casual${genderSuffix}`];

    // Pick least-used photo for variety
    if (!usageCounts[key]) usageCounts[key] = new Map();
    const counts = usageCounts[key];

    let minCount = Infinity;
    let candidates = [];
    for (const p of photos) {
      const c = counts.get(p) || 0;
      if (c < minCount) { minCount = c; candidates = [p]; }
      else if (c === minCount) candidates.push(p);
    }

    const photo = pick(candidates);
    counts.set(photo, (counts.get(photo) || 0) + 1);

    return { id: scan.id, image_url: photo };
  });

  // Batch update
  console.log("Updating scans with stock photos...");
  let updated = 0;

  for (let i = 0; i < updates.length; i += 50) {
    const batch = updates.slice(i, i + 50);

    // Supabase doesn't support bulk update by ID easily, so we do individual updates
    // but run them concurrently in batches
    const promises = batch.map(({ id, image_url }) =>
      supabase.from("scans").update({ image_url }).eq("id", id)
    );

    const results = await Promise.all(promises);
    const errors = results.filter(r => r.error);
    if (errors.length > 0) {
      console.error(`  ${errors.length} errors in batch ${Math.floor(i/50)}:`, errors[0].error.message);
    }

    updated += batch.length - errors.length;
    process.stdout.write(`  Updated ${updated}/${allScans.length}\r`);
  }

  console.log(`\nDone! Updated ${updated} scans with stock fashion photos.`);

  // Print distribution
  console.log("\nStyle distribution:");
  for (const [key, counts] of Object.entries(usageCounts)) {
    const total = Array.from(counts.values()).reduce((a, b) => a + b, 0);
    console.log(`  ${key}: ${total} scans`);
  }
}

main().catch(console.error);
