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

// Mock twin data — React renders it natively through normal code path (no HTML injection)
const MOCK_TWINS_DATA = {
  ready: true,
  my_archetype: "Modern Classic",
  my_style_score: { classic_vs_trendy: 3, minimal_vs_maximal: 2, casual_vs_formal: 7, budget_vs_luxury: 6 },
  total_matches: 6,
  twins: [
    { id: "twin-1", display_name: "Emma Morrison", avatar_url: null, match_pct: 94, archetype: "Modern Classic", bio: "Clean lines, neutral palettes, timeless pieces", shared_axes: ["Minimal", "Classic"], traits: ["Chic", "Polished"], dominant_colors: ["navy", "cream", "brown"], shared_saves_count: 3, shared_saves: ["Wool Overcoat", "Cashmere Sweater", "Silk Blouse"], style_score: { classic_vs_trendy: 3, minimal_vs_maximal: 2, casual_vs_formal: 7, budget_vs_luxury: 7 }, is_following: false },
    { id: "twin-2", display_name: "James Kim", avatar_url: null, match_pct: 87, archetype: "Refined Edge", bio: "Sharp tailoring meets modern ease", shared_axes: ["Minimal", "Formal"], traits: ["Sharp", "Modern"], dominant_colors: ["charcoal", "silver", "white"], shared_saves_count: 0, shared_saves: [], style_score: { classic_vs_trendy: 4, minimal_vs_maximal: 2, casual_vs_formal: 8, budget_vs_luxury: 7 }, is_following: false },
    { id: "twin-3", display_name: "Sofia Patel", avatar_url: null, match_pct: 76, archetype: "Elegant Minimal", bio: "Less is more, quality over quantity", shared_axes: ["Classic"], traits: ["Elegant"], dominant_colors: ["gold", "cream"], shared_saves_count: 1, shared_saves: ["Silk Blouse"], style_score: { classic_vs_trendy: 3, minimal_vs_maximal: 3, casual_vs_formal: 6, budget_vs_luxury: 8 }, is_following: false },
    { id: "twin-4", display_name: "Alex Rivera", avatar_url: null, match_pct: 72, archetype: "Street Luxe", bio: "Streetwear with a luxury twist", shared_axes: ["Trendy"], traits: ["Bold"], dominant_colors: ["black", "white", "red"], shared_saves_count: 0, shared_saves: [], style_score: { classic_vs_trendy: 7, minimal_vs_maximal: 4, casual_vs_formal: 5, budget_vs_luxury: 7 }, is_following: false },
    { id: "twin-5", display_name: "Maya Williams", avatar_url: null, match_pct: 63, archetype: "Boho Chic", bio: "Free-spirited and earthy vibes", shared_axes: ["Balanced"], traits: ["Relaxed"], dominant_colors: ["olive", "rust", "cream"], shared_saves_count: 0, shared_saves: [], style_score: { classic_vs_trendy: 5, minimal_vs_maximal: 5, casual_vs_formal: 4, budget_vs_luxury: 5 }, is_following: false }
  ]
};

const COMPARE_SHEET_HTML = `<div style="position:absolute;inset:0;background:rgba(0,0,0,0.6);backdrop-filter:blur(6px)"></div><div class="bottom-sheet style-twin-compare-sheet" style="position:absolute;bottom:0;left:0;right:0;background:var(--bg-card,#1A1A1A);border-radius:24px 24px 0 0;padding:24px 24px 32px;max-height:85vh;overflow-y:auto;border-top:1px solid rgba(255,255,255,0.08)"><div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:24px"><div style="font-size:18px;font-weight:800;color:var(--text-primary,#fff);font-family:var(--font-display)">Style Comparison</div></div><div style="display:flex;justify-content:center;margin-bottom:24px"><div class="style-twin-compare-ring"><span class="style-twin-compare-pct">94%</span><span style="font-size:10px;color:var(--text-secondary,rgba(255,255,255,0.6));font-weight:500">match</span></div></div><div style="display:grid;grid-template-columns:1fr 1fr;gap:24px;text-align:center;margin-bottom:24px"><div><div class="style-twin-avatar-sm" style="margin:0 auto 8px;width:48px;height:48px"><span style="font-size:16px">ME</span></div><div style="font-size:13px;font-weight:600;color:var(--text-primary,#fff)">You</div><div style="font-size:11px;color:var(--accent,#C9A96E);font-weight:500;margin-top:2px">Modern Classic</div></div><div><div class="style-twin-avatar-sm" style="margin:0 auto 8px;width:48px;height:48px"><span style="font-size:16px">EM</span></div><div style="font-size:13px;font-weight:600;color:var(--text-primary,#fff)">Emma Morrison</div><div style="font-size:11px;color:var(--accent,#C9A96E);font-weight:500;margin-top:2px">Modern Classic</div></div></div><div style="margin-bottom:20px"><div style="font-size:11px;font-weight:700;color:var(--text-tertiary,rgba(255,255,255,0.35));text-transform:uppercase;letter-spacing:1px;margin-bottom:10px">Shared Style Traits</div><div style="display:flex;flex-wrap:wrap;gap:8px;justify-content:center"><span class="style-twin-axis-chip" style="font-size:13px;padding:6px 16px">Minimal</span><span class="style-twin-axis-chip" style="font-size:13px;padding:6px 16px">Classic</span></div></div><button class="user-search-follow-btn follow" style="width:100%;min-height:48px;font-size:15px;border-radius:12px;font-weight:700;margin-top:8px">Follow Your Style Twin</button></div>`;

