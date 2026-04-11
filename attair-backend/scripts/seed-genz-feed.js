#!/usr/bin/env node
/**
 * Seed the feed with Gen Z brand-heavy outfit content.
 * Creates AI accounts + diverse scans featuring target brands.
 *
 * Usage: node scripts/seed-genz-feed.js [count]
 *   count: number of scans to create (default 500)
 *
 * Target brands: Adanola, Skims, Faherty, Marine Layer, Salomon,
 * Aritzia, Zara, Banana Republic, Princess Polly, Nordstrom, COS,
 * Lululemon, Adidas, Revolve, Free People, White Fox, Oh Polly,
 * Vuori, Nike, New Balance, Alo Yoga, Gymshark, Abercrombie,
 * Reformation, Sandro, Maje, AllSaints, Reiss, Massimo Dutti
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

const COUNT = parseInt(process.argv[2]) || 500;

// ─── Unsplash outfit photos (curated for fashion) ──────────────
const PHOTOS = [
  "photo-1617137968427-85924c800a22", "photo-1515886657613-9f3515b0c78f",
  "photo-1509631179647-0177331693ae", "photo-1552374196-1ab2a1c593e8",
  "photo-1469334031218-e382a71b716b", "photo-1534030347209-467a5b0ad3e6",
  "photo-1529139574466-a303027c1d8b", "photo-1490481651871-ab68de25d43d",
  "photo-1518577915332-c2a19f149a75", "photo-1507003211169-0a1dd7228f2d",
  "photo-1485462537746-965f33f7f6a7", "photo-1550639525-c97d455acf70",
  "photo-1492707892479-7bc8d5a4ee93", "photo-1515886657613-9f3515b0c78f",
  "photo-1571945153237-4929e783af4a", "photo-1517941823-815bea90d291",
  "photo-1548883354-94bcfe321cbb", "photo-1516826957135-700dedea698c",
  "photo-1506794778202-cad84cf45f1d", "photo-1580657018950-c7f7d6a6d990",
  "photo-1535295972055-1c762f4483e5", "photo-1533808510650-6b0e2e8e9f41",
  "photo-1485462537746-965f33f7f6a7", "photo-1492707892479-7bc8d5a4ee93",
  "photo-1469334031218-e382a71b716b", "photo-1550639525-c97d455acf70",
];
const photoUrl = (id) => `https://images.unsplash.com/${id}?w=600&h=800&fit=crop&crop=center`;

// ─── Name pools ────────────────────────────────────────────────
const NAMES_F = ["Aaliyah","Bella","Carmen","Deja","Elena","Fatima","Grace","Hana","Iris","Jade","Kaia","Luna","Maya","Nia","Olivia","Priya","Quinn","Rosa","Suki","Talia","Uma","Violet","Winnie","Yara","Zara","Amara","Bianca","Chloe","Diana","Emiko","Freya","Gigi","Harper","Ines","Jada","Keiko","Leila","Mika","Noor","Paloma","Raven","Sasha","Tiana","Valentina","Willow","Yuki","Aria","Sage","Sloane","Margot","Piper","Riley","Zoe","Stella","Penelope","Wren"];
const NAMES_M = ["Aiden","Blake","Carlos","Dante","Ethan","Felix","Grant","Hugo","Isaac","Jaden","Kai","Liam","Marcus","Nico","Orion","Phoenix","Quincy","Rafael","Soren","Tyler","Uriel","Victor","Wyatt","Xavier","Zayn","Archer","Brooks","Caleb","Diego","Emerson","Finn","Grayson","Hudson","Ivan","Jasper","Knox","Leo","Miles","Nash","Oliver","Parker","Reed","Sebastian","Theo","Vaughn","Wells"];
const LAST = ["A","B","C","D","E","F","G","H","I","J","K","L","M","N","O","P","Q","R","S","T","U","V","W","X","Y","Z"];

// ─── Outfit templates with Gen Z brands ────────────────────────
const OUTFITS = [
  // ═══ ATHLEISURE / ACTIVEWEAR ═══
  { g: "female", summary: "Pilates-to-brunch fit with matching set and clean sneakers", items: [
    { name: "Sculpt Seamless Sports Bra", brand: "Adanola", brand_confidence: "high", category: "top", subcategory: "sports bra", color: "mocha", material: "nylon spandex seamless knit", fit: "fitted", search_query: "women's Adanola seamless sports bra mocha", style_keywords: ["athleisure", "pilates", "minimal"], price_range: "$40 - $55" },
    { name: "High Rise Flared Leggings", brand: "Adanola", brand_confidence: "high", category: "bottom", subcategory: "leggings", color: "mocha", material: "nylon spandex", fit: "fitted", search_query: "women's Adanola high rise flared leggings mocha", style_keywords: ["athleisure", "matching set", "flare"], price_range: "$50 - $65" },
    { name: "Retro Low-Top Sneakers", brand: "New Balance", brand_confidence: "confirmed", category: "shoes", subcategory: "sneakers", color: "white grey", material: "leather suede", fit: "regular", search_query: "women's New Balance 550 white grey sneakers", style_keywords: ["retro", "clean", "casual"], price_range: "$110 - $120" },
  ]},
  { g: "female", summary: "Hot girl walk outfit with oversized hoodie and bike shorts", items: [
    { name: "Oversized Cotton Hoodie", brand: "Skims", brand_confidence: "high", category: "top", subcategory: "hoodie", color: "bone", material: "heavyweight cotton fleece", fit: "oversized", search_query: "women's Skims oversized cotton hoodie bone", style_keywords: ["cozy", "oversized", "neutral"], price_range: "$78 - $98" },
    { name: "Bike Shorts", brand: "Skims", brand_confidence: "high", category: "bottom", subcategory: "shorts", color: "onyx", material: "nylon spandex", fit: "fitted", search_query: "women's Skims bike shorts black", style_keywords: ["athleisure", "minimal", "basics"], price_range: "$32 - $42" },
    { name: "Cloud Slide Sandals", brand: "Lululemon", brand_confidence: "moderate", category: "shoes", subcategory: "slides", color: "white", material: "EVA foam", fit: "regular", search_query: "women's Lululemon Restfeel slide white", style_keywords: ["comfort", "clean", "recovery"], price_range: "$48 - $58" },
  ]},
  { g: "female", summary: "Yoga class to coffee run in buttery soft layers", items: [
    { name: "Align High-Neck Tank", brand: "Lululemon", brand_confidence: "confirmed", category: "top", subcategory: "tank top", color: "smoked spruce", material: "Nulu fabric", fit: "fitted", search_query: "women's Lululemon Align tank top smoked spruce", style_keywords: ["yoga", "athleisure", "performance"], price_range: "$58 - $68" },
    { name: "High Rise Jogger", brand: "Vuori", brand_confidence: "high", category: "bottom", subcategory: "joggers", color: "heather grey", material: "DreamKnit fabric", fit: "relaxed", search_query: "women's Vuori Performance jogger grey", style_keywords: ["comfort", "athleisure", "casual"], price_range: "$84 - $98" },
    { name: "Ultraboost Running Shoes", brand: "Adidas", brand_confidence: "confirmed", category: "shoes", subcategory: "sneakers", color: "cloud white", material: "Primeknit", fit: "regular", search_query: "women's Adidas Ultraboost cloud white", style_keywords: ["performance", "clean", "running"], price_range: "$180 - $200" },
  ]},
  { g: "male", summary: "Gym-to-street in performance basics and trail runners", items: [
    { name: "Metal Vent Tech Polo", brand: "Lululemon", brand_confidence: "confirmed", category: "top", subcategory: "polo", color: "true navy", material: "silverescent nylon", fit: "slim", search_query: "men's Lululemon Metal Vent Tech polo navy", style_keywords: ["performance", "clean", "athleisure"], price_range: "$88 - $98" },
    { name: "ABC Jogger", brand: "Lululemon", brand_confidence: "confirmed", category: "bottom", subcategory: "joggers", color: "obsidian", material: "Warpstreme fabric", fit: "slim", search_query: "men's Lululemon ABC jogger obsidian", style_keywords: ["athleisure", "versatile", "commute"], price_range: "$118 - $128" },
    { name: "XT-6 Trail Sneakers", brand: "Salomon", brand_confidence: "confirmed", category: "shoes", subcategory: "sneakers", color: "vanilla ice", material: "mesh rubber", fit: "regular", search_query: "men's Salomon XT-6 vanilla ice sneakers", style_keywords: ["gorpcore", "trail", "technical"], price_range: "$180 - $200" },
  ]},
  { g: "male", summary: "Weekend warrior fit with soft layers and earth tones", items: [
    { name: "Strato Tech Tee", brand: "Vuori", brand_confidence: "high", category: "top", subcategory: "t-shirt", color: "sage heather", material: "recycled polyester", fit: "regular", search_query: "men's Vuori Strato Tech tee sage", style_keywords: ["active", "eco", "casual"], price_range: "$54 - $64" },
    { name: "Kore Shorts", brand: "Vuori", brand_confidence: "high", category: "bottom", subcategory: "shorts", color: "charcoal", material: "4-way stretch", fit: "regular", search_query: "men's Vuori Kore short charcoal", style_keywords: ["athletic", "versatile", "weekend"], price_range: "$68 - $78" },
    { name: "Speedcross Trail Shoes", brand: "Salomon", brand_confidence: "confirmed", category: "shoes", subcategory: "sneakers", color: "black phantom", material: "mesh Contagrip", fit: "regular", search_query: "men's Salomon Speedcross 6 black", style_keywords: ["trail", "gorpcore", "performance"], price_range: "$140 - $160" },
  ]},

  // ═══ GOING OUT / NIGHT ═══
  { g: "female", summary: "Girls night out with bodycon dress and strappy heels", items: [
    { name: "Ruched Mesh Bodycon Dress", brand: "Oh Polly", brand_confidence: "high", category: "dress", subcategory: "bodycon dress", color: "chocolate brown", material: "stretch mesh", fit: "fitted", search_query: "women's Oh Polly ruched mesh bodycon dress brown", style_keywords: ["going out", "bodycon", "sexy"], price_range: "$60 - $80" },
    { name: "Strappy Heeled Sandals", brand: "Zara", brand_confidence: "moderate", category: "shoes", subcategory: "heels", color: "black", material: "faux leather", fit: "regular", search_query: "women's Zara strappy heeled sandals black", style_keywords: ["night out", "elegant", "minimal"], price_range: "$50 - $70" },
    { name: "Mini Shoulder Bag", brand: "Zara", brand_confidence: "moderate", category: "bag", subcategory: "shoulder bag", color: "silver", material: "metallic faux leather", fit: "standard", search_query: "women's Zara mini shoulder bag silver", style_keywords: ["going out", "statement", "metallic"], price_range: "$30 - $45" },
  ]},
  { g: "female", summary: "Date night satin set with gold accessories", items: [
    { name: "Satin Cowl Neck Top", brand: "Princess Polly", brand_confidence: "high", category: "top", subcategory: "blouse", color: "champagne", material: "satin polyester", fit: "relaxed", search_query: "women's Princess Polly satin cowl neck top champagne", style_keywords: ["date night", "romantic", "elevated"], price_range: "$40 - $55" },
    { name: "Satin Midi Skirt", brand: "Princess Polly", brand_confidence: "high", category: "bottom", subcategory: "skirt", color: "champagne", material: "satin polyester", fit: "slim", search_query: "women's Princess Polly satin midi skirt champagne", style_keywords: ["matching set", "elevated", "feminine"], price_range: "$45 - $60" },
    { name: "Strappy Block Heels", brand: "Revolve", brand_confidence: "moderate", category: "shoes", subcategory: "heels", color: "nude", material: "leather", fit: "regular", search_query: "women's block heel strappy sandals nude", style_keywords: ["elegant", "date night", "classic"], price_range: "$80 - $120" },
  ]},
  { g: "female", summary: "Festival ready with crochet top and wide leg pants", items: [
    { name: "Crochet Halter Top", brand: "Free People", brand_confidence: "high", category: "top", subcategory: "halter top", color: "cream", material: "cotton crochet", fit: "cropped", search_query: "women's Free People crochet halter top cream", style_keywords: ["boho", "festival", "handmade"], price_range: "$48 - $68" },
    { name: "Linen Wide Leg Pants", brand: "Free People", brand_confidence: "high", category: "bottom", subcategory: "wide leg pants", color: "natural", material: "linen blend", fit: "relaxed", search_query: "women's Free People linen wide leg pants natural", style_keywords: ["boho", "flowy", "relaxed"], price_range: "$78 - $98" },
    { name: "Leather Platform Sandals", brand: "Free People", brand_confidence: "moderate", category: "shoes", subcategory: "sandals", color: "tan", material: "leather", fit: "regular", search_query: "women's Free People platform sandals tan", style_keywords: ["boho", "platform", "summer"], price_range: "$128 - $168" },
  ]},

  // ═══ SMART CASUAL / EVERYDAY ═══
  { g: "female", summary: "Effortless Aritzia fit with oversized blazer and trousers", items: [
    { name: "Oversized Wool Blazer", brand: "Aritzia", brand_confidence: "high", category: "outerwear", subcategory: "blazer", color: "heather oat", material: "wool blend", fit: "oversized", search_query: "women's Aritzia Wilfred oversized blazer oat", style_keywords: ["minimal", "oversized", "smart casual"], price_range: "$168 - $228" },
    { name: "Sculpt Knit Tank", brand: "Aritzia", brand_confidence: "high", category: "top", subcategory: "tank top", color: "white", material: "ribbed knit", fit: "fitted", search_query: "women's Aritzia Babaton sculpt knit tank white", style_keywords: ["minimal", "basics", "layering"], price_range: "$38 - $48" },
    { name: "Effortless Trouser", brand: "Aritzia", brand_confidence: "high", category: "bottom", subcategory: "trousers", color: "black", material: "crepe", fit: "relaxed", search_query: "women's Aritzia Effortless trouser black", style_keywords: ["workwear", "elevated", "clean"], price_range: "$110 - $148" },
  ]},
  { g: "female", summary: "White Fox basics with clean lines and neutral palette", items: [
    { name: "Oversized Crewneck Sweatshirt", brand: "White Fox", brand_confidence: "high", category: "top", subcategory: "sweatshirt", color: "cloud grey", material: "cotton fleece", fit: "oversized", search_query: "women's White Fox oversized crewneck sweatshirt grey", style_keywords: ["loungewear", "oversized", "cozy"], price_range: "$55 - $75" },
    { name: "Straight Leg Sweatpants", brand: "White Fox", brand_confidence: "high", category: "bottom", subcategory: "sweatpants", color: "cloud grey", material: "cotton fleece", fit: "straight", search_query: "women's White Fox straight leg sweatpants grey", style_keywords: ["matching set", "loungewear", "clean"], price_range: "$55 - $75" },
    { name: "Platform Sneakers", brand: "Adidas", brand_confidence: "confirmed", category: "shoes", subcategory: "sneakers", color: "white", material: "leather", fit: "regular", search_query: "women's Adidas Samba platform white sneakers", style_keywords: ["classic", "platform", "trending"], price_range: "$120 - $130" },
  ]},
  { g: "male", summary: "Coastal California vibes with linen and leather sandals", items: [
    { name: "Linen Camp Collar Shirt", brand: "Marine Layer", brand_confidence: "high", category: "top", subcategory: "shirt", color: "faded indigo", material: "linen cotton blend", fit: "relaxed", search_query: "men's Marine Layer linen camp collar shirt indigo", style_keywords: ["coastal", "relaxed", "summer"], price_range: "$78 - $98" },
    { name: "Relaxed Chino Shorts", brand: "Faherty", brand_confidence: "high", category: "bottom", subcategory: "shorts", color: "stone", material: "organic cotton twill", fit: "relaxed", search_query: "men's Faherty All Day shorts stone", style_keywords: ["coastal", "sustainable", "casual"], price_range: "$88 - $108" },
    { name: "Leather Slide Sandals", brand: "Banana Republic", brand_confidence: "moderate", category: "shoes", subcategory: "sandals", color: "cognac", material: "leather", fit: "regular", search_query: "men's leather slide sandals cognac", style_keywords: ["summer", "elevated", "casual"], price_range: "$60 - $80" },
  ]},
  { g: "male", summary: "Elevated basics with premium cotton and Italian leather", items: [
    { name: "Heavyweight Cotton Tee", brand: "COS", brand_confidence: "high", category: "top", subcategory: "t-shirt", color: "off white", material: "heavyweight organic cotton", fit: "regular", search_query: "men's COS heavyweight cotton t-shirt off white", style_keywords: ["minimalist", "quality", "basics"], price_range: "$35 - $49" },
    { name: "Relaxed Wool Trousers", brand: "COS", brand_confidence: "high", category: "bottom", subcategory: "trousers", color: "dark navy", material: "wool blend", fit: "relaxed", search_query: "men's COS relaxed wool trousers navy", style_keywords: ["minimalist", "tailored", "scandi"], price_range: "$89 - $135" },
    { name: "Suede Loafers", brand: "Massimo Dutti", brand_confidence: "moderate", category: "shoes", subcategory: "loafers", color: "tan suede", material: "suede leather", fit: "regular", search_query: "men's Massimo Dutti suede loafers tan", style_keywords: ["classic", "refined", "smart casual"], price_range: "$100 - $140" },
  ]},

  // ═══ REFORMATION / SUSTAINABLE ═══
  { g: "female", summary: "Sustainable chic with fitted midi and platform boots", items: [
    { name: "Carina Midi Dress", brand: "Reformation", brand_confidence: "high", category: "dress", subcategory: "midi dress", color: "black", material: "Tencel lyocell", fit: "fitted", search_query: "women's Reformation Carina midi dress black", style_keywords: ["sustainable", "elegant", "fitted"], price_range: "$178 - $248" },
    { name: "Leather Ankle Boots", brand: "Zara", brand_confidence: "moderate", category: "shoes", subcategory: "boots", color: "black", material: "genuine leather", fit: "regular", search_query: "women's Zara leather ankle boots black", style_keywords: ["classic", "versatile", "edgy"], price_range: "$80 - $130" },
    { name: "Gold Chain Necklace", brand: "Unidentified", brand_confidence: "low", category: "accessory", subcategory: "necklace", color: "gold", material: "gold plated", fit: "standard", search_query: "women's layered gold chain necklace", style_keywords: ["jewelry", "layered", "minimal"], price_range: "$25 - $60" },
  ]},

  // ═══ ABERCROMBIE / CASUAL ═══
  { g: "female", summary: "Clean girl aesthetic with tailored pieces and neutral tones", items: [
    { name: "Tailored Linen Vest", brand: "Abercrombie", brand_confidence: "high", category: "top", subcategory: "vest", color: "cream", material: "linen blend", fit: "tailored", search_query: "women's Abercrombie tailored linen vest cream", style_keywords: ["clean girl", "tailored", "minimal"], price_range: "$60 - $80" },
    { name: "Wide Leg Linen Pants", brand: "Abercrombie", brand_confidence: "high", category: "bottom", subcategory: "wide leg pants", color: "cream", material: "linen blend", fit: "relaxed", search_query: "women's Abercrombie wide leg linen pants cream", style_keywords: ["matching set", "summer", "clean"], price_range: "$70 - $90" },
    { name: "Leather Slingback Flats", brand: "Zara", brand_confidence: "moderate", category: "shoes", subcategory: "flats", color: "black", material: "leather", fit: "regular", search_query: "women's Zara leather slingback flats black", style_keywords: ["classic", "elegant", "quiet luxury"], price_range: "$50 - $70" },
  ]},
  { g: "male", summary: "Relaxed weekend look with premium denim and camp shirt", items: [
    { name: "Camp Collar Resort Shirt", brand: "Abercrombie", brand_confidence: "high", category: "top", subcategory: "shirt", color: "navy print", material: "viscose", fit: "relaxed", search_query: "men's Abercrombie camp collar shirt navy print", style_keywords: ["resort", "relaxed", "vacation"], price_range: "$60 - $80" },
    { name: "Athletic Slim Jeans", brand: "Abercrombie", brand_confidence: "high", category: "bottom", subcategory: "jeans", color: "medium wash", material: "stretch denim", fit: "slim", search_query: "men's Abercrombie athletic slim jeans medium wash", style_keywords: ["casual", "everyday", "fitted"], price_range: "$80 - $100" },
    { name: "Classic Leather Sneakers", brand: "Adidas", brand_confidence: "confirmed", category: "shoes", subcategory: "sneakers", color: "white green", material: "leather", fit: "regular", search_query: "men's Adidas Stan Smith white green sneakers", style_keywords: ["classic", "clean", "iconic"], price_range: "$90 - $100" },
  ]},

  // ═══ ALLSAINTS / REISS / ELEVATED ═══
  { g: "male", summary: "Dark layered look with leather jacket and combat boots", items: [
    { name: "Leather Biker Jacket", brand: "AllSaints", brand_confidence: "high", category: "outerwear", subcategory: "jacket", color: "black", material: "lamb leather", fit: "slim", search_query: "men's AllSaints leather biker jacket black", style_keywords: ["edgy", "rock", "statement"], price_range: "$400 - $500" },
    { name: "Slim Crew Neck Tee", brand: "AllSaints", brand_confidence: "high", category: "top", subcategory: "t-shirt", color: "jet black", material: "cotton jersey", fit: "slim", search_query: "men's AllSaints Tonic crew tee black", style_keywords: ["basics", "slim", "essential"], price_range: "$45 - $65" },
    { name: "Skinny Jeans", brand: "AllSaints", brand_confidence: "moderate", category: "bottom", subcategory: "jeans", color: "washed black", material: "stretch denim", fit: "skinny", search_query: "men's AllSaints skinny jeans washed black", style_keywords: ["edgy", "fitted", "rock"], price_range: "$130 - $180" },
  ]},
  { g: "male", summary: "Power workwear with structured blazer and tailored trousers", items: [
    { name: "Double Breasted Blazer", brand: "Reiss", brand_confidence: "high", category: "outerwear", subcategory: "blazer", color: "navy", material: "wool blend", fit: "tailored", search_query: "men's Reiss double breasted blazer navy", style_keywords: ["power dressing", "tailored", "sharp"], price_range: "$350 - $470" },
    { name: "Slim Fit Shirt", brand: "Reiss", brand_confidence: "high", category: "top", subcategory: "dress shirt", color: "white", material: "cotton poplin", fit: "slim", search_query: "men's Reiss slim fit cotton shirt white", style_keywords: ["sharp", "business", "essential"], price_range: "$130 - $180" },
    { name: "Tailored Trousers", brand: "Reiss", brand_confidence: "high", category: "bottom", subcategory: "trousers", color: "navy", material: "wool blend", fit: "tailored", search_query: "men's Reiss tailored trousers navy", style_keywords: ["workwear", "structured", "classic"], price_range: "$180 - $250" },
  ]},

  // ═══ SANDRO / MAJE / FRENCH ═══
  { g: "female", summary: "Parisian chic with tweed jacket and pleated skirt", items: [
    { name: "Tweed Cropped Jacket", brand: "Sandro", brand_confidence: "high", category: "outerwear", subcategory: "jacket", color: "ecru pink", material: "tweed", fit: "cropped", search_query: "women's Sandro tweed cropped jacket ecru pink", style_keywords: ["french", "chic", "structured"], price_range: "$400 - $595" },
    { name: "Pleated Midi Skirt", brand: "Maje", brand_confidence: "high", category: "bottom", subcategory: "skirt", color: "black", material: "polyester blend", fit: "regular", search_query: "women's Maje pleated midi skirt black", style_keywords: ["french", "feminine", "elegant"], price_range: "$250 - $350" },
    { name: "Pointed Toe Slingbacks", brand: "Sandro", brand_confidence: "moderate", category: "shoes", subcategory: "heels", color: "nude", material: "leather", fit: "regular", search_query: "women's Sandro pointed slingback heels nude", style_keywords: ["french", "classic", "refined"], price_range: "$280 - $395" },
  ]},

  // ═══ GYMSHARK / GYM ═══
  { g: "male", summary: "Gym essentials with performance fit and bold branding", items: [
    { name: "Seamless T-Shirt", brand: "Gymshark", brand_confidence: "confirmed", category: "top", subcategory: "t-shirt", color: "navy", material: "nylon spandex seamless", fit: "fitted", search_query: "men's Gymshark Vital seamless tee navy", style_keywords: ["gym", "performance", "fitted"], price_range: "$30 - $40" },
    { name: "Apex Shorts", brand: "Gymshark", brand_confidence: "confirmed", category: "bottom", subcategory: "shorts", color: "black", material: "polyester mesh", fit: "regular", search_query: "men's Gymshark Apex shorts black", style_keywords: ["gym", "training", "performance"], price_range: "$30 - $42" },
    { name: "Training Shoes", brand: "Nike", brand_confidence: "confirmed", category: "shoes", subcategory: "sneakers", color: "black volt", material: "mesh Flyknit", fit: "regular", search_query: "men's Nike Metcon 9 black training shoes", style_keywords: ["training", "crossfit", "performance"], price_range: "$130 - $150" },
  ]},
  { g: "female", summary: "Gym to errands in sculpted leggings and crop", items: [
    { name: "Vital Seamless Crop Top", brand: "Gymshark", brand_confidence: "confirmed", category: "top", subcategory: "crop top", color: "dusty rose", material: "nylon spandex", fit: "cropped", search_query: "women's Gymshark Vital seamless crop top pink", style_keywords: ["gym", "seamless", "feminine"], price_range: "$30 - $38" },
    { name: "Adapt Camo Leggings", brand: "Gymshark", brand_confidence: "confirmed", category: "bottom", subcategory: "leggings", color: "grey camo", material: "nylon spandex", fit: "fitted", search_query: "women's Gymshark Adapt camo leggings grey", style_keywords: ["gym", "camo", "performance"], price_range: "$50 - $60" },
    { name: "Cloud Running Shoes", brand: "Adidas", brand_confidence: "confirmed", category: "shoes", subcategory: "sneakers", color: "white pink", material: "mesh Boost", fit: "regular", search_query: "women's Adidas Ultraboost Light white pink", style_keywords: ["running", "performance", "cushioned"], price_range: "$180 - $200" },
  ]},

  // ═══ ALO YOGA ═══
  { g: "female", summary: "Studio to street in luxe yoga layers", items: [
    { name: "Airbrush Real Bra Tank", brand: "Alo Yoga", brand_confidence: "confirmed", category: "top", subcategory: "tank top", color: "espresso", material: "Airbrush fabric", fit: "fitted", search_query: "women's Alo Yoga Airbrush tank espresso", style_keywords: ["yoga", "luxe", "studio"], price_range: "$62 - $72" },
    { name: "High Waist Airlift Legging", brand: "Alo Yoga", brand_confidence: "confirmed", category: "bottom", subcategory: "leggings", color: "espresso", material: "Airlift fabric", fit: "fitted", search_query: "women's Alo Yoga Airlift legging espresso", style_keywords: ["yoga", "luxe", "performance"], price_range: "$108 - $128" },
    { name: "Oversized Sherpa Half Zip", brand: "Alo Yoga", brand_confidence: "high", category: "outerwear", subcategory: "pullover", color: "ivory", material: "sherpa fleece", fit: "oversized", search_query: "women's Alo Yoga sherpa half zip ivory", style_keywords: ["cozy", "luxe", "apres"], price_range: "$188 - $228" },
  ]},

  // ═══ MORE MALE — SNEAKERHEAD / STREETWEAR ═══
  { g: "male", summary: "Sneakerhead fit with premium kicks and minimalist layers", items: [
    { name: "Oversized Washed Tee", brand: "Zara", brand_confidence: "moderate", category: "top", subcategory: "t-shirt", color: "washed black", material: "cotton jersey", fit: "oversized", search_query: "men's Zara oversized washed tee black", style_keywords: ["streetwear", "oversized", "minimal"], price_range: "$20 - $30" },
    { name: "Relaxed Cargo Pants", brand: "Zara", brand_confidence: "moderate", category: "bottom", subcategory: "cargo pants", color: "khaki", material: "cotton twill", fit: "relaxed", search_query: "men's Zara relaxed cargo pants khaki", style_keywords: ["utility", "streetwear", "relaxed"], price_range: "$40 - $55" },
    { name: "Air Jordan 4 Retro", brand: "Nike", brand_confidence: "confirmed", category: "shoes", subcategory: "sneakers", color: "white cement", material: "leather suede", fit: "regular", search_query: "men's Nike Air Jordan 4 Retro white cement", style_keywords: ["sneakerhead", "iconic", "hype"], price_range: "$200 - $220" },
  ]},
  { g: "male", summary: "Minimalist earth tones with premium denim and suede boots", items: [
    { name: "Merino Crew Sweater", brand: "COS", brand_confidence: "high", category: "top", subcategory: "sweater", color: "camel", material: "merino wool", fit: "regular", search_query: "men's COS merino wool crew sweater camel", style_keywords: ["minimalist", "quality", "scandi"], price_range: "$69 - $99" },
    { name: "Slim Tapered Jeans", brand: "Zara", brand_confidence: "moderate", category: "bottom", subcategory: "jeans", color: "dark indigo", material: "stretch selvedge denim", fit: "slim", search_query: "men's Zara slim tapered jeans dark indigo", style_keywords: ["minimal", "classic", "fitted"], price_range: "$40 - $55" },
    { name: "Suede Chelsea Boots", brand: "Massimo Dutti", brand_confidence: "high", category: "shoes", subcategory: "boots", color: "tan suede", material: "suede leather", fit: "regular", search_query: "men's Massimo Dutti suede Chelsea boots tan", style_keywords: ["smart casual", "refined", "versatile"], price_range: "$120 - $180" },
  ]},
  { g: "male", summary: "Tech bro essentials with quarter-zip and joggers", items: [
    { name: "Better Sweater Quarter Zip", brand: "Faherty", brand_confidence: "high", category: "outerwear", subcategory: "pullover", color: "charcoal heather", material: "organic cotton fleece", fit: "regular", search_query: "men's Faherty quarter zip pullover charcoal", style_keywords: ["casual", "sustainable", "cozy"], price_range: "$128 - $158" },
    { name: "Sunday Performance Jogger", brand: "Vuori", brand_confidence: "high", category: "bottom", subcategory: "joggers", color: "black", material: "DreamKnit", fit: "slim", search_query: "men's Vuori Sunday Performance jogger black", style_keywords: ["athleisure", "WFH", "comfort"], price_range: "$84 - $98" },
    { name: "990v6 Running Shoes", brand: "New Balance", brand_confidence: "confirmed", category: "shoes", subcategory: "sneakers", color: "grey", material: "suede mesh ENCAP", fit: "regular", search_query: "men's New Balance 990v6 grey sneakers", style_keywords: ["dad shoe", "heritage", "quality"], price_range: "$200 - $220" },
  ]},
  { g: "male", summary: "Summer resort with linen shirt and espadrilles", items: [
    { name: "100% Linen Band Collar Shirt", brand: "Banana Republic", brand_confidence: "high", category: "top", subcategory: "shirt", color: "white", material: "100% linen", fit: "regular", search_query: "men's Banana Republic linen band collar shirt white", style_keywords: ["resort", "summer", "clean"], price_range: "$70 - $90" },
    { name: "Linen Drawstring Pants", brand: "Banana Republic", brand_confidence: "high", category: "bottom", subcategory: "trousers", color: "natural", material: "linen", fit: "relaxed", search_query: "men's Banana Republic linen drawstring pants natural", style_keywords: ["resort", "relaxed", "summer"], price_range: "$80 - $100" },
    { name: "Suede Espadrilles", brand: "Massimo Dutti", brand_confidence: "moderate", category: "shoes", subcategory: "espadrilles", color: "navy", material: "suede jute", fit: "regular", search_query: "men's Massimo Dutti suede espadrilles navy", style_keywords: ["summer", "mediterranean", "relaxed"], price_range: "$80 - $110" },
  ]},
  { g: "male", summary: "Gorpcore hiker fit with technical layers", items: [
    { name: "Windbreaker Shell Jacket", brand: "Salomon", brand_confidence: "high", category: "outerwear", subcategory: "jacket", color: "olive black", material: "nylon ripstop", fit: "regular", search_query: "men's Salomon Bonatti windbreaker jacket olive", style_keywords: ["gorpcore", "trail", "technical"], price_range: "$160 - $200" },
    { name: "Hiking Cargo Shorts", brand: "Vuori", brand_confidence: "moderate", category: "bottom", subcategory: "shorts", color: "dark earth", material: "ripstop nylon", fit: "regular", search_query: "men's Vuori Trail short dark earth", style_keywords: ["outdoor", "technical", "hiking"], price_range: "$68 - $82" },
    { name: "X Ultra 4 GTX Hiking Shoes", brand: "Salomon", brand_confidence: "confirmed", category: "shoes", subcategory: "hiking shoes", color: "pewter black", material: "Gore-Tex mesh", fit: "regular", search_query: "men's Salomon X Ultra 4 GTX hiking shoes", style_keywords: ["hiking", "waterproof", "trail"], price_range: "$140 - $170" },
  ]},
  { g: "male", summary: "Classic Americana with premium basics and white sneakers", items: [
    { name: "Heavyweight Pocket Tee", brand: "Marine Layer", brand_confidence: "high", category: "top", subcategory: "t-shirt", color: "faded navy", material: "signature soft cotton", fit: "regular", search_query: "men's Marine Layer signature crew tee navy", style_keywords: ["americana", "soft", "quality"], price_range: "$42 - $52" },
    { name: "Slim Straight Chinos", brand: "Banana Republic", brand_confidence: "high", category: "bottom", subcategory: "chinos", color: "dark khaki", material: "stretch cotton twill", fit: "slim", search_query: "men's Banana Republic slim straight chinos khaki", style_keywords: ["classic", "versatile", "clean"], price_range: "$70 - $90" },
    { name: "Court Classic Sneakers", brand: "Adidas", brand_confidence: "confirmed", category: "shoes", subcategory: "sneakers", color: "white gum", material: "leather gum sole", fit: "regular", search_query: "men's Adidas Stan Smith white gum sneakers", style_keywords: ["classic", "clean", "timeless"], price_range: "$90 - $100" },
  ]},
  { g: "male", summary: "Date night sharp casual with knit polo and loafers", items: [
    { name: "Textured Knit Polo", brand: "Reiss", brand_confidence: "high", category: "top", subcategory: "polo", color: "sage", material: "cotton knit", fit: "slim", search_query: "men's Reiss textured knit polo sage", style_keywords: ["smart casual", "date night", "refined"], price_range: "$130 - $170" },
    { name: "Tailored Slim Trousers", brand: "Massimo Dutti", brand_confidence: "high", category: "bottom", subcategory: "trousers", color: "navy", material: "cotton blend", fit: "slim", search_query: "men's Massimo Dutti slim tailored trousers navy", style_keywords: ["tailored", "smart", "classic"], price_range: "$80 - $110" },
    { name: "Leather Penny Loafers", brand: "Banana Republic", brand_confidence: "moderate", category: "shoes", subcategory: "loafers", color: "dark brown", material: "leather", fit: "regular", search_query: "men's leather penny loafers dark brown", style_keywords: ["classic", "preppy", "refined"], price_range: "$100 - $150" },
  ]},

  // ═══ MORE FEMALE — DIVERSE STYLES ═══
  { g: "female", summary: "Coastal grandmother aesthetic with linen and woven accessories", items: [
    { name: "Oversized Linen Button Down", brand: "Faherty", brand_confidence: "high", category: "top", subcategory: "shirt", color: "white", material: "organic linen", fit: "oversized", search_query: "women's Faherty oversized linen shirt white", style_keywords: ["coastal", "effortless", "sustainable"], price_range: "$118 - $148" },
    { name: "Wide Leg Linen Pants", brand: "Aritzia", brand_confidence: "high", category: "bottom", subcategory: "wide leg pants", color: "flax", material: "linen blend", fit: "relaxed", search_query: "women's Aritzia wide leg linen pants flax", style_keywords: ["coastal", "relaxed", "summer"], price_range: "$88 - $118" },
    { name: "Woven Slide Sandals", brand: "Zara", brand_confidence: "moderate", category: "shoes", subcategory: "sandals", color: "natural", material: "woven leather", fit: "regular", search_query: "women's Zara woven leather slide sandals natural", style_keywords: ["summer", "artisan", "minimal"], price_range: "$50 - $70" },
  ]},
  { g: "female", summary: "Old money tennis club look with pleated skirt and polo", items: [
    { name: "Cable Knit Polo Sweater", brand: "Banana Republic", brand_confidence: "high", category: "top", subcategory: "polo", color: "cream", material: "cotton cable knit", fit: "regular", search_query: "women's Banana Republic cable knit polo cream", style_keywords: ["old money", "preppy", "classic"], price_range: "$70 - $90" },
    { name: "Pleated Tennis Skirt", brand: "Aritzia", brand_confidence: "high", category: "bottom", subcategory: "skirt", color: "white", material: "woven cotton", fit: "regular", search_query: "women's Aritzia pleated tennis skirt white", style_keywords: ["preppy", "sporty", "classic"], price_range: "$58 - $78" },
    { name: "Classic Leather Sneakers", brand: "Adidas", brand_confidence: "confirmed", category: "shoes", subcategory: "sneakers", color: "white green", material: "leather", fit: "regular", search_query: "women's Adidas Stan Smith white green", style_keywords: ["classic", "tennis", "clean"], price_range: "$90 - $100" },
  ]},
  { g: "female", summary: "Brunch-ready with midi dress and chunky sandals", items: [
    { name: "Smocked Floral Midi Dress", brand: "Free People", brand_confidence: "high", category: "dress", subcategory: "midi dress", color: "sage floral", material: "cotton voile", fit: "relaxed", search_query: "women's Free People smocked floral midi dress sage", style_keywords: ["boho", "feminine", "brunch"], price_range: "$128 - $168" },
    { name: "Chunky Platform Sandals", brand: "Free People", brand_confidence: "moderate", category: "shoes", subcategory: "sandals", color: "tan", material: "leather wood", fit: "regular", search_query: "women's Free People chunky platform sandals tan", style_keywords: ["boho", "platform", "summer"], price_range: "$138 - $178" },
    { name: "Straw Tote Bag", brand: "Zara", brand_confidence: "moderate", category: "bag", subcategory: "tote", color: "natural", material: "woven straw", fit: "standard", search_query: "women's Zara straw tote bag natural", style_keywords: ["summer", "beach", "casual"], price_range: "$35 - $50" },
  ]},
  { g: "female", summary: "Office to happy hour with blazer dress and mules", items: [
    { name: "Belted Blazer Dress", brand: "Aritzia", brand_confidence: "high", category: "dress", subcategory: "blazer dress", color: "black", material: "crepe", fit: "tailored", search_query: "women's Aritzia Babaton blazer dress black", style_keywords: ["workwear", "power dressing", "versatile"], price_range: "$168 - $228" },
    { name: "Pointed Mule Heels", brand: "Zara", brand_confidence: "moderate", category: "shoes", subcategory: "mules", color: "nude", material: "faux leather", fit: "regular", search_query: "women's Zara pointed mule heels nude", style_keywords: ["elegant", "office", "transitional"], price_range: "$50 - $70" },
    { name: "Structured Shoulder Bag", brand: "COS", brand_confidence: "high", category: "bag", subcategory: "shoulder bag", color: "black", material: "leather", fit: "standard", search_query: "women's COS structured leather shoulder bag black", style_keywords: ["minimal", "workwear", "structured"], price_range: "$120 - $180" },
  ]},
  { g: "female", summary: "Gym shark pump cover outfit with oversized tank and shorts", items: [
    { name: "Oversized Training Tank", brand: "Gymshark", brand_confidence: "confirmed", category: "top", subcategory: "tank top", color: "light grey", material: "cotton blend", fit: "oversized", search_query: "women's Gymshark oversized training tank grey", style_keywords: ["gym", "pump cover", "oversized"], price_range: "$25 - $35" },
    { name: "Vital Cycling Shorts", brand: "Gymshark", brand_confidence: "confirmed", category: "bottom", subcategory: "shorts", color: "black", material: "nylon spandex", fit: "fitted", search_query: "women's Gymshark Vital cycling shorts black", style_keywords: ["gym", "fitted", "performance"], price_range: "$28 - $38" },
    { name: "Running Shoes", brand: "Nike", brand_confidence: "confirmed", category: "shoes", subcategory: "sneakers", color: "black white", material: "Flyknit mesh", fit: "regular", search_query: "women's Nike Free Run 5.0 black white", style_keywords: ["running", "training", "lightweight"], price_range: "$100 - $120" },
  ]},
  { g: "female", summary: "Skims everything shower outfit with matching loungewear", items: [
    { name: "Soft Lounge Long Sleeve", brand: "Skims", brand_confidence: "confirmed", category: "top", subcategory: "long sleeve", color: "sienna", material: "modal blend", fit: "fitted", search_query: "women's Skims Soft Lounge long sleeve sienna", style_keywords: ["loungewear", "cozy", "basics"], price_range: "$58 - $68" },
    { name: "Soft Lounge Pants", brand: "Skims", brand_confidence: "confirmed", category: "bottom", subcategory: "lounge pants", color: "sienna", material: "modal blend", fit: "relaxed", search_query: "women's Skims Soft Lounge pants sienna", style_keywords: ["loungewear", "matching set", "cozy"], price_range: "$68 - $78" },
    { name: "Fuzzy Slides", brand: "Skims", brand_confidence: "high", category: "shoes", subcategory: "slides", color: "bone", material: "faux shearling", fit: "regular", search_query: "women's Skims fuzzy slides bone", style_keywords: ["cozy", "loungewear", "home"], price_range: "$48 - $58" },
  ]},
  { g: "female", summary: "Night out bodysuit and leather pants with strappy heels", items: [
    { name: "One Shoulder Bodysuit", brand: "Revolve", brand_confidence: "moderate", category: "top", subcategory: "bodysuit", color: "black", material: "stretch jersey", fit: "fitted", search_query: "women's one shoulder bodysuit black going out", style_keywords: ["going out", "sexy", "sleek"], price_range: "$40 - $65" },
    { name: "Faux Leather Straight Pants", brand: "Zara", brand_confidence: "moderate", category: "bottom", subcategory: "pants", color: "black", material: "faux leather", fit: "straight", search_query: "women's Zara faux leather straight pants black", style_keywords: ["edgy", "night out", "statement"], price_range: "$50 - $70" },
    { name: "Strappy Heeled Sandals", brand: "Princess Polly", brand_confidence: "high", category: "shoes", subcategory: "heels", color: "black", material: "faux leather", fit: "regular", search_query: "women's Princess Polly strappy heeled sandals black", style_keywords: ["night out", "sexy", "strappy"], price_range: "$45 - $60" },
  ]},

  // ═══ SHOE-FOCUSED OUTFITS ═══
  { g: "male", summary: "Clean sneaker showcase with minimal fit to let the shoes talk", items: [
    { name: "Basic Crew Tee", brand: "COS", brand_confidence: "moderate", category: "top", subcategory: "t-shirt", color: "white", material: "organic cotton", fit: "regular", search_query: "men's COS basic crew tee white", style_keywords: ["minimal", "basics", "clean"], price_range: "$25 - $39" },
    { name: "Straight Leg Chinos", brand: "Banana Republic", brand_confidence: "moderate", category: "bottom", subcategory: "chinos", color: "stone", material: "stretch cotton", fit: "straight", search_query: "men's Banana Republic straight chinos stone", style_keywords: ["classic", "clean", "versatile"], price_range: "$60 - $80" },
    { name: "Samba OG Sneakers", brand: "Adidas", brand_confidence: "confirmed", category: "shoes", subcategory: "sneakers", color: "white black gum", material: "leather suede", fit: "regular", search_query: "men's Adidas Samba OG white black gum", style_keywords: ["iconic", "trending", "terrace"], price_range: "$100 - $110" },
  ]},
  { g: "female", summary: "Ballet flat moment with cropped trousers and knit", items: [
    { name: "Cashmere Crew Neck", brand: "COS", brand_confidence: "high", category: "top", subcategory: "sweater", color: "oatmeal", material: "cashmere", fit: "regular", search_query: "women's COS cashmere crew sweater oatmeal", style_keywords: ["quiet luxury", "soft", "timeless"], price_range: "$135 - $190" },
    { name: "Cropped Tailored Trousers", brand: "Aritzia", brand_confidence: "high", category: "bottom", subcategory: "trousers", color: "charcoal", material: "wool blend", fit: "tailored", search_query: "women's Aritzia cropped tailored trousers charcoal", style_keywords: ["polished", "workwear", "modern"], price_range: "$110 - $148" },
    { name: "Leather Ballet Flats", brand: "Zara", brand_confidence: "moderate", category: "shoes", subcategory: "ballet flats", color: "burgundy", material: "soft leather", fit: "regular", search_query: "women's Zara leather ballet flats burgundy", style_keywords: ["ballet", "trending", "elegant"], price_range: "$40 - $60" },
  ]},
  { g: "male", summary: "Hiking trail look that works for the city too", items: [
    { name: "Merino Wool Base Layer", brand: "Marine Layer", brand_confidence: "moderate", category: "top", subcategory: "long sleeve", color: "charcoal", material: "merino wool blend", fit: "regular", search_query: "men's Marine Layer merino wool long sleeve charcoal", style_keywords: ["outdoor", "layering", "performance"], price_range: "$68 - $88" },
    { name: "Stretch Hiking Pants", brand: "Vuori", brand_confidence: "moderate", category: "bottom", subcategory: "pants", color: "dark grey", material: "nylon stretch", fit: "slim", search_query: "men's Vuori Meta pant dark grey", style_keywords: ["outdoor", "technical", "versatile"], price_range: "$98 - $118" },
    { name: "XA Pro 3D V9 Trail Runners", brand: "Salomon", brand_confidence: "confirmed", category: "shoes", subcategory: "trail shoes", color: "black magnet", material: "mesh Contagrip", fit: "regular", search_query: "men's Salomon XA Pro 3D V9 black trail shoes", style_keywords: ["trail", "gorpcore", "technical"], price_range: "$130 - $150" },
  ]},
];

// ─── Helpers ───────────────────────────────────────────────────
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const uuid = () => crypto.randomUUID();

// ─── Main ──────────────────────────────────────────────────────
async function run() {
  console.log(`Seeding ${COUNT} Gen Z outfit scans...`);

  // 1. Get or create AI accounts
  const { data: existingAccounts } = await supabase
    .from("profiles")
    .select("id, display_name, gender_pref")
    .eq("is_ai", true)
    .limit(200);

  let accounts = existingAccounts || [];
  console.log(`Found ${accounts.length} existing AI accounts`);

  // Create more if needed (aim for at least 50)
  const needed = Math.max(0, 50 - accounts.length);
  if (needed > 0) {
    console.log(`Creating ${needed} new AI accounts...`);
    for (let i = 0; i < needed; i++) {
      const isFemale = Math.random() > 0.45;
      const name = isFemale ? pick(NAMES_F) : pick(NAMES_M);
      const last = pick(LAST);
      const id = uuid();
      const { error } = await supabase.from("profiles").insert({
        id,
        display_name: `${name} ${last}.`,
        gender_pref: isFemale ? "female" : "male",
        is_ai: true,
        tier: "pro",
      });
      if (!error) accounts.push({ id, display_name: `${name} ${last}.`, gender_pref: isFemale ? "female" : "male" });
    }
    console.log(`Created ${needed} accounts. Total: ${accounts.length}`);
  }

  // 2. Generate scans
  let created = 0;
  const batchSize = 20;

  for (let batch = 0; created < COUNT; batch++) {
    const scans = [];
    const batchCount = Math.min(batchSize, COUNT - created);

    for (let i = 0; i < batchCount; i++) {
      const outfit = pick(OUTFITS);
      // Match account gender to outfit gender
      const matchingAccounts = accounts.filter(a =>
        (outfit.g === "female" && a.gender_pref === "female") ||
        (outfit.g === "male" && a.gender_pref === "male")
      );
      const account = pick(matchingAccounts.length > 0 ? matchingAccounts : accounts);
      const photo = pick(PHOTOS);

      scans.push({
        id: uuid(),
        user_id: account.id,
        image_url: photoUrl(photo),
        image_thumbnail: null,
        detected_gender: outfit.g,
        summary: outfit.summary,
        items: outfit.items.map((item, idx) => ({
          ...item,
          position_y: 0.2 + idx * 0.25,
          visibility_pct: 85 + Math.floor(Math.random() * 15),
          identification_confidence: 40 + Math.floor(Math.random() * 40),
          alt_search: item.search_query.replace(item.brand !== "Unidentified" ? item.brand + " " : "", ""),
          construction_details: "",
        })),
        tiers: null,
        visibility: "public",
        created_at: new Date(Date.now() - Math.floor(Math.random() * 30 * 24 * 60 * 60 * 1000)).toISOString(), // random date within last 30 days
      });
    }

    const { error } = await supabase.from("scans").insert(scans);
    if (error) {
      console.error(`Batch ${batch} error:`, error.message);
    } else {
      created += scans.length;
      process.stdout.write(`\r  ${created}/${COUNT} scans created`);
    }
  }

  console.log(`\n\nDone! Created ${created} scans with Gen Z brands.`);
  console.log("Brands featured: Adanola, Skims, Lululemon, Vuori, Salomon, Oh Polly, Princess Polly,");
  console.log("  Free People, Aritzia, White Fox, Zara, COS, Reformation, Abercrombie,");
  console.log("  AllSaints, Reiss, Sandro, Maje, Gymshark, Alo Yoga, Nike, Adidas,");
  console.log("  New Balance, Faherty, Marine Layer, Banana Republic, Massimo Dutti, Revolve");
}

run().catch(err => { console.error("Fatal:", err.message); process.exit(1); });
