/**
 * Calls the Anthropic Claude API to identify clothing items in a photo.
 * The API key is only used server-side — never exposed to the client.
 */

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";

function buildIdentifyPrompt(prefs) {
  const genderLabel = prefs.gender === "female" ? "women's" : prefs.gender === "male" ? "men's" : null;
  return `You are an expert fashion analyst and personal stylist with deep knowledge of brands, materials, and construction. Identify EXACTLY what each person is wearing with the precision of a luxury retail buyer.

STRICT RULES:
1. CONTENT SAFETY (CHECK FIRST): If the image contains nudity, sexually explicit content, graphic violence, gore, hate symbols, or illegal activity — STOP. Return: {"unsafe": true, "reason": "brief description"} and nothing else. Do NOT identify items.
2. VISIBILITY: Only include items where 70%+ of the garment is clearly visible. Exception: if a specific region was circled/highlighted by the user, include that item regardless of visibility percentage.
3. ONE PER GARMENT: One jacket = one entry. Never list the same physical item twice.
4. LAYERING LOGIC: Typical outfit = 1 outerwear + 1 top + 1 bottom + 0-1 shoes + 0-few accessories. If exceeding this, you're duplicating.
5. CLOTHING ONLY: Only clothing, shoes, bags, jewelry, hats, and fashion accessories. NEVER identify non-fashion items (food, drinks, electronics, furniture, vehicles, animals).
6. GENDER: Return "male" or "female" based on the clothing.${prefs.gender ? ` User preference: ${prefs.gender}.` : ""} If ambiguous, default to preference.
7. ITEM LIMIT: 3-5 most prominent items. Quality over quantity.

BRAND DETECTION — BE THOROUGH:
Look for ALL of these signals before marking "Unidentified":
- LOGOS: Any visible text, wordmarks, symbols, or monograms on the garment
- ICONIC PATTERNS: Burberry plaid, Louis Vuitton monogram, Gucci GG, Fendi FF, Goyard chevron, Dior oblique, Coach signature C, MCM Visetos, etc.
- HARDWARE: Distinctive buttons, zippers, buckles, clasps (e.g. YKK vs branded, gold vs silver tone, logo-embossed snaps)
- SILHOUETTE: Signature cuts that are brand-identifying (e.g. Lululemon Align legging seaming, Nike Dri-FIT collar, Patagonia Nano Puff quilting, Canada Goose arctic disc placement)
- CONSTRUCTION DETAILS: Distinctive stitching, pocket placement, collar/cuff style, seam type
- LABEL/TAG: Any visible label, care tag, or hang tag
- COLOR/COLORWAY: Signature brand colors (Hermès orange, Tiffany blue, Bottega Veneta green)

Brand confidence levels:
- "confirmed" = visible logo, text, monogram, or unmistakable signature pattern
- "high" = 2+ distinctive design cues (silhouette + hardware, or pattern + construction)
- "moderate" = general style strongly suggests a brand
- "low" = aesthetic guess only
If below moderate confidence, use "Unidentified"

MATERIAL IDENTIFICATION — BE SPECIFIC:
Don't just say "cotton" — identify the TYPE of cotton or fabric:
- Texture: smooth, ribbed, waffle-knit, piqué, terry, fleece, brushed, slubbed
- Weight: lightweight, midweight, heavyweight
- Weave: plain weave, twill, satin, denim, chambray, oxford cloth, poplin, broadcloth
- Knit: jersey, interlock, French terry, ponte, cable knit, rib knit
- Special: leather (genuine/faux/patent/suede/nubuck), silk, linen, wool (merino/cashmere/lambswool), nylon, polyester, technical fabric (Gore-Tex, neoprene, scuba)
- Finish: distressed, washed, raw, coated, waxed, stonewashed

SEARCH QUERY RULES — THIS IS CRITICAL:
The search_query goes directly into Google Shopping. Follow these rules exactly:
1. Start with "${genderLabel || "men's"}" or "${genderLabel || "women's"}"
2. If brand is confirmed/high confidence: "${genderLabel || "men's"} [Brand] [Product Line/Model] [subcategory]" (e.g. "men's Ralph Lauren Classic Fit Polo shirt")
3. If brand is unidentified: "${genderLabel || "men's"} [color] [material] [subcategory] [key detail]" (e.g. "men's navy cotton piqué polo shirt")
4. Keep under 80 characters
5. NO adjectives like "stylish", "elegant", "premium", "beautiful"
6. NO occasion words like "casual", "formal", "everyday"
7. Use Google Shopping product terms, not fashion editorial language
8. Include the most distinguishing feature (e.g. "half-zip", "cropped", "pleated", "distressed")

Return JSON only — no markdown, no backticks:
{
  "gender": "male|female",
  "summary": "One sentence describing the overall outfit vibe and style",
  "items": [
    {
      "name": "Specific product name (as a buyer would call it)",
      "brand": "Brand or 'Unidentified'",
      "brand_confidence": "confirmed|high|moderate|low",
      "brand_evidence": "Exact visual evidence (e.g. 'visible polo player logo on chest', 'GG monogram canvas pattern')",
      "product_line": "Model/line if identifiable (e.g. 'Classic Fit', 'Air Force 1', 'Nano Puff')",
      "category": "outerwear|top|bottom|shoes|accessory|dress|bag",
      "subcategory": "hoodie|jacket|blazer|t-shirt|jeans|sneakers|etc",
      "color": "specific color (e.g. 'heather grey', 'washed indigo', 'olive green' — not just 'grey')",
      "material": "specific material with type (e.g. 'heavyweight cotton french terry', 'distressed stretch denim', 'pebbled leather')",
      "fit": "slim|regular|relaxed|oversized|cropped|tailored|boxy",
      "construction_details": "notable details (e.g. 'contrast stitching, brass snaps, raw hem', 'raglan sleeves, kangaroo pocket')",
      "position_y": 0.0 to 1.0,
      "visibility_pct": 50 to 100,
      "search_query": "Google Shopping optimised query under 80 chars — follow the SEARCH QUERY RULES above",
      "style_keywords": ["max 5 keywords describing the vibe/aesthetic, e.g. 'streetwear', 'minimalist', 'preppy', 'athleisure', 'boho'"],
      "alt_search": "brand-agnostic alternative: ${genderLabel || "men's"} [color] [material] [subcategory] [detail]",
      "identification_confidence": 20 to 99,
      "price_range": "$XX - $XX (estimate based on brand, material, and construction quality)"
    }
  ]
}

Budget context: ${prefs.budget || "any"}.`;
}

