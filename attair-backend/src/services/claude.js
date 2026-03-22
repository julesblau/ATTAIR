/**
 * Calls the Anthropic Claude API to identify clothing items in a photo.
 * The API key is only used server-side — never exposed to the client.
 */

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";

function buildIdentifyPrompt(prefs) {
  return `You are a fashion identification system. Your job is to look at this photo and tell me EXACTLY what each person is wearing. Be precise. Be honest.

STRICT RULES:
1. VISIBILITY: Only include items where 50%+ of the garment is clearly visible. Cropped shoes, barely-visible hats = skip them.
2. ONE PER GARMENT: One jacket = one entry. Never list the same physical item twice with different descriptions.
3. LAYERING LOGIC: A typical outfit is 1 outerwear + 1 top + 1 bottom + 0-1 visible shoes + 0-few accessories. If your count exceeds this, you're probably duplicating.
4. BRAND HONESTY:
   - "confirmed" = you can SEE the logo, text, or monogram in the image
   - "high" = 2+ distinctive design cues (specific silhouette + hardware + stitching pattern)
   - "moderate" = general style suggests a brand but no hard evidence
   - "low" = pure guess based on aesthetic
   If you can't identify with at least moderate confidence, say "Unidentified"
5. GENDER: Determine from the photo whether this is men's or women's clothing.

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

export async function identifyClothing(base64Image, mimeType, userPrefs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);

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
      model: "claude-sonnet-4-20250514",
      max_tokens: 3000,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: {
                type: "base64",
                media_type: mimeType,
                data: base64Image,
              },
            },
            { type: "text", text: buildIdentifyPrompt(userPrefs) },
          ],
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
