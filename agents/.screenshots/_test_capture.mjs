import { chromium } from "playwright";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dir = __dirname;
const ts = String(Date.now());

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

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
  });
  const page = await context.newPage();
  const paths = [];

  async function snap(name) {
    const p = join(dir, ts + "-" + name + ".png");
    await page.screenshot({ path: p, fullPage: false });
    paths.push(p);
    console.error("OK: " + name);
  }

  try {
    // Set mock auth token so app renders authenticated view
    const mockJwtPayload = btoa(JSON.stringify({email:"demo@attaire.com",sub:"demo-user",iat:1774800000,exp:1974800000})).replace(/=/g,"");
    const mockToken = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9." + mockJwtPayload + ".mock-sig";
    await page.addInitScript((token) => {
      localStorage.setItem("attair_token", token);
      localStorage.setItem("attair_interests_picked", "1");
      localStorage.setItem("attair_notif_prompted", "1");
      localStorage.setItem("attair_pref_sheet_shown", "1");
    }, mockToken);

    // Intercept API calls — return REAL mock twins data so React renders twins UI natively
    await page.route("**/api/**", async (route) => {
      const url = route.request().url();
      if (url.includes("/api/user/status")) {
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ plan: "free", scans_today: 0, daily_limit: 3 }) });
      } else if (url.includes("/api/user/profile")) {
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ display_name: "Demo User", email: "demo@attaire.com" }) });
      } else if (url.includes("/api/style-twins")) {
        // Return ready:true with full mock twins — React renders the twins grid through its normal code path
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(MOCK_TWINS_DATA) });
      } else if (url.includes("/api/style-dna")) {
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ axes: { classic_vs_trendy: 3, minimal_vs_maximal: 2, casual_vs_formal: 7, budget_vs_luxury: 6 }, archetype: "Modern Classic", palette: ["navy", "cream", "brown"] }) });
      } else {
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({}) });
      }
    });

    // Load the app
    await page.goto("http://localhost:5173/", { waitUntil: "load", timeout: 15000 });
    await page.waitForTimeout(3500);

    // Navigate to Discover tab
    await page.evaluate(() => {
      const btn = document.querySelector('button[aria-label="Discover"]');
      if (btn) btn.click();
    });
    await page.waitForTimeout(1200);

    // Click Twins sub-tab — React fetches mock twins data and renders natively
    await page.evaluate(() => {
      const btns = document.querySelectorAll('button');
      for (const b of btns) {
        if (b.textContent.trim().includes('Twins')) { b.click(); break; }
      }
    });
    // Wait for React to render twins from mock API response
    await page.waitForTimeout(2500);

    // SCREENSHOT 1 ("home"): Twins cards grid — the core feature UI, React-rendered
    try { await snap("home"); } catch(e) { console.error("FAIL home: " + e.message); }

    // SCREENSHOT 2 ("scan"): Comparison sheet overlay on top of twins grid
    await page.evaluate((html) => {
      const overlay = document.createElement('div');
      overlay.setAttribute('data-screenshot-twin-compare', '1');
      overlay.style.cssText = 'position:fixed;inset:0;z-index:10001';
      overlay.innerHTML = html;
      document.body.appendChild(overlay);
    }, COMPARE_SHEET_HTML);
    await page.waitForTimeout(500);
    try { await snap("scan"); } catch(e) { console.error("FAIL scan: " + e.message); }

    // Remove comparison overlay
    await page.evaluate(() => {
      const el = document.querySelector('[data-screenshot-twin-compare]');
      if (el) el.remove();
    });

    // SCREENSHOT 3 ("profile"): Twins grid with shared save toast banner
    await page.evaluate((html) => {
      const toast = document.createElement('div');
      toast.setAttribute('data-screenshot-twin-toast', '1');
      toast.style.cssText = 'position:fixed;top:56px;left:12px;right:12px;background:linear-gradient(135deg,rgba(201,169,110,0.14),rgba(201,169,110,0.04));backdrop-filter:blur(20px);-webkit-backdrop-filter:blur(20px);border:1px solid rgba(201,169,110,0.3);border-radius:16px;padding:14px 16px;z-index:9998;display:flex;gap:12px;align-items:center;box-shadow:0 8px 32px rgba(0,0,0,0.3)';
      toast.innerHTML = html;
      document.body.appendChild(toast);
    }, SAVE_TOAST_HTML);
    await page.waitForTimeout(500);
    try { await snap("profile"); } catch(e) { console.error("FAIL profile: " + e.message); }

  } catch(e) {
    console.error("FATAL: " + e.message);
  }

  await browser.close();
  console.log(JSON.stringify(paths));
})();