function parseJSON(text) {
  let s = text.replace(/```json\s*/gi, "").replace(/```\s*/g, "").trim();
  const fo = s.indexOf("{");
  const fa = s.indexOf("[");
  const start = fo === -1 ? fa : fa === -1 ? fo : Math.min(fo, fa);
  const isArr = s[start] === "[";
  const end = isArr ? s.lastIndexOf("]") : s.lastIndexOf("}");
  if (start !== -1 && end > start) s = s.substring(start, end + 1);
  return JSON.parse(s);
}

/**
 * Build a compact memory block string from structured memory for injection into prompts.
 * Memory captures key corrections and context from prior conversation turns so we don't
 * need to replay the full chat history every time.
 */
export function buildMemoryBlock(memory) {
  if (!memory) return "";
  const parts = [];

  if (memory.corrections?.length) {
    parts.push("PRIOR CORRECTIONS (apply these — the user already told us):");
    for (const c of memory.corrections) {
      if (c.from) {
        parts.push(`  • ${c.field}: "${c.from}" → "${c.to}"`);
      } else {
        parts.push(`  • ${c.field}: set to "${c.to}"`);
      }
    }
  }

  if (memory.confirmed_facts?.length) {
    parts.push("CONFIRMED FACTS:");
    for (const f of memory.confirmed_facts) {
      parts.push(`  • ${f}`);
    }
  }

  if (memory.user_preferences?.length) {
    parts.push("USER PREFERENCES (mentioned during conversation):");
    for (const p of memory.user_preferences) {
      parts.push(`  • ${p}`);
    }
  }

  if (memory.context_notes?.length) {
    parts.push("CONTEXT NOTES:");
    for (const n of memory.context_notes) {
      parts.push(`  • ${n}`);
    }
  }

  return parts.length ? "\n\nCONVERSATION MEMORY:\n" + parts.join("\n") : "";
}

