import { useState, useRef, useCallback, useEffect } from "react";
import ReactCrop from "react-image-crop";
import "react-image-crop/dist/ReactCrop.css";
import "./App.css";

// ═══════════════════════════════════════════════════════════════
// CONFIG — Set VITE_API_BASE in Vercel env vars for production
// ═══════════════════════════════════════════════════════════════
const API_BASE = import.meta.env.VITE_API_BASE || "http://localhost:3000";

// Supabase public config for OAuth (safe to expose — anon key is public by design in Supabase's model)
// SECURITY: The anon key is intentionally public and provides no privilege beyond what RLS policies allow.
// Keys are read from Vite env vars so that rotating them requires only an env-var change, not a code
// change + redeploy, and so the live project ref does not appear in version control.
// Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY in your Vercel / local .env file.
// The service role key must NEVER appear here or in any frontend file.
const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL || "https://cmlgqztjkrfipzknwnfm.supabase.co";
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY || "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNtbGdxenRqa3JmaXB6a253bmZtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM4NzkzMzQsImV4cCI6MjA4OTQ1NTMzNH0.zQItty8IrgKmwTnpPAAtupzujYwHoLYO2KklNSr8pUg";

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
 */
function decodeJwt(token) {
  try {
    return JSON.parse(atob(token.split('.')[1]));
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

  async identifyClothing(base64, mimeType, userPrefs, priorityRegionBase64 = null) {
    const res = await authFetch(`${API_BASE}/api/identify`, {
      method: "POST",
      body: JSON.stringify({ image: base64, mime_type: mimeType, user_prefs: userPrefs, ...(priorityRegionBase64 && { priority_region_base64: priorityRegionBase64 }) }),
    });
    if (res.status === 429) {
      const data = await res.json();
      throw new Error(data.message || "Daily scan limit reached");
    }
    if (!res.ok) {
      let data = {};
      try { data = await res.json(); } catch { data = { message: `HTTP ${res.status} (non-JSON body)` }; }
      console.error("[ATTAIR] /api/identify response:", res.status, data);
      throw new Error(data.message || data.error || `API error ${res.status}`);
    }
    return await res.json();
  },

  async findProducts(items, gender, scanId, occasion = null, searchNotes = null) {
    const res = await authFetch(`${API_BASE}/api/find-products`, {
      method: "POST",
      body: JSON.stringify({ items, gender, scan_id: scanId, occasion, ...(searchNotes ? { search_notes: searchNotes } : {}) }),
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

  async seenOn(brand, name, interests) {
    const params = new URLSearchParams();
    if (brand) params.set("brand", brand);
    if (name) params.set("name", name);
    if (interests && interests.length > 0) params.set("interests", interests.join(","));
    const res = await authFetch(`${API_BASE}/api/seen-on?${params}`);
    if (!res.ok) return { appearances: [] };
    return await res.json();
  },

  async nearbyStores(brand, category, lat, lng) {
    const params = new URLSearchParams({ lat, lng });
    if (brand && brand !== "Unidentified") params.set("brand", brand);
    if (category) params.set("category", category);
    const res = await authFetch(`${API_BASE}/api/nearby-stores?${params}`);
    if (!res.ok) return { stores: [] };
    return await res.json();
  },

  async suggestPairings(scanId, items, gender) {
    const res = await authFetch(`${API_BASE}/api/suggest-pairings`, {
      method: "POST",
      body: JSON.stringify({ scan_id: scanId, items, gender }),
    });
    if (!res.ok) return null;
    return await res.json();
  },

  async getWishlists() {
    const res = await authFetch(`${API_BASE}/api/wishlists`);
    if (!res.ok) return { wishlists: [] };
    return await res.json();
  },

  async createWishlist(name) {
    const res = await authFetch(`${API_BASE}/api/wishlists`, { method: "POST", body: JSON.stringify({ name }) });
    if (!res.ok) { const d = await res.json(); throw new Error(d.error || "Failed to create list"); }
    return await res.json();
  },

  async deleteWishlist(id) {
    const res = await authFetch(`${API_BASE}/api/wishlists/${id}`, { method: "DELETE" });
    return res.ok;
  },

  async renameWishlist(id, name) {
    const res = await authFetch(`${API_BASE}/api/wishlists/${id}`, { method: "PATCH", body: JSON.stringify({ name }) });
    return res.ok ? await res.json() : null;
  },

  async addToWishlist(wishlistId, savedItemId) {
    const res = await authFetch(`${API_BASE}/api/wishlists/${wishlistId}/items`, { method: "POST", body: JSON.stringify({ saved_item_id: savedItemId }) });
    return res.ok;
  },

  async removeFromWishlist(wishlistId, savedItemId) {
    const res = await authFetch(`${API_BASE}/api/wishlists/${wishlistId}/items/${savedItemId}`, { method: "DELETE" });
    return res.ok;
  },

  async rateScan(scanId, rating) {
    const res = await authFetch(`${API_BASE}/api/user/scan/${scanId}/rating`, { method: "PATCH", body: JSON.stringify({ rating }) });
    return res.ok ? await res.json() : null;
  },

  async setVerdict(scanId, verdict) {
    const res = await authFetch(`${API_BASE}/api/user/scan/${scanId}/verdict`, {
      method: "PATCH",
      body: JSON.stringify({ verdict }),
    });
    return res.json();
  },

  async refineItem(scanId, itemIndex, originalItem, userMessage, chatHistory, gender) {
    const res = await authFetch(`${API_BASE}/api/refine-item`, {
      method: "POST",
      body: JSON.stringify({ scan_id: scanId, item_index: itemIndex, original_item: originalItem, user_message: userMessage, chat_history: chatHistory, gender }),
    });
    if (!res.ok) { const d = await res.json(); throw new Error(d.message || "Refinement failed"); }
    return await res.json();
  },

  async createCheckoutSession(plan) {
    const res = await authFetch(`${API_BASE}/api/payments/create-checkout-session`, {
      method: "POST",
      body: JSON.stringify({ plan }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Failed to create checkout session");
    return data;
  },

  async startTrial() {
    const res = await authFetch(`${API_BASE}/api/payments/start-trial`, { method: "POST" });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Failed to start trial");
    return data;
  },

  async getProfile() {
    const res = await authFetch(`${API_BASE}/api/user/profile`);
    if (!res.ok) return null;
    return await res.json();
  },

  async getStreak() {
    const res = await authFetch(`${API_BASE}/api/user/streak`);
    if (!res.ok) return { streak: 0 };
    return await res.json();
  },

  async getPublicProfile(userId) {
    return authFetch(`${API_BASE}/api/social/profile/${userId}`).then(r => r.json());
  },

  async followUser(userId) {
    return authFetch(`${API_BASE}/api/social/follow/${userId}`, { method: "POST" }).then(r => r.json());
  },

  async unfollowUser(userId) {
    return authFetch(`${API_BASE}/api/social/follow/${userId}`, { method: "DELETE" }).then(r => r.json());
  },

  async updateScanVisibility(scanId, visibility) {
    return authFetch(`${API_BASE}/api/social/scans/${scanId}/visibility`, { method: "PATCH", body: JSON.stringify({ visibility }) }).then(r => r.json());
  },

  async getFeed(page = 1, feedTab = "foryou") {
    const res = await authFetch(`${API_BASE}/api/feed?page=${page}&limit=20&tab=${feedTab}`);
    return res.json();
  },
  async searchUsers(q) {
    const res = await authFetch(`${API_BASE}/api/users/search?q=${encodeURIComponent(q)}`);
    return res.json();
  },
  async getPublicScan(scanId) {
    const res = await fetch(`${API_BASE}/api/scan/${scanId}/public`);
    return res.json();
  },

  async styleDna() {
    const res = await authFetch(`${API_BASE}/api/user/style-dna`);
    return res.json();
  },

  async priceAlertCount() {
    const res = await authFetch(`${API_BASE}/api/price-alerts/count`);
    return res.json();
  },
  async priceAlerts() {
    const res = await authFetch(`${API_BASE}/api/price-alerts`);
    return res.json();
  },
  async priceAlertSeen(id) {
    await authFetch(`${API_BASE}/api/price-alerts/${id}/seen`, { method: "PATCH" });
  },
};

// ═══════════════════════════════════════════════════════════════
// ANALYTICS
// ═══════════════════════════════════════════════════════════════

// Create once per browser tab — refreshes on tab close (sessionStorage)
const _sessionId = (() => {
  try {
    let id = sessionStorage.getItem("attair_sid");
    if (!id) { id = crypto.randomUUID(); sessionStorage.setItem("attair_sid", id); }
    return id;
  } catch { return Math.random().toString(36).slice(2); }
})();

/**
 * Fire-and-forget event tracker. Never throws, never blocks UI.
 * @param {string} eventType  e.g. "scan_started", "product_clicked"
 * @param {object} data       arbitrary payload for this event
 * @param {string|null} scanId  associated scan UUID if applicable
 * @param {string|null} page  e.g. "scan", "history", "profile"
 */
function track(eventType, data = {}, scanId = null, page = null) {
  try {
    authFetch(`${API_BASE}/api/events`, {
      method: "POST",
      body: JSON.stringify({
        event_type: eventType,
        event_data: data,
        scan_id: scanId || null,
        page,
        session_id: _sessionId,
      }),
    }).catch(() => {});
  } catch { /* ignore */ }
}

/**
 * Send event via sendBeacon — use for logout/page-close events where
 * the page is being torn down and a regular fetch might not complete.
 */
function trackBeacon(eventType, data = {}) {
  try {
    if (typeof navigator !== "undefined" && navigator.sendBeacon) {
      const payload = JSON.stringify([{
        event_type: eventType,
        event_data: data,
        session_id: _sessionId,
      }]);
      navigator.sendBeacon(`${API_BASE}/api/events`, new Blob([payload], { type: "application/json" }));
    }
  } catch { /* ignore */ }
}

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

const StatusPill = ({ status }) => {
  const cfg = {
    identified: { text: "AI IDENTIFIED", bg: "var(--bg-input)", color: "var(--text-tertiary)", dot: "var(--text-tertiary)" },
    searching: { text: "SEARCHING…", bg: "var(--accent-bg)", color: "var(--accent)", dot: "var(--accent)", pulse: true },
    verified: { text: "WEB VERIFIED", bg: "rgba(201,169,110,0.1)", color: "var(--accent)", dot: "var(--accent)" },
    failed: { text: "AI ONLY", bg: "var(--bg-input)", color: "var(--text-tertiary)", dot: "var(--text-tertiary)" },
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
    <a href={href} target="_blank" rel="noopener noreferrer"
      onClick={() => track("product_clicked", { tier, brand: data.brand, price: data.price, is_fallback: isFallback }, scanId, "scan")}
      style={{ padding: 16, background: "var(--bg-card)", border: `1px solid ${data.is_identified_brand ? "var(--accent-border)" : "var(--border)"}`, borderRadius: 14, textDecoration: "none", color: "inherit", display: "flex", flexDirection: "column", gap: 8, transition: "all 0.2s" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: 1.5, color: isFallback ? "var(--text-tertiary)" : tierCfg.accent, textTransform: "uppercase" }}>{tierCfg.icon} {tierCfg.label}</span>
        <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
          {data.is_identified_brand && <span style={{ fontSize: 8, fontWeight: 800, letterSpacing: 1, padding: "2px 6px", borderRadius: 3, background: "rgba(201,169,110,0.12)", color: "var(--accent)" }}>ORIGINAL</span>}
          {data.is_resale && <span style={{ fontSize: 8, fontWeight: 800, letterSpacing: 1, padding: "2px 6px", borderRadius: 3, background: "rgba(120,200,120,0.12)", color: "#7BC87B" }}>RESALE</span>}
          {data.is_product_page && !data.is_identified_brand && !data.is_resale && <span style={{ fontSize: 8, fontWeight: 700, letterSpacing: .5, padding: "2px 6px", borderRadius: 3, background: "var(--bg-input)", color: "var(--text-tertiary)" }}>Product page</span>}
        </div>
      </div>
      {isFallback ? (
        <>
          <div style={{ fontSize: 14, fontWeight: 600, lineHeight: 1.3, color: "var(--text-tertiary)" }}>No exact match found</div>
          <div style={{ fontSize: 12, color: "var(--text-tertiary)" }}>{data.price}</div>
          <div style={{ marginTop: "auto", padding: "10px 0 2px", fontSize: 12, fontWeight: 700, color: tierCfg.accent, textAlign: "center", borderTop: "1px solid var(--border)" }}>Search Google Shopping →</div>
        </>
      ) : (
        <>
          <div style={{ fontSize: 14, fontWeight: 600, lineHeight: 1.3 }}>{data.product_name || "Loading…"}</div>
          <div style={{ fontSize: 12, color: "var(--text-tertiary)" }}>{data.brand}</div>
          <div style={{ fontSize: 18, fontWeight: 700, color: tierCfg.accent, fontFamily: "var(--font-sans)" }}>{data.price}</div>
          {data.why && <div style={{ fontSize: 11, color: "var(--text-tertiary)", lineHeight: 1.4, fontStyle: "italic" }}>{data.why}</div>}
          <div style={{ marginTop: "auto", padding: "10px 0 2px", fontSize: 12, fontWeight: 700, color: tierCfg.accent, textAlign: "center", borderTop: "1px solid var(--border)" }}>Shop →</div>
        </>
      )}
    </a>
  );
};

// ─── Mini product card (compact, for 2-col grid) ────────────
const MiniCard = ({ tier, data, scanId, itemIndex, onSave, isSavedItem }) => {
  if (!data) return null;
  const tierCfg = {
    budget: { accent: "#5AC8FF" },
    mid: { accent: "#C9A96E" },
    premium: { accent: "#C77DFF" },
    resale: { accent: "#7BC47F" },
  }[tier] || { accent: "#C9A96E" };
  const clickId = `${scanId || "x"}_${itemIndex}_${tier}_mini`;
  const href = data.url ? API.affiliateUrl(clickId, data.url, scanId, itemIndex, tier, data.brand) : "#";
  const isFallback = !data.is_product_page && data.brand === "Google Shopping";
  return (
    <div style={{ position: "relative" }}>
      <a href={href} target="_blank" rel="noopener noreferrer"
        onClick={() => track("product_clicked", { tier, brand: data.brand, price: data.price, is_fallback: isFallback }, scanId, "scan")}
        style={{ padding: 12, background: "var(--bg-card)", border: `1px solid ${data.is_identified_brand ? "var(--accent-border)" : "var(--border)"}`, borderRadius: 12, textDecoration: "none", color: "inherit", display: "flex", flexDirection: "column", gap: 6, transition: "all 0.2s", minWidth: 0 }}>
        {data.image_url && (
          <div style={{ width: "100%", aspectRatio: "1", borderRadius: 8, overflow: "hidden", background: "var(--bg-input)", marginBottom: 2 }}>
            <img src={data.image_url} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} onError={e => { e.target.style.display = "none"; }} />
          </div>
        )}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          {data.is_identified_brand && <span style={{ fontSize: 7, fontWeight: 800, letterSpacing: 1, padding: "2px 5px", borderRadius: 3, background: "rgba(201,169,110,.12)", color: "var(--accent)" }}>ORIG</span>}
          {data.is_resale && <span style={{ fontSize: 7, fontWeight: 800, letterSpacing: 1, padding: "2px 5px", borderRadius: 3, background: "rgba(123,196,127,.12)", color: "#7BC47F" }}>RESALE</span>}
          {!data.is_identified_brand && !data.is_resale && <span style={{ fontSize: 7, color: "var(--text-tertiary)" }}>{data.brand?.slice(0, 14)}</span>}
          <span style={{ fontSize: 13, fontWeight: 700, color: tierCfg.accent }}>{isFallback ? "Search →" : data.price}</span>
        </div>
        {!isFallback && <div style={{ fontSize: 11, fontWeight: 500, color: "var(--text-secondary)", lineHeight: 1.3, overflow: "hidden", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical" }}>{data.product_name}</div>}
        {isFallback && <div style={{ fontSize: 11, color: "var(--text-tertiary)", lineHeight: 1.3 }}>No match — tap to search</div>}
      </a>
      {onSave && (
        <button
          aria-label={isSavedItem ? "Remove from Likes" : "Save to Likes"}
          onClick={e => { e.preventDefault(); e.stopPropagation(); onSave(); }}
          style={{ position: "absolute", top: 6, right: 6, width: 30, height: 30, borderRadius: "50%", background: isSavedItem ? "rgba(255,60,80,.9)" : "rgba(0,0,0,.45)", border: "none", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", backdropFilter: "blur(4px)", transition: "all .2s", zIndex: 2 }}>
          <svg viewBox="0 0 24 24" width="14" height="14" fill={isSavedItem ? "#fff" : "none"} stroke={isSavedItem ? "#fff" : "rgba(255,255,255,.8)"} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/>
          </svg>
        </button>
      )}
    </div>
  );
};

// ─── Upgrade Modal ──────────────────────────────────────────
const UpgradeModal = ({ trigger, onClose, onUpgrade, onStartTrial, userStatus }) => {
  const [plan, setPlan] = useState("yearly");
  const [loadingPlan, setLoadingPlan] = useState(false);
  const msgs = {
    scan_limit: { title: "You've used all 12 free scans this month", sub: "Go Pro for unlimited scans, zero ads, and price drop alerts.", cta: "Unlock Unlimited Scans" },
    ad_fatigue: { title: "Tired of ads?", sub: "Pro members get a completely ad-free experience plus unlimited scans.", cta: "Remove Ads Forever" },
    history_expiring: { title: "Your scan history expires soon", sub: "Free accounts only keep 7 days. Pro keeps everything forever.", cta: "Keep My History" },
    save_limit: { title: "You've saved 20 items", sub: "Unlock unlimited saves, price drop alerts, and an ad-free experience.", cta: "Save Unlimited Items" },
    price_drop: { title: "A saved item dropped 30%", sub: "Pro users get instant price drop alerts. Never miss a deal.", cta: "Get Price Alerts" },
    general: { title: "Unlock the full experience", sub: "Unlimited scans, zero ads, price alerts, and more.", cta: "Go Pro" },
  };
  const m = msgs[trigger] || msgs.general;
  const handleCta = async () => {
    setLoadingPlan(true);
    try { await onUpgrade(plan); } finally { setLoadingPlan(false); }
  };
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-box" onClick={e => e.stopPropagation()} style={{ overflowY: "auto", maxHeight: "90vh" }}>
        <button className="modal-x" onClick={onClose}>✕</button>
        <div className="pw-badge">✦ ATTAIR PRO</div>
        <h2 className="modal-title">{m.title}</h2>
        <p className="modal-sub">{m.sub}</p>
        <div className="pw-fs" style={{ marginBottom: 24 }}>
          {["Unlimited AI outfit scans", "Completely ad-free", "Price drop alerts", "Full scan history forever"].map((f, i) => (
            <div className="pw-f" key={i}><div className="pw-ck">✓</div>{f}</div>
          ))}
        </div>
        <div className="pw-plans">
          <div className={`pw-p${plan === "yearly" ? " sel" : ""}`} onClick={() => setPlan("yearly")} style={{ textAlign: "center" }}>
            <div className="pw-ptag">SAVE 50%</div>
            <div className="pw-pp">$30<span className="pw-pd">/yr</span></div>
            <div className="pw-pw">$2.50/mo</div>
          </div>
          <div className={`pw-p${plan === "monthly" ? " sel" : ""}`} onClick={() => setPlan("monthly")} style={{ textAlign: "center" }}>
            <div className="pw-pp">$5<span className="pw-pd">/mo</span></div>
            <div className="pw-pw">$1.15/week</div>
          </div>
        </div>
        <button className="cta" onClick={handleCta} disabled={loadingPlan} style={{ opacity: loadingPlan ? 0.7 : 1 }}>
          {loadingPlan ? <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}><span style={{ display: "inline-block", width: 14, height: 14, border: "2px solid rgba(12,12,14,.3)", borderTopColor: "#0C0C0E", borderRadius: "50%", animation: "spin .7s linear infinite" }} />Processing…</span> : m.cta}
        </button>
        <button className="modal-later" onClick={() => onStartTrial && onStartTrial()} style={{ color: "var(--accent)", fontSize: 12, marginTop: -4 }}>
          Or start a 7-day free trial →
        </button>
        <button className="modal-later" onClick={onClose}>Maybe later</button>
        {userStatus?.tier === "free" && !userStatus?.trial_ends_at && (
          <div style={{ textAlign: "center", marginTop: 12, paddingTop: 12, borderTop: "1px solid var(--border)" }}>
            <button onClick={() => onStartTrial && onStartTrial()} style={{ background: "transparent", border: "1px solid rgba(255,107,53,.35)", color: "#FF6B35", padding: "10px 24px", borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: "pointer", fontFamily: "var(--font-sans)", width: "100%" }}>
              Start 7-day free trial — no card required
            </button>
          </div>
        )}
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
        <div className="ad-slot" style={{ width: "90%", height: "70%", borderRadius: 12, overflow: "hidden", display: "flex", flexDirection: "column", background: "linear-gradient(135deg, #1a1a2e 0%, #16213e 50%, #0f3460 100%)", border: "1px solid rgba(255,255,255,.08)" }}>
          <div style={{ padding: "8px 12px", display: "flex", justifyContent: "space-between", alignItems: "center", borderBottom: "1px solid rgba(255,255,255,.06)" }}>
            <span style={{ fontSize: 9, color: "rgba(255,255,255,.3)", letterSpacing: 1, textTransform: "uppercase" }}>Sponsored</span>
            <span style={{ fontSize: 9, color: "rgba(255,255,255,.15)" }}>Ad</span>
          </div>
          <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
            <div style={{ textAlign: "center" }}>
              <div style={{ fontSize: 48, marginBottom: 12 }}>&#128247;</div>
              <div style={{ fontSize: 16, fontWeight: 700, color: "#fff", marginBottom: 6, fontFamily: "var(--font-sans)" }}>New Arrivals</div>
              <div style={{ fontSize: 12, color: "rgba(255,255,255,.5)", marginBottom: 16 }}>Discover this season's top looks</div>
              <button onClick={() => { API.logAdEvent("interstitial", "post_scan", "click"); onClose(); }} style={{ display: "inline-block", padding: "10px 24px", background: "#C9A96E", borderRadius: 100, fontSize: 12, fontWeight: 700, color: "#0C0C0E", fontFamily: "var(--font-sans)", border: "none", cursor: "pointer" }}>Shop Now</button>
            </div>
          </div>
          <div style={{ padding: "8px 12px", textAlign: "center", borderTop: "1px solid rgba(255,255,255,.06)" }}>
            <span style={{ fontSize: 10, color: "rgba(255,255,255,.2)" }}>Featured Partner</span>
          </div>
        </div>
        <div style={{ fontSize: 10, color: "rgba(255,255,255,.15)" }}>Upgrade to Pro to remove ads</div>
        {timer > 0
          ? <div style={{ position: "absolute", top: 16, right: 16, fontSize: 12, color: "rgba(255,255,255,.25)" }}>Skip in {timer}s</div>
          : <button onClick={onClose} style={{ position: "absolute", top: 14, right: 14, background: "rgba(255,255,255,.08)", border: "none", borderRadius: 100, padding: "6px 14px", fontSize: 12, fontWeight: 600, color: "#fff", cursor: "pointer", fontFamily: "var(--font-sans)" }}>Skip →</button>
        }
      </div>
    </div>
  );
};

const CAT_POSITIONS = { outerwear: 0.3, top: 0.35, dress: 0.4, bottom: 0.65, shoes: 0.88, accessory: 0.15, bag: 0.55 };

// Normalise tiers: backend may return a single object (old format) or an array (new format)
function asTierArray(val) {
  if (!val) return [];
  if (Array.isArray(val)) return val;
  return [val]; // legacy single-product format
}

// ═══════════════════════════════════════════════════════════════
// i18n — 8 language support
// ═══════════════════════════════════════════════════════════════
const STRINGS = {
  en: {
    home: "Home",
    scan: "Scan",
    history: "History",
    saved: "Saved",
    profile: "Profile",
    new_scan: "New scan",
    analyzing: "Analyzing the look…",
    searching: "Searching the web…",
    shop_item: "Shop this item",
    save: "Save",
    splurge: "Splurge",
    best_value: "Best Value",
    complete_look: "Complete the Look",
    as_seen_on: "As Seen On",
    get_it_today: "Get It Today",
    rate_outfit: "Rate this outfit",
    log_out: "Log out",
    settings: "Settings",
    light_mode: "Switch to Light Mode",
    dark_mode: "Switch to Dark Mode",
    language: "Language",
    search_notes_placeholder: "Add search notes (e.g., 'sustainable brands', 'linen fabric')…",
    select_items: "Select items to search",
    no_scans: "No scans yet. Take your first photo!",
    no_saves: "No saved items yet",
    scans_remaining: "free scans this month",
    upgrade: "Go Pro",
    copy: "Copy",
    copied: "Copied!",
    share: "Share",
    streak: "day streak!",
    likes: "Saved",
    collections: "Collections",
    add_to_collection: "Add to collection",
    create_collection: "Create collection",
    no_likes: "No saved items yet",
    find_nearby: "Find Near Me",
    no_stores_nearby: "No stores nearby",
    location_denied: "Location access needed",
    who_inspires: "Who inspires your style?",
    custom_occasion: "Custom",
    search_failed: "Search failed. Try refining your items and searching again.",
    follow: "Follow",
    unfollow: "Unfollow",
    followers: "Followers",
    following: "Following",
    public_profile: "Public",
    private_profile: "Private",
    followers_only: "Followers Only",
  },
  es: {
    home: "Inicio",
    scan: "Escanear",
    history: "Historial",
    saved: "Guardados",
    profile: "Perfil",
    new_scan: "Nuevo escaneo",
    analyzing: "Analizando el look…",
    searching: "Buscando en la web…",
    shop_item: "Comprar este artículo",
    save: "Económico",
    splurge: "Premium",
    best_value: "Mejor precio",
    complete_look: "Completa el Look",
    as_seen_on: "Visto en",
    get_it_today: "Cómpralo Hoy",
    rate_outfit: "Califica este outfit",
    log_out: "Cerrar sesión",
    settings: "Ajustes",
    light_mode: "Cambiar a Modo Claro",
    dark_mode: "Cambiar a Modo Oscuro",
    language: "Idioma",
    search_notes_placeholder: "Añadir notas (ej. 'marcas sostenibles', 'tela de lino')…",
    select_items: "Seleccionar artículos",
    no_scans: "Sin escaneos. ¡Toma tu primera foto!",
    no_saves: "Sin artículos guardados",
    scans_remaining: "escaneos gratis este mes",
    upgrade: "Ir a Pro",
    copy: "Copiar",
    copied: "¡Copiado!",
    share: "Compartir",
    streak: "días seguidos!",
    likes: "Me gusta",
    collections: "Colecciones",
    add_to_collection: "Añadir a colección",
    create_collection: "Crear colección",
    no_likes: "Sin artículos guardados",
    find_nearby: "Buscar cerca",
    no_stores_nearby: "Sin tiendas cercanas",
    location_denied: "Se necesita acceso a ubicación",
    who_inspires: "¿Quién inspira tu estilo?",
    custom_occasion: "Personalizar",
    search_failed: "La búsqueda falló. Intenta refinar tus artículos y buscar de nuevo.",
    follow: "Seguir",
    unfollow: "Dejar de seguir",
    followers: "Seguidores",
    following: "Siguiendo",
    public_profile: "Público",
    private_profile: "Privado",
    followers_only: "Solo seguidores",
  },
  fr: {
    home: "Accueil",
    scan: "Scanner",
    history: "Historique",
    saved: "Sauvegardes",
    profile: "Profil",
    new_scan: "Nouveau scan",
    analyzing: "Analyse du look…",
    searching: "Recherche en cours…",
    shop_item: "Acheter cet article",
    save: "Économique",
    splurge: "Premium",
    best_value: "Meilleur rapport",
    complete_look: "Compléter le Look",
    as_seen_on: "Vu Sur",
    get_it_today: "L'Avoir Aujourd'hui",
    rate_outfit: "Évaluer la tenue",
    log_out: "Se déconnecter",
    settings: "Paramètres",
    light_mode: "Passer en Mode Clair",
    dark_mode: "Passer en Mode Sombre",
    language: "Langue",
    search_notes_placeholder: "Notes de recherche (ex. 'marques durables', 'tissu lin')…",
    select_items: "Sélectionner des articles",
    no_scans: "Aucun scan. Prenez votre première photo!",
    no_saves: "Aucun article sauvegardé",
    scans_remaining: "scans gratuits ce mois",
    upgrade: "Passer Pro",
    copy: "Copier",
    copied: "Copié!",
    share: "Partager",
    streak: "jours de suite!",
    likes: "J'aime",
    collections: "Collections",
    add_to_collection: "Ajouter à une collection",
    create_collection: "Créer une collection",
    no_likes: "Aucun article aimé",
    find_nearby: "Trouver près de moi",
    no_stores_nearby: "Aucun magasin à proximité",
    location_denied: "Accès à la localisation requis",
    who_inspires: "Qui inspire votre style?",
    custom_occasion: "Personnalisé",
    search_failed: "La recherche a échoué. Essayez d'affiner vos articles et relancez.",
    follow: "Suivre",
    unfollow: "Ne plus suivre",
    followers: "Abonnés",
    following: "Abonnements",
    public_profile: "Public",
    private_profile: "Privé",
    followers_only: "Abonnés uniquement",
  },
  de: {
    home: "Start",
    scan: "Scannen",
    history: "Verlauf",
    saved: "Gespeichert",
    profile: "Profil",
    new_scan: "Neuer Scan",
    analyzing: "Look wird analysiert…",
    searching: "Web wird durchsucht…",
    shop_item: "Artikel kaufen",
    save: "Günstig",
    splurge: "Premium",
    best_value: "Bestes Preis-Leistung",
    complete_look: "Look vervollständigen",
    as_seen_on: "Gesehen Bei",
    get_it_today: "Heute Kaufen",
    rate_outfit: "Outfit bewerten",
    log_out: "Abmelden",
    settings: "Einstellungen",
    light_mode: "Zum hellen Modus",
    dark_mode: "Zum dunklen Modus",
    language: "Sprache",
    search_notes_placeholder: "Suchnotizen (z.B. 'nachhaltige Marken', 'Leinenstoff')…",
    select_items: "Artikel auswählen",
    no_scans: "Noch keine Scans. Mach dein erstes Foto!",
    no_saves: "Keine gespeicherten Artikel",
    scans_remaining: "kostenlose Scans diesen Monat",
    upgrade: "Pro werden",
    copy: "Kopieren",
    copied: "Kopiert!",
    share: "Teilen",
    streak: "Tage hintereinander!",
    likes: "Gefällt mir",
    collections: "Sammlungen",
    add_to_collection: "Zur Sammlung hinzufügen",
    create_collection: "Sammlung erstellen",
    no_likes: "Noch keine Favoriten",
    find_nearby: "In der Nähe suchen",
    no_stores_nearby: "Keine Geschäfte in der Nähe",
    location_denied: "Standortzugriff benötigt",
    who_inspires: "Wer inspiriert deinen Stil?",
    custom_occasion: "Benutzerdefiniert",
    search_failed: "Suche fehlgeschlagen. Verfeinern Sie Ihre Artikel und versuchen Sie es erneut.",
    follow: "Folgen",
    unfollow: "Entfolgen",
    followers: "Follower",
    following: "Folge ich",
    public_profile: "Öffentlich",
    private_profile: "Privat",
    followers_only: "Nur Follower",
  },
  zh: {
    home: "首页",
    scan: "扫描",
    history: "历史",
    saved: "已保存",
    profile: "个人",
    new_scan: "新扫描",
    analyzing: "正在分析穿搭…",
    searching: "正在搜索…",
    shop_item: "购买此商品",
    save: "经济实惠",
    splurge: "高端奢华",
    best_value: "最佳性价比",
    complete_look: "完善穿搭",
    as_seen_on: "明星同款",
    get_it_today: "今日购买",
    rate_outfit: "评价穿搭",
    log_out: "退出登录",
    settings: "设置",
    light_mode: "切换浅色模式",
    dark_mode: "切换深色模式",
    language: "语言",
    search_notes_placeholder: "添加搜索备注（如'可持续品牌'、'亚麻面料'）…",
    select_items: "选择要搜索的商品",
    no_scans: "暂无扫描记录，拍摄你的第一张照片吧！",
    no_saves: "暂无保存的商品",
    scans_remaining: "本月免费扫描次数",
    upgrade: "升级 Pro",
    copy: "复制",
    copied: "已复制！",
    share: "分享",
    streak: "天连续打卡！",
    likes: "喜欢",
    collections: "收藏夹",
    add_to_collection: "添加到收藏夹",
    create_collection: "创建收藏夹",
    no_likes: "还没有喜欢的商品",
    find_nearby: "附近门店",
    no_stores_nearby: "附近没有门店",
    location_denied: "需要位置权限",
    who_inspires: "谁启发了你的穿搭风格？",
    custom_occasion: "自定义",
    search_failed: "搜索失败。请调整商品描述后重试。",
    follow: "关注",
    unfollow: "取消关注",
    followers: "粉丝",
    following: "关注中",
    public_profile: "公开",
    private_profile: "私密",
    followers_only: "仅粉丝可见",
  },
  ja: {
    home: "ホーム",
    scan: "スキャン",
    history: "履歴",
    saved: "保存済み",
    profile: "プロフィール",
    new_scan: "新規スキャン",
    analyzing: "コーデを分析中…",
    searching: "検索中…",
    shop_item: "このアイテムを購入",
    save: "プチプラ",
    splurge: "プレミアム",
    best_value: "コスパ最高",
    complete_look: "コーデを完成させる",
    as_seen_on: "着用情報",
    get_it_today: "今日ゲット",
    rate_outfit: "コーデを評価",
    log_out: "ログアウト",
    settings: "設定",
    light_mode: "ライトモードに切替",
    dark_mode: "ダークモードに切替",
    language: "言語",
    search_notes_placeholder: "検索メモ（例：'サステナブルブランド'、'リネン素材'）…",
    select_items: "アイテムを選択",
    no_scans: "スキャン履歴なし。最初の写真を撮りましょう！",
    no_saves: "保存アイテムなし",
    scans_remaining: "今月の無料スキャン",
    upgrade: "Proにアップグレード",
    copy: "コピー",
    copied: "コピーしました！",
    share: "シェア",
    streak: "日連続！",
    likes: "いいね",
    collections: "コレクション",
    add_to_collection: "コレクションに追加",
    create_collection: "コレクションを作成",
    no_likes: "まだいいねしたアイテムがありません",
    find_nearby: "近くで探す",
    no_stores_nearby: "近くに店舗なし",
    location_denied: "位置情報へのアクセスが必要",
    who_inspires: "あなたのスタイルに影響を与える人は？",
    custom_occasion: "カスタム",
    search_failed: "検索に失敗しました。アイテムを調整して再検索してください。",
    follow: "フォロー",
    unfollow: "フォロー解除",
    followers: "フォロワー",
    following: "フォロー中",
    public_profile: "公開",
    private_profile: "非公開",
    followers_only: "フォロワーのみ",
  },
  ko: {
    home: "홈",
    scan: "스캔",
    history: "기록",
    saved: "저장됨",
    profile: "프로필",
    new_scan: "새 스캔",
    analyzing: "스타일 분석 중…",
    searching: "검색 중…",
    shop_item: "이 아이템 구매",
    save: "저렴한",
    splurge: "프리미엄",
    best_value: "가성비 최고",
    complete_look: "룩 완성하기",
    as_seen_on: "착용 정보",
    get_it_today: "오늘 구매",
    rate_outfit: "스타일 평가",
    log_out: "로그아웃",
    settings: "설정",
    light_mode: "라이트 모드로 전환",
    dark_mode: "다크 모드로 전환",
    language: "언어",
    search_notes_placeholder: "검색 메모 추가 (예: '지속가능 브랜드', '린넨 소재')…",
    select_items: "검색할 아이템 선택",
    no_scans: "스캔 기록 없음. 첫 번째 사진을 찍어보세요!",
    no_saves: "저장된 아이템 없음",
    scans_remaining: "이번 달 무료 스캔",
    upgrade: "Pro로 업그레이드",
    copy: "복사",
    copied: "복사됨!",
    share: "공유",
    streak: "일 연속!",
    likes: "좋아요",
    collections: "컬렉션",
    add_to_collection: "컬렉션에 추가",
    create_collection: "컬렉션 만들기",
    no_likes: "좋아요한 아이템이 없습니다",
    find_nearby: "주변 찾기",
    no_stores_nearby: "주변 매장 없음",
    location_denied: "위치 접근 권한 필요",
    who_inspires: "누가 당신의 스타일에 영감을 주나요?",
    custom_occasion: "직접 입력",
    search_failed: "검색에 실패했습니다. 항목을 수정한 후 다시 검색해 주세요.",
    follow: "팔로우",
    unfollow: "언팔로우",
    followers: "팔로워",
    following: "팔로잉",
    public_profile: "공개",
    private_profile: "비공개",
    followers_only: "팔로워만",
  },
  pt: {
    home: "Inicio",
    scan: "Escanear",
    history: "Histórico",
    saved: "Salvos",
    profile: "Perfil",
    new_scan: "Novo scan",
    analyzing: "Analisando o look…",
    searching: "Pesquisando na web…",
    shop_item: "Comprar este item",
    save: "Econômico",
    splurge: "Premium",
    best_value: "Melhor custo-benefício",
    complete_look: "Completar o Look",
    as_seen_on: "Visto Em",
    get_it_today: "Compre Hoje",
    rate_outfit: "Avaliar o outfit",
    log_out: "Sair",
    settings: "Configurações",
    light_mode: "Mudar para Modo Claro",
    dark_mode: "Mudar para Modo Escuro",
    language: "Idioma",
    search_notes_placeholder: "Notas de busca (ex: 'marcas sustentáveis', 'tecido linho')…",
    select_items: "Selecionar itens",
    no_scans: "Sem scans. Tire sua primeira foto!",
    no_saves: "Nenhum item salvo",
    scans_remaining: "scans gratuitos este mês",
    upgrade: "Ir Pro",
    copy: "Copiar",
    copied: "Copiado!",
    share: "Compartilhar",
    streak: "dias seguidos!",
    likes: "Curtidas",
    collections: "Coleções",
    add_to_collection: "Adicionar à coleção",
    create_collection: "Criar coleção",
    no_likes: "Nenhum item curtido ainda",
    find_nearby: "Encontrar perto de mim",
    no_stores_nearby: "Nenhuma loja próxima",
    location_denied: "Acesso à localização necessário",
    who_inspires: "Quem inspira o seu estilo?",
    custom_occasion: "Personalizado",
    search_failed: "A pesquisa falhou. Tente refinar seus itens e pesquisar novamente.",
    follow: "Seguir",
    unfollow: "Deixar de seguir",
    followers: "Seguidores",
    following: "Seguindo",
    public_profile: "Público",
    private_profile: "Privado",
    followers_only: "Apenas seguidores",
  },
};

// ═══════════════════════════════════════════════════════════════
// ONBOARDING
// ═══════════════════════════════════════════════════════════════
const OB_STEPS = [
  { id: "welcome", type: "info", icon: "✦", title: "Scan any outfit.\nFind where to buy it.", sub: "Point your camera at any look. Our AI identifies every piece and finds you budget, mid, and premium options instantly.", cta: "Get Started" },
  { id: "first_scan", type: "first_scan", title: "Scan Your First Outfit", sub: "Take a photo or upload one to see the magic." },
];

// ═══════════════════════════════════════════════════════════════
// SHARE CARD GENERATOR — Canvas API (Instagram story 9:16)
// ═══════════════════════════════════════════════════════════════
async function generateShareCard({ imageUrl, summary, items, verdict, userName }) {
  const canvas = document.createElement("canvas");
  canvas.width = 1080;
  canvas.height = 1920;
  const ctx = canvas.getContext("2d");

  // Background: dark gradient
  const grad = ctx.createLinearGradient(0, 0, 0, 1920);
  grad.addColorStop(0, "#0C0C0E");
  grad.addColorStop(1, "#1A1A1A");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 1080, 1920);

  // Load and draw outfit photo
  try {
    const img = new Image();
    img.crossOrigin = "anonymous";
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = reject;
      img.src = imageUrl;
    });
    const photoX = 40, photoY = 120, photoW = 1000, photoH = 1200;
    ctx.save();
    ctx.beginPath();
    ctx.roundRect(photoX, photoY, photoW, photoH, 24);
    ctx.clip();
    const scale = Math.max(photoW / img.width, photoH / img.height);
    const sw = photoW / scale, sh = photoH / scale;
    const sx = (img.width - sw) / 2, sy = (img.height - sh) / 2;
    ctx.drawImage(img, sx, sy, sw, sh, photoX, photoY, photoW, photoH);
    ctx.restore();
  } catch (e) {
    // If image fails, continue with text only
  }

  // Verdict badge
  const verdictY = 1380;
  if (verdict) {
    const labels = { would_wear: "Would Wear", on_the_fence: "On the Fence", not_for_me: "Not for Me" };
    const colors = { would_wear: "#4CAF50", on_the_fence: "#FFB74D", not_for_me: "#FF5252" };
    ctx.fillStyle = colors[verdict] || "#C9A96E";
    ctx.font = "bold 48px 'Outfit', system-ui";
    ctx.textAlign = "center";
    ctx.fillText(labels[verdict] || "", 540, verdictY);
  }

  // Summary
  ctx.fillStyle = "#FFFFFF";
  ctx.font = "600 36px 'Outfit', system-ui";
  ctx.textAlign = "center";
  const summaryText = summary?.substring(0, 60) || "";
  if (summaryText) ctx.fillText(summaryText, 540, 1460);

  // Items count
  const itemCount = items?.length || 0;
  ctx.fillStyle = "rgba(255,255,255,0.5)";
  ctx.font = "400 28px 'Outfit', system-ui";
  ctx.fillText(`${itemCount} item${itemCount !== 1 ? "s" : ""} identified`, 540, 1520);

  // User name
  if (userName) {
    ctx.fillStyle = "rgba(255,255,255,0.4)";
    ctx.font = "400 24px 'Outfit', system-ui";
    ctx.fillText(`Scanned by ${userName}`, 540, 1580);
  }

  // ATTAIR watermark
  ctx.fillStyle = "#C9A96E";
  ctx.font = "bold 56px 'Outfit', system-ui";
  ctx.textAlign = "center";
  ctx.fillText("ATTAIRE", 540, 1800);
  ctx.fillStyle = "rgba(201,169,110,0.5)";
  ctx.font = "400 24px 'Outfit', system-ui";
  ctx.fillText("AI Fashion Scanner", 540, 1850);

  return canvas.toDataURL("image/png");
}

// ─── Style DNA share card generator ──────────────────────────
async function generateStyleDnaCard(dna, userName) {
  const canvas = document.createElement("canvas");
  canvas.width = 1080;
  canvas.height = 1920;
  const ctx = canvas.getContext("2d");

  // Background gradient
  const grad = ctx.createLinearGradient(0, 0, 0, 1920);
  grad.addColorStop(0, "#0C0C0E");
  grad.addColorStop(0.5, "#151518");
  grad.addColorStop(1, "#0C0C0E");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 1080, 1920);

  // Subtle gold accent circle in background
  ctx.beginPath();
  ctx.arc(540, 600, 300, 0, Math.PI * 2);
  ctx.fillStyle = "rgba(201,169,110,0.03)";
  ctx.fill();

  // "YOUR STYLE DNA" header
  ctx.fillStyle = "#C9A96E";
  ctx.font = "bold 28px 'Outfit', system-ui";
  ctx.textAlign = "center";
  ctx.fillText("YOUR STYLE DNA", 540, 300);

  // Archetype - big and bold
  ctx.fillStyle = "#FFFFFF";
  ctx.font = "bold 72px 'Outfit', system-ui";
  ctx.fillText(dna.archetype || "", 540, 500);

  // Description
  ctx.fillStyle = "rgba(255,255,255,0.6)";
  ctx.font = "400 32px 'Outfit', system-ui";
  const descWords = (dna.description || "").split(" ");
  let descLine = "", descY = 600;
  for (const word of descWords) {
    const test = descLine + word + " ";
    if (ctx.measureText(test).width > 900) {
      ctx.fillText(descLine.trim(), 540, descY);
      descLine = word + " ";
      descY += 44;
    } else {
      descLine = test;
    }
  }
  if (descLine.trim()) ctx.fillText(descLine.trim(), 540, descY);

  // Trait pills
  const traitY = descY + 80;
  ctx.font = "500 28px 'Outfit', system-ui";
  (dna.traits || []).forEach((trait, i) => {
    const ty = traitY + i * 56;
    const tw = ctx.measureText(trait).width + 48;
    const tx = 540 - tw / 2;
    ctx.fillStyle = "rgba(201,169,110,0.1)";
    ctx.beginPath();
    ctx.roundRect(tx, ty - 20, tw, 44, 22);
    ctx.fill();
    ctx.strokeStyle = "rgba(201,169,110,0.2)";
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.fillStyle = "rgba(255,255,255,0.7)";
    ctx.fillText(trait, 540, ty + 8);
  });

  // Style score bars
  const barY = traitY + (dna.traits?.length || 0) * 56 + 60;
  const dims = [
    { label: "Classic", label2: "Trendy", key: "classic_vs_trendy" },
    { label: "Minimal", label2: "Maximal", key: "minimal_vs_maximal" },
    { label: "Casual", label2: "Formal", key: "casual_vs_formal" },
    { label: "Budget", label2: "Luxury", key: "budget_vs_luxury" }
  ];
  dims.forEach(({ label, label2, key }, i) => {
    const y = barY + i * 70;
    ctx.font = "600 22px 'Outfit', system-ui";
    ctx.fillStyle = "rgba(255,255,255,0.3)";
    ctx.textAlign = "left";
    ctx.fillText(label, 100, y);
    ctx.textAlign = "right";
    ctx.fillText(label2, 980, y);
    // Bar background
    ctx.fillStyle = "rgba(255,255,255,0.06)";
    ctx.beginPath();
    ctx.roundRect(100, y + 12, 880, 8, 4);
    ctx.fill();
    // Bar fill
    const pct = ((dna.style_score?.[key] || 5) / 10) * 880;
    ctx.fillStyle = "#C9A96E";
    ctx.beginPath();
    ctx.roundRect(100, y + 12, pct, 8, 4);
    ctx.fill();
  });

  // User name
  if (userName) {
    ctx.textAlign = "center";
    ctx.fillStyle = "rgba(255,255,255,0.35)";
    ctx.font = "400 26px 'Outfit', system-ui";
    ctx.fillText(userName, 540, 1700);
  }

  // ATTAIR watermark
  ctx.fillStyle = "#C9A96E";
  ctx.font = "bold 56px 'Outfit', system-ui";
  ctx.textAlign = "center";
  ctx.fillText("ATTAIRE", 540, 1810);
  ctx.fillStyle = "rgba(201,169,110,0.5)";
  ctx.font = "400 24px 'Outfit', system-ui";
  ctx.fillText("AI Fashion Scanner", 540, 1860);

  return canvas.toDataURL("image/png");
}

// ═══════════════════════════════════════════════════════════════
// ─── Loading message arrays ──────────────────────────────────
const SCAN_MESSAGES = [
  "Analyzing the look…",
  "Reading colors and silhouettes…",
  "Identifying brands and styles…",
  "Checking for visual details…",
  "Mapping the outfit…",
  "Almost there…",
];
const SEARCH_MESSAGES = [
  "Analyzing your photo…",
  "Searching stores…",
  "Finding matches…",
  "Comparing prices…",
  "Checking stock…",
  "Almost ready…",
];
const RESEARCH_MESSAGES = [
  "Re-running search…",
  "Finding better matches…",
  "Applying your changes…",
  "Searching with new criteria…",
  "Comparing results…",
  "Almost there…",
];

// ─── Circle to Search canvas overlay ────────────────────────
const CircleToSearchOverlay = ({ imageRef, onConfirm, onCancel }) => {
  const canvasRef = useRef(null);
  const [isDrawing, setIsDrawing] = useState(false);
  const [path, setPath] = useState([]);
  const [confirmed, setConfirmed] = useState(false);
  const [glowing, setGlowing] = useState(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !imageRef?.current) return;
    const img = imageRef.current;
    canvas.width = img.offsetWidth;
    canvas.height = img.offsetHeight;
  }, [imageRef]);

  const getPos = (e) => {
    const canvas = canvasRef.current;
    const rect = canvas.getBoundingClientRect();
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;
    return { x: clientX - rect.left, y: clientY - rect.top };
  };

  const startDraw = (e) => {
    e.preventDefault();
    const pos = getPos(e);
    setIsDrawing(true);
    setPath([pos]);
    setConfirmed(false);
    const ctx = canvasRef.current.getContext("2d");
    ctx.clearRect(0, 0, canvasRef.current.width, canvasRef.current.height);
  };

  const draw = (e) => {
    if (!isDrawing) return;
    e.preventDefault();
    const pos = getPos(e);
    setPath(prev => [...prev, pos]);
    const canvas = canvasRef.current;
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const pts = [...path, pos];
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    pts.forEach(p => ctx.lineTo(p.x, p.y));
    ctx.strokeStyle = "rgba(255, 204, 0, 0.7)";
    ctx.lineWidth = 5;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.stroke();
    ctx.closePath();
    ctx.fillStyle = "rgba(255, 220, 0, 0.06)";
    ctx.fill();
  };

  const endDraw = (e) => {
    if (!isDrawing) return;
    e.preventDefault();
    setIsDrawing(false);
    if (path.length < 3) return;
    const canvas = canvasRef.current;
    const ctx = canvas.getContext("2d");
    ctx.beginPath();
    ctx.moveTo(path[0].x, path[0].y);
    path.forEach(p => ctx.lineTo(p.x, p.y));
    ctx.closePath();
    ctx.strokeStyle = "rgba(255, 204, 0, 0.8)";
    ctx.lineWidth = 5;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.stroke();
    ctx.fillStyle = "rgba(255, 220, 0, 0.1)";
    ctx.fill();
    setConfirmed(true);
    // Trigger glow animation to confirm "locked on" — lasts ~2 seconds
    setGlowing(true);
    setTimeout(() => setGlowing(false), 2000);
    const xs = path.map(p => p.x), ys = path.map(p => p.y);
    const minX = Math.max(0, Math.min(...xs) - 10);
    const minY = Math.max(0, Math.min(...ys) - 10);
    const maxX = Math.min(canvas.width, Math.max(...xs) + 10);
    const maxY = Math.min(canvas.height, Math.max(...ys) + 10);
    const cropW = maxX - minX, cropH = maxY - minY;
    if (cropW < 10 || cropH < 10) return;
    const img = imageRef.current;
    const cropCanvas = document.createElement("canvas");
    const scaleX = img.naturalWidth / img.offsetWidth;
    const scaleY = img.naturalHeight / img.offsetHeight;
    cropCanvas.width = cropW * scaleX;
    cropCanvas.height = cropH * scaleY;
    const cropCtx = cropCanvas.getContext("2d");
    cropCtx.drawImage(img, minX * scaleX, minY * scaleY, cropW * scaleX, cropH * scaleY, 0, 0, cropCanvas.width, cropCanvas.height);
    const base64 = cropCanvas.toDataURL("image/jpeg", 0.9).split(",")[1];
    onConfirm(base64);
  };

  const clear = () => {
    setPath([]);
    setConfirmed(false);
    const canvas = canvasRef.current;
    if (canvas) canvas.getContext("2d").clearRect(0, 0, canvas.width, canvas.height);
    onConfirm(null);
  };

  return (
    <div style={{ position: "absolute", top: 0, left: 0, width: "100%", height: "100%", zIndex: 10 }}>
      <canvas
        ref={canvasRef}
        style={{ position: "absolute", top: 0, left: 0, width: "100%", height: "100%", touchAction: "none", cursor: "crosshair", animation: glowing ? 'circleGlow 0.5s ease-in-out 4' : 'none', borderRadius: glowing ? "inherit" : undefined }}
        onMouseDown={startDraw} onMouseMove={draw} onMouseUp={endDraw}
        onTouchStart={startDraw} onTouchMove={draw} onTouchEnd={endDraw}
      />
      <div style={{ position: "absolute", bottom: 12, left: "50%", transform: "translateX(-50%)", display: "flex", gap: 10, zIndex: 11 }}>
        <button onClick={clear} aria-label="Clear circle selection" style={{ padding: "8px 18px", background: "rgba(0,0,0,.7)", border: "1px solid rgba(255,255,255,.2)", borderRadius: 100, color: "#fff", fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: "var(--font-sans)", minHeight: 44, minWidth: 44 }}>Clear</button>
        {confirmed && <button onClick={onCancel} aria-label="Confirm circle selection" style={{ padding: "8px 18px", background: "rgba(201,169,110,.9)", border: "none", borderRadius: 100, color: "#0C0C0E", fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: "var(--font-sans)", minHeight: 44, minWidth: 44 }}>Done</button>}
      </div>
    </div>
  );
};

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
  const [sizePrefs, setSizePrefs] = useState({ body_type: [], fit: [], sizes: {} });

  // ─── User status (from backend) ───────────────────────────
  const [userStatus, setUserStatus] = useState(null); // { tier, scans_remaining_today, saved_count, show_ads, ... }

  // ─── App state ────────────────────────────────────────────
  const [screen, setScreen] = useState("onboarding");
  const [obIdx, setObIdx] = useState(0);
  const [prefs, setPrefs] = useState({});
  const [selPlan, setSelPlan] = useState("yearly");
  const [tab, setTab] = useState("home");
  const [img, setImg] = useState(null);
  const [results, setResults] = useState(null);
  const [scanId, setScanId] = useState(null);
  const [phase, setPhase] = useState("idle");
  const [error, setError] = useState(null);
  const [selIdx, setSelIdx] = useState(null);
  const [pickedItems, setPickedItems] = useState(new Set()); // indices of items user chose to search
  const [history, setHistory] = useState([]);
  const [saved, setSaved] = useState([]);
  const [fade, setFade] = useState("fi");
  const [historyFilter, setHistoryFilter] = useState("all"); // "all" | "saved"
  const [confirmDeleteId, setConfirmDeleteId] = useState(null); // scan id awaiting inline delete confirm
  const [upgradeModal, setUpgradeModal] = useState(null); // null | trigger string
  const [upgradeLoading, setUpgradeLoading] = useState(false);
  const [upgradeSuccess, setUpgradeSuccess] = useState(false);
  const [trialStarting, setTrialStarting] = useState(false);
  const [trialSuccess, setTrialSuccess] = useState(false);
  const [showInterstitial, setShowInterstitial] = useState(false);

  // ─── Circle to Search ─────────────────────────────────────
  const [circleSearchActive, setCircleSearchActive] = useState(false);
  const [priorityRegionBase64, setPriorityRegionBase64] = useState(null);
  const [circleConfirmed, setCircleConfirmed] = useState(false);
  const imageDisplayRef = useRef(null);

  // ─── Referral ─────────────────────────────────────────────
  const [referralCode, setReferralCode] = useState(null);
  const [referralCopied, setReferralCopied] = useState(false);

  const fileRef = useRef(null);
  // Camera refs/state removed — native file picker only
  const [showScanSheet, setShowScanSheet] = useState(false); // bottom sheet for scan options

  // ─── Per-item overrides (reset each new scan) ─────────────
  const [itemOverrides, setItemOverrides] = useState({}); // { [itemIdx]: { budget, sizePrefs } }
  const [itemSettingsIdx, setItemSettingsIdx] = useState(null); // which item's popup is open

  // ─── Complete the Look ────────────────────────────────────
  const [pairings, setPairings] = useState(null);   // null | []
  const [pairingsLoading, setPairingsLoading] = useState(false);

  // ─── As Seen On ───────────────────────────────────────────
  const [seenOnData, setSeenOnData] = useState({});     // { [itemIdx]: {appearances,loading,open} }

  // ─── Get It Today (nearby stores) ────────────────────────
  const [nearbyData, setNearbyData] = useState({});     // { [itemIdx]: {stores,loading,open} }

  // ─── Outfit rating ────────────────────────────────────────
  const [scanRatings, setScanRatings] = useState({});  // { [scanId]: 1-5 }

  // ─── Outfit verdict ─────────────────────────────────────
  const [scanVerdicts, setScanVerdicts] = useState({}); // { [scanId]: "would_wear"|"on_the_fence"|"not_for_me" }
  const [verdictAnimating, setVerdictAnimating] = useState(null); // "would_wear"|"on_the_fence"|"not_for_me"|null

  // ─── Public scan view (deep link /scan/:id) ────────────────
  const [publicScanView, setPublicScanView] = useState(null); // { scanId, data, loading, error }

  // ─── Share card generation ──────────────────────────────────
  const [shareCardLoading, setShareCardLoading] = useState(false);
  const [shareLinkCopied, setShareLinkCopied] = useState(false);

  // ─── Post-first-scan preference sheet ──────────────────────
  const [showPrefSheet, setShowPrefSheet] = useState(false);
  const [prefSheetBudgetMin, setPrefSheetBudgetMin] = useState(50);
  const [prefSheetBudgetMax, setPrefSheetBudgetMax] = useState(150);
  const [prefSheetFit, setPrefSheetFit] = useState([]);

  // ─── Style fingerprint card ────────────────────────────────
  const [showStyleFingerprint, setShowStyleFingerprint] = useState(false);

  // ─── Style DNA ────────────────────────────────────────────
  const [styleDna, setStyleDna] = useState(null);
  const [styleDnaLoading, setStyleDnaLoading] = useState(false);
  const [showStyleDna, setShowStyleDna] = useState(false);
  const [styleDnaShareLoading, setStyleDnaShareLoading] = useState(false);

  // ─── Price Drop Alerts ────────────────────────────────────
  const [priceAlertCount, setPriceAlertCount] = useState(0);
  const [priceAlerts, setPriceAlerts] = useState([]);
  const [showPriceAlerts, setShowPriceAlerts] = useState(false);

  // ─── Wishlists ────────────────────────────────────────────
  const [wishlists, setWishlists] = useState([]);       // [{ id, name, created_at }]
  const [activeWishlist, setActiveWishlist] = useState(null); // { id, name } | null
  const [wishlistInput, setWishlistInput] = useState("");
  const [wishlistCreating, setWishlistCreating] = useState(false);
  const [addToListOpenId, setAddToListOpenId] = useState(null); // saved item id with open dropdown
  const [addToListConfirm, setAddToListConfirm] = useState(null); // { savedItemId, wishlistName }

  // ─── Likes / Collections tab ──────────────────────────────
  const [likesCollectionFilter, setLikesCollectionFilter] = useState("all");
  const [likesLongPressItem, setLikesLongPressItem] = useState(null); // { savedItem } for collection sheet
  const [likesCollectionInput, setLikesCollectionInput] = useState("");
  const [likesCollectionCreating, setLikesCollectionCreating] = useState(false);
  const [likesCategoryFilter, setLikesCategoryFilter] = useState("all"); // category chip filter
  const [savedSearchQuery, setSavedSearchQuery] = useState(""); // search within saved items
  const [likesBudgetExpanded, setLikesBudgetExpanded] = useState(false); // budget tracker toggle

  // ─── Profile redesign ──────────────────────────────────────
  const [profileSettingsOpen, setProfileSettingsOpen] = useState(false);
  const [profileScanOverlay, setProfileScanOverlay] = useState(null); // scan object for overlay
  const [historyDetailScan, setHistoryDetailScan] = useState(null); // history item detail overlay

  // ─── Interest Picker (style inspirations) ─────────────────
  const [showInterestPicker, setShowInterestPicker] = useState(false);
  const [selectedInterests, setSelectedInterests] = useState([]);

  // ─── Custom occasion ──────────────────────────────────────
  const [customOccasionInput, setCustomOccasionInput] = useState("");
  const [showCustomOccasion, setShowCustomOccasion] = useState(false);
  const [recentOccasions, setRecentOccasions] = useState(() => {
    try { return JSON.parse(localStorage.getItem("attair_recent_occasions") || "[]"); } catch { return []; }
  });

  // ─── Occasion filter ──────────────────────────────────────
  const [occasion, setOccasion] = useState(null);       // null | "casual"|"work"|"night_out"|"athletic"|"formal"|"outdoor"

  // ─── Search notes ─────────────────────────────────────────
  const [searchNotes, setSearchNotes] = useState("");

  // ─── Scan streak ──────────────────────────────────────────
  const [scanStreak, setScanStreak] = useState(0);

  // ─── Identification preview ───────────────────────────────
  const [identPreview, setIdentPreview] = useState(null); // array of identified items | null

  // ─── Re-search indicator ──────────────────────────────────
  const [isResearch, setIsResearch] = useState(false); // true when re-running a search (not first run)

  // ─── Advanced section toggle (results screen) ─────────────
  const [showAdvanced, setShowAdvanced] = useState(false);

  // ─── Expanded items in results ────────────────────────────
  const [expandedItems, setExpandedItems] = useState(new Set()); // which item indices are expanded

  // ─── Social profile ───────────────────────────────────────
  const [profileBio, setProfileBio] = useState("");
  const [profileBioEditing, setProfileBioEditing] = useState(false);
  const [profileBioSaving, setProfileBioSaving] = useState(false);
  const [profileStats, setProfileStats] = useState({ followers_count: 0, following_count: 0 }); // { followers_count, following_count }
  const [scanVisibilityMap, setScanVisibilityMap] = useState({}); // { [scanId]: "public"|"private"|"followers" }

  // ─── Social Feed ───────────────────────────────────────────
  const [feedTab, setFeedTab] = useState("foryou"); // "foryou" | "following"
  const [feedScans, setFeedScans] = useState([]);
  const [feedPage, setFeedPage] = useState(1);
  const [feedLoading, setFeedLoading] = useState(false);
  const [feedHasMore, setFeedHasMore] = useState(false);
  const [feedDetailScan, setFeedDetailScan] = useState(null); // scan object for overlay
  const [showUserSearch, setShowUserSearch] = useState(false);
  const [userSearchQuery, setUserSearchQuery] = useState("");
  const [userSearchResults, setUserSearchResults] = useState([]);
  const [userSearchLoading, setUserSearchLoading] = useState(false);
  const [followingSet, setFollowingSet] = useState(new Set()); // user ids we follow
  const userSearchTimerRef = useRef(null);
  const [searchSubTab, setSearchSubTab] = useState("people"); // "people" | "products"
  const [productSearchQuery, setProductSearchQuery] = useState("");
  const [productSearchResults, setProductSearchResults] = useState([]);

  // ─── Theme (dark / light) ─────────────────────────────────
  const [theme, setTheme] = useState(() => localStorage.getItem("attair_theme") || "dark");
  const toggleTheme = () => setTheme(t => { const n = t === "dark" ? "light" : "dark"; localStorage.setItem("attair_theme", n); return n; });

  // ─── Language (i18n) ──────────────────────────────────────
  const [lang, setLang] = useState(() => localStorage.getItem("attair_lang") || "en");
  const t = (key) => STRINGS[lang]?.[key] ?? STRINGS.en[key] ?? key;
  const LANG_OPTIONS = [
    { code: "en", label: "English" },
    { code: "es", label: "Español" },
    { code: "fr", label: "Français" },
    { code: "de", label: "Deutsch" },
    { code: "zh", label: "中文" },
    { code: "ja", label: "日本語" },
    { code: "ko", label: "한국어" },
    { code: "pt", label: "Português" },
  ];

  // ─── Loading message rotation ─────────────────────────────
  const [loadMsgIdx, setLoadMsgIdx] = useState(0);
  const [loadMsgVisible, setLoadMsgVisible] = useState(true);
  useEffect(() => {
    const isLoading = phase === "identifying" || phase === "searching";
    if (!isLoading) { setLoadMsgIdx(0); setLoadMsgVisible(true); return; }
    const msgs = phase === "identifying" ? SCAN_MESSAGES : (isResearch ? RESEARCH_MESSAGES : SEARCH_MESSAGES);
    const interval = setInterval(() => {
      setLoadMsgVisible(false);
      setTimeout(() => { setLoadMsgIdx(i => (i + 1) % msgs.length); setLoadMsgVisible(true); }, 350);
    }, 2800);
    return () => clearInterval(interval);
  }, [phase, isResearch]);

  // ─── AI refinement (ID/Shop toggle + chat per item) ───────
  const [itemViewModes, setItemViewModes] = useState({}); // { [idx]: "id" | "shop" }
  const [itemChats, setItemChats] = useState({});          // { [idx]: [{role, content}] }
  const [refineInputs, setRefineInputs] = useState({});    // { [idx]: string }
  const [refineLoadings, setRefineLoadings] = useState({}); // { [idx]: bool }

  // ─── Crop ─────────────────────────────────────────────────
  const [cropPending, setCropPending] = useState(null); // { src, base64, mime, source }
  const [cropMode, setCropMode] = useState(false); // true = editing handles shown

  // Auto-activate circle to search when image is ready
  useEffect(() => {
    if (cropPending && !cropMode) {
      setCircleSearchActive(true);
    } else if (!cropPending) {
      setCircleSearchActive(false);
    }
  }, [cropPending, cropMode]);
  const [crop, setCrop] = useState();
  const [completedCrop, setCompletedCrop] = useState();
  const cropImgRef = useRef(null);
  const cropRestoredRef = useRef(false); // true when re-entering crop with a saved position

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
      const token = Auth.getToken();
      if (token) {
        const jwt = decodeJwt(token);
        if (jwt?.email) setAuthEmail(jwt.email);
      }
      refreshStatus();
      authFetch(`${API_BASE}/api/user/profile`)
        .then(r => r.json())
        .then(profile => {
          if (profile.display_name) setAuthName(profile.display_name);
          if (profile.gender_pref) setPrefs(p => ({ ...p, gender: profile.gender_pref }));
          if (profile.budget_min != null) setBudgetMin(profile.budget_min);
          if (profile.budget_max != null) setBudgetMax(profile.budget_max);
          if (profile.size_prefs) setSizePrefs(profile.size_prefs);
          if (profile.referral_code) setReferralCode(profile.referral_code);
          if (profile.bio) setProfileBio(profile.bio);
          if (profile.style_interests) setSelectedInterests(profile.style_interests);
          if (profile.followers_count != null || profile.following_count != null) {
            setProfileStats({ followers_count: profile.followers_count || 0, following_count: profile.following_count || 0 });
          }
        })
        .catch(() => {});
      API.getHistory().then(d => {
        const scans = d.scans || [];
        setHistory(scans);
        // Calculate streak: consecutive days with at least 1 scan, from most recent day back
        if (scans.length > 0) {
          const daySet = new Set(scans.map(s => new Date(s.created_at).toDateString()));
          let streak = 0;
          const today = new Date();
          for (let i = 0; i < 365; i++) {
            const d = new Date(today);
            d.setDate(today.getDate() - i);
            if (daySet.has(d.toDateString())) {
              streak++;
            } else if (i > 0) {
              break; // gap found
            }
            // if i===0 and no scan today, continue checking yesterday
            else {
              // no scan today yet — check if yesterday starts the streak
            }
          }
          setScanStreak(streak);
        }
      }).catch(() => {});
      API.getSaved().then(d => setSaved(d.items || [])).catch(() => {});
      API.getWishlists().then(d => setWishlists(d.wishlists || [])).catch(() => {});
      API.getStreak().then(s => { if (s?.streak > 0) setScanStreak(s.streak); }).catch(() => {});
      API.priceAlertCount().then(d => setPriceAlertCount(d.unseen_count || 0)).catch(() => {});
      if (!styleDna && !styleDnaLoading) {
        setStyleDnaLoading(true);
        API.styleDna().then(data => setStyleDna(data)).catch(() => {}).finally(() => setStyleDnaLoading(false));
      }
      if (screen === "onboarding") setScreen("app");

      // Handle post-Stripe-checkout redirect
      const params = new URLSearchParams(window.location.search);
      if (params.has("session_id") || params.has("upgrade-success")) {
        setTimeout(async () => {
          try {
            const status = await API.getUserStatus();
            setUserStatus(status);
            setUpgradeSuccess(true);
            setTimeout(() => setUpgradeSuccess(false), 5000);
          } catch {}
          window.history.replaceState({}, "", window.location.pathname);
        }, 1500);
      }
    }
  }, [authed]);

  // ─── Interest picker — show once after first login ─────────
  useEffect(() => {
    if (authed && screen === "app") {
      const picked = localStorage.getItem("attair_interests_picked");
      if (!picked) {
        setTimeout(() => setShowInterestPicker(true), 1500);
      }
    }
  }, [authed, screen]);

  // ─── Feed loader ─────────────────────────────────────────────
  const loadFeed = useCallback(async (page = 1, append = false) => {
    if (feedLoading) return;
    setFeedLoading(true);
    try {
      const data = await API.getFeed(page, feedTab);
      const scans = data.scans || [];
      setFeedScans(prev => append ? [...prev, ...scans] : scans);
      setFeedHasMore(data.has_more || false);
      setFeedPage(page);
    } catch (err) {
      console.error("[ATTAIR] Feed load error:", err);
    } finally {
      setFeedLoading(false);
    }
  }, [feedLoading]);

  useEffect(() => {
    if (authed && screen === "app" && (tab === "home" || (tab === "scan" && phase === "idle" && !img))) {
      loadFeed(1, false);
    }
  }, [authed, screen, tab, feedTab]);

  // ─── User search (debounced) ──────────────────────────────
  useEffect(() => {
    if (!showUserSearch) return;
    if (userSearchTimerRef.current) clearTimeout(userSearchTimerRef.current);
    if (!userSearchQuery.trim()) { setUserSearchResults([]); return; }
    setUserSearchLoading(true);
    userSearchTimerRef.current = setTimeout(async () => {
      try {
        const data = await API.searchUsers(userSearchQuery.trim());
        setUserSearchResults(data.users || []);
      } catch { setUserSearchResults([]); }
      finally { setUserSearchLoading(false); }
    }, 300);
    return () => { if (userSearchTimerRef.current) clearTimeout(userSearchTimerRef.current); };
  }, [userSearchQuery, showUserSearch]);

  const handleFollowFromSearch = async (userId) => {
    try {
      if (followingSet.has(userId)) {
        await API.unfollowUser(userId);
        setFollowingSet(prev => { const n = new Set(prev); n.delete(userId); return n; });
      } else {
        await API.followUser(userId);
        setFollowingSet(prev => new Set(prev).add(userId));
      }
    } catch (err) { console.error("Follow error:", err); }
  };

  // ─── Upgrade / Trial handlers ──────────────────────────────
  const handleUpgrade = async (plan = "yearly") => {
    setUpgradeLoading(true);
    try {
      const result = await API.createCheckoutSession(plan);
      if (result.url) {
        window.location.href = result.url;
      }
    } catch (err) {
      console.error("Checkout error:", err);
      alert("Could not start checkout. Please try again.");
    } finally {
      setUpgradeLoading(false);
      setUpgradeModal(null);
    }
  };

  const handleStartTrial = async () => {
    setTrialStarting(true);
    try {
      await API.startTrial();
      const status = await API.getUserStatus();
      setUserStatus(status);
      setUpgradeModal(null);
      setTrialSuccess(true);
      setTimeout(() => setTrialSuccess(false), 4000);
    } catch (err) {
      const userMessage = err.message === "Failed to fetch"
        ? "Couldn't connect. Check your connection and try again."
        : err.message;
      setError("Could not start trial. " + userMessage);
    } finally {
      setTrialStarting(false);
    }
  };

  // ─── Helpers ──────────────────────────────────────────────
  const trans = (fn) => { setFade("fo"); setTimeout(() => { fn(); setFade("fi"); }, 220); };
  const obNext = () => {
    if (obIdx < OB_STEPS.length - 1) trans(() => setObIdx(i => i + 1));
    else trans(() => setScreen("paywall"));
  };
  const isFree = !userStatus || userStatus.tier === "free" || userStatus.tier === "expired";
  const isPro = userStatus?.tier === "pro" || userStatus?.tier === "trial";
  const scansLeft = userStatus?.scans_remaining_today ?? 12;
  const scansLimit = userStatus?.scans_limit ?? 12;
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
        const jwt = decodeJwt(access);
        if (jwt?.email) setAuthEmail(jwt.email);
        setAuthed(true);
        setScreen("app");
        window.history.replaceState(null, "", window.location.pathname);
      }
    }
  }, []);

  // ─── Public scan deep link — /scan/:scanId ──────────────────
  useEffect(() => {
    const match = window.location.pathname.match(/^\/scan\/([a-zA-Z0-9\-]+)$/);
    if (match) {
      const deepScanId = match[1];
      setPublicScanView({ scanId: deepScanId, data: null, loading: true, error: null });
      API.getPublicScan(deepScanId).then(data => {
        if (data.error) {
          setPublicScanView(prev => prev ? { ...prev, loading: false, error: data.error } : null);
        } else {
          setPublicScanView(prev => prev ? { ...prev, loading: false, data } : null);
        }
      }).catch(err => {
        setPublicScanView(prev => prev ? { ...prev, loading: false, error: err.message || "Failed to load scan" } : null);
      });
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
          size_prefs: prefs.size_prefs || sizePrefs,
        });
        track("signup", { method: "email" }, null, "auth");
      } else {
        await API.login(authEmail, authPass);
        track("login", { method: "email" }, null, "auth");
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
      // If the user came from the paywall with a plan selected, trigger checkout now
      const pendingPlan = sessionStorage.getItem("attair_pending_plan");
      if (pendingPlan) {
        sessionStorage.removeItem("attair_pending_plan");
        handleUpgrade(pendingPlan);
      }
    } catch (err) {
      const userMessage = err.message === "Failed to fetch"
        ? "Couldn't connect. Check your connection and try again."
        : err.message;
      setAuthErr(userMessage);
    }
    setAuthLoading(false);
  };

  // Camera functions removed — native file picker only (via fileRef)

  // File upload
  const handleFile = useCallback((file) => {
    if (!file) return;
    const validExts = [".jpg",".jpeg",".png",".gif",".webp",".heic",".heif",".bmp",".tiff"];
    const ext = (file.name || "").toLowerCase().slice(file.name.lastIndexOf("."));
    const isImage = (file.type || "").startsWith("image/") || validExts.includes(ext) || !file.type;
    if (!isImage) { setError("Please upload an image file."); return; }
    track("photo_uploaded", {}, null, "scan");
    setError(null);
    const tryBlob = () => {
      try {
        const url = URL.createObjectURL(file);
        const im = new Image();
        im.onload = async () => { const r = await resizeImage(url); URL.revokeObjectURL(url); openCrop(r); };
        im.onerror = () => { URL.revokeObjectURL(url); tryReader(); };
        im.src = url;
      } catch { tryReader(); }
    };
    const tryReader = () => {
      const rd = new FileReader();
      rd.onload = async (e) => {
        try { const r = await resizeImage(e.target.result); openCrop(r); }
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

  // ─── Crop helpers ─────────────────────────────────────────
  const openCrop = (r, source = "file") => {
    setCropPending({ src: r.dataUrl, base64: r.base64, mime: r.mime, source,
                     originalSrc: r.dataUrl, originalBase64: r.base64, lastCrop: null });
    setCropMode(false);
    setCrop(undefined);
    setCompletedCrop(undefined);
  };

  const retakeCrop = () => {
    const source = cropPending?.source;
    setCropPending(null);
    setCropMode(false);
    // Always open native file picker for retake (camera code removed)
    fileRef.current?.click();
  };

  const onCropImageLoad = (e) => {
    if (cropRestoredRef.current) {
      cropRestoredRef.current = false; // restored crop box already set — don't override
      return;
    }
    const { width, height } = e.currentTarget;
    const w = width * 0.85;
    const h = height * 0.85;
    const c = { unit: "px", x: (width - w) / 2, y: (height - h) / 2, width: w, height: h };
    setCrop(c);
    setCompletedCrop(c);
  };

  const getCroppedImg = (img, c) => {
    const sx = img.naturalWidth / img.width;
    const sy = img.naturalHeight / img.height;
    const canvas = document.createElement("canvas");
    canvas.width = Math.floor(c.width * sx);
    canvas.height = Math.floor(c.height * sy);
    canvas.getContext("2d").drawImage(img, c.x * sx, c.y * sy, c.width * sx, c.height * sy, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", 0.92);
  };

  const applyCrop = () => {
    if (!cropPending) return;
    if (completedCrop?.width && completedCrop?.height && cropImgRef.current) {
      const dataUrl = getCroppedImg(cropImgRef.current, completedCrop);
      const base64 = dataUrl.split(",")[1];
      // Update preview with cropped version; preserve originals and save crop position
      setCropPending(prev => ({ ...prev, src: dataUrl, base64, lastCrop: completedCrop }));
      setCropMode(false);
    } else {
      setCropMode(false);
    }
  };

  const skipCrop = () => {
    if (!cropPending) return;
    const { src, base64, mime } = cropPending;
    setCropPending(null);
    setImg(src);
    runScan(base64, mime);
  };

  // ═══════════════════════════════════════════════════════════
  // SCAN ENGINE — Phase 1: Identify, then user picks items
  // ═══════════════════════════════════════════════════════════
  const runScan = async (base64, mime) => {
    if (!canScan()) return;

    setPhase("identifying"); setResults(null); setSelIdx(null); setError(null); setScanId(null); setPickedItems(new Set());
    track("scan_started", {}, null, "scan");

    // Phase 1: Identify (backend handles Claude + dedup + rate limit + image storage)
    try {
      const raw = await API.identifyClothing(base64, mime, prefs, priorityRegionBase64);
      // Sort priority items first
      if (raw.items) {
        raw.items = [...raw.items].sort((a, b) => (b.priority ? 1 : 0) - (a.priority ? 1 : 0));
      }
      setPriorityRegionBase64(null);
      setCircleSearchActive(false);
      let items = (raw.items || []).map(item => ({ ...item, status: "identified", tiers: null }));
      const identified = { gender: raw.gender || "male", summary: raw.summary || "", items, scanId: raw.scan_id, imageUrl: raw.image_url };
      setScanId(raw.scan_id);
      setResults(identified);
      setItemOverrides({});
      setItemSettingsIdx(null);
      setIdentPreview(items);
      setPhase("picking"); // Stop here — let user choose which items to search
      track("scan_completed", { item_count: items.length, gender: raw.gender }, raw.scan_id, "scan");

      // Update status (scan count changed) — optimistic local update + server confirm
      setUserStatus(prev => prev ? { ...prev, scans_remaining_today: Math.max(0, (prev.scans_remaining_today ?? 12) - 1) } : prev);
      refreshStatus();

      // Show interstitial ad for free users (skip on first-ever scan — don't be hostile)
      if (showAds && scansLeft < 2) {
        setShowInterstitial(true);
      }
      if (showAds && scansLeft <= 1) {
        setTimeout(() => setUpgradeModal("ad_fatigue"), 800);
      }
    } catch (err) {
      setPhase("idle");
      if (err.message.includes("scan limit") || err.message.includes("12/12") || err.message.includes("3/3")) {
        setUpgradeModal("scan_limit");
        setError("You've used all 12 free scans this month.");
      } else if (err.message.includes("Session expired")) {
        setError("Your session expired. Please log in again.");
        setAuthed(false);
        setScreen("auth");
      } else if (err.message.includes("fetch") || err.message.includes("network") || err.message.includes("Failed")) {
        setError("Couldn't connect to the server. Check your internet connection and try again.");
      } else {
        console.error("[ATTAIR] Identify error:", err.message);
        setError("Something went wrong analyzing the photo. Please try again.");
      }
    }
  };

  // ═══════════════════════════════════════════════════════════
  // SCAN ENGINE — Phase 2: Search products for picked items only
  // ═══════════════════════════════════════════════════════════
  const runProductSearch = async () => {
    if (!results || pickedItems.size === 0) return;

    const picked = [...pickedItems].sort((a, b) => a - b).map(i => ({
      ...results.items[i],
      _scan_item_index: i,
      _budget_min: itemOverrides[i]?.budgetMin ?? null,
      _budget_max: itemOverrides[i]?.budgetMax ?? null,
      _size_prefs: itemOverrides[i]?.sizePrefs ?? null,
      _market_pref: itemOverrides[i]?.marketPref ?? "both",
    }));
    const pickedIndices = [...pickedItems].sort((a, b) => a - b);

    // Detect re-search: phase was "done" meaning we already had results once
    const wasAlreadySearched = phase === "done";
    setIsResearch(wasAlreadySearched);
    setPhase("searching");
    setResults(prev => prev ? {
      ...prev,
      items: prev.items.map((it, i) => pickedItems.has(i) ? { ...it, status: "searching" } : it)
    } : prev);
    setSelIdx(pickedIndices[0]); // Auto-select first picked item

    try {
      const searchResults = await API.findProducts(picked, results.gender, scanId, occasion, searchNotes || null);
      setResults(prev => {
        if (!prev) return prev;
        const updated = prev.items.map((item, idx) => {
          if (!pickedItems.has(idx)) return item; // Skip unpicked items
          const sr = Array.isArray(searchResults) ? searchResults.find(s => s.item_index === idx) : null;
          if (!sr || !sr.tiers) return { ...item, status: "failed" };
          return { ...item, status: "verified", brand_verified: sr.brand_verified || false, tiers: sr.tiers };
        });
        return { ...prev, items: updated };
      });
    } catch (err) {
      console.error("Product search failed:", err);
      setResults(prev => prev ? { ...prev, items: prev.items.map(it => it.status === "searching" ? { ...it, status: "failed" } : it) } : prev);
      setError(t("search_failed") || "Search failed. Please try refining your items and searching again.");
    }
    setPhase("done");
    setIsResearch(false);
    // Auto-expand first picked item in results
    setExpandedItems(new Set([pickedIndices[0]]));
    // Auto-switch picked items to "shop" view once search completes
    setItemViewModes(prev => {
      const next = { ...prev };
      [...pickedItems].forEach(idx => { next[idx] = "shop"; });
      return next;
    });

    // Post-first-scan preference sheet — show once after the user's very first scan
    if (!localStorage.getItem("attair_pref_sheet_shown")) {
      setTimeout(() => {
        setShowPrefSheet(true);
        localStorage.setItem("attair_pref_sheet_shown", "1");
      }, 1200);
    }

    // Refresh history + saved so those tabs are up to date
    API.getHistory().then(d => setHistory(d.scans || [])).catch(() => {});
    API.getSaved().then(d => setSaved(d.items || [])).catch(() => {});
  };

  const reset = () => { setImg(null); setResults(null); setSelIdx(null); setPickedItems(new Set()); setError(null); setPhase("idle"); setScanId(null); setItemOverrides({}); setItemSettingsIdx(null); setItemViewModes({}); setItemChats({}); setRefineInputs({}); setRefineLoadings({}); setPairings(null); setPairingsLoading(false); setSeenOnData({}); setNearbyData({}); setOccasion(null); setSearchNotes(""); setIdentPreview(null); setCircleSearchActive(false); setPriorityRegionBase64(null); setCircleConfirmed(false); setIsResearch(false); setShowAdvanced(false); setExpandedItems(new Set()); };

  // ─── AI item refinement ────────────────────────────────────
  const handleRefine = async (itemIdx) => {
    const msg = (refineInputs[itemIdx] || "").trim();
    if (!msg || refineLoadings[itemIdx]) return;
    const item = results.items[itemIdx];
    const chat = itemChats[itemIdx] || [];
    setRefineLoadings(l => ({ ...l, [itemIdx]: true }));
    setRefineInputs(i => ({ ...i, [itemIdx]: "" }));
    try {
      const res = await API.refineItem(scanId, itemIdx, item, msg, chat, results.gender);
      const newChat = [...chat, { role: "user", content: msg }, { role: "assistant", content: res.ai_message || "Updated." }];
      setItemChats(c => ({ ...c, [itemIdx]: newChat }));
      // Merge updated_item fields, preserving status/tiers
      setResults(prev => {
        if (!prev) return prev;
        const items = prev.items.map((it, i) => i === itemIdx ? { ...it, ...res.updated_item, status: it.status, tiers: res.new_tiers || it.tiers } : it);
        return { ...prev, items };
      });
      // Auto-switch to shop if new tiers came back
      if (res.new_tiers) setItemViewModes(m => ({ ...m, [itemIdx]: "shop" }));
      track("item_refined", { item_index: itemIdx }, scanId, "scan");
    } catch (err) {
      setItemChats(c => ({ ...c, [itemIdx]: [...(c[itemIdx] || []), { role: "user", content: msg }, { role: "assistant", content: "Sorry, I couldn't process that. Try rephrasing." }] }));
    }
    setRefineLoadings(l => ({ ...l, [itemIdx]: false }));
  };

  // ─── Save with backend persistence ────────────────────────
  const toggleSave = async (item) => {
    const existing = saved.find(i => (i.item_data || i).name === item.name);
    if (existing) {
      await API.deleteSaved(existing.id).catch(() => {});
      setSaved(s => s.filter(i => i.id !== existing.id));
      refreshStatus();
      track("item_unsaved", { item_name: item.name }, scanId, "scan");
    } else {
      // Check save limit for free users
      if (isFree && (userStatus?.saved_count || 0) >= (userStatus?.saved_limit || 20)) {
        setUpgradeModal("save_limit");
        track("upgrade_modal_shown", { trigger: "save_limit" }, scanId, "scan");
        return;
      }
      try {
        const res = await API.saveItem(scanId, item);
        setSaved(s => [...s, { id: res.id, item_data: item, created_at: new Date().toISOString() }]);
        refreshStatus();
        track("item_saved", { item_name: item.name }, scanId, "scan");
      } catch (err) {
        if (err.message.includes("limit")) setUpgradeModal("save_limit");
      }
    }
  };
  const isSaved = (item) => saved.some(i => (i.item_data || i).name === item.name);

  // ─── One-tap heart save from product cards ─────────────────
  const quickSaveItem = async (item, scanIdOverride) => {
    const sid = scanIdOverride || scanId;
    const existing = saved.find(i => (i.item_data || i).name === item.name);
    if (existing) {
      await API.deleteSaved(existing.id).catch(() => {});
      setSaved(s => s.filter(i => i.id !== existing.id));
      refreshStatus();
    } else {
      if (isFree && (userStatus?.saved_count || 0) >= (userStatus?.saved_limit || 20)) {
        setUpgradeModal("save_limit");
        return;
      }
      try {
        const res = await API.saveItem(sid, item);
        setSaved(s => [...s, { id: res.id, item_data: item, scan_id: sid, created_at: new Date().toISOString() }]);
        refreshStatus();
        track("item_saved", { item_name: item.name }, sid, "scan");
      } catch (err) {
        if (err.message?.includes("limit")) setUpgradeModal("save_limit");
      }
    }
  };

  const brandConfLabel = (c) => ({ confirmed: { t: "Confirmed", c: "#C9A96E" }, high: { t: "High confidence", c: "rgba(201,169,110,0.7)" }, moderate: { t: "Moderate", c: "rgba(255,255,255,0.4)" }, low: { t: "Estimated", c: "rgba(255,255,255,0.25)" } }[c] || { t: "Unknown", c: "rgba(255,255,255,0.2)" });

  const handleLogout = () => { trackBeacon("logout", {}); Auth.clear(); setAuthed(false); setAuthEmail(""); setAuthName(""); setUserStatus(null); setScreen("onboarding"); setObIdx(0); };

  const step = OB_STEPS[obIdx];
  const prog = ((obIdx + 1) / OB_STEPS.length) * 100;

  return (<>
    {/* Styles moved to App.css — imported at top of file */}
    {/* REMOVED: ~690 lines of inline <style> */}

    <div className="app" data-theme={theme}>
      {/* ─── ONBOARDING ──────────────────────────────────── */}
      {screen === "onboarding" && (
        <div className={`ob ${fade}`}>
          <div className="ob-bar"><div className="ob-fill" style={{ width: `${prog}%` }} /></div>
          <div className="ob-body">
            {step.icon && <div className="ob-icon">{step.icon}</div>}
            <h1 className="ob-title">{step.title}</h1>
            <p className="ob-sub">{step.sub}</p>
            {step.stats && <div className="ob-stats">{step.stats.map((s,i) => <div key={i}><div className="ob-sn">{s.n}</div><div className="ob-sl">{s.l}</div></div>)}</div>}
            {step.type === "first_scan" && (
              <div style={{ display: "flex", flexDirection: "column", gap: 16, alignItems: "center" }}>
                <div style={{ width: 120, height: 120, borderRadius: "50%", border: "1.5px dashed rgba(201,169,110,.4)", display: "flex", alignItems: "center", justifyContent: "center", marginBottom: 8 }}>
                  <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#C9A96E" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="6" width="20" height="14" rx="3"/><circle cx="12" cy="13" r="4"/><path d="M8 6l1.5-3h5L16 6"/></svg>
                </div>
                <button className="cta" style={{ width: "100%" }} onClick={() => { trans(() => { setScreen("auth"); setAuthScreen("signup"); }); }}>
                  Create Account to Start Scanning
                </button>
                <button className="ob-skip" onClick={() => { trans(() => { setScreen("auth"); setAuthScreen("signup"); }); }}>Skip for now</button>
              </div>
            )}
            {step.type === "info" && <button className="cta" onClick={() => obNext()}>{step.cta}</button>}
            {obIdx === 0 && <button style={{background:"none",border:"none",color:"var(--text-tertiary)",fontSize:13,cursor:"pointer",fontFamily:"var(--font-sans)",padding:"12px 0",marginTop:8,minHeight:44}} onClick={() => { setScreen("auth"); setAuthScreen("login"); }}>Already have an account? Log in</button>}
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
            <div className={`pw-p ${selPlan==="yearly"?"sel":""}`} onClick={() => setSelPlan("yearly")}><div className="pw-ptag">BEST VALUE</div><div className="pw-pp">$30<span className="pw-pd"> /year</span></div><div className="pw-pw">$0.58/week</div></div>
            <div className={`pw-p ${selPlan==="monthly"?"sel":""}`} onClick={() => setSelPlan("monthly")}><div className="pw-pp">$5<span className="pw-pd"> /mo</span></div><div className="pw-pw">$1.15/week</div></div>
          </div>
          <button className="cta" onClick={() => {
            if (authed) {
              handleUpgrade(selPlan);
            } else {
              // Store intent so auth flow can trigger checkout after signup
              sessionStorage.setItem("attair_pending_plan", selPlan);
              trans(() => setScreen("auth"));
            }
          }}>
            {authed ? (upgradeLoading ? "Loading…" : `Start Pro — ${selPlan === "yearly" ? "$30/yr" : "$5/mo"}`) : "Get started"}
          </button>
          <div className="pw-terms">12 free scans per month. Upgrade anytime.</div>
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
          <button onClick={() => API.oauthLogin("google")} style={{ width: "100%", padding: "14px 18px", background: "var(--bg-card)", border: "1px solid var(--border)", borderRadius: 12, color: "var(--text-primary)", fontFamily: "var(--font-sans)", fontSize: 14, fontWeight: 600, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 10, marginBottom: 8, transition: "all .2s" }}>
            <svg width="18" height="18" viewBox="0 0 24 24"><path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 01-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4"/><path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/><path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/><path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/></svg>
            Continue with Google
          </button>
          {import.meta.env.VITE_APPLE_AUTH_ENABLED === "true" && (
            <button onClick={() => API.oauthLogin("apple")} style={{ width: "100%", padding: "14px 18px", background: "var(--bg-card)", border: "1px solid var(--border)", borderRadius: 12, color: "var(--text-primary)", fontFamily: "var(--font-sans)", fontSize: 14, fontWeight: 600, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 10, marginBottom: 8, transition: "all .2s" }}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M17.05 20.28c-.98.95-2.05.88-3.08.4-1.09-.5-2.08-.48-3.24 0-1.44.62-2.2.44-3.06-.4C2.79 15.25 3.51 7.59 9.05 7.31c1.35.07 2.29.74 3.08.8 1.18-.24 2.31-.93 3.57-.84 1.51.12 2.65.72 3.4 1.8-3.12 1.87-2.38 5.98.48 7.13-.57 1.5-1.31 2.99-2.54 4.09zM12.03 7.25c-.15-2.23 1.66-4.07 3.74-4.25.29 2.58-2.34 4.5-3.74 4.25z"/></svg>
              Continue with Apple
            </button>
          )}

          {/* Divider */}
          <div style={{ display: "flex", alignItems: "center", gap: 12, margin: "4px 0 16px" }}>
            <div style={{ flex: 1, height: 1, background: "var(--border)" }} />
            <span style={{ fontSize: 11, color: "var(--text-tertiary)", fontWeight: 500 }}>or</span>
            <div style={{ flex: 1, height: 1, background: "var(--border)" }} />
          </div>

          {authErr && <div className="auth-err">{authErr}</div>}

          {/* Name + phone (signup only) */}
          {authScreen === "signup" && (<>
            <input type="text" placeholder="Full name" value={authName} onChange={e => setAuthName(e.target.value)} autoComplete="name" />
            <input type="tel" placeholder="Phone number (optional)" value={authPhone} onChange={e => setAuthPhone(e.target.value)} autoComplete="tel" />
          </>)}

          <input type="email" placeholder="Email address" value={authEmail} onChange={e => setAuthEmail(e.target.value)} autoComplete="email" />
          <div style={{ position: "relative" }}>
            <input type={showPass ? "text" : "password"} placeholder="Password" value={authPass} onChange={e => setAuthPass(e.target.value)} onKeyDown={e => e.key === "Enter" && authEmail && authPass.length >= 6 && handleAuth()} autoComplete={authScreen === "signup" ? "new-password" : "current-password"} style={{ paddingRight: 48 }} />
            <button onClick={() => setShowPass(p => !p)} style={{ position: "absolute", right: 12, top: "50%", transform: "translateY(-50%)", background: "none", border: "none", color: "var(--text-tertiary)", fontSize: 12, cursor: "pointer", fontFamily: "var(--font-sans)", padding: "8px", minHeight: 44, minWidth: 44 }}>{showPass ? "Hide" : "Show"}</button>
          </div>
          {authScreen === "signup" && authPass.length > 0 && authPass.length < 6 && (
            <div style={{ fontSize: 11, color: "rgba(255,150,100,.5)", marginTop: -4, marginBottom: 4 }}>Password must be at least 6 characters</div>
          )}
          <button className="cta" style={{ marginTop: 8, opacity: (!authEmail || authPass.length < 6) ? 0.4 : 1 }} onClick={handleAuth} disabled={authLoading || !authEmail || authPass.length < 6}>
            {authLoading ? "Loading…" : authScreen === "signup" ? "Create Account" : "Log In"}
          </button>
          <button className="auth-toggle" onClick={() => { setAuthScreen(authScreen === "login" ? "signup" : "login"); setAuthErr(null); setShowPass(false); }}>
            {authScreen === "login" ? "Don't have an account? Sign up" : "Already have an account? Log in"}
          </button>
        </div>
      )}

      {/* ─── CAMERA removed — native file picker only ─── */}

      {/* ─── INTERSTITIAL AD (free users, post-scan) ─────── */}
      {showInterstitial && showAds && (
        <InterstitialAd onClose={() => setShowInterstitial(false)} />
      )}

      {/* ─── UPGRADE MODAL ───────────────────────────────── */}
      {upgradeModal && (
        <UpgradeModal
          trigger={upgradeModal}
          onClose={() => setUpgradeModal(null)}
          onUpgrade={handleUpgrade}
          onStartTrial={handleStartTrial}
          userStatus={userStatus}
        />
      )}

      {/* ─── INTEREST PICKER ─────────────────────────────── */}
      {showInterestPicker && (
        <div className="modal-overlay" onClick={() => { setShowInterestPicker(false); localStorage.setItem("attair_interests_picked", "1"); }}>
          <div className="modal-box" onClick={e => e.stopPropagation()} style={{ maxHeight: "85vh", overflowY: "auto" }}>
            <button className="modal-x" onClick={() => { setShowInterestPicker(false); localStorage.setItem("attair_interests_picked", "1"); }}>✕</button>
            <h2 className="modal-title" style={{ fontSize: 20, marginBottom: 6 }}>{t("who_inspires")}</h2>
            <p className="modal-sub" style={{ marginBottom: 20 }}>Pick up to 5. We'll personalize your results.</p>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 24 }}>
              {[
                { v: "Actors & Actresses", l: "Actors & Actresses", icon: "🎬" },
                { v: "Musicians & K-Pop", l: "Musicians & K-Pop", icon: "🎵" },
                { v: "Athletes", l: "Athletes", icon: "🏀" },
                { v: "TikTok Creators", l: "TikTok Creators", icon: "📱" },
                { v: "Instagram Influencers", l: "Instagram Influencers", icon: "📸" },
                { v: "Streamers & YouTubers", l: "Streamers & YouTubers", icon: "🎮" },
                { v: "Fashion Icons & Models", l: "Fashion Icons & Models", icon: "👗" },
                { v: "Street Style", l: "Street Style", icon: "🌍" },
              ].map(({ v, l, icon }) => {
                const on = selectedInterests.includes(v);
                return (
                  <button key={v}
                    onClick={() => setSelectedInterests(prev => on ? prev.filter(x => x !== v) : prev.length < 5 ? [...prev, v] : prev)}
                    style={{ display: "flex", alignItems: "center", gap: 7, padding: "9px 14px", borderRadius: 100, border: `1px solid ${on ? "rgba(201,169,110,.5)" : "var(--border)"}`, background: on ? "rgba(201,169,110,.1)" : "var(--bg-input)", color: on ? "var(--accent)" : "var(--text-secondary)", fontFamily: "var(--font-sans)", fontSize: 13, fontWeight: 600, cursor: "pointer", transition: "all .2s", minHeight: 44 }}>
                    <span style={{ fontSize: 16 }}>{icon}</span>{l}
                  </button>
                );
              })}
            </div>
            <button className="cta" onClick={async () => {
              try {
                await API.updateProfile({ style_interests: selectedInterests });
              } catch {}
              setShowInterestPicker(false);
              localStorage.setItem("attair_interests_picked", "1");
              track("interests_picked", { interests: selectedInterests });
            }}>
              {selectedInterests.length === 0 ? "Skip for now" : `Save ${selectedInterests.length} interest${selectedInterests.length !== 1 ? "s" : ""}`}
            </button>
          </div>
        </div>
      )}

      {/* ─── UPGRADE SUCCESS BANNER ──────────────────────── */}
      {upgradeSuccess && (
        <div style={{ position: "fixed", top: 16, left: "50%", transform: "translateX(-50%)", background: "var(--accent)", color: "var(--text-inverse)", padding: "12px 24px", borderRadius: 12, fontWeight: 700, fontSize: 14, zIndex: 9999, boxShadow: "0 8px 32px rgba(0,0,0,.4)" }}>
          Welcome to ATTAIR Pro!
        </div>
      )}

      {/* ─── TRIAL SUCCESS BANNER ────────────────────────── */}
      {trialSuccess && (
        <div style={{ position: "fixed", top: 16, left: "50%", transform: "translateX(-50%)", background: "var(--accent)", color: "var(--text-inverse)", padding: "12px 24px", borderRadius: 12, fontWeight: 700, fontSize: 14, zIndex: 9999, boxShadow: "0 8px 32px rgba(0,0,0,.4)", whiteSpace: "nowrap" }}>
          ✓ 7-day free trial started!
        </div>
      )}

      {/* ─── MAIN APP ────────────────────────────────────── */}
      {screen === "app" && (<>
        <div className="hdr">
          <img src="/logo-option-3.svg" alt="ATTAIR" className="logo-img" />
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            {isPro
              ? <div className="pro">PRO</div>
              : <div className="free-badge" onClick={() => setUpgradeModal("general")}>FREE · {scansLeft}/{scansLimit}</div>
            }
            {userStatus?.tier === "trial" && userStatus?.trial_ends_at && (() => {
              const daysLeft = Math.max(0, Math.ceil((new Date(userStatus.trial_ends_at) - new Date()) / 86400000));
              return <div style={{ fontSize: 10, color: "var(--accent)", padding: "2px 8px", background: "var(--accent-bg)", borderRadius: 100, border: "1px solid var(--accent-border)" }}>{daysLeft}d trial</div>;
            })()}
          </div>
        </div>
        <div className="as">
          <input ref={fileRef} type="file" accept="image/*,.heic,.heif" capture="environment" className="hid" onChange={(e) => handleFile(e.target.files[0])} />

          {/* ─── Home Feed (TikTok/Instagram style) ────── */}
          {tab === "home" && (
            <div className="animate-fade-in" style={{ paddingBottom: 80 }}>
              {/* For You / Following tabs directly under header */}
              {/* For You / Following toggle */}
              <div className="feed-tabs-wrap">
                <button className={`feed-tab${feedTab === "foryou" ? " active" : ""}`} onClick={() => { setFeedTab("foryou"); setFeedPage(1); }}>For You</button>
                <button className={`feed-tab${feedTab === "following" ? " active" : ""}`} onClick={() => { setFeedTab("following"); setFeedPage(1); }}>Following</button>
              </div>

              {/* Skeleton loading */}
              {feedLoading && feedScans.length === 0 && (
                <div style={{ display: "flex", flexDirection: "column", gap: 16, padding: "0 16px" }}>
                  {[0,1,2].map(i => (
                    <div key={i} className="skeleton" style={{ borderRadius: 16, overflow: "hidden" }}>
                      <div className="skeleton-image" style={{ width: "100%", aspectRatio: "4/5" }} />
                    </div>
                  ))}
                </div>
              )}

              {/* Empty state — For You: pre-seeded trending content */}
              {!feedLoading && feedScans.length === 0 && feedTab === "foryou" && (
                <div className="animate-slide-up" style={{ padding: "0 16px 100px" }}>
                  {/* Section header */}
                  <div style={{ padding: "20px 0 14px", display: "flex", alignItems: "center", gap: 8 }}>
                    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>
                    <span style={{ fontSize: 15, fontWeight: 700, color: "var(--text-primary)", letterSpacing: 0.3 }}>Trending on ATTAIR</span>
                  </div>

                  {/* Pre-seeded placeholder cards */}
                  <div className="feed-list" style={{ padding: 0 }}>
                    {[
                      { gradient: "linear-gradient(135deg, #2D1B4E 0%, #1A1A2E 50%, #C9A96E 100%)", label: "Scanned 4 items", title: "Street Style NYC", user: "StyleGuru", initials: "SG" },
                      { gradient: "linear-gradient(135deg, #1A2A1A 0%, #0D1B2A 50%, #8B6914 100%)", label: "Scanned 3 items", title: "Minimal Summer Look", user: "FashionFinder", initials: "FF" },
                      { gradient: "linear-gradient(135deg, #2A1A1A 0%, #1B1025 50%, #C9A96E 100%)", label: "Scanned 5 items", title: "Evening Out Fit Check", user: "OutfitDaily", initials: "OD" },
                      { gradient: "linear-gradient(135deg, #0D1B2A 0%, #1A1A2E 50%, #A8884A 100%)", label: "Scanned 2 items", title: "Cozy Layered Look", user: "TrendWatch", initials: "TW" },
                    ].map((card, idx) => (
                      <div key={idx} className="feed-card card-enter" style={{ animationDelay: `${idx * 0.08}s`, opacity: 0.85, pointerEvents: "none" }} aria-label={`Example outfit: ${card.title}`}>
                        <div style={{ position: "relative" }}>
                          <div className="feed-card-img" style={{ aspectRatio: "4/5", background: card.gradient, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 10 }}>
                            <svg viewBox="0 0 24 24" width="40" height="40" fill="none" stroke="rgba(255,255,255,0.2)" strokeWidth="1"><rect x="2" y="6" width="20" height="14" rx="3" /><circle cx="12" cy="13" r="4" /></svg>
                            <span style={{ fontSize: 13, fontWeight: 600, color: "rgba(255,255,255,0.35)", letterSpacing: 1, textTransform: "uppercase" }}>{card.label}</span>
                          </div>
                          <div className="feed-card-overlay">
                            <div className="feed-card-user">
                              <div className="feed-card-avatar">{card.initials}</div>
                              <div className="feed-card-info">
                                <div className="feed-card-name">{card.user}</div>
                                <div className="feed-card-summary">{card.title}</div>
                              </div>
                            </div>
                            <div className="feed-card-heart" style={{ pointerEvents: "none" }}>
                              <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>
                            </div>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>

                  {/* Subtle CTA text */}
                  <div style={{ textAlign: "center", padding: "28px 16px 0" }}>
                    <div style={{ fontSize: 13, color: "var(--text-tertiary)", lineHeight: 1.6 }}>
                      Follow people and scan outfits to fill your feed with personalized style inspiration.
                    </div>
                  </div>
                </div>
              )}

              {/* Empty state — Following: suggested users to follow */}
              {!feedLoading && feedScans.length === 0 && feedTab === "following" && (
                <div className="animate-slide-up" style={{ padding: "0 16px 100px" }}>
                  {/* Prompt header */}
                  <div style={{ textAlign: "center", padding: "32px 16px 8px" }}>
                    <div style={{ fontSize: 18, fontWeight: 700, color: "var(--text-primary)", marginBottom: 6 }}>Follow people you like</div>
                    <div style={{ fontSize: 13, color: "var(--text-tertiary)", lineHeight: 1.5, maxWidth: 260, margin: "0 auto" }}>See their outfits and scans right here when you follow them.</div>
                  </div>

                  {/* Suggested for You section */}
                  <div style={{ padding: "20px 0 0" }}>
                    <div style={{ fontSize: 13, fontWeight: 700, color: "var(--text-secondary)", letterSpacing: 0.5, textTransform: "uppercase", marginBottom: 12, paddingLeft: 4 }}>Suggested for you</div>
                    <div className="feed-suggested-users" role="list" aria-label="Suggested users to follow">
                      {[
                        { name: "StyleGuru", handle: "@styleguru", initials: "SG", followers: "12.4k", color: "#C9A96E" },
                        { name: "FashionFinder", handle: "@fashionfinder", initials: "FF", followers: "8.1k", color: "#A8884A" },
                        { name: "OutfitDaily", handle: "@outfitdaily", initials: "OD", followers: "23.7k", color: "#8B6914" },
                        { name: "TrendWatch", handle: "@trendwatch", initials: "TW", followers: "5.9k", color: "#D4B978" },
                        { name: "StreetLooks", handle: "@streetlooks", initials: "SL", followers: "15.2k", color: "#B8965A" },
                        { name: "MinimalFit", handle: "@minimalfit", initials: "MF", followers: "9.8k", color: "#C9A96E" },
                      ].map((user, idx) => (
                        <div key={idx} className="feed-suggested-row" role="listitem" style={{ animationDelay: `${idx * 0.05}s` }} aria-label={`Suggested user ${user.name}`}>
                          <div className="feed-suggested-avatar" style={{ background: user.color }}>{user.initials}</div>
                          <div className="feed-suggested-info">
                            <div className="feed-suggested-name">{user.name}</div>
                            <div className="feed-suggested-meta">{user.followers} followers</div>
                          </div>
                          <button className="feed-suggested-follow-btn" aria-label={`Follow ${user.name}`}>Follow</button>
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* Discover People button */}
                  <div style={{ textAlign: "center", padding: "24px 0 0" }}>
                    <button className="btn-primary" onClick={() => { setTab("search"); setShowUserSearch(true); }} style={{ padding: "14px 36px", borderRadius: 100, fontSize: 15, minHeight: 48 }} aria-label="Discover more people to follow">Discover People</button>
                  </div>
                </div>
              )}

              {/* Feed cards */}
              {feedScans.length > 0 && (
                <div className="feed-list">
                  {feedScans.map((scan, idx) => {
                    const u = scan.user || {};
                    const ini = (u.display_name || "?").split(" ").map(w => w[0]).join("").slice(0,2).toUpperCase();
                    const isSaved = saved.some(s => s.scan_id === scan.id);
                    return (
                      <div key={scan.id || idx} className="feed-card card-enter" style={{ animationDelay: `${idx * 0.06}s` }} onClick={() => setFeedDetailScan(scan)}>
                        <div style={{ position: "relative" }}>
                          {scan.image_url
                            ? <img className="feed-card-img" src={scan.image_url} alt={scan.summary || "Outfit"} loading="lazy" style={{ aspectRatio: "4/5" }} />
                            : <div className="feed-card-img" style={{ aspectRatio: "4/5", background: "var(--bg-card)", display: "flex", alignItems: "center", justifyContent: "center" }}>
                                <svg viewBox="0 0 24 24" width="48" height="48" fill="none" stroke="var(--text-tertiary)" strokeWidth="1"><rect x="2" y="6" width="20" height="14" rx="3" /><circle cx="12" cy="13" r="4" /></svg>
                              </div>
                          }
                          {scan.save_count > 0 && (
                            <div className="feed-card-pill">
                              <svg viewBox="0 0 24 24" width="12" height="12" fill="var(--accent)" stroke="none"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>
                              {scan.save_count}
                            </div>
                          )}
                          <div className="feed-card-overlay">
                            <div className="feed-card-user">
                              <div className="feed-card-avatar">{ini}</div>
                              <div className="feed-card-info">
                                <div className="feed-card-name">{u.display_name || "Anonymous"}</div>
                                {scan.summary && <div className="feed-card-summary">{scan.summary}</div>}
                              </div>
                            </div>
                            <button className="feed-card-heart" onClick={(e) => { e.stopPropagation(); const itemData = { name: scan.summary || "Scanned outfit", brand: scan.user?.display_name || "Unknown", category: "outfit", image_url: scan.image_url }; quickSaveItem(itemData, scan.id); }}>
                              <svg viewBox="0 0 24 24" width="22" height="22" fill={isSaved ? "var(--accent)" : "none"} stroke={isSaved ? "var(--accent)" : "#fff"} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>
                            </button>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                  {feedHasMore && (
                    <button onClick={() => loadFeed(feedPage + 1, true)} disabled={feedLoading} className="btn-secondary" style={{ padding: "14px 0", borderRadius: 14, width: "100%", opacity: feedLoading ? 0.5 : 1 }}>
                      {feedLoading ? "Loading..." : "Load more"}
                    </button>
                  )}
                </div>
              )}
            </div>
          )}

          {/* ─── Search Tab ──────────────────────────────── */}
          {tab === "search" && (
            <div className="animate-fade-in" style={{ paddingBottom: 80 }}>
              {/* People / Products sub-tabs */}
              <div className="feed-tabs-wrap">
                <button className={`feed-tab${searchSubTab === "people" ? " active" : ""}`} onClick={() => setSearchSubTab("people")}>People</button>
                <button className={`feed-tab${searchSubTab === "products" ? " active" : ""}`} onClick={() => setSearchSubTab("products")}>Products</button>
              </div>

              {/* Search input */}
              <div style={{ padding: "8px 16px 0" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10, background: "var(--bg-card)", borderRadius: 12, padding: "0 14px", border: "1px solid var(--border)" }}>
                  <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="var(--text-tertiary)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/></svg>
                  {searchSubTab === "people" ? (
                    <input
                      value={userSearchQuery}
                      onChange={e => { setUserSearchQuery(e.target.value); if (!showUserSearch) setShowUserSearch(true); }}
                      onFocus={() => { if (!showUserSearch) setShowUserSearch(true); }}
                      placeholder="Search people..."
                      autoFocus
                      style={{ flex: 1, background: "none", border: "none", outline: "none", padding: "12px 0", fontFamily: "var(--font-sans)", fontSize: 15, color: "var(--text-primary)", minHeight: 44 }}
                    />
                  ) : (
                    <input
                      value={productSearchQuery}
                      onChange={e => setProductSearchQuery(e.target.value)}
                      placeholder="Search products, brands..."
                      autoFocus
                      style={{ flex: 1, background: "none", border: "none", outline: "none", padding: "12px 0", fontFamily: "var(--font-sans)", fontSize: 15, color: "var(--text-primary)", minHeight: 44 }}
                    />
                  )}
                  {searchSubTab === "people" && userSearchQuery && (
                    <button onClick={() => { setUserSearchQuery(""); setUserSearchResults([]); }} style={{ background: "none", border: "none", cursor: "pointer", padding: 10, minHeight: 44, minWidth: 44, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-tertiary)" }}>
                      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6L6 18M6 6l12 12"/></svg>
                    </button>
                  )}
                  {searchSubTab === "products" && productSearchQuery && (
                    <button onClick={() => { setProductSearchQuery(""); setProductSearchResults([]); }} style={{ background: "none", border: "none", cursor: "pointer", padding: 10, minHeight: 44, minWidth: 44, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-tertiary)" }}>
                      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6L6 18M6 6l12 12"/></svg>
                    </button>
                  )}
                </div>
              </div>

              {/* ─── People search results ─── */}
              {searchSubTab === "people" && (
                <div style={{ padding: "12px 16px" }}>
                  {userSearchLoading && <div style={{ textAlign: "center", padding: 32, color: "var(--text-tertiary)", fontSize: 13 }}>Searching...</div>}
                  {!userSearchLoading && userSearchQuery.trim() && userSearchResults.length === 0 && <div style={{ textAlign: "center", padding: 32, color: "var(--text-tertiary)", fontSize: 13 }}>No users found</div>}
                  {!userSearchLoading && !userSearchQuery.trim() && (
                    <div style={{ textAlign: "center", padding: "60px 20px", color: "var(--text-tertiary)" }}>
                      <svg viewBox="0 0 24 24" width="40" height="40" fill="none" stroke="var(--text-tertiary)" strokeWidth="1.2" style={{ marginBottom: 12, opacity: 0.4 }}><circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/></svg>
                      <div style={{ fontFamily: "var(--font-sans)", fontWeight: 600, fontSize: 15 }}>Search for people to follow</div>
                      <div style={{ fontSize: 13, marginTop: 6, opacity: 0.7 }}>Discover outfit inspiration from other users</div>
                    </div>
                  )}
                  {userSearchResults.map(usr => {
                    const ini = (usr.display_name || "?").split(" ").map(w => w[0]).join("").slice(0,2).toUpperCase();
                    const isFlw = followingSet.has(usr.id);
                    return (
                      <div key={usr.id} className="user-search-row">
                        <div className="user-search-avatar">{ini}</div>
                        <div className="user-search-info">
                          <div className="user-search-name">{usr.display_name}</div>
                          {usr.bio && <div className="user-search-bio">{usr.bio}</div>}
                          <div className="user-search-followers">{usr.follower_count || 0} follower{(usr.follower_count || 0) !== 1 ? "s" : ""}</div>
                        </div>
                        <button
                          className={`user-search-follow-btn ${isFlw ? "following" : "follow"}`}
                          onClick={(e) => { e.stopPropagation(); handleFollowFromSearch(usr.id); }}
                        >{isFlw ? "Following" : "Follow"}</button>
                      </div>
                    );
                  })}
                </div>
              )}

              {/* ─── Product search results ─── */}
              {searchSubTab === "products" && (
                <div style={{ padding: "12px 16px" }}>
                  {productSearchQuery.trim() && productSearchResults.length === 0 && (
                    <div style={{ textAlign: "center", padding: 32, color: "var(--text-tertiary)", fontSize: 13 }}>No products found</div>
                  )}
                  {!productSearchQuery.trim() && (
                    <div style={{ textAlign: "center", padding: "60px 20px", color: "var(--text-tertiary)" }}>
                      <svg viewBox="0 0 24 24" width="40" height="40" fill="none" stroke="var(--text-tertiary)" strokeWidth="1.2" style={{ marginBottom: 12, opacity: 0.4 }}><circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/></svg>
                      <div style={{ fontFamily: "var(--font-sans)", fontWeight: 600, fontSize: 15 }}>Search for clothing items, brands, or styles</div>
                      <div style={{ fontSize: 13, marginTop: 6, opacity: 0.7 }}>Find products from your favorite brands</div>
                    </div>
                  )}
                  {productSearchResults.length > 0 && (
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 12 }}>
                      {productSearchResults.map((product, idx) => (
                        <div key={product.id || idx} style={{ background: "var(--bg-card)", borderRadius: 12, border: "1px solid var(--border)", overflow: "hidden" }}>
                          {product.image_url && <img src={product.image_url} alt={product.name || ""} style={{ width: "100%", aspectRatio: "3/4", objectFit: "cover" }} />}
                          <div style={{ padding: 10 }}>
                            {product.brand && <div style={{ fontSize: 11, fontWeight: 600, color: "var(--accent)", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 2 }}>{product.brand}</div>}
                            <div style={{ fontSize: 13, fontWeight: 500, color: "var(--text-primary)", lineHeight: 1.3 }}>{product.name}</div>
                            {product.price && <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text-secondary)", marginTop: 4 }}>{product.price}</div>}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {/* ─── Scan Landing (clean idle state) ───── */}
          {tab === "scan" && phase === "idle" && !img && (<>
            <div className="screen-enter" style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: "60px 24px 40px", minHeight: "60vh", textAlign: "center" }}>
              {/* Hero icon */}
              <div style={{ width: 80, height: 80, borderRadius: "50%", background: "rgba(201,169,110,.08)", border: "1px solid rgba(201,169,110,.15)", display: "flex", alignItems: "center", justifyContent: "center", marginBottom: 24 }}>
                <svg viewBox="0 0 24 24" width="36" height="36" fill="none" stroke="#C9A96E" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="6" width="20" height="14" rx="3" /><circle cx="12" cy="13" r="4" /><path d="M8 6l1.5-3h5L16 6" /></svg>
              </div>
              {/* Title */}
              <div style={{ fontFamily: "'Instrument Serif'", fontSize: 28, color: "var(--text-primary)", marginBottom: 8 }}>Scan an Outfit</div>
              <div style={{ fontSize: 13, color: "var(--text-tertiary)", lineHeight: 1.6, maxWidth: 280, marginBottom: 32 }}>
                Upload a photo of any outfit to find where to buy it
              </div>

              {isFree && scansLeft != null && (
                <div style={{ marginBottom: 24 }}>
                  <div className="scan-counter" style={{ display: "inline-block" }}>{scansLeft > 0 ? <><strong>{scansLimit - scansLeft}</strong> of {scansLimit} scans used</> : <>No scans left &middot; <span style={{color:"var(--accent)",cursor:"pointer"}} onClick={() => setUpgradeModal("scan_limit")}>Go Pro</span></>}</div>
                </div>
              )}

              {/* Scan action — triggers native file picker (camera/gallery) */}
              <div style={{ width: "100%", maxWidth: 340, display: "flex", flexDirection: "column", gap: 12 }}>
                <button className="btn-primary" onClick={() => fileRef.current?.click()} style={{ width: "100%", padding: "16px 0", borderRadius: 14, fontFamily: "var(--font-sans)", fontWeight: 700, fontSize: 16, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 10, minHeight: 52 }}>
                  <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="6" width="20" height="14" rx="3" /><circle cx="12" cy="13" r="4" /><path d="M8 6l1.5-3h5L16 6" /></svg>
                  Tap to Scan an Outfit
                </button>
              </div>
            </div>
          </>)}

          {/* ─── Loading (branded identifying experience) ── */}
          {tab === "scan" && phase === "identifying" && img && (
            <div className="ld-wrap" style={{ position: "relative", minHeight: "70vh", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center" }}>
              {/* Background photo — blurred and darkened */}
              <div style={{ position: "absolute", inset: 0, overflow: "hidden", zIndex: 0 }}>
                <img src={img} alt="" style={{ width: "100%", height: "100%", objectFit: "cover", filter: "blur(12px) brightness(0.3)", transform: "scale(1.1)" }} />
                <div style={{ position: "absolute", inset: 0, background: "rgba(0,0,0,0.45)" }} />
              </div>
              {/* Centered content panel */}
              <div className="animate-scale-in" style={{ position: "relative", zIndex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 20, padding: "40px 32px", background: "rgba(12,12,14,0.7)", backdropFilter: "blur(20px)", WebkitBackdropFilter: "blur(20px)", borderRadius: 20, border: "1px solid rgba(201,169,110,.15)", maxWidth: 300 }}>
                {/* ATTAIR wordmark */}
                <img src="/logo-option-3.svg" alt="ATTAIR" style={{ height: 24, width: "auto" }} />
                {/* Gold scan ring spinner */}
                <div className="scan-ring scan-ring--lg" />
                {/* Animated status text */}
                <div style={{ textAlign: "center" }}>
                  <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: 2.5, color: "rgba(201,169,110,.5)", textTransform: "uppercase", marginBottom: 8 }}>Identifying outfit</div>
                  <div className="serif" style={{ fontSize: 18, color: "var(--text-primary)", transition: "opacity .35s ease", opacity: loadMsgVisible ? 1 : 0, minHeight: 28 }}>{SCAN_MESSAGES[loadMsgIdx]}</div>
                </div>
                <div className="ld-dots"><div className="ld-dot" /><div className="ld-dot" /><div className="ld-dot" /></div>
              </div>
            </div>
          )}

          {/* ─── Error ─────────────────────────────────── */}
          {tab === "scan" && error && phase === "idle" && (
            <div className="animate-slide-up">
              {img && <img src={img} style={{width:"100%",maxHeight:"25vh",objectFit:"cover",display:"block",filter:"brightness(0.25)"}} alt="" />}
              <div className="err">{error}</div>
              <div style={{padding:"0 20px",marginTop:12}}><button className="btn-secondary" style={{width:"100%"}} onClick={reset}>Try again</button></div>
            </div>
          )}

          {/* ─── Picking — choose which items to search ── */}
          {tab === "scan" && results && phase === "picking" && (
            <div className="res">
              <div className="v-banner">
                <div className="v-steps">
                  <div className="v-step">
                    <div className="v-step-bar"><div className="v-step-fill" style={{ width: "100%", background: "var(--accent)" }} /></div>
                    <div className="v-step-l" style={{ color: "var(--accent)" }}>✓ Identified</div>
                  </div>
                  <div className="v-step">
                    <div className="v-step-bar"><div className="v-step-fill" style={{ width: "0%", background: "var(--border)" }} /></div>
                    <div className="v-step-l" style={{ color: "var(--text-tertiary)" }}>Select items</div>
                  </div>
                </div>
              </div>

              {/* Image with toggleable hotspots */}
              <div className="res-img-sec">
                <img src={img} className="res-img" alt="" /><div className="res-grad" />
                <button className="res-close" onClick={reset}><svg viewBox="0 0 14 14"><path d="M2 2l10 10M12 2L2 12"/></svg></button>
                <button className="res-new" onClick={reset}><svg viewBox="0 0 24 24"><rect x="2" y="6" width="20" height="14" rx="3"/><circle cx="12" cy="13" r="4"/><path d="M8 6l1.5-3h5L16 6"/></svg>{t("new_scan")}</button>
                {results.items.map((item, i) => {
                  const py = item.position_y != null ? Math.max(0.08, Math.min(0.85, item.position_y)) : (CAT_POSITIONS[item.category] || 0.5);
                  const px = 0.5 + (i % 2 === 0 ? -0.22 : 0.22);
                  const isPicked = pickedItems.has(i);
                  return (
                    <div key={i} className={`hs ${isPicked ? "picked" : "unpicked"}`} style={{ top: `${py*100}%`, left: `${Math.max(0.12, Math.min(0.88, px))*100}%` }} onClick={() => setPickedItems(prev => { const n = new Set(prev); if (n.has(i)) n.delete(i); else n.add(i); return n; })}>
                      <div className="hs-ring"><span className="hs-num">{i+1}</span></div>
                      <div className="hs-tag">{item.subcategory || item.category}</div>
                    </div>
                  );
                })}
              </div>

              {/* Prompt */}
              <div style={{ padding: "16px 20px 6px", textAlign: "center" }}>
                <div style={{ fontFamily: "'Instrument Serif'", fontSize: 22, color: "var(--text-primary)", marginBottom: 6 }}>What do you want to shop?</div>
                <div style={{ fontSize: 12, color: "var(--text-tertiary)", lineHeight: 1.5 }}>Tap items on the image or below</div>
                {/* Gender badge — prominent, tappable */}
                <div style={{ display: "flex", justifyContent: "center", marginTop: 12 }}>
                  <div style={{ display: "inline-flex", background: "var(--bg-input)", borderRadius: "var(--radius-full)", border: "1px solid var(--border)", overflow: "hidden" }}>
                    <button
                      aria-label="Switch to Men's"
                      onClick={() => { if (results.gender !== "male") setResults(prev => prev ? { ...prev, gender: "male" } : prev); }}
                      style={{ padding: "8px 18px", fontSize: 13, fontWeight: 700, letterSpacing: 0.5, border: "none", cursor: "pointer", fontFamily: "var(--font-sans)", transition: "all var(--transition-fast)", minHeight: 36, background: results.gender === "male" ? "rgba(110,169,201,.15)" : "transparent", color: results.gender === "male" ? "#6EAEC9" : "var(--text-tertiary)", borderRight: "1px solid var(--border)" }}
                    >Men's</button>
                    <button
                      aria-label="Switch to Women's"
                      onClick={() => { if (results.gender !== "female") setResults(prev => prev ? { ...prev, gender: "female" } : prev); }}
                      style={{ padding: "8px 18px", fontSize: 13, fontWeight: 700, letterSpacing: 0.5, border: "none", cursor: "pointer", fontFamily: "var(--font-sans)", transition: "all var(--transition-fast)", minHeight: 36, background: results.gender === "female" ? "rgba(201,110,169,.15)" : "transparent", color: results.gender === "female" ? "#C96EAE" : "var(--text-tertiary)" }}
                    >Women's</button>
                  </div>
                </div>
              </div>

              {/* Item pick list — tap row to set per-item prefs, tap checkbox to toggle */}
              <div className="pick-list">
                {results.items.map((item, i) => {
                  const isPicked = pickedItems.has(i);
                  const ov = itemOverrides[i];
                  return (
                    <div key={i} className={`pick-item ${isPicked ? "picked" : ""}`} onClick={() => setItemSettingsIdx(i)}>
                      <div className="pick-check" onClick={e => { e.stopPropagation(); setPickedItems(prev => { const n = new Set(prev); if (n.has(i)) n.delete(i); else n.add(i); return n; }); }}>
                        {isPicked && <svg width="12" height="12" viewBox="0 0 12 12"><path d="M2.5 6.5L5 9L9.5 3.5" fill="none" stroke="#0C0C0E" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>}
                      </div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                          <span style={{ fontSize: 14, fontWeight: 600, color: isPicked ? "var(--text-primary)" : "var(--text-secondary)", transition: "color .2s" }}>{item.name}</span>
                          {item.priority && <span style={{ fontSize: 9, fontWeight: 700, padding: "2px 6px", background: "rgba(201,169,110,.12)", border: "1px solid rgba(201,169,110,.35)", borderRadius: 100, color: "var(--accent)", letterSpacing: .5, flexShrink: 0 }}>&#11044; Circled</span>}
                        </div>
                        <div style={{ fontSize: 11, color: isPicked ? "rgba(201,169,110,.6)" : "var(--text-tertiary)", transition: "color .2s" }}>
                          {item.brand && item.brand !== "Unidentified" ? item.brand + " · " : ""}{item.color} · {item.category}
                          {item.identification_confidence ? <span style={{ marginLeft: 4, color: "var(--text-tertiary)" }}>· {item.identification_confidence}%</span> : null}
                        </div>
                      </div>
                      {ov?.budgetMin != null
                        ? <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 3, flexShrink: 0 }}>
                            <div style={{ fontSize: 12, fontWeight: 700, color: "var(--accent)", background: "rgba(201,169,110,.1)", border: "1px solid rgba(201,169,110,.25)", borderRadius: 7, padding: "4px 9px", whiteSpace: "nowrap" }}>${ov.budgetMin}–${ov.budgetMax ?? ov.budgetMin * 2}</div>
                            <div style={{ fontSize: 9, color: "rgba(201,169,110,.5)", letterSpacing: .3 }}>tap to edit</div>
                          </div>
                        : <div style={{ display: "flex", alignItems: "center", gap: 5, padding: "8px 12px", background: "rgba(201,169,110,.06)", border: "1px solid rgba(201,169,110,.2)", borderRadius: 10, flexShrink: 0, cursor: "pointer" }}>
                            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#C9A96E" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="4" y1="6" x2="20" y2="6"/><line x1="4" y1="12" x2="20" y2="12"/><line x1="4" y1="18" x2="20" y2="18"/><circle cx="8" cy="6" r="2" fill="#C9A96E" stroke="none"/><circle cx="16" cy="12" r="2" fill="#C9A96E" stroke="none"/><circle cx="10" cy="18" r="2" fill="#C9A96E" stroke="none"/></svg>
                            <span style={{ fontSize: 12, fontWeight: 600, color: "var(--accent)" }}>Set prefs</span>
                          </div>
                      }
                    </div>
                  );
                })}
              </div>

              {/* Occasion Filter */}
              <div style={{ padding: "4px 20px 0" }}>
                <div className="item-opts-label">Occasion</div>
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  {[
                    { v: "casual",    l: "Casual",   icon: "☀️" },
                    { v: "work",      l: "Work",     icon: "💼" },
                    { v: "night_out", l: "Night Out", icon: "🌙" },
                    { v: "athletic",  l: "Athletic",  icon: "🏃" },
                    { v: "formal",    l: "Formal",    icon: "✨" },
                    { v: "outdoor",   l: "Outdoor",   icon: "🌲" },
                  ].map(({ v, l, icon }) => (
                    <button key={v} className={`scan-vis-chip${occasion === v ? " active" : ""}`} onClick={() => { setOccasion(o => o === v ? null : v); setShowCustomOccasion(false); }}>
                      <span style={{ fontSize: 13 }}>{icon}</span>{l}
                    </button>
                  ))}
                  {recentOccasions.map((ro, i) => (
                    <button key={`recent-${i}`} className={`scan-vis-chip${occasion === ro ? " active" : ""}`} onClick={() => { setOccasion(o => o === ro ? null : ro); setShowCustomOccasion(false); }}>
                      {ro}
                    </button>
                  ))}
                  <button className={`scan-vis-chip${showCustomOccasion ? " active" : ""}`} onClick={() => setShowCustomOccasion(v => !v)}>
                    <span style={{ fontSize: 13 }}>+</span>{t("custom_occasion")}
                  </button>
                </div>
                {showCustomOccasion && (
                  <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                    <input
                      autoFocus
                      value={customOccasionInput}
                      onChange={e => setCustomOccasionInput(e.target.value)}
                      onKeyDown={e => {
                        if (e.key === "Enter" && customOccasionInput.trim()) {
                          const val = customOccasionInput.trim();
                          setOccasion(val);
                          setShowCustomOccasion(false);
                          setCustomOccasionInput("");
                          const updated = [val, ...recentOccasions.filter(x => x !== val)].slice(0, 5);
                          setRecentOccasions(updated);
                          localStorage.setItem("attair_recent_occasions", JSON.stringify(updated));
                        }
                      }}
                      placeholder="e.g. rooftop brunch, job interview"
                      style={{ flex: 1, padding: "8px 12px", background: "var(--bg-input)", border: "1px solid var(--accent-border)", borderRadius: 10, color: "var(--text-primary)", fontFamily: "var(--font-sans)", fontSize: 12, outline: "none", minHeight: 44 }}
                    />
                    <button onClick={() => {
                      const val = customOccasionInput.trim();
                      if (!val) return;
                      setOccasion(val);
                      setShowCustomOccasion(false);
                      setCustomOccasionInput("");
                      const updated = [val, ...recentOccasions.filter(x => x !== val)].slice(0, 5);
                      setRecentOccasions(updated);
                      localStorage.setItem("attair_recent_occasions", JSON.stringify(updated));
                    }} style={{ padding: "8px 14px", background: "var(--accent)", border: "none", borderRadius: 10, color: "var(--text-inverse)", fontFamily: "var(--font-sans)", fontSize: 12, fontWeight: 700, cursor: "pointer", whiteSpace: "nowrap" }}>
                      Set
                    </button>
                  </div>
                )}
              </div>

              {/* Search Notes */}
              <div style={{ padding: "8px 20px 0" }}>
                <textarea
                  value={searchNotes}
                  onChange={e => setSearchNotes(e.target.value.slice(0, 200))}
                  placeholder={t("search_notes_placeholder")}
                  rows={2}
                  className="refine-input"
                  style={{ width: "100%", fontSize: 12 }}
                />
              </div>

              {/* Search CTA */}
              <div className="pick-cta">
                <button
                  style={{ background: pickedItems.size > 0 ? "var(--accent)" : "var(--accent-bg)", color: pickedItems.size > 0 ? "var(--text-inverse)" : "var(--text-tertiary)" }}
                  onClick={runProductSearch}
                  disabled={pickedItems.size === 0}
                >
                  {pickedItems.size === 0 ? "Select items to search" : `Search ${pickedItems.size} item${pickedItems.size > 1 ? "s" : ""}${occasion ? ` · ${["casual","work","night_out","athletic","formal","outdoor"].find(v=>v===occasion) ? {casual:"Casual",work:"Work",night_out:"Night Out",athletic:"Athletic",formal:"Formal",outdoor:"Outdoor"}[occasion] : ""}` : ""}`}
                </button>
                <button className="btn-ghost" style={{ width: "100%", fontSize: 12, marginTop: 4 }}
                  onClick={() => { setPickedItems(new Set(results.items.map((_, i) => i))); }}>
                  Select all
                </button>
              </div>
            </div>
          )}

          {/* ─── Results (Minimalist Redesign) ───────────────────────────────── */}
          {tab === "scan" && results && (phase === "searching" || phase === "done") && (
            <div className="res">
              {/* Re-search banner */}
              {phase === "searching" && isResearch && (
                <div style={{ padding: "10px 16px", background: "rgba(201,169,110,.08)", borderBottom: "1px solid rgba(201,169,110,.15)", display: "flex", alignItems: "center", gap: 10 }}>
                  <div style={{ display: "flex", gap: 4, flexShrink: 0 }}>
                    <div className="ld-dot" style={{ background: "var(--accent)" }} />
                    <div className="ld-dot" style={{ background: "var(--accent)", animationDelay: ".15s" }} />
                    <div className="ld-dot" style={{ background: "var(--accent)", animationDelay: ".3s" }} />
                  </div>
                  <div style={{ fontSize: 12, fontWeight: 600, color: "var(--accent)", transition: "opacity .35s ease", opacity: loadMsgVisible ? 1 : 0.3 }}>
                    {RESEARCH_MESSAGES[loadMsgIdx % RESEARCH_MESSAGES.length]}
                  </div>
                </div>
              )}

              {/* Progress bar */}
              <div className="v-banner">
                <div className="v-steps">
                  <div className="v-step">
                    <div className="v-step-bar"><div className="v-step-fill" style={{ width: "100%", background: "var(--accent)" }} /></div>
                    <div className="v-step-l" style={{ color: "var(--accent)" }}>Identified</div>
                  </div>
                  <div className="v-step">
                    <div className="v-step-bar"><div className="v-step-fill" style={{ width: phase === "searching" ? "40%" : "100%", background: phase === "done" ? (results.items.some(it => it.status === "verified") ? "var(--accent)" : "var(--text-tertiary)") : "rgba(201,169,110,.4)", transition: phase === "searching" ? "width 12s linear" : "width .5s ease" }} /></div>
                    <div className="v-step-l" style={{ color: phase === "searching" ? "rgba(201,169,110,.5)" : results.items.some(it => it.status === "verified") ? "var(--accent)" : "var(--text-tertiary)", transition: "opacity .35s ease", opacity: phase === "searching" ? (loadMsgVisible ? 1 : 0.3) : 1 }}>
                      {phase === "searching"
                        ? (isResearch ? RESEARCH_MESSAGES[loadMsgIdx % RESEARCH_MESSAGES.length] : SEARCH_MESSAGES[loadMsgIdx % SEARCH_MESSAGES.length])
                        : results.items.some(it => it.status === "verified") ? "Products found" : "Search complete"}
                    </div>
                  </div>
                </div>
              </div>

              {/* ─── Compact header: photo + summary + gender ─── */}
              <div style={{ display: "flex", gap: 14, padding: "14px 20px", alignItems: "flex-start" }}>
                {img && (
                  <div style={{ width: 90, height: 120, borderRadius: 12, overflow: "hidden", flexShrink: 0, position: "relative" }}>
                    <img src={img} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                    <button onClick={reset} style={{ position: "absolute", top: 4, right: 4, width: 24, height: 24, borderRadius: "50%", background: "rgba(0,0,0,.5)", border: "none", color: "#fff", fontSize: 12, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", backdropFilter: "blur(4px)" }} aria-label="New scan">
                      <svg viewBox="0 0 14 14" width="10" height="10" stroke="currentColor" strokeWidth="2"><path d="M2 2l10 10M12 2L2 12"/></svg>
                    </button>
                  </div>
                )}
                <div style={{ flex: 1, minWidth: 0 }}>
                  {results.summary && <div style={{ fontSize: 13, color: "var(--text-secondary)", lineHeight: 1.5, marginBottom: 8 }}>{results.summary}</div>}
                  <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                    <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: 2, color: "var(--text-tertiary)", textTransform: "uppercase" }}>{pickedItems.size} items</span>
                    <div style={{ display: "inline-flex", background: "var(--bg-input)", borderRadius: "var(--radius-full)", border: "1px solid var(--border)", overflow: "hidden", marginLeft: "auto" }}>
                      <button
                        aria-label="Switch to Men's results"
                        onClick={() => {
                          if (results.gender !== "male") {
                            setResults(prev => prev ? { ...prev, gender: "male" } : prev);
                            if (phase === "done" && pickedItems.size > 0) setTimeout(() => runProductSearch(), 100);
                          }
                        }}
                        style={{ padding: "4px 10px", fontSize: 10, fontWeight: 700, letterSpacing: 0.5, border: "none", cursor: "pointer", fontFamily: "var(--font-sans)", transition: "all var(--transition-fast)", minHeight: 28, background: results.gender === "male" ? "rgba(110,169,201,.15)" : "transparent", color: results.gender === "male" ? "#6EAEC9" : "var(--text-tertiary)", borderRight: "1px solid var(--border)" }}
                      >Men's</button>
                      <button
                        aria-label="Switch to Women's results"
                        onClick={() => {
                          if (results.gender !== "female") {
                            setResults(prev => prev ? { ...prev, gender: "female" } : prev);
                            if (phase === "done" && pickedItems.size > 0) setTimeout(() => runProductSearch(), 100);
                          }
                        }}
                        style={{ padding: "4px 10px", fontSize: 10, fontWeight: 700, letterSpacing: 0.5, border: "none", cursor: "pointer", fontFamily: "var(--font-sans)", transition: "all var(--transition-fast)", minHeight: 28, background: results.gender === "female" ? "rgba(201,110,169,.15)" : "transparent", color: results.gender === "female" ? "#C96EAE" : "var(--text-tertiary)" }}
                      >Women's</button>
                    </div>
                  </div>
                </div>
              </div>

              {/* ─── Ident preview while searching ─── */}
              {phase === "searching" && identPreview && identPreview.length > 0 && (
                <div style={{ padding: "0 20px 10px", display: "flex", flexDirection: "column", gap: 6 }}>
                  <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: 2, color: "rgba(201,169,110,.4)", textTransform: "uppercase", marginBottom: 2 }}>Found in this photo</div>
                  {identPreview.slice(0, 4).map((item, i) => (
                    <div key={i} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 12px", background: "var(--accent-bg)", borderRadius: 10, border: "1px solid var(--border)" }}>
                      <div style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--accent)", flexShrink: 0 }} />
                      <div style={{ flex: 1 }}>
                        <span style={{ fontSize: 13, color: "var(--text-primary)", fontWeight: 600 }}>{item.name}</span>
                        {item.brand && item.brand !== "Unidentified" && <span style={{ fontSize: 11, color: "var(--text-tertiary)", marginLeft: 6 }}>{item.brand}</span>}
                        {item.color && <span style={{ fontSize: 11, color: "var(--text-tertiary)", marginLeft: 4 }}>· {item.color}</span>}
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {/* ─── Outfit verdict (prominent) ─── */}
              {phase === "done" && scanId && (
                <div style={{ padding: "0 20px 12px", display: "flex", gap: 8, justifyContent: "center" }}>
                  {[
                    { key: "would_wear", label: "Would Wear", icon: "\u2713", color: "var(--success)", bg: "rgba(76,175,80,.1)", border: "rgba(76,175,80,.3)" },
                    { key: "on_the_fence", label: "On the Fence", icon: "~", color: "var(--warning)", bg: "rgba(255,183,77,.1)", border: "rgba(255,183,77,.3)" },
                    { key: "not_for_me", label: "Not for Me", icon: "\u2717", color: "var(--error)", bg: "rgba(255,82,82,.1)", border: "rgba(255,82,82,.3)" },
                  ].map(v => {
                    const isActive = scanVerdicts[scanId] === v.key;
                    const isAnimating = verdictAnimating === v.key;
                    return (
                      <button
                        key={v.key}
                        aria-label={`Mark outfit as ${v.label}`}
                        onClick={async () => {
                          const newVerdict = isActive ? null : v.key;
                          setScanVerdicts(sv => ({ ...sv, [scanId]: newVerdict }));
                          setVerdictAnimating(v.key);
                          setTimeout(() => setVerdictAnimating(null), 500);
                          if (newVerdict) {
                            API.setVerdict(scanId, newVerdict).catch(() => {});
                            track("verdict_set", { verdict: newVerdict }, scanId, "scan");
                            if (newVerdict === "would_wear" && results?.items) {
                              results.items.forEach((item, idx) => {
                                if (pickedItems.has(idx) && item.tiers) {
                                  const bestTier = item.tiers.find(t => t.products?.length > 0);
                                  if (bestTier) {
                                    API.saveItem(scanId, item, bestTier.tier, bestTier.products[0]).catch(() => {});
                                  }
                                }
                              });
                              API.getSaved().then(d => setSaved(d.items || [])).catch(() => {});
                            }
                          }
                        }}
                        style={{
                          flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 4,
                          padding: "10px 8px", minHeight: 44,
                          background: isActive ? v.bg : "var(--bg-card)",
                          border: `1px solid ${isActive ? v.border : "var(--border)"}`,
                          borderRadius: "var(--radius-md)", cursor: "pointer",
                          transition: "all var(--transition-fast)",
                          animation: isAnimating && v.key === "not_for_me" ? "verdictShake 0.4s ease" : isAnimating ? "verdictPop 0.4s ease" : "none",
                          fontFamily: "var(--font-sans)",
                        }}
                      >
                        <span style={{ fontSize: 18, fontWeight: 700, color: isActive ? v.color : "rgba(255,255,255,.25)", transition: "color var(--transition-fast)" }}>{v.icon}</span>
                        <span style={{ fontSize: 10, fontWeight: 600, color: isActive ? v.color : "rgba(255,255,255,.3)", letterSpacing: 0.3, transition: "color var(--transition-fast)" }}>{v.label}</span>
                      </button>
                    );
                  })}
                </div>
              )}

              {/* ─── Banner ad slot (free users) ─── */}
              {showAds && (
                <div className="ad-slot ad-banner" style={{ margin: "0 20px 8px", height: "auto", borderRadius: 12, overflow: "hidden", border: "1px solid var(--border)", background: "var(--accent-bg)" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 12px" }}>
                    <div style={{ width: 38, height: 38, borderRadius: 8, background: "rgba(201,169,110,.12)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18, flexShrink: 0 }}>✦</div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 12, fontWeight: 700, color: "var(--text-primary)", marginBottom: 2 }}>Trending This Week</div>
                      <div style={{ fontSize: 10, color: "var(--text-tertiary)" }}>Discover curated styles from top brands</div>
                    </div>
                    <div style={{ fontSize: 9, color: "var(--text-tertiary)", letterSpacing: .5, textTransform: "uppercase", flexShrink: 0 }}>Sponsored</div>
                  </div>
                </div>
              )}

              {/* ═══════════════════════════════════════════════════════════
                  CORE: Per-item collapsible sections with horizontal product scroll
                  ═══════════════════════════════════════════════════════════ */}
              <div style={{ padding: "0 0 8px" }}>
                {results.items.map((item, i) => {
                  if (!pickedItems.has(i)) return null;
                  const isExpanded = expandedItems.has(i);
                  const TIER_CFG = { budget: { label: "Budget", accent: "#5AC8FF" }, mid: { label: "Match", accent: "#C9A96E" }, premium: { label: "Premium", accent: "#C77DFF" }, resale: { label: "Resale", accent: "#7BC47F" } };
                  const allTierProducts = item.tiers ? ["budget", "mid", "premium", "resale"].flatMap(tk => asTierArray(item.tiers[tk]).map(p => ({ ...p, _tier: tk }))) : [];

                  return (
                    <div key={i} style={{ borderBottom: "1px solid var(--border)" }}>
                      {/* Item header — tap to expand/collapse */}
                      <button
                        onClick={() => {
                          setExpandedItems(prev => {
                            const next = new Set(prev);
                            if (next.has(i)) next.delete(i); else next.add(i);
                            return next;
                          });
                          setSelIdx(i);
                        }}
                        style={{
                          width: "100%", display: "flex", alignItems: "center", gap: 10,
                          padding: "14px 20px", background: "none", border: "none",
                          cursor: "pointer", fontFamily: "var(--font-sans)", textAlign: "left",
                          transition: "background .15s",
                        }}
                      >
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontSize: 14, fontWeight: 600, color: "var(--text-primary)", lineHeight: 1.3 }}>
                            {item.name}
                            {item.priority && <span style={{ marginLeft: 6, fontSize: 9, fontWeight: 700, padding: "2px 6px", background: "rgba(201,169,110,.12)", borderRadius: 100, color: "var(--accent)", letterSpacing: .5, verticalAlign: "middle" }}>Circled</span>}
                          </div>
                          <div style={{ fontSize: 11, color: "var(--text-tertiary)", marginTop: 2 }}>
                            {item.brand && item.brand !== "Unidentified" ? item.brand + " · " : ""}{item.color} · {item.category}
                          </div>
                        </div>
                        {item.status === "searching" && <div className="ld-dot" style={{ width: 8, height: 8, background: "var(--accent)", flexShrink: 0 }} />}
                        {item.status === "verified" && allTierProducts.length > 0 && (
                          <span style={{ fontSize: 10, fontWeight: 600, color: "var(--text-tertiary)", flexShrink: 0 }}>{allTierProducts.length} products</span>
                        )}
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--text-tertiary)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, transition: "transform .2s", transform: isExpanded ? "rotate(180deg)" : "rotate(0)" }}>
                          <polyline points="6 9 12 15 18 9"/>
                        </svg>
                      </button>

                      {/* Expanded content */}
                      {isExpanded && (
                        <div style={{ padding: "0 0 16px", overflow: "hidden", animation: "slideDown .2s ease" }}>
                          {/* Searching state */}
                          {item.status === "searching" && (
                            <div style={{ padding: "12px 20px", textAlign: "center", color: "rgba(201,169,110,.5)", fontSize: 12 }}>
                              Finding products...
                            </div>
                          )}

                          {/* Failed state */}
                          {item.status === "failed" && !item.tiers && (
                            <div style={{ padding: "12px 20px", textAlign: "center", color: "var(--text-tertiary)", fontSize: 12 }}>
                              No products found.{" "}
                              <span style={{ color: "var(--accent)", cursor: "pointer" }} onClick={() => { setSelIdx(i); setItemViewModes(m => ({ ...m, [i]: "id" })); }}>Correct the AI</span>
                            </div>
                          )}

                          {/* Horizontal product scroll per tier */}
                          {item.tiers && ["budget", "mid", "premium", "resale"].map(tierKey => {
                            const products = asTierArray(item.tiers[tierKey]);
                            if (!products.length) return null;
                            const cfg = TIER_CFG[tierKey];
                            return (
                              <div key={tierKey} style={{ marginBottom: 12 }}>
                                <div style={{ padding: "0 20px 6px", fontSize: 9, fontWeight: 700, letterSpacing: 1.5, color: cfg.accent, textTransform: "uppercase" }}>
                                  {cfg.label}
                                </div>
                                <div className="scroll-x" style={{ display: "flex", gap: 10, overflowX: "auto", paddingLeft: 20, paddingRight: 20, paddingBottom: 4, scrollSnapType: "x mandatory", WebkitOverflowScrolling: "touch", msOverflowStyle: "none", scrollbarWidth: "none" }}>
                                  {products.map((p, j) => {
                                    const isFallback = !p.is_product_page && p.brand === "Google Shopping";
                                    const clickId = `${scanId || "x"}_${i}_${tierKey}_${j}`;
                                    const href = p.url ? API.affiliateUrl(clickId, p.url, scanId, i, tierKey, p.brand) : "#";
                                    const isSavedProduct = saved.some(s => (s.item_data?.name || s.name) === (p.product_name || item.name));
                                    return (
                                      <div key={j} className="card-press" style={{ flexShrink: 0, width: 150, scrollSnapAlign: "start", position: "relative" }}>
                                        <a href={href} target="_blank" rel="noopener noreferrer"
                                          onClick={() => track("product_clicked", { tier: tierKey, brand: p.brand, price: p.price, is_fallback: isFallback }, scanId, "scan")}
                                          style={{ display: "flex", flexDirection: "column", textDecoration: "none", color: "inherit", background: "var(--bg-card)", border: `1px solid ${p.is_identified_brand ? "rgba(201,169,110,.25)" : "var(--border)"}`, borderRadius: 12, overflow: "hidden", transition: "all .2s" }}>
                                          {p.image_url && (
                                            <div style={{ width: "100%", aspectRatio: "1", background: "var(--bg-input)", overflow: "hidden" }}>
                                              <img src={p.image_url} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} onError={e => { e.target.style.display = "none"; }} />
                                            </div>
                                          )}
                                          <div style={{ padding: "8px 10px", display: "flex", flexDirection: "column", gap: 3 }}>
                                            {p.is_identified_brand && <span style={{ fontSize: 7, fontWeight: 800, letterSpacing: 1, padding: "2px 5px", borderRadius: 3, background: "rgba(201,169,110,.12)", color: "var(--accent)", alignSelf: "flex-start" }}>ORIGINAL</span>}
                                            <div style={{ fontSize: 11, fontWeight: 500, color: "var(--text-secondary)", lineHeight: 1.3, overflow: "hidden", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical" }}>
                                              {isFallback ? "Search results" : (p.product_name || "Product")}
                                            </div>
                                            <div style={{ fontSize: 10, color: "var(--text-tertiary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.brand}</div>
                                            <div style={{ fontSize: 14, fontWeight: 700, color: cfg.accent }}>{isFallback ? "Search" : p.price}</div>
                                            <div style={{ fontSize: 11, fontWeight: 600, color: cfg.accent, textAlign: "center", paddingTop: 4, borderTop: "1px solid var(--border)" }}>Shop</div>
                                          </div>
                                        </a>
                                        {/* Save heart */}
                                        <button
                                          aria-label={isSavedProduct ? "Remove from Likes" : "Save to Likes"}
                                          onClick={e => { e.preventDefault(); e.stopPropagation(); quickSaveItem({ name: p.product_name || item.name, brand: p.brand || item.brand, price: p.price, image_url: p.image_url, url: p.url, category: item.category }, scanId); }}
                                          style={{ position: "absolute", top: 6, right: 6, width: 28, height: 28, borderRadius: "50%", background: isSavedProduct ? "rgba(255,60,80,.9)" : "rgba(0,0,0,.45)", border: "none", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", backdropFilter: "blur(4px)", zIndex: 2 }}>
                                          <svg viewBox="0 0 24 24" width="12" height="12" fill={isSavedProduct ? "#fff" : "none"} stroke={isSavedProduct ? "#fff" : "rgba(255,255,255,.8)"} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                                            <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/>
                                          </svg>
                                        </button>
                                      </div>
                                    );
                                  })}
                                </div>
                              </div>
                            );
                          })}

                          {/* Not finding what you want? */}
                          {item.tiers && (() => {
                            const allProducts = ["budget", "mid", "premium"].flatMap(tk => asTierArray(item.tiers[tk]));
                            const hasFallback = allProducts.some(p => !p.is_product_page && p.brand === "Google Shopping");
                            if (!hasFallback) return null;
                            const googleQuery = item.search_query || `${item.brand || ""} ${item.name || ""}`.trim();
                            return (
                              <div style={{ padding: "0 20px", display: "flex", gap: 8, justifyContent: "center", flexWrap: "wrap" }}>
                                {item.alt_search && (
                                  <button
                                    onClick={() => { setSearchNotes(item.alt_search); setTimeout(() => runProductSearch(), 100); track("alt_search_clicked", { item_name: item.name, alt_search: item.alt_search }, scanId, "scan"); }}
                                    style={{ padding: "8px 14px", background: "rgba(201,169,110,.08)", border: "1px solid rgba(201,169,110,.25)", borderRadius: 10, color: "var(--accent)", fontFamily: "var(--font-sans)", fontSize: 12, fontWeight: 600, cursor: "pointer" }}>
                                    Try alternate search
                                  </button>
                                )}
                                <a href={`https://www.google.com/search?tbm=shop&q=${encodeURIComponent(googleQuery)}`} target="_blank" rel="noopener noreferrer"
                                  onClick={() => track("google_search_clicked", { item_name: item.name, query: googleQuery }, scanId, "scan")}
                                  style={{ padding: "8px 14px", background: "var(--bg-input)", border: "1px solid var(--border)", borderRadius: 10, color: "var(--text-secondary)", fontFamily: "var(--font-sans)", fontSize: 12, fontWeight: 600, cursor: "pointer", textDecoration: "none", display: "inline-flex", alignItems: "center", gap: 5 }}>
                                  Google Shopping
                                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
                                </a>
                              </div>
                            );
                          })()}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>

              {/* ═══════════════════════════════════════════════════════════
                  ADVANCED / REFINE SEARCH — hidden by default
                  ═══════════════════════════════════════════════════════════ */}
              {phase === "done" && (
                <div style={{ padding: "0 20px" }}>
                  {/* Toggle button */}
                  <button
                    onClick={() => setShowAdvanced(a => !a)}
                    style={{
                      width: "100%", display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
                      padding: "12px 0", background: "none", border: "none",
                      cursor: "pointer", fontFamily: "var(--font-sans)",
                      color: "var(--text-tertiary)", fontSize: 12, fontWeight: 600, letterSpacing: 0.3,
                    }}
                  >
                    Refine Search
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ transition: "transform .2s", transform: showAdvanced ? "rotate(180deg)" : "rotate(0)" }}>
                      <polyline points="6 9 12 15 18 9"/>
                    </svg>
                  </button>

                  {/* Advanced content */}
                  {showAdvanced && (
                    <div style={{ paddingBottom: 16, display: "flex", flexDirection: "column", gap: 16, animation: "slideDown .2s ease" }}>

                      {/* Search notes */}
                      <div>
                        <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: 1.5, color: "var(--text-tertiary)", textTransform: "uppercase", marginBottom: 6 }}>Search Notes</div>
                        {searchNotes ? (
                          <div style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "6px 12px", background: "var(--accent-bg)", border: "1px solid var(--accent-border)", borderRadius: "var(--radius-full)", cursor: "pointer", marginBottom: 6 }}
                            onClick={() => { const el = document.getElementById("adv-search-notes"); if (el) el.focus(); }}>
                            <span style={{ fontSize: 12, color: "var(--accent)", fontWeight: 500, maxWidth: 260, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{searchNotes}</span>
                            <button aria-label="Clear search notes" onClick={(e) => { e.stopPropagation(); setSearchNotes(""); setTimeout(() => runProductSearch(), 100); }}
                              style={{ background: "none", border: "none", color: "var(--accent)", cursor: "pointer", fontSize: 14, padding: 0, lineHeight: 1 }}>&times;</button>
                          </div>
                        ) : null}
                        <input
                          id="adv-search-notes"
                          value={searchNotes}
                          onChange={e => setSearchNotes(e.target.value.slice(0, 200))}
                          onKeyDown={e => { if (e.key === "Enter" && searchNotes.trim()) { e.target.blur(); runProductSearch(); } }}
                          placeholder="Tell us more... (brand, color, style)"
                          style={{
                            width: "100%", padding: "10px 14px",
                            background: "var(--bg-input)", border: "1px solid var(--border)",
                            borderRadius: "var(--radius-md)", color: "var(--text-secondary)", fontSize: "var(--text-sm)",
                            fontFamily: "var(--font-sans)", outline: "none", boxSizing: "border-box", minHeight: 44,
                          }}
                          onFocus={e => e.target.style.borderColor = "var(--border-focus)"}
                          onBlur={e => e.target.style.borderColor = "var(--border)"}
                        />
                      </div>

                      {/* Budget presets + range */}
                      <div>
                        <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: 1.5, color: "var(--text-tertiary)", textTransform: "uppercase", marginBottom: 8 }}>Budget Range</div>
                        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 10 }}>
                          {[
                            { l: "$ Under $50", min: 0, max: 50 },
                            { l: "$$ $50-150", min: 50, max: 150 },
                            { l: "$$$ $150-500", min: 150, max: 500 },
                            { l: "$$$$ $500+", min: 500, max: 2000 },
                          ].map(preset => {
                            const isActive = budgetMin === preset.min && budgetMax === preset.max;
                            return (
                              <button key={preset.l}
                                onClick={() => { setBudgetMin(preset.min); setBudgetMax(preset.max); }}
                                style={{
                                  padding: "6px 12px", borderRadius: 20, fontSize: 11, fontWeight: 600, fontFamily: "var(--font-sans)", cursor: "pointer", transition: "all .2s",
                                  background: isActive ? "rgba(201,169,110,.12)" : "var(--bg-input)",
                                  border: `1px solid ${isActive ? "rgba(201,169,110,.4)" : "var(--border)"}`,
                                  color: isActive ? "var(--accent)" : "var(--text-tertiary)",
                                }}>
                                {preset.l}
                              </button>
                            );
                          })}
                        </div>
                        <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
                          <div style={{ flex: 1 }}>
                            <div style={{ fontSize: 9, color: "var(--text-tertiary)", marginBottom: 4 }}>MIN</div>
                            <div style={{ display: "flex", alignItems: "center", background: "var(--bg-input)", border: "1px solid var(--border)", borderRadius: 10, padding: "8px 12px" }}>
                              <span style={{ color: "var(--text-tertiary)", fontSize: 14, marginRight: 4 }}>$</span>
                              <input type="number" value={budgetMin} onChange={e => setBudgetMin(Math.max(0, parseInt(e.target.value) || 0))} style={{ background: "none", border: "none", color: "var(--text-primary)", fontFamily: "var(--font-sans)", fontSize: 14, fontWeight: 600, width: "100%", outline: "none" }} />
                            </div>
                          </div>
                          <span style={{ color: "var(--text-tertiary)", fontSize: 14, marginTop: 16 }}>--</span>
                          <div style={{ flex: 1 }}>
                            <div style={{ fontSize: 9, color: "var(--text-tertiary)", marginBottom: 4 }}>MAX</div>
                            <div style={{ display: "flex", alignItems: "center", background: "var(--bg-input)", border: "1px solid var(--border)", borderRadius: 10, padding: "8px 12px" }}>
                              <span style={{ color: "var(--text-tertiary)", fontSize: 14, marginRight: 4 }}>$</span>
                              <input type="number" value={budgetMax} onChange={e => setBudgetMax(Math.max(budgetMin + 1, parseInt(e.target.value) || 0))} style={{ background: "none", border: "none", color: "var(--text-primary)", fontFamily: "var(--font-sans)", fontSize: 14, fontWeight: 600, width: "100%", outline: "none" }} />
                            </div>
                          </div>
                        </div>
                      </div>

                      {/* Update button */}
                      <button
                        onClick={() => { setPrefs(p => ({ ...p, budget_min: budgetMin, budget_max: budgetMax })); runProductSearch(); }}
                        style={{
                          width: "100%", padding: "12px 0",
                          background: "var(--accent)", color: "var(--text-inverse)", border: "none",
                          borderRadius: "var(--radius-md)", fontFamily: "var(--font-sans)",
                          fontSize: 14, fontWeight: 700, cursor: "pointer",
                        }}>
                        Update Search
                      </button>

                      {/* Complete the Look */}
                      {results?.items?.length > 0 && (
                        <div>
                          <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: 1.5, color: "var(--text-tertiary)", textTransform: "uppercase", marginBottom: 8 }}>{t("complete_look")}</div>
                          {!pairings && !pairingsLoading && (
                            <button
                              onClick={async () => {
                                setPairingsLoading(true);
                                try {
                                  const res = await API.suggestPairings(scanId, results.items.filter((_, idx) => pickedItems.has(idx)), results.gender);
                                  setPairings(res?.pairings || []);
                                  track("pairings_requested", { item_count: pickedItems.size }, scanId, "scan");
                                } catch { setPairings([]); }
                                setPairingsLoading(false);
                              }}
                              style={{ width: "100%", padding: "12px 0", background: "var(--accent-bg)", border: "1px solid var(--accent-border)", borderRadius: 12, color: "var(--accent)", fontFamily: "var(--font-sans)", fontSize: 13, fontWeight: 700, cursor: "pointer" }}>
                              Complete the Look
                            </button>
                          )}
                          {pairingsLoading && (
                            <div style={{ padding: "14px", textAlign: "center", color: "var(--text-tertiary)", fontSize: 12 }}>
                              <div className="ld-dots" style={{ justifyContent: "center", marginBottom: 6 }}><div className="ld-dot" /><div className="ld-dot" /><div className="ld-dot" /></div>
                              Finding complementary pieces...
                            </div>
                          )}
                          {pairings && pairings.length > 0 && (
                            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                              <div className="scroll-x" style={{ display: "flex", gap: 10, overflowX: "auto", paddingBottom: 4, scrollSnapType: "x mandatory", WebkitOverflowScrolling: "touch", msOverflowStyle: "none", scrollbarWidth: "none" }}>
                                {pairings.map((p, pi) => {
                                  const prod = p.product;
                                  const shopUrl = prod?.url
                                    ? API.affiliateUrl(`pairing_${scanId}_${pi}`, prod.url, scanId, 0, "pairing", prod.brand)
                                    : `https://www.google.com/search?tbm=shop&q=${encodeURIComponent(p.search_query || p.name)}`;
                                  return (
                                    <a key={pi} href={shopUrl} target="_blank" rel="noopener noreferrer"
                                      onClick={async () => {
                                        track("pairing_clicked", { name: p.name, search_query: p.search_query, category: p.category, has_product: !!prod }, scanId, "scan");
                                        authFetch(`${API_BASE}/api/suggest-pairings/track-click`, { method: "POST", body: JSON.stringify({ pairing_product_url: shopUrl, item_name: p.name }) }).catch(() => {});
                                      }}
                                      className="card-press"
                                      style={{ flexShrink: 0, width: 150, scrollSnapAlign: "start", background: "var(--accent-bg)", border: "1px solid var(--accent-border)", borderRadius: 12, textDecoration: "none", color: "inherit", overflow: "hidden" }}>
                                      {prod?.image_url ? (
                                        <div style={{ width: "100%", aspectRatio: "1", background: "var(--bg-input)", overflow: "hidden" }}>
                                          <img src={prod.image_url} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} onError={e => { e.target.style.display = "none"; }} />
                                        </div>
                                      ) : (
                                        <div style={{ width: "100%", aspectRatio: "1", background: "rgba(201,169,110,.08)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 28 }}>
                                          {{ shoes: "S", accessory: "A", bag: "B", outerwear: "O", top: "T", bottom: "B", dress: "D" }[p.category] || "?"}
                                        </div>
                                      )}
                                      <div style={{ padding: "8px 10px" }}>
                                        <div style={{ fontSize: 11, fontWeight: 500, color: "var(--text-secondary)", lineHeight: 1.3, overflow: "hidden", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical" }}>{prod?.product_name || p.name || "Item"}</div>
                                        {(prod?.brand || p.brand) && <div style={{ fontSize: 10, color: "var(--text-tertiary)" }}>{prod?.brand || p.brand}</div>}
                                        {(prod?.price || p.price) && <div style={{ fontSize: 13, fontWeight: 700, color: "var(--accent)", marginTop: 2 }}>{prod?.price || p.price}</div>}
                                        <div style={{ fontSize: 11, fontWeight: 600, color: "var(--accent)", textAlign: "center", paddingTop: 4, borderTop: "1px solid var(--border)" }}>Shop</div>
                                      </div>
                                    </a>
                                  );
                                })}
                              </div>
                              <button onClick={() => setPairings(null)} style={{ background: "none", border: "none", color: "var(--text-tertiary)", fontFamily: "var(--font-sans)", fontSize: 11, cursor: "pointer", padding: "4px 0" }}>Dismiss</button>
                            </div>
                          )}
                          {pairings && pairings.length === 0 && (
                            <div style={{ fontSize: 12, color: "var(--text-tertiary)", textAlign: "center", padding: "12px 0" }}>Outfit looks complete.</div>
                          )}
                        </div>
                      )}

                      {/* Share buttons */}
                      {scanId && (
                        <div style={{ display: "flex", gap: 8 }}>
                          <button
                            aria-label="Share Your Look"
                            onClick={async () => {
                              const shareUrl = `${window.location.origin}/scan/${scanId}`;
                              const shareData = { title: "ATTAIRE - Check out this outfit", text: results?.summary || "Check out this outfit I scanned on ATTAIRE!", url: shareUrl };
                              if (navigator.share) {
                                try { await navigator.share(shareData); track("share_link", { method: "native" }, scanId, "scan"); } catch {}
                              } else {
                                try {
                                  await navigator.clipboard.writeText(shareUrl);
                                  setShareLinkCopied(true);
                                  setTimeout(() => setShareLinkCopied(false), 2000);
                                  track("share_link", { method: "clipboard" }, scanId, "scan");
                                } catch {}
                              }
                            }}
                            style={{
                              flex: 1, display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
                              padding: "12px 16px", minHeight: 44,
                              background: "var(--bg-input)", color: "var(--text-secondary)",
                              border: "1px solid var(--border)", borderRadius: "var(--radius-md)",
                              fontFamily: "var(--font-sans)", fontSize: 12, fontWeight: 600, cursor: "pointer",
                            }}
                          >
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>
                            {shareLinkCopied ? "Copied!" : "Share"}
                          </button>
                          <button
                            aria-label="Share Card"
                            disabled={shareCardLoading}
                            onClick={async () => {
                              setShareCardLoading(true);
                              try {
                                const userName = authName || (authEmail ? authEmail.split("@")[0] : "");
                                const cardDataUrl = await generateShareCard({
                                  imageUrl: img,
                                  summary: results?.summary,
                                  items: results?.items?.filter((_, idx) => pickedItems.has(idx)),
                                  verdict: scanVerdicts[scanId],
                                  userName,
                                });
                                const res = await fetch(cardDataUrl);
                                const blob = await res.blob();
                                const file = new File([blob], "attair-outfit.png", { type: "image/png" });
                                if (navigator.share && navigator.canShare?.({ files: [file] })) {
                                  try { await navigator.share({ title: "My ATTAIRE Outfit", files: [file] }); track("share_card", { method: "native" }, scanId, "scan"); } catch {}
                                } else {
                                  const a = document.createElement("a");
                                  a.href = cardDataUrl;
                                  a.download = "attair-outfit.png";
                                  document.body.appendChild(a);
                                  a.click();
                                  document.body.removeChild(a);
                                  track("share_card", { method: "download" }, scanId, "scan");
                                }
                              } catch (e) { console.error("Share card generation failed:", e); }
                              setShareCardLoading(false);
                            }}
                            style={{
                              display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
                              padding: "12px 16px", minHeight: 44,
                              background: "var(--bg-input)", color: "var(--text-secondary)",
                              border: "1px solid var(--border)", borderRadius: "var(--radius-md)",
                              fontFamily: "var(--font-sans)", fontSize: 12, fontWeight: 600, cursor: "pointer",
                              opacity: shareCardLoading ? 0.6 : 1,
                            }}
                          >
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
                            {shareCardLoading ? "..." : "Share Card"}
                          </button>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}

              <div className="aff-note" style={{ padding: "8px 20px 16px" }}>Links may include affiliate partnerships</div>
            </div>
          )}

          {/* History tab removed — scan history is integrated in Profile grid.
             Dead code (~430 lines) was removed in the Run 6 quality sweep. */}

          {/* ─── Saved tab (clean Pinterest grid) ─────────── */}
          {tab === "likes" && (() => {
            // Derive unique categories from all saved items
            const categories = [...new Set(saved.map(s => (s.item_data || s).category).filter(Boolean))];

            // Apply category + search filter
            let allSavedItems = likesCategoryFilter === "all"
              ? saved
              : saved.filter(s => (s.item_data || s).category === likesCategoryFilter);
            if (savedSearchQuery.trim()) {
              const q = savedSearchQuery.toLowerCase();
              allSavedItems = allSavedItems.filter(s => {
                const item = s.item_data || s;
                return (item.name || "").toLowerCase().includes(q) || (item.brand || "").toLowerCase().includes(q) || (item.category || "").toLowerCase().includes(q);
              });
            }

            // Split into 2 columns for masonry
            const col1 = [], col2 = [];
            allSavedItems.forEach((s, i) => (i % 2 === 0 ? col1 : col2).push(s));

            const renderCard = (s) => {
              const item = s.item_data || s;
              return (
                <div key={s.id} className="likes-v2-card card-press" onClick={() => { if (item.url) window.open(item.url, "_blank"); }} style={{ cursor: item.url ? "pointer" : "default" }}>
                  <div style={{ position: "relative" }}>
                    {item.image_url ? (
                      <img className="likes-v2-card-img" style={{ aspectRatio: "3/4", objectFit: "cover" }} src={item.image_url} alt={item.name} loading="lazy" onError={e => { e.target.style.display = "none"; }} />
                    ) : (
                      <div className="likes-v2-card-img-placeholder" style={{ aspectRatio: "3/4" }}>
                        {{ shoes: "\uD83D\uDC5F", accessory: "\u231A", bag: "\uD83D\uDC5C", outerwear: "\uD83E\uDDE5", top: "\uD83D\uDC55", bottom: "\uD83D\uDC56", dress: "\uD83D\uDC57" }[item.category] || "\u2726"}
                      </div>
                    )}
                    <button className="likes-v2-heart" aria-label={`Remove ${item.name} from saved`} onClick={async (e) => { e.stopPropagation(); await API.deleteSaved(s.id).catch(() => {}); setSaved(prev => prev.filter(x => x.id !== s.id)); refreshStatus(); }}>
                      <svg viewBox="0 0 24 24"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>
                    </button>
                  </div>
                  <div className="likes-v2-card-body">
                    {item.brand && item.brand !== "Unidentified" && <div className="likes-v2-card-brand">{item.brand}</div>}
                    <div className="likes-v2-card-name" style={{ WebkitLineClamp: 1 }}>{item.name}</div>
                    {item.price && <div className="likes-v2-card-price">{item.price}</div>}
                  </div>
                </div>
              );
            };

            return (
              <div className="likes-v2 animate-fade-in">
                {/* Price Drop Alerts Banner */}
                {priceAlertCount > 0 && (
                  <button onClick={() => { setShowPriceAlerts(true); API.priceAlerts().then(d => setPriceAlerts(d.alerts || d || [])).catch(() => {}); }}
                    aria-label={`${priceAlertCount} price drops on saved items`}
                    style={{
                      width: "calc(100% - 32px)", margin: "12px 16px 0", padding: "12px 16px",
                      background: "linear-gradient(135deg, rgba(76,175,80,.1), rgba(76,175,80,.05))",
                      border: "1px solid rgba(76,175,80,.25)", borderRadius: "var(--radius-sm)",
                      display: "flex", alignItems: "center", gap: 10, cursor: "pointer",
                      color: "var(--text-primary)", fontSize: 14, fontWeight: 600, fontFamily: "var(--font-sans)"
                    }}>
                    <span style={{ fontSize: 20 }}>&#x1F4B0;</span>
                    <span>{priceAlertCount} price drop{priceAlertCount !== 1 ? "s" : ""} on your saved items!</span>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ marginLeft: "auto" }}><polyline points="9 18 15 12 9 6"/></svg>
                  </button>
                )}

                {/* Header */}
                <div style={{ padding: "16px 16px 4px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                  <h2 style={{ fontSize: 22, fontWeight: 700, color: "var(--text-primary)", margin: 0 }}>Saved</h2>
                  {saved.length > 0 && <span style={{ fontSize: 13, color: "var(--text-tertiary)", fontWeight: 500 }}>{saved.length} item{saved.length !== 1 ? "s" : ""}</span>}
                </div>

                {/* Search bar */}
                {saved.length > 0 && (
                  <div style={{ padding: "8px 16px 0" }}>
                    <div style={{ position: "relative" }}>
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--text-tertiary)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ position: "absolute", left: 12, top: "50%", transform: "translateY(-50%)" }}><circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/></svg>
                      <input
                        placeholder="Search saved items..."
                        value={savedSearchQuery}
                        onChange={e => setSavedSearchQuery(e.target.value)}
                        style={{ width: "100%", padding: "10px 12px 10px 36px", background: "var(--bg-input)", border: "1px solid var(--border)", borderRadius: "var(--radius-full)", color: "var(--text-primary)", fontSize: 14, fontFamily: "var(--font-sans)", outline: "none", minHeight: 44, boxSizing: "border-box" }}
                      />
                    </div>
                  </div>
                )}

                {/* Filter Chips */}
                {saved.length > 0 && (
                  <div className="likes-v2-chips scroll-x" role="tablist" aria-label="Filter saved items">
                    <button className={`chip${likesCategoryFilter === "all" ? " active" : ""}`} onClick={() => setLikesCategoryFilter("all")} style={{ whiteSpace: "nowrap", flexShrink: 0 }}>All</button>
                    {categories.map(cat => (
                      <button key={cat} className={`chip${likesCategoryFilter === cat ? " active" : ""}`} onClick={() => setLikesCategoryFilter(cat)} style={{ whiteSpace: "nowrap", flexShrink: 0, textTransform: "capitalize" }}>{cat}</button>
                    ))}
                  </div>
                )}

                {/* Content */}
                {allSavedItems.length === 0 ? (
                  <div style={{ padding: "80px 32px", textAlign: "center", display: "flex", flexDirection: "column", alignItems: "center", gap: 8 }}>
                    <svg width="56" height="56" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.12, marginBottom: 8 }}>
                      <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/>
                    </svg>
                    <div style={{ fontSize: 16, fontWeight: 600, color: "var(--text-primary)" }}>{saved.length === 0 ? "No saved items yet" : "No items match this filter"}</div>
                    <div style={{ fontSize: 13, color: "var(--text-tertiary)", lineHeight: 1.5, maxWidth: 240 }}>
                      {saved.length === 0 ? "Scan outfits and save items you love" : "Try a different category"}
                    </div>
                    {saved.length === 0 && (
                      <button className="btn-primary" style={{ marginTop: 12 }} onClick={() => fileRef.current?.click()}>Scan an Outfit</button>
                    )}
                  </div>
                ) : (
                  <div className="likes-v2-masonry">
                    <div className="likes-v2-col">{col1.map(renderCard)}</div>
                    <div className="likes-v2-col">{col2.map(renderCard)}</div>
                  </div>
                )}
              </div>
            );
          })()}

          {/* ─── Profile (TikTok/IG Style) ──────────────── */}
          {tab === "profile" && (() => {
            const profileScansCount = history.length;
            return (
            <div className="profile-v2">
              {/* Top bar: username left, gear icon right (Instagram style) */}
              <div className="profile-v2-topbar">
                <div className="profile-v2-username">{authName || authEmail?.split("@")[0] || "User"}</div>
                <button className="profile-v2-gear" aria-label="Open settings" onClick={() => setProfileSettingsOpen(true)}>
                  <svg viewBox="0 0 24 24" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
                </button>
              </div>

              {/* Profile info row: avatar left, stats right (Instagram layout) */}
              <div className="profile-v2-row">
                <div className="profile-v2-avatar" aria-label="Profile avatar">
                  {(authName || authEmail || "U")[0].toUpperCase()}
                </div>
                <div className="profile-v2-stats" role="list" aria-label="Profile statistics">
                  <div className="profile-v2-stat" role="listitem">
                    <div className="profile-stat-val">{profileScansCount}</div>
                    <div className="profile-stat-lbl">Scans</div>
                  </div>
                  <div className="profile-v2-stat" role="listitem">
                    <div className="profile-stat-val">{profileStats?.followers_count ?? 0}</div>
                    <div className="profile-stat-lbl">Followers</div>
                  </div>
                  <div className="profile-v2-stat" role="listitem">
                    <div className="profile-stat-val">{profileStats?.following_count ?? 0}</div>
                    <div className="profile-stat-lbl">Following</div>
                  </div>
                </div>
              </div>

              {/* Name + bio + edit button */}
              <div style={{ padding: "12px 20px 0" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <div style={{ fontSize: 16, fontWeight: 700, color: "var(--text-primary)" }}>
                    {authName || authEmail?.split("@")[0] || "User"}
                  </div>
                  {isPro && <span className="pro" style={{ verticalAlign: "middle" }}>PRO</span>}
                </div>
                {profileBioEditing ? (
                  <div style={{ marginTop: 6, maxWidth: 360 }}>
                    <textarea className="profile-bio-area" rows={3} maxLength={200} autoFocus value={profileBio} onChange={e => setProfileBio(e.target.value.slice(0, 200))} placeholder="Tell people about your style..." aria-label="Edit your bio" />
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 4 }}>
                      <span style={{ fontSize: 10, color: "var(--text-tertiary)" }}>{profileBio.length}/200</span>
                      <div style={{ display: "flex", gap: 6 }}>
                        <button className="btn-ghost" style={{ padding: "6px 14px", fontSize: 12 }} onClick={() => setProfileBioEditing(false)}>Cancel</button>
                        <button className="btn-primary" style={{ padding: "6px 14px", fontSize: 12 }} onClick={async () => { setProfileBioSaving(true); try { await API.updateProfile({ bio: profileBio }); } catch {} setProfileBioSaving(false); setProfileBioEditing(false); }}>{profileBioSaving ? "Saving..." : "Save"}</button>
                      </div>
                    </div>
                  </div>
                ) : (
                  <div style={{ fontSize: 14, color: "var(--text-secondary)", marginTop: 4, lineHeight: 1.4, display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>
                    {profileBio || <span style={{ fontStyle: "italic", color: "var(--text-tertiary)" }}>No bio yet</span>}
                  </div>
                )}
                {/* Edit Profile button */}
                <button className="btn-secondary" style={{ width: "100%", marginTop: 12, padding: "8px 0", fontSize: 14, fontWeight: 600, borderRadius: "var(--radius-sm)" }} onClick={() => setProfileBioEditing(true)}>Edit Profile</button>

                {/* Style DNA button */}
                {styleDna?.ready ? (
                  <button onClick={() => setShowStyleDna(true)} aria-label="View your Style DNA report" style={{
                    width: "100%", marginTop: 8, padding: "12px 0", fontSize: 14, fontWeight: 600,
                    borderRadius: "var(--radius-sm)", background: "linear-gradient(135deg, rgba(201,169,110,.12), rgba(201,169,110,.04))",
                    border: "1px solid rgba(201,169,110,.25)", color: "var(--accent)",
                    cursor: "pointer", fontFamily: "var(--font-sans)", letterSpacing: 0.3,
                    display: "flex", alignItems: "center", justifyContent: "center", gap: 8
                  }}>
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 2L15.09 8.26L22 9.27L17 14.14L18.18 21.02L12 17.77L5.82 21.02L7 14.14L2 9.27L8.91 8.26L12 2Z"/></svg>
                    Your Style DNA: {styleDna.archetype}
                  </button>
                ) : styleDna && !styleDna.ready ? (
                  <div style={{
                    width: "100%", marginTop: 8, padding: "10px 16px", fontSize: 13,
                    borderRadius: "var(--radius-sm)", background: "var(--bg-card)", border: "1px solid var(--border)",
                    color: "var(--text-tertiary)", textAlign: "center", fontFamily: "var(--font-sans)"
                  }}>
                    {styleDna.message}
                  </div>
                ) : null}
              </div>

              {/* Trial banner */}
              {userStatus?.tier === "trial" && userStatus?.trial_ends_at && (() => {
                const daysLeft = Math.ceil((new Date(userStatus.trial_ends_at) - Date.now()) / 86400000);
                return daysLeft > 0 ? <div style={{ margin: "12px 20px 0", display: "inline-flex", alignItems: "center", gap: 5, fontSize: 12, padding: "6px 14px", borderRadius: "var(--radius-sm)", background: "rgba(255,107,53,.1)", border: "1px solid rgba(255,107,53,.25)", color: "#FF6B35", fontWeight: 600 }}>{daysLeft} day{daysLeft !== 1 ? "s" : ""} left in trial</div> : null;
              })()}

              {/* Grid divider */}
              <div style={{ margin: "16px 0 0", borderTop: "1px solid var(--border)" }} />

              {/* 3-column scan grid */}
              <div style={{ paddingBottom: 80 }}>
                {history.length === 0 ? (
                  <div className="empty" style={{ padding: "48px 20px" }}>
                    <div style={{ fontSize: 40, opacity: 0.15, marginBottom: 12 }}><svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="2" y="6" width="20" height="14" rx="3"/><circle cx="12" cy="13" r="4"/><path d="M8 6l1.5-3h5L16 6"/></svg></div>
                    <div className="empty-t">No scans yet</div>
                    <div className="empty-s">Your outfit scans will appear here</div>
                    <button className="btn-primary" style={{ marginTop: 12, opacity: 0.85 }} onClick={() => setTab("home")}>Start exploring</button>
                  </div>
                ) : (
                  <div className="profile-v2-grid">
                    {history.map((hx) => {
                      const hxImg = hx.image_thumbnail || hx.image_url;
                      const hxItems = hx.items || [];
                      return (
                        <div key={hx.id} className="profile-v2-grid-cell" onClick={() => setProfileScanOverlay(hx)} aria-label={`Scan: ${hxItems.length} items`}>
                          {hxImg ? <img src={hxImg} alt="" loading="lazy" onError={e => { e.target.style.display = "none"; }} /> : <div className="profile-v2-grid-placeholder">{hx.detected_gender === "female" ? "\uD83D\uDC57" : "\uD83D\uDC54"}</div>}
                          {hxItems.length > 0 && <span className="grid-items-badge">{hxItems.length}</span>}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              {/* Scan detail overlay */}
              {profileScanOverlay && (() => {
                const hs = profileScanOverlay, hsItems = hs.items || [], hsImg = hs.image_url || hs.image_thumbnail;
                return (
                  <div className="scan-overlay" role="dialog" aria-label="Scan details" aria-modal="true">
                    <button className="scan-overlay-close" onClick={() => setProfileScanOverlay(null)} aria-label="Close"><svg viewBox="0 0 24 24"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
                    {hsImg && <img className="scan-overlay-img" src={hsImg} alt="Scan" />}
                    <div className="scan-overlay-body">
                      <div className="scan-overlay-meta">
                        <span className="scan-overlay-tag">{hsItems.length} item{hsItems.length !== 1 ? "s" : ""}</span>
                        <span style={{ fontSize: "var(--text-xs)", color: "var(--text-tertiary)" }}>{new Date(hs.created_at).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}</span>
                        {hs.detected_gender && <span className="scan-overlay-tag">{hs.detected_gender}</span>}
                      </div>
                      {hs.summary && <div className="scan-overlay-summary">{hs.summary}</div>}
                      {hsItems.length > 0 && <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                        <div className="sec-t">Identified Items</div>
                        {hsItems.map((it, idx) => (
                          <div key={idx} style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 12px", background: "var(--bg-card)", border: "1px solid var(--border)", borderRadius: "var(--radius-sm)" }}>
                            <div style={{ width: 36, height: 36, borderRadius: "var(--radius-sm)", background: "var(--accent-bg)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 16, flexShrink: 0 }}>{{ shoes: "\uD83D\uDC5F", accessory: "\u231A", bag: "\uD83D\uDC5C", outerwear: "\uD83E\uDDE5", top: "\uD83D\uDC55", bottom: "\uD83D\uDC56", dress: "\uD83D\uDC57" }[it.category] || "\u2726"}</div>
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <div style={{ fontSize: "var(--text-sm)", fontWeight: 600, color: "var(--text-primary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{it.name}</div>
                              <div style={{ fontSize: "var(--text-xs)", color: "var(--text-tertiary)" }}>{it.brand || it.category}</div>
                            </div>
                          </div>
                        ))}
                      </div>}
                      <button className="btn-primary" style={{ width: "100%", marginTop: 16 }} onClick={() => {
                        setResults({ gender: hs.detected_gender || "male", summary: hs.summary || "", items: hsItems.map(it => ({ ...it, status: hs.tiers ? "verified" : "identified", tiers: null })) });
                        if (hs.tiers && Array.isArray(hs.tiers)) setResults(prev => prev ? { ...prev, items: prev.items.map((item, idx) => { const sr = hs.tiers.find(t2 => t2.item_index === idx); return sr?.tiers ? { ...item, status: "verified", tiers: sr.tiers } : item; }) } : prev);
                        setImg(hs.image_url || hs.image_thumbnail || null);
                        setScanId(hs.id); setSelIdx(0); setPickedItems(new Set((hs.tiers || []).map(t2 => t2.item_index))); setPhase("done"); setTab("scan"); setProfileScanOverlay(null);
                      }}>View Full Results</button>
                    </div>
                  </div>
                );
              })()}

              {/* Settings bottom sheet */}
              {profileSettingsOpen && <>
                <div className="bottom-sheet-overlay" onClick={() => setProfileSettingsOpen(false)} />
                <div className="bottom-sheet" role="dialog" aria-label="Settings" aria-modal="true">
                  <div className="bottom-sheet-handle" />
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20 }}>
                    <div style={{ fontSize: 18, fontWeight: 700, color: "var(--text-primary)" }}>Settings</div>
                    <button onClick={() => setProfileSettingsOpen(false)} aria-label="Close settings" style={{ width: 32, height: 32, display: "flex", alignItems: "center", justifyContent: "center", background: "none", border: "none", cursor: "pointer", borderRadius: "50%", color: "var(--text-secondary)" }}>
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                    </button>
                  </div>

                  {/* Theme toggle */}
                  <div className="settings-sheet-item" onClick={toggleTheme} role="button" aria-label="Toggle theme">
                    <span className="settings-label">Appearance</span>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <span className="settings-value">{theme === "dark" ? "Dark" : "Light"}</span>
                      <div style={{ width: 44, height: 26, borderRadius: 13, background: theme === "dark" ? "var(--accent)" : "var(--border)", position: "relative", transition: "background 0.2s", cursor: "pointer", flexShrink: 0 }}>
                        <div style={{ width: 20, height: 20, borderRadius: "50%", background: "#fff", position: "absolute", top: 3, left: theme === "dark" ? 21 : 3, transition: "left 0.2s", boxShadow: "0 1px 3px rgba(0,0,0,.2)" }} />
                      </div>
                    </div>
                  </div>

                  {/* Language */}
                  <div className="settings-sheet-item" style={{ alignItems: "flex-start", flexDirection: "column", gap: 8, cursor: "default" }}>
                    <span className="settings-label">Language</span>
                    <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                      {[["en","EN"],["es","ES"],["fr","FR"],["de","DE"],["zh","\u4E2D"],["ja","\u65E5"],["ko","\uD55C"],["pt","PT"]].map(([l, label]) => (
                        <button key={l} className={`chip${lang === l ? " active" : ""}`} onClick={() => { setLang(l); localStorage.setItem("attair_lang", l); }} style={{ padding: "8px 14px", fontSize: 12, minHeight: 44 }}>{label}</button>
                      ))}
                    </div>
                  </div>

                  {/* Budget / Size info */}
                  <div className="settings-sheet-item" style={{ cursor: "default" }}>
                    <span className="settings-label">Budget Range</span>
                    <span className="settings-value">${budgetMin} - ${budgetMax}{budgetMax >= 1000 ? "+" : ""}</span>
                  </div>
                  <div className="settings-sheet-item" style={{ cursor: "default" }}>
                    <span className="settings-label">Size Preferences</span>
                    <span className="settings-value">{(sizePrefs.body_type || []).length > 0 ? (sizePrefs.body_type || []).join(", ") : "Not set"}</span>
                  </div>

                  {/* Subscription */}
                  <div className="settings-sheet-item" style={{ cursor: "default" }}>
                    <span className="settings-label">Subscription</span>
                    <span className="settings-value" style={{ color: isPro ? "var(--accent)" : undefined }}>{isPro ? "Pro" : "Free"}</span>
                  </div>
                  {isFree && (
                    <button className="btn-primary" style={{ width: "100%", margin: "8px 0 12px", padding: "10px 0", fontSize: 14, fontWeight: 600 }} onClick={() => { setProfileSettingsOpen(false); setUpgradeModal("general"); }}>
                      Upgrade to Pro
                    </button>
                  )}

                  {/* Referral */}
                  {referralCode && (
                    <div style={{ padding: "14px 0", borderTop: "1px solid var(--border)" }}>
                      <div style={{ fontSize: 14, fontWeight: 600, color: "var(--text-primary)", marginBottom: 6 }}>Refer a friend</div>
                      <div style={{ fontSize: 12, color: "var(--text-tertiary)", marginBottom: 10, lineHeight: 1.4 }}>Share your code. Both of you get $5 credit.</div>
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <div style={{ flex: 1, padding: "8px 12px", background: "var(--accent-bg)", border: "1px solid var(--accent-border)", borderRadius: "var(--radius-sm)", fontWeight: 800, color: "var(--accent)", letterSpacing: 2, fontSize: 14, fontFamily: "var(--font-sans)" }}>{referralCode}</div>
                        <button className="btn-secondary" style={{ padding: "8px 14px", fontSize: 12, whiteSpace: "nowrap" }} onClick={() => {
                          navigator.clipboard.writeText(referralCode).then(() => { setReferralCopied(true); setTimeout(() => setReferralCopied(false), 2000); }).catch(() => {});
                        }}>{referralCopied ? "Copied" : "Copy"}</button>
                      </div>
                    </div>
                  )}

                  {/* Sign out */}
                  <div className="settings-sheet-item danger" style={{ marginTop: 8 }} onClick={() => { setProfileSettingsOpen(false); handleLogout(); }} role="button" aria-label="Sign out">{t("log_out")}</div>
                </div>
              </>}
            </div>
            );
          })()}

        </div>

        {/* ─── Per-item preferences popup ─────────────── */}
        {itemSettingsIdx !== null && results?.items[itemSettingsIdx] && (() => {
          const idx = itemSettingsIdx;
          const item = results.items[idx];
          const isPicked = pickedItems.has(idx);
          const ov = itemOverrides[idx] || { budget: budgetMax, sizePrefs: { body_type: [...(sizePrefs.body_type||[])], fit: [...(sizePrefs.fit||[])], sizes: { ...(sizePrefs.sizes||{}) } }, marketPref: "both" };
          const setOv = (updater) => setItemOverrides(o => ({ ...o, [idx]: typeof updater === "function" ? updater(o[idx] || ov) : updater }));

          // Determine the most relevant size for this item
          const cat = (item.category||"").toLowerCase(), sub = (item.subcategory||"").toLowerCase(), combined = cat+" "+sub;
          let sizeInfo = null;
          if (["jean","denim"].some(k=>combined.includes(k))) sizeInfo = { key:"jeans", label:"Jean size", opts:["24","25","26","27","28","29","30","31","32","33","34","36","38","40"] };
          else if (["short"].some(k=>combined.includes(k))) sizeInfo = { key:"shorts", label:"Shorts size", opts:["XS","S","M","L","XL","XXL"] };
          else if (["pant","trouser","chino","legging"].some(k=>combined.includes(k))||cat==="bottom") sizeInfo = { key:"bottoms", label:"Bottom size", opts:["24","26","28","30","32","34","36","38","40","42"] };
          else if (["shirt","tee","blouse","polo","sweater","hoodie","pullover","sweatshirt"].some(k=>combined.includes(k))||cat==="top") sizeInfo = { key:"tops", label:"Top size", opts:["XS","S","M","L","XL","XXL","XXXL"] };
          else if (["jacket","coat","blazer","parka","bomber"].some(k=>combined.includes(k))||cat==="outerwear") sizeInfo = { key:"outerwear", label:"Outerwear size", opts:["XS","S","M","L","XL","XXL"] };
          else if (["dress","gown","romper","jumpsuit","skirt"].some(k=>combined.includes(k))||cat==="dress") sizeInfo = { key:"dresses", label:"Dress size", opts:["0","2","4","6","8","10","12","14","16","XS","S","M","L","XL"] };
          else if (["shoe","sneaker","boot","sandal","loafer","heel"].some(k=>combined.includes(k))||cat==="shoes") sizeInfo = { key:"shoes", label:"Shoe size", opts:["5","5.5","6","6.5","7","7.5","8","8.5","9","9.5","10","10.5","11","11.5","12","13","14"] };
          else if (["sock"].some(k=>combined.includes(k))) sizeInfo = { key:"socks", label:"Sock size", opts:["S","M","L","XL"] };

          const bMin = ov.budgetMin ?? budgetMin;
          const bMax = ov.budgetMax ?? budgetMax;
          const spVal = ov.sizePrefs || {};

          return (
            <>
              <div className="item-opts-overlay" onClick={() => setItemSettingsIdx(null)} />
              <div className="item-opts-sheet">
                <div className="item-opts-handle" />
                {/* Header */}
                <div style={{ marginBottom: 18 }}>
                  <div style={{ fontSize: 16, fontWeight: 700, color: "var(--text-primary)", marginBottom: 3 }}>{item.name}</div>
                  <div style={{ fontSize: 11, color: "var(--text-tertiary)" }}>{item.subcategory || item.category}</div>
                </div>

                {/* Include toggle */}
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 14px", background: "var(--bg-input)", border: "1px solid var(--border)", borderRadius: 12, marginBottom: 20 }}
                  onClick={() => setPickedItems(prev => { const n = new Set(prev); if (n.has(idx)) n.delete(idx); else n.add(idx); return n; })}>
                  <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text-secondary)" }}>Include in search</span>
                  <div style={{ width: 42, height: 24, borderRadius: 12, background: isPicked ? "var(--accent)" : "var(--border)", position: "relative", transition: "background .2s", cursor: "pointer" }}>
                    <div style={{ position: "absolute", top: 3, left: isPicked ? 21 : 3, width: 18, height: 18, borderRadius: 9, background: "#fff", transition: "left .2s" }} />
                  </div>
                </div>

                {/* Market type preference */}
                <div style={{ marginBottom: 20 }}>
                  <div className="item-opts-label">Market type</div>
                  <div style={{ display: "flex", gap: 7 }}>
                    {[
                      { l: "All", v: "both", desc: "Retail + resale" },
                      { l: "Retail only", v: "retail", desc: "Direct from brands & stores" },
                      { l: "Resale only", v: "resale", desc: "Pre-owned & secondary market" },
                    ].map(o => {
                      const on = (ov.marketPref || "both") === o.v;
                      return (
                        <div key={o.v}
                          style={{ flex: 1, padding: "8px 6px", textAlign: "center", background: on ? "rgba(201,169,110,.1)" : "var(--bg-input)", border: `1px solid ${on ? "rgba(201,169,110,.4)" : "var(--border)"}`, borderRadius: 10, cursor: "pointer", transition: "all .2s" }}
                          onClick={() => setOv(o2 => ({ ...(o2 || ov), marketPref: o.v }))}>
                          <div style={{ fontSize: 12, fontWeight: 600, color: on ? "var(--accent)" : "var(--text-secondary)", marginBottom: 2 }}>{o.l}</div>
                          <div style={{ fontSize: 9, color: on ? "rgba(201,169,110,.55)" : "var(--text-tertiary)", lineHeight: 1.3 }}>{o.desc}</div>
                        </div>
                      );
                    })}
                  </div>
                </div>

                {/* Budget — range slider + preset chips */}
                <div style={{ marginBottom: 24 }}>
                  <div className="item-opts-label">Budget range for this item</div>

                  {/* Dual range slider */}
                  <div style={{ position: "relative", height: 40, marginBottom: 8 }}>
                    <div style={{ position: "absolute", top: 18, left: 0, right: 0, height: 4, background: "var(--border)", borderRadius: 2 }} />
                    <div style={{ position: "absolute", top: 18, left: `${Math.max(0, (bMin / 1000) * 100)}%`, right: `${Math.max(0, 100 - (bMax / 1000) * 100)}%`, height: 4, background: "var(--accent)", borderRadius: 2, transition: "left var(--transition-fast), right var(--transition-fast)" }} />
                    <input
                      type="range" min="0" max="1000" step="10" value={bMin}
                      aria-label="Minimum budget"
                      onChange={e => {
                        const val = parseInt(e.target.value);
                        if (val < bMax) setOv(o2 => ({ ...(o2 || ov), budgetMin: val }));
                      }}
                      style={{ position: "absolute", top: 8, left: 0, width: "100%", height: 24, WebkitAppearance: "none", appearance: "none", background: "transparent", pointerEvents: "none", zIndex: 2, margin: 0 }}
                      className="budget-range-thumb"
                    />
                    <input
                      type="range" min="0" max="1000" step="10" value={bMax}
                      aria-label="Maximum budget"
                      onChange={e => {
                        const val = parseInt(e.target.value);
                        if (val > bMin) setOv(o2 => ({ ...(o2 || ov), budgetMax: val }));
                      }}
                      style={{ position: "absolute", top: 8, left: 0, width: "100%", height: 24, WebkitAppearance: "none", appearance: "none", background: "transparent", pointerEvents: "none", zIndex: 3, margin: 0 }}
                      className="budget-range-thumb"
                    />
                  </div>

                  {/* Display range */}
                  <div style={{ textAlign: "center", fontSize: 14, fontWeight: 600, color: "var(--accent)", marginBottom: 10 }}>
                    ${bMin} – ${bMax}{bMax >= 1000 ? "+" : ""}
                  </div>

                  {/* Preset chips */}
                  <div style={{ display: "flex", gap: 6, justifyContent: "center" }}>
                    {[
                      { label: "$", min: 0, max: 50 },
                      { label: "$$", min: 50, max: 150 },
                      { label: "$$$", min: 150, max: 500 },
                      { label: "$$$$", min: 500, max: 1000 },
                    ].map(preset => {
                      const isPresetActive = bMin === preset.min && bMax === preset.max;
                      return (
                        <button
                          key={preset.label}
                          aria-label={`Set budget to ${preset.label} range: $${preset.min} to $${preset.max}`}
                          onClick={() => setOv(o2 => ({ ...(o2 || ov), budgetMin: preset.min, budgetMax: preset.max }))}
                          style={{
                            flex: 1, padding: "8px 6px", minHeight: 44,
                            background: isPresetActive ? "var(--accent-bg)" : "var(--bg-input)",
                            border: `1px solid ${isPresetActive ? "var(--accent-border)" : "var(--border)"}`,
                            borderRadius: "var(--radius-sm)", cursor: "pointer",
                            fontFamily: "var(--font-sans)", fontSize: 13, fontWeight: 600,
                            color: isPresetActive ? "var(--accent)" : "var(--text-tertiary)",
                            transition: "all var(--transition-fast)",
                          }}
                        >{preset.label}</button>
                      );
                    })}
                  </div>
                  <div style={{ fontSize: 10, color: "var(--text-tertiary)", marginTop: 8, textAlign: "center" }}>
                    Budget: under ${bMin} · Mid: ${bMin}–${bMax} · Premium: ${bMax}+
                  </div>
                </div>

                {/* Body type */}
                <div style={{ marginBottom: 16 }}>
                  <div className="item-opts-label">Body type</div>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 7 }}>
                    {[{l:"Standard",v:"standard"},{l:"Petite",v:"petite"},{l:"Tall",v:"tall"},{l:"Plus Size",v:"plus"},{l:"Big & Tall",v:"big_tall"},{l:"Athletic",v:"athletic"},{l:"Curvy",v:"curvy"}].map(o => {
                      const on = (spVal.body_type||[]).includes(o.v);
                      return <div key={o.v} style={{ padding:"6px 13px", background: on?"rgba(201,169,110,.1)":"var(--bg-input)", border:`1px solid ${on?"rgba(201,169,110,.4)":"var(--border)"}`, borderRadius:100, cursor:"pointer", fontSize:12, fontWeight:500, color: on?"var(--accent)":"var(--text-secondary)", transition:"all .2s" }}
                        onClick={() => { const a=spVal.body_type||[]; setOv(o2 => ({ ...(o2||ov), sizePrefs: { ...(o2||ov).sizePrefs, body_type: a.includes(o.v)?a.filter(x=>x!==o.v):[...a,o.v] } })); }}>{o.l}</div>;
                    })}
                  </div>
                </div>

                {/* Fit style */}
                <div style={{ marginBottom: sizeInfo ? 16 : 0 }}>
                  <div className="item-opts-label">Fit style</div>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 7 }}>
                    {[{l:"Slim/Fitted",v:"slim"},{l:"Regular",v:"regular"},{l:"Relaxed",v:"relaxed"},{l:"Oversized",v:"oversized"},{l:"Flowy",v:"flowy"}].map(o => {
                      const on = (spVal.fit||[]).includes(o.v);
                      return <div key={o.v} style={{ padding:"6px 13px", background: on?"rgba(201,169,110,.1)":"var(--bg-input)", border:`1px solid ${on?"rgba(201,169,110,.4)":"var(--border)"}`, borderRadius:100, cursor:"pointer", fontSize:12, fontWeight:500, color: on?"var(--accent)":"var(--text-secondary)", transition:"all .2s" }}
                        onClick={() => { const a=spVal.fit||[]; setOv(o2 => ({ ...(o2||ov), sizePrefs: { ...(o2||ov).sizePrefs, fit: a.includes(o.v)?a.filter(x=>x!==o.v):[...a,o.v] } })); }}>{o.l}</div>;
                    })}
                  </div>
                </div>

                {/* Relevant size */}
                {sizeInfo && (
                  <div style={{ marginTop: 0 }}>
                    <div className="item-opts-label">{sizeInfo.label}</div>
                    <select value={spVal.sizes?.[sizeInfo.key]||""} onChange={e => setOv(o2 => ({ ...(o2||ov), sizePrefs: { ...(o2||ov).sizePrefs, sizes: { ...((o2||ov).sizePrefs?.sizes||{}), [sizeInfo.key]: e.target.value||null } } }))}
                      style={{ width:"100%", background:"var(--bg-input)", border:"1px solid var(--border)", borderRadius:10, color: spVal.sizes?.[sizeInfo.key]?"var(--text-primary)":"var(--text-tertiary)", fontSize:14, padding:"12px 14px", fontFamily:"var(--font-sans)", cursor:"pointer", outline:"none", minHeight:44 }}>
                      <option value="" style={{color:"#111",background:"#fff"}}>Not set</option>
                      {sizeInfo.opts.map(o=><option key={o} value={o} style={{color:"#111",background:"#fff"}}>{o}</option>)}
                    </select>
                  </div>
                )}

                <button onClick={() => setItemSettingsIdx(null)}
                  className="btn-primary" style={{ width:"100%", marginTop:22 }}>
                  Done
                </button>
              </div>
            </>
          );
        })()}

        {/* ─── User Search Overlay (hidden on Search tab — it has its own inline search) ── */}
        {showUserSearch && tab !== "search" && (
          <div className="user-search-overlay">
            <div className="user-search-header">
              <input className="user-search-input" placeholder="Search people..." autoFocus value={userSearchQuery} onChange={e => setUserSearchQuery(e.target.value)} />
              <button className="user-search-cancel" onClick={() => { setShowUserSearch(false); setUserSearchQuery(""); setUserSearchResults([]); }}>Cancel</button>
            </div>
            <div className="user-search-list">
              {userSearchLoading && <div style={{ textAlign: "center", padding: 32, color: "var(--text-tertiary)", fontSize: 13 }}>Searching...</div>}
              {!userSearchLoading && userSearchQuery.trim() && userSearchResults.length === 0 && <div style={{ textAlign: "center", padding: 32, color: "var(--text-tertiary)", fontSize: 13 }}>No users found</div>}
              {!userSearchLoading && !userSearchQuery.trim() && <div style={{ textAlign: "center", padding: 32, color: "var(--text-tertiary)", fontSize: 13 }}>Type a name to search</div>}
              {userSearchResults.map(usr => {
                const ini = (usr.display_name || "?").split(" ").map(w => w[0]).join("").slice(0,2).toUpperCase();
                const isFlw = followingSet.has(usr.id);
                return (
                  <div key={usr.id} className="user-search-row">
                    <div className="user-search-avatar">{ini}</div>
                    <div className="user-search-info">
                      <div className="user-search-name">{usr.display_name}</div>
                      {usr.bio && <div className="user-search-bio">{usr.bio}</div>}
                      <div className="user-search-followers">{usr.follower_count || 0} follower{(usr.follower_count || 0) !== 1 ? "s" : ""}</div>
                    </div>
                    <button className={`user-search-follow-btn ${isFlw ? "following" : "follow"}`} onClick={() => handleFollowFromSearch(usr.id)}>{isFlw ? "Following" : "Follow"}</button>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* ─── Feed Detail Overlay ─────────────────────── */}
        {feedDetailScan && (
          <div className="feed-detail-overlay">
            <button className="feed-detail-close" onClick={() => setFeedDetailScan(null)}>&#x2715;</button>
            {feedDetailScan.image_url && <img className="feed-detail-img" src={feedDetailScan.image_url} alt="" />}
            <div className="feed-detail-body">
              <div className="feed-detail-user">
                <div className="feed-card-avatar" style={{ width: 40, height: 40, fontSize: 15 }}>{((feedDetailScan.user?.display_name || "?").split(" ").map(w => w[0]).join("").slice(0,2).toUpperCase())}</div>
                <div>
                  <div className="feed-detail-name">{feedDetailScan.user?.display_name || "Anonymous"}</div>
                  {feedDetailScan.created_at && <div className="feed-detail-date">{new Date(feedDetailScan.created_at).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}</div>}
                </div>
              </div>
              {feedDetailScan.summary && <div className="feed-detail-summary">{feedDetailScan.summary}</div>}
              {feedDetailScan.item_count > 0 && <div style={{ fontSize: 13, color: "var(--text-tertiary)", marginBottom: 16 }}>{feedDetailScan.item_count} item{feedDetailScan.item_count !== 1 ? "s" : ""} identified</div>}
              {feedDetailScan.user?.bio && <div style={{ fontSize: 13, color: "var(--text-tertiary)", padding: "12px 0", borderTop: "1px solid var(--border)" }}>{feedDetailScan.user.bio}</div>}
            </div>
          </div>
        )}

        {/* ─── Tab bar (5 tabs: Feed, Search, Scan, Saved, Profile) ── */}
        <div className="tb">
          <button className={`tab${tab==="home"?" on":""}`} onClick={() => { track("tab_switched", { tab: "home" }); setTab("home"); setShowUserSearch(false); }} aria-label="Feed">
            <svg viewBox="0 0 24 24" fill={tab==="home"?"currentColor":"none"} stroke="currentColor" strokeWidth="1.5"><path d="M3 9.5L12 3l9 6.5V20a1 1 0 01-1 1h-5v-6h-6v6H4a1 1 0 01-1-1V9.5z"/></svg>
            <span className="tab-l">Feed</span>
          </button>
          <button className={`tab${tab==="search"?" on":""}`} onClick={() => { track("tab_switched", { tab: "search" }); setTab("search"); setShowUserSearch(false); }} aria-label="Search">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/></svg>
            <span className="tab-l">Search</span>
          </button>
          <button className="tab-scan" onClick={() => { track("tab_switched", { tab: "scan" }); setTab("scan"); setShowUserSearch(false); fileRef.current?.click(); }} aria-label="Scan outfit">
            <div className="tab-scan-icon">
              <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
            </div>
            <span className="tab-l">Scan</span>
          </button>
          <button className={`tab${tab==="likes"?" on":""}`} onClick={() => { track("tab_switched", { tab: "likes" }); setTab("likes"); setShowUserSearch(false); }} aria-label="Saved">
            <svg viewBox="0 0 24 24" fill={tab==="likes"?"currentColor":"none"} stroke="currentColor" strokeWidth="1.5"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>
            <span className="tab-l">Saved</span>
            {priceAlertCount > 0 && (
              <span className="tab-badge" />
            )}
          </button>
          <button className={`tab${tab==="profile"?" on":""}`} onClick={() => { track("tab_switched", { tab: "profile" }); setTab("profile"); setShowUserSearch(false); }} aria-label="Profile">
            <svg viewBox="0 0 24 24" fill={tab==="profile"?"currentColor":"none"} stroke="currentColor" strokeWidth="1.5"><circle cx="12" cy="8" r="4" /><path d="M20 21c0-3.87-3.58-7-8-7s-8 3.13-8 7"/></svg>
            <span className="tab-l">Profile</span>
          </button>
        </div>
      </>)}

      {/* ─── Crop screen ─────────────────────────────── */}
      {cropPending && (
        <div className="crop-screen">
          <div className="crop-stage">
            {cropMode ? (
              <ReactCrop
                crop={crop}
                onChange={c => setCrop(c)}
                onComplete={c => setCompletedCrop(c)}
                minWidth={40}
                minHeight={40}
              >
                <img
                  ref={cropImgRef}
                  src={cropPending.originalSrc}
                  onLoad={onCropImageLoad}
                  style={{ maxWidth: "100%", maxHeight: "calc(100vh - 120px)", display: "block" }}
                  alt=""
                />
              </ReactCrop>
            ) : (
              <div style={{ position: "relative", display: "inline-block" }}>
                <img
                  ref={imageDisplayRef}
                  src={cropPending.src}
                  style={{ maxWidth: "100%", maxHeight: "calc(100vh - 220px)", display: "block", borderRadius: 12 }}
                  alt=""
                />
                {circleSearchActive && (
                  <CircleToSearchOverlay
                    imageRef={imageDisplayRef}
                    onConfirm={(base64) => {
                      setPriorityRegionBase64(base64);
                      setCircleConfirmed(!!base64);
                      if (base64) setCircleSearchActive(false);
                    }}
                    onCancel={() => setCircleSearchActive(false)}
                  />
                )}
              </div>
            )}
          </div>
          {!cropMode && (
            <div style={{ display: "flex", justifyContent: "center", alignItems: "center", padding: "8px 20px 0", gap: 8 }}>
              {priorityRegionBase64 ? (
                <button
                  onClick={() => {
                    setPriorityRegionBase64(null);
                    setCircleConfirmed(false);
                    setCircleSearchActive(true);
                  }}
                  style={{ display: "flex", alignItems: "center", gap: 6, padding: "8px 16px", background: "var(--accent-bg)", border: "1px solid rgba(201,169,110,.4)", borderRadius: 100, color: "var(--accent)", fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: "var(--font-sans)", minHeight: 44 }}
                  aria-label="Clear circled item"
                >
                  ✓ Item circled — Clear
                </button>
              ) : (
                <div style={{ display: "flex", alignItems: "center", gap: 5, padding: "6px 12px", background: "rgba(201,169,110,.06)", border: "1px solid rgba(201,169,110,.2)", borderRadius: 100 }}>
                  <span style={{ fontSize: 11, color: "rgba(201,169,110,.7)", fontFamily: "var(--font-sans)", fontWeight: 600 }}>
                    ✏ Draw a circle around any item to prioritize it
                  </span>
                </div>
              )}
            </div>
          )}
          <div className="crop-bar">
            {cropMode ? (
              <>
                <button onClick={() => setCropMode(false)} style={{ flex: 1, padding: "14px 0", background: "var(--bg-input)", border: "1px solid var(--border)", borderRadius: 12, color: "var(--text-secondary)", fontFamily: "var(--font-sans)", fontSize: 14, fontWeight: 600, cursor: "pointer" }}>
                  Back
                </button>
                <button onClick={applyCrop} style={{ flex: 2, padding: "14px 0", background: "var(--accent)", border: "none", borderRadius: 12, color: "var(--text-inverse)", fontFamily: "var(--font-sans)", fontSize: 15, fontWeight: 700, cursor: "pointer" }}>
                  Apply crop
                </button>
              </>
            ) : (
              <>
                <button onClick={retakeCrop} style={{ flex: 1, padding: "14px 0", background: "var(--bg-input)", border: "1px solid var(--border)", borderRadius: 12, color: "var(--text-secondary)", fontFamily: "var(--font-sans)", fontSize: 14, fontWeight: 600, cursor: "pointer" }}>
                  Re-take
                </button>
                <button onClick={() => {
                  if (cropPending.lastCrop) {
                    cropRestoredRef.current = true;
                    setCrop(cropPending.lastCrop);
                    setCompletedCrop(cropPending.lastCrop);
                  }
                  setCropMode(true);
                }} style={{ flex: 1, padding: "14px 0", background: "var(--accent-bg)", border: "1px solid var(--accent-border)", borderRadius: 12, color: "var(--accent)", fontFamily: "var(--font-sans)", fontSize: 14, fontWeight: 600, cursor: "pointer" }}>
                  Crop
                </button>
                <button
                  onClick={skipCrop}
                  aria-label={priorityRegionBase64 ? "Scan circled item" : "Scan this outfit"}
                  style={{ flex: 2, padding: "14px 0", background: priorityRegionBase64 ? "rgba(201,169,110,.9)" : "var(--accent)", border: "none", borderRadius: 12, color: "var(--text-inverse)", fontFamily: "var(--font-sans)", fontSize: 15, fontWeight: 700, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 8, minHeight: 48, boxShadow: "0 4px 16px rgba(201,169,110,.35)", transition: "all var(--transition-fast)" }}
                >
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#0C0C0E" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/></svg>
                  {priorityRegionBase64 ? "Scan Circled Item" : "Scan This"}
                </button>
              </>
            )}
          </div>
        </div>
      )}

      {/* ═══ PUBLIC SCAN VIEW (deep link /scan/:scanId) ═══════ */}
      {publicScanView && (
        <div style={{ position: "fixed", inset: 0, zIndex: 9999, background: "var(--bg-secondary, #0C0C0E)", display: "flex", flexDirection: "column", overflow: "auto" }}>
          {/* Header */}
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "14px 20px", borderBottom: "1px solid var(--border)" }}>
            <img src="/logo-option-3.svg" alt="ATTAIR" className="logo-img" />
            <button onClick={() => { setPublicScanView(null); window.history.replaceState(null, "", "/"); }} style={{ background: "none", border: "none", color: "var(--text-tertiary)", fontSize: 20, cursor: "pointer", padding: 8, minWidth: 44, minHeight: 44 }}>&times;</button>
          </div>

          {publicScanView.loading && (
            <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", flexDirection: "column", gap: 12 }}>
              <div className="ld-dots" style={{ justifyContent: "center" }}><div className="ld-dot" /><div className="ld-dot" /><div className="ld-dot" /></div>
              <div style={{ fontSize: 13, color: "var(--text-tertiary)" }}>Loading scan...</div>
            </div>
          )}

          {publicScanView.error && (
            <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", flexDirection: "column", gap: 16, padding: 32 }}>
              <div style={{ fontSize: 32, color: "var(--text-tertiary)" }}>404</div>
              <div style={{ fontSize: 14, color: "var(--text-secondary)", textAlign: "center" }}>{publicScanView.error}</div>
              <button onClick={() => { setPublicScanView(null); window.history.replaceState(null, "", "/"); }} className="cta" style={{ width: "auto", padding: "14px 32px" }}>Go to ATTAIRE</button>
            </div>
          )}

          {publicScanView.data && !publicScanView.loading && (() => {
            const ps = publicScanView.data;
            return (
              <div style={{ flex: 1, display: "flex", flexDirection: "column" }}>
                {/* Outfit image full-bleed */}
                {ps.image_url && (
                  <div style={{ position: "relative", width: "100%", maxHeight: "55vh", overflow: "hidden" }}>
                    <img src={ps.image_url} alt="Outfit" style={{ width: "100%", objectFit: "cover", display: "block" }} />
                    <div style={{ position: "absolute", bottom: 0, left: 0, right: 0, height: 80, background: "linear-gradient(transparent, var(--bg-secondary, #0C0C0E))" }} />
                  </div>
                )}

                <div style={{ padding: "16px 20px", flex: 1 }}>
                  {/* User name */}
                  {ps.user?.display_name && (
                    <div style={{ fontSize: 12, color: "var(--text-tertiary)", marginBottom: 8, fontWeight: 600 }}>
                      Scanned by {ps.user.display_name}
                    </div>
                  )}

                  {/* Summary */}
                  {ps.summary && (
                    <div style={{ fontSize: 15, color: "var(--text-secondary)", fontStyle: "italic", lineHeight: 1.5, marginBottom: 16 }}>
                      {ps.summary}
                    </div>
                  )}

                  {/* Items list */}
                  {ps.items && ps.items.length > 0 && (
                    <div style={{ marginBottom: 20 }}>
                      <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: 2, color: "var(--text-tertiary)", textTransform: "uppercase", marginBottom: 10 }}>{ps.items.length} item{ps.items.length !== 1 ? "s" : ""} identified</div>
                      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                        {ps.items.map((item, i) => (
                          <div key={i} style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 12px", background: "var(--bg-input)", borderRadius: 10, border: "1px solid var(--border)" }}>
                            <div style={{ width: 8, height: 8, borderRadius: "50%", background: "var(--accent)", flexShrink: 0 }} />
                            <div style={{ flex: 1 }}>
                              <div style={{ fontSize: 14, color: "var(--text-primary)", fontWeight: 600 }}>{item.name || item.category}</div>
                              {item.brand && item.brand !== "Unidentified" && <div style={{ fontSize: 11, color: "var(--text-tertiary)", marginTop: 2 }}>{item.brand}</div>}
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Find my version CTA */}
                  <button
                    onClick={() => {
                      setPublicScanView(null);
                      window.history.replaceState(null, "", "/");
                      if (authed) {
                        setTab("scan");
                        setScreen("app");
                      } else {
                        setScreen("auth");
                        setAuthScreen("signup");
                      }
                    }}
                    style={{
                      width: "100%", padding: "16px 0", minHeight: 52,
                      background: "var(--accent)", color: "var(--text-inverse)", border: "none", borderRadius: 14,
                      fontFamily: "var(--font-sans)", fontSize: 16, fontWeight: 700, cursor: "pointer",
                      display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
                      boxShadow: "0 4px 20px rgba(201,169,110,.4)",
                    }}
                  >
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/></svg>
                    Find my version
                  </button>

                  <div style={{ textAlign: "center", marginTop: 12, fontSize: 12, color: "var(--text-tertiary)" }}>
                    Powered by ATTAIR AI Fashion Scanner
                  </div>
                </div>
              </div>
            );
          })()}
        </div>
      )}

      {/* ═══ POST-FIRST-SCAN PREFERENCE SHEET ═════════════════ */}
      {showPrefSheet && (
        <div style={{ position: "fixed", inset: 0, zIndex: 9998, background: "rgba(0,0,0,.6)", backdropFilter: "blur(8px)", display: "flex", alignItems: "flex-end", justifyContent: "center" }}
          onClick={(e) => { if (e.target === e.currentTarget) { setShowPrefSheet(false); } }}>
          <div style={{
            width: "100%", maxWidth: 430, background: "var(--bg-card, #1A1A1C)", borderRadius: "24px 24px 0 0",
            padding: "24px 24px 32px", animation: "slideUp .35s ease forwards",
          }}>
            {/* Handle */}
            <div className="bottom-sheet-handle" />

            <h2 style={{ fontFamily: "'Instrument Serif'", fontSize: 24, color: "var(--text-primary)", marginBottom: 6, textAlign: "center" }}>Personalize Your Experience</h2>
            <p style={{ fontSize: 13, color: "var(--text-tertiary)", textAlign: "center", marginBottom: 24, lineHeight: 1.5 }}>Help us find better matches for you.</p>

            {/* Budget range */}
            <div style={{ marginBottom: 20 }}>
              <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: 1.5, color: "var(--text-tertiary)", textTransform: "uppercase", marginBottom: 10 }}>Budget per item</div>
              <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
                <div style={{ flex: 1 }}>
                  <div style={{ display: "flex", alignItems: "center", background: "var(--bg-input)", border: "1px solid var(--border)", borderRadius: 12, padding: "12px 14px" }}>
                    <span style={{ color: "var(--text-tertiary)", fontSize: 16, fontWeight: 600, marginRight: 4 }}>$</span>
                    <input type="number" value={prefSheetBudgetMin} onChange={e => setPrefSheetBudgetMin(Math.max(0, parseInt(e.target.value) || 0))} style={{ background: "none", border: "none", color: "var(--text-primary)", fontFamily: "var(--font-sans)", fontSize: 16, fontWeight: 600, width: "100%", outline: "none" }} />
                  </div>
                </div>
                <span style={{ color: "var(--text-tertiary)", fontSize: 14 }}>to</span>
                <div style={{ flex: 1 }}>
                  <div style={{ display: "flex", alignItems: "center", background: "var(--bg-input)", border: "1px solid var(--border)", borderRadius: 12, padding: "12px 14px" }}>
                    <span style={{ color: "var(--text-tertiary)", fontSize: 16, fontWeight: 600, marginRight: 4 }}>$</span>
                    <input type="number" value={prefSheetBudgetMax} onChange={e => setPrefSheetBudgetMax(Math.max(prefSheetBudgetMin + 1, parseInt(e.target.value) || 0))} style={{ background: "none", border: "none", color: "var(--text-primary)", fontFamily: "var(--font-sans)", fontSize: 16, fontWeight: 600, width: "100%", outline: "none" }} />
                  </div>
                </div>
              </div>
            </div>

            {/* Fit preference chips */}
            <div style={{ marginBottom: 24 }}>
              <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: 1.5, color: "var(--text-tertiary)", textTransform: "uppercase", marginBottom: 10 }}>Fit preference</div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                {["Slim", "Regular", "Relaxed", "Oversized"].map(fit => {
                  const isOn = prefSheetFit.includes(fit.toLowerCase());
                  return (
                    <button key={fit} onClick={() => setPrefSheetFit(prev => isOn ? prev.filter(f => f !== fit.toLowerCase()) : [...prev, fit.toLowerCase()])}
                      style={{
                        padding: "10px 20px", minHeight: 44,
                        background: isOn ? "rgba(201,169,110,.12)" : "var(--bg-input)",
                        border: `1px solid ${isOn ? "rgba(201,169,110,.4)" : "var(--border)"}`,
                        borderRadius: 100, cursor: "pointer",
                        fontFamily: "var(--font-sans)", fontSize: 13, fontWeight: 600,
                        color: isOn ? "var(--accent)" : "var(--text-secondary)",
                        transition: "all .2s",
                      }}
                    >{fit}</button>
                  );
                })}
              </div>
            </div>

            {/* Save button */}
            <button
              onClick={() => {
                setBudgetMin(prefSheetBudgetMin);
                setBudgetMax(prefSheetBudgetMax);
                setSizePrefs(prev => ({ ...prev, fit: prefSheetFit }));
                setPrefs(prev => ({ ...prev, budget_min: prefSheetBudgetMin, budget_max: prefSheetBudgetMax, size_prefs: { ...prev.size_prefs, fit: prefSheetFit } }));
                // Persist to backend if authed
                if (authed) {
                  API.updateProfile({ budget_min: prefSheetBudgetMin, budget_max: prefSheetBudgetMax }).catch(() => {});
                }
                setShowPrefSheet(false);
                // Show style fingerprint card briefly
                setShowStyleFingerprint(true);
                setTimeout(() => setShowStyleFingerprint(false), 3500);
                track("pref_sheet_saved", { budget_min: prefSheetBudgetMin, budget_max: prefSheetBudgetMax, fits: prefSheetFit });
              }}
              style={{
                width: "100%", padding: "16px 0", minHeight: 48,
                background: "var(--accent)", color: "var(--text-inverse)", border: "none", borderRadius: 14,
                fontFamily: "var(--font-sans)", fontSize: 15, fontWeight: 700, cursor: "pointer",
                marginBottom: 8,
              }}
            >Save Preferences</button>
            <button onClick={() => { setShowPrefSheet(false); setShowStyleFingerprint(true); setTimeout(() => setShowStyleFingerprint(false), 3500); }}
              style={{ width: "100%", padding: "12px 0", background: "none", border: "none", color: "var(--text-tertiary)", fontFamily: "var(--font-sans)", fontSize: 13, cursor: "pointer", minHeight: 44 }}>
              Skip for now
            </button>
          </div>
        </div>
      )}

      {/* ═══ STYLE FINGERPRINT CARD (legacy) ═══════════════════ */}
      {showStyleFingerprint && (
        <div style={{ position: "fixed", inset: 0, zIndex: 9997, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(0,0,0,.5)", backdropFilter: "blur(6px)" }}
          onClick={() => setShowStyleFingerprint(false)}>
          <div onClick={e => e.stopPropagation()} style={{
            position: "relative", width: "calc(100% - 48px)", maxWidth: 380,
            background: "linear-gradient(145deg, #1A1A1C 0%, #0C0C0E 100%)",
            border: "1px solid rgba(201,169,110,.2)", borderRadius: 20,
            padding: "28px 24px", textAlign: "center",
            animation: "slideIn .4s ease forwards", overflow: "hidden",
            boxShadow: "0 20px 60px rgba(0,0,0,.5), inset 0 1px 0 rgba(201,169,110,.08)",
          }}>
            <div style={{
              position: "absolute", inset: 0, borderRadius: 20, overflow: "hidden", pointerEvents: "none",
              background: "linear-gradient(105deg, transparent 40%, rgba(201,169,110,.06) 45%, rgba(201,169,110,.12) 50%, rgba(201,169,110,.06) 55%, transparent 60%)",
              backgroundSize: "200% 100%", animation: "searchPulse 2s ease infinite",
            }} />
            <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: 2, color: "var(--accent)", textTransform: "uppercase", marginBottom: 12 }}>Your Style Fingerprint</div>
            <div style={{ fontFamily: "'Instrument Serif'", fontSize: 28, color: "var(--text-primary)", marginBottom: 20 }}>Looking good.</div>
            <div style={{ display: "flex", gap: 12, justifyContent: "center", marginBottom: 16 }}>
              <div style={{ padding: "10px 16px", background: "rgba(201,169,110,.08)", border: "1px solid rgba(201,169,110,.2)", borderRadius: 12, textAlign: "center" }}>
                <div style={{ fontSize: 10, color: "var(--text-tertiary)", fontWeight: 600, letterSpacing: 0.5, marginBottom: 4 }}>Budget</div>
                <div style={{ fontSize: 16, fontWeight: 700, color: "var(--accent)" }}>${prefSheetBudgetMin}-${prefSheetBudgetMax}</div>
              </div>
              {prefSheetFit.length > 0 && (
                <div style={{ padding: "10px 16px", background: "rgba(201,169,110,.08)", border: "1px solid rgba(201,169,110,.2)", borderRadius: 12, textAlign: "center" }}>
                  <div style={{ fontSize: 10, color: "var(--text-tertiary)", fontWeight: 600, letterSpacing: 0.5, marginBottom: 4 }}>Fit</div>
                  <div style={{ fontSize: 14, fontWeight: 700, color: "var(--accent)", textTransform: "capitalize" }}>{prefSheetFit.join(", ")}</div>
                </div>
              )}
            </div>
            <div style={{ fontSize: 12, color: "var(--text-tertiary)", lineHeight: 1.5 }}>
              {history.length > 0 ? `${history.length} outfit${history.length !== 1 ? "s" : ""} scanned` : "First scan complete!"}
            </div>
            <div style={{ marginTop: 16, fontSize: 11, color: "var(--text-tertiary)" }}>Tap anywhere to dismiss</div>
          </div>
        </div>
      )}

      {/* ═══ STYLE DNA CARD MODAL ═══════════════════════════════ */}
      {showStyleDna && styleDna?.ready && (
        <div style={{ position: "fixed", inset: 0, zIndex: 9997, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(0,0,0,.6)", backdropFilter: "blur(8px)" }}
          onClick={() => setShowStyleDna(false)} role="dialog" aria-label="Style DNA report" aria-modal="true">
          <div onClick={e => e.stopPropagation()} style={{
            position: "relative", width: "calc(100% - 32px)", maxWidth: 400,
            background: "linear-gradient(165deg, #1A1A1C 0%, #0C0C0E 100%)",
            border: "1px solid rgba(201,169,110,.2)", borderRadius: 24,
            padding: "32px 24px 24px", textAlign: "center",
            animation: "slideIn .4s var(--ease-spring) forwards",
            boxShadow: "0 24px 80px rgba(0,0,0,.6), inset 0 1px 0 rgba(201,169,110,.1)",
            overflow: "hidden", maxHeight: "90vh", overflowY: "auto"
          }}>
            {/* Shimmer overlay */}
            <div style={{ position: "absolute", inset: 0, borderRadius: 24, overflow: "hidden", pointerEvents: "none",
              background: "linear-gradient(105deg, transparent 40%, rgba(201,169,110,.05) 45%, rgba(201,169,110,.1) 50%, rgba(201,169,110,.05) 55%, transparent 60%)",
              backgroundSize: "200% 100%", animation: "searchPulse 3s ease infinite" }} />

            {/* Header */}
            <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: 3, color: "var(--accent)", textTransform: "uppercase", marginBottom: 6 }}>YOUR STYLE DNA</div>

            {/* Archetype */}
            <div style={{ fontFamily: "'Instrument Serif', serif", fontSize: 32, color: "var(--text-primary)", marginBottom: 8, lineHeight: 1.2 }}>{styleDna.archetype}</div>

            {/* Description */}
            <div style={{ fontSize: 14, color: "var(--text-secondary)", lineHeight: 1.6, marginBottom: 20, maxWidth: 320, margin: "0 auto 20px" }}>{styleDna.description}</div>

            {/* Traits */}
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8, justifyContent: "center", marginBottom: 20 }}>
              {styleDna.traits?.map((trait, i) => (
                <span key={i} style={{ padding: "6px 14px", background: "var(--accent-bg)", border: "1px solid var(--accent-border)", borderRadius: 20, fontSize: 12, color: "var(--text-secondary)", fontWeight: 500 }}>{trait}</span>
              ))}
            </div>

            {/* Style scores - horizontal bars */}
            {styleDna.style_score && (
              <div style={{ marginBottom: 20, textAlign: "left" }}>
                {[
                  { label: "Classic", label2: "Trendy", key: "classic_vs_trendy" },
                  { label: "Minimal", label2: "Maximal", key: "minimal_vs_maximal" },
                  { label: "Casual", label2: "Formal", key: "casual_vs_formal" },
                  { label: "Budget", label2: "Luxury", key: "budget_vs_luxury" }
                ].map(({ label, label2, key }) => (
                  <div key={key} style={{ marginBottom: 10 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: "var(--text-tertiary)", fontWeight: 600, letterSpacing: 0.5, marginBottom: 4 }}>
                      <span>{label}</span><span>{label2}</span>
                    </div>
                    <div style={{ height: 4, background: "var(--border)", borderRadius: 2, position: "relative" }}>
                      <div style={{ position: "absolute", left: 0, top: 0, height: "100%", width: `${(styleDna.style_score[key] || 5) * 10}%`, background: "var(--accent)", borderRadius: 2, transition: "width 1s ease" }} />
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* Stats row */}
            <div style={{ display: "flex", gap: 8, justifyContent: "center", marginBottom: 20, flexWrap: "wrap" }}>
              {styleDna.stats?.dominant_colors?.slice(0, 3).map((color, i) => (
                <span key={i} style={{ padding: "6px 12px", background: "var(--bg-input)", borderRadius: 8, fontSize: 11, color: "var(--text-secondary)" }}>{color}</span>
              ))}
              {styleDna.stats?.price_tier && (
                <span style={{ padding: "6px 12px", background: "rgba(201,169,110,.1)", borderRadius: 8, fontSize: 11, color: "var(--accent)", fontWeight: 600 }}>{styleDna.stats.price_tier}</span>
              )}
            </div>

            {/* Top brands */}
            {styleDna.stats?.top_brands?.length > 0 && (
              <div style={{ fontSize: 12, color: "var(--text-tertiary)", marginBottom: 16 }}>
                Top brands: {styleDna.stats.top_brands.slice(0, 3).join(" \u00B7 ")}
              </div>
            )}

            {/* Share button */}
            <button onClick={async (e) => {
              e.stopPropagation();
              setStyleDnaShareLoading(true);
              try {
                const cardUrl = await generateStyleDnaCard(styleDna, authName);
                if (navigator.share) {
                  const blob = await (await fetch(cardUrl)).blob();
                  const file = new File([blob], "style-dna.png", { type: "image/png" });
                  await navigator.share({ files: [file], title: "My Style DNA \u2014 ATTAIRE" });
                } else {
                  const a = document.createElement("a");
                  a.href = cardUrl;
                  a.download = "style-dna.png";
                  a.click();
                }
              } catch {}
              setStyleDnaShareLoading(false);
            }} aria-label="Share your Style DNA card" style={{
              width: "100%", padding: "14px 0", background: "var(--accent)", color: "var(--text-inverse)",
              border: "none", borderRadius: "var(--radius-sm)", fontSize: 15, fontWeight: 700,
              cursor: "pointer", fontFamily: "var(--font-sans)", letterSpacing: 0.3,
              display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
              opacity: styleDnaShareLoading ? 0.6 : 1, minHeight: 44
            }}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M4 12v8a2 2 0 002 2h12a2 2 0 002-2v-8"/><polyline points="16 6 12 2 8 6"/><line x1="12" y1="2" x2="12" y2="15"/></svg>
              {styleDnaShareLoading ? "Generating..." : "Share Your Style DNA"}
            </button>

            {/* Scan count */}
            <div style={{ marginTop: 12, fontSize: 11, color: "var(--text-tertiary)" }}>Based on {styleDna.stats?.total_scans || 0} scans</div>
          </div>
        </div>
      )}

      {/* ═══ PRICE ALERTS BOTTOM SHEET ═══════════════════════════ */}
      {showPriceAlerts && (
        <div style={{ position: "fixed", inset: 0, zIndex: 9996, background: "rgba(0,0,0,.5)", backdropFilter: "blur(4px)" }}
          onClick={() => setShowPriceAlerts(false)} role="dialog" aria-label="Price drop alerts" aria-modal="true">
          <div onClick={e => e.stopPropagation()} style={{
            position: "absolute", bottom: 0, left: 0, right: 0,
            background: "var(--bg-primary)", borderRadius: "20px 20px 0 0",
            maxHeight: "70vh", overflowY: "auto",
            padding: "20px 16px calc(20px + env(safe-area-inset-bottom, 0px))",
            animation: "slideIn .3s var(--ease-spring) forwards"
          }}>
            <div style={{ width: 36, height: 4, borderRadius: 2, background: "var(--border)", margin: "0 auto 16px" }} />
            <div style={{ fontSize: 18, fontWeight: 700, color: "var(--text-primary)", marginBottom: 16 }}>Price Drops</div>
            {priceAlerts.length === 0 ? (
              <div style={{ textAlign: "center", padding: 24, color: "var(--text-tertiary)" }}>Loading alerts...</div>
            ) : priceAlerts.map((alert, i) => (
              <div key={alert.id || i} style={{
                display: "flex", alignItems: "center", gap: 12, padding: "12px 0",
                borderBottom: i < priceAlerts.length - 1 ? "1px solid var(--border)" : "none"
              }}>
                <div style={{ width: 44, height: 44, borderRadius: "var(--radius-sm)", background: "rgba(76,175,80,.1)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 20, flexShrink: 0 }} aria-hidden="true">&#x1F4C9;</div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 14, fontWeight: 600, color: "var(--text-primary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{alert.product_name || "Saved item"}</div>
                  <div style={{ fontSize: 12, color: "var(--text-tertiary)" }}>{alert.brand}</div>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 4 }}>
                    <span style={{ fontSize: 13, color: "var(--text-tertiary)", textDecoration: "line-through" }}>${alert.original_price}</span>
                    <span style={{ fontSize: 15, fontWeight: 700, color: "#4CAF50" }}>${alert.current_price}</span>
                    <span style={{ fontSize: 11, padding: "2px 6px", background: "rgba(76,175,80,.15)", color: "#4CAF50", borderRadius: 4, fontWeight: 600 }}>-{Math.round(alert.drop_percentage)}%</span>
                  </div>
                </div>
                <a href={alert.product_url} target="_blank" rel="noopener" onClick={() => { API.priceAlertSeen(alert.id).catch(() => {}); setPriceAlertCount(c => Math.max(0, c - 1)); }}
                  aria-label={`Shop ${alert.product_name || "item"} at new price`}
                  style={{ padding: "8px 14px", background: "var(--accent)", color: "#000", borderRadius: "var(--radius-sm)", fontSize: 13, fontWeight: 700, textDecoration: "none", whiteSpace: "nowrap", minHeight: 44, display: "flex", alignItems: "center" }}>
                  Shop
                </a>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  </>);
}
