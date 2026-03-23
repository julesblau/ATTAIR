import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import { suggestPairings } from "../services/claude.js";
import supabase from "../lib/supabase.js";

const router = Router();

/**
 * POST /api/suggest-pairings
 *
 * Request: { scan_id, items: [{name, category, ...}], gender }
 * Response: { pairings: [{ name, category, why, search_query }] }
 */
router.post("/", requireAuth, async (req, res) => {
  const { scan_id, items, gender = "male" } = req.body;

  if (!items || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: "Missing items array" });
  }

  try {
    const { data: profile } = await supabase
      .from("profiles")
      .select("budget_max")
      .eq("id", req.userId)
      .single();

    const result = await suggestPairings(items, gender, profile?.budget_max);
    if (!result || !Array.isArray(result.pairings)) {
      return res.status(500).json({ error: "No pairings returned" });
    }

    return res.json({ pairings: result.pairings });
  } catch (err) {
    console.error("Suggest pairings error:", err.message);
    return res.status(500).json({ error: "Failed to suggest pairings", message: err.message });
  }
});

export default router;