/**
 * Extract/update structured memory from the conversation so far.
 * Uses Claude Haiku for speed and cost efficiency.
 * Returns a compact memory object that replaces the need for full chat history.
 *
 * @param {object} originalItem - The original identified item
 * @param {object} updatedItem - The item after this refinement
 * @param {string} userMessage - The latest user message
 * @param {string} aiMessage - The latest AI response
 * @param {object|null} existingMemory - Previous memory to update (or null for first turn)
 * @returns {Promise<object>} Updated memory object
 */
export async function extractMemory(originalItem, updatedItem, userMessage, aiMessage, existingMemory = null) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);

  const existingBlock = existingMemory ? `\nExisting memory to update:\n${JSON.stringify(existingMemory, null, 2)}` : "";

  const prompt = `Extract key context from this clothing item refinement conversation turn into a structured memory object. This memory will be passed to future AI calls instead of replaying the full conversation.
${existingBlock}

Original item: ${JSON.stringify(originalItem, null, 2)}
Updated item: ${JSON.stringify(updatedItem, null, 2)}
User said: "${userMessage}"
AI responded: "${aiMessage}"

Return ONLY valid JSON (no markdown, no backticks):
{
  "corrections": [
    { "field": "brand", "from": "Unidentified", "to": "Nike" }
  ],
  "confirmed_facts": ["User confirmed it's a vintage piece from the 90s"],
  "user_preferences": ["Prefers exact brand match over alternatives"],
  "context_notes": ["Item was partially obscured in photo"],
  "turn_count": ${(existingMemory?.turn_count || 0) + 1}
}

RULES:
- "corrections": Merge with existing corrections. If the same field was corrected again, keep only the latest. Each entry needs "field" and "to", optionally "from".
- "confirmed_facts": Key facts the user confirmed or stated. Deduplicate with existing. Max 5.
- "user_preferences": Shopping/style preferences mentioned. Deduplicate. Max 3.
- "context_notes": Important context about the photo or item. Max 3.
- Keep everything concise — this is a memory aid, not a transcript.
- If existing memory has entries that are still valid, preserve them.`;

  try {
    const res = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 600,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    clearTimeout(timeout);
    if (!res.ok) {
      console.error(`[Memory] API ${res.status}`);
      return existingMemory || null; // fail open — keep old memory
    }

    const data = await res.json();
    const text = data.content?.map(c => c.text || "").join("") || "";
    const parsed = parseJSON(text);

    // Validate and sanitize
    return {
      corrections: Array.isArray(parsed.corrections) ? parsed.corrections.slice(0, 10) : [],
      confirmed_facts: Array.isArray(parsed.confirmed_facts) ? parsed.confirmed_facts.slice(0, 5) : [],
      user_preferences: Array.isArray(parsed.user_preferences) ? parsed.user_preferences.slice(0, 3) : [],
      context_notes: Array.isArray(parsed.context_notes) ? parsed.context_notes.slice(0, 3) : [],
      turn_count: (existingMemory?.turn_count || 0) + 1,
    };
  } catch (err) {
    clearTimeout(timeout);
    console.error(`[Memory] Error: ${err.message}`);
    return existingMemory || null; // fail open
  }
}

