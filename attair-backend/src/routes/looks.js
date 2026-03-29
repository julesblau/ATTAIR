import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import supabase from "../lib/supabase.js";

const router = Router();

// ─── GET /api/looks ─────────────────────────────────────────
// Returns user's saved items grouped by scan_id, with scan metadata,
// total items in scan, saved count, and progress percentage.
router.get("/", requireAuth, async (req, res) => {
  try {
    // Fetch all saved items for the user
    const { data: savedItems, error: savedErr } = await supabase
      .from("saved_items")
      .select("id, scan_id, item_data, selected_tier, tier_product, created_at")
      .eq("user_id", req.userId)
      .order("created_at", { ascending: false });

    if (savedErr) throw savedErr;

    if (!savedItems || savedItems.length === 0) {
      return res.json({ looks: [] });
    }

    // Group saved items by scan_id
    const scanGroupMap = new Map();
    const orphanItems = []; // saved items with no scan_id

    for (const item of savedItems) {
      if (!item.scan_id) {
        orphanItems.push(item);
        continue;
      }
      if (!scanGroupMap.has(item.scan_id)) {
        scanGroupMap.set(item.scan_id, []);
      }
      scanGroupMap.get(item.scan_id).push(item);
    }

    if (scanGroupMap.size === 0) {
      return res.json({ looks: [] });
    }

    // Fetch scan metadata for all scan_ids
    const scanIds = [...scanGroupMap.keys()];
    const { data: scans, error: scanErr } = await supabase
      .from("scans")
      .select("id, scan_name, image_thumbnail, image_url, summary, items, detected_gender, created_at")
      .in("id", scanIds);

    if (scanErr) throw scanErr;

    const scanMap = new Map();
    for (const scan of scans || []) {
      scanMap.set(scan.id, scan);
    }

    // Build looks array
    const looks = [];
    for (const [scanId, items] of scanGroupMap) {
      const scan = scanMap.get(scanId);
      const scanItems = scan?.items || [];
      const totalItems = scanItems.length || items.length;
      const savedCount = items.length;

      // Compute which scan items are saved (by name match)
      const savedNames = new Set(
        items.map(s => (s.item_data?.name || "").toLowerCase()).filter(Boolean)
      );
      const scanItemsEnriched = scanItems.map((si, idx) => ({
        ...si,
        index: idx,
        is_saved: savedNames.has((si.name || "").toLowerCase()),
        saved_item_id: items.find(
          s => (s.item_data?.name || "").toLowerCase() === (si.name || "").toLowerCase()
        )?.id || null,
      }));

      // Estimate total price from saved items' tier_product or item_data
      let totalPrice = 0;
      let priceCount = 0;
      for (const item of items) {
        const price = item.tier_product?.price || item.item_data?.price || item.item_data?.estimated_price || 0;
        const parsed = typeof price === "string" ? parseFloat(price.replace(/[^0-9.]/g, "")) : price;
        if (parsed && isFinite(parsed)) {
          totalPrice += parsed;
          priceCount++;
        }
      }

      looks.push({
        scan_id: scanId,
        scan_name: scan?.scan_name || scan?.summary || "Outfit",
        scan_thumbnail: scan?.image_thumbnail || scan?.image_url || null,
        scan_image: scan?.image_url || scan?.image_thumbnail || null,
        summary: scan?.summary || null,
        detected_gender: scan?.detected_gender || null,
        scan_created_at: scan?.created_at || null,
        total_items: totalItems,
        saved_count: savedCount,
        progress: Math.min(1, savedCount / Math.max(1, totalItems)),
        total_price_estimate: priceCount > 0 ? Math.round(totalPrice * 100) / 100 : null,
        saved_items: items.map(i => ({
          id: i.id,
          item_data: i.item_data,
          selected_tier: i.selected_tier,
          tier_product: i.tier_product,
          created_at: i.created_at,
        })),
        scan_items: scanItemsEnriched,
      });
    }

    // Sort: incomplete looks first (by progress ascending), then by saved count descending
    looks.sort((a, b) => {
      // Complete looks (100%) go to end
      if (a.progress === 1 && b.progress !== 1) return 1;
      if (b.progress === 1 && a.progress !== 1) return -1;
      // Among incomplete, sort by saved count descending (most progress first)
      return b.saved_count - a.saved_count;
    });

    return res.json({ looks });
  } catch (err) {
    console.error("[LOOKS] Error:", err.message);
    return res.status(500).json({ error: "Failed to fetch looks" });
  }
});

