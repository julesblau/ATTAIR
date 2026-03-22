import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import supabase from "../lib/supabase.js";

const router = Router();

const VALID_AD_TYPES = ["interstitial", "banner", "native", "upgrade_prompt"];
const VALID_PLACEMENTS = ["post_scan", "results_banner", "retailer_list", "upgrade_modal"];
const VALID_ACTIONS = ["impression", "click", "dismiss", "upgrade_clicked"];

/**
 * POST /api/ad-events
 * Body: { ad_type, ad_placement, action, revenue_estimate? }
 */
router.post("/", requireAuth, async (req, res) => {
  const { ad_type, ad_placement, action, revenue_estimate } = req.body;

  if (!VALID_AD_TYPES.includes(ad_type)) {
    return res.status(400).json({ error: `Invalid ad_type. Must be: ${VALID_AD_TYPES.join(", ")}` });
  }
  if (!VALID_PLACEMENTS.includes(ad_placement)) {
    return res.status(400).json({ error: `Invalid ad_placement. Must be: ${VALID_PLACEMENTS.join(", ")}` });
  }
  if (!VALID_ACTIONS.includes(action)) {
    return res.status(400).json({ error: `Invalid action. Must be: ${VALID_ACTIONS.join(", ")}` });
  }

  // If the user clicked upgrade from an ad, record upgrade_source
  if (action === "upgrade_clicked") {
    await supabase
      .from("profiles")
      .update({ upgrade_source: "ad_fatigue" })
      .eq("id", req.userId);
  }

  const { error } = await supabase.from("ad_events").insert({
    user_id: req.userId,
    ad_type,
    ad_placement,
    action,
    revenue_estimate: revenue_estimate || null,
  });

  if (error) {
    console.error("Ad event log error:", error.message);
    return res.status(500).json({ error: "Failed to log ad event" });
  }

  return res.json({ ok: true });
});

export default router;
