import { chromium } from "playwright";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { spawn } from "child_process";
import http from "http";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dir = __dirname;
const ts = String(Date.now());

const VITE_URL = "http://localhost:5173";
const APP_DIR = join(__dirname, "..", "..", "attair-app");

// ─── Mock scan data with product results ───────────────────
// This simulates a completed scan with real-looking product tiers
const MOCK_SCAN_IMAGE = "https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=400&h=600&fit=crop";

const MOCK_SCAN = {
  id: "scan-demo-001",
  scan_name: "Street Style Look",
  detected_gender: "male",
  summary: "Clean casual streetwear with layered neutrals — modern minimalist with a relaxed edge.",
  image_url: MOCK_SCAN_IMAGE,
  image_thumbnail: MOCK_SCAN_IMAGE,
  created_at: new Date().toISOString(),
  items: [
    { name: "Oversized Crew Neck Sweater", brand: "COS", color: "Cream", category: "Tops", material: "Wool blend" },
    { name: "Straight Leg Trousers", brand: "Uniqlo", color: "Charcoal", category: "Bottoms", material: "Cotton twill" },
    { name: "Leather Low-Top Sneakers", brand: "Common Projects", color: "White", category: "Shoes", material: "Leather" },
  ],
  tiers: [
    {
      item_index: 0,
      tiers: {
        budget: [
          { product_name: "Oversized Crew Sweater", brand: "H&M", price: "$34.99", url: "https://hm.com/sweater", image_url: "https://images.unsplash.com/photo-1576566588028-4147f3842f27?w=300&h=300&fit=crop", is_product_page: true, style_match: 82 },
          { product_name: "Relaxed Wool Blend Sweater", brand: "Uniqlo", price: "$49.90", url: "https://uniqlo.com/sweater", image_url: "https://images.unsplash.com/photo-1620799140408-edc6dcb6d633?w=300&h=300&fit=crop", is_product_page: true, style_match: 78 },
        ],
        mid: [
          { product_name: "Oversized Merino Crew", brand: "COS", price: "$89.00", url: "https://cos.com/sweater", image_url: "https://images.unsplash.com/photo-1614975059251-992f11792571?w=300&h=300&fit=crop", is_product_page: true, is_identified_brand: true, style_match: 94 },
          { product_name: "Wool Crewneck", brand: "Arket", price: "$79.00", url: "https://arket.com/sweater", image_url: "https://images.unsplash.com/photo-1578587018452-892bacefd3f2?w=300&h=300&fit=crop", is_product_page: true, style_match: 88 },
          { product_name: "Premium Crew Sweater", brand: "& Other Stories", price: "$99.00", url: "https://stories.com/sweater", image_url: "https://images.unsplash.com/photo-1556821840-3a63f95609a7?w=300&h=300&fit=crop", is_product_page: true, style_match: 71 },
        ],
        premium: [
          { product_name: "Cashmere Oversized Crew", brand: "Auralee", price: "$420.00", url: "https://auralee.jp/sweater", image_url: "https://images.unsplash.com/photo-1591047139829-d91aecb6caea?w=300&h=300&fit=crop", is_product_page: true, style_match: 96 },
        ],
        resale: [
          { product_name: "COS Wool Sweater (Like New)", brand: "Depop", price: "$38.00", url: "https://depop.com/sweater", image_url: "https://images.unsplash.com/photo-1618354691373-d851c5c3a990?w=300&h=300&fit=crop", is_product_page: true, style_match: 85 },
        ],
      }
    },
    {
      item_index: 1,
      tiers: {
        budget: [
          { product_name: "Straight Fit Chinos", brand: "Uniqlo", price: "$39.90", url: "https://uniqlo.com/chinos", image_url: "https://images.unsplash.com/photo-1624378439575-d8705ad7ae80?w=300&h=300&fit=crop", is_product_page: true, is_identified_brand: true, style_match: 91 },
          { product_name: "Relaxed Chino Trousers", brand: "Zara", price: "$45.90", url: "https://zara.com/chinos", image_url: "https://images.unsplash.com/photo-1473966968600-fa801b869a1a?w=300&h=300&fit=crop", is_product_page: true, style_match: 76 },
        ],
        mid: [
          { product_name: "Tapered Wool Trousers", brand: "COS", price: "$115.00", url: "https://cos.com/trousers", image_url: "https://images.unsplash.com/photo-1594938298603-c8148c4dae35?w=300&h=300&fit=crop", is_product_page: true, style_match: 89 },
        ],
        premium: [
          { product_name: "Pleated Wide Trousers", brand: "Lemaire", price: "$580.00", url: "https://lemaire.fr/trousers", image_url: "https://images.unsplash.com/photo-1506629082955-511b1aa562c8?w=300&h=300&fit=crop", is_product_page: true, style_match: 93 },
        ],
      }
    },
    {
      item_index: 2,
      tiers: {
        budget: [
          { product_name: "White Leather Sneakers", brand: "Axel Arigato", price: "$65.00", url: "https://axelarigato.com/sneaker", image_url: "https://images.unsplash.com/photo-1549298916-b41d501d3772?w=300&h=300&fit=crop", is_product_page: true, style_match: 84 },
        ],
        mid: [
          { product_name: "Retro Low Sneaker", brand: "Veja", price: "$150.00", url: "https://veja.com/sneaker", image_url: "https://images.unsplash.com/photo-1595950653106-6c9ebd614d3a?w=300&h=300&fit=crop", is_product_page: true, style_match: 87 },
          { product_name: "Court Classic", brand: "Koio", price: "$248.00", url: "https://koio.co/sneaker", image_url: "https://images.unsplash.com/photo-1600269452121-4f2416e55c28?w=300&h=300&fit=crop", is_product_page: true, style_match: 90 },
        ],
        premium: [
          { product_name: "Original Achilles Low", brand: "Common Projects", price: "$425.00", url: "https://commonprojects.com", image_url: "https://images.unsplash.com/photo-1491553895911-0055eca6402d?w=300&h=300&fit=crop", is_product_page: true, is_identified_brand: true, style_match: 97 },
        ],
      }
    },
  ]
};

