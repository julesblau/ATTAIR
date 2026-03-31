/**
 * Screenshot capture: Style DNA overlay in LIGHT and DARK mode
 * Verifies text contrast fix — white text on black overlay background.
 */
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

// ─── Rich mock Style DNA data ────────────────────────────────
const MOCK_STYLE_DNA = {
  ready: true,
  archetype: "Modern Classic",
  description: "You blend timeless silhouettes with contemporary details. Clean lines, neutral palettes, and understated luxury define your wardrobe.",
  traits: ["Refined", "Intentional", "Versatile", "Elevated"],
  style_score: {
    classic_vs_trendy: 3,
    minimal_vs_maximal: 2,
    casual_vs_formal: 6,
    budget_vs_luxury: 7
  },
  stats: {
    total_scans: 24,
    dominant_colors: [
      { value: "Navy" },
      { value: "Cream" },
      { value: "Charcoal" },
      { value: "Olive" },
      { value: "Brown" }
    ],
    top_brands: [
      { value: "COS" },
      { value: "Arket" },
      { value: "A.P.C." },
      { value: "Lemaire" },
      { value: "Uniqlo" }
    ],
    category_breakdown: { "Tops": 42, "Bottoms": 31, "Shoes": 27 },
    price_tier: "Mid-Range"
  }
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
  let serverReady = await checkServer(VITE_URL);
  if (!serverReady) {
    serverReady = await startViteAndWait();
    if (!serverReady) {
      console.error("[SDNA] FATAL: Vite not reachable after 30s.");
      console.log(JSON.stringify([]));
      process.exit(1);
    }
  }
  console.error("[SDNA] Vite ready at " + VITE_URL);

  const browser = await chromium.launch({ headless: true });
  const mockJwtPayload = Buffer.from(JSON.stringify({
    email: "demo@attaire.com", sub: "demo-user", iat: 1774800000, exp: 1974800000
  })).toString("base64").replace(/=/g, "");
  const mockToken = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9." + mockJwtPayload + ".mock-sig";

  const paths = [];

  // ─── Helper: capture Style DNA overlay for a given theme ────
  async function captureStyleDna(theme) {
    console.error("[SDNA] Capturing " + theme + " mode...");
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 3,
    });

    await context.addInitScript(({ token, themeVal }) => {
      localStorage.setItem("attair_token", token);
      localStorage.setItem("attair_refresh", "mock-refresh-token");
      localStorage.setItem("attair_interests_picked", "1");
      localStorage.setItem("attair_notif_prompted", "1");
      localStorage.setItem("attair_pref_sheet_shown", "1");
      if (themeVal === "light") {
        localStorage.setItem("attair_theme", "light");
      } else {
        localStorage.removeItem("attair_theme");
      }
    }, { token: mockToken, themeVal: theme });

    const page = await context.newPage();
    page.on("console", msg => console.error("[PAGE " + msg.type() + "] " + msg.text()));
    page.on("pageerror", err => console.error("[PAGE ERROR] " + err.message));

    // Intercept ALL API calls
    await page.route("**/api/**", async (route) => {
      const url = route.request().url();
      if (url.includes("/api/user/status")) {
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ plan: "free", scans_today: 1, daily_limit: 3 }) });
      } else if (url.includes("/api/user/profile")) {
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ display_name: "Demo User", email: "demo@attaire.com", budget_min: 50, budget_max: 200 }) });
      } else if (url.includes("/api/style-twins")) {
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ready: false, twins: [] }) });
      } else if (url.includes("/api/user/style-dna") || url.includes("/api/style-dna")) {
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(MOCK_STYLE_DNA) });
      } else if (url.includes("/api/feed")) {
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ posts: [], scans: [], has_more: false }) });
      } else if (url.includes("/api/saved")) {
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ items: [] }) });
      } else if (url.includes("/api/wishlists")) {
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ wishlists: [] }) });
      } else if (url.includes("/api/user/history")) {
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ scans: [] }) });
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
      } else {
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({}) });
      }
    });

    // Navigate to profile
    await page.goto(VITE_URL + "/?tab=profile", { waitUntil: "load", timeout: 20000 });

    try {
      await page.waitForSelector(".tb", { timeout: 10000 });
      console.error("[SDNA] [" + theme + "] Tab bar found");
    } catch {
      console.error("[SDNA] [" + theme + "] Tab bar NOT found, trying onboarding skip...");
      const skipBtn = await page.$("text=Skip");
      if (skipBtn) { await skipBtn.click(); await page.waitForTimeout(500); }
      const startBtn = await page.$("button.cta");
      if (startBtn) { await startBtn.click(); await page.waitForTimeout(500); }
      try { await page.waitForSelector(".tb", { timeout: 5000 }); } catch {}
    }

    // Force theme attribute
    if (theme === "light") {
      await page.evaluate(() => document.documentElement.setAttribute("data-theme", "light"));
    }
    await page.waitForTimeout(2000);

    // Click Profile tab
    await page.evaluate(() => {
      const btns = document.querySelectorAll(".tb button");
      for (const b of btns) {
        const label = b.getAttribute("aria-label") || b.textContent;
        if (label.includes("Profile") || label.includes("profile")) { b.click(); return; }
      }
    });
    await page.waitForTimeout(2000);

    // Re-force theme after nav
    if (theme === "light") {
      await page.evaluate(() => document.documentElement.setAttribute("data-theme", "light"));
      await page.waitForTimeout(300);
    }

    // Click Style DNA button
    const foundDna = await page.evaluate(() => {
      const btn = document.querySelector('[aria-label="View your Style DNA report"]');
      if (btn) { btn.click(); return "clicked"; }
      const buttons = Array.from(document.querySelectorAll("button"));
      for (const b of buttons) {
        if (b.textContent.includes("Style DNA")) { b.click(); return "clicked_fallback"; }
      }
      return "not_found: " + document.body.innerText.slice(0, 500);
    });
    console.error("[SDNA] [" + theme + "] Style DNA button: " + foundDna);
    await page.waitForTimeout(1500);

    // Verify overlay is open
    const overlayOpen = await page.evaluate(() => !!document.querySelector(".sdna-overlay"));
    console.error("[SDNA] [" + theme + "] Overlay open: " + overlayOpen);

    if (!overlayOpen) {
      const p = join(dir, ts + "-sdna-" + theme + "-diagnostic.png");
      await page.screenshot({ path: p, fullPage: false });
      paths.push(p);
      await context.close();
      return;
    }

    // Re-force theme after overlay opens
    if (theme === "light") {
      await page.evaluate(() => document.documentElement.setAttribute("data-theme", "light"));
      await page.waitForTimeout(300);
    }

    async function snap(name) {
      const p = join(dir, ts + "-" + name + ".png");
      await page.screenshot({ path: p, fullPage: false });
      paths.push(p);
      console.error("[SDNA] OK: " + name);
    }

    // Slide 0: Intro ("YOUR STYLE DNA — 24 outfits analyzed")
    await snap("sdna-" + theme + "-slide0-intro");

    // Slide 1: Archetype reveal
    await page.click(".sdna-card");
    await page.waitForTimeout(800);
    await snap("sdna-" + theme + "-slide1-archetype");

    // Slide 3: Style Spectrum (skip slide 2 — traits)
    await page.click(".sdna-card");
    await page.waitForTimeout(500);
    await page.click(".sdna-card");
    await page.waitForTimeout(800);
    await snap("sdna-" + theme + "-slide3-spectrum");

    // Slide 6: Summary + Share
    await page.click(".sdna-card");
    await page.waitForTimeout(400);
    await page.click(".sdna-card");
    await page.waitForTimeout(400);
    await page.click(".sdna-card");
    await page.waitForTimeout(800);
    await snap("sdna-" + theme + "-slide6-summary");

    await context.close();
  }

  try {
    await captureStyleDna("dark");
    await captureStyleDna("light");
  } catch (e) {
    console.error("FATAL: " + e.message);
    console.error(e.stack);
  }

  await browser.close();
  console.log(JSON.stringify(paths));
})();
