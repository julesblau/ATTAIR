/**
 * seedAiAccounts.js — Create 20 AI style accounts for ATTAIRE beta.
 *
 * Run once: node src/scripts/seedAiAccounts.js
 *
 * Creates Supabase auth users + profiles with is_ai=true.
 * Skips accounts that already exist (checks by email).
 */

import "dotenv/config";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
);

const AI_ACCOUNTS = [
  // ─── Women's Fashion ─────────────────────────────────────
  {
    email: "ai-street-style@attaire.app",
    display_name: "Street Style Daily",
    bio: "NYC, London, Tokyo — the best street style captured daily",
    gender_pref: "women",
    style_interests: ["streetwear", "urban", "casual", "layering"],
    avatar_color: "#C9A96E",
  },
  {
    email: "ai-luxury-finds@attaire.app",
    display_name: "Luxury Finds",
    bio: "Designer pieces at every price point. From runway to your closet.",
    gender_pref: "women",
    style_interests: ["luxury", "designer", "runway", "high fashion"],
    avatar_color: "#AB82FF",
  },
  {
    email: "ai-vintage-vibes@attaire.app",
    display_name: "Vintage Vibes",
    bio: "Retro-inspired fits and thrift gems. Sustainable style.",
    gender_pref: "women",
    style_interests: ["vintage", "retro", "thrift", "sustainable"],
    avatar_color: "#A8884A",
  },
  {
    email: "ai-minimal-wardrobe@attaire.app",
    display_name: "Minimal Wardrobe",
    bio: "Clean lines, neutral tones. Less is more.",
    gender_pref: "women",
    style_interests: ["minimalist", "capsule wardrobe", "neutral", "clean"],
    avatar_color: "#8B8B8B",
  },
  {
    email: "ai-date-night@attaire.app",
    display_name: "Date Night Looks",
    bio: "Outfits that turn heads. Evening and going-out inspiration.",
    gender_pref: "women",
    style_interests: ["evening", "going out", "date night", "elegant"],
    avatar_color: "#D4B978",
  },
  {
    email: "ai-athleisure@attaire.app",
    display_name: "Athleisure Edit",
    bio: "Gym to brunch outfit inspo. Comfort meets style.",
    gender_pref: "women",
    style_interests: ["athleisure", "activewear", "sporty", "casual"],
    avatar_color: "#66BB6A",
  },
  {
    email: "ai-boho-chic@attaire.app",
    display_name: "Boho Chic",
    bio: "Free-spirited style. Earthy tones and flowy fits.",
    gender_pref: "women",
    style_interests: ["bohemian", "boho", "earthy", "flowy"],
    avatar_color: "#D4A574",
  },
  {
    email: "ai-office-slay@attaire.app",
    display_name: "Office Slay",
    bio: "Corporate chic that commands the room. Power dressing daily.",
    gender_pref: "women",
    style_interests: ["workwear", "corporate", "professional", "tailored"],
    avatar_color: "#5C6BC0",
  },
  {
    email: "ai-y2k-revival@attaire.app",
    display_name: "Y2K Revival",
    bio: "Early 2000s energy. Butterfly clips to low-rise everything.",
    gender_pref: "women",
    style_interests: ["y2k", "2000s", "trendy", "nostalgic"],
    avatar_color: "#FF80AB",
  },
  {
    email: "ai-coastal-granddaughter@attaire.app",
    display_name: "Coastal Aesthetic",
    bio: "Linen, whites, and sea breeze vibes. Quiet luxury.",
    gender_pref: "women",
    style_interests: ["coastal", "quiet luxury", "linen", "resort"],
    avatar_color: "#80DEEA",
  },

  // ─── Men's Fashion ────────────────────────────────────────
  {
    email: "ai-mens-street@attaire.app",
    display_name: "Drip Check",
    bio: "Best men's streetwear fits. Sneakers, layers, heat.",
    gender_pref: "men",
    style_interests: ["streetwear", "sneakers", "hype", "urban"],
    avatar_color: "#EF5350",
  },
  {
    email: "ai-mens-classic@attaire.app",
    display_name: "Classic Menswear",
    bio: "Timeless men's style. Tailored, refined, confident.",
    gender_pref: "men",
    style_interests: ["classic", "tailored", "menswear", "suiting"],
    avatar_color: "#37474F",
  },
  {
    email: "ai-athlete-style@attaire.app",
    display_name: "Athlete Style",
    bio: "How the pros dress off the court. NBA, NFL, soccer style.",
    gender_pref: "men",
    style_interests: ["athletic", "sports", "casual", "sneakers"],
    avatar_color: "#FF7043",
  },
  {
    email: "ai-mens-minimal@attaire.app",
    display_name: "Essential Man",
    bio: "Minimalist men's wardrobe. Quality over quantity.",
    gender_pref: "men",
    style_interests: ["minimalist", "essential", "quality", "capsule"],
    avatar_color: "#90A4AE",
  },
  {
    email: "ai-rock-style@attaire.app",
    display_name: "Rock & Roll Style",
    bio: "Musicians, bands, and stage-to-street fashion.",
    gender_pref: "men",
    style_interests: ["rock", "band", "edgy", "leather"],
    avatar_color: "#424242",
  },

  // ─── Unisex / Lifestyle ──────────────────────────────────
  {
    email: "ai-celeb-spotted@attaire.app",
    display_name: "Celeb Spotted",
    bio: "Celebrity style decoded. Get the look for less.",
    gender_pref: "both",
    style_interests: ["celebrity", "red carpet", "paparazzi", "get the look"],
    avatar_color: "#FFD54F",
  },
  {
    email: "ai-tiktok-trends@attaire.app",
    display_name: "TikTok Trending",
    bio: "Viral fits from TikTok. The looks everyone is talking about.",
    gender_pref: "both",
    style_interests: ["tiktok", "viral", "trending", "gen z"],
    avatar_color: "#EE1D52",
  },
  {
    email: "ai-sustainable@attaire.app",
    display_name: "Sustainable Style",
    bio: "Eco-friendly fashion that looks incredible. Slow fashion wins.",
    gender_pref: "both",
    style_interests: ["sustainable", "eco", "ethical", "slow fashion"],
    avatar_color: "#43A047",
  },
  {
    email: "ai-budget-style@attaire.app",
    display_name: "Budget Style Wins",
    bio: "Amazing outfits under $100. Proof that style has no price tag.",
    gender_pref: "both",
    style_interests: ["budget", "affordable", "deals", "value"],
    avatar_color: "#26A69A",
  },
  {
    email: "ai-seasonal-edit@attaire.app",
    display_name: "Seasonal Edit",
    bio: "What to wear right now. Seasonal trend reports and outfit ideas.",
    gender_pref: "both",
    style_interests: ["seasonal", "trends", "forecast", "editorial"],
    avatar_color: "#7E57C2",
  },
];

