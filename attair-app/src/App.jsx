import { useState, useRef, useCallback, useEffect } from "react";

// ═══════════════════════════════════════════════════════════════
// CONFIG — Change this to your Railway URL in production
// ═══════════════════════════════════════════════════════════════
const API_BASE = "http://localhost:3000";

// Supabase public config for OAuth (safe to expose — anon key is public)
const SUPABASE_URL="https://cmlgqztjkrfipzknwnfm.supabase.co"
const SUPABASE_ANON_KEY="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNtbGdxenRqa3JmaXB6a253bmZtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM4NzkzMzQsImV4cCI6MjA4OTQ1NTMzNH0.zQItty8IrgKmwTnpPAAtupzujYwHoLYO2KklNSr8pUg"

// ═══════════════════════════════════════════════════════════════
// AUTH HELPERS — Token management + auto-refresh
// ═══════════════════════════════════════════════════════════════
const Auth = {
  getToken: () => localStorage.getItem("attair_token"),
  getRefresh: () => localStorage.getItem("attair_refresh"),
  setTokens: (access, refresh) => {
    localStorage.setItem("attair_token", access);
    localStorage.setItem("attair_refresh", refresh);
  },
  clear: () => {
    localStorage.removeItem("attair_token");
    localStorage.removeItem("attair_refresh");
  },
  headers: () => {
    const t = localStorage.getItem("attair_token");
    return t ? { Authorization: `Bearer ${t}`, "Content-Type": "application/json" } : { "Content-Type": "application/json" };
  },
  _refreshing: null, // singleton promise to prevent concurrent refreshes
  async refreshToken() {
    // If a refresh is already in flight, wait for it
    if (Auth._refreshing) return Auth._refreshing;
    const rt = Auth.getRefresh();
    if (!rt) throw new Error("No refresh token");
    Auth._refreshing = fetch(`${API_BASE}/api/auth/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refresh_token: rt }),
    })
      .then(async (res) => {
        Auth._refreshing = null;
        if (!res.ok) throw new Error("Refresh failed");
        const data = await res.json();
        Auth.setTokens(data.access_token, data.refresh_token);
        return true;
      })
      .catch((err) => {
        Auth._refreshing = null;
        Auth.clear();
        throw err;
      });
    return Auth._refreshing;
  },
};

/**
 * Decode a Supabase JWT to extract user info (email, etc.)
 * Returns { email, sub } or null if decode fails.
 */
function decodeJwt(token) {
  try {
    const payload = JSON.parse(atob(token.split('.')[1]));
    return payload;
  } catch {
    return null;
  }
}

/**
 * Fetch wrapper that auto-retries on 401 by refreshing the token once.
 * If refresh fails, clears auth and throws "Session expired".
 */
async function authFetch(url, options = {}) {
  const res = await fetch(url, { ...options, headers: Auth.headers() });
  if (res.status === 401 && Auth.getRefresh()) {
    try {
      await Auth.refreshToken();
      // Retry with the new token
      const retry = await fetch(url, { ...options, headers: Auth.headers() });
      return retry;
    } catch {
      Auth.clear();
      throw new Error("Session expired — please log in again");
    }
  }
  return res;
}

// ═══════════════════════════════════════════════════════════════
// SERVICE LAYER — All calls go to your backend
// ═══════════════════════════════════════════════════════════════
const API = {
  async signup(email, password, { display_name, phone, gender_pref, budget_min, budget_max } = {}) {
    const res = await fetch(`${API_BASE}/api/auth/signup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password, display_name, phone, gender_pref, budget_min, budget_max }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Signup failed");
    Auth.setTokens(data.access_token, data.refresh_token);
    return data;
  },

  async login(email, password) {
    const res = await fetch(`${API_BASE}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Login failed");
    Auth.setTokens(data.access_token, data.refresh_token);
    return data;
  },

  async getUserStatus() {
    const res = await authFetch(`${API_BASE}/api/user/status`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Failed to get status");
    return data;
  },

  async identifyClothing(base64, mimeType, userPrefs) {
    const res = await authFetch(`${API_BASE}/api/identify`, {
      method: "POST",
      body: JSON.stringify({ image: base64, mime_type: mimeType, user_prefs: userPrefs }),
    });
    if (res.status === 429) {
      const data = await res.json();
      throw new Error(data.message || "Daily scan limit reached");
    }
    if (!res.ok) { const data = await res.json(); throw new Error(data.message || `API error ${res.status}`); }
    return await res.json();
  },

  async findProducts(items, gender, scanId) {
    const res = await authFetch(`${API_BASE}/api/find-products`, {
      method: "POST",
      body: JSON.stringify({ items, gender, scan_id: scanId }),
    });
    if (!res.ok) { const data = await res.json(); throw new Error(data.message || "Product search failed"); }
    return await res.json();
  },

  async getHistory() {
    const res = await authFetch(`${API_BASE}/api/user/history`);
    if (!res.ok) return { scans: [] };
    return await res.json();
  },

  async getSaved() {
    const res = await authFetch(`${API_BASE}/api/user/saved`);
    if (!res.ok) return { items: [] };
    return await res.json();
  },

  async saveItem(scanId, itemData, selectedTier, tierProduct) {
    const res = await authFetch(`${API_BASE}/api/user/saved`, {
      method: "POST",
      body: JSON.stringify({ scan_id: scanId, item_data: itemData, selected_tier: selectedTier, tier_product: tierProduct }),
    });
    if (res.status === 429) {
      const data = await res.json();
      throw new Error(data.message || "Save limit reached");
    }
    if (!res.ok) { const data = await res.json(); throw new Error(data.error || "Save failed"); }
    return await res.json();
  },

  async deleteSaved(id) {
    await authFetch(`${API_BASE}/api/user/saved/${id}`, { method: "DELETE" });
  },

  async logAdEvent(ad_type, ad_placement, action) {
    authFetch(`${API_BASE}/api/ad-events`, {
      method: "POST",
      body: JSON.stringify({ ad_type, ad_placement, action }),
    }).catch(() => {});
  },

  affiliateUrl(clickId, url, scanId, itemIndex, tier, retailer) {
    const params = new URLSearchParams({ url, scan_id: scanId || "", item_index: itemIndex, tier, retailer });
    return `${API_BASE}/api/go/${clickId}?${params}`;
  },

  oauthLogin(provider) {
    const redirectTo = window.location.origin + "/";
    window.location.href = `${SUPABASE_URL}/auth/v1/authorize?provider=${provider}&redirect_to=${encodeURIComponent(redirectTo)}`;
  },

  async renameScan(scanId, name) {
    const res = await authFetch(`${API_BASE}/api/user/scan/${scanId}`, { method: "PATCH", body: JSON.stringify({ scan_name: name }) });
    return res.ok ? await res.json() : null;
  },

  async deleteScan(scanId) {
    const res = await authFetch(`${API_BASE}/api/user/scan/${scanId}`, { method: "DELETE" });
    return res.ok;
  },

  async toggleScanSave(scanId) {
    const res = await authFetch(`${API_BASE}/api/user/scan/${scanId}/save`, { method: "POST" });
    if (res.status === 429) throw new Error("Save limit reached");
    return res.ok ? await res.json() : null;
  },

  async updateProfile(updates) {
    const res = await authFetch(`${API_BASE}/api/user/profile`, { method: "PATCH", body: JSON.stringify(updates) });
    return res.ok ? await res.json() : null;
  },
};

// ═══════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════
function resizeImage(dataUrl, maxDim = 1024) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      let w = img.width, h = img.height;
      if (w > maxDim || h > maxDim) { const r = Math.min(maxDim/w, maxDim/h); w = Math.round(w*r); h = Math.round(h*r); }
      const c = document.createElement("canvas"); c.width = w; c.height = h;
      c.getContext("2d").drawImage(img, 0, 0, w, h);
      const du = c.toDataURL("image/jpeg", 0.82);
      resolve({ dataUrl: du, base64: du.split(",")[1], mime: "image/jpeg" });
    };
    img.onerror = () => resolve({ dataUrl, base64: dataUrl.split(",")[1], mime: "image/jpeg" });
    img.src = dataUrl;
  });
}

// ═══════════════════════════════════════════════════════════════
// COMPONENTS
// ═══════════════════════════════════════════════════════════════
const ConfidenceRing = ({ value, size = 48, stroke = 3, label }) => {
  const r = (size - stroke) / 2, c = 2 * Math.PI * r, off = c - (value / 100) * c;
  const color = value >= 80 ? "#C9A96E" : value >= 55 ? "rgba(255,255,255,0.5)" : "rgba(255,255,255,0.25)";
  return (
    <div style={{ position: "relative", width: size, height: size, flexShrink: 0 }}>
      <svg width={size} height={size} style={{ transform: "rotate(-90deg)" }}>
        <circle cx={size/2} cy={size/2} r={r} fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth={stroke} />
        <circle cx={size/2} cy={size/2} r={r} fill="none" stroke={color} strokeWidth={stroke} strokeDasharray={c} strokeDashoffset={off} strokeLinecap="round" style={{ transition: "stroke-dashoffset 0.8s ease" }} />
      </svg>
      <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center" }}>
        <span style={{ fontFamily: "'Outfit'", fontSize: size * 0.22, fontWeight: 700, color, lineHeight: 1 }}>{value}%</span>
        {label && <span style={{ fontSize: 7, fontWeight: 600, letterSpacing: 0.8, color: "rgba(255,255,255,0.3)", textTransform: "uppercase", marginTop: 1 }}>{label}</span>}
      </div>
    </div>
  );
};

const StatusPill = ({ status }) => {
  const cfg = {
    identified: { text: "AI IDENTIFIED", bg: "rgba(255,255,255,0.06)", color: "rgba(255,255,255,0.35)", dot: "rgba(255,255,255,0.25)" },
    searching: { text: "SEARCHING…", bg: "rgba(201,169,110,0.08)", color: "#C9A96E", dot: "#C9A96E", pulse: true },
    verified: { text: "WEB VERIFIED", bg: "rgba(201,169,110,0.1)", color: "#C9A96E", dot: "#C9A96E" },
    failed: { text: "AI ONLY", bg: "rgba(255,255,255,0.04)", color: "rgba(255,255,255,0.25)", dot: "rgba(255,255,255,0.15)" },
  }[status] || {};
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 5, padding: "3px 9px", borderRadius: 4, background: cfg.bg, fontSize: 9, fontWeight: 700, letterSpacing: 1.2, color: cfg.color }}>
      <span style={{ width: 5, height: 5, borderRadius: "50%", background: cfg.dot, ...(cfg.pulse ? { animation: "pulse 1.4s ease-in-out infinite" } : {}) }} />
      {cfg.text}
    </span>
  );
};

const TierCard = ({ tier, data, scanId, itemIndex }) => {
  if (!data) return null;
  const tierCfg = { budget: { label: "Save", icon: "$", accent: "#5AC8FF" }, mid: { label: "Best value", icon: "$$", accent: "#C9A96E" }, premium: { label: "Splurge", icon: "$$$", accent: "#C77DFF" } }[tier];
  const clickId = `${scanId || "x"}_${itemIndex}_${tier}`;
  const href = data.url ? API.affiliateUrl(clickId, data.url, scanId, itemIndex, tier, data.brand) : "#";
  const isFallback = !data.is_product_page && data.brand === "Google Shopping";
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" style={{ padding: 16, background: isFallback ? "rgba(255,255,255,0.01)" : "rgba(255,255,255,0.02)", border: `1px solid ${data.is_identified_brand ? "rgba(201,169,110,0.3)" : isFallback ? "rgba(255,255,255,0.03)" : "rgba(255,255,255,0.05)"}`, borderRadius: 14, textDecoration: "none", color: "inherit", display: "flex", flexDirection: "column", gap: 8, transition: "all 0.2s" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: 1.5, color: isFallback ? "rgba(255,255,255,.2)" : tierCfg.accent, textTransform: "uppercase" }}>{tierCfg.icon} {tierCfg.label}</span>
        {data.is_identified_brand && <span style={{ fontSize: 8, fontWeight: 800, letterSpacing: 1, padding: "2px 6px", borderRadius: 3, background: "rgba(201,169,110,0.12)", color: "#C9A96E" }}>ORIGINAL</span>}
        {data.is_product_page && !data.is_identified_brand && <span style={{ fontSize: 8, fontWeight: 700, letterSpacing: .5, padding: "2px 6px", borderRadius: 3, background: "rgba(255,255,255,0.04)", color: "rgba(255,255,255,0.3)" }}>Product page</span>}
      </div>
      {isFallback ? (
        <>
          <div style={{ fontSize: 14, fontWeight: 600, lineHeight: 1.3, color: "rgba(255,255,255,.35)" }}>No exact match found</div>
          <div style={{ fontSize: 12, color: "rgba(255,255,255,.2)" }}>{data.price}</div>
          <div style={{ marginTop: "auto", padding: "10px 0 2px", fontSize: 12, fontWeight: 700, color: tierCfg.accent, textAlign: "center", borderTop: "1px solid rgba(255,255,255,0.04)" }}>Search Google Shopping →</div>
        </>
      ) : (
        <>
          <div style={{ fontSize: 14, fontWeight: 600, lineHeight: 1.3 }}>{data.product_name || "Loading…"}</div>
          <div style={{ fontSize: 12, color: "rgba(255,255,255,0.4)" }}>{data.brand}</div>
          <div style={{ fontSize: 18, fontWeight: 700, color: tierCfg.accent, fontFamily: "'Outfit'" }}>{data.price}</div>
          {data.why && <div style={{ fontSize: 11, color: "rgba(255,255,255,0.25)", lineHeight: 1.4, fontStyle: "italic" }}>{data.why}</div>}
          <div style={{ marginTop: "auto", padding: "10px 0 2px", fontSize: 12, fontWeight: 700, color: tierCfg.accent, textAlign: "center", borderTop: `1px solid rgba(255,255,255,0.04)` }}>Shop →</div>
        </>
      )}
    </a>
  );
};

// ─── Upgrade Modal ──────────────────────────────────────────
const UpgradeModal = ({ trigger, onClose, onUpgrade }) => {
  const msgs = {
    scan_limit: { title: "You've used all 3 free scans today", sub: "Go Pro for unlimited scans, zero ads, and price drop alerts.", cta: "Unlock Unlimited Scans" },
    ad_fatigue: { title: "Tired of ads?", sub: "Pro members get a completely ad-free experience plus unlimited scans.", cta: "Remove Ads Forever" },
    history_expiring: { title: "Your scan history expires soon", sub: "Free accounts only keep 7 days. Pro keeps everything forever.", cta: "Keep My History" },
    save_limit: { title: "You've saved 20 items", sub: "Unlock unlimited saves, price drop alerts, and an ad-free experience.", cta: "Save Unlimited Items" },
    price_drop: { title: "A saved item dropped 30%", sub: "Pro users get instant price drop alerts. Never miss a deal.", cta: "Get Price Alerts" },
    general: { title: "Unlock the full experience", sub: "Unlimited scans, zero ads, price alerts, and more.", cta: "Go Pro" },
  };
  const m = msgs[trigger] || msgs.general;
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-box" onClick={e => e.stopPropagation()}>
        <button className="modal-x" onClick={onClose}>✕</button>
        <div className="pw-badge">✦ ATTAIR PRO</div>
        <h2 className="modal-title">{m.title}</h2>
        <p className="modal-sub">{m.sub}</p>
        <div className="pw-fs" style={{ marginBottom: 24 }}>
          {["Unlimited AI outfit scans", "Completely ad-free", "Price drop alerts", "Full scan history forever"].map((f, i) => (
            <div className="pw-f" key={i}><div className="pw-ck">✓</div>{f}</div>
          ))}
        </div>
        <div style={{ display: "flex", gap: 10, marginBottom: 12 }}>
          <div style={{ flex: 1, textAlign: "center" }}>
            <div style={{ fontSize: 20, fontWeight: 700, color: "#fff" }}>$39.99<span style={{ fontSize: 13, color: "rgba(255,255,255,.35)" }}>/yr</span></div>
            <div style={{ fontSize: 10, color: "rgba(255,255,255,.2)" }}>$0.77/week</div>
          </div>
          <div style={{ width: 1, background: "rgba(255,255,255,.06)" }} />
          <div style={{ flex: 1, textAlign: "center" }}>
            <div style={{ fontSize: 20, fontWeight: 700, color: "#fff" }}>$9.99<span style={{ fontSize: 13, color: "rgba(255,255,255,.35)" }}>/mo</span></div>
            <div style={{ fontSize: 10, color: "rgba(255,255,255,.2)" }}>$2.50/week</div>
          </div>
        </div>
        <button className="cta" onClick={onUpgrade}>{m.cta}</button>
        <button className="modal-later" onClick={onClose}>Maybe later</button>
      </div>
    </div>
  );
};

// ─── Interstitial Ad Placeholder ────────────────────────────
const InterstitialAd = ({ onClose }) => {
  const [timer, setTimer] = useState(5);
  useEffect(() => {
    API.logAdEvent("interstitial", "post_scan", "impression");
    const iv = setInterval(() => setTimer(t => { if (t <= 1) { clearInterval(iv); } return t - 1; }), 1000);
    return () => clearInterval(iv);
  }, []);
  return (
    <div className="modal-overlay" onClick={() => timer <= 3 && onClose()}>
      <div onClick={e => e.stopPropagation()} style={{ width: "100%", maxWidth: 400, aspectRatio: "9/16", background: "#111114", border: "1px solid rgba(255,255,255,.06)", borderRadius: 20, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 16, position: "relative" }}>
        <div className="ad-slot" style={{ width: "90%", height: "70%", borderRadius: 12, fontSize: 11 }}>INTERSTITIAL AD</div>
        <div style={{ fontSize: 10, color: "rgba(255,255,255,.15)" }}>Ad placeholder — AdMob SDK in Phase 3</div>
        {timer > 0
          ? <div style={{ position: "absolute", top: 16, right: 16, fontSize: 12, color: "rgba(255,255,255,.25)" }}>Skip in {timer}s</div>
          : <button onClick={onClose} style={{ position: "absolute", top: 14, right: 14, background: "rgba(255,255,255,.08)", border: "none", borderRadius: 100, padding: "6px 14px", fontSize: 12, fontWeight: 600, color: "#fff", cursor: "pointer", fontFamily: "'Outfit'" }}>Skip →</button>
        }
      </div>
    </div>
  );
};

const CAT_POSITIONS = { outerwear: 0.3, top: 0.35, dress: 0.4, bottom: 0.65, shoes: 0.88, accessory: 0.15, bag: 0.55 };

// ═══════════════════════════════════════════════════════════════
// ONBOARDING
// ═══════════════════════════════════════════════════════════════
const OB_STEPS = [
  { id: "welcome", type: "info", icon: "✦", title: "Identify any outfit.\nShop it at any budget.", sub: "Snap a photo. Our AI identifies every item, then finds you a budget, mid-range, and premium option for each.", cta: "Get Started" },
  { id: "gender", type: "select", title: "I usually shop for…", sub: "We also auto-detect from each photo.", opts: [{ l: "Menswear", v: "men" },{ l: "Womenswear", v: "women" },{ l: "Both", v: "both" }] },
  { id: "budget", type: "budget_range", title: "What's your budget\nper item?", sub: "We'll tailor budget, mid, and premium tiers to your range. You can change this anytime." },
  { id: "proof", type: "info", icon: "◎", title: "You're all set.", sub: "Every scan gives you 3 price options per item — budget, mid-range, and premium. You choose.", cta: "Continue" },
];

// ═══════════════════════════════════════════════════════════════
// MAIN APP
// ═══════════════════════════════════════════════════════════════
export default function App() {
  // ─── Auth state ───────────────────────────────────────────
  const [authed, setAuthed] = useState(!!Auth.getToken());
  const [authScreen, setAuthScreen] = useState("login"); // login | signup
  const [authEmail, setAuthEmail] = useState("");
  const [authPass, setAuthPass] = useState("");
  const [authErr, setAuthErr] = useState(null);
  const [authLoading, setAuthLoading] = useState(false);
  const [showPass, setShowPass] = useState(false);
  const [authName, setAuthName] = useState("");
  const [authPhone, setAuthPhone] = useState("");
  const [budgetMin, setBudgetMin] = useState(50);
  const [budgetMax, setBudgetMax] = useState(100);

  // ─── User status (from backend) ───────────────────────────
  const [userStatus, setUserStatus] = useState(null); // { tier, scans_remaining_today, saved_count, show_ads, ... }

  // ─── App state ────────────────────────────────────────────
  const [screen, setScreen] = useState("onboarding");
  const [obIdx, setObIdx] = useState(0);
  const [prefs, setPrefs] = useState({});
  const [selPlan, setSelPlan] = useState("yearly");
  const [tab, setTab] = useState("scan");
  const [img, setImg] = useState(null);
  const [results, setResults] = useState(null);
  const [scanId, setScanId] = useState(null);
  const [phase, setPhase] = useState("idle");
  const [error, setError] = useState(null);
  const [selIdx, setSelIdx] = useState(null);
  const [history, setHistory] = useState([]);
  const [saved, setSaved] = useState([]);
  const [fade, setFade] = useState("fi");
  const [historyFilter, setHistoryFilter] = useState("all"); // "all" | "saved"
  const [upgradeModal, setUpgradeModal] = useState(null); // null | trigger string
  const [showInterstitial, setShowInterstitial] = useState(false);
  const fileRef = useRef(null);
  const vidRef = useRef(null);
  const canRef = useRef(null);
  const streamRef = useRef(null);
  const [camOn, setCamOn] = useState(false);
  const [camReady, setCamReady] = useState(false);

  // ─── Fetch user status on auth ────────────────────────────
  const refreshStatus = useCallback(async () => {
    try {
      const status = await API.getUserStatus();
      setUserStatus(status);
    } catch (err) {
      if (err.message === "Session expired") {
        setAuthed(false);
        setScreen("onboarding");
      }
    }
  }, []);

  useEffect(() => {
    if (authed) {
      // Restore email from JWT immediately (no API call needed)
      const token = Auth.getToken();
      if (token) {
        const jwt = decodeJwt(token);
        if (jwt?.email) setAuthEmail(jwt.email);
      }
      refreshStatus();
      // Fetch profile to restore display name + preferences
      authFetch(`${API_BASE}/api/user/profile`)
        .then(r => r.json())
        .then(profile => {
          if (profile.display_name) setAuthName(profile.display_name);
          if (profile.gender_pref) setPrefs(p => ({ ...p, gender: profile.gender_pref }));
          if (profile.budget_min != null) setBudgetMin(profile.budget_min);
          if (profile.budget_max != null) setBudgetMax(profile.budget_max);
        })
        .catch(() => {});
      // Also load history + saved
      API.getHistory().then(d => setHistory(d.scans || [])).catch(() => {});
      API.getSaved().then(d => setSaved(d.items || [])).catch(() => {});
      // Skip onboarding if returning user
      if (screen === "onboarding") setScreen("app");
    }
  }, [authed]);

  // ─── Helpers ──────────────────────────────────────────────
  const trans = (fn) => { setFade("fo"); setTimeout(() => { fn(); setFade("fi"); }, 220); };
  const obNext = (v) => {
    const step = OB_STEPS[obIdx];
    if (step.type === "budget_range") {
      setPrefs(p => ({ ...p, budget_min: budgetMin, budget_max: budgetMax }));
    } else if (v) {
      setPrefs(p => ({ ...p, [step.id]: v }));
    }
    if (obIdx < OB_STEPS.length - 1) trans(() => setObIdx(i => i + 1));
    else trans(() => setScreen("paywall"));
  };
  const isFree = !userStatus || userStatus.tier === "free" || userStatus.tier === "expired";
  const isPro = userStatus?.tier === "pro" || userStatus?.tier === "trial";
  const scansLeft = userStatus?.scans_remaining_today ?? 3;
  const scansLimit = userStatus?.scans_limit ?? 3;
  const showAds = userStatus?.show_ads ?? true;

  // ─── OAuth callback — check URL hash for tokens on mount ──
  useEffect(() => {
    const hash = window.location.hash;
    if (hash.includes("access_token=")) {
      const params = new URLSearchParams(hash.replace("#", ""));
      const access = params.get("access_token");
      const refresh = params.get("refresh_token");
      if (access && refresh) {
        Auth.setTokens(access, refresh);
        // Extract email from JWT for immediate display
        const jwt = decodeJwt(access);
        if (jwt?.email) setAuthEmail(jwt.email);
        setAuthed(true);
        setScreen("app");
        window.history.replaceState(null, "", window.location.pathname);
      }
    }
  }, []);

  // ─── Auth handlers ────────────────────────────────────────
  const handleAuth = async () => {
    setAuthErr(null);
    setAuthLoading(true);
    try {
      if (authScreen === "signup") {
        await API.signup(authEmail, authPass, {
          display_name: authName || undefined,
          phone: authPhone,
          gender_pref: prefs.gender,
          budget_min: prefs.budget_min || budgetMin,
          budget_max: prefs.budget_max || budgetMax,
        });
      } else {
        await API.login(authEmail, authPass);
        // Restore preferences from profile for returning users
        try {
          const status = await API.getUserStatus();
          setUserStatus(status);
        } catch {}
        try {
          const profile = await authFetch(`${API_BASE}/api/user/profile`).then(r => r.json());
          if (profile.gender_pref) setPrefs(p => ({ ...p, gender: profile.gender_pref }));
          if (profile.budget_min != null) setBudgetMin(profile.budget_min);
          if (profile.budget_max != null) setBudgetMax(profile.budget_max);
        } catch {}
      }
      setAuthed(true);
      setScreen("app");
    } catch (err) {
      setAuthErr(err.message);
    }
    setAuthLoading(false);
  };

  // Camera
  const camStart = async () => {
    try {
      const s = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment", width: { ideal: 1280 } } });
      streamRef.current = s;
      if (vidRef.current) { vidRef.current.srcObject = s; vidRef.current.onloadedmetadata = () => setCamReady(true); }
      setCamOn(true);
    } catch { setError("Camera denied. Upload a photo instead."); }
  };
  const camCapture = async () => {
    if (!vidRef.current || !canRef.current) return;
    const v = vidRef.current, c = canRef.current;
    c.width = v.videoWidth; c.height = v.videoHeight;
    c.getContext("2d").drawImage(v, 0, 0);
    camStop();
    const r = await resizeImage(c.toDataURL("image/jpeg", 0.85));
    setImg(r.dataUrl);
    runScan(r.base64, r.mime);
  };
  const camStop = () => {
    if (streamRef.current) { streamRef.current.getTracks().forEach(t => t.stop()); streamRef.current = null; }
    setCamOn(false); setCamReady(false);
  };

  // File upload
  const handleFile = useCallback((file) => {
    if (!file) return;
    const validExts = [".jpg",".jpeg",".png",".gif",".webp",".heic",".heif",".bmp",".tiff"];
    const ext = (file.name || "").toLowerCase().slice(file.name.lastIndexOf("."));
    const isImage = (file.type || "").startsWith("image/") || validExts.includes(ext) || !file.type;
    if (!isImage) { setError("Please upload an image file."); return; }
    setError(null);
    const tryBlob = () => {
      try {
        const url = URL.createObjectURL(file);
        const im = new Image();
        im.onload = async () => { const r = await resizeImage(url); URL.revokeObjectURL(url); setImg(r.dataUrl); runScan(r.base64, r.mime); };
        im.onerror = () => { URL.revokeObjectURL(url); tryReader(); };
        im.src = url;
      } catch { tryReader(); }
    };
    const tryReader = () => {
      const rd = new FileReader();
      rd.onload = async (e) => {
        try { const r = await resizeImage(e.target.result); setImg(r.dataUrl); runScan(r.base64, r.mime); }
        catch { setError("Couldn't process image. Try screenshotting it first."); }
      };
      rd.readAsDataURL(file);
    };
    tryBlob();
  }, []);

  // ─── Pre-scan gate: check limits ─────────────────────────
  const canScan = () => {
    if (isPro) return true;
    if (scansLeft <= 0) {
      setUpgradeModal("scan_limit");
      return false;
    }
    return true;
  };

  // ═══════════════════════════════════════════════════════════
  // SCAN ENGINE — now calls backend, not Anthropic directly
  // ═══════════════════════════════════════════════════════════
  const runScan = async (base64, mime) => {
    if (!canScan()) return;

    setPhase("identifying"); setResults(null); setSelIdx(null); setError(null); setScanId(null);

    // Phase 1: Identify (backend handles Claude + dedup + rate limit + image storage)
    let identified;
    try {
      const raw = await API.identifyClothing(base64, mime, prefs);
      let items = (raw.items || []).map(item => ({ ...item, status: "identified", tiers: null }));
      identified = { gender: raw.gender || "male", summary: raw.summary || "", items, scanId: raw.scan_id, imageUrl: raw.image_url };
      setScanId(raw.scan_id);
      setResults(identified);
      setSelIdx(0);
      setPhase("identified");

      // Update status (scan count changed) — optimistic local update + server confirm
      setUserStatus(prev => prev ? { ...prev, scans_remaining_today: Math.max(0, (prev.scans_remaining_today ?? 3) - 1) } : prev);
      refreshStatus();

      // Show interstitial ad for free users (skip on first-ever scan — don't be hostile)
      if (showAds && scansLeft < 2) {
        setShowInterstitial(true);
      }
      // After 2nd scan of the day, also show upgrade prompt
      if (showAds && scansLeft <= 1) {
        setTimeout(() => setUpgradeModal("ad_fatigue"), 800);
      }
    } catch (err) {
      setPhase("idle");
      // Check if it's a rate limit error → show upgrade
      if (err.message.includes("scan limit") || err.message.includes("3/3")) {
        setUpgradeModal("scan_limit");
        setError("You've used all your free scans for today.");
      } else if (err.message.includes("Session expired")) {
        setError("Your session expired. Please log in again.");
        setAuthed(false);
        setScreen("auth");
      } else if (err.message.includes("fetch") || err.message.includes("network") || err.message.includes("Failed")) {
        setError("Couldn't connect to the server. Check your internet connection and try again.");
      } else {
        console.error("Identify error:", err.message);
        setError("Something went wrong analyzing the photo. Please try again.");
      }
      return;
    }

    // Phase 2: Find products (three-tier via SerpAPI on backend)
    setPhase("searching");
    setResults(prev => prev ? { ...prev, items: prev.items.map(it => ({ ...it, status: "searching" })) } : prev);

    try {
      const searchResults = await API.findProducts(identified.items, identified.gender, identified.scanId);
      setResults(prev => {
        if (!prev) return prev;
        const updated = prev.items.map((item, idx) => {
          const sr = Array.isArray(searchResults) ? (searchResults.find(s => s.item_index === idx) || searchResults[idx]) : null;
          if (!sr || !sr.tiers) return { ...item, status: "failed" };
          return { ...item, status: "verified", brand_verified: sr.brand_verified || false, tiers: sr.tiers };
        });
        return { ...prev, items: updated };
      });
    } catch (err) {
      console.error("Product search failed:", err);
      setResults(prev => prev ? { ...prev, items: prev.items.map(it => it.status === "searching" ? { ...it, status: "failed" } : it) } : prev);
    }
    setPhase("done");

    // Refresh history + saved so those tabs are up to date
    API.getHistory().then(d => setHistory(d.scans || [])).catch(() => {});
    API.getSaved().then(d => setSaved(d.items || [])).catch(() => {});
  };

  const reset = () => { setImg(null); setResults(null); setSelIdx(null); setError(null); setPhase("idle"); setScanId(null); };

  // ─── Save with backend persistence ────────────────────────
  const toggleSave = async (item) => {
    const existing = saved.find(i => (i.item_data || i).name === item.name);
    if (existing) {
      await API.deleteSaved(existing.id).catch(() => {});
      setSaved(s => s.filter(i => i.id !== existing.id));
      refreshStatus();
    } else {
      // Check save limit for free users
      if (isFree && (userStatus?.saved_count || 0) >= (userStatus?.saved_limit || 20)) {
        setUpgradeModal("save_limit");
        return;
      }
      try {
        const res = await API.saveItem(scanId, item);
        setSaved(s => [...s, { id: res.id, item_data: item, created_at: new Date().toISOString() }]);
        refreshStatus();
      } catch (err) {
        if (err.message.includes("limit")) setUpgradeModal("save_limit");
      }
    }
  };
  const isSaved = (item) => saved.some(i => (i.item_data || i).name === item.name);

  const brandConfLabel = (c) => ({ confirmed: { t: "Confirmed", c: "#C9A96E" }, high: { t: "High confidence", c: "rgba(201,169,110,0.7)" }, moderate: { t: "Moderate", c: "rgba(255,255,255,0.4)" }, low: { t: "Estimated", c: "rgba(255,255,255,0.25)" } }[c] || { t: "Unknown", c: "rgba(255,255,255,0.2)" });

  const handleLogout = () => { Auth.clear(); setAuthed(false); setAuthEmail(""); setAuthName(""); setUserStatus(null); setScreen("onboarding"); setObIdx(0); };

  const step = OB_STEPS[obIdx];
  const prog = ((obIdx + 1) / OB_STEPS.length) * 100;

  return (<>
    <style>{`
      @import url('https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&family=Outfit:wght@300;400;500;600;700;800&display=swap');
      *{margin:0;padding:0;box-sizing:border-box;-webkit-tap-highlight-color:transparent}
      @keyframes fi{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:translateY(0)}}
      @keyframes fo{from{opacity:1}to{opacity:0}}
      @keyframes scan{0%{top:5%}50%{top:92%}100%{top:5%}}
      @keyframes pulse{0%,100%{opacity:.35}50%{opacity:1}}
      @keyframes slideIn{from{opacity:0;transform:translateY(16px)}to{opacity:1;transform:translateY(0)}}
      .fi{animation:fi .3s ease forwards}.fo{animation:fo .22s ease forwards}
      .app{width:100%;max-width:430px;min-height:100vh;margin:0 auto;background:#0C0C0E;font-family:'Outfit',sans-serif;color:#E8E6E1;display:flex;flex-direction:column;overflow-x:hidden}
      .serif{font-family:'Instrument Serif',serif}

      .ob{flex:1;display:flex;flex-direction:column;padding:20px 28px}
      .ob-bar{height:2px;background:rgba(255,255,255,.06);border-radius:1px;margin-bottom:40px;overflow:hidden}
      .ob-fill{height:100%;background:#C9A96E;transition:width .4s ease}
      .ob-body{flex:1;display:flex;flex-direction:column;justify-content:center}
      .ob-icon{font-size:32px;margin-bottom:20px;color:#C9A96E}
      .ob-title{font-family:'Instrument Serif';font-size:32px;line-height:1.15;margin-bottom:14px;white-space:pre-line;color:#fff}
      .ob-sub{font-size:14px;color:rgba(255,255,255,.4);line-height:1.6;margin-bottom:36px}
      .ob-opts{display:flex;flex-direction:column;gap:10px}
      .ob-opt{padding:18px 22px;background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.07);border-radius:14px;cursor:pointer;transition:all .2s;font-size:15px;font-weight:500;color:rgba(255,255,255,.75)}
      .ob-opt:hover{background:rgba(255,255,255,.06);border-color:rgba(255,255,255,.12)}
      .ob-stats{display:flex;gap:32px;margin-bottom:36px}
      .ob-sn{font-family:'Outfit';font-size:24px;font-weight:700;color:#C9A96E}
      .ob-sl{font-size:11px;color:rgba(255,255,255,.3);letter-spacing:1px;text-transform:uppercase;margin-top:2px}
      .cta{width:100%;padding:17px;background:#C9A96E;color:#0C0C0E;border:none;border-radius:14px;font-family:'Outfit';font-size:15px;font-weight:700;cursor:pointer;transition:all .2s;margin-top:auto}.cta:hover{background:#D4B87A}

      .pw{flex:1;display:flex;flex-direction:column;padding:20px 28px}
      .pw-skip{align-self:flex-end;background:none;border:none;color:rgba(255,255,255,.25);font-size:13px;cursor:pointer;padding:8px;font-family:'Outfit'}
      .pw-badge{display:inline-flex;align-items:center;gap:5px;background:rgba(201,169,110,.08);border:1px solid rgba(201,169,110,.15);border-radius:100px;padding:7px 14px;font-size:11px;font-weight:600;color:#C9A96E;letter-spacing:.8px;margin:16px 0 20px;align-self:flex-start}
      .pw-t{font-family:'Instrument Serif';font-size:30px;line-height:1.15;margin-bottom:8px;color:#fff}
      .pw-st{font-size:14px;color:rgba(255,255,255,.35);line-height:1.5;margin-bottom:28px}
      .pw-fs{display:flex;flex-direction:column;gap:12px;margin-bottom:32px}
      .pw-f{display:flex;align-items:center;gap:11px;font-size:14px;color:rgba(255,255,255,.6)}
      .pw-ck{width:20px;height:20px;border-radius:50%;background:rgba(201,169,110,.1);display:flex;align-items:center;justify-content:center;flex-shrink:0;color:#C9A96E;font-size:10px;font-weight:700}
      .pw-plans{display:flex;gap:10px;margin-bottom:28px}
      .pw-p{flex:1;padding:20px 14px;border-radius:14px;border:1.5px solid rgba(255,255,255,.06);cursor:pointer;transition:all .2s;position:relative;background:rgba(255,255,255,.01)}.pw-p.sel{border-color:rgba(201,169,110,.5);background:rgba(201,169,110,.03)}
      .pw-ptag{position:absolute;top:-9px;left:50%;transform:translateX(-50%);background:#C9A96E;color:#0C0C0E;font-size:9px;font-weight:800;padding:3px 10px;border-radius:100px;letter-spacing:1px;white-space:nowrap}
      .pw-pp{font-size:22px;font-weight:700;color:#fff}.pw-pd{font-size:12px;color:rgba(255,255,255,.3)}.pw-pw{font-size:11px;color:rgba(255,255,255,.2);margin-top:4px}
      .pw-terms{text-align:center;font-size:10px;color:rgba(255,255,255,.15);margin-top:14px}

      .auth{flex:1;display:flex;flex-direction:column;padding:20px 28px;justify-content:center}
      .auth input{width:100%;padding:16px 18px;background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.08);border-radius:12px;color:#fff;font-family:'Outfit';font-size:15px;outline:none;margin-bottom:10px;transition:border-color .2s}
      .auth input:focus{border-color:rgba(201,169,110,.4)}
      .auth input::placeholder{color:rgba(255,255,255,.2)}
      .auth-toggle{background:none;border:none;color:#C9A96E;font-family:'Outfit';font-size:13px;cursor:pointer;padding:8px;text-align:center;width:100%;margin-top:8px}
      .auth-err{background:rgba(255,80,80,.06);border:1px solid rgba(255,80,80,.12);border-radius:10px;padding:12px;font-size:13px;color:rgba(255,130,130,.8);margin-bottom:12px;text-align:center}

      .as{flex:1;display:flex;flex-direction:column;padding-bottom:80px}
      .hdr{display:flex;align-items:center;justify-content:space-between;padding:14px 20px;position:sticky;top:0;z-index:50;background:rgba(12,12,14,.92);backdrop-filter:blur(20px);border-bottom:1px solid rgba(255,255,255,.04)}
      .logo{font-family:'Instrument Serif';font-size:22px;color:#fff;font-style:italic}.logo span{color:#C9A96E}
      .pro{font-size:9px;font-weight:800;letter-spacing:1.5px;color:#C9A96E;background:rgba(201,169,110,.1);padding:3px 8px;border-radius:4px;cursor:pointer}
      .free-badge{font-size:9px;font-weight:700;letter-spacing:1.5px;color:rgba(255,255,255,.3);background:rgba(255,255,255,.04);padding:3px 8px;border-radius:4px;cursor:pointer}
      .scan-counter{font-size:11px;color:rgba(255,255,255,.25);text-align:center;margin-top:-8px;margin-bottom:8px}
      .scan-counter strong{color:#C9A96E}
      .tb{position:fixed;bottom:0;left:50%;transform:translateX(-50%);width:100%;max-width:430px;display:flex;background:rgba(12,12,14,.95);backdrop-filter:blur(24px);border-top:1px solid rgba(255,255,255,.04);padding:8px 0;padding-bottom:max(8px,env(safe-area-inset-bottom));z-index:100}
      .tab{flex:1;display:flex;flex-direction:column;align-items:center;gap:3px;padding:6px 0;cursor:pointer;background:none;border:none;color:rgba(255,255,255,.2);transition:color .2s;font-family:'Outfit'}.tab.on{color:#C9A96E}
      .tab svg{width:21px;height:21px;stroke:currentColor;fill:none;stroke-width:1.8}.tab-l{font-size:9px;font-weight:600;letter-spacing:.5px}

      .shome{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:40px 28px;gap:28px;text-align:center}
      .scan-ring{width:150px;height:150px;border-radius:50%;border:1.5px dashed rgba(201,169,110,.2);display:flex;align-items:center;justify-content:center;cursor:pointer;transition:all .3s}
      .scan-ring:hover{border-color:rgba(201,169,110,.4);transform:scale(1.03)}
      .scan-inner{width:110px;height:110px;border-radius:50%;background:rgba(201,169,110,.04);display:flex;align-items:center;justify-content:center;font-size:36px}
      .btns{display:flex;gap:10px;width:100%}
      .btn{flex:1;padding:15px;border-radius:12px;border:none;font-family:'Outfit';font-size:13px;font-weight:700;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:7px;transition:all .2s}
      .btn.gold{background:#C9A96E;color:#0C0C0E}.btn.gold:hover{background:#D4B87A}
      .btn.ghost{background:rgba(255,255,255,.04);color:rgba(255,255,255,.6);border:1px solid rgba(255,255,255,.06)}
      .btn svg{width:16px;height:16px;stroke:currentColor;fill:none;stroke-width:2}

      .cam{position:fixed;inset:0;z-index:200;background:#000;display:flex;flex-direction:column}
      .cam video{flex:1;object-fit:cover}
      .cam-corners{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);width:260px;height:340px;pointer-events:none}
      .cc{position:absolute;width:28px;height:28px;border-color:#C9A96E;border-style:solid}
      .cc.tl{top:0;left:0;border-width:2px 0 0 2px;border-radius:6px 0 0 0}.cc.tr{top:0;right:0;border-width:2px 2px 0 0;border-radius:0 6px 0 0}
      .cc.bl{bottom:0;left:0;border-width:0 0 2px 2px;border-radius:0 0 0 6px}.cc.br{bottom:0;right:0;border-width:0 2px 2px 0;border-radius:0 0 6px 0}
      .cam-bar{padding:24px;display:flex;align-items:center;justify-content:center;gap:36px;background:rgba(0,0,0,.85);backdrop-filter:blur(16px);padding-bottom:max(24px,env(safe-area-inset-bottom))}
      .cam-x{background:none;border:none;color:#fff;font-family:'Outfit';font-size:15px;cursor:pointer}
      .shutter{width:64px;height:64px;border-radius:50%;background:#C9A96E;border:4px solid rgba(201,169,110,.25);cursor:pointer;transition:transform .15s}.shutter:active{transform:scale(.88)}

      .ld-wrap{flex:1;display:flex;flex-direction:column}
      .ld-img-wrap{position:relative;width:100%;aspect-ratio:3/4;max-height:55vh;overflow:hidden}
      .ld-img{width:100%;height:100%;object-fit:cover;filter:brightness(.45) saturate(.6)}
      .ld-scanline{position:absolute;left:0;right:0;height:2px;background:linear-gradient(90deg,transparent,#C9A96E,transparent);animation:scan 3s ease-in-out infinite;box-shadow:0 0 24px rgba(201,169,110,.3)}
      .ld-info{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;padding:32px}
      .ld-dots{display:flex;gap:5px}.ld-dot{width:4px;height:4px;border-radius:50%;background:#C9A96E;animation:pulse 1.2s ease-in-out infinite}.ld-dot:nth-child(2){animation-delay:.15s}.ld-dot:nth-child(3){animation-delay:.3s}

      .res{flex:1;display:flex;flex-direction:column}
      .res-img-sec{position:relative;width:100%}
      .res-img{width:100%;aspect-ratio:3/4;max-height:48vh;object-fit:cover;display:block}
      .res-grad{position:absolute;bottom:0;left:0;right:0;height:120px;background:linear-gradient(transparent,#0C0C0E)}
      .res-new{position:absolute;top:14px;right:14px;background:rgba(0,0,0,.45);backdrop-filter:blur(12px);border:1px solid rgba(255,255,255,.08);border-radius:100px;color:#fff;font-family:'Outfit';font-size:11px;font-weight:600;padding:7px 14px;cursor:pointer}
      .hs{position:absolute;transform:translate(-50%,-50%);cursor:pointer;transition:all .2s;z-index:10}
      .hs-ring{width:32px;height:32px;border-radius:50%;border:2px solid #C9A96E;display:flex;align-items:center;justify-content:center;background:rgba(12,12,14,.5);backdrop-filter:blur(4px);transition:all .2s}
      .hs.on .hs-ring{background:#C9A96E;transform:scale(1.15);box-shadow:0 0 0 4px rgba(201,169,110,.2)}
      .hs-num{font-size:11px;font-weight:700;color:#C9A96E;transition:color .2s}.hs.on .hs-num{color:#0C0C0E}
      .hs-tag{position:absolute;top:100%;left:50%;transform:translateX(-50%);margin-top:4px;font-size:8px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:#C9A96E;background:rgba(12,12,14,.7);backdrop-filter:blur(8px);padding:2px 6px;border-radius:3px;white-space:nowrap}

      .v-banner{padding:12px 20px;display:flex;align-items:center;gap:10px;border-bottom:1px solid rgba(255,255,255,.03)}
      .v-steps{display:flex;gap:6px;flex:1}
      .v-step{flex:1;display:flex;flex-direction:column;gap:3px;align-items:center}
      .v-step-bar{width:100%;height:2px;border-radius:1px;background:rgba(255,255,255,.06);overflow:hidden}
      .v-step-fill{height:100%;border-radius:1px;transition:width .5s ease}
      .v-step-l{font-size:8px;font-weight:700;letter-spacing:1px;text-transform:uppercase}

      .det{padding:20px;animation:slideIn .35s ease}
      .det-top{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}
      .det-name{font-family:'Instrument Serif';font-size:24px;color:#fff;line-height:1.15;flex:1}
      .det-save{width:38px;height:38px;border-radius:50%;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.06);display:flex;align-items:center;justify-content:center;cursor:pointer;flex-shrink:0;font-size:16px;transition:all .2s}.det-save.on{background:rgba(201,169,110,.1);border-color:rgba(201,169,110,.3);color:#C9A96E}
      .det-tags{display:flex;gap:5px;flex-wrap:wrap;margin:12px 0}
      .det-tag{font-size:9px;font-weight:600;letter-spacing:.5px;text-transform:uppercase;color:rgba(255,255,255,.25);background:rgba(255,255,255,.03);padding:4px 8px;border-radius:5px}
      .det-conf{display:flex;align-items:center;gap:14px;padding:14px;background:rgba(255,255,255,.02);border:1px solid rgba(255,255,255,.04);border-radius:14px;margin-bottom:18px}
      .sec-t{font-size:9px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:rgba(255,255,255,.15);margin-bottom:10px;display:flex;align-items:center;justify-content:space-between}
      .tiers-scroll{display:flex;flex-direction:column;gap:10px;padding:0 0 12px}
      .tier-empty{padding:16px;border:1px dashed rgba(255,255,255,.06);border-radius:12px;text-align:center;font-size:12px;color:rgba(255,255,255,.2);line-height:1.5}
      .aff-note{font-size:9px;color:rgba(255,255,255,.1);text-align:center;margin-top:12px;padding-bottom:16px}

      .empty{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:40px 32px;gap:10px}
      .empty-i{font-size:36px;opacity:.2;margin-bottom:6px}.empty-t{font-size:16px;font-weight:600}.empty-s{font-size:12px;color:rgba(255,255,255,.25)}
      .hist-list{padding:16px 20px;display:flex;flex-direction:column;gap:10px}
      .hist-card{display:flex;gap:12px;padding:12px;background:rgba(255,255,255,.02);border:1px solid rgba(255,255,255,.04);border-radius:12px}
      .hist-thumb{width:52px;height:68px;border-radius:8px;object-fit:cover;flex-shrink:0}
      .saved-list{padding:16px 20px;display:flex;flex-direction:column;gap:7px}
      .saved-row{display:flex;align-items:center;gap:12px;padding:12px;background:rgba(255,255,255,.02);border:1px solid rgba(255,255,255,.04);border-radius:12px}
      .err{margin:20px;padding:20px;background:rgba(255,80,80,.05);border:1px solid rgba(255,80,80,.1);border-radius:12px;color:rgba(255,130,130,.8);font-size:13px;text-align:center;line-height:1.5}
      .hid{display:none}canvas.hid{display:none}
      .pcard{background:rgba(255,255,255,.02);border:1px solid rgba(255,255,255,.04);border-radius:14px;padding:20px}
      .rcard{background:rgba(201,169,110,.03);border:1px solid rgba(201,169,110,.08);border-radius:14px;padding:20px}
      .sitem{display:flex;align-items:center;justify-content:space-between;padding:13px 16px;background:rgba(255,255,255,.02);border:1px solid rgba(255,255,255,.04);border-radius:10px;font-size:13px;font-weight:500;color:rgba(255,255,255,.5);cursor:pointer}
      .ad-slot{display:flex;align-items:center;justify-content:center;background:rgba(255,255,255,.015);border:1px dashed rgba(255,255,255,.04);border-radius:10px;color:rgba(255,255,255,.08);font-size:9px;font-weight:700;letter-spacing:2px}
      .ad-banner{height:48px;margin:0 20px 8px}
      .ad-native{height:72px;margin:8px 0}

      .modal-overlay{position:fixed;inset:0;z-index:300;background:rgba(0,0,0,.75);backdrop-filter:blur(8px);display:flex;align-items:center;justify-content:center;padding:24px}
      .modal-box{width:100%;max-width:380px;background:#111114;border:1px solid rgba(255,255,255,.06);border-radius:24px;padding:28px 24px;position:relative;animation:slideIn .3s ease}
      .modal-x{position:absolute;top:16px;right:16px;background:none;border:none;color:rgba(255,255,255,.25);font-size:18px;cursor:pointer;font-family:'Outfit'}
      .modal-title{font-family:'Instrument Serif';font-size:24px;color:#fff;line-height:1.15;margin-bottom:8px}
      .modal-sub{font-size:13px;color:rgba(255,255,255,.35);line-height:1.6;margin-bottom:24px}
      .modal-later{background:none;border:none;color:rgba(255,255,255,.2);font-family:'Outfit';font-size:12px;cursor:pointer;width:100%;text-align:center;padding:10px;margin-top:6px}
    `}</style>

    <div className="app">
      {/* ─── ONBOARDING ──────────────────────────────────── */}
      {screen === "onboarding" && (
        <div className={`ob ${fade}`}>
          <div className="ob-bar"><div className="ob-fill" style={{ width: `${prog}%` }} /></div>
          <div className="ob-body">
            {step.icon && <div className="ob-icon">{step.icon}</div>}
            <h1 className="ob-title">{step.title}</h1>
            <p className="ob-sub">{step.sub}</p>
            {step.stats && <div className="ob-stats">{step.stats.map((s,i) => <div key={i}><div className="ob-sn">{s.n}</div><div className="ob-sl">{s.l}</div></div>)}</div>}
            {step.type === "select" && <div className="ob-opts">{step.opts.map((o,i) => <div key={i} className="ob-opt" onClick={() => obNext(o.v)}>{o.l}</div>)}</div>}
            {step.type === "budget_range" && (
              <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
                <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: 1.5, color: "rgba(255,255,255,.3)", textTransform: "uppercase", marginBottom: 6 }}>Min per item</div>
                    <div style={{ display: "flex", alignItems: "center", background: "rgba(255,255,255,.03)", border: "1px solid rgba(255,255,255,.08)", borderRadius: 12, padding: "14px 16px" }}>
                      <span style={{ color: "rgba(255,255,255,.3)", fontSize: 18, fontWeight: 600, marginRight: 4 }}>$</span>
                      <input type="number" value={budgetMin} onChange={e => setBudgetMin(Math.max(0, parseInt(e.target.value) || 0))} style={{ background: "none", border: "none", color: "#fff", fontFamily: "'Outfit'", fontSize: 18, fontWeight: 600, width: "100%", outline: "none" }} />
                    </div>
                  </div>
                  <span style={{ color: "rgba(255,255,255,.15)", fontSize: 16, marginTop: 22 }}>—</span>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: 1.5, color: "rgba(255,255,255,.3)", textTransform: "uppercase", marginBottom: 6 }}>Max per item</div>
                    <div style={{ display: "flex", alignItems: "center", background: "rgba(255,255,255,.03)", border: "1px solid rgba(255,255,255,.08)", borderRadius: 12, padding: "14px 16px" }}>
                      <span style={{ color: "rgba(255,255,255,.3)", fontSize: 18, fontWeight: 600, marginRight: 4 }}>$</span>
                      <input type="number" value={budgetMax} onChange={e => setBudgetMax(Math.max(budgetMin + 1, parseInt(e.target.value) || 0))} style={{ background: "none", border: "none", color: "#fff", fontFamily: "'Outfit'", fontSize: 18, fontWeight: 600, width: "100%", outline: "none" }} />
                    </div>
                  </div>
                </div>
                <div style={{ fontSize: 12, color: "rgba(255,255,255,.25)", textAlign: "center", lineHeight: 1.5 }}>
                  Budget tier: under ${budgetMin} · Mid tier: ${budgetMin}–${budgetMax} · Premium: ${budgetMax}+
                </div>
                <button className="cta" onClick={() => obNext()}>Continue</button>
              </div>
            )}
            {step.type === "info" && <button className="cta" onClick={() => obNext()}>{step.cta}</button>}
            {obIdx === 0 && <button style={{background:"none",border:"none",color:"rgba(255,255,255,.25)",fontSize:13,cursor:"pointer",fontFamily:"'Outfit'",padding:"12px 0",marginTop:8}} onClick={() => { setScreen("auth"); setAuthScreen("login"); }}>Already have an account? Log in</button>}
          </div>
        </div>
      )}

      {/* ─── PAYWALL ─────────────────────────────────────── */}
      {screen === "paywall" && (
        <div className={`pw ${fade}`}>
          <button className="pw-skip" onClick={() => trans(() => setScreen("auth"))}>Skip — start free</button>
          <div className="pw-badge">✦ LIMITED OFFER</div>
          <h1 className="pw-t">Unlock unlimited<br />outfit scans</h1>
          <p className="pw-st">Unlimited scans, zero ads, and priority results. Three price options for every item.</p>
          <div className="pw-fs">
            {["Unlimited AI outfit scans","Completely ad-free experience","Web-verified product links","Price drop alerts on saved items","Full scan history forever"].map((f,i) => <div className="pw-f" key={i}><div className="pw-ck">✓</div>{f}</div>)}
          </div>
          <div className="pw-plans">
            <div className={`pw-p ${selPlan==="yearly"?"sel":""}`} onClick={() => setSelPlan("yearly")}><div className="pw-ptag">BEST VALUE</div><div className="pw-pp">$39.99<span className="pw-pd"> /year</span></div><div className="pw-pw">$0.77/week</div></div>
            <div className={`pw-p ${selPlan==="monthly"?"sel":""}`} onClick={() => setSelPlan("monthly")}><div className="pw-pp">$9.99<span className="pw-pd"> /mo</span></div><div className="pw-pw">$2.50/week</div></div>
          </div>
          <button className="cta" onClick={() => trans(() => setScreen("auth"))}>Continue with free account</button>
          <div className="pw-terms">3 free scans per day. Upgrade anytime.</div>
        </div>
      )}

      {/* ─── AUTH (Login / Signup) ────────────────────────── */}
      {screen === "auth" && (
        <div className={`auth ${fade}`}>
          <div style={{ textAlign: "center", marginBottom: 28 }}>
            <div className="ob-icon" style={{ fontSize: 28 }}>✦</div>
            <h1 className="ob-title" style={{ fontSize: 26 }}>{authScreen === "signup" ? "Create your account" : "Welcome back"}</h1>
            <p className="ob-sub" style={{ marginBottom: 0 }}>{authScreen === "signup" ? "Sign up to start scanning outfits" : "Log in to continue"}</p>
          </div>

          {/* OAuth buttons */}
          <button onClick={() => API.oauthLogin("google")} style={{ width: "100%", padding: "14px 18px", background: "rgba(255,255,255,.04)", border: "1px solid rgba(255,255,255,.08)", borderRadius: 12, color: "#fff", fontFamily: "'Outfit'", fontSize: 14, fontWeight: 600, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 10, marginBottom: 8, transition: "all .2s" }}>
            <svg width="18" height="18" viewBox="0 0 24 24"><path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 01-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4"/><path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/><path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/><path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/></svg>
            Continue with Google
          </button>
          <button onClick={() => API.oauthLogin("apple")} style={{ width: "100%", padding: "14px 18px", background: "rgba(255,255,255,.04)", border: "1px solid rgba(255,255,255,.08)", borderRadius: 12, color: "#fff", fontFamily: "'Outfit'", fontSize: 14, fontWeight: 600, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 10, marginBottom: 16, transition: "all .2s" }}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="#fff"><path d="M17.05 20.28c-.98.95-2.05.88-3.08.4-1.09-.5-2.08-.48-3.24 0-1.44.62-2.2.44-3.06-.4C2.79 15.25 3.51 7.59 9.05 7.31c1.35.07 2.29.74 3.08.8 1.18-.24 2.31-.93 3.57-.84 1.51.12 2.65.72 3.4 1.8-3.12 1.87-2.38 5.98.48 7.13-.57 1.5-1.31 2.99-2.54 4.09zM12.03 7.25c-.15-2.23 1.66-4.07 3.74-4.25.29 2.58-2.34 4.5-3.74 4.25z"/></svg>
            Continue with Apple
          </button>

          {/* Divider */}
          <div style={{ display: "flex", alignItems: "center", gap: 12, margin: "4px 0 16px" }}>
            <div style={{ flex: 1, height: 1, background: "rgba(255,255,255,.06)" }} />
            <span style={{ fontSize: 11, color: "rgba(255,255,255,.2)", fontWeight: 500 }}>or</span>
            <div style={{ flex: 1, height: 1, background: "rgba(255,255,255,.06)" }} />
          </div>

          {authErr && <div className="auth-err">{authErr}</div>}

          {/* Name + phone (signup only) */}
          {authScreen === "signup" && (<>
            <input type="text" placeholder="Full name" value={authName} onChange={e => setAuthName(e.target.value)} autoComplete="name" />
            <input type="tel" placeholder="Phone number" value={authPhone} onChange={e => setAuthPhone(e.target.value)} autoComplete="tel" />
          </>)}

          <input type="email" placeholder="Email address" value={authEmail} onChange={e => setAuthEmail(e.target.value)} autoComplete="email" />
          <div style={{ position: "relative" }}>
            <input type={showPass ? "text" : "password"} placeholder="Password" value={authPass} onChange={e => setAuthPass(e.target.value)} onKeyDown={e => e.key === "Enter" && authEmail && authPass.length >= 6 && (authScreen === "login" || authPhone) && handleAuth()} autoComplete={authScreen === "signup" ? "new-password" : "current-password"} style={{ paddingRight: 48 }} />
            <button onClick={() => setShowPass(p => !p)} style={{ position: "absolute", right: 12, top: "50%", transform: "translateY(-50%)", background: "none", border: "none", color: "rgba(255,255,255,.2)", fontSize: 12, cursor: "pointer", fontFamily: "'Outfit'", padding: "4px" }}>{showPass ? "Hide" : "Show"}</button>
          </div>
          {authScreen === "signup" && authPass.length > 0 && authPass.length < 6 && (
            <div style={{ fontSize: 11, color: "rgba(255,150,100,.5)", marginTop: -4, marginBottom: 4 }}>Password must be at least 6 characters</div>
          )}
          <button className="cta" style={{ marginTop: 8, opacity: (!authEmail || authPass.length < 6 || (authScreen === "signup" && !authPhone)) ? 0.4 : 1 }} onClick={handleAuth} disabled={authLoading || !authEmail || authPass.length < 6 || (authScreen === "signup" && !authPhone)}>
            {authLoading ? "Loading…" : authScreen === "signup" ? "Create Account" : "Log In"}
          </button>
          <button className="auth-toggle" onClick={() => { setAuthScreen(authScreen === "login" ? "signup" : "login"); setAuthErr(null); setShowPass(false); }}>
            {authScreen === "login" ? "Don't have an account? Sign up" : "Already have an account? Log in"}
          </button>
        </div>
      )}

      {/* ─── CAMERA ──────────────────────────────────────── */}
      {camOn && (
        <div className="cam">
          <video ref={vidRef} autoPlay playsInline muted />
          <div className="cam-corners"><div className="cc tl" /><div className="cc tr" /><div className="cc bl" /><div className="cc br" /></div>
          <canvas ref={canRef} className="hid" />
          <div className="cam-bar">
            <button className="cam-x" onClick={camStop}>Cancel</button>
            <button className="shutter" onClick={camCapture} style={{opacity:camReady?1:.3}} disabled={!camReady} />
            <div style={{width:44}} />
          </div>
        </div>
      )}

      {/* ─── INTERSTITIAL AD (free users, post-scan) ─────── */}
      {showInterstitial && showAds && (
        <InterstitialAd onClose={() => setShowInterstitial(false)} />
      )}

      {/* ─── UPGRADE MODAL ───────────────────────────────── */}
      {upgradeModal && (
        <UpgradeModal
          trigger={upgradeModal}
          onClose={() => setUpgradeModal(null)}
          onUpgrade={() => { setUpgradeModal(null); /* TODO: RevenueCat in Phase 3 */ }}
        />
      )}

      {/* ─── MAIN APP ────────────────────────────────────── */}
      {screen === "app" && (<>
        <div className="hdr">
          <div className="logo"><span>ATT</span>AIR</div>
          {isPro
            ? <div className="pro">PRO</div>
            : <div className="free-badge" onClick={() => setUpgradeModal("general")}>FREE · {scansLeft}/{scansLimit}</div>
          }
        </div>
        <div className="as">
          <input ref={fileRef} type="file" accept="image/*,.heic,.heif" className="hid" onChange={(e) => handleFile(e.target.files[0])} />

          {/* ─── Scan Home ─────────────────────────────── */}
          {tab === "scan" && phase === "idle" && !img && (
            <div className="shome">
              <div className="scan-ring" onClick={camStart}><div className="scan-inner">◎</div></div>
              <h2 className="serif" style={{fontSize:28,color:"#fff"}}>Scan an outfit</h2>
              <p style={{fontSize:13,color:"rgba(255,255,255,.3)",marginTop:-14,lineHeight:1.5}}>Get a budget, mid-range, and premium option for every item</p>
              {isFree && (
                <div className="scan-counter">{scansLeft > 0 ? <><strong>{scansLeft}</strong> of {scansLimit} free scans remaining today</> : <>No scans left today · <span style={{color:"#C9A96E",cursor:"pointer"}} onClick={() => setUpgradeModal("scan_limit")}>Go Pro</span></>}</div>
              )}
              <div className="btns">
                <button className="btn gold" onClick={camStart}><svg viewBox="0 0 24 24"><rect x="2" y="6" width="20" height="14" rx="3" /><circle cx="12" cy="13" r="4" /><path d="M8 6l1.5-3h5L16 6" /></svg>Camera</button>
                <button className="btn ghost" onClick={() => fileRef.current?.click()}><svg viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="3" /><circle cx="8.5" cy="8.5" r="1.5" /><path d="M21 15l-5-5L5 21" /></svg>Upload</button>
              </div>
            </div>
          )}

          {/* ─── Loading ───────────────────────────────── */}
          {tab === "scan" && phase === "identifying" && img && (
            <div className="ld-wrap">
              <div className="ld-img-wrap"><img src={img} className="ld-img" alt="" /><div className="ld-scanline" /></div>
              <div className="ld-info">
                <div style={{fontSize:10,fontWeight:700,letterSpacing:2.5,color:"rgba(201,169,110,.5)",textTransform:"uppercase"}}>Identifying outfit</div>
                <div className="serif" style={{fontSize:20,color:"#fff"}}>Analyzing the look…</div>
                <div className="ld-dots"><div className="ld-dot" /><div className="ld-dot" /><div className="ld-dot" /></div>
              </div>
            </div>
          )}

          {/* ─── Error ─────────────────────────────────── */}
          {tab === "scan" && error && phase === "idle" && (
            <div>
              {img && <img src={img} style={{width:"100%",maxHeight:"25vh",objectFit:"cover",display:"block",filter:"brightness(0.25)"}} alt="" />}
              <div className="err">{error}</div>
              <div style={{padding:"0 20px",marginTop:12}}><button className="btn ghost" style={{width:"100%"}} onClick={reset}>Try again</button></div>
            </div>
          )}

          {/* ─── Results ───────────────────────────────── */}
          {tab === "scan" && results && phase !== "idle" && phase !== "identifying" && (
            <div className="res">
              {/* Verification progress */}
              <div className="v-banner">
                <div className="v-steps">
                  <div className="v-step">
                    <div className="v-step-bar"><div className="v-step-fill" style={{ width: "100%", background: "#C9A96E" }} /></div>
                    <div className="v-step-l" style={{ color: "#C9A96E" }}>✓ Identified</div>
                  </div>
                  <div className="v-step">
                    <div className="v-step-bar"><div className="v-step-fill" style={{ width: phase === "searching" ? "40%" : "100%", background: phase === "done" ? (results.items.some(i => i.status === "verified") ? "#C9A96E" : "rgba(255,255,255,.15)") : "rgba(201,169,110,.4)", transition: phase === "searching" ? "width 12s linear" : "width .5s ease" }} /></div>
                    <div className="v-step-l" style={{ color: phase === "searching" ? "rgba(201,169,110,.5)" : results.items.some(i => i.status === "verified") ? "#C9A96E" : "rgba(255,255,255,.2)" }}>
                      {phase === "searching" ? "Finding products…" : results.items.some(i => i.status === "verified") ? "✓ Products found" : "Search complete"}
                    </div>
                  </div>
                </div>
              </div>

              {/* Image with hotspots */}
              <div className="res-img-sec">
                <img src={img} className="res-img" alt="" /><div className="res-grad" />
                <button className="res-new" onClick={reset}>New scan</button>
                {results.items.map((item, i) => {
                  const py = item.position_y != null ? Math.max(0.08, Math.min(0.85, item.position_y)) : (CAT_POSITIONS[item.category] || 0.5);
                  const px = 0.5 + (i % 2 === 0 ? -0.22 : 0.22);
                  return (
                    <div key={i} className={`hs ${selIdx === i ? "on" : ""}`} style={{ top: `${py*100}%`, left: `${Math.max(0.12, Math.min(0.88, px))*100}%` }} onClick={() => setSelIdx(i)}>
                      <div className="hs-ring"><span className="hs-num">{i+1}</span></div>
                      {selIdx === i && <div className="hs-tag">{item.subcategory || item.category}</div>}
                    </div>
                  );
                })}
              </div>

              {/* Summary */}
              <div style={{ padding: "14px 20px" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                  <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: 2, color: "rgba(255,255,255,.35)", textTransform: "uppercase" }}>{results.items.length} items</span>
                  <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: 1, padding: "3px 8px", borderRadius: 4, textTransform: "uppercase", background: results.gender === "female" ? "rgba(201,110,169,.1)" : "rgba(110,169,201,.1)", color: results.gender === "female" ? "#C96EAE" : "#6EAEC9" }}>
                    {results.gender === "female" ? "Women's" : "Men's"}
                  </span>
                </div>
                {results.summary && <div style={{ fontSize: 13, color: "rgba(255,255,255,.5)", fontStyle: "italic", lineHeight: 1.5 }}>{results.summary}</div>}
              </div>

              {/* ─── Banner ad slot (free users) ──────── */}
              {showAds && <div className="ad-slot ad-banner">BANNER AD</div>}

              {/* Selected item detail */}
              {selIdx !== null && results.items[selIdx] && (() => {
                const item = results.items[selIdx];
                const bc = brandConfLabel(item.brand_confidence);
                return (
                  <div className="det" key={selIdx}>
                    <div className="det-top">
                      <h2 className="det-name">{item.name}</h2>
                      <button className={`det-save ${isSaved(item)?"on":""}`} onClick={() => toggleSave(item)}>{isSaved(item)?"♥":"♡"}</button>
                    </div>

                    {item.brand && item.brand !== "Unidentified" && (
                      <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8, flexWrap: "wrap" }}>
                        <span style={{ fontSize: 15, fontWeight: 700, color: "#fff" }}>{item.brand}</span>
                        {item.product_line && <span style={{ fontSize: 12, color: "rgba(255,255,255,.3)" }}>· {item.product_line}</span>}
                        <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: 1, padding: "3px 8px", borderRadius: 4, textTransform: "uppercase", background: `${bc.c}15`, color: bc.c, border: `1px solid ${bc.c}30` }}>{bc.t}</span>
                      </div>
                    )}
                    {item.brand_evidence && <div style={{ fontSize: 11, color: "rgba(255,255,255,.25)", marginTop: 6, fontStyle: "italic" }}>Evidence: {item.brand_evidence}</div>}

                    <div className="det-tags">
                      <span className="det-tag">{item.color}</span>
                      <span className="det-tag">{item.material}</span>
                      {item.fit && <span className="det-tag">{item.fit}</span>}
                      {item.subcategory && <span className="det-tag">{item.subcategory}</span>}
                    </div>

                    <div className="det-conf">
                      <ConfidenceRing value={item.identification_confidence || 50} size={50} stroke={3} label="ID" />
                      <div style={{ flex: 1 }}>
                        <div style={{ fontSize: 14, fontWeight: 600 }}>Identification confidence</div>
                        <div style={{ fontSize: 11, color: "rgba(255,255,255,.25)", marginTop: 2 }}>
                          {item.identification_confidence >= 80 ? "High certainty" : item.identification_confidence >= 55 ? "Moderate certainty" : "Visual estimate"}
                        </div>
                      </div>
                      <StatusPill status={item.status} />
                    </div>

                    <div style={{ fontSize: 20, fontWeight: 700, color: "#C9A96E", marginBottom: 18 }}>{item.price_range}</div>

                    {/* Three-tier product cards */}
                    <div className="sec-t">
                      <span>Shop this item</span>
                      <StatusPill status={item.status} />
                    </div>

                    {item.status === "searching" && (
                      <div className="tier-empty" style={{ background: "rgba(201,169,110,.03)", borderColor: "rgba(201,169,110,.1)", color: "rgba(201,169,110,.5)" }}>
                        Finding budget, mid-range, and premium options…<br />
                        <span style={{ fontSize: 10, color: "rgba(201,169,110,.3)" }}>This takes 10-15 seconds</span>
                      </div>
                    )}

                    {item.status === "failed" && !item.tiers && (
                      <div className="tier-empty">
                        Couldn't find products online. Try searching: "{item.search_query}"
                      </div>
                    )}

                    {item.tiers && (
                      <div className="tiers-scroll">
                        <TierCard tier="budget" data={item.tiers.budget} scanId={scanId} itemIndex={selIdx} />
                        <TierCard tier="mid" data={item.tiers.mid} scanId={scanId} itemIndex={selIdx} />
                        <TierCard tier="premium" data={item.tiers.premium} scanId={scanId} itemIndex={selIdx} />
                      </div>
                    )}

                    {/* Native ad slot — free users, every 2 items */}
                    {showAds && selIdx % 2 === 1 && <div className="ad-slot ad-native">SPONSORED</div>}

                    <div className="aff-note">Links may include affiliate partnerships</div>
                  </div>
                );
              })()}
            </div>
          )}

          {/* ─── History (merged with Saved) ─────────────── */}
          {tab === "history" && (() => {
            const filteredHistory = historyFilter === "saved" ? history.filter(h => h.is_saved) : history;
            const loadScan = (h) => {
              const items = h.items || [];
              setResults({ gender: h.detected_gender || "male", summary: h.summary || "", items: items.map(it => ({ ...it, status: h.tiers ? "verified" : "identified", tiers: null })) });
              if (h.tiers && Array.isArray(h.tiers)) {
                setResults(prev => prev ? { ...prev, items: prev.items.map((item, idx) => { const sr = h.tiers[idx]; return sr?.tiers ? { ...item, status: "verified", tiers: sr.tiers } : item; }) } : prev);
              }
              setImg(h.image_url || h.image_thumbnail || null);
              setScanId(h.id); setSelIdx(0); setPhase("done"); setTab("scan");
            };
            return filteredHistory.length === 0 && history.length === 0
              ? <div className="empty"><div className="empty-i">◎</div><div className="empty-t">No scans yet</div><div className="empty-s">Your scan history will appear here</div></div>
              : <div className="hist-list">
                  {/* Filter tabs */}
                  <div style={{ display: "flex", gap: 0, marginBottom: 12, background: "rgba(255,255,255,.03)", borderRadius: 10, padding: 3 }}>
                    {["all", "saved"].map(f => (
                      <button key={f} onClick={() => setHistoryFilter(f)} style={{ flex: 1, padding: "8px 0", borderRadius: 8, border: "none", background: historyFilter === f ? "rgba(201,169,110,.12)" : "transparent", color: historyFilter === f ? "#C9A96E" : "rgba(255,255,255,.3)", fontFamily: "'Outfit'", fontSize: 12, fontWeight: 600, cursor: "pointer", transition: "all .2s", letterSpacing: 0.5 }}>
                        {f === "all" ? "All Scans" : "♥ Saved"}
                      </button>
                    ))}
                  </div>
                  {isFree && <div style={{fontSize:9,color:"rgba(255,255,255,.12)",marginBottom:8,display:"flex",justifyContent:"space-between"}}><span>Last 7 days</span><span style={{color:"#C9A96E",cursor:"pointer"}} onClick={() => setUpgradeModal("history_expiring")}>Keep all →</span></div>}
                  {filteredHistory.length === 0
                    ? <div className="empty" style={{padding:"40px 20px"}}><div className="empty-i">♡</div><div className="empty-t">No saved scans</div><div className="empty-s">Tap the heart on any scan to save it</div></div>
                    : filteredHistory.map((h,i) => {
                      const items = h.items || [];
                      const imgSrc = h.image_url || h.image_thumbnail;
                      return (
                        <div className="hist-card" key={h.id || i}>
                          {/* Image */}
                          {imgSrc ? (
                            <img src={imgSrc} className="hist-thumb" alt="" onClick={() => loadScan(h)} style={{cursor:"pointer"}} />
                          ) : (
                            <div onClick={() => loadScan(h)} style={{width:52,height:68,borderRadius:8,background: h.detected_gender === "female" ? "rgba(201,110,169,.06)" : "rgba(110,169,201,.06)",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0,cursor:"pointer",fontSize:18}}>
                              {h.detected_gender === "female" ? "👗" : "👔"}
                            </div>
                          )}
                          {/* Info */}
                          <div style={{flex:1,minWidth:0,cursor:"pointer"}} onClick={() => loadScan(h)}>
                            <div
                              contentEditable
                              suppressContentEditableWarning
                              onClick={(e) => e.stopPropagation()}
                              onBlur={async (e) => {
                                const name = e.target.innerText.trim();
                                if (name) {
                                  await API.renameScan(h.id, name);
                                  setHistory(prev => prev.map(s => s.id === h.id ? { ...s, scan_name: name } : s));
                                }
                              }}
                              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); e.target.blur(); } }}
                              style={{fontSize:13,fontWeight:600,marginBottom:3,lineHeight:1.3,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",outline:"none",borderBottom:"1px solid transparent",cursor:"text",transition:"border-color .2s"}}
                              onFocus={(e) => { e.target.style.borderBottomColor = "rgba(201,169,110,.3)"; }}
                              onBlurCapture={(e) => { e.target.style.borderBottomColor = "transparent"; }}
                            >{h.scan_name || items.map(it=>it.name).slice(0,2).join(", ") || h.summary || "Outfit scan"}</div>
                            <div style={{display:"flex",alignItems:"center",gap:6}}>
                              <span style={{fontSize:11,color:"rgba(255,255,255,.2)"}}>{new Date(h.created_at).toLocaleDateString()}</span>
                              <span style={{fontSize:9,fontWeight:700,padding:"1px 5px",borderRadius:3,background:"rgba(255,255,255,.04)",color:"rgba(255,255,255,.2)"}}>{items.length} items</span>
                            </div>
                          </div>
                          {/* Save heart */}
                          <button onClick={async (e) => {
                            e.stopPropagation();
                            try {
                              const result = await API.toggleScanSave(h.id);
                              if (result) setHistory(prev => prev.map(s => s.id === h.id ? { ...s, is_saved: result.saved } : s));
                            } catch (err) {
                              if (err.message.includes("limit")) setUpgradeModal("save_limit");
                            }
                          }} style={{background:"none",border:"none",fontSize:18,cursor:"pointer",padding:"4px 4px",flexShrink:0,color: h.is_saved ? "#C9A96E" : "rgba(255,255,255,.12)",transition:"color .2s"}}>
                            {h.is_saved ? "♥" : "♡"}
                          </button>
                          {/* Delete */}
                          <button onClick={async (e) => {
                            e.stopPropagation();
                            if (!confirm("Delete this scan?")) return;
                            const ok = await API.deleteScan(h.id);
                            if (ok) setHistory(prev => prev.filter(s => s.id !== h.id));
                          }} style={{background:"none",border:"none",fontSize:14,cursor:"pointer",padding:"4px 4px",flexShrink:0,color:"rgba(255,255,255,.08)",transition:"color .2s"}} onMouseEnter={e => e.target.style.color="rgba(255,100,100,.5)"} onMouseLeave={e => e.target.style.color="rgba(255,255,255,.08)"}>
                            ✕
                          </button>
                        </div>
                      );
                    })
                  }
                </div>;
          })()}

          {/* ─── Profile ───────────────────────────────── */}
          {tab === "profile" && (
            <div style={{padding:20,display:"flex",flexDirection:"column",gap:14}}>
              <div className="sec-t" style={{marginTop:8}}>Account</div>
              <div className="pcard">
                <div style={{display:"flex",alignItems:"center",gap:14,marginBottom:14}}>
                  <div style={{width:52,height:52,borderRadius:"50%",background:"rgba(201,169,110,.08)",display:"flex",alignItems:"center",justifyContent:"center",fontWeight:700,color:"#C9A96E",fontSize:20,flexShrink:0,overflow:"hidden"}}>
                    {(authName || authEmail || "U")[0].toUpperCase()}
                  </div>
                  <div style={{flex:1,minWidth:0}}>
                    <div style={{fontWeight:600,fontSize:15}}>{authName || (isPro ? "Pro Member" : "Free Account")}</div>
                    <div style={{fontSize:11,color:"rgba(255,255,255,.25)"}}>{authEmail || "Not signed in"}</div>
                  </div>
                  {isPro ? <div className="pro" style={{marginLeft:"auto"}}>PRO</div> : <div className="free-badge" style={{marginLeft:"auto"}} onClick={() => setUpgradeModal("general")}>UPGRADE</div>}
                </div>
                <div style={{fontSize:12,color:"rgba(255,255,255,.3)",lineHeight:1.6}}>
                  Scans today: {isFree ? `${(scansLimit - scansLeft)}/${scansLimit}` : "Unlimited"} · Saved: {userStatus?.saved_count || saved.length}{isFree ? `/${userStatus?.saved_limit || 20}` : ""}
                </div>
              </div>

              {isFree && (<>
                <div className="sec-t">Go Pro</div>
                <div className="rcard">
                  <div style={{fontWeight:600,fontSize:14,marginBottom:5}}>Unlock the full experience</div>
                  <div style={{fontSize:12,color:"rgba(255,255,255,.3)",lineHeight:1.5,marginBottom:12}}>Unlimited scans, no ads, price alerts, full history.</div>
                  <button className="btn gold" style={{width:"100%"}} onClick={() => setUpgradeModal("general")}>Go Pro — $39.99/year</button>
                </div>
              </>)}

              <div className="sec-t">Budget per item</div>
              <div className="pcard">
                <div style={{ fontSize: 12, color: "rgba(255,255,255,.3)", marginBottom: 10 }}>Set your target spend per clothing item. We'll tailor the budget, mid, and premium tiers to match.</div>
                <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: 1, color: "rgba(255,255,255,.2)", textTransform: "uppercase", marginBottom: 4 }}>Min</div>
                    <div style={{ display: "flex", alignItems: "center", background: "rgba(255,255,255,.03)", border: "1px solid rgba(255,255,255,.06)", borderRadius: 8, padding: "8px 10px" }}>
                      <span style={{ color: "rgba(255,255,255,.25)", marginRight: 2 }}>$</span>
                      <input type="number" value={budgetMin} onChange={e => setBudgetMin(Math.max(0, parseInt(e.target.value) || 0))} onBlur={() => API.updateProfile({ budget_min: budgetMin })} style={{ background: "none", border: "none", color: "#fff", fontFamily: "'Outfit'", fontSize: 15, fontWeight: 600, width: "100%", outline: "none" }} />
                    </div>
                  </div>
                  <span style={{ color: "rgba(255,255,255,.1)", marginTop: 18 }}>—</span>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: 1, color: "rgba(255,255,255,.2)", textTransform: "uppercase", marginBottom: 4 }}>Max</div>
                    <div style={{ display: "flex", alignItems: "center", background: "rgba(255,255,255,.03)", border: "1px solid rgba(255,255,255,.06)", borderRadius: 8, padding: "8px 10px" }}>
                      <span style={{ color: "rgba(255,255,255,.25)", marginRight: 2 }}>$</span>
                      <input type="number" value={budgetMax} onChange={e => setBudgetMax(Math.max(budgetMin + 1, parseInt(e.target.value) || 0))} onBlur={() => API.updateProfile({ budget_max: budgetMax })} style={{ background: "none", border: "none", color: "#fff", fontFamily: "'Outfit'", fontSize: 15, fontWeight: 600, width: "100%", outline: "none" }} />
                    </div>
                  </div>
                </div>
                <div style={{ fontSize: 10, color: "rgba(255,255,255,.15)", marginTop: 8 }}>Budget: under ${budgetMin} · Mid: ${budgetMin}–${budgetMax} · Premium: ${budgetMax}+</div>
              </div>

              <div className="sec-t">Refer & earn</div>
              <div className="rcard">
                <div style={{fontWeight:600,fontSize:14,marginBottom:5}}>Get $5 for every friend</div>
                <div style={{fontSize:12,color:"rgba(255,255,255,.3)",lineHeight:1.5,marginBottom:12}}>Share your link. Both get $5 credit.</div>
                <button className="btn gold" style={{width:"100%"}}>Share invite link</button>
              </div>
              <div className="sec-t">Settings</div>
              <div className="sitem" onClick={handleLogout} style={{color:"rgba(255,100,100,.5)",justifyContent:"center"}}>Log out</div>
            </div>
          )}
        </div>

        {/* ─── Tab bar (3 tabs) ────────────────────────── */}
        <div className="tb">
          <button className={`tab ${tab==="scan"?"on":""}`} onClick={() => setTab("scan")}><svg viewBox="0 0 24 24"><rect x="2" y="6" width="20" height="14" rx="3" /><circle cx="12" cy="13" r="4" /><path d="M8 6l1.5-3h5L16 6" /></svg><span className="tab-l">Scan</span></button>
          <button className={`tab ${tab==="history"?"on":""}`} onClick={() => setTab("history")}><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 3" strokeLinecap="round" /></svg><span className="tab-l">History</span></button>
          <button className={`tab ${tab==="profile"?"on":""}`} onClick={() => setTab("profile")}><svg viewBox="0 0 24 24"><circle cx="12" cy="8" r="4" /><path d="M20 21c0-3.87-3.58-7-8-7s-8 3.13-8 7" /></svg><span className="tab-l">Profile</span></button>
        </div>
      </>)}
    </div>
  </>);
}
