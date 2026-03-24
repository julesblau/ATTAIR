import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import { refineItem } from "../services/claude.js";
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
 *   chat_history: [ { role: "user", content: "..." }, { role: "assistant", content: "..." } ]
 * }
 *
 * Response: {
 *   updated_item: { ... },
 *   ai_message: "Got it — updated to olive green bomber jacket.",
 *   new_tiers: { budget: {...}, mid: {...}, premium: {...} }
 * }
 */
router.post("/", requireAuth, async (req, res) => {
  const { scan_id, item_index, original_item, user_message, chat_history = [], gender = "male" } = req.body;

  if (!original_item || !user_message) {
    return res.status(400).json({ error: "Missing original_item or user_message" });
  }

  try {
    // 1. Refine the item via Claude
    const refined = await refineItem(original_item, user_message, chat_history);
    if (!refined || !refined.updated_item) {
      return res.status(500).json({ error: "Refinement failed — unexpected response from AI" });
    }

    const { updated_item, ai_message } = refined;

    // 2. Get profile for budget/size defaults
    const { data: profile } = await supabase
      .from("profiles")
      .select("budget_min, budget_max, size_prefs")
      .eq("id", req.userId)
      .single();

    // 3. Re-search products for the refined item (no Lens image, text search only)
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

    return res.json({
      updated_item,
      ai_message: ai_message || "Updated. Re-searching now.",
      new_tiers: newTiers,
    });
  } catch (err) {
    // SECURITY: Do not forward err.message to the client — it can contain Anthropic API error
    // bodies or internal service details. Log server-side only.
    console.error("Refine item error:", err.message);
    return res.status(500).json({ error: "Refinement failed" });
  }
});

export default router;
