/**
 * Calls the Anthropic Claude API to identify clothing items in a photo.
 * The API key is only used server-side — never exposed to the client.
 */

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";

function buildIdentifyPrompt(prefs) {
  const genderLabel = prefs.gender === "female" ? "women's" : prefs.gender === "male" ? "men's" : null;
  return `You are an expert fashion analyst and personal stylist with deep knowledge of brands, materials, and construction. Identify EXACTLY what each person is wearing with the precision of a luxury retail buyer.

STRICT RULES:
1. VISIBILITY: Only include items where 70%+ of the garment is clearly visible. Exception: if a specific region was circled/highlighted by the user, include that item regardless of visibility percentage.
2. ONE PER GARMENT: One jacket = one entry. Never list the same physical item twice.
3. LAYERING LOGIC: Typical outfit = 1 outerwear + 1 top + 1 bottom + 0-1 shoes + 0-few accessories. If exceeding this, you're duplicating.
4. CLOTHING ONLY: Only clothing, shoes, bags, jewelry, hats, and fashion accessories. NEVER identify non-fashion items (food, drinks, electronics, furniture, vehicles, animals).
5. GENDER: Return "male" or "female" based on the clothing.${prefs.gender ? ` User preference: ${prefs.gender}.` : ""} If ambiguous, default to preference.
6. ITEM LIMIT: 3-5 most prominent items. Quality over quantity.

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
4. Keep under 60 characters
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
      "search_query": "Google Shopping optimised query under 60 chars — follow the SEARCH QUERY RULES above",
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
 * Refine an identified clothing item based on user correction/input.
 * Returns { updated_item, ai_message }.
 */
export async function refineItem(originalItem, userMessage, chatHistory = []) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);

  const systemPrompt = `You are refining a clothing identification. The user is correcting or adjusting what was initially detected in their photo. Update the item JSON to reflect the correction. Return ONLY valid JSON in this exact format (no markdown, no backticks):
{
  "updated_item": {
    "name": "...",
    "brand": "...",
    "brand_confidence": "confirmed|high|moderate|low",
    "brand_evidence": "...",
    "product_line": "...",
    "category": "outerwear|top|bottom|shoes|accessory|dress|bag",
    "subcategory": "...",
    "color": "...",
    "material": "...",
    "fit": "slim|regular|relaxed|oversized|cropped",
    "search_query": "best Google Shopping search for this item",
    "style_keywords": ["..."],
    "alt_search": "brand-agnostic alternative search"
  },
  "ai_message": "Brief friendly confirmation of what you updated, 1-2 sentences."
}`;

  const messages = [
    ...chatHistory.map(m => ({ role: m.role, content: m.content })),
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
        model: "claude-sonnet-4-6",
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
export async function rerankCandidates(item, candidates, occasion = null) {
  if (!candidates.length) return [];

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);

  const candidateList = candidates.map((c, i) => ({
    idx: i,
    title: (c.product_name || c.title || "").slice(0, 100),
    brand: (c.brand || c.source || "").slice(0, 40),
    price: c.price || "unknown",
  }));

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

CANDIDATES:
${candidateList.map(c => `[${c.idx}] "${c.title}" by ${c.brand} — ${c.price}`).join("\n")}

For each candidate, score 0-100 on how well it matches the target item:
- 90-100: Exact or near-exact match (same brand, same product line, same style)
- 70-89: Very strong match (same type, similar style/quality/vibe, would satisfy the user)
- 50-69: Decent match (right category, somewhat similar style, acceptable alternative)
- 30-49: Weak match (right category but wrong style, quality tier, or vibe)
- 0-29: Poor match (wrong item, wrong style, clearly not what the user is looking for)

Consider: brand tier match, material quality match, style/aesthetic match, silhouette match, and color match. A $15 fast-fashion dupe of a $500 designer item should score 30-50 (right look, wrong tier). A same-tier same-vibe alternative should score 70+.

Return JSON only — no markdown, no backticks:
{ "scores": [ { "idx": 0, "score": 75, "reason": "brief reason" } ] }`;

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
  const timeout = setTimeout(() => controller.abort(), 30000);

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
        model: "claude-sonnet-4-6",
        max_tokens: 3000,
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