// ─── GET /api/looks/:scanId ─────────────────────────────────
// Returns all items from a specific scan + which ones are saved by the user
router.get("/:scanId", requireAuth, async (req, res) => {
  const { scanId } = req.params;

  // Validate UUID
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(scanId)) {
    return res.status(400).json({ error: "Invalid scan ID" });
  }

  try {
    // Fetch the scan (must belong to user)
    const { data: scan, error: scanErr } = await supabase
      .from("scans")
      .select("id, scan_name, image_thumbnail, image_url, summary, items, tiers, detected_gender, created_at")
      .eq("id", scanId)
      .eq("user_id", req.userId)
      .single();

    if (scanErr || !scan) {
      return res.status(404).json({ error: "Scan not found" });
    }

    // Fetch saved items for this scan
    const { data: savedItems, error: savedErr } = await supabase
      .from("saved_items")
      .select("id, item_data, selected_tier, tier_product, created_at")
      .eq("user_id", req.userId)
      .eq("scan_id", scanId);

    if (savedErr) throw savedErr;

    const savedNames = new Set(
      (savedItems || []).map(s => (s.item_data?.name || "").toLowerCase()).filter(Boolean)
    );

    const scanItems = (scan.items || []).map((item, idx) => {
      const isSaved = savedNames.has((item.name || "").toLowerCase());
      const savedMatch = (savedItems || []).find(
        s => (s.item_data?.name || "").toLowerCase() === (item.name || "").toLowerCase()
      );

      // Enrich with tier data if available
      const tierData = (scan.tiers || []).find(t => t.item_index === idx);

      return {
        ...item,
        index: idx,
        is_saved: isSaved,
        saved_item_id: savedMatch?.id || null,
        tier_product: savedMatch?.tier_product || null,
        tiers: tierData?.tiers || null,
      };
    });

    // Compute total price
    let totalPrice = 0;
    let priceCount = 0;
    for (const item of savedItems || []) {
      const price = item.tier_product?.price || item.item_data?.price || item.item_data?.estimated_price || 0;
      const parsed = typeof price === "string" ? parseFloat(price.replace(/[^0-9.]/g, "")) : price;
      if (parsed && isFinite(parsed)) {
        totalPrice += parsed;
        priceCount++;
      }
    }

    return res.json({
      scan_id: scan.id,
      scan_name: scan.scan_name || scan.summary || "Outfit",
      scan_thumbnail: scan.image_thumbnail || scan.image_url || null,
      scan_image: scan.image_url || scan.image_thumbnail || null,
      summary: scan.summary || null,
      detected_gender: scan.detected_gender || null,
      created_at: scan.created_at,
      total_items: scanItems.length,
      saved_count: (savedItems || []).length,
      progress: Math.min(1, (savedItems || []).length / Math.max(1, scanItems.length)),
      total_price_estimate: priceCount > 0 ? Math.round(totalPrice * 100) / 100 : null,
      items: scanItems,
      saved_items: (savedItems || []).map(s => ({
        id: s.id,
        item_data: s.item_data,
        selected_tier: s.selected_tier,
        tier_product: s.tier_product,
        created_at: s.created_at,
      })),
    });
  } catch (err) {
    console.error("[LOOKS] Detail error:", err.message);
    return res.status(500).json({ error: "Failed to fetch look details" });
  }
});

