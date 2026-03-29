import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import { refineItem, extractMemory } from "../services/claude.js";
import { findProductsForItems } from "../services/products.js";
import supabase from "../lib/supabase.js";

const router = Router();

/**
 * POST /api/refine-item
 *
 * Request: {
 *   scan_id: "uuid",
 *   item_index: 0,
 *   original_item: { name, brand, category, subcategory, color, ... },
 *   user_message: "It's actually a bomber jacket, olive green",
 *   chat_history: [ { role: "user", content: "..." }, { role: "assistant", content: "..." } ],
 *   memory: { corrections: [...], confirmed_facts: [...], ... } | null
 * }
 *
 * Response: {
 *   updated_item: { ... },
 *   ai_message: "Got it — updated to olive green bomber jacket.",
 *   new_tiers: { budget: {...}, mid: {...}, premium: {...} },
 *   memory: { corrections: [...], confirmed_facts: [...], turn_count: N }
 * }
 */
router.post("/", requireAuth, async (req, res) => {
  const { scan_id, item_index, original_item, user_message, chat_history = [], gender = "male", memory = null } = req.body;

  if (!original_item || !user_message) {
    return res.status(400).json({ error: "Missing original_item or user_message" });
  }

  // Cap user_message length to prevent prompt injection and cost abuse
  if (user_message && user_message.length > 500) {
    return res.status(400).json({ error: "Message too long (max 500 characters)" });
  }

  // Validate chat_history entries
  if (Array.isArray(chat_history)) {
    if (chat_history.length > 20) {
      return res.status(400).json({ error: "Chat history too long (max 20 turns)" });
    }
    for (const msg of chat_history) {
      if (!["user", "assistant"].includes(msg.role)) {
        return res.status(400).json({ error: "Invalid chat history role" });
      }
      if (typeof msg.content !== "string" || msg.content.length > 2000) {
        return res.status(400).json({ error: "Invalid chat history content" });
      }
    }
  }

  // Validate memory object if provided
  if (memory !== null && memory !== undefined) {
    if (typeof memory !== "object" || Array.isArray(memory)) {
      return res.status(400).json({ error: "Invalid memory format" });
    }
    // Cap memory arrays to prevent abuse
    const memArrays = ["corrections", "confirmed_facts", "user_preferences", "context_notes"];
    for (const key of memArrays) {
      if (memory[key] && (!Array.isArray(memory[key]) || memory[key].length > 15)) {
        return res.status(400).json({ error: `Invalid memory.${key}` });
      }
    }
  }

  try {
    // Verify scan_id belongs to this user (if provided)
    if (scan_id) {
      const { data: scanRow } = await supabase
        .from("scans")
        .select("id")
        .eq("id", scan_id)
        .eq("user_id", req.userId)
        .single();
      if (!scanRow) {
        return res.status(404).json({ error: "Scan not found" });
      }
    }

    // 1. Refine the item via Claude (pass memory for context persistence)
    const refined = await refineItem(original_item, user_message, chat_history, memory);
    if (!refined || !refined.updated_item) {
      return res.status(500).json({ error: "Refinement failed — unexpected response from AI" });
    }

    const { updated_item, ai_message } = refined;

    // 2. Extract/update memory in background (non-blocking for response speed)
    //    Memory extraction runs concurrently with product search
    const memoryPromise = extractMemory(
      original_item,
      updated_item,
      user_message,
      ai_message || "Updated.",
      memory
    ).catch(err => {
      console.error("[Memory] extraction failed:", err.message);
      return memory; // fall back to existing memory
    });

    // 3. Get profile for budget/size defaults
    const { data: profile } = await supabase
      .from("profiles")
      .select("budget_min, budget_max, size_prefs")
      .eq("id", req.userId)
      .single();

    // 4. Re-search products for the refined item (no Lens image, text search only)
    const searchItems = [{ ...updated_item, _scan_item_index: item_index ?? 0 }];
    const searchResults = await findProductsForItems(
      searchItems,
      gender,
      profile?.budget_min,
      profile?.budget_max,
      null,           // no image URL for text-only re-search
      profile?.size_prefs || {}
    );

    const newTiers = searchResults?.[0]?.tiers || null;

    // 5. Await memory extraction (should be done by now since product search is slower)
    const updatedMemory = await memoryPromise;

    // 6. Persist memory to scan items in Supabase (fire-and-forget, don't block response)
    if (scan_id && updatedMemory && item_index != null) {
      supabase
        .from("scans")
        .select("items")
        .eq("id", scan_id)
        .eq("user_id", req.userId)
        .single()
        .then(({ data: scanData }) => {
          if (scanData?.items && Array.isArray(scanData.items)) {
            const items = [...scanData.items];
            if (items[item_index]) {
              items[item_index] = { ...items[item_index], _memory: updatedMemory };
              supabase
                .from("scans")
                .update({ items })
                .eq("id", scan_id)
                .eq("user_id", req.userId)
                .then(({ error }) => {
                  if (error) console.error("[Memory] persist error:", error.message);
                });
            }
          }
        })
        .catch(err => console.error("[Memory] persist error:", err.message));
    }

    return res.json({
      updated_item,
      ai_message: ai_message || "Updated. Re-searching now.",
      new_tiers: newTiers,
      memory: updatedMemory || null,
    });
  } catch (err) {
    // SECURITY: Do not forward err.message to the client — it can contain Anthropic API error
    // bodies or internal service details. Log server-side only.
    console.error("Refine item error:", err.message);
    return res.status(500).json({ error: "Refinement failed" });
  }
});

export default router;