const SAVE_TOAST_HTML = `<div style="width:36px;height:36px;border-radius:50%;background:rgba(201,169,110,0.15);display:flex;align-items:center;justify-content:center;flex-shrink:0"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="#C9A96E" stroke-width="2"><circle cx="9" cy="7" r="3"/><circle cx="15" cy="7" r="3"/><path d="M3 21c0-3.31 2.69-6 6-6h0c1.1 0 2.12.3 3 .82A5.98 5.98 0 0115 15h0c3.31 0 6 2.69 6 6"/></svg></div><div style="flex:1;min-width:0"><div style="font-size:13px;font-weight:700;color:var(--text-primary,#fff);margin-bottom:2px">Style Twin Match!</div><div style="font-size:11px;color:var(--text-secondary,rgba(255,255,255,0.6));line-height:1.4">Your Style Twin Emma Morrison also saved this!</div></div><button style="background:var(--accent,#C9A96E);color:#000;border:none;border-radius:100px;padding:6px 14px;font-size:11px;font-weight:700;cursor:pointer;white-space:nowrap;flex-shrink:0">View Twins</button>`;

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
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ plan: "free", scans_today: 0, daily_limit: 3 }) });
      } else if (url.includes("/api/user/profile")) {
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ display_name: "Demo User", email: "demo@attaire.com" }) });
      } else if (url.includes("/api/style-twins")) {
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(MOCK_TWINS_DATA) });
      } else if (url.includes("/api/style-dna")) {
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ axes: { classic_vs_trendy: 3, minimal_vs_maximal: 2, casual_vs_formal: 7, budget_vs_luxury: 6 }, archetype: "Modern Classic", palette: ["navy", "cream", "brown"] }) });
      } else if (url.includes("/api/feed")) {
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ posts: [], scans: [], has_more: false }) });
      } else if (url.includes("/api/saved")) {
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ items: [] }) });
      } else if (url.includes("/api/wishlists")) {
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ wishlists: [] }) });
      } else if (url.includes("/api/history")) {
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

    // ═══ SINGLE LOAD: Navigate directly to /?tab=twins ═══
    // localStorage is already set via addInitScript, so React sees the token on first render.
    // Use "load" instead of "networkidle" — Vite's HMR WebSocket prevents networkidle from resolving.
    console.error("[Screenshot] Navigating to /?tab=twins with token pre-set...");
    await page.goto(VITE_URL + "/?tab=twins", { waitUntil: "load", timeout: 20000 });

    // Wait for React to hydrate and render — look for the tab bar which confirms app screen
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

    // Give React time to settle after mount and process ?tab=twins deep link
    await page.waitForTimeout(1500);

    // Verify we're on the Twins tab — deep link should have set it
    const tabState = await page.evaluate(() => {
      const feedTabs = document.querySelectorAll(".feed-tab");
      let activeTab = "none";
      for (const t of feedTabs) {
        if (t.classList.contains("active")) activeTab = t.textContent.trim();
      }
      return {
        hasFeedTabs: feedTabs.length > 0,
        activeTab,
        hasTwinsContent: !!document.querySelector(".style-twin-featured") || !!document.querySelector(".style-twins-loading") || !!document.querySelector(".style-twins-empty"),
      };
    });
    console.error("[Screenshot] Tab state:", JSON.stringify(tabState));

    // If Twins tab is not active, click it manually
    if (!tabState.activeTab.includes("Twins")) {
      console.error("[Screenshot] Twins tab not active, clicking Discover then Twins...");

      // Click the Discover tab button in bottom bar
      await page.evaluate(() => {
        const btns = document.querySelectorAll(".tb button");
        for (const b of btns) {
          const label = b.getAttribute("aria-label") || b.textContent;
          if (label.includes("Discover")) { b.click(); return; }
        }
      });
      await page.waitForTimeout(500);

      // Click the Twins sub-tab
      await page.evaluate(() => {
        const btns = document.querySelectorAll(".feed-tab, button");
        for (const b of btns) {
          if (b.textContent.trim().includes("Twins")) { b.click(); return; }
        }
      });
      await page.waitForTimeout(500);
    }

    // Wait for the API call to complete and twins content to render
    console.error("[Screenshot] Waiting for twins content to render...");
    try {
      await page.waitForSelector(".style-twin-featured", { timeout: 10000 });
      console.error("[Screenshot] Featured twin card rendered successfully!");
    } catch {
      // Check if loading or error is showing
      const state = await page.evaluate(() => ({
        hasLoading: !!document.querySelector(".style-twins-loading"),
        hasEmpty: !!document.querySelector(".style-twins-empty"),
        hasFeatured: !!document.querySelector(".style-twin-featured"),
        hasGrid: !!document.querySelector(".style-twins-grid"),
        hasError: document.body.innerText.includes("Something Went Wrong") || document.body.innerText.includes("Tap to retry"),
        visibleText: document.body.innerText.slice(0, 500),
      }));
      console.error("[Screenshot] Content state:", JSON.stringify(state, null, 2));

      // If still loading, wait more
      if (state.hasLoading) {
        console.error("[Screenshot] Still loading, waiting 5 more seconds...");
        try {
          await page.waitForSelector(".style-twin-featured", { timeout: 5000 });
          console.error("[Screenshot] Featured card appeared after extended wait");
        } catch {
          console.error("[Screenshot] Twins still loading/not rendering after extended wait");
        }
      }
    }

    // Extra stabilization for CSS animations
    await page.waitForTimeout(800);

    // ═══ SCREENSHOTS ═══

    // SCREENSHOT 1 ("home"): Twins cards grid — the core feature UI
    console.error("[Screenshot] Taking screenshot 1: Twins cards grid...");
    try { await snap("home"); } catch(e) { console.error("FAIL home: " + e.message); }

    // SCREENSHOT 2 ("scan"): Comparison sheet overlay
    console.error("[Screenshot] Taking screenshot 2: Comparison sheet...");
    await page.evaluate((html) => {
      const overlay = document.createElement("div");
      overlay.setAttribute("data-screenshot-twin-compare", "1");
      overlay.style.cssText = "position:fixed;inset:0;z-index:10001";
      overlay.innerHTML = html;
      document.body.appendChild(overlay);
    }, COMPARE_SHEET_HTML);
    await page.waitForTimeout(500);
    try { await snap("scan"); } catch(e) { console.error("FAIL scan: " + e.message); }

    // Remove comparison overlay
    await page.evaluate(() => {
      const el = document.querySelector("[data-screenshot-twin-compare]");
      if (el) el.remove();
    });

    // SCREENSHOT 3 ("profile"): Twins grid with shared save toast banner
    console.error("[Screenshot] Taking screenshot 3: Save toast overlay...");
    await page.evaluate((html) => {
      const toast = document.createElement("div");
      toast.setAttribute("data-screenshot-twin-toast", "1");
      toast.style.cssText = "position:fixed;top:56px;left:12px;right:12px;background:linear-gradient(135deg,rgba(201,169,110,0.14),rgba(201,169,110,0.04));backdrop-filter:blur(20px);-webkit-backdrop-filter:blur(20px);border:1px solid rgba(201,169,110,0.3);border-radius:16px;padding:14px 16px;z-index:9998;display:flex;gap:12px;align-items:center;box-shadow:0 8px 32px rgba(0,0,0,0.3)";
      toast.innerHTML = html;
      document.body.appendChild(toast);
    }, SAVE_TOAST_HTML);
    await page.waitForTimeout(500);
    try { await snap("profile"); } catch(e) { console.error("FAIL profile: " + e.message); }

  } catch(e) {
    console.error("FATAL: " + e.message);
    console.error(e.stack);
  }

  await browser.close();
  console.log(JSON.stringify(paths));
})();
