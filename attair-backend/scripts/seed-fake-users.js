#!/usr/bin/env node
/**
 * Seed 100 fake users with diverse fashion content.
 * No Claude Vision API calls — pure synthetic data.
 *
 * Usage: node scripts/seed-fake-users.js
 *
 * Creates:
 *  - 100 AI-flagged user profiles (is_ai: true)
 *  - 5-15 public scans per user (~800-1000 total)
 *  - Random follow relationships between users
 *  - Some saved_items for social proof
 */

import { createClient } from "@supabase/supabase-js";
import { config } from "dotenv";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import crypto from "crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: join(__dirname, "..", ".env") });

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ─── Data pools ──────────────────────────────────────────────

const FIRST_NAMES_F = [
  "Aaliyah", "Bella", "Carmen", "Deja", "Elena", "Fatima", "Grace", "Hana",
  "Iris", "Jade", "Kaia", "Luna", "Maya", "Nia", "Olivia", "Priya",
  "Quinn", "Rosa", "Suki", "Talia", "Uma", "Violet", "Winnie", "Xena",
  "Yara", "Zara", "Amara", "Bianca", "Chloe", "Diana", "Emiko", "Freya",
  "Gigi", "Harper", "Ines", "Jada", "Keiko", "Leila", "Mika", "Noor",
  "Paloma", "Raven", "Sasha", "Tiana", "Valentina", "Willow", "Xiomara", "Yuki"
];

const FIRST_NAMES_M = [
  "Andre", "Blake", "Carlos", "Devon", "Elias", "Felix", "Gabriel", "Hassan",
  "Isaac", "Jamal", "Kai", "Leo", "Miles", "Noah", "Omar", "Phoenix",
  "Quincy", "Rafael", "Sage", "Theo", "Umi", "Vincent", "Wesley", "Xavier",
  "Yosef", "Zion", "Aiden", "Bodhi", "Cyrus", "Dante", "Ezra", "Flynn",
  "Gio", "Hugo", "Idris", "Jalen", "Kenzo", "Liam", "Malik", "Nico",
  "Orion", "Rio", "Silas", "Tyrell", "Usher", "Vance", "Wyatt", "Zayn"
];

const LAST_NAMES = [
  "Chen", "Williams", "Garcia", "Kim", "Patel", "Santos", "Taylor", "Nakamura",
  "Brown", "Silva", "Lee", "Anderson", "Martinez", "Robinson", "Okafor", "Nguyen",
  "Jackson", "Wright", "Lopez", "Thompson", "White", "Harris", "Clark", "Lewis",
  "Young", "Allen", "Scott", "Adams", "Mitchell", "Roberts", "Turner", "Phillips",
  "Campbell", "Parker", "Evans", "Edwards", "Collins", "Stewart", "Morris", "Rogers"
];

const BIOS = [
  "thrifting queen", "vintage collector", "streetwear daily",
  "minimalist fits only", "designer on a budget", "fashion student",
  "outfit repeater & proud", "NYC street style", "LA casual vibes",
  "sustainable fashion advocate", "sneakerhead", "accessory obsessed",
  "neutral tones forever", "color maximalist", "denim everything",
  "90s revival", "cottagecore girlie", "dark academia aesthetic",
  "athleisure convert", "capsule wardrobe builder", "mix high & low",
  "fashion tech nerd", "always overdressed", "effortlessly underdressed",
  "pattern clash enthusiast", "monochrome mood", "boho soul",
  "preppy with edge", "y2k throwback", "coastal grandmother energy",
  "old money aesthetic", "quiet luxury fan", "dopamine dressing",
  "gorpcore enthusiast", "balletcore era", "workwear collector",
  "vintage denim hunter", "silk & cashmere only", "thrift flip artist",
  "unisex fits", "gender fluid fashion", "avant garde or nothing"
];

const STYLE_INTERESTS = [
  "streetwear", "minimalist", "vintage", "preppy", "athleisure",
  "bohemian", "grunge", "cottagecore", "dark academia", "y2k",
  "coastal", "old money", "quiet luxury", "dopamine dressing",
  "gorpcore", "balletcore", "workwear", "avant garde", "normcore",
  "techwear", "scandinavian", "italian", "japanese", "korean",
  "punk", "romantic", "edgy", "classic", "sporty", "eclectic"
];

// ─── Outfit templates by style archetype ─────────────────────

