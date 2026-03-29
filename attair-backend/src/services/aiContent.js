/**
 * aiContent.js — AI account content posting service for ATTAIRE.
 *
 * Manages:
 * - Content library of curated outfits for each AI persona
 * - Scheduling posts throughout the day
 * - Publishing posts as public scans
 * - Notifying followers of new posts
 *
 * Content is curated per persona. Each post creates a real scan entry
 * visible in the public feed and to followers.
 */

import supabase from "../lib/supabase.js";
import { notifyFollowers } from "./notifications.js";

// ─── Content Library ───────────────────────────────────────────
// Each entry maps an AI account display_name to arrays of outfit content.
// items follow the same JSONB shape as real scan results.

const CONTENT_LIBRARY = {
  "Street Style Daily": [
    {
      summary: "Downtown NYC layered look — oversized blazer over a graphic tee with wide-leg jeans and chunky sneakers",
      detected_gender: "women",
      items: [
        { category: "Outerwear", subcategory: "Oversized Blazer", brand: "Zara", color: "charcoal", material: "wool blend", confidence: 0.92 },
        { category: "Top", subcategory: "Graphic Tee", brand: "Unidentified", color: "white", material: "cotton", confidence: 0.88 },
        { category: "Bottom", subcategory: "Wide-Leg Jeans", brand: "Agolde", color: "light wash", material: "denim", confidence: 0.85 },
        { category: "Shoes", subcategory: "Chunky Sneakers", brand: "New Balance", color: "cream", material: "leather/mesh", confidence: 0.90 },
      ],
    },
    {
      summary: "London street style — trench coat, turtleneck, pleated skirt, and knee-high boots",
      detected_gender: "women",
      items: [
        { category: "Outerwear", subcategory: "Trench Coat", brand: "Burberry", color: "beige", material: "gabardine", confidence: 0.94 },
        { category: "Top", subcategory: "Turtleneck Sweater", brand: "COS", color: "black", material: "merino wool", confidence: 0.87 },
        { category: "Bottom", subcategory: "Pleated Midi Skirt", brand: "Unidentified", color: "navy", material: "polyester", confidence: 0.83 },
        { category: "Shoes", subcategory: "Knee-High Boots", brand: "Stuart Weitzman", color: "black", material: "leather", confidence: 0.91 },
      ],
    },
    {
      summary: "Tokyo street style — oversized denim jacket, cropped hoodie, cargo pants, and platform sneakers",
      detected_gender: "women",
      items: [
        { category: "Outerwear", subcategory: "Denim Jacket", brand: "Levi's", color: "medium wash", material: "denim", confidence: 0.89 },
        { category: "Top", subcategory: "Cropped Hoodie", brand: "Nike", color: "sage green", material: "cotton blend", confidence: 0.86 },
        { category: "Bottom", subcategory: "Cargo Pants", brand: "Unidentified", color: "khaki", material: "cotton", confidence: 0.84 },
        { category: "Shoes", subcategory: "Platform Sneakers", brand: "Converse", color: "white", material: "canvas", confidence: 0.92 },
      ],
    },
    {
      summary: "Berlin minimal streetwear — black leather jacket, white tank, straight-leg trousers, and loafers",
      detected_gender: "women",
      items: [
        { category: "Outerwear", subcategory: "Leather Jacket", brand: "AllSaints", color: "black", material: "leather", confidence: 0.93 },
        { category: "Top", subcategory: "Tank Top", brand: "Unidentified", color: "white", material: "cotton", confidence: 0.85 },
        { category: "Bottom", subcategory: "Straight-Leg Trousers", brand: "COS", color: "black", material: "wool blend", confidence: 0.87 },
        { category: "Shoes", subcategory: "Loafers", brand: "G.H. Bass", color: "burgundy", material: "leather", confidence: 0.90 },
      ],
    },
  ],

  "Luxury Finds": [
    {
      summary: "Resort ready — silk wrap dress with strappy heels and a structured clutch",
      detected_gender: "women",
      items: [
        { category: "Dress", subcategory: "Silk Wrap Dress", brand: "Diane von Furstenberg", color: "emerald green", material: "silk", confidence: 0.95 },
        { category: "Shoes", subcategory: "Strappy Heels", brand: "Jimmy Choo", color: "gold", material: "metallic leather", confidence: 0.91 },
        { category: "Accessory", subcategory: "Structured Clutch", brand: "Bottega Veneta", color: "cream", material: "intrecciato leather", confidence: 0.88 },
      ],
    },
    {
      summary: "Power suit moment — double-breasted blazer set with pointed-toe pumps",
      detected_gender: "women",
      items: [
        { category: "Outerwear", subcategory: "Double-Breasted Blazer", brand: "Saint Laurent", color: "black", material: "wool", confidence: 0.93 },
        { category: "Bottom", subcategory: "Tailored Trousers", brand: "Saint Laurent", color: "black", material: "wool", confidence: 0.92 },
        { category: "Shoes", subcategory: "Pointed-Toe Pumps", brand: "Manolo Blahnik", color: "nude", material: "patent leather", confidence: 0.90 },
      ],
    },
  ],

  "Vintage Vibes": [
    {
      summary: "70s revival — flared jeans, crochet vest, platform boots, and round sunglasses",
      detected_gender: "women",
      items: [
        { category: "Bottom", subcategory: "Flared Jeans", brand: "Free People", color: "dark wash", material: "denim", confidence: 0.88 },
        { category: "Top", subcategory: "Crochet Vest", brand: "Unidentified", color: "cream", material: "cotton crochet", confidence: 0.82 },
        { category: "Shoes", subcategory: "Platform Boots", brand: "Dr. Martens", color: "brown", material: "leather", confidence: 0.90 },
        { category: "Accessory", subcategory: "Round Sunglasses", brand: "Ray-Ban", color: "gold/brown", material: "metal", confidence: 0.86 },
      ],
    },
    {
      summary: "Thrift haul look — vintage band tee tucked into mom jeans with Converse and a corduroy jacket",
      detected_gender: "women",
      items: [
        { category: "Top", subcategory: "Vintage Band Tee", brand: "Unidentified", color: "faded black", material: "cotton", confidence: 0.80 },
        { category: "Bottom", subcategory: "Mom Jeans", brand: "Levi's", color: "medium wash", material: "denim", confidence: 0.87 },
        { category: "Outerwear", subcategory: "Corduroy Jacket", brand: "Unidentified", color: "camel", material: "corduroy", confidence: 0.84 },
        { category: "Shoes", subcategory: "High-Top Sneakers", brand: "Converse", color: "off-white", material: "canvas", confidence: 0.91 },
      ],
    },
  ],

  "Minimal Wardrobe": [
    {
      summary: "Capsule wardrobe perfection — cashmere crew, tailored trousers, and minimal leather sandals",
      detected_gender: "women",
      items: [
        { category: "Top", subcategory: "Cashmere Crewneck", brand: "Everlane", color: "oatmeal", material: "cashmere", confidence: 0.91 },
        { category: "Bottom", subcategory: "Tailored Wide-Leg Trousers", brand: "COS", color: "black", material: "cotton blend", confidence: 0.89 },
        { category: "Shoes", subcategory: "Leather Sandals", brand: "The Row", color: "tan", material: "leather", confidence: 0.87 },
      ],
    },
  ],

  "Date Night Looks": [
    {
      summary: "Dinner date — satin midi dress, strappy heels, and delicate gold jewelry",
      detected_gender: "women",
      items: [
        { category: "Dress", subcategory: "Satin Midi Dress", brand: "Reformation", color: "burgundy", material: "satin", confidence: 0.92 },
        { category: "Shoes", subcategory: "Strappy Heels", brand: "Steve Madden", color: "black", material: "suede", confidence: 0.88 },
        { category: "Accessory", subcategory: "Gold Chain Necklace", brand: "Mejuri", color: "gold", material: "14k gold", confidence: 0.85 },
      ],
    },
  ],

  "Athleisure Edit": [
    {
      summary: "Gym to coffee run — matching set, clean sneakers, and oversized sunglasses",
      detected_gender: "women",
      items: [
        { category: "Top", subcategory: "Sports Bra Tank", brand: "Lululemon", color: "sage", material: "nulu fabric", confidence: 0.90 },
        { category: "Bottom", subcategory: "High-Rise Leggings", brand: "Lululemon", color: "sage", material: "nulu fabric", confidence: 0.91 },
        { category: "Shoes", subcategory: "Running Sneakers", brand: "On Running", color: "white/sand", material: "mesh", confidence: 0.89 },
      ],
    },
  ],

  "Boho Chic": [
    {
      summary: "Festival ready — maxi dress with layered necklaces, ankle boots, and a fringe bag",
      detected_gender: "women",
      items: [
        { category: "Dress", subcategory: "Floral Maxi Dress", brand: "Free People", color: "rust/multi", material: "viscose", confidence: 0.88 },
        { category: "Shoes", subcategory: "Western Ankle Boots", brand: "Isabel Marant", color: "tan", material: "suede", confidence: 0.86 },
        { category: "Accessory", subcategory: "Fringe Crossbody Bag", brand: "Unidentified", color: "brown", material: "leather", confidence: 0.83 },
      ],
    },
  ],

  "Office Slay": [
    {
      summary: "Monday morning power move — structured blazer, silk blouse, pencil skirt, and pointed-toe pumps",
      detected_gender: "women",
      items: [
        { category: "Outerwear", subcategory: "Structured Blazer", brand: "Theory", color: "navy", material: "wool blend", confidence: 0.93 },
        { category: "Top", subcategory: "Silk Blouse", brand: "Equipment", color: "ivory", material: "silk", confidence: 0.90 },
        { category: "Bottom", subcategory: "Pencil Skirt", brand: "Hugo Boss", color: "navy", material: "wool blend", confidence: 0.88 },
        { category: "Shoes", subcategory: "Pointed-Toe Pumps", brand: "Stuart Weitzman", color: "black", material: "leather", confidence: 0.91 },
      ],
    },
  ],

  "Y2K Revival": [
    {
      summary: "Early 2000s energy — low-rise cargo pants, baby tee, platform sandals, and mini bag",
      detected_gender: "women",
      items: [
        { category: "Bottom", subcategory: "Low-Rise Cargo Pants", brand: "Urban Outfitters", color: "olive", material: "cotton", confidence: 0.85 },
        { category: "Top", subcategory: "Baby Tee", brand: "Unidentified", color: "pink", material: "cotton", confidence: 0.83 },
        { category: "Shoes", subcategory: "Platform Sandals", brand: "Steve Madden", color: "white", material: "synthetic", confidence: 0.87 },
        { category: "Accessory", subcategory: "Mini Shoulder Bag", brand: "Unidentified", color: "silver", material: "metallic", confidence: 0.80 },
      ],
    },
  ],

  "Coastal Aesthetic": [
    {
      summary: "Quiet luxury beach-to-dinner — linen set, leather sandals, and woven tote",
      detected_gender: "women",
      items: [
        { category: "Top", subcategory: "Linen Button-Down Shirt", brand: "Loro Piana", color: "white", material: "linen", confidence: 0.90 },
        { category: "Bottom", subcategory: "Linen Wide-Leg Pants", brand: "Loro Piana", color: "sand", material: "linen", confidence: 0.89 },
        { category: "Shoes", subcategory: "Flat Leather Sandals", brand: "Ancient Greek Sandals", color: "natural", material: "leather", confidence: 0.87 },
        { category: "Accessory", subcategory: "Woven Tote Bag", brand: "Dragon Diffusion", color: "tan", material: "woven leather", confidence: 0.85 },
      ],
    },
  ],

  "Drip Check": [
    {
      summary: "Heat check — Jordan 4s, oversized vintage hoodie, stacked jeans, and a fitted cap",
      detected_gender: "men",
      items: [
        { category: "Shoes", subcategory: "Retro Sneakers", brand: "Jordan", color: "military black", material: "leather/nubuck", confidence: 0.95 },
        { category: "Top", subcategory: "Oversized Hoodie", brand: "Essentials", color: "dark oatmeal", material: "cotton blend", confidence: 0.90 },
        { category: "Bottom", subcategory: "Stacked Jeans", brand: "Amiri", color: "washed black", material: "denim", confidence: 0.88 },
        { category: "Accessory", subcategory: "Fitted Cap", brand: "New Era", color: "black", material: "wool blend", confidence: 0.86 },
      ],
    },
    {
      summary: "Tech fleece fit — full Nike set with Air Max 90s and a crossbody bag",
      detected_gender: "men",
      items: [
        { category: "Top", subcategory: "Tech Fleece Hoodie", brand: "Nike", color: "dark grey heather", material: "tech fleece", confidence: 0.93 },
        { category: "Bottom", subcategory: "Tech Fleece Joggers", brand: "Nike", color: "dark grey heather", material: "tech fleece", confidence: 0.92 },
        { category: "Shoes", subcategory: "Air Max 90", brand: "Nike", color: "white/black", material: "leather/mesh", confidence: 0.94 },
        { category: "Accessory", subcategory: "Crossbody Bag", brand: "Nike", color: "black", material: "nylon", confidence: 0.85 },
      ],
    },
  ],

  "Classic Menswear": [
    {
      summary: "Italian-inspired — navy blazer, white OCBD, grey wool trousers, and suede loafers",
      detected_gender: "men",
      items: [
        { category: "Outerwear", subcategory: "Navy Blazer", brand: "Ralph Lauren", color: "navy", material: "wool", confidence: 0.94 },
        { category: "Top", subcategory: "Oxford Button-Down Shirt", brand: "Brooks Brothers", color: "white", material: "cotton oxford", confidence: 0.91 },
        { category: "Bottom", subcategory: "Wool Trousers", brand: "Incotex", color: "medium grey", material: "wool", confidence: 0.89 },
        { category: "Shoes", subcategory: "Suede Loafers", brand: "Alden", color: "tobacco", material: "suede", confidence: 0.88 },
      ],
    },
  ],

  "Athlete Style": [
    {
      summary: "Post-game tunnel fit — oversized leather jacket, designer tee, joggers, and high-top sneakers",
      detected_gender: "men",
      items: [
        { category: "Outerwear", subcategory: "Oversized Leather Jacket", brand: "Rick Owens", color: "black", material: "leather", confidence: 0.90 },
        { category: "Top", subcategory: "Designer T-Shirt", brand: "Fear of God", color: "cream", material: "cotton", confidence: 0.87 },
        { category: "Bottom", subcategory: "Relaxed Joggers", brand: "Essentials", color: "black", material: "cotton blend", confidence: 0.85 },
        { category: "Shoes", subcategory: "High-Top Sneakers", brand: "Jordan", color: "chicago red/white/black", material: "leather", confidence: 0.94 },
      ],
    },
  ],

  "Essential Man": [
    {
      summary: "Everyday essentials — perfect-fit tee, slim chinos, clean sneakers, and a simple watch",
      detected_gender: "men",
      items: [
        { category: "Top", subcategory: "Premium T-Shirt", brand: "Reigning Champ", color: "heather grey", material: "cotton", confidence: 0.88 },
        { category: "Bottom", subcategory: "Slim Chinos", brand: "Bonobos", color: "khaki", material: "stretch cotton", confidence: 0.87 },
        { category: "Shoes", subcategory: "Leather Sneakers", brand: "Common Projects", color: "white", material: "leather", confidence: 0.93 },
      ],
    },
  ],

  "Rock & Roll Style": [
    {
      summary: "Rock meets refined — leather biker jacket, band tee, skinny jeans, Chelsea boots",
      detected_gender: "men",
      items: [
        { category: "Outerwear", subcategory: "Biker Jacket", brand: "Schott NYC", color: "black", material: "leather", confidence: 0.94 },
        { category: "Top", subcategory: "Vintage Band Tee", brand: "Unidentified", color: "washed black", material: "cotton", confidence: 0.82 },
        { category: "Bottom", subcategory: "Skinny Jeans", brand: "Saint Laurent", color: "black", material: "denim", confidence: 0.89 },
        { category: "Shoes", subcategory: "Chelsea Boots", brand: "Saint Laurent", color: "black", material: "leather", confidence: 0.92 },
      ],
    },
  ],

  "Celeb Spotted": [
    {
      summary: "Airport style decoded — cashmere hoodie, tailored joggers, designer sneakers, and oversized shades",
      detected_gender: "both",
      items: [
        { category: "Top", subcategory: "Cashmere Hoodie", brand: "Brunello Cucinelli", color: "oatmeal", material: "cashmere", confidence: 0.88 },
        { category: "Bottom", subcategory: "Tailored Joggers", brand: "Loro Piana", color: "navy", material: "technical wool", confidence: 0.86 },
        { category: "Shoes", subcategory: "Designer Sneakers", brand: "Golden Goose", color: "white/star", material: "leather", confidence: 0.91 },
        { category: "Accessory", subcategory: "Oversized Sunglasses", brand: "Celine", color: "black", material: "acetate", confidence: 0.87 },
      ],
    },
  ],

  "TikTok Trending": [
    {
      summary: "The viral clean girl aesthetic — slicked bun, gold hoops, matching set, and cloud slides",
      detected_gender: "women",
      items: [
        { category: "Top", subcategory: "Ribbed Tank Top", brand: "Skims", color: "espresso", material: "cotton blend", confidence: 0.89 },
        { category: "Bottom", subcategory: "Wide-Leg Trousers", brand: "Aritzia", color: "espresso", material: "crepe", confidence: 0.87 },
        { category: "Shoes", subcategory: "Cloud Slides", brand: "UGG", color: "bone", material: "foam/shearling", confidence: 0.90 },
        { category: "Accessory", subcategory: "Gold Hoop Earrings", brand: "Mejuri", color: "gold", material: "14k gold vermeil", confidence: 0.84 },
      ],
    },
  ],

  "Sustainable Style": [
    {
      summary: "Conscious closet — organic cotton tee, recycled denim, hemp sneakers",
      detected_gender: "both",
      items: [
        { category: "Top", subcategory: "Organic Cotton Tee", brand: "Patagonia", color: "natural", material: "organic cotton", confidence: 0.90 },
        { category: "Bottom", subcategory: "Recycled Denim Jeans", brand: "Nudie Jeans", color: "mid blue", material: "recycled cotton denim", confidence: 0.88 },
        { category: "Shoes", subcategory: "Sustainable Sneakers", brand: "Allbirds", color: "natural white", material: "merino wool", confidence: 0.91 },
      ],
    },
  ],

  "Budget Style Wins": [
    {
      summary: "Full outfit under $80 — H&M blazer, Uniqlo tee, Zara trousers, and Adidas sneakers",
      detected_gender: "both",
      items: [
        { category: "Outerwear", subcategory: "Relaxed Blazer", brand: "H&M", color: "beige", material: "polyester blend", confidence: 0.87 },
        { category: "Top", subcategory: "Supima Cotton Tee", brand: "Uniqlo", color: "white", material: "supima cotton", confidence: 0.89 },
        { category: "Bottom", subcategory: "Wide-Leg Trousers", brand: "Zara", color: "black", material: "viscose blend", confidence: 0.86 },
        { category: "Shoes", subcategory: "Stan Smith Sneakers", brand: "adidas", color: "white/green", material: "leather", confidence: 0.93 },
      ],
    },
  ],

  "Seasonal Edit": [
    {
      summary: "Spring transition — lightweight trench, striped Breton top, tailored shorts, and canvas sneakers",
      detected_gender: "both",
      items: [
        { category: "Outerwear", subcategory: "Lightweight Trench", brand: "Uniqlo", color: "khaki", material: "cotton blend", confidence: 0.88 },
        { category: "Top", subcategory: "Breton Stripe Top", brand: "Saint James", color: "navy/white", material: "cotton jersey", confidence: 0.90 },
        { category: "Bottom", subcategory: "Tailored Shorts", brand: "J.Crew", color: "olive", material: "cotton twill", confidence: 0.85 },
        { category: "Shoes", subcategory: "Canvas Sneakers", brand: "Veja", color: "white", material: "organic canvas", confidence: 0.89 },
      ],
    },
  ],
};