/**
 * Refine an identified clothing item based on user correction/input.
 * Uses structured memory for context persistence instead of replaying full chat history.
 * Returns { updated_item, ai_message }.
 *
 * @param {object} originalItem - The item to refine
 * @param {string} userMessage - User's correction/input
 * @param {object[]} chatHistory - Recent chat turns (kept short — last 4 messages max)
 * @param {object|null} memory - Structured memory from previous turns
 */
export async function refineItem(originalItem, userMessage, chatHistory = [], memory = null) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);

  const memoryBlock = buildMemoryBlock(memory);

  const systemPrompt = `You are refining a clothing identification. The user is correcting or adjusting what was initially detected in their photo. Update the item JSON to reflect the correction.
${memoryBlock}
SEARCH QUERY RULES: The search_query goes directly into Google Shopping. Keep under 80 chars. Start with "men's" or "women's". If brand is known, include it. NO adjectives like "stylish" or "elegant". Use product terms only.

IMPORTANT: If CONVERSATION MEMORY is provided above, treat those corrections and facts as already established — apply them to the item AND incorporate the user's new message. Do not ask the user to re-confirm things already in memory.

Return ONLY valid JSON in this exact format (no markdown, no backticks):
{
  "updated_item": {
    "name": "...",
    "brand": "...",
    "brand_confidence": "confirmed|high|moderate|low",
    "brand_evidence": "...",
    "product_line": "...",
    "category": "outerwear|top|bottom|shoes|accessory|dress|bag",
    "subcategory": "...",
    "color": "specific color (e.g. 'heather grey' not just 'grey')",
    "material": "specific material with type (e.g. 'cotton french terry', 'stretch denim')",
    "fit": "slim|regular|relaxed|oversized|cropped|tailored|boxy",
    "construction_details": "notable details (e.g. 'contrast stitching, raw hem')",
    "search_query": "Google Shopping query under 80 chars following rules above",
    "style_keywords": ["vibe keywords like 'streetwear', 'minimalist', 'preppy'"],
    "alt_search": "brand-agnostic alternative: [gender] [color] [material] [subcategory]"
  },
  "ai_message": "Brief friendly confirmation of what you updated, 1-2 sentences."
}`;

  // When memory exists, only send the last 4 chat messages for immediate context
  // (the rest is captured in the memory object). Without memory, send full history.
  const recentHistory = memory && chatHistory.length > 4
    ? chatHistory.slice(-4)
    : chatHistory;

  const messages = [
    ...recentHistory.map(m => ({ role: m.role, content: m.content })),
    {
      role: "user",
      content: `Original item: ${JSON.stringify(originalItem, null, 2)}\n\nUser says: "${userMessage}"\n\nPlease update the item identification accordingly.`,
    },
  ];

  try {
    const res = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 1000,
        system: systemPrompt,
        messages,
      }),
    });

    clearTimeout(timeout);
    if (!res.ok) throw new Error(`Anthropic API ${res.status}`);

    const data = await res.json();
    const text = data.content?.map(c => c.text || "").join("") || "";
    return parseJSON(text);
  } catch (err) {
    clearTimeout(timeout);
    if (err.name === "AbortError") throw new Error("Refinement timed out — please try again");
    throw err;
  }
}

/**
 * Suggest complementary items to complete an outfit based on what was identified.
 * Returns { pairings: [{ name, category, why, search_query }] }
 */