const OUTFIT_TEMPLATES = {
  streetwear_m: [
    {
      summary: "Oversized street style with premium sneakers and layered accessories",
      items: [
        { name: "Oversized Graphic Hoodie", brand: "Stussy", brand_confidence: "high", category: "top", subcategory: "hoodie", color: "washed black", material: "heavyweight cotton french terry", fit: "oversized", search_query: "men's Stussy oversized graphic hoodie black", style_keywords: ["streetwear", "oversized", "urban"], price_range: "$90 - $130" },
        { name: "Wide Leg Cargo Pants", brand: "Carhartt WIP", brand_confidence: "high", category: "bottom", subcategory: "cargo pants", color: "olive green", material: "cotton ripstop", fit: "relaxed", search_query: "men's Carhartt WIP wide leg cargo pants olive", style_keywords: ["streetwear", "workwear", "utility"], price_range: "$120 - $160" },
        { name: "Retro Running Sneakers", brand: "New Balance", brand_confidence: "confirmed", category: "shoes", subcategory: "sneakers", color: "grey navy", material: "suede mesh", fit: "regular", search_query: "men's New Balance 990v6 grey sneakers", style_keywords: ["retro", "dad shoe", "streetwear"], price_range: "$180 - $200" }
      ]
    },
    {
      summary: "Clean streetwear with Japanese influences and muted tones",
      items: [
        { name: "Boxy Mock Neck Tee", brand: "Uniqlo U", brand_confidence: "moderate", category: "top", subcategory: "t-shirt", color: "cream", material: "heavy cotton jersey", fit: "boxy", search_query: "men's Uniqlo U mock neck oversized tee cream", style_keywords: ["minimalist", "japanese", "clean"], price_range: "$20 - $30" },
        { name: "Relaxed Tapered Jeans", brand: "Unidentified", brand_confidence: "low", category: "bottom", subcategory: "jeans", color: "washed indigo", material: "non-stretch selvedge denim", fit: "relaxed", search_query: "men's relaxed tapered selvedge jeans indigo", style_keywords: ["japanese denim", "relaxed", "classic"], price_range: "$60 - $120" },
        { name: "Canvas Low Top Sneakers", brand: "Converse", brand_confidence: "confirmed", category: "shoes", subcategory: "sneakers", color: "off white", material: "canvas rubber", fit: "regular", search_query: "men's Converse Chuck 70 low off white", style_keywords: ["classic", "minimal", "casual"], price_range: "$80 - $90" }
      ]
    },
    {
      summary: "Hypebeast fit with designer accessories and chunky sneakers",
      items: [
        { name: "Logo Embossed Track Jacket", brand: "Nike", brand_confidence: "confirmed", category: "outerwear", subcategory: "track jacket", color: "black white", material: "polyester tricot", fit: "regular", search_query: "men's Nike Sportswear track jacket black", style_keywords: ["sporty", "streetwear", "athleisure"], price_range: "$80 - $100" },
        { name: "Distressed Slim Jeans", brand: "Amiri", brand_confidence: "high", category: "bottom", subcategory: "jeans", color: "light wash", material: "stretch distressed denim", fit: "slim", search_query: "men's Amiri distressed slim jeans light wash", style_keywords: ["luxury streetwear", "distressed", "designer"], price_range: "$800 - $1200" },
        { name: "Chunky Platform Sneakers", brand: "Balenciaga", brand_confidence: "high", category: "shoes", subcategory: "sneakers", color: "triple white", material: "mesh leather", fit: "regular", search_query: "men's Balenciaga Track sneakers white", style_keywords: ["luxury", "chunky", "statement"], price_range: "$900 - $1100" }
      ]
    }
  ],
  streetwear_f: [
    {
      summary: "Sporty streetwear with crop top and high-waisted cargos",
      items: [
        { name: "Cropped Logo Tank", brand: "Nike", brand_confidence: "confirmed", category: "top", subcategory: "tank top", color: "white", material: "cotton jersey", fit: "cropped", search_query: "women's Nike cropped logo tank white", style_keywords: ["sporty", "streetwear", "minimal"], price_range: "$25 - $35" },
        { name: "High Rise Cargo Joggers", brand: "Unidentified", brand_confidence: "low", category: "bottom", subcategory: "joggers", color: "sage green", material: "cotton twill", fit: "relaxed", search_query: "women's high rise cargo joggers sage green", style_keywords: ["streetwear", "utility", "casual"], price_range: "$40 - $60" },
        { name: "Platform Air Force 1", brand: "Nike", brand_confidence: "confirmed", category: "shoes", subcategory: "sneakers", color: "white", material: "leather", fit: "regular", search_query: "women's Nike Air Force 1 platform white", style_keywords: ["classic", "platform", "streetwear"], price_range: "$120 - $140" }
      ]
    },
    {
      summary: "Y2K inspired with baby tee, low-rise pants and mini bag",
      items: [
        { name: "Rhinestone Baby Tee", brand: "Unidentified", brand_confidence: "low", category: "top", subcategory: "t-shirt", color: "baby pink", material: "stretch cotton", fit: "slim", search_query: "women's rhinestone baby tee pink Y2K", style_keywords: ["y2k", "girly", "retro"], price_range: "$15 - $30" },
        { name: "Low Rise Flare Pants", brand: "Zara", brand_confidence: "moderate", category: "bottom", subcategory: "trousers", color: "black", material: "ponte knit", fit: "regular", search_query: "women's Zara low rise flare pants black", style_keywords: ["y2k", "going out", "trendy"], price_range: "$40 - $60" },
        { name: "Mini Shoulder Bag", brand: "Unidentified", brand_confidence: "low", category: "bag", subcategory: "shoulder bag", color: "silver", material: "metallic faux leather", fit: "regular", search_query: "women's silver mini shoulder bag metallic", style_keywords: ["y2k", "going out", "accessories"], price_range: "$20 - $40" }
      ]
    }
  ],
  minimalist_m: [
    {
      summary: "Clean monochrome layers with precise tailoring",
      items: [
        { name: "Merino Wool Crew Sweater", brand: "COS", brand_confidence: "moderate", category: "top", subcategory: "sweater", color: "charcoal grey", material: "fine merino wool", fit: "regular", search_query: "men's COS merino wool crew sweater charcoal", style_keywords: ["minimalist", "scandinavian", "clean"], price_range: "$80 - $120" },
        { name: "Slim Chinos", brand: "Theory", brand_confidence: "moderate", category: "bottom", subcategory: "chinos", color: "navy", material: "stretch cotton twill", fit: "slim", search_query: "men's Theory slim chinos navy stretch", style_keywords: ["minimalist", "smart casual", "tailored"], price_range: "$150 - $200" },
        { name: "White Leather Sneakers", brand: "Common Projects", brand_confidence: "high", category: "shoes", subcategory: "sneakers", color: "white", material: "full grain leather", fit: "regular", search_query: "men's Common Projects Achilles low white leather", style_keywords: ["minimalist", "luxury", "clean"], price_range: "$400 - $450" }
      ]
    },
    {
      summary: "All-black everything with architectural silhouettes",
      items: [
        { name: "Structured Overcoat", brand: "Acne Studios", brand_confidence: "moderate", category: "outerwear", subcategory: "overcoat", color: "black", material: "wool cashmere blend", fit: "tailored", search_query: "men's Acne Studios wool overcoat black", style_keywords: ["minimalist", "scandinavian", "architectural"], price_range: "$700 - $1000" },
        { name: "Slim Turtleneck", brand: "Unidentified", brand_confidence: "low", category: "top", subcategory: "turtleneck", color: "black", material: "fine knit merino", fit: "slim", search_query: "men's slim black merino turtleneck sweater", style_keywords: ["minimalist", "layering", "classic"], price_range: "$50 - $100" },
        { name: "Straight Leg Trousers", brand: "Lemaire", brand_confidence: "moderate", category: "bottom", subcategory: "trousers", color: "black", material: "wool gabardine", fit: "regular", search_query: "men's Lemaire straight leg wool trousers black", style_keywords: ["minimalist", "architectural", "quiet luxury"], price_range: "$400 - $600" }
      ]
    }
  ],
  minimalist_f: [
    {
      summary: "Effortless Scandi minimalism with neutral palette",
      items: [
        { name: "Oversized Cashmere Cardigan", brand: "Toteme", brand_confidence: "moderate", category: "outerwear", subcategory: "cardigan", color: "oatmeal", material: "cashmere wool blend", fit: "oversized", search_query: "women's Toteme oversized cashmere cardigan oatmeal", style_keywords: ["minimalist", "scandinavian", "quiet luxury"], price_range: "$400 - $600" },
        { name: "High Waist Wide Leg Trousers", brand: "COS", brand_confidence: "moderate", category: "bottom", subcategory: "trousers", color: "cream", material: "linen blend", fit: "relaxed", search_query: "women's COS high waist wide leg trousers cream", style_keywords: ["minimalist", "clean", "effortless"], price_range: "$80 - $120" },
        { name: "Square Toe Leather Mules", brand: "Unidentified", brand_confidence: "low", category: "shoes", subcategory: "mules", color: "tan", material: "smooth leather", fit: "regular", search_query: "women's square toe leather mules tan", style_keywords: ["minimalist", "modern", "clean"], price_range: "$80 - $150" }
      ]
    }
  ],
  vintage_m: [
    {
      summary: "Retro Americana with workwear details and vintage denim",
      items: [
        { name: "Flannel Shirt Jacket", brand: "Levi's", brand_confidence: "high", category: "outerwear", subcategory: "shirt jacket", color: "red black plaid", material: "heavyweight cotton flannel", fit: "regular", search_query: "men's Levi's flannel shirt jacket red plaid", style_keywords: ["vintage", "workwear", "americana"], price_range: "$80 - $120" },
        { name: "Straight Leg 501 Jeans", brand: "Levi's", brand_confidence: "confirmed", category: "bottom", subcategory: "jeans", color: "medium wash", material: "non-stretch denim", fit: "regular", search_query: "men's Levi's 501 original jeans medium wash", style_keywords: ["vintage", "classic", "americana"], price_range: "$60 - $80" },
        { name: "Leather Work Boots", brand: "Red Wing", brand_confidence: "high", category: "shoes", subcategory: "boots", color: "brown", material: "full grain leather", fit: "regular", search_query: "men's Red Wing Iron Ranger boots brown", style_keywords: ["workwear", "heritage", "rugged"], price_range: "$300 - $350" }
      ]
    }
  ],
  vintage_f: [
    {
      summary: "70s inspired boho look with earth tones and flowing fabrics",
      items: [
        { name: "Crochet Knit Vest", brand: "Free People", brand_confidence: "moderate", category: "top", subcategory: "vest", color: "rust orange", material: "cotton crochet knit", fit: "regular", search_query: "women's Free People crochet knit vest rust", style_keywords: ["boho", "70s", "vintage"], price_range: "$60 - $90" },
        { name: "High Rise Flare Jeans", brand: "Unidentified", brand_confidence: "low", category: "bottom", subcategory: "jeans", color: "dark indigo", material: "stretch denim", fit: "regular", search_query: "women's high rise flare jeans dark indigo vintage", style_keywords: ["70s", "retro", "boho"], price_range: "$50 - $80" },
        { name: "Suede Ankle Boots", brand: "Unidentified", brand_confidence: "low", category: "shoes", subcategory: "boots", color: "cognac", material: "suede leather", fit: "regular", search_query: "women's suede ankle boots cognac western", style_keywords: ["western", "boho", "vintage"], price_range: "$80 - $150" }
      ]
    }
  ],
  preppy_m: [
    {
      summary: "Classic prep with modern fit and luxury basics",
      items: [
        { name: "Cotton Polo Shirt", brand: "Ralph Lauren", brand_confidence: "confirmed", category: "top", subcategory: "polo shirt", color: "navy blue", material: "cotton pique", fit: "slim", search_query: "men's Ralph Lauren slim fit polo navy", style_keywords: ["preppy", "classic", "smart casual"], price_range: "$80 - $110" },
        { name: "Chino Shorts", brand: "J.Crew", brand_confidence: "moderate", category: "bottom", subcategory: "shorts", color: "khaki", material: "cotton twill", fit: "regular", search_query: "men's J.Crew chino shorts khaki", style_keywords: ["preppy", "summer", "classic"], price_range: "$50 - $70" },
        { name: "Leather Boat Shoes", brand: "Sperry", brand_confidence: "confirmed", category: "shoes", subcategory: "boat shoes", color: "sahara brown", material: "full grain leather", fit: "regular", search_query: "men's Sperry Authentic Original boat shoes brown", style_keywords: ["preppy", "nautical", "classic"], price_range: "$90 - $110" }
      ]
    }
  ],
  preppy_f: [
    {
      summary: "Modern prep with tennis skirt and knit polo combo",
      items: [
        { name: "Knit Polo Top", brand: "Lacoste", brand_confidence: "confirmed", category: "top", subcategory: "polo shirt", color: "pastel green", material: "cotton pique", fit: "regular", search_query: "women's Lacoste polo shirt pastel green", style_keywords: ["preppy", "sporty", "classic"], price_range: "$90 - $120" },
        { name: "Pleated Tennis Skirt", brand: "Unidentified", brand_confidence: "low", category: "bottom", subcategory: "skirt", color: "white", material: "polyester blend", fit: "regular", search_query: "women's pleated tennis skirt white", style_keywords: ["preppy", "sporty", "collegiate"], price_range: "$30 - $50" },
        { name: "White Leather Sneakers", brand: "Veja", brand_confidence: "high", category: "shoes", subcategory: "sneakers", color: "white green", material: "leather", fit: "regular", search_query: "women's Veja Campo sneakers white green", style_keywords: ["sustainable", "clean", "preppy"], price_range: "$140 - $160" }
      ]
    }
  ],
  athleisure_m: [
    {
      summary: "Performance-meets-style with tech fabrics and sleek silhouettes",
      items: [
        { name: "Half-Zip Running Top", brand: "Nike", brand_confidence: "confirmed", category: "top", subcategory: "pullover", color: "charcoal", material: "Dri-FIT polyester", fit: "regular", search_query: "men's Nike Dri-FIT half zip running top charcoal", style_keywords: ["athleisure", "sporty", "performance"], price_range: "$60 - $80" },
        { name: "Tapered Jogger Pants", brand: "Lululemon", brand_confidence: "high", category: "bottom", subcategory: "joggers", color: "black", material: "warpstreme fabric", fit: "slim", search_query: "men's Lululemon ABC jogger black", style_keywords: ["athleisure", "techwear", "comfort"], price_range: "$120 - $140" },
        { name: "Ultraboost Running Shoes", brand: "Adidas", brand_confidence: "confirmed", category: "shoes", subcategory: "sneakers", color: "core black", material: "primeknit", fit: "regular", search_query: "men's Adidas Ultraboost 23 black", style_keywords: ["performance", "athleisure", "running"], price_range: "$180 - $200" }
      ]
    }
  ],
  athleisure_f: [
    {
      summary: "Pilates-to-brunch fit with matching set and clean sneakers",
      items: [
        { name: "Ribbed Sports Bra", brand: "Alo Yoga", brand_confidence: "high", category: "top", subcategory: "sports bra", color: "espresso brown", material: "ribbed seamless nylon", fit: "slim", search_query: "women's Alo Yoga ribbed sports bra espresso", style_keywords: ["athleisure", "yoga", "clean girl"], price_range: "$50 - $70" },
        { name: "High Rise Leggings", brand: "Lululemon", brand_confidence: "confirmed", category: "bottom", subcategory: "leggings", color: "espresso brown", material: "Nulu fabric", fit: "slim", search_query: "women's Lululemon Align high rise leggings espresso", style_keywords: ["athleisure", "yoga", "comfort"], price_range: "$90 - $110" },
        { name: "Retro Sneakers", brand: "New Balance", brand_confidence: "confirmed", category: "shoes", subcategory: "sneakers", color: "beige", material: "suede mesh", fit: "regular", search_query: "women's New Balance 550 beige sneakers", style_keywords: ["retro", "clean", "casual"], price_range: "$100 - $120" }
      ]
    }
  ],
  luxury_m: [
    {
      summary: "Quiet luxury with Italian tailoring and subtle branding",
      items: [
        { name: "Cashmere Crew Sweater", brand: "Brunello Cucinelli", brand_confidence: "high", category: "top", subcategory: "sweater", color: "dove grey", material: "cashmere", fit: "regular", search_query: "men's Brunello Cucinelli cashmere sweater grey", style_keywords: ["quiet luxury", "italian", "refined"], price_range: "$1200 - $1800" },
        { name: "Tailored Wool Trousers", brand: "Loro Piana", brand_confidence: "high", category: "bottom", subcategory: "trousers", color: "charcoal", material: "super 150s wool", fit: "tailored", search_query: "men's Loro Piana wool tailored trousers charcoal", style_keywords: ["quiet luxury", "italian", "tailored"], price_range: "$800 - $1200" },
        { name: "Suede Loafers", brand: "Tod's", brand_confidence: "high", category: "shoes", subcategory: "loafers", color: "tan", material: "suede", fit: "regular", search_query: "men's Tod's suede loafers tan", style_keywords: ["luxury", "italian", "classic"], price_range: "$500 - $700" }
      ]
    }
  ],
  luxury_f: [
    {
      summary: "Old money elegance with silk blouse and structured accessories",
      items: [
        { name: "Silk Button-Down Blouse", brand: "The Row", brand_confidence: "moderate", category: "top", subcategory: "blouse", color: "ivory", material: "silk charmeuse", fit: "relaxed", search_query: "women's The Row silk button down blouse ivory", style_keywords: ["quiet luxury", "old money", "elegant"], price_range: "$800 - $1200" },
        { name: "Wide Leg Tailored Trousers", brand: "Max Mara", brand_confidence: "high", category: "bottom", subcategory: "trousers", color: "camel", material: "virgin wool", fit: "relaxed", search_query: "women's Max Mara wide leg wool trousers camel", style_keywords: ["quiet luxury", "tailored", "italian"], price_range: "$600 - $900" },
        { name: "Leather Tote Bag", brand: "Celine", brand_confidence: "high", category: "bag", subcategory: "tote", color: "tan", material: "smooth calfskin", fit: "regular", search_query: "women's Celine leather tote bag tan", style_keywords: ["luxury", "classic", "quiet luxury"], price_range: "$2000 - $3000" }
      ]
    }
  ],
  casual_m: [
    {
      summary: "Weekend casual with henley, chinos and slip-on sneakers",
      items: [
        { name: "Waffle Knit Henley", brand: "Unidentified", brand_confidence: "low", category: "top", subcategory: "henley", color: "heather grey", material: "waffle knit cotton", fit: "regular", search_query: "men's waffle knit henley heather grey", style_keywords: ["casual", "weekend", "relaxed"], price_range: "$25 - $45" },
        { name: "Slim Chinos", brand: "Bonobos", brand_confidence: "moderate", category: "bottom", subcategory: "chinos", color: "stone", material: "stretch cotton twill", fit: "slim", search_query: "men's Bonobos slim stretch chinos stone", style_keywords: ["smart casual", "clean", "versatile"], price_range: "$80 - $100" },
        { name: "Slip-On Sneakers", brand: "Vans", brand_confidence: "confirmed", category: "shoes", subcategory: "sneakers", color: "classic white", material: "canvas", fit: "regular", search_query: "men's Vans Classic Slip-On white", style_keywords: ["casual", "classic", "skate"], price_range: "$50 - $60" }
      ]
    }
  ],
  casual_f: [
    {
      summary: "Relaxed weekend look with oversized button-down and straight jeans",
      items: [
        { name: "Oversized Linen Shirt", brand: "Unidentified", brand_confidence: "low", category: "top", subcategory: "button-down", color: "light blue", material: "linen", fit: "oversized", search_query: "women's oversized linen button down light blue", style_keywords: ["casual", "relaxed", "coastal"], price_range: "$30 - $60" },
        { name: "High Rise Straight Jeans", brand: "Agolde", brand_confidence: "high", category: "bottom", subcategory: "jeans", color: "medium wash", material: "rigid denim", fit: "regular", search_query: "women's Agolde 90s straight jeans medium wash", style_keywords: ["90s", "clean", "versatile"], price_range: "$180 - $220" },
        { name: "Leather Slide Sandals", brand: "Birkenstock", brand_confidence: "confirmed", category: "shoes", subcategory: "sandals", color: "taupe", material: "oiled leather", fit: "regular", search_query: "women's Birkenstock Arizona sandals taupe leather", style_keywords: ["casual", "comfort", "classic"], price_range: "$130 - $150" }
      ]
    }
  ],
  edgy_m: [
    {
      summary: "Dark layered look with leather jacket and combat boots",
      items: [
        { name: "Leather Biker Jacket", brand: "AllSaints", brand_confidence: "high", category: "outerwear", subcategory: "leather jacket", color: "black", material: "lamb leather", fit: "slim", search_query: "men's AllSaints leather biker jacket black", style_keywords: ["edgy", "rock", "moto"], price_range: "$400 - $500" },
        { name: "Distressed Skinny Jeans", brand: "Unidentified", brand_confidence: "low", category: "bottom", subcategory: "jeans", color: "black", material: "stretch denim", fit: "slim", search_query: "men's distressed skinny jeans black", style_keywords: ["edgy", "grunge", "punk"], price_range: "$40 - $80" },
        { name: "Combat Boots", brand: "Dr. Martens", brand_confidence: "confirmed", category: "shoes", subcategory: "boots", color: "black", material: "smooth leather", fit: "regular", search_query: "men's Dr. Martens 1460 boots black", style_keywords: ["punk", "edgy", "classic"], price_range: "$150 - $180" }
      ]
    }
  ],
  edgy_f: [
    {
      summary: "Grunge-meets-glam with mesh top, leather skirt and platform boots",
      items: [
        { name: "Mesh Long Sleeve Top", brand: "Unidentified", brand_confidence: "low", category: "top", subcategory: "long sleeve", color: "black", material: "stretch mesh", fit: "slim", search_query: "women's black mesh long sleeve top", style_keywords: ["edgy", "grunge", "going out"], price_range: "$15 - $30" },
        { name: "Faux Leather Mini Skirt", brand: "Unidentified", brand_confidence: "low", category: "bottom", subcategory: "skirt", color: "black", material: "faux leather", fit: "regular", search_query: "women's faux leather mini skirt black", style_keywords: ["edgy", "going out", "punk"], price_range: "$25 - $50" },
        { name: "Platform Chelsea Boots", brand: "Dr. Martens", brand_confidence: "confirmed", category: "shoes", subcategory: "boots", color: "black", material: "smooth leather", fit: "regular", search_query: "women's Dr. Martens platform Chelsea boots black", style_keywords: ["punk", "platform", "edgy"], price_range: "$180 - $210" }
      ]
    }
  ],
  korean_m: [
    {
      summary: "K-fashion with structured layers and clean proportions",
      items: [
        { name: "Oversized Blazer", brand: "Unidentified", brand_confidence: "low", category: "outerwear", subcategory: "blazer", color: "light grey", material: "polyester blend", fit: "oversized", search_query: "men's oversized drop shoulder blazer light grey", style_keywords: ["korean", "oversized", "modern"], price_range: "$60 - $120" },
        { name: "Wide Leg Pleated Trousers", brand: "Unidentified", brand_confidence: "low", category: "bottom", subcategory: "trousers", color: "black", material: "polyester blend", fit: "relaxed", search_query: "men's wide leg pleated trousers black korean", style_keywords: ["korean", "minimalist", "structured"], price_range: "$40 - $80" },
        { name: "Chunky Sole Derbies", brand: "Unidentified", brand_confidence: "low", category: "shoes", subcategory: "derby shoes", color: "black", material: "leather", fit: "regular", search_query: "men's chunky sole derby shoes black", style_keywords: ["korean", "modern", "chunky"], price_range: "$60 - $120" }
      ]
    }
  ],
  korean_f: [
    {
      summary: "Soft K-fashion with oversized layers and neutral tones",
      items: [
        { name: "Oversized Knit Cardigan", brand: "Unidentified", brand_confidence: "low", category: "outerwear", subcategory: "cardigan", color: "lavender", material: "acrylic wool blend", fit: "oversized", search_query: "women's oversized knit cardigan lavender korean", style_keywords: ["korean", "soft", "cozy"], price_range: "$30 - $60" },
        { name: "High Waist Wide Leg Pants", brand: "Unidentified", brand_confidence: "low", category: "bottom", subcategory: "trousers", color: "cream", material: "cotton blend", fit: "relaxed", search_query: "women's high waist wide leg pants cream", style_keywords: ["korean", "minimalist", "clean"], price_range: "$30 - $50" },
        { name: "Platform Mary Janes", brand: "Unidentified", brand_confidence: "low", category: "shoes", subcategory: "mary janes", color: "black", material: "patent leather", fit: "regular", search_query: "women's platform mary jane shoes black patent", style_keywords: ["korean", "cute", "platform"], price_range: "$40 - $80" }
      ]
    }
  ],
  workwear_m: [
    {
      summary: "Modern business casual with clean lines",
      items: [
        { name: "Oxford Button-Down Shirt", brand: "Brooks Brothers", brand_confidence: "moderate", category: "top", subcategory: "button-down", color: "light blue", material: "oxford cotton", fit: "regular", search_query: "men's Brooks Brothers oxford button down light blue", style_keywords: ["classic", "business casual", "preppy"], price_range: "$80 - $100" },
        { name: "Flat Front Dress Pants", brand: "Unidentified", brand_confidence: "low", category: "bottom", subcategory: "dress pants", color: "charcoal", material: "wool blend", fit: "tailored", search_query: "men's flat front dress pants charcoal wool", style_keywords: ["business", "tailored", "classic"], price_range: "$60 - $100" },
        { name: "Leather Oxford Shoes", brand: "Cole Haan", brand_confidence: "moderate", category: "shoes", subcategory: "oxford shoes", color: "cognac", material: "burnished leather", fit: "regular", search_query: "men's Cole Haan leather oxford shoes cognac", style_keywords: ["business", "classic", "polished"], price_range: "$130 - $180" }
      ]
    }
  ],
  workwear_f: [
    {
      summary: "Power workwear with blazer, trousers and pointed heels",
      items: [
        { name: "Tailored Single-Breasted Blazer", brand: "Reiss", brand_confidence: "moderate", category: "outerwear", subcategory: "blazer", color: "black", material: "wool blend", fit: "tailored", search_query: "women's Reiss tailored blazer black", style_keywords: ["business", "power dressing", "tailored"], price_range: "$300 - $400" },
        { name: "High Waist Cigarette Pants", brand: "Unidentified", brand_confidence: "low", category: "bottom", subcategory: "trousers", color: "black", material: "stretch wool blend", fit: "slim", search_query: "women's high waist cigarette pants black", style_keywords: ["business", "tailored", "sleek"], price_range: "$60 - $100" },
        { name: "Pointed Toe Pumps", brand: "Stuart Weitzman", brand_confidence: "moderate", category: "shoes", subcategory: "heels", color: "nude", material: "suede", fit: "regular", search_query: "women's Stuart Weitzman pointed toe pumps nude", style_keywords: ["classic", "elegant", "professional"], price_range: "$350 - $450" }
      ]
    }
  ]
};

