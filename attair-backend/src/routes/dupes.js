import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import { findDupes } from "../services/dupes.js";

const router = Router();

/**
 * POST /api/dupes
 *
 * Request body:
 *   {
 *     product_name: string,       — e.g. "Gucci GG Marmont Mini Bag"
 *     description: string,        — material, color, construction details
 *     price: number,              — original price in USD (e.g. 1250)
 *     image_url?: string,         — URL of the original product image
 *     category?: string,          — "bag", "shoes", "top", etc.
 *     gender?: "male"|"female"    — defaults to "female"
 *   }
 *
 * Response:
 *   {
 *     dupes: [
 *       {
 *         product_name: string,
 *         brand: string,
 *         price: string,
 *         price_numeric: number,
 *         image_url: string,
 *         url: string,
 *         store: string,
 *         savings_pct: number,
 *         similarity_score: number,
 *         similarity_reason: string,
 *       }
 *     ],
 *     original: { name, price, image_url }
 *   }
 */
router.post("/", requireAuth, async (req, res) => {
  const { product_name, description, price, image_url, category, gender } = req.body;

  // ── Validation ──
  if (!product_name || typeof product_name !== "string" || !product_name.trim()) {
    return res.status(400).json({ error: "product_name is required" });
  }
  if (price == null || typeof price !== "number" || price <= 0) {
    return res.status(400).json({ error: "price must be a positive number" });
  }
  if (price < 150) {
    return res.status(400).json({ error: "Dupe search is only available for items priced $150+" });
  }

  try {
    const result = await findDupes({
      productName: product_name.trim().slice(0, 200),
      description: (description || "").trim().slice(0, 500),
      price,
      imageUrl: (image_url || "").trim().slice(0, 2000),
      category: (category || "").trim().slice(0, 50),
      gender: gender === "male" ? "male" : "female",
    });

    res.json(result);
  } catch (err) {
    console.error("[DUPES]", err.message);
    res.status(500).json({ error: "Dupe search failed — please try again" });
  }
});

export default router;
