import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import { findProductsForItems } from "../services/products.js";
import supabase from "../lib/supabase.js";

const router = Router();

/**
 * POST /api/find-products
 *
 * Request:  { items: [...identified items], gender: "male"|"female", scan_id?: "uuid" }
 * Response: [ { item_index, brand_verified, tiers: { budget, mid, premium } } ]
 */
router.post("/", requireAuth, async (req, res) => {
  const { items, gender, scan_id } = req.body;

  if (!items || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: "Missing or empty items array" });
  }

  if (!gender || !["male", "female"].includes(gender)) {
    return res.status(400).json({ error: 'gender must be "male" or "female"' });
  }

  try {
    // Get user's budget preferences
    const { data: profile } = await supabase
      .from("profiles")
      .select("budget_min, budget_max")
      .eq("id", req.userId)
      .single();

    // Get the scan's image URL for Google Lens visual search
    let imageUrl = null;
    if (scan_id) {
      const { data: scan } = await supabase
        .from("scans")
        .select("image_url")
        .eq("id", scan_id)
        .eq("user_id", req.userId)
        .single();
      imageUrl = scan?.image_url || null;
    }

    const results = await findProductsForItems(items, gender, profile?.budget_min, profile?.budget_max, imageUrl);

    // Persist tier results back to the scan row
    if (scan_id) {
      await supabase
        .from("scans")
        .update({ tiers: results })
        .eq("id", scan_id)
        .eq("user_id", req.userId);
    }

    return res.json(results);
  } catch (err) {
    console.error("Find products error:", err.message);
    return res.status(500).json({
      error: "Product search failed",
      message: err.message,
    });
  }
});

export default router;