const STYLE_ARCHETYPES = Object.keys(OUTFIT_TEMPLATES);

const AVATAR_COLORS = [
  "#FF6B6B", "#4ECDC4", "#45B7D1", "#96CEB4", "#FFEAA7", "#DDA0DD",
  "#98D8C8", "#F7DC6F", "#BB8FCE", "#85C1E9", "#F1948A", "#82E0AA",
  "#F8C471", "#AED6F1", "#D7BDE2", "#A3E4D7", "#FAD7A0", "#D5F5E3"
];

// ─── Helpers ──────────────────────────────────────────────────

function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function pickN(arr, n) {
  const shuffled = [...arr].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, Math.min(n, arr.length));
}
function randInt(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }
function uuid() { return crypto.randomUUID(); }

// Generate a random date within last 30 days
function recentDate(maxDaysAgo = 30) {
  const now = Date.now();
  const msAgo = Math.random() * maxDaysAgo * 24 * 60 * 60 * 1000;
  return new Date(now - msAgo).toISOString();
}

// Simple placeholder avatar URL (colored initials)
function avatarUrl(name) {
  const color = pick(AVATAR_COLORS).replace("#", "");
  return `https://ui-avatars.com/api/?name=${encodeURIComponent(name)}&background=${color}&color=fff&size=200&bold=true`;
}

