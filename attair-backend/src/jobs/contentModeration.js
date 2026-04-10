import supabase from "../lib/supabase.js";

/**
 * Background content moderation for the public feed.
 *
 * Periodically checks recent public scans that haven't been moderated yet.
 * Uses Haiku vision to flag inappropriate content (nudity, violence, etc.).
 * Flagged scans are set to visibility: "private" to remove from the feed.
 *
 * Runs every 5 minutes via setInterval from index.js.
 * Each run checks up to 10 unmoderated scans to control API costs.
 */

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const BATCH_SIZE = 10;
const MODERATION_INTERVAL = 5 * 60 * 1000; // 5 minutes

async function moderateScan(scan) {
  if (!scan.image_url) return { safe: true };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);

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
        max_tokens: 100,
        messages: [{
          role: "user",
          content: [
            {
              type: "image",
              source: { type: "url", url: scan.image_url },
            },
            {
              type: "text",
              text: 'Is this image appropriate for a fashion shopping app? Check for: nudity, sexually explicit content, graphic violence, gore, hate symbols, illegal activity, or non-fashion content (memes, spam, screenshots). Reply ONLY with JSON: {"safe": true} or {"safe": false, "reason": "brief reason"}',
            },
          ],
        }],
      }),
    });

    clearTimeout(timeout);
    if (!res.ok) return { safe: true }; // fail open — don't block content on API errors

    const data = await res.json();
    const text = data.content?.[0]?.text || "";
    try {
      const jsonStart = text.indexOf("{");
      const jsonEnd = text.lastIndexOf("}");
      if (jsonStart >= 0 && jsonEnd > jsonStart) {
        return JSON.parse(text.substring(jsonStart, jsonEnd + 1));
      }
    } catch {}
    return { safe: true }; // fail open on parse errors
  } catch {
    clearTimeout(timeout);
    return { safe: true }; // fail open
  }
}

async function runModerationBatch() {
  try {
    // Find recent public scans that haven't been moderated
    const { data: scans, error } = await supabase
      .from("scans")
      .select("id, image_url, user_id, visibility")
      .eq("visibility", "public")
      .is("moderated_at", null)
      .order("created_at", { ascending: false })
      .limit(BATCH_SIZE);

    if (error || !scans || scans.length === 0) return;

    console.log(`[Moderation] Checking ${scans.length} unmoderated public scans...`);

    let flagged = 0;
    for (const scan of scans) {
      const result = await moderateScan(scan);

      if (!result.safe) {
        flagged++;
        console.warn(`[Moderation] FLAGGED scan ${scan.id}: ${result.reason}`);
        // Hide from feed
        await supabase
          .from("scans")
          .update({ visibility: "private", moderated_at: new Date().toISOString(), moderation_reason: result.reason })
          .eq("id", scan.id);
      } else {
        // Mark as moderated (safe)
        await supabase
          .from("scans")
          .update({ moderated_at: new Date().toISOString() })
          .eq("id", scan.id);
      }
    }

    if (flagged > 0) {
      console.warn(`[Moderation] Flagged ${flagged}/${scans.length} scans`);
    } else {
      console.log(`[Moderation] All ${scans.length} scans clear`);
    }
  } catch (err) {
    console.error("[Moderation] Error:", err.message);
  }
}

export function startContentModeration() {
  // Don't start if no API key (local dev without Anthropic)
  if (!process.env.ANTHROPIC_API_KEY) {
    console.log("[Moderation] Skipped — no ANTHROPIC_API_KEY");
    return;
  }

  // Run first batch after 30 seconds (let server boot first)
  setTimeout(runModerationBatch, 30000);

  // Then every 5 minutes
  setInterval(runModerationBatch, MODERATION_INTERVAL);
  console.log("  🛡️  Content moderation scheduled (every 5 min)");
}