// ─── GET /api/looks/:scanId/buy-all ─────────────────────────
// Returns affiliate links for all saved items from a scan, plus
// generates an HTML redirect page that opens each retailer link.
router.get("/:scanId/buy-all", requireAuth, async (req, res) => {
  const { scanId } = req.params;
  const { format } = req.query; // "json" (default) or "html"

  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(scanId)) {
    return res.status(400).json({ error: "Invalid scan ID" });
  }

  try {
    // Verify scan ownership
    const { data: scan } = await supabase
      .from("scans")
      .select("id, scan_name, summary, items")
      .eq("id", scanId)
      .eq("user_id", req.userId)
      .single();

    if (!scan) {
      return res.status(404).json({ error: "Scan not found" });
    }

    // Fetch saved items for this scan
    const { data: savedItems, error: savedErr } = await supabase
      .from("saved_items")
      .select("id, item_data, tier_product")
      .eq("user_id", req.userId)
      .eq("scan_id", scanId);

    if (savedErr) throw savedErr;

    if (!savedItems || savedItems.length === 0) {
      return res.json({ links: [], total_price: 0 });
    }

    // Extract product URLs and build affiliate links
    const links = [];
    let totalPrice = 0;

    for (const item of savedItems) {
      const url = item.tier_product?.url || item.item_data?.url || null;
      const name = item.item_data?.name || item.tier_product?.name || "Item";
      const price = item.tier_product?.price || item.item_data?.price || item.item_data?.estimated_price || 0;
      const parsed = typeof price === "string" ? parseFloat(price.replace(/[^0-9.]/g, "")) : price;
      const retailer = item.tier_product?.retailer || item.item_data?.retailer || extractRetailer(url);
      const image = item.tier_product?.image_url || item.item_data?.image_url || item.item_data?.thumbnail || null;

      if (parsed && isFinite(parsed)) {
        totalPrice += parsed;
      }

      if (url) {
        links.push({
          saved_item_id: item.id,
          name,
          price: parsed || null,
          retailer,
          url, // raw URL — frontend routes through /api/go/ for affiliate tagging
          image,
        });
      }
    }

    if (format === "html") {
      // Generate a redirect page that opens all links
      const scanName = scan.scan_name || scan.summary || "Your Look";
      const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

      res.setHeader("Content-Type", "text/html; charset=utf-8");
      return res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Complete the Look - ATTAIRE</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0a0a0a; color: #fff; min-height: 100vh; display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 20px; }
    .container { max-width: 400px; width: 100%; text-align: center; }
    h1 { font-size: 20px; margin-bottom: 8px; }
    .subtitle { color: #888; font-size: 14px; margin-bottom: 24px; }
    .item { display: flex; align-items: center; gap: 12px; padding: 12px 16px; background: #1a1a1a; border-radius: 12px; margin-bottom: 8px; text-align: left; text-decoration: none; color: inherit; border: 1px solid #222; }
    .item:hover { border-color: #C9A96E; }
    .item-img { width: 48px; height: 48px; border-radius: 8px; object-fit: cover; background: #222; flex-shrink: 0; }
    .item-info { flex: 1; min-width: 0; }
    .item-name { font-size: 13px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .item-meta { font-size: 11px; color: #888; margin-top: 2px; }
    .total { margin-top: 16px; font-size: 14px; color: #C9A96E; font-weight: 600; }
    .opening { margin-top: 24px; font-size: 12px; color: #666; }
    .arrow { display: inline-block; font-size: 14px; color: #C9A96E; }
  </style>
</head>
<body>
  <div class="container">
    <h1>${esc(scanName)}</h1>
    <div class="subtitle">Opening ${links.length} item${links.length !== 1 ? "s" : ""} from your look</div>
    ${links.map((l, i) => `
    <a href="${esc(l.url)}" target="_blank" rel="noopener noreferrer" class="item">
      ${l.image ? `<img class="item-img" src="${esc(l.image)}" alt="" />` : `<div class="item-img"></div>`}
      <div class="item-info">
        <div class="item-name">${esc(l.name)}</div>
        <div class="item-meta">${l.retailer ? esc(l.retailer) : ""}${l.price ? ` &middot; $${l.price.toFixed(2)}` : ""}</div>
      </div>
      <span class="arrow">&rarr;</span>
    </a>`).join("")}
    ${totalPrice > 0 ? `<div class="total">Estimated total: $${totalPrice.toFixed(2)}</div>` : ""}
    <div class="opening">Opening retailer tabs...</div>
  </div>
  <script>
    const urls = ${JSON.stringify(links.map(l => l.url))};
    // Stagger opening tabs to avoid popup blockers
    urls.forEach((u, i) => {
      setTimeout(() => window.open(u, '_blank'), i * 300);
    });
  </script>
</body>
</html>`);
    }

    return res.json({
      scan_id: scanId,
      scan_name: scan.scan_name || scan.summary || "Your Look",
      links,
      total_price: Math.round(totalPrice * 100) / 100,
      item_count: links.length,
    });
  } catch (err) {
    console.error("[LOOKS] Buy-all error:", err.message);
    return res.status(500).json({ error: "Failed to generate buy-all links" });
  }
});

/**
 * Extract retailer name from URL hostname
 */
function extractRetailer(url) {
  if (!url) return null;
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
    // Map common domains to clean names
    const map = {
      "amazon.com": "Amazon",
      "nordstrom.com": "Nordstrom",
      "asos.com": "ASOS",
      "revolve.com": "Revolve",
      "zara.com": "Zara",
      "hm.com": "H&M",
      "uniqlo.com": "Uniqlo",
      "ssense.com": "SSENSE",
      "farfetch.com": "Farfetch",
      "net-a-porter.com": "Net-a-Porter",
      "shopbop.com": "Shopbop",
      "bloomingdales.com": "Bloomingdale's",
      "saksfifthavenue.com": "Saks",
      "macys.com": "Macy's",
      "lululemon.com": "Lululemon",
      "nike.com": "Nike",
      "adidas.com": "Adidas",
      "urbanoutfitters.com": "Urban Outfitters",
      "anthropologie.com": "Anthropologie",
      "madewell.com": "Madewell",
      "zappos.com": "Zappos",
    };
    return map[host] || host.split(".")[0].charAt(0).toUpperCase() + host.split(".")[0].slice(1);
  } catch {
    return null;
  }
}

export default router;
