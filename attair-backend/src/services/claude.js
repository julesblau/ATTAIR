/**
 * Calls the Anthropic Claude API to identify clothing items in a photo.
 * The API key is only used server-side — never exposed to the client.
 */

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";

function buildIdentifyPrompt(prefs) {
  return `You are a fashion identification system. Your job is to look at this photo and tell me EXACTLY what each person is wearing. Be precise. Be honest.

STRICT RULES:
1. VISIBILITY: Only include items where 70%+ of the garment is clearly visible. Exception: if a specific region was circled/highlighted by the user, include that item regardless of visibility percentage. Cropped shoes, barely-visible hats = skip them.
2. ONE PER GARMENT: One jacket = one entry. Never list the same physical item twice with different descriptions.
3. LAYERING LOGIC: A typical outfit is 1 outerwear + 1 top + 1 bottom + 0-1 visible shoes + 0-few accessories. If your count exceeds this, you're probably duplicating.
4. BRAND HONESTY:
   - "confirmed" = you can SEE the logo, text, or monogram in the image
   - "high" = 2+ distinctive design cues (specific silhouette + hardware + stitching pattern)
   - "moderate" = general style suggests a brand but no hard evidence
   - "low" = pure guess based on aesthetic
   If you can't identify with at least moderate confidence, say "Unidentified"
5. GENDER: Determine from the photo whether this is men's or women's clothing. This MUST be returned as "male" or "female" in the gender field. If ambiguous, default to the user's preference if provided${prefs.gender ? ` (user preference: ${prefs.gender})` : ""}.
6. ITEM LIMIT: Focus on the 3-5 most prominent, clearly visible garments. Ignore partially hidden items, undergarments, socks, and small accessories unless they are the main focus of the photo.

For each item, think: "If someone searched for this exact item online, what would they type?" That's your search_query.

Return JSON only — no markdown, no backticks:
{
  "gender": "male|female",
  "summary": "One sentence describing the overall outfit",
  "items": [
    {
      "name": "Specific product name",
      "brand": "Brand or 'Unidentified'",
      "brand_confidence": "confirmed|high|moderate|low",
      "brand_evidence": "Specific visual evidence",
      "product_line": "Model/line if known",
      "category": "outerwear|top|bottom|shoes|accessory|dress|bag",
      "subcategory": "hoodie|jacket|blazer|t-shirt|jeans|sneakers|etc",
      "color": "specific color",
      "material": "specific material",
      "fit": "slim|regular|relaxed|oversized|cropped",
      "position_y": 0.0 to 1.0,
      "visibility_pct": 50 to 100,
      "search_query": "best search to find this item for ${prefs.gender || "any gender"}",
      "style_keywords": ["keyword1", "keyword2"],
      "alt_search": "brand-agnostic alternative search query",
      "identification_confidence": 20 to 99,
      "price_range": "$XX - $XX"
    }
  ]
}

Budget: ${prefs.budget || "any"}. Quality over quantity. 3 accurate items beats 6 wrong ones.`;
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