async function seed() {
  console.log("Seeding 20 AI style accounts...\n");
  let created = 0;
  let skipped = 0;

  for (const acct of AI_ACCOUNTS) {
    // Check if account already exists
    const { data: existing } = await supabase
      .from("profiles")
      .select("id, display_name")
      .eq("display_name", acct.display_name)
      .maybeSingle();

    if (existing) {
      console.log(`  SKIP  ${acct.display_name} (already exists: ${existing.id})`);
      skipped++;
      continue;
    }

    try {
      // Create auth user (no password needed — these accounts never log in)
      const { data: authData, error: authError } = await supabase.auth.admin.createUser({
        email: acct.email,
        email_confirm: true,
        password: `ai-${Date.now()}-${Math.random().toString(36).slice(2)}`, // random, unused
        user_metadata: { display_name: acct.display_name, is_ai: true },
      });

      if (authError) {
        // If user already exists in auth but not in profiles, get the existing user
        if (authError.message?.includes("already been registered")) {
          console.log(`  SKIP  ${acct.display_name} (auth user exists)`);
          skipped++;
          continue;
        }
        throw authError;
      }

      const userId = authData.user.id;

      // Update profile with AI account data
      const { error: profileError } = await supabase
        .from("profiles")
        .update({
          display_name: acct.display_name,
          bio: acct.bio,
          gender_pref: acct.gender_pref,
          style_interests: acct.style_interests,
          is_ai: true,
          tier: "pro", // AI accounts are "pro" so they appear credible
        })
        .eq("id", userId);

      if (profileError) throw profileError;

      console.log(`  OK    ${acct.display_name} (${userId})`);
      created++;
    } catch (err) {
      console.error(`  FAIL  ${acct.display_name}: ${err.message}`);
    }
  }

  console.log(`\nDone: ${created} created, ${skipped} skipped`);
}

seed().catch(err => {
  console.error("Seed failed:", err);
  process.exit(1);
});