/**
 * Get all AI account user IDs from the database.
 */
export async function getAiAccounts() {
  const { data } = await supabase
    .from("profiles")
    .select("id, display_name")
    .eq("is_ai", true);
  return data || [];
}

/**
 * Create a post (scan) for an AI account.
 * Returns the created scan ID.
 */
export async function createAiPost(aiUserId, content) {
  const { summary, detected_gender, items } = content;

  const { data: scan, error } = await supabase
    .from("scans")
    .insert({
      user_id: aiUserId,
      scan_name: summary.slice(0, 60),
      summary,
      detected_gender,
      items,
      visibility: "public",
    })
    .select("id")
    .single();

  if (error) throw error;
  return scan.id;
}

/**
 * Schedule content for AI accounts.
 * Picks random content from each account's library and distributes posts
 * throughout the target date.
 *
 * @param {string} targetDate - ISO date string (YYYY-MM-DD)
 * @param {number} postsPerAccount - Number of posts per account per day (default: 3)
 */
export async function scheduleContent(targetDate, postsPerAccount = 3) {
  const accounts = await getAiAccounts();
  if (accounts.length === 0) {
    console.log("[AI Content] No AI accounts found. Run seedAiAccounts.js first.");
    return { scheduled: 0 };
  }

  let scheduled = 0;

  for (const account of accounts) {
    const library = CONTENT_LIBRARY[account.display_name];
    if (!library || library.length === 0) continue;

    for (let i = 0; i < postsPerAccount; i++) {
      // Distribute posts between 8am and 10pm ET (13:00-03:00 UTC next day)
      const hour = 8 + Math.floor(Math.random() * 14); // 8-21
      const minute = Math.floor(Math.random() * 60);
      const scheduledAt = new Date(`${targetDate}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00-04:00`);

      // Pick a random content piece (with some variation)
      const content = library[Math.floor(Math.random() * library.length)];

      // Check if this exact content was already scheduled for this account today
      const { data: existing } = await supabase
        .from("ai_content_queue")
        .select("id")
        .eq("ai_user_id", account.id)
        .gte("scheduled_at", `${targetDate}T00:00:00Z`)
        .lte("scheduled_at", `${targetDate}T23:59:59Z`);

      if (existing && existing.length >= postsPerAccount) continue;

      const { error } = await supabase
        .from("ai_content_queue")
        .insert({
          ai_user_id: account.id,
          content_data: content,
          scheduled_at: scheduledAt.toISOString(),
        });

      if (!error) scheduled++;
    }
  }

  console.log(`[AI Content] Scheduled ${scheduled} posts for ${targetDate}`);
  return { scheduled };
}