export async function suggestPairings(identifiedItems, gender, budget) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);

  const itemSummary = identifiedItems.map(it => `- ${it.name} (${it.category})`).join("\n");
  const genderLabel = gender === "female" ? "women's" : "men's";
  const budgetStr = budget ? `Budget: $${budget} per item.` : "";

  const prompt = `A person is wearing the following items:\n${itemSummary}\n\nSuggest 2-3 complementary pieces that would complete this ${genderLabel} outfit. Focus on items that are MISSING from the look (e.g. if there are no shoes, suggest shoes; if no bag, suggest a bag). ${budgetStr}\n\nReturn ONLY valid JSON (no markdown, no backticks):\n{\n  "pairings": [\n    {\n      "name": "White leather sneakers",\n      "category": "shoes",\n      "why": "Clean, versatile — pairs perfectly with the relaxed vibe",\n      "search_query": "${genderLabel} white leather sneakers casual"\n    }\n  ]\n}`;

  try {
    const res = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 600,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    clearTimeout(timeout);
    if (!res.ok) throw new Error(`Anthropic API ${res.status}`);
    const data = await res.json();
    const text = data.content?.map(c => c.text || "").join("") || "";
    return parseJSON(text);
  } catch (err) {
    clearTimeout(timeout);
    if (err.name === "AbortError") throw new Error("Pairing suggestion timed out");
    throw err;
  }
}

/**
 * AI re-ranking: evaluate search result candidates against the original identified item.
 * This is the "stylist layer" — it understands vibe, style, and quality match beyond
 * keyword matching. Returns re-scored candidates with style match ratings.
 *
 * @param {object} item - The identified clothing item from Claude Vision
 * @param {object[]} candidates - Top search result candidates (max 15 per call to control cost)
 * @param {string} occasion - Optional occasion context
 * @returns {Promise<object[]>} candidates with added `ai_score` (0-100) and `ai_reason` fields
 */
export async function rerankCandidates(item, candidates, occasion = null, userContext = null) {
  if (!candidates.length) return [];

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);

  const candidateList = candidates.map((c, i) => ({
    idx: i,
    title: (c.product_name || c.title || "").slice(0, 100),
    brand: (c.brand || c.source || "").slice(0, 40),
    price: c.price || "unknown",
  }));

  // Build user preference context block if available
  let userPrefBlock = "";
  if (userContext) {
    const parts = [];
    if (userContext.budgetMin != null || userContext.budgetMax != null) {
      const range = userContext.budgetMin && userContext.budgetMax
        ? `$${userContext.budgetMin}–$${userContext.budgetMax}`
        : userContext.budgetMax ? `up to $${userContext.budgetMax}` : `$${userContext.budgetMin}+`;
      parts.push(`Budget: ${range}`);
    }
    if (userContext.likedBrands?.length) {
      parts.push(`Brands they love: ${userContext.likedBrands.slice(0, 8).join(", ")}`);
    }
    if (userContext.avoidedBrands?.length) {
      parts.push(`Brands they avoid: ${userContext.avoidedBrands.slice(0, 5).join(", ")}`);
    }
    if (userContext.preferredCategories?.length) {
      parts.push(`Preferred categories: ${userContext.preferredCategories.slice(0, 5).join(", ")}`);
    }
    if (userContext.positiveColors?.length) {
      parts.push(`Favorite colors: ${userContext.positiveColors.slice(0, 5).join(", ")}`);
    }
    if (userContext.negativeColors?.length) {
      parts.push(`Colors they dislike: ${userContext.negativeColors.slice(0, 5).join(", ")}`);
    }
    if (userContext.styleKeywords?.length) {
      parts.push(`Style vibe: ${userContext.styleKeywords.slice(0, 6).join(", ")}`);
    }
    if (parts.length) {
      userPrefBlock = `\nUSER PREFERENCES (from their history — use this to break ties and boost personalized matches):
${parts.map(p => `- ${p}`).join("\n")}`;
    }
  }

  const prompt = `You are a fashion stylist evaluating product search results. Rate how well each candidate matches the target item.

TARGET ITEM:
- Name: ${item.name}
- Brand: ${item.brand || "Unidentified"} (confidence: ${item.brand_confidence || "low"})
- Category: ${item.category} / ${item.subcategory}
- Color: ${item.color}
- Material: ${item.material}
- Fit: ${item.fit}
- Style vibe: ${(item.style_keywords || []).join(", ") || "not specified"}
- Construction: ${item.construction_details || "not specified"}
${occasion ? `- Occasion: ${occasion}` : ""}
${userPrefBlock}

CANDIDATES:
${candidateList.map(c => `[${c.idx}] "${c.title}" by ${c.brand} — ${c.price}`).join("\n")}

For each candidate, score 0-100 on how well it matches the target item:
- 90-100: Exact or near-exact match (same brand, same product line, same style)
- 70-89: Very strong match (same type, similar style/quality/vibe, would satisfy the user)
- 50-69: Decent match (right category, somewhat similar style, acceptable alternative)
- 30-49: Weak match (right category but wrong style, quality tier, or vibe)
- 0-29: Poor match (wrong item, wrong style, clearly not what the user is looking for)

Consider: brand tier match, material quality match, style/aesthetic match, silhouette match, and color match. A $15 fast-fashion dupe of a $500 designer item should score 30-50 (right look, wrong tier). A same-tier same-vibe alternative should score 70+.
${userPrefBlock ? "\nPERSONALIZATION: When two candidates score similarly on item match, boost the one that aligns with the user's brand/color/style preferences. A candidate from an avoided brand should lose 5-10 points. A candidate in a favorite color or from a loved brand gains 5-10 points. Budget fit matters — products near the middle of their budget range are ideal." : ""}

IMPORTANT: You MUST return a score for EVERY candidate idx listed above. Do not skip any.

Return JSON only — no markdown, no backticks:
{ "scores": [ { "idx": 0, "score": 75, "reason": "brief reason" }, { "idx": 1, "score": 60, "reason": "brief reason" } ] }`;

  try {
    const res = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 1500,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    clearTimeout(timeout);
    if (!res.ok) {
      console.error(`[Rerank] API ${res.status}`);
      return candidates; // fail open — return unranked
    }

    const data = await res.json();
    const text = data.content?.map(c => c.text || "").join("") || "";
    const parsed = parseJSON(text);
    const scoreMap = new Map();
    for (const s of (parsed.scores || [])) {
      scoreMap.set(s.idx, { score: s.score || 0, reason: s.reason || "" });
    }

    return candidates.map((c, i) => {
      const aiResult = scoreMap.get(i);
      return {
        ...c,
        ai_score: aiResult ? aiResult.score : 50,
        ai_reason: aiResult ? aiResult.reason : "",
      };
    });
  } catch (err) {
    clearTimeout(timeout);
    console.error(`[Rerank] Error: ${err.message}`);
    return candidates; // fail open
  }
}