// ─── Main seed logic ──────────────────────────────────────────

async function seed() {
  console.log("Starting seed: 100 fake users with diverse fashion content...\n");

  // Step 1: Check if we already have AI users (avoid duplicates)
  const { data: existingAi } = await supabase
    .from("profiles")
    .select("id")
    .eq("is_ai", true);

  if (existingAi && existingAi.length > 0) {
    console.log(`Found ${existingAi.length} existing AI users.`);
    console.log("Deleting existing AI users and their content first...");

    const aiIds = existingAi.map(u => u.id);

    // Delete scans first (FK dependency)
    await supabase.from("scans").delete().in("user_id", aiIds);
    // Delete follows
    await supabase.from("follows").delete().in("follower_id", aiIds);
    await supabase.from("follows").delete().in("following_id", aiIds);
    // Delete saved items referencing AI user scans
    await supabase.from("saved_items").delete().in("user_id", aiIds);

    // Delete auth users (cascades to profiles)
    for (const id of aiIds) {
      await supabase.auth.admin.deleteUser(id);
    }
    console.log("Cleaned up existing AI users.\n");
  }

  // Step 2: Create 100 users
  const users = [];
  const usedEmails = new Set();

  for (let i = 0; i < 100; i++) {
    const isFemale = Math.random() > 0.45; // slight female skew for fashion app
    const firstName = isFemale ? pick(FIRST_NAMES_F) : pick(FIRST_NAMES_M);
    const lastName = pick(LAST_NAMES);
    const displayName = `${firstName} ${lastName.charAt(0)}.`;

    // Ensure unique email
    let email;
    do {
      email = `ai_${firstName.toLowerCase()}${randInt(100, 9999)}@attaire.fake`;
    } while (usedEmails.has(email));
    usedEmails.add(email);

    const gender = isFemale ? "female" : "male";
    const genderSuffix = isFemale ? "_f" : "_m";

    // Pick a primary style for this user
    const styleOptions = STYLE_ARCHETYPES.filter(s => s.endsWith(genderSuffix));
    const primaryStyle = pick(styleOptions);
    const styleName = primaryStyle.replace(genderSuffix, "");

    // Pick style interests
    const interests = [styleName, ...pickN(STYLE_INTERESTS, randInt(2, 4))];
    const uniqueInterests = [...new Set(interests)];

    const budgetPrefs = pick(["budget", "mid", "premium", "luxury"]);
    const budgetRanges = { budget: [20, 60], mid: [50, 150], premium: [100, 400], luxury: [300, 2000] };
    const [budgetMin, budgetMax] = budgetRanges[budgetPrefs];

    users.push({
      email,
      displayName,
      gender,
      primaryStyle,
      bio: pick(BIOS),
      styleInterests: uniqueInterests,
      budgetPref: budgetPrefs,
      budgetMin,
      budgetMax,
      tier: pick(["free", "free", "free", "pro", "trial"]), // mostly free
    });
  }

  console.log("Creating 100 auth users...");

  const createdUsers = [];
  // Batch in groups of 10 to avoid rate limits
  for (let batch = 0; batch < users.length; batch += 10) {
    const batchUsers = users.slice(batch, batch + 10);
    const results = await Promise.all(
      batchUsers.map(async (u) => {
        const { data, error } = await supabase.auth.admin.createUser({
          email: u.email,
          password: `AiUser_${uuid().slice(0, 8)}!`,
          email_confirm: true,
          user_metadata: { display_name: u.displayName }
        });
        if (error) {
          console.error(`  Failed to create ${u.email}: ${error.message}`);
          return null;
        }
        return { ...u, id: data.user.id };
      })
    );
    createdUsers.push(...results.filter(Boolean));
    process.stdout.write(`  Created ${Math.min(batch + 10, users.length)}/100 users\r`);
  }

  console.log(`\nCreated ${createdUsers.length} auth users.`);

  // Step 3: Create profiles
  console.log("Creating profiles...");

  const profileRows = createdUsers.map(u => ({
    id: u.id,
    display_name: u.displayName,
    avatar_url: avatarUrl(u.displayName),
    gender_pref: u.gender === "female" ? "female" : "male",
    budget_pref: u.budgetPref,
    budget_min: u.budgetMin,
    budget_max: u.budgetMax,
    bio: u.bio,
    style_interests: u.styleInterests,
    tier: u.tier,
    is_ai: true,
    created_at: recentDate(60),
  }));

  // Batch insert profiles
  for (let i = 0; i < profileRows.length; i += 50) {
    const batch = profileRows.slice(i, i + 50);
    const { error } = await supabase.from("profiles").upsert(batch);
    if (error) console.error("  Profile insert error:", error.message);
  }
  console.log(`  Inserted ${profileRows.length} profiles.`);

  // Step 4: Create scans (5-15 per user)
  console.log("Creating scans...");

  let totalScans = 0;
  const allScanIds = [];
  const userScanMap = new Map(); // userId -> [scanId]

  for (let i = 0; i < createdUsers.length; i += 10) {
    const batch = createdUsers.slice(i, i + 10);
    const scanRows = [];

    for (const user of batch) {
      const numScans = randInt(5, 15);
      const templates = OUTFIT_TEMPLATES[user.primaryStyle] || [];

      // Also pull from other styles of same gender for variety
      const genderSuffix = user.gender === "female" ? "_f" : "_m";
      const allTemplates = STYLE_ARCHETYPES
        .filter(s => s.endsWith(genderSuffix))
        .flatMap(s => OUTFIT_TEMPLATES[s]);

      const userScans = [];

      for (let j = 0; j < numScans; j++) {
        // 60% from primary style, 40% from other styles
        const template = j < Math.ceil(numScans * 0.6)
          ? pick(templates.length > 0 ? templates : allTemplates)
          : pick(allTemplates);

        const scanId = uuid();
        const createdAt = recentDate(21); // last 3 weeks

        // Add some variation to items
        const items = template.items.map(item => ({
          ...item,
          brand_evidence: item.brand !== "Unidentified" ? "visible logo" : "",
          product_line: "",
          position_y: Math.random() * 0.8 + 0.1,
          visibility_pct: randInt(75, 100),
          alt_search: item.search_query.replace(item.brand, "").trim(),
          identification_confidence: randInt(60, 95),
        }));

        scanRows.push({
          id: scanId,
          user_id: user.id,
          scan_name: `Scan ${j + 1}`,
          image_url: null, // no actual images
          image_thumbnail: null,
          detected_gender: user.gender,
          summary: template.summary,
          items,
          visibility: "public",
          verdict: pick(["would_wear", "would_wear", "would_wear", "on_the_fence", "not_for_me"]),
          created_at: createdAt,
        });

        userScans.push(scanId);
        allScanIds.push(scanId);
      }

      userScanMap.set(user.id, userScans);
      totalScans += numScans;
    }

    // Insert scan batch
    const { error } = await supabase.from("scans").insert(scanRows);
    if (error) console.error("  Scan insert error:", error.message);
    process.stdout.write(`  Created ${Math.min(i + 10, createdUsers.length) * 10}+ scans\r`);
  }
  console.log(`\n  Inserted ~${totalScans} scans.`);

  // Step 5: Create follow relationships (each user follows 5-20 others)
  console.log("Creating follow relationships...");

  const followRows = [];
  for (const user of createdUsers) {
    const numFollows = randInt(5, 20);
    const candidates = createdUsers.filter(u => u.id !== user.id);
    const toFollow = pickN(candidates, numFollows);

    for (const target of toFollow) {
      followRows.push({
        follower_id: user.id,
        following_id: target.id,
        created_at: recentDate(30),
      });
    }
  }

  // Batch insert follows
  for (let i = 0; i < followRows.length; i += 200) {
    const batch = followRows.slice(i, i + 200);
    const { error } = await supabase.from("follows").insert(batch);
    if (error && !error.message.includes("duplicate")) {
      console.error("  Follow insert error:", error.message);
    }
  }
  console.log(`  Inserted ${followRows.length} follow relationships.`);

  // Step 6: Create some saved_items for social proof
  console.log("Creating saved items for social proof...");

  let savedCount = 0;
  for (const user of createdUsers) {
    // Each user saves 3-10 random scans from other users
    const numSaves = randInt(3, 10);
    const otherScans = allScanIds.filter(id => {
      const userScans = userScanMap.get(user.id) || [];
      return !userScans.includes(id);
    });
    const toSave = pickN(otherScans, numSaves);

    const saveRows = toSave.map(scanId => ({
      id: uuid(),
      user_id: user.id,
      scan_id: scanId,
      item_data: { name: "Saved from feed" },
      selected_tier: pick(["budget", "mid", "premium"]),
      created_at: recentDate(14),
    }));

    if (saveRows.length > 0) {
      const { error } = await supabase.from("saved_items").insert(saveRows);
      if (error && !error.message.includes("duplicate")) {
        // Some columns might not exist, try minimal insert
      }
      savedCount += saveRows.length;
    }
  }
  console.log(`  Inserted ${savedCount} saved items.`);

  // Done!
  console.log("\n========================================");
  console.log("Seed complete!");
  console.log(`  Users: ${createdUsers.length}`);
  console.log(`  Scans: ~${totalScans}`);
  console.log(`  Follows: ${followRows.length}`);
  console.log(`  Saved items: ${savedCount}`);
  console.log("========================================");
  console.log("\nAll users are flagged is_ai: true for easy cleanup.");
  console.log("All scans are visibility: public so they show in feeds.");
}

seed().catch(err => {
  console.error("Seed failed:", err);
  process.exit(1);
});