/**
 * Publish all due posts from the content queue.
 * Called by a cron job or manual trigger.
 * Returns summary of what was posted.
 */
export async function publishDuePosts() {
  const now = new Date().toISOString();

  // Get all unposted items that are due
  const { data: duePosts, error } = await supabase
    .from("ai_content_queue")
    .select("id, ai_user_id, content_data")
    .is("posted_at", null)
    .lte("scheduled_at", now)
    .order("scheduled_at", { ascending: true })
    .limit(50); // safety cap

  if (error) {
    console.error("[AI Content] Failed to fetch due posts:", error.message);
    return { posted: 0, errors: [error.message] };
  }

  if (!duePosts || duePosts.length === 0) {
    return { posted: 0, errors: [] };
  }

  let posted = 0;
  const errors = [];

  for (const post of duePosts) {
    try {
      // Create the scan (public post)
      const scanId = await createAiPost(post.ai_user_id, post.content_data);

      // Mark as posted
      await supabase
        .from("ai_content_queue")
        .update({ posted_at: now, scan_id: scanId })
        .eq("id", post.id);

      // Notify followers (non-blocking)
      const { data: profile } = await supabase
        .from("profiles")
        .select("display_name")
        .eq("id", post.ai_user_id)
        .single();

      const name = profile?.display_name || "ATTAIRE Style";
      notifyFollowers(
        post.ai_user_id,
        `New from ${name}`,
        post.content_data.summary?.slice(0, 80) || "Check out this new outfit",
        { url: `/scan/${scanId}` }
      ).catch(() => {});

      posted++;
    } catch (err) {
      console.error(`[AI Content] Failed to post ${post.id}:`, err.message);
      errors.push(`${post.id}: ${err.message}`);
    }
  }

  console.log(`[AI Content] Published ${posted}/${duePosts.length} posts`);
  return { posted, errors };
}

/**
 * Get content stats (for admin visibility).
 */
export async function getContentStats() {
  const accounts = await getAiAccounts();

  const { count: totalQueued } = await supabase
    .from("ai_content_queue")
    .select("id", { count: "exact", head: true })
    .is("posted_at", null);

  const { count: totalPosted } = await supabase
    .from("ai_content_queue")
    .select("id", { count: "exact", head: true })
    .not("posted_at", "is", null);

  return {
    ai_accounts: accounts.length,
    queued: totalQueued || 0,
    posted: totalPosted || 0,
  };
}