export async function identifyClothing(base64Image, mimeType, userPrefs, priorityRegionBase64) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000); // 15s max — identification should be fast

  const contentBlocks = [
    {
      type: "image",
      source: {
        type: "base64",
        media_type: mimeType,
        data: base64Image,
      },
    },
  ];

  if (priorityRegionBase64) {
    contentBlocks.push({
      type: "image",
      source: {
        type: "base64",
        media_type: mimeType,
        data: priorityRegionBase64,
      },
    });
    contentBlocks.push({
      type: "text",
      text: "The second image is a cropped region the user circled. Identify this specific item first and mark it with priority: true in your response.",
    });
  }

  contentBlocks.push({ type: "text", text: buildIdentifyPrompt(userPrefs) });

  try {
    const res = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 2000,
        messages: [
          {
            role: "user",
            content: contentBlocks,
          },
        ],
      }),
    });

    clearTimeout(timeout);

    if (!res.ok) {
      const errBody = await res.text();
      throw new Error(`Anthropic API ${res.status}: ${errBody}`);
    }

    const data = await res.json();
    if (data.error) throw new Error(data.error.message);

    const text = data.content?.map((c) => c.text || "").join("") || "";
    return parseJSON(text);
  } catch (err) {
    clearTimeout(timeout);
    if (err.name === "AbortError") throw new Error("AI identification timed out — please try again");
    throw err;
  }
}