// ── Pre-flight: ensure Vite dev server is running ──
function checkServer(url, timeoutMs = 3000) {
  return new Promise((resolve) => {
    const req = http.get(url, (res) => { res.resume(); resolve(true); });
    req.on("error", () => resolve(false));
    req.setTimeout(timeoutMs, () => { req.destroy(); resolve(false); });
  });
}

async function startViteAndWait(maxWaitMs = 30000) {
  console.error("[Screenshot] Vite dev server not running — starting it automatically...");
  const vite = spawn("npx", ["vite", "--port", "5173", "--host"], {
    cwd: APP_DIR,
    stdio: "ignore",
    detached: true,
    shell: true,
  });
  vite.unref();
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    const alive = await checkServer(VITE_URL);
    if (alive) {
      console.error("[Screenshot] Vite dev server is now running.");
      return true;
    }
    await new Promise(r => setTimeout(r, 1000));
  }
  return false;
}

(async () => {
  // ── CRITICAL: Verify dev server is reachable BEFORE launching browser ──
  let serverReady = await checkServer(VITE_URL);
  if (!serverReady) {
    serverReady = await startViteAndWait();
    if (!serverReady) {
      console.error("[Screenshot] FATAL: Vite dev server at " + VITE_URL + " is not reachable after 30s.");
      console.log(JSON.stringify([]));
      process.exit(1);
    }
  }
  console.error("[Screenshot] Vite dev server confirmed running at " + VITE_URL);

  const browser = await chromium.launch({ headless: true });

  // Build mock JWT token (Node.js Buffer-based for reliability, btoa can be inconsistent)
  const mockJwtPayload = Buffer.from(JSON.stringify({email:"demo@attaire.com",sub:"demo-user",iat:1774800000,exp:1974800000})).toString("base64").replace(/=/g,"");
  const mockToken = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9." + mockJwtPayload + ".mock-sig";

  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
  });

  // ═══ KEY FIX: Set localStorage BEFORE any page loads via addInitScript ═══
  // This runs synchronously in the browser before React initializes,
  // so Auth.getToken() returns the token on first render → screen="app" immediately.
  await context.addInitScript((token) => {
    localStorage.setItem("attair_token", token);
    localStorage.setItem("attair_refresh", "mock-refresh-token");
    localStorage.setItem("attair_interests_picked", "1");
    localStorage.setItem("attair_notif_prompted", "1");
    localStorage.setItem("attair_pref_sheet_shown", "1");
  }, mockToken);

  const page = await context.newPage();
  const paths = [];

  // Debug: log console messages to stderr for troubleshooting
  page.on("console", msg => console.error(`[PAGE ${msg.type()}] ${msg.text()}`));
  page.on("pageerror", err => console.error(`[PAGE ERROR] ${err.message}`));

  async function snap(name) {
    const p = join(dir, ts + "-" + name + ".png");
    await page.screenshot({ path: p, fullPage: false });
    paths.push(p);
    console.error("OK: " + name);
  }

  try {
    // Intercept ALL API calls — return mock data for every endpoint
    await page.route("**/api/**", async (route) => {
      const url = route.request().url();
      if (url.includes("/api/user/status")) {
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ plan: "free", scans_today: 1, daily_limit: 3 }) });
      } else if (url.includes("/api/user/profile")) {
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ display_name: "Demo User", email: "demo@attaire.com", budget_min: 50, budget_max: 200 }) });
      } else if (url.includes("/api/style-twins")) {
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ready: false, twins: [] }) });
      } else if (url.includes("/api/style-dna")) {
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ axes: { classic_vs_trendy: 3, minimal_vs_maximal: 2, casual_vs_formal: 7, budget_vs_luxury: 6 }, archetype: "Modern Classic", palette: ["navy", "cream", "brown"] }) });
      } else if (url.includes("/api/feed")) {
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ posts: [], scans: [], has_more: false }) });
      } else if (url.includes("/api/saved")) {
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ items: [] }) });
      } else if (url.includes("/api/wishlists")) {
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ wishlists: [] }) });
      } else if (url.includes("/api/user/history")) {
        // Return a scan with full product results — this is the key mock
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ scans: [MOCK_SCAN] }) });
      } else if (url.includes("/api/streak")) {
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ streak: 5 }) });
      } else if (url.includes("/api/notifications")) {
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ notifications: [], count: 0 }) });
      } else if (url.includes("/api/price-alerts")) {
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ unseen_count: 0 }) });
      } else if (url.includes("/api/hanger-test")) {
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({}) });
      } else if (url.includes("/api/challenges")) {
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ challenges: [] }) });
      } else if (url.includes("/api/social/following-ids")) {
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ following_ids: [] }) });
      } else if (url.includes("/api/auth/refresh")) {
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ access_token: "mock-access", refresh_token: "mock-refresh" }) });
      } else if (url.includes("/api/affiliate")) {
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ url: "#" }) });
      } else {
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({}) });
      }
    });

    // ═══ Navigate to Likes tab (which loads scan history) ═══
    console.error("[Screenshot] Navigating to /?tab=likes with token pre-set...");
    await page.goto(VITE_URL + "/?tab=likes", { waitUntil: "load", timeout: 20000 });

    // Wait for React to hydrate — look for the tab bar
    console.error("[Screenshot] Waiting for tab bar (.tb)...");
    try {
      await page.waitForSelector(".tb", { timeout: 10000 });
      console.error("[Screenshot] Tab bar found — app screen active");
    } catch {
      console.error("[Screenshot] Tab bar NOT found, diagnosing...");
      const diagnosis = await page.evaluate(() => ({
        url: location.href,
        hasToken: !!localStorage.getItem("attair_token"),
        bodyClasses: document.body.className,
        bodyText: document.body.innerText.slice(0, 300),
        allButtons: Array.from(document.querySelectorAll("button")).map(b => b.textContent.trim()).slice(0, 10),
      }));
      console.error("[Screenshot] Diagnosis:", JSON.stringify(diagnosis, null, 2));

      // If stuck on onboarding despite token, try clicking through
      const skipBtn = await page.$("text=Skip");
      if (skipBtn) { await skipBtn.click(); await page.waitForTimeout(500); }
      const startBtn = await page.$("button.cta");
      if (startBtn) { await startBtn.click(); await page.waitForTimeout(500); }

      // Re-check for tab bar
      try {
        await page.waitForSelector(".tb", { timeout: 5000 });
        console.error("[Screenshot] Tab bar found after clicking through onboarding");
      } catch {
        console.error("[Screenshot] FATAL: Cannot reach app screen. Taking diagnostic screenshot.");
        await snap("home");
        await snap("scan");
        await snap("profile");
        await browser.close();
        console.log(JSON.stringify(paths));
        return;
      }
    }

    // Wait for React to settle and history to load
    await page.waitForTimeout(2000);

    // Click the Likes tab in bottom bar to trigger history load
    console.error("[Screenshot] Clicking Likes tab...");
    await page.evaluate(() => {
      const btns = document.querySelectorAll(".tb button");
      for (const b of btns) {
        const label = b.getAttribute("aria-label") || b.textContent;
        if (label.includes("Likes") || label.includes("Saved") || label.includes("saved")) { b.click(); return; }
      }
    });
    await page.waitForTimeout(2000);

    // Look for scan history cards and click "View results" on the first one
    console.error("[Screenshot] Looking for scan history card...");
    const foundScanCard = await page.evaluate(() => {
      // Look for the scan card with "View results" or the scan name
      const buttons = Array.from(document.querySelectorAll("button"));
      for (const b of buttons) {
        const label = b.getAttribute("aria-label") || b.textContent.trim();
        if (label.includes("View scan results") || label.includes("View results")) {
          b.click();
          return "clicked_view_results";
        }
      }
      // Also try clicking on scan card itself
      const scanCards = document.querySelectorAll("[class*='scan-card'], [class*='history']");
      if (scanCards.length > 0) {
        scanCards[0].click();
        return "clicked_scan_card";
      }
      // Debug: report what's visible
      return document.body.innerText.slice(0, 500);
    });
    console.error("[Screenshot] Scan card result:", foundScanCard);

    // Wait for the scan results view to render
    await page.waitForTimeout(1500);

    // Check if we're on the scan results view
    const scanState = await page.evaluate(() => ({
      hasRes: !!document.querySelector(".res"),
      hasVBanner: !!document.querySelector(".v-banner"),
      bodyText: document.body.innerText.slice(0, 800),
      phase: document.querySelector(".v-step-l")?.textContent || "none",
    }));
    console.error("[Screenshot] Scan results state:", JSON.stringify(scanState, null, 2));

    // ═══ SCREENSHOTS ═══

    // SCREENSHOT 1 ("scan"): Scan results overview — shows "Products Found" + item list
    console.error("[Screenshot] Taking screenshot 1: Scan results overview...");
    await page.waitForTimeout(800);
    try { await snap("scan"); } catch(e) { console.error("FAIL scan: " + e.message); }

    // SCREENSHOT 2 ("home"): Scroll to product cards — the actual products from search
    console.error("[Screenshot] Taking screenshot 2: Product cards from scan...");
    // Scroll the main content (not .res — the whole page) to show product cards
    await page.evaluate(() => {
      // The res div may be the scrollable container, or the window
      const res = document.querySelector(".res");
      if (res) {
        // Scroll within the results container to show products
        res.scrollTop = res.scrollHeight;
        // Try window scroll too
      }
      window.scrollTo(0, 9999);
      // Also scroll the main app container if it exists
      const main = document.querySelector(".app-scroll") || document.querySelector("main") || document.querySelector("[class*='content']");
      if (main) main.scrollTop = main.scrollHeight;
    });
    await page.waitForTimeout(600);
    // Now scroll to a good position showing product cards
    await page.evaluate(() => {
      const budgetLabels = document.querySelectorAll("span");
      for (const el of budgetLabels) {
        if (el.textContent.trim() === "BUDGET" || el.textContent.trim() === "MATCH") {
          el.scrollIntoView({ block: "start", behavior: "instant" });
          // Nudge up a bit to show the item name too
          window.scrollBy(0, -40);
          return;
        }
      }
    });
    await page.waitForTimeout(600);
    try { await snap("home"); } catch(e) { console.error("FAIL home: " + e.message); }

    // SCREENSHOT 3 ("profile"): Expanded second item with its product cards
    console.error("[Screenshot] Taking screenshot 3: Second item products...");
    // Expand second item (Straight Leg Trousers) and scroll to it
    await page.evaluate(() => {
      const itemBtns = Array.from(document.querySelectorAll("button"));
      for (const b of itemBtns) {
        if (b.textContent.includes("Straight Leg Trousers")) {
          b.click();
          setTimeout(() => b.scrollIntoView({ block: "start", behavior: "instant" }), 200);
          return;
        }
      }
    });
    await page.waitForTimeout(1000);
    try { await snap("profile"); } catch(e) { console.error("FAIL profile: " + e.message); }

  } catch(e) {
    console.error("FATAL: " + e.message);
    console.error(e.stack);
  }

  await browser.close();
  console.log(JSON.stringify(paths));
})();
