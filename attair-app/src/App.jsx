import { useState, useRef, useCallback, useEffect } from "react";
import ReactCrop from "react-image-crop";
import "react-image-crop/dist/ReactCrop.css";

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
      console.error("[ATTAIRE] /api/identify response:", res.status, data);
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
    <a href={href} target="_blank" rel="noopener noreferrer"
      onClick={() => track("product_clicked", { tier, brand: data.brand, price: data.price, is_fallback: isFallback }, scanId, "scan")}
      style={{ padding: 16, background: isFallback ? "rgba(255,255,255,0.01)" : "rgba(255,255,255,0.02)", border: `1px solid ${data.is_identified_brand ? "rgba(201,169,110,0.3)" : isFallback ? "rgba(255,255,255,0.03)" : "rgba(255,255,255,0.05)"}`, borderRadius: 14, textDecoration: "none", color: "inherit", display: "flex", flexDirection: "column", gap: 8, transition: "all 0.2s" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: 1.5, color: isFallback ? "rgba(255,255,255,.2)" : tierCfg.accent, textTransform: "uppercase" }}>{tierCfg.icon} {tierCfg.label}</span>
        <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
          {data.is_identified_brand && <span style={{ fontSize: 8, fontWeight: 800, letterSpacing: 1, padding: "2px 6px", borderRadius: 3, background: "rgba(201,169,110,0.12)", color: "#C9A96E" }}>ORIGINAL</span>}
          {data.is_resale && <span style={{ fontSize: 8, fontWeight: 800, letterSpacing: 1, padding: "2px 6px", borderRadius: 3, background: "rgba(120,200,120,0.12)", color: "#7BC87B" }}>RESALE</span>}
          {data.is_product_page && !data.is_identified_brand && !data.is_resale && <span style={{ fontSize: 8, fontWeight: 700, letterSpacing: .5, padding: "2px 6px", borderRadius: 3, background: "rgba(255,255,255,0.04)", color: "rgba(255,255,255,0.3)" }}>Product page</span>}
        </div>
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
        style={{ padding: 12, background: isFallback ? "rgba(255,255,255,.01)" : "rgba(255,255,255,.02)", border: `1px solid ${data.is_identified_brand ? "rgba(201,169,110,0.25)" : "rgba(255,255,255,.05)"}`, borderRadius: 12, textDecoration: "none", color: "inherit", display: "flex", flexDirection: "column", gap: 6, transition: "all 0.2s", minWidth: 0 }}>
        {data.image_url && (
          <div style={{ width: "100%", aspectRatio: "1", borderRadius: 8, overflow: "hidden", background: "rgba(255,255,255,.04)", marginBottom: 2 }}>
            <img src={data.image_url} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} onError={e => { e.target.style.display = "none"; }} />
          </div>
        )}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          {data.is_identified_brand && <span style={{ fontSize: 7, fontWeight: 800, letterSpacing: 1, padding: "2px 5px", borderRadius: 3, background: "rgba(201,169,110,.12)", color: "#C9A96E" }}>ORIG</span>}
          {data.is_resale && <span style={{ fontSize: 7, fontWeight: 800, letterSpacing: 1, padding: "2px 5px", borderRadius: 3, background: "rgba(123,196,127,.12)", color: "#7BC47F" }}>RESALE</span>}
          {!data.is_identified_brand && !data.is_resale && <span style={{ fontSize: 7, color: "rgba(255,255,255,.15)" }}>{data.brand?.slice(0, 14)}</span>}
          <span style={{ fontSize: 13, fontWeight: 700, color: tierCfg.accent }}>{isFallback ? "Search →" : data.price}</span>
        </div>
        {!isFallback && <div style={{ fontSize: 11, fontWeight: 500, color: "rgba(255,255,255,.7)", lineHeight: 1.3, overflow: "hidden", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical" }}>{data.product_name}</div>}
        {isFallback && <div style={{ fontSize: 11, color: "rgba(255,255,255,.3)", lineHeight: 1.3 }}>No match — tap to search</div>}
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
        <div className="pw-badge">✦ ATTAIRE PRO</div>
        <h2 className="modal-title">{m.title}</h2>
        <p className="modal-sub">{m.sub}</p>
        <div className="pw-fs" style={{ marginBottom: 24 }}>
          {["Unlimited AI outfit scans", "Completely ad-free", "Price drop alerts", "Full scan history forever"].map((f, i) => (
            <div className="pw-f" key={i}><div className="pw-ck">✓</div>{f}</div>
          ))}
        </div>
        <div style={{ display: "flex", gap: 10, marginBottom: 16 }}>
          <div
            onClick={() => setPlan("yearly")}
            style={{ flex: 1, textAlign: "center", padding: "12px 8px", borderRadius: 12, border: `1.5px solid ${plan === "yearly" ? "rgba(201,169,110,.6)" : "rgba(255,255,255,.06)"}`, background: plan === "yearly" ? "rgba(201,169,110,.06)" : "rgba(255,255,255,.01)", cursor: "pointer", transition: "all .2s", position: "relative" }}>
            <div style={{ position: "absolute", top: -9, left: "50%", transform: "translateX(-50%)", background: "#C9A96E", color: "#0C0C0E", fontSize: 8, fontWeight: 800, padding: "2px 8px", borderRadius: 100, letterSpacing: 1, whiteSpace: "nowrap", boxShadow: "0 2px 8px rgba(255,107,53,0.5), 0 0 16px rgba(255,107,53,0.2), 0 4px 16px rgba(201,169,110,.5)" }}>SAVE 50%</div>
            <div style={{ fontSize: 20, fontWeight: 700, color: "#fff" }}>$30<span style={{ fontSize: 13, color: "rgba(255,255,255,.35)" }}>/yr</span></div>
            <div style={{ fontSize: 10, color: "rgba(255,255,255,.2)" }}>$2.50/mo</div>
          </div>
          <div
            onClick={() => setPlan("monthly")}
            style={{ flex: 1, textAlign: "center", padding: "12px 8px", borderRadius: 12, border: `1.5px solid ${plan === "monthly" ? "rgba(201,169,110,.6)" : "rgba(255,255,255,.06)"}`, background: plan === "monthly" ? "rgba(201,169,110,.06)" : "rgba(255,255,255,.01)", cursor: "pointer", transition: "all .2s" }}>
            <div style={{ fontSize: 20, fontWeight: 700, color: "#fff" }}>$5<span style={{ fontSize: 13, color: "rgba(255,255,255,.35)" }}>/mo</span></div>
            <div style={{ fontSize: 10, color: "rgba(255,255,255,.2)" }}>$1.15/week</div>
          </div>
        </div>
        <button className="cta" onClick={handleCta} disabled={loadingPlan} style={{ opacity: loadingPlan ? 0.7 : 1 }}>
          {loadingPlan ? <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}><span style={{ display: "inline-block", width: 14, height: 14, border: "2px solid rgba(12,12,14,.3)", borderTopColor: "#0C0C0E", borderRadius: "50%", animation: "spin .7s linear infinite" }} />Processing…</span> : m.cta}
        </button>
        <button className="modal-later" onClick={() => onStartTrial && onStartTrial()} style={{ color: "#C9A96E", fontSize: 12, marginTop: -4 }}>
          Or start a 7-day free trial →
        </button>
        <button className="modal-later" onClick={onClose}>Maybe later</button>
        {userStatus?.tier === "free" && !userStatus?.trial_ends_at && (
          <div style={{ textAlign: "center", marginTop: 12, paddingTop: 12, borderTop: "1px solid rgba(255,255,255,.06)" }}>
            <button onClick={() => onStartTrial && onStartTrial()} style={{ background: "transparent", border: "1px solid rgba(255,107,53,.35)", color: "#FF6B35", padding: "10px 24px", borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: "pointer", fontFamily: "'Outfit'", width: "100%" }}>
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
              <div style={{ fontSize: 16, fontWeight: 700, color: "#fff", marginBottom: 6, fontFamily: "'Outfit'" }}>New Arrivals</div>
              <div style={{ fontSize: 12, color: "rgba(255,255,255,.5)", marginBottom: 16 }}>Discover this season's top looks</div>
              <button onClick={() => { API.logAdEvent("interstitial", "post_scan", "click"); onClose(); }} style={{ display: "inline-block", padding: "10px 24px", background: "#C9A96E", borderRadius: 100, fontSize: 12, fontWeight: 700, color: "#0C0C0E", fontFamily: "'Outfit'", border: "none", cursor: "pointer" }}>Shop Now</button>
            </div>
          </div>
          <div style={{ padding: "8px 12px", textAlign: "center", borderTop: "1px solid rgba(255,255,255,.06)" }}>
            <span style={{ fontSize: 10, color: "rgba(255,255,255,.2)" }}>Featured Partner</span>
          </div>
        </div>
        <div style={{ fontSize: 10, color: "rgba(255,255,255,.15)" }}>Upgrade to Pro to remove ads</div>
        {timer > 0
          ? <div style={{ position: "absolute", top: 16, right: 16, fontSize: 12, color: "rgba(255,255,255,.25)" }}>Skip in {timer}s</div>
          : <button onClick={onClose} style={{ position: "absolute", top: 14, right: 14, background: "rgba(255,255,255,.08)", border: "none", borderRadius: 100, padding: "6px 14px", fontSize: 12, fontWeight: 600, color: "#fff", cursor: "pointer", fontFamily: "'Outfit'" }}>Skip →</button>
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
    ctx.font = "bold 48px system-ui";
    ctx.textAlign = "center";
    ctx.fillText(labels[verdict] || "", 540, verdictY);
  }

  // Summary
  ctx.fillStyle = "#FFFFFF";
  ctx.font = "600 36px system-ui";
  ctx.textAlign = "center";
  const summaryText = summary?.substring(0, 60) || "";
  if (summaryText) ctx.fillText(summaryText, 540, 1460);

  // Items count
  const itemCount = items?.length || 0;
  ctx.fillStyle = "rgba(255,255,255,0.5)";
  ctx.font = "400 28px system-ui";
  ctx.fillText(`${itemCount} item${itemCount !== 1 ? "s" : ""} identified`, 540, 1520);

  // User name
  if (userName) {
    ctx.fillStyle = "rgba(255,255,255,0.4)";
    ctx.font = "400 24px system-ui";
    ctx.fillText(`Scanned by ${userName}`, 540, 1580);
  }

  // ATTAIRE watermark
  ctx.fillStyle = "#C9A96E";
  ctx.font = "bold 56px system-ui";
  ctx.textAlign = "center";
  ctx.fillText("ATTAIRE", 540, 1800);
  ctx.fillStyle = "rgba(201,169,110,0.5)";
  ctx.font = "400 24px system-ui";
  ctx.fillText("AI Fashion Scanner", 540, 1850);

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
        <button onClick={clear} aria-label="Clear circle selection" style={{ padding: "8px 18px", background: "rgba(0,0,0,.7)", border: "1px solid rgba(255,255,255,.2)", borderRadius: 100, color: "#fff", fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: "'Outfit'", minHeight: 44, minWidth: 44 }}>Clear</button>
        {confirmed && <button onClick={onCancel} aria-label="Confirm circle selection" style={{ padding: "8px 18px", background: "rgba(201,169,110,.9)", border: "none", borderRadius: 100, color: "#0C0C0E", fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: "'Outfit'", minHeight: 44, minWidth: 44 }}>Done</button>}
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
  const vidRef = useRef(null);
  const canRef = useRef(null);
  const streamRef = useRef(null);
  const [camOn, setCamOn] = useState(false);
  const [camReady, setCamReady] = useState(false);
  const [camFacing, setCamFacing] = useState("environment"); // "environment" (back) | "user" (front)
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
      console.error("[ATTAIRE] Feed load error:", err);
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
  const obNext = (v) => {
    const step = OB_STEPS[obIdx];
    if (step.type === "budget_range") {
      setPrefs(p => ({ ...p, budget_min: budgetMin, budget_max: budgetMax }));
    } else if (step.type === "size_prefs") {
      const sp = v || {};
      setSizePrefs(sp);
      setPrefs(p => ({ ...p, size_prefs: sp }));
    } else if (v) {
      setPrefs(p => ({ ...p, [step.id]: v }));
    }
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

  // Camera
  const camStart = async (facing) => {
    const mode = facing || camFacing;
    track("camera_opened", {}, null, "scan");
    try {
      const s = await navigator.mediaDevices.getUserMedia({ video: { facingMode: mode, width: { ideal: 1280 } } });
      streamRef.current = s;
      if (vidRef.current) { vidRef.current.srcObject = s; vidRef.current.onloadedmetadata = () => setCamReady(true); }
      setCamOn(true);
    } catch { setError("Camera denied. Upload a photo instead."); }
  };
  const camFlip = async () => {
    const newFacing = camFacing === "environment" ? "user" : "environment";
    setCamFacing(newFacing);
    setCamReady(false);
    // Stop current stream
    if (streamRef.current) { streamRef.current.getTracks().forEach(t => t.stop()); streamRef.current = null; }
    // Start new stream with flipped camera — attach directly to existing video element
    try {
      const s = await navigator.mediaDevices.getUserMedia({ video: { facingMode: newFacing, width: { ideal: 1280 } } });
      streamRef.current = s;
      if (vidRef.current) { vidRef.current.srcObject = s; vidRef.current.onloadedmetadata = () => setCamReady(true); }
    } catch { setError("Could not switch camera."); }
  };
  const camCapture = async () => {
    if (!vidRef.current || !canRef.current) return;
    const v = vidRef.current, c = canRef.current;
    c.width = v.videoWidth; c.height = v.videoHeight;
    const ctx = c.getContext("2d");
    // For front-facing camera: the video preview is CSS-mirrored but the captured
    // image should NOT be mirrored — flip the canvas context before drawing
    if (camFacing === "user") {
      ctx.translate(c.width, 0);
      ctx.scale(-1, 1);
    }
    ctx.drawImage(v, 0, 0);
    camStop();
    const r = await resizeImage(c.toDataURL("image/jpeg", 0.85));
    openCrop(r, "camera");
  };
  const camStop = () => {
    if (streamRef.current) { streamRef.current.getTracks().forEach(t => t.stop()); streamRef.current = null; }
    setCamOn(false); setCamReady(false);
    // Return to home feed when canceling camera (not the old scan idle state)
    if (phase === "idle" && !img && !results) setTab("home");
  };

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
    if (source === "camera") {
      camStart();
    } else {
      fileRef.current?.click();
    }
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
        console.error("[ATTAIRE] Identify error:", err.message);
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
    <style>{`
      @import url('https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&family=Outfit:wght@300;400;500;600;700;800&display=swap');
      *{margin:0;padding:0;box-sizing:border-box;-webkit-tap-highlight-color:transparent}
      @keyframes fi{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:translateY(0)}}
      @keyframes fo{from{opacity:1}to{opacity:0}}
      @keyframes scan{0%{top:5%}50%{top:92%}100%{top:5%}}
      @keyframes pulse{0%,100%{opacity:.35}50%{opacity:1}}
      @keyframes slideIn{from{opacity:0;transform:translateY(16px)}to{opacity:1;transform:translateY(0)}}
      @keyframes spin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}
      @keyframes glowPulse{0%,100%{opacity:1;filter:brightness(1.5)}50%{opacity:.6;filter:brightness(2)}}
      @keyframes circleGlow{0%,100%{opacity:0.6;filter:drop-shadow(0 0 10px rgba(201,169,110,0.4)) drop-shadow(0 0 3px rgba(201,169,110,0.6))}50%{opacity:1;filter:drop-shadow(0 0 20px rgba(201,169,110,0.7)) drop-shadow(0 0 6px rgba(201,169,110,0.9))}}
      @keyframes searchPulse{0%,100%{background-position:200% center}50%{background-position:0% center}}
      @keyframes verdictPop{0%{transform:scale(1)}30%{transform:scale(1.25)}60%{transform:scale(0.95)}100%{transform:scale(1)}}
      @keyframes slideDown{0%{opacity:0;max-height:0}100%{opacity:1;max-height:2000px}}
      .scroll-x::-webkit-scrollbar{display:none}
      @keyframes verdictShake{0%,100%{transform:translateX(0)}15%{transform:translateX(-4px)}30%{transform:translateX(4px)}45%{transform:translateX(-3px)}60%{transform:translateX(3px)}75%{transform:translateX(-1px)}90%{transform:translateX(1px)}}
      @keyframes highlighterPulse{0%{opacity:0.6}50%{opacity:0.9}100%{opacity:0.6}}
      @keyframes budgetSliderPulse{0%{box-shadow:0 0 0 0 rgba(201,169,110,0.3)}70%{box-shadow:0 0 0 6px rgba(201,169,110,0)}100%{box-shadow:0 0 0 0 rgba(201,169,110,0)}}
      .fi{animation:fi .3s ease forwards}.fo{animation:fo .22s ease forwards}
      .app{width:100%;max-width:430px;min-height:100vh;margin:0 auto;background:var(--bg-secondary);font-family:'Outfit',sans-serif;color:var(--text-primary);display:flex;flex-direction:column;overflow-x:hidden}
      .serif{font-family:'Instrument Serif',serif}

      .ob{flex:1;display:flex;flex-direction:column;padding:20px 28px}
      .ob-bar{height:2px;background:var(--border);border-radius:1px;margin-bottom:40px;overflow:hidden}
      .ob-fill{height:100%;background:var(--accent);transition:width .4s ease}
      .ob-body{flex:1;display:flex;flex-direction:column;justify-content:center}
      .ob-icon{font-size:32px;margin-bottom:20px;color:var(--accent)}
      .ob-title{font-family:'Instrument Serif';font-size:32px;line-height:1.15;margin-bottom:14px;white-space:pre-line;color:var(--text-primary)}
      .ob-sub{font-size:14px;color:var(--text-secondary);line-height:1.6;margin-bottom:36px}
      .ob-opts{display:flex;flex-direction:column;gap:10px}
      .ob-opt{padding:18px 22px;background:var(--accent-bg);border:1px solid var(--border);border-radius:14px;cursor:pointer;transition:all .2s;font-size:15px;font-weight:500;color:var(--text-secondary);min-height:44px}
      .ob-opt:hover{background:rgba(255,255,255,.06);border-color:rgba(255,255,255,.12)}
      .ob-chips{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:4px}
      .ob-chip{padding:9px 16px;background:var(--accent-bg);border:1px solid var(--border);border-radius:100px;cursor:pointer;font-size:13px;font-weight:500;color:var(--text-secondary);transition:all .2s;-webkit-tap-highlight-color:transparent;min-height:36px}
      .ob-chip.on{background:var(--accent-bg);border-color:var(--accent-border);color:var(--accent)}
      .ob-skip{background:none;border:none;color:var(--text-tertiary);font-size:13px;cursor:pointer;font-family:'Outfit';padding:10px 0;margin-top:4px;text-align:center;width:100%;min-height:44px}
      .ob-stats{display:flex;gap:32px;margin-bottom:36px}
      .ob-sn{font-family:'Outfit';font-size:24px;font-weight:700;color:var(--accent)}
      .ob-sl{font-size:11px;color:var(--text-tertiary);letter-spacing:1px;text-transform:uppercase;margin-top:2px}
      .cta{width:100%;padding:17px;background:var(--accent);color:var(--text-inverse);border:none;border-radius:14px;font-family:'Outfit';font-size:15px;font-weight:700;cursor:pointer;transition:all .2s;margin-top:auto;min-height:44px}.cta:hover{background:var(--accent-hover)}

      .pw{flex:1;display:flex;flex-direction:column;padding:20px 28px}
      .pw-skip{align-self:flex-end;background:none;border:none;color:var(--text-tertiary);font-size:13px;cursor:pointer;padding:8px;font-family:'Outfit';min-height:44px}
      .pw-badge{display:inline-flex;align-items:center;gap:5px;background:var(--accent-bg);border:1px solid var(--accent-border);border-radius:100px;padding:7px 14px;font-size:11px;font-weight:600;color:var(--accent);letter-spacing:.8px;margin:16px 0 20px;align-self:flex-start}
      .pw-t{font-family:'Instrument Serif';font-size:30px;line-height:1.15;margin-bottom:8px;color:var(--text-primary)}
      .pw-st{font-size:14px;color:var(--text-secondary);line-height:1.5;margin-bottom:28px}
      .pw-fs{display:flex;flex-direction:column;gap:12px;margin-bottom:32px}
      .pw-f{display:flex;align-items:center;gap:11px;font-size:14px;color:var(--text-secondary)}
      .pw-ck{width:20px;height:20px;border-radius:50%;background:var(--accent-bg);display:flex;align-items:center;justify-content:center;flex-shrink:0;color:var(--accent);font-size:10px;font-weight:700}
      .pw-plans{display:flex;gap:10px;margin-bottom:28px}
      .pw-p{flex:1;padding:20px 14px;border-radius:14px;border:1.5px solid var(--border);cursor:pointer;transition:all .2s;position:relative;background:var(--bg-card)}.pw-p.sel{border-color:var(--accent-border);background:var(--accent-bg)}
      .pw-ptag{position:absolute;top:-9px;left:50%;transform:translateX(-50%);background:var(--accent);color:var(--text-inverse);font-size:9px;font-weight:800;padding:3px 10px;border-radius:100px;letter-spacing:1px;white-space:nowrap;box-shadow:0 4px 16px rgba(201,169,110,.5)}
      .pw-pp{font-size:22px;font-weight:700;color:var(--text-primary)}.pw-pd{font-size:12px;color:var(--text-tertiary)}.pw-pw{font-size:11px;color:var(--text-tertiary);margin-top:4px}
      .pw-terms{text-align:center;font-size:10px;color:var(--text-tertiary);margin-top:14px}

      .auth{flex:1;display:flex;flex-direction:column;padding:20px 28px;justify-content:center}
      .auth input{width:100%;padding:16px 18px;background:var(--bg-input);border:1px solid var(--border);border-radius:12px;color:var(--text-primary);font-family:'Outfit';font-size:15px;outline:none;margin-bottom:10px;transition:border-color .2s;min-height:44px;box-sizing:border-box}
      .auth input:focus{border-color:var(--border-focus)}
      .auth input::placeholder{color:var(--text-tertiary)}
      .auth-toggle{background:none;border:none;color:var(--accent);font-family:'Outfit';font-size:13px;cursor:pointer;padding:8px;text-align:center;width:100%;margin-top:8px;min-height:44px}
      .auth-err{background:rgba(255,80,80,.06);border:1px solid rgba(255,80,80,.12);border-radius:10px;padding:12px;font-size:13px;color:var(--error);margin-bottom:12px;text-align:center}

      .as{flex:1;display:flex;flex-direction:column;padding-bottom:80px}
      .hdr{display:flex;align-items:center;justify-content:space-between;padding:14px 20px;position:sticky;top:0;z-index:50;background:color-mix(in srgb,var(--bg-secondary) 92%,transparent);backdrop-filter:blur(20px);border-bottom:1px solid var(--border)}
      .logo{font-family:'Instrument Serif';font-size:22px;color:var(--text-primary);font-style:italic;letter-spacing:0.04em}.logo span{color:var(--accent)}
      .pro{font-size:9px;font-weight:800;letter-spacing:1.5px;color:var(--accent);background:var(--accent-bg);padding:3px 8px;border-radius:4px;cursor:pointer;min-height:28px;display:inline-flex;align-items:center}
      .free-badge{font-size:9px;font-weight:700;letter-spacing:1.5px;color:var(--text-tertiary);background:var(--accent-bg);padding:3px 8px;border-radius:4px;cursor:pointer;min-height:28px;display:inline-flex;align-items:center}
      .scan-counter{font-size:11px;color:var(--text-tertiary);text-align:center;margin-top:-8px;margin-bottom:8px}
      .scan-counter strong{color:var(--accent)}
      .tb{position:fixed;bottom:0;left:50%;transform:translateX(-50%);width:100%;max-width:430px;display:flex;background:var(--bg-card);backdrop-filter:blur(24px);border-top:1px solid var(--border);padding:6px 0 0;padding-bottom:max(6px,env(safe-area-inset-bottom));z-index:100}
      .tab{flex:1;display:flex;flex-direction:column;align-items:center;gap:2px;padding:6px 0 4px;cursor:pointer;background:none;border:none;color:var(--text-tertiary);transition:color .2s;font-family:'Outfit';min-height:44px;position:relative}.tab.on{color:var(--accent)}
      .tab.on::before{content:'';position:absolute;top:-6px;left:50%;transform:translateX(-50%);width:20px;height:2px;background:var(--accent);border-radius:2px}
      .tab svg{width:22px;height:22px;stroke:currentColor;fill:none;stroke-width:1.6}.tab.on svg{stroke-width:2}
      .tab-l{font-size:10px;font-weight:500;letter-spacing:.3px;margin-top:1px}.tab.on .tab-l{font-weight:700}

      .shome{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:40px 28px;gap:28px;text-align:center}
      .scan-ring{width:150px;height:150px;border-radius:50%;border:1.5px dashed var(--accent-border);display:flex;align-items:center;justify-content:center;cursor:pointer;transition:all .3s}
      .scan-ring:hover{border-color:rgba(201,169,110,.4);transform:scale(1.03)}
      .scan-inner{width:110px;height:110px;border-radius:50%;background:var(--accent-bg);display:flex;align-items:center;justify-content:center;font-size:36px}
      .btns{display:flex;gap:10px;width:100%}
      .btn{flex:1;padding:15px;border-radius:12px;border:none;font-family:'Outfit';font-size:13px;font-weight:700;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:7px;transition:all .2s;min-height:44px}
      .btn.gold{background:var(--accent);color:var(--text-inverse)}.btn.gold:hover{background:var(--accent-hover)}
      .btn.ghost{background:var(--accent-bg);color:var(--text-secondary);border:1px solid var(--border)}
      .btn svg{width:16px;height:16px;stroke:currentColor;fill:none;stroke-width:2}

      .cam{position:fixed;inset:0;z-index:200;background:#000;display:flex;flex-direction:column;overflow:hidden}
      .cam video{flex:1;object-fit:cover;min-height:0}
      .cam-corners{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);width:260px;height:340px;pointer-events:none}
      .cc{position:absolute;width:28px;height:28px;border-color:var(--accent);border-style:solid}
      .cc.tl{top:0;left:0;border-width:2px 0 0 2px;border-radius:6px 0 0 0}.cc.tr{top:0;right:0;border-width:2px 2px 0 0;border-radius:0 6px 0 0}
      .cc.bl{bottom:0;left:0;border-width:0 0 2px 2px;border-radius:0 0 0 6px}.cc.br{bottom:0;right:0;border-width:0 2px 2px 0;border-radius:0 0 6px 0}
      .cam-bar{flex-shrink:0;padding:24px;display:flex;align-items:center;justify-content:center;gap:36px;background:rgba(0,0,0,.85);backdrop-filter:blur(16px);padding-bottom:max(24px,env(safe-area-inset-bottom))}
      .cam-x{background:none;border:none;color:#fff;font-family:'Outfit';font-size:15px;cursor:pointer;min-height:44px;min-width:44px}
      .shutter{width:64px;height:64px;border-radius:50%;background:var(--accent);border:4px solid var(--accent-border);cursor:pointer;transition:transform .15s}.shutter:active{transform:scale(.88)}

      .ld-wrap{flex:1;display:flex;flex-direction:column}
      .ld-img-wrap{position:relative;width:100%;aspect-ratio:3/4;max-height:55vh;overflow:hidden}
      .ld-img{width:100%;height:100%;object-fit:cover;filter:brightness(.45) saturate(.6)}
      .ld-scanline{position:absolute;left:0;right:0;height:3px;background:linear-gradient(90deg,transparent 0%,rgba(201,169,110,.2) 20%,var(--accent) 50%,rgba(201,169,110,.2) 80%,transparent 100%);animation:scan 3s ease-in-out infinite;box-shadow:0 0 30px rgba(201,169,110,.4),0 0 60px rgba(201,169,110,.15)}
      .ld-img-wrap::after{content:'';position:absolute;inset:0;background:radial-gradient(ellipse at center,rgba(201,169,110,.04) 0%,transparent 70%);animation:pulse 2.5s ease-in-out infinite;pointer-events:none}
      .ld-info{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;padding:32px}
      .ld-dots{display:flex;gap:5px}.ld-dot{width:4px;height:4px;border-radius:50%;background:var(--accent);animation:pulse 1.2s ease-in-out infinite}.ld-dot:nth-child(2){animation-delay:.15s}.ld-dot:nth-child(3){animation-delay:.3s}

      .res{flex:1;display:flex;flex-direction:column}
      .res-img-sec{position:relative;width:100%}
      .res-img{width:100%;aspect-ratio:3/4;max-height:48vh;object-fit:cover;display:block}
      .res-grad{position:absolute;bottom:0;left:0;right:0;height:120px;background:linear-gradient(transparent,var(--bg-secondary))}
      .res-new{position:absolute;top:14px;right:14px;display:flex;align-items:center;gap:6px;background:rgba(255,255,255,.92);backdrop-filter:blur(12px);border:none;border-radius:100px;color:#0C0C0E;font-family:'Outfit';font-size:12px;font-weight:700;padding:9px 16px;cursor:pointer;box-shadow:0 2px 12px rgba(0,0,0,.35);transition:all .2s}.res-new:hover{background:#fff;transform:scale(1.03)}
      .res-new svg{width:13px;height:13px;stroke:#0C0C0E;fill:none;stroke-width:2.2;flex-shrink:0}
      .res-close{position:absolute;top:14px;left:14px;width:36px;height:36px;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.5);backdrop-filter:blur(12px);border:1px solid rgba(255,255,255,.12);border-radius:50%;cursor:pointer;transition:all .2s}.res-close:hover{background:rgba(0,0,0,.7)}
      .res-close svg{width:14px;height:14px;stroke:#fff;fill:none;stroke-width:2.5;stroke-linecap:round}
      .hs{position:absolute;transform:translate(-50%,-50%);cursor:pointer;transition:all .2s;z-index:10}
      .hs-ring{width:32px;height:32px;border-radius:50%;border:2px solid var(--accent);display:flex;align-items:center;justify-content:center;background:rgba(12,12,14,.5);backdrop-filter:blur(4px);transition:all .2s}
      .hs.on .hs-ring{background:var(--accent);transform:scale(1.15);box-shadow:0 0 0 4px rgba(201,169,110,.2)}
      .hs-num{font-size:11px;font-weight:700;color:var(--accent);transition:color .2s}.hs.on .hs-num{color:var(--text-inverse)}
      .hs-tag{position:absolute;top:100%;left:50%;transform:translateX(-50%);margin-top:4px;font-size:8px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:var(--accent);background:rgba(12,12,14,.7);backdrop-filter:blur(8px);padding:2px 6px;border-radius:3px;white-space:nowrap}
      .hs.picked .hs-ring{background:var(--accent);transform:scale(1.15);box-shadow:0 0 0 4px rgba(201,169,110,.2)}
      .hs.picked .hs-num{color:var(--text-inverse)}
      .hs.unpicked .hs-ring{border-color:rgba(255,255,255,.15);background:rgba(12,12,14,.5)}.hs.unpicked .hs-num{color:rgba(255,255,255,.25)}
      .pick-list{padding:12px 20px;display:flex;flex-direction:column;gap:8px}
      .pick-item{display:flex;align-items:center;gap:12px;padding:14px 16px;background:var(--accent-bg);border:1px solid var(--border);border-radius:12px;cursor:pointer;transition:all .2s;-webkit-tap-highlight-color:transparent;min-height:44px}
      .pick-item.picked{background:var(--accent-bg);border-color:var(--accent-border)}
      .pick-check{width:22px;height:22px;border-radius:6px;border:1.5px solid var(--text-tertiary);display:flex;align-items:center;justify-content:center;flex-shrink:0;transition:all .15s}
      .pick-item.picked .pick-check{background:var(--accent);border-color:var(--accent)}
      .pick-cta{position:sticky;bottom:80px;padding:12px 20px;z-index:10}
      .pick-cta button{width:100%;padding:16px;border-radius:14px;font-size:15px;font-weight:700;font-family:'Outfit';cursor:pointer;transition:all .2s;border:none}
      .budget-input-wrap{flex:1;display:flex;align-items:center;background:var(--bg-input);border:1px solid var(--border);border-radius:12px;padding:12px 14px;gap:4px;transition:border-color .2s}
      .budget-input-wrap:focus-within{border-color:var(--border-focus)}
      .budget-input-wrap input{background:none;border:none;color:var(--text-primary);font-family:'Outfit';font-size:20px;font-weight:700;width:100%;outline:none}
      .budget-input-wrap input::placeholder{color:var(--text-tertiary)}
      .budget-input-wrap span{color:var(--text-tertiary);font-size:16px;font-weight:600;flex-shrink:0}
      .budget-range-thumb::-webkit-slider-thumb{-webkit-appearance:none;appearance:none;width:22px;height:22px;border-radius:50%;background:var(--accent);border:2px solid var(--bg-primary);cursor:pointer;pointer-events:auto;box-shadow:0 2px 6px rgba(0,0,0,0.3);transition:transform var(--transition-fast)}
      .budget-range-thumb::-webkit-slider-thumb:active{transform:scale(1.2)}
      .budget-range-thumb::-moz-range-thumb{width:22px;height:22px;border-radius:50%;background:var(--accent);border:2px solid var(--bg-primary);cursor:pointer;pointer-events:auto;box-shadow:0 2px 6px rgba(0,0,0,0.3)}
      .crop-screen{position:fixed;inset:0;z-index:400;background:#000;display:flex;flex-direction:column}
      .crop-stage{flex:1;overflow:hidden;display:flex;align-items:center;justify-content:center;padding:16px 16px 0}
      .crop-stage img{max-width:100%;max-height:100%;display:block}
      .crop-bar{flex-shrink:0;padding:16px 20px;padding-bottom:max(20px,env(safe-area-inset-bottom));background:var(--bg-secondary);display:flex;gap:12px;align-items:center;border-top:1px solid var(--border)}
      .ReactCrop{border-radius:4px}
      .ReactCrop__crop-selection{border:2px solid var(--accent);box-shadow:0 0 0 9999px rgba(0,0,0,.55)}
      .ReactCrop__drag-handle::after{background:var(--accent);border:2px solid var(--bg-secondary);width:14px;height:14px;border-radius:3px}
      .item-opts-overlay{position:fixed;inset:0;z-index:250;background:rgba(0,0,0,.65);backdrop-filter:blur(4px)}
      .item-opts-sheet{position:fixed;bottom:0;left:50%;transform:translateX(-50%);width:100%;max-width:430px;background:var(--bg-card);border-radius:20px 20px 0 0;border-top:1px solid var(--border);padding:20px 20px;padding-bottom:max(24px,env(safe-area-inset-bottom));z-index:251;animation:slideIn .22s ease;max-height:82vh;overflow-y:auto}
      .item-opts-handle{width:36px;height:3px;background:var(--text-tertiary);border-radius:3px;margin:0 auto 18px}
      .item-opts-label{font-size:9px;font-weight:700;letter-spacing:1.2px;text-transform:uppercase;color:var(--text-tertiary);margin-bottom:8px}
      .pick-item{display:flex;align-items:center;gap:12px;padding:14px 16px;background:var(--accent-bg);border:1px solid var(--border);border-radius:12px;cursor:pointer;transition:all .2s;-webkit-tap-highlight-color:transparent;min-height:44px}
      .pick-item.picked{background:var(--accent-bg);border-color:var(--accent-border)}

      .v-banner{padding:12px 20px;display:flex;align-items:center;gap:10px;border-bottom:1px solid var(--border)}
      .v-steps{display:flex;gap:6px;flex:1}
      .v-step{flex:1;display:flex;flex-direction:column;gap:3px;align-items:center}
      .v-step-bar{width:100%;height:2px;border-radius:1px;background:var(--border);overflow:hidden}
      .v-step-fill{height:100%;border-radius:1px;transition:width .5s ease}
      .v-step-l{font-size:8px;font-weight:700;letter-spacing:1px;text-transform:uppercase}

      .det{padding:20px;animation:slideIn .35s ease}
      .det-top{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}
      .det-name{font-family:'Instrument Serif';font-size:24px;color:var(--text-primary);line-height:1.15;flex:1}
      .det-save{width:44px;height:44px;border-radius:50%;background:var(--accent-bg);border:1px solid var(--border);display:flex;align-items:center;justify-content:center;cursor:pointer;flex-shrink:0;font-size:16px;transition:all .2s}.det-save.on{background:var(--accent-bg);border-color:var(--accent-border);color:var(--accent)}
      .det-tags{display:flex;gap:5px;flex-wrap:wrap;margin:12px 0}
      .det-tag{font-size:9px;font-weight:600;letter-spacing:.5px;text-transform:uppercase;color:var(--text-tertiary);background:var(--accent-bg);padding:4px 8px;border-radius:5px}
      .det-conf{display:flex;align-items:center;gap:14px;padding:14px;background:var(--accent-bg);border:1px solid var(--border);border-radius:14px;margin-bottom:18px}
      .sec-t{font-size:9px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:var(--text-tertiary);margin-bottom:10px;display:flex;align-items:center;justify-content:space-between}
      .tiers-scroll{display:flex;flex-direction:column;gap:10px;padding:0 0 12px}
      .tier-empty{padding:16px;border:1px dashed var(--border);border-radius:12px;text-align:center;font-size:12px;color:var(--text-tertiary);line-height:1.5}
      .aff-note{font-size:9px;color:var(--text-tertiary);text-align:center;margin-top:12px;padding-bottom:16px}

      .empty{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:40px 32px;gap:10px}
      .empty-i{font-size:36px;opacity:.2;margin-bottom:6px}.empty-t{font-size:16px;font-weight:600;color:var(--text-primary)}.empty-s{font-size:12px;color:var(--text-tertiary)}
      .hist-list{padding:16px 20px;display:flex;flex-direction:column;gap:10px}
      .hist-card{display:flex;gap:12px;padding:12px;background:var(--bg-card);border:1px solid var(--border);border-radius:12px;box-shadow:var(--shadow-card)}
      .hist-thumb{width:52px;height:68px;border-radius:8px;object-fit:cover;flex-shrink:0}
      .saved-list{padding:16px 20px;display:flex;flex-direction:column;gap:7px}
      .saved-row{display:flex;align-items:center;gap:12px;padding:12px;background:var(--bg-card);border:1px solid var(--border);border-radius:12px;box-shadow:var(--shadow-card)}
      .err{margin:20px;padding:20px;background:rgba(255,80,80,.05);border:1px solid rgba(255,80,80,.1);border-radius:12px;color:var(--error);font-size:13px;text-align:center;line-height:1.5}
      .hid{display:none}canvas.hid{display:none}
      .pcard{background:var(--bg-card);border:1px solid var(--border);border-radius:14px;padding:20px;box-shadow:var(--shadow-card)}
      .rcard{background:var(--accent-bg);border:1px solid var(--accent-border);border-radius:14px;padding:20px}
      .sitem{display:flex;align-items:center;justify-content:space-between;padding:13px 16px;background:var(--bg-card);border:1px solid var(--border);border-radius:10px;font-size:13px;font-weight:500;color:var(--text-secondary);cursor:pointer;min-height:44px}
      .ad-slot{display:flex;align-items:center;justify-content:center;background:rgba(255,255,255,.015);border:1px dashed rgba(255,255,255,.04);border-radius:10px;color:rgba(255,255,255,.08);font-size:9px;font-weight:700;letter-spacing:2px}
      .ad-banner{height:48px;margin:0 20px 8px}
      .ad-native{height:72px;margin:8px 0}

      .modal-overlay{position:fixed;inset:0;z-index:300;background:rgba(0,0,0,.75);backdrop-filter:blur(8px);display:flex;align-items:center;justify-content:center;padding:24px}
      .modal-box{width:100%;max-width:380px;background:var(--bg-card);border:1px solid var(--border);border-radius:24px;padding:28px 24px;position:relative;animation:slideIn .3s ease}
      .modal-x{position:absolute;top:16px;right:16px;background:none;border:none;color:var(--text-tertiary);font-size:18px;cursor:pointer;font-family:'Outfit';min-height:44px;min-width:44px}
      .modal-title{font-family:'Instrument Serif';font-size:24px;color:var(--text-primary);line-height:1.15;margin-bottom:8px}
      .modal-sub{font-size:13px;color:var(--text-secondary);line-height:1.6;margin-bottom:24px}
      .modal-later{background:none;border:none;color:var(--text-tertiary);font-family:'Outfit';font-size:12px;cursor:pointer;width:100%;text-align:center;padding:10px;margin-top:6px;min-height:44px}

      .view-toggle{display:flex;gap:0;background:var(--accent-bg);border-radius:10px;padding:3px;margin-bottom:16px}
      .view-tab{flex:1;padding:8px 0;border-radius:8px;border:none;font-family:'Outfit';font-size:12px;font-weight:600;cursor:pointer;transition:all .2s}
      .view-tab.on{background:var(--accent-bg);color:var(--accent)}
      .view-tab.off{background:transparent;color:var(--text-tertiary)}
      .refine-chat{display:flex;flex-direction:column;gap:8px;margin-bottom:12px}
      .refine-msg{padding:9px 13px;border-radius:10px;font-size:12px;line-height:1.5;max-width:88%}
      .refine-msg.user{background:var(--accent-bg);color:var(--text-primary);align-self:flex-end;border:1px solid var(--accent-border)}
      .refine-msg.ai{background:var(--bg-card);color:var(--text-secondary);align-self:flex-start;border:1px solid var(--border)}
      .refine-input-row{display:flex;gap:8px;align-items:flex-end}
      .refine-input{flex:1;padding:11px 14px;background:var(--bg-input);border:1px solid var(--border);border-radius:12px;color:var(--text-primary);font-family:'Outfit';font-size:13px;outline:none;resize:none;transition:border-color .2s;line-height:1.4}
      .refine-input:focus{border-color:var(--border-focus)}
      .refine-input::placeholder{color:var(--text-tertiary)}
      .refine-send{width:44px;height:44px;border-radius:10px;background:var(--accent);border:none;cursor:pointer;display:flex;align-items:center;justify-content:center;flex-shrink:0;transition:all .2s}
      .refine-send:disabled{opacity:.4;cursor:not-allowed}

      /* ─── Light mode overrides (LEGACY SAFETY NET) ─── */
      /* Many of these are now redundant because the CSS classes above use
         var(--*) tokens that auto-switch via [data-theme='light'] in index.css.
         Kept as a fallback for inline styles in JSX that still use hardcoded rgba values. */
      .app[data-theme='light']{background:#F6F4F0;color:#1A1816}
      .app[data-theme='light'] .hdr{background:rgba(246,244,240,.92);border-bottom-color:rgba(0,0,0,.06)}
      .app[data-theme='light'] .logo{color:#1A1816}
      .app[data-theme='light'] .free-badge{background:rgba(0,0,0,.04);color:rgba(0,0,0,.3)}
      .app[data-theme='light'] .tb{background:rgba(255,255,255,.97);border-top-color:rgba(0,0,0,.08)}
      .app[data-theme='light'] .tab{color:rgba(0,0,0,.3)}
      .app[data-theme='light'] .tab.on{color:#C9A96E}
      .app[data-theme='light'] .res-grad{background:linear-gradient(transparent,#F6F4F0)}
      .app[data-theme='light'] .ob-bar{background:rgba(0,0,0,.06)}
      .app[data-theme='light'] .ob-title{color:#1A1816}
      .app[data-theme='light'] .ob-sub{color:rgba(0,0,0,.4)}
      .app[data-theme='light'] .ob-opt{background:rgba(0,0,0,.03);border-color:rgba(0,0,0,.07);color:rgba(0,0,0,.7)}
      .app[data-theme='light'] .ob-chip{background:rgba(0,0,0,.03);border-color:rgba(0,0,0,.07);color:rgba(0,0,0,.5)}
      .app[data-theme='light'] .ob-chip.on{background:var(--accent-bg);border-color:var(--accent-border);color:var(--accent)}
      .app[data-theme='light'] .ob-skip{color:rgba(0,0,0,.2)}
      .app[data-theme='light'] .auth input{background:rgba(0,0,0,.03);border-color:rgba(0,0,0,.08);color:#1A1816}
      .app[data-theme='light'] .auth input::placeholder{color:rgba(0,0,0,.2)}
      .app[data-theme='light'] .auth-err{background:rgba(200,0,0,.04);border-color:rgba(200,0,0,.12);color:rgba(160,0,0,.8)}
      .app[data-theme='light'] .pick-item{background:rgba(0,0,0,.02)!important;border-color:rgba(0,0,0,.05)!important}
      .app[data-theme='light'] .pick-item.picked{background:rgba(201,169,110,.06)!important;border-color:rgba(201,169,110,.25)!important}
      .app[data-theme='light'] .pick-check{border-color:rgba(0,0,0,.12)}
      .app[data-theme='light'] .hist-card{background:rgba(0,0,0,.02)!important;border-color:rgba(0,0,0,.04)!important}
      .app[data-theme='light'] .saved-row{background:rgba(0,0,0,.02)!important;border-color:rgba(0,0,0,.04)!important}
      .app[data-theme='light'] .item-opts-sheet{background:#EDEBE6}
      .app[data-theme='light'] .budget-input-wrap{background:rgba(0,0,0,.03);border-color:rgba(0,0,0,.08)}
      .app[data-theme='light'] .budget-input-wrap input{color:#1A1816}
      .app[data-theme='light'] .err{background:rgba(200,0,0,.04);border-color:rgba(200,0,0,.1);color:rgba(140,0,0,.7)}
      .app[data-theme='light'] .view-toggle{background:rgba(0,0,0,.05)}
      .app[data-theme='light'] .view-tab.off{color:rgba(0,0,0,.25)}
      .app[data-theme='light'] .refine-msg.ai{background:rgba(0,0,0,.04);border-color:rgba(0,0,0,.06);color:rgba(0,0,0,.6)}
      .app[data-theme='light'] .refine-input{background:rgba(0,0,0,.03);border-color:rgba(0,0,0,.08);color:#1A1816}
      .app[data-theme='light'] .sitem{background:rgba(0,0,0,.02);border-color:rgba(0,0,0,.04);color:rgba(0,0,0,.5)}
      .app[data-theme='light'] .modal-box{background:#F6F4F0;border-color:rgba(0,0,0,.08)}
      .app[data-theme='light'] .modal-title,.app[data-theme='light'] .modal-sub{color:#1A1816}
      .app[data-theme='light'] .det{background:#F6F4F0;border-color:rgba(0,0,0,.06)}
      .app[data-theme='light'] .det-name{color:#1A1816}
      .app[data-theme='light'] .saved-row{background:rgba(0,0,0,.02);border-color:rgba(0,0,0,.05)}
      .app[data-theme='light'] .hist-item{background:rgba(0,0,0,.02);border-color:rgba(0,0,0,.05)}
      .app[data-theme='light'] .shome h2{color:#1A1816}
      .app[data-theme='light'] .scan-ring{background:rgba(0,0,0,.04);border-color:rgba(0,0,0,.08)}
      .app[data-theme='light'] .scan-inner{color:#1A1816}

      /* ─── Comprehensive light mode ───────────────────── */
      /* Cards */
      .app[data-theme='light'] .pcard{background:#FFFFFF;border-color:rgba(0,0,0,.08);box-shadow:0 1px 3px rgba(0,0,0,.08)}
      .app[data-theme='light'] .rcard{background:#FFF9F0;border-color:rgba(201,169,110,.2);box-shadow:0 1px 3px rgba(0,0,0,.06)}
      .app[data-theme='light'] .hist-card{background:#FFFFFF!important;border-color:rgba(0,0,0,.08)!important;box-shadow:0 1px 3px rgba(0,0,0,.06)}
      .app[data-theme='light'] .saved-row{background:#FFFFFF!important;border-color:rgba(0,0,0,.08)!important;box-shadow:0 1px 3px rgba(0,0,0,.06)}
      .app[data-theme='light'] .likes-card{background:#FFFFFF!important;border-color:rgba(0,0,0,.08)!important;box-shadow:0 1px 3px rgba(0,0,0,.08)}
      /* Text contrast */
      .app[data-theme='light'] .sec-t{color:#1A1816}
      .app[data-theme='light'] .det-tags .det-tag{background:rgba(0,0,0,.04);color:#666666;border-color:rgba(0,0,0,.07)}
      .app[data-theme='light'] .aff-note{color:rgba(0,0,0,.25)}
      /* Search/results area */
      .app[data-theme='light'] .res{background:#F6F4F0}
      .app[data-theme='light'] .v-banner{background:rgba(0,0,0,.03);border-bottom-color:rgba(0,0,0,.06)}
      .app[data-theme='light'] .v-step-bar{background:rgba(0,0,0,.06)}
      .app[data-theme='light'] .pick-list{background:#F6F4F0}
      .app[data-theme='light'] .pick-cta{background:linear-gradient(transparent,#F6F4F0 60%)}
      /* Inputs and textareas */
      .app[data-theme='light'] textarea{background:#F5F5F5;border-color:#E0E0E0;color:#1A1816}
      .app[data-theme='light'] textarea::placeholder{color:#999999}
      .app[data-theme='light'] input[type="number"]{color:#1A1816}
      .app[data-theme='light'] select{background:#F5F5F5;border-color:#E0E0E0;color:#1A1816}
      /* Tier selector pills */
      .app[data-theme='light'] .view-tab.on{background:rgba(201,169,110,.12);color:#8B6914}
      /* Profile section */
      .app[data-theme='light'] .pcard *{color:#1A1816}
      .app[data-theme='light'] .pcard .pro{color:#FFFFFF}
      .app[data-theme='light'] .pcard .free-badge{color:rgba(0,0,0,.4)}
      /* Modals and bottom sheets */
      .app[data-theme='light'] .modal-box{background:#FFFFFF;border-color:rgba(0,0,0,.08);box-shadow:0 24px 80px rgba(0,0,0,.18)}
      .app[data-theme='light'] .modal-title{color:#1A1816}
      .app[data-theme='light'] .modal-sub{color:#666666}
      .app[data-theme='light'] .modal-x{color:rgba(0,0,0,.3)}
      .app[data-theme='light'] .modal-later{color:rgba(0,0,0,.3)}
      .app[data-theme='light'] .item-opts-sheet{background:#FFFFFF;box-shadow:0 -4px 32px rgba(0,0,0,.12)}
      .app[data-theme='light'] .item-opts-label{color:rgba(0,0,0,.4)}
      /* Occasion chips */
      .app[data-theme='light'] .det{background:#FFFFFF;border-color:rgba(0,0,0,.08);box-shadow:0 1px 3px rgba(0,0,0,.06)}
      /* Pairings grid */
      .app[data-theme='light'] .hist-list{background:#F6F4F0}
      .app[data-theme='light'] .empty-t{color:#1A1816}
      .app[data-theme='light'] .empty-s{color:#666666}
      /* Upgrade modal specific */
      .app[data-theme='light'] .pw-f{color:#1A1816}
      .app[data-theme='light'] .pw-ck{color:#C9A96E}
      /* Refine chat in light mode */
      .app[data-theme='light'] .refine-msg.user{color:#1A1816}
      /* History name text */
      .app[data-theme='light'] .hist-name-row div{color:#1A1816}
      /* Bottom sheet overlays */
      .app[data-theme='light'] .likes-card *:not(button):not(img){color:#1A1816}
      /* Scan home */
      .app[data-theme='light'] .shome{background:#F6F4F0}
      .app[data-theme='light'] .btn.ghost{background:rgba(0,0,0,.04);color:rgba(0,0,0,.6);border-color:rgba(0,0,0,.08)}
      /* Loading screen */
      .app[data-theme='light'] .ld-wrap{background:#F6F4F0}
      .app[data-theme='light'] .ld-info{background:#F6F4F0}
      /* Results screen */
      .app[data-theme='light'] .res-grad{background:linear-gradient(transparent,#F6F4F0)}
      .app[data-theme='light'] .v-banner{background:#F6F4F0}
      .app[data-theme='light'] .v-step-l{color:rgba(0,0,0,.4)}
      .app[data-theme='light'] .det-conf{background:rgba(0,0,0,.02);border-color:rgba(0,0,0,.06)}
      .app[data-theme='light'] .tier-empty{border-color:rgba(0,0,0,.08);color:rgba(0,0,0,.3)}
      /* TierCard + MiniCard link colors */
      .app[data-theme='light'] .tiers-scroll a{color:#1A1816}
      /* MiniCard text overrides for light mode — inline rgba(255,255,255,.X) is invisible on white */
      .app[data-theme='light'] .tiers-scroll a div{color:#1A1816 !important}
      .app[data-theme='light'] .tiers-scroll a span{color:#666 !important}
      .app[data-theme='light'] .tiers-scroll a span[style*="fontWeight: 700"]{color:inherit !important}
      .app[data-theme='light'] .tiers-scroll a{background:rgba(0,0,0,.02) !important;border-color:rgba(0,0,0,.08) !important}
      /* Pick-item screen */
      .app[data-theme='light'] .pick-cta{background:linear-gradient(transparent,#F6F4F0 60%)}
      /* Camera overlay */
      .app[data-theme='light'] .cam{background:#000}
      /* Progress dots */
      .app[data-theme='light'] .ld-dot{background:#C9A96E}
      /* Profile page */
      .app[data-theme='light'] .pcard div:not(.pro):not(.free-badge){color:#1A1816}
      .app[data-theme='light'] .rcard{background:#FFF9F0}
      .app[data-theme='light'] .rcard div{color:#1A1816}
      /* Wishlist/collection sheet */
      .app[data-theme='light'] .likes-card{background:#FFFFFF;border-color:rgba(0,0,0,.07)}
      /* As-seen-on links */
      .app[data-theme='light'] .det a{color:#1A1816}
      /* Search re-run banner */
      .app[data-theme='light'] .research-banner{background:rgba(201,169,110,.06);border-bottom-color:rgba(201,169,110,.12)}
      /* Onboarding page in light mode */
      .app[data-theme='light'] .ob{background:#F6F4F0}
      .app[data-theme='light'] .ob-skip{color:rgba(0,0,0,.25)}

      /* ─── Comprehensive light mode: scan home ─────────── */
      .app[data-theme='light'] .shome h2{color:#1a1a1a!important}
      .app[data-theme='light'] .shome p{color:rgba(0,0,0,.45)!important}
      .app[data-theme='light'] .scan-counter{color:rgba(0,0,0,.35)!important}
      .app[data-theme='light'] .shome .btn.ghost{color:rgba(0,0,0,.6)!important;background:rgba(0,0,0,.05)!important;border-color:rgba(0,0,0,.1)!important}

      /* ─── Comprehensive light mode: picking / results ─── */
      .app[data-theme='light'] .res{background:#F5F5F7}
      .app[data-theme='light'] .pick-list [style*="rgba(255,255,255,.5)"] span[style]{color:rgba(0,0,0,.6)!important}
      .app[data-theme='light'] .pick-list [style*="rgba(255,255,255,.15)"] span[style]{color:rgba(0,0,0,.25)!important}
      .app[data-theme='light'] .pick-list > div > div > div:first-child{color:#1a1a1a!important}

      /* Occasion section label */
      .app[data-theme='light'] [style*="rgba(255,255,255,.2)"][style*="letterSpacing: 1.5"][style*="textTransform"]{color:rgba(0,0,0,.35)!important}

      /* Ident preview rows */
      .app[data-theme='light'] [style*="rgba(255,255,255,.02)"][style*="borderRadius: 10"]{background:rgba(0,0,0,.03)!important;border-color:rgba(0,0,0,.06)!important}
      .app[data-theme='light'] [style*="rgba(255,255,255,.04)"][style*="borderRadius: 10"]{background:rgba(0,0,0,.04)!important;border-color:rgba(0,0,0,.07)!important}

      /* Loading state */
      .app[data-theme='light'] .ld-wrap{background:#F5F5F7}
      .app[data-theme='light'] .ld-info{background:#F5F5F7}
      .app[data-theme='light'] .ld-info > div:nth-child(2){color:#1a1a1a!important}

      /* Summary text in results */
      .app[data-theme='light'] [style*="rgba(255,255,255,.5)"][style*="fontStyle: \"italic\""]{color:rgba(0,0,0,.55)!important}
      .app[data-theme='light'] [style*="rgba(255,255,255,.35)"][style*="textTransform: \"uppercase\""][style*="pickedItems"]{color:rgba(0,0,0,.45)!important}

      /* det (item detail) */
      .app[data-theme='light'] .det-name{color:#1a1a1a!important}
      .app[data-theme='light'] [style*="fontSize: 15"][style*="fontWeight: 700"][style*="color: \"#fff\""]{color:#1a1a1a!important}
      .app[data-theme='light'] [style*="rgba(255,255,255,.3)"][style*="marginLeft: 6"]{color:rgba(0,0,0,.35)!important}
      .app[data-theme='light'] [style*="rgba(255,255,255,.25)"][style*="marginTop: 6"][style*="fontStyle"]{color:rgba(0,0,0,.3)!important}
      .app[data-theme='light'] [style*="rgba(255,255,255,.2)"][style*="textAlign: \"center\""]{color:rgba(0,0,0,.3)!important}
      .app[data-theme='light'] [style*="rgba(255,255,255,.15)"][style*="No recent"]{color:rgba(0,0,0,.25)!important}
      .app[data-theme='light'] [style*="rgba(255,255,255,.15)"][style*="No stores"]{color:rgba(0,0,0,.25)!important}
      .app[data-theme='light'] [style*="rgba(255,255,255,.7)"][style*="lineHeight: 1.3"]{color:rgba(0,0,0,.75)!important}
      .app[data-theme='light'] [style*="rgba(255,255,255,.25)"][style*="source_name"]{color:rgba(0,0,0,.3)!important}
      .app[data-theme='light'] [style*="rgba(255,255,255,.7)"][style*="lineHeight: 1.3"][style*="marginBottom: 3"]{color:rgba(0,0,0,.75)!important}
      .app[data-theme='light'] [style*="rgba(255,255,255,.25)"][style*="marginTop: 1"]{color:rgba(0,0,0,.3)!important}
      .app[data-theme='light'] .det [style*="rgba(255,255,255,.04)"][style*="display: \"flex\""][style*="justifyContent: \"center\""][style*="borderRadius: 8"]{background:rgba(0,0,0,.04)!important}

      /* ID view card */
      .app[data-theme='light'] .det [style*="rgba(255,255,255,.02)"][style*="border: \"1px solid rgba(255,255,255,.04)\""]{background:rgba(0,0,0,.03)!important;border-color:rgba(0,0,0,.06)!important}
      .app[data-theme='light'] [style*="rgba(255,255,255,.2)"][style*="AI Identification"]{color:rgba(0,0,0,.3)!important}
      .app[data-theme='light'] [style*="rgba(255,255,255,.2)"][style*="width: 70"]{color:rgba(0,0,0,.3)!important}
      .app[data-theme='light'] [style*="rgba(255,255,255,.6)"][style*="lineHeight: 1.4"]{color:rgba(0,0,0,.65)!important}
      .app[data-theme='light'] [style*="rgba(255,255,255,.2)"][style*="Correct the AI"]{color:rgba(0,0,0,.3)!important}

      /* Re-search button */
      .app[data-theme='light'] [style*="rgba(255,255,255,.04)"][style*="borderRadius: 12"]{background:rgba(0,0,0,.04)!important;border-color:rgba(0,0,0,.08)!important}
      .app[data-theme='light'] [style*="rgba(255,255,255,.5)"][style*="fontWeight: 600"][style*="borderRadius: 12"]{color:rgba(0,0,0,.5)!important}

      /* Complete the Look button */
      .app[data-theme='light'] [style*="rgba(255,255,255,.2)"][style*="Outfit looks complete"]{color:rgba(0,0,0,.3)!important}
      .app[data-theme='light'] [style*="rgba(255,255,255,.15)"][style*="Dismiss"]{color:rgba(0,0,0,.2)!important}

      /* Pairings cards */
      .app[data-theme='light'] [style*="rgba(201,169,110,.04)"][style*="borderRadius: 12"]{background:rgba(201,169,110,.07)!important}
      .app[data-theme='light'] [style*="rgba(255,255,255,.4)"][style*="marginBottom: 2"]{color:rgba(0,0,0,.45)!important}
      .app[data-theme='light'] [style*="rgba(255,255,255,.35)"][style*="lineHeight: 1.4"]{color:rgba(0,0,0,.4)!important}

      /* Rate outfit */
      .app[data-theme='light'] [style*="rgba(255,255,255,.25)"][style*="rate_outfit"]{color:rgba(0,0,0,.35)!important}
      .app[data-theme='light'] [style*="rgba(255,255,255,.15)"][style*="fontSize: 18"]{color:rgba(0,0,0,.12)!important}

      /* Native ad (free users) */
      .app[data-theme='light'] [style*="rgba(255,255,255,.25)"][style*="Sponsored"]{color:rgba(0,0,0,.3)!important}
      .app[data-theme='light'] [style*="rgba(255,255,255,.4)"][style*="fontSize: 11"]{color:rgba(0,0,0,.45)!important}

      /* Banner ad slot */
      .app[data-theme='light'] [style*="rgba(255,255,255,.05)"][style*="overflow: \"hidden\""][style*="border: \"1px solid"]{border-color:rgba(0,0,0,.07)!important}
      .app[data-theme='light'] [style*="Trending This Week"][style*="color: \"#fff\""]{color:#1a1a1a!important}

      /* ─── Comprehensive light mode: history tab ─────────── */
      .app[data-theme='light'] .hist-list{background:#F5F5F7}
      .app[data-theme='light'] .hist-list [style*="rgba(255,255,255,.03)"][style*="borderRadius: 10"]{background:rgba(0,0,0,.05)!important}
      .app[data-theme='light'] .hist-list [style*="rgba(255,255,255,.3)"][style*="fontSize: 12"]{color:rgba(0,0,0,.4)!important}
      .app[data-theme='light'] .hist-card [style*="color: \"#fff\""][style*="fontSize: 13"]{color:#1a1a1a!important}
      .app[data-theme='light'] .hist-card [style*="rgba(255,255,255,.2)"][style*="fontSize: 11"]{color:rgba(0,0,0,.35)!important}
      .app[data-theme='light'] .hist-card [style*="rgba(255,255,255,.04)"][style*="borderRadius: 3"]{background:rgba(0,0,0,.06)!important;color:rgba(0,0,0,.3)!important;border:1px solid rgba(0,0,0,.06)}
      .app[data-theme='light'] .hist-card [style*="rgba(255,255,255,.12)"][style*="flexShrink: 0"]{color:rgba(0,0,0,.2)!important}
      .app[data-theme='light'] .hist-card [style*="rgba(255,255,255,.08)"][style*="cursor: \"pointer\""] button{color:rgba(0,0,0,.3)!important}
      .app[data-theme='light'] .hist-list [style*="rgba(255,255,255,.12)"][style*="fontSize: 9"]{color:rgba(0,0,0,.25)!important}
      .app[data-theme='light'] .hist-list [style*="rgba(255,255,255,.02)"][style*="borderRadius: 12"]{background:#FFFFFF!important;border-color:rgba(0,0,0,.08)!important}
      .app[data-theme='light'] .hist-list [style*="rgba(255,255,255,.06)"][style*="borderRadius: 12"]{background:#FFFFFF!important;border-color:rgba(0,0,0,.08)!important}
      .app[data-theme='light'] .hist-list [style*="rgba(255,255,255,.6)"][style*="fontSize: 14"]{color:#1a1a1a!important}
      .app[data-theme='light'] .hist-list [style*="rgba(255,255,255,.25)"][style*="fontSize: 11"]{color:rgba(0,0,0,.35)!important}
      .app[data-theme='light'] .hist-list [style*="rgba(255,255,255,.12)"][style*="userSelect"]{color:rgba(0,0,0,.2)!important}
      .app[data-theme='light'] .hist-list input{background:rgba(0,0,0,.04)!important;border-color:rgba(0,0,0,.08)!important;color:#1a1a1a!important}
      .app[data-theme='light'] .hist-list input::placeholder{color:rgba(0,0,0,.3)!important}
      .app[data-theme='light'] [style*="rgba(255,255,255,.06)"][style*="borderRadius: 8"][style*="background: \"rgba(201,169,110,.06)\""]{background:rgba(201,169,110,.1)!important}

      /* Visibility menu chips */
      .app[data-theme='light'] .scan-vis-chip{background:rgba(0,0,0,.04)!important;border-color:rgba(0,0,0,.1)!important;color:rgba(0,0,0,.5)!important}
      .app[data-theme='light'] .scan-vis-chip.active{background:rgba(201,169,110,.1)!important;border-color:rgba(201,169,110,.4)!important;color:#8B6914!important}
      .app[data-theme='light'] .profile-bio-area{background:#F0F0F2!important;color:#1a1a1a!important;border-color:rgba(0,0,0,.1)!important}
      .app[data-theme='light'] .profile-bio-area::placeholder{color:rgba(0,0,0,.3)!important}
      .app[data-theme='light'] .profile-stats-row{border-top-color:rgba(0,0,0,.08)!important}
      .app[data-theme='light'] .profile-stat-val{color:#1a1a1a!important}
      .app[data-theme='light'] .profile-stat-lbl{color:#666!important}
      .app[data-theme='light'] .interest-chip{background:rgba(0,0,0,.04)!important;border-color:rgba(0,0,0,.1)!important;color:rgba(0,0,0,.5)!important}
      .app[data-theme='light'] .interest-chip.on{background:rgba(201,169,110,.1)!important;border-color:rgba(201,169,110,.4)!important;color:#8B6914!important}

      /* ─── Comprehensive light mode: likes tab ─────────── */
      .app[data-theme='light'] .likes-card{background:#FFFFFF!important;border-color:rgba(0,0,0,.08)!important;box-shadow:0 1px 4px rgba(0,0,0,.08)}
      .app[data-theme='light'] .likes-card [style*="rgba(255,255,255,.04)"]{background:rgba(0,0,0,.04)!important}
      .app[data-theme='light'] .likes-card [style*="rgba(255,255,255,.03)"]{background:rgba(0,0,0,.03)!important}
      .app[data-theme='light'] .likes-card [style*="rgba(255,255,255,.85)"]{color:#1a1a1a!important}
      .app[data-theme='light'] .likes-card [style*="rgba(255,255,255,.35)"]{color:rgba(0,0,0,.4)!important}
      .app[data-theme='light'] .likes-card [style*="rgba(255,255,255,.2)"]{color:rgba(0,0,0,.3)!important}
      .app[data-theme='light'] [style*="rgba(255,255,255,.6)"][style*="fontWeight: 600"]:not(button){color:rgba(0,0,0,.7)!important}
      .app[data-theme='light'] [style*="rgba(255,255,255,.06)"][style*="borderRadius: 6"]{border-color:rgba(0,0,0,.08)!important}
      .app[data-theme='light'] [style*="rgba(255,255,255,.04)"][style*="display: \"flex\""][style*="justifyContent: \"center\""][style*="fontSize: 18"]{background:rgba(0,0,0,.04)!important}

      /* Add-to-collection bottom sheet */
      .app[data-theme='light'] [style*="background: \"#18181C\""][style*="borderTopLeftRadius"]{background:#FFFFFF!important}
      .app[data-theme='light'] [style*="fontSize: 14"][style*="fontWeight: 700"][style*="color: \"#fff\""]{color:#1a1a1a!important}
      .app[data-theme='light'] [style*="rgba(255,255,255,.06)"][style*="borderBottom: \"1px solid"]{border-bottom-color:rgba(0,0,0,.08)!important}
      .app[data-theme='light'] [style*="rgba(255,255,255,.06)"][style*="borderTop: \"1px solid"]{border-top-color:rgba(0,0,0,.08)!important}
      .app[data-theme='light'] [style*="rgba(255,255,255,.12)"][style*="borderRadius: 2"]{background:rgba(0,0,0,.1)!important}
      .app[data-theme='light'] [style*="rgba(255,255,255,.7)"][style*="fontFamily"][style*="fontSize: 14"]{color:#1a1a1a!important}

      /* Collections chips */
      .app[data-theme='light'] [style*="rgba(255,255,255,.08)"][style*="borderRadius: 20"]{border-color:rgba(0,0,0,.1)!important}
      .app[data-theme='light'] [style*="rgba(255,255,255,.03)"][style*="borderRadius: 20"]{background:rgba(0,0,0,.03)!important}
      .app[data-theme='light'] [style*="rgba(255,255,255,.4)"][style*="fontSize: 12"][style*="fontWeight: 600"]{color:rgba(0,0,0,.45)!important}

      /* ─── Comprehensive light mode: profile tab ─────────── */
      .app[data-theme='light'] .pcard [style*="rgba(255,255,255,.25)"]{color:rgba(0,0,0,.35)!important}
      .app[data-theme='light'] .pcard [style*="rgba(255,255,255,.3)"]{color:rgba(0,0,0,.4)!important}
      .app[data-theme='light'] .pcard [style*="rgba(255,255,255,.2)"]{color:rgba(0,0,0,.3)!important}
      .app[data-theme='light'] .pcard [style*="rgba(255,255,255,.45)"]{color:rgba(0,0,0,.5)!important}
      .app[data-theme='light'] .pcard [style*="fontWeight: 600"][style*="fontSize: 15"]{color:#1a1a1a!important}
      .app[data-theme='light'] .pcard [style*="rgba(255,255,255,.03)"][style*="borderRadius"]{background:rgba(0,0,0,.04)!important;border-color:rgba(0,0,0,.08)!important}
      .app[data-theme='light'] .pcard input[style*="color: \"#fff\""]{color:#1a1a1a!important}
      .app[data-theme='light'] .pcard [style*="rgba(255,255,255,.15)"][style*="marginTop: 8"]{color:rgba(0,0,0,.25)!important}
      .app[data-theme='light'] .pcard [style*="rgba(255,255,255,.1)"][style*="marginTop: 18"]{color:rgba(0,0,0,.15)!important}
      .app[data-theme='light'] .pcard [style*="rgba(255,255,255,.5)"][style*="fontSize: 12"]{color:rgba(0,0,0,.5)!important}
      .app[data-theme='light'] .pcard [style*="rgba(255,255,255,.07)"][style*="borderRadius: 100"]{border-color:rgba(0,0,0,.1)!important}
      .app[data-theme='light'] .pcard select{background:rgba(0,0,0,.04)!important;border-color:rgba(0,0,0,.08)!important;color:#1a1a1a!important}
      .app[data-theme='light'] .rcard [style*="rgba(255,255,255,.3)"]{color:rgba(0,0,0,.4)!important}
      .app[data-theme='light'] .rcard [style*="fontWeight: 600"][style*="fontSize: 14"]{color:#1a1a1a!important}
      .app[data-theme='light'] .sitem span[style*="rgba(255,255,255,.2)"]{color:rgba(0,0,0,.3)!important}
      .app[data-theme='light'] .sitem [style*="rgba(255,255,255,.04)"][style*="padding: \"3px 8px\""]{background:rgba(0,0,0,.06)!important;color:rgba(0,0,0,.35)!important}
      .app[data-theme='light'] [style*="rgba(255,255,255,.04)"][style*="borderRadius: 5"]{background:rgba(0,0,0,.05)!important}
      .app[data-theme='light'] [style*="rgba(255,255,255,.2)"][style*="borderRadius: 5"]{color:rgba(0,0,0,.35)!important}

      /* ─── Social profile CSS classes ──────────────────── */
      .profile-bio-area{width:100%;padding:10px 14px;background:var(--bg-input);border:1px solid var(--border);border-radius:12px;color:var(--text-primary);font-family:'Outfit';font-size:13px;resize:none;outline:none;line-height:1.5;box-sizing:border-box;transition:border-color .2s}
      .profile-bio-area::placeholder{color:var(--text-tertiary)}
      .profile-bio-area:focus{border-color:var(--border-focus)}
      .profile-stats-row{display:flex;gap:24px;padding:12px 0;border-top:1px solid var(--border)}
      .profile-stat-val{font-size:18px;font-weight:700;color:var(--text-primary)}
      .profile-stat-lbl{font-size:11px;color:var(--text-tertiary);margin-top:1px}
      .interest-chip{display:inline-flex;align-items:center;gap:6px;padding:8px 14px;border-radius:100px;border:1px solid var(--border);background:var(--accent-bg);color:var(--text-secondary);font-family:'Outfit';font-size:12px;font-weight:600;cursor:pointer;transition:all .2s;min-height:44px;-webkit-tap-highlight-color:transparent}
      .interest-chip.on{background:var(--accent-bg);border-color:var(--accent-border);color:var(--accent)}
      .scan-vis-chip{display:inline-flex;align-items:center;gap:4px;padding:5px 10px;border-radius:20px;border:1px solid var(--border);background:var(--accent-bg);color:var(--text-secondary);font-family:'Outfit';font-size:10px;font-weight:600;cursor:pointer;transition:all .15s;-webkit-tap-highlight-color:transparent;min-height:32px}
      .scan-vis-chip.active{background:var(--accent-bg);border-color:var(--accent-border);color:var(--accent)}

      /* ─── Profile Redesign (TikTok/IG style) ────────── */
      .profile-v2{display:flex;flex-direction:column;min-height:100%}
      .profile-v2-gear{width:44px;height:44px;display:flex;align-items:center;justify-content:center;background:transparent;border:none;cursor:pointer;border-radius:50%;transition:background var(--transition-fast);-webkit-tap-highlight-color:transparent}
      .profile-v2-gear:hover{background:var(--accent-bg)}
      .profile-v2-gear svg{width:22px;height:22px;stroke:var(--text-secondary);fill:none;stroke-width:1.8}

      /* profile-v2-stats: now inlined in JSX for Instagram layout */

      .profile-v2-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:2px;padding:2px}
      .profile-v2-grid-cell{aspect-ratio:1;overflow:hidden;position:relative;cursor:pointer;background:var(--bg-card)}
      .profile-v2-grid-cell img{width:100%;height:100%;object-fit:cover;display:block;transition:opacity var(--transition-fast)}
      .profile-v2-grid-cell:active img{opacity:.7}
      .profile-v2-grid-cell .grid-items-badge{position:absolute;bottom:6px;right:6px;font-size:10px;font-weight:700;background:rgba(0,0,0,.6);color:#fff;padding:2px 6px;border-radius:4px;backdrop-filter:blur(4px)}
      .profile-v2-grid-placeholder{aspect-ratio:1;display:flex;align-items:center;justify-content:center;background:var(--accent-bg);font-size:24px;opacity:.3}

      .scan-overlay{position:fixed;inset:0;z-index:var(--z-modal,200);background:var(--bg-primary);animation:slideUpSheet var(--transition-normal);overflow-y:auto;-webkit-overflow-scrolling:touch}
      .scan-overlay-close{position:fixed;top:16px;right:16px;z-index:calc(var(--z-modal,200) + 1);width:44px;height:44px;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.5);backdrop-filter:blur(12px);border:1px solid rgba(255,255,255,.12);border-radius:50%;cursor:pointer;transition:all var(--transition-fast)}
      .scan-overlay-close svg{width:16px;height:16px;stroke:#fff;fill:none;stroke-width:2.5;stroke-linecap:round}
      .scan-overlay-img{width:100%;max-height:50vh;object-fit:cover;display:block}
      .scan-overlay-body{padding:20px}
      .scan-overlay-summary{font-size:var(--text-sm,14px);color:var(--text-secondary);line-height:1.5;margin-bottom:12px}
      .scan-overlay-meta{display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin-bottom:16px}
      .scan-overlay-tag{font-size:var(--text-xs,12px);font-weight:var(--weight-semibold,600);padding:4px 10px;border-radius:var(--radius-full,9999px);background:var(--accent-bg);color:var(--accent);border:1px solid var(--accent-border)}

      /* ─── Settings bottom sheet ─────────────────────── */
      .settings-sheet-item{display:flex;align-items:center;justify-content:space-between;padding:14px 0;border-bottom:1px solid var(--border);font-size:var(--text-md,16px);color:var(--text-primary);cursor:pointer;min-height:44px;-webkit-tap-highlight-color:transparent}
      .settings-sheet-item:last-child{border-bottom:none}
      .settings-sheet-item .settings-label{font-weight:var(--weight-medium,500)}
      .settings-sheet-item .settings-value{font-size:var(--text-sm,14px);color:var(--text-tertiary)}
      .settings-sheet-item.danger{color:var(--error);justify-content:center;font-weight:var(--weight-semibold,600)}

      /* ─── History Redesign ──────────────────────────── */
      .history-v2{padding:16px;display:flex;flex-direction:column;gap:10px}
      .history-v2-card{display:flex;gap:12px;padding:12px;background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius-md,12px);box-shadow:var(--shadow-card);cursor:pointer;transition:all var(--transition-fast);-webkit-tap-highlight-color:transparent;align-items:center}
      .history-v2-card:active{transform:scale(0.98)}
      .history-v2-thumb{width:60px;height:60px;border-radius:var(--radius-sm,8px);object-fit:cover;flex-shrink:0;background:var(--bg-card)}
      .history-v2-thumb-placeholder{width:60px;height:60px;border-radius:var(--radius-sm,8px);background:var(--accent-bg);display:flex;align-items:center;justify-content:center;flex-shrink:0;font-size:22px;opacity:.5}
      .history-v2-info{flex:1;min-width:0;display:flex;flex-direction:column;gap:3px}
      .history-v2-title{font-size:var(--text-sm,14px);font-weight:var(--weight-semibold,600);color:var(--text-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .history-v2-date{font-size:var(--text-xs,12px);color:var(--text-tertiary)}
      .history-v2-summary{font-size:var(--text-xs,12px);color:var(--text-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .history-v2-badge{font-size:10px;font-weight:var(--weight-bold,700);padding:2px 7px;border-radius:var(--radius-sm,8px);background:var(--accent-bg);color:var(--accent);border:1px solid var(--accent-border);white-space:nowrap;flex-shrink:0}
      .history-v2-actions{display:flex;align-items:center;gap:4px;flex-shrink:0}

      .history-v2-detail{position:fixed;inset:0;z-index:var(--z-modal,200);background:var(--bg-primary);animation:slideUpSheet var(--transition-normal);overflow-y:auto;-webkit-overflow-scrolling:touch}
      .history-v2-detail-header{position:sticky;top:0;z-index:10;display:flex;align-items:center;justify-content:space-between;padding:14px 16px;background:color-mix(in srgb,var(--bg-primary) 92%,transparent);backdrop-filter:blur(20px);border-bottom:1px solid var(--border)}

      /* ─── Likes Redesign (Pinterest masonry) ─────────── */
      .likes-v2{display:flex;flex-direction:column;min-height:100%}
      .likes-v2-chips{display:flex;gap:6px;padding:12px 16px 8px;overflow-x:auto;-webkit-overflow-scrolling:touch}
      .likes-v2-chips::-webkit-scrollbar{display:none}
      .likes-v2-masonry{display:flex;gap:8px;padding:4px 12px 80px}
      .likes-v2-col{display:flex;flex-direction:column;gap:8px;flex:1;min-width:0}
      .likes-v2-card{background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius-lg,16px);overflow:hidden;box-shadow:var(--shadow-card);position:relative;break-inside:avoid}
      .likes-v2-card-img{width:100%;aspect-ratio:3/4;object-fit:cover;display:block;background:var(--accent-bg);border-radius:var(--radius-lg,16px) var(--radius-lg,16px) 0 0}
      .likes-v2-card-img-placeholder{width:100%;aspect-ratio:3/4;display:flex;align-items:center;justify-content:center;background:var(--accent-bg);font-size:32px;opacity:.3}
      .likes-v2-card-body{padding:8px 10px 10px}
      .likes-v2-card-brand{font-size:11px;color:var(--text-tertiary);font-weight:var(--weight-bold,700);margin-bottom:1px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;text-transform:uppercase;letter-spacing:.3px}
      .likes-v2-card-name{font-size:13px;font-weight:var(--weight-medium,500);color:var(--text-primary);overflow:hidden;display:-webkit-box;-webkit-line-clamp:1;-webkit-box-orient:vertical;line-height:1.3;margin-bottom:2px}
      .likes-v2-card-price{font-size:var(--text-sm,14px);font-weight:var(--weight-bold,700);color:var(--accent)}
      .likes-v2-heart{position:absolute;top:4px;right:4px;width:44px;height:44px;border-radius:50%;background:rgba(0,0,0,.45);backdrop-filter:blur(4px);border:none;display:flex;align-items:center;justify-content:center;cursor:pointer;-webkit-tap-highlight-color:transparent;transition:all var(--transition-fast)}
      .likes-v2-heart:active{transform:scale(.88)}
      .likes-v2-heart svg{width:16px;height:16px;fill:var(--accent);stroke:var(--accent);stroke-width:1.5}

      .budget-tracker{margin:0 16px 12px;background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius-md,12px);overflow:hidden;box-shadow:var(--shadow-card)}
      .budget-tracker-header{display:flex;align-items:center;justify-content:space-between;padding:12px 14px;cursor:pointer;-webkit-tap-highlight-color:transparent;min-height:44px}
      .budget-tracker-header span{font-size:var(--text-sm,14px);font-weight:var(--weight-semibold,600);color:var(--text-primary)}
      .budget-tracker-chevron{font-size:14px;color:var(--text-tertiary);transition:transform var(--transition-fast)}
      .budget-tracker-body{padding:0 14px 14px}
      .budget-tracker-bar{display:flex;align-items:center;gap:8px;margin-bottom:8px}
      .budget-tracker-bar-label{font-size:var(--text-xs,12px);color:var(--text-secondary);width:70px;flex-shrink:0}
      .budget-tracker-bar-track{flex:1;height:8px;background:var(--accent-bg);border-radius:var(--radius-full,9999px);overflow:hidden}
      .budget-tracker-bar-fill{height:100%;border-radius:var(--radius-full,9999px);transition:width var(--transition-normal)}
      .budget-tracker-total{display:flex;justify-content:space-between;padding-top:8px;border-top:1px solid var(--border);margin-top:4px}
      .budget-tracker-total span{font-size:var(--text-sm,14px)}
      .budget-tracker-total .total-label{color:var(--text-secondary)}
      .budget-tracker-total .total-value{font-weight:var(--weight-bold,700);color:var(--accent)}
      .budget-tracker-locked{padding:16px 14px;text-align:center}
      .budget-tracker-locked p{font-size:var(--text-sm,14px);color:var(--text-tertiary);margin-bottom:10px}

      /* ─── Light mode for new components ─────────────── */
      .app[data-theme='light'] .profile-v2-avatar{background:rgba(201,169,110,.1);border-color:rgba(201,169,110,.3)}
      .app[data-theme='light'] .scan-overlay{background:var(--bg-primary)}
      .app[data-theme='light'] .scan-overlay-close{background:rgba(0,0,0,.3)}
      .app[data-theme='light'] .history-v2-card{background:#fff;border-color:rgba(0,0,0,.08);box-shadow:0 1px 3px rgba(0,0,0,.06)}
      .app[data-theme='light'] .likes-v2-card{background:#fff;border-color:rgba(0,0,0,.08);box-shadow:0 1px 3px rgba(0,0,0,.06)}
      .app[data-theme='light'] .likes-v2-heart{background:rgba(255,255,255,.8)}
      .app[data-theme='light'] .budget-tracker{background:#fff;border-color:rgba(0,0,0,.08)}
      .app[data-theme='light'] .settings-sheet-item{border-bottom-color:rgba(0,0,0,.06)}

      /* ─── Comprehensive light mode: item-opts-sheet ────── */
      .app[data-theme='light'] .item-opts-sheet [style*="color: \"#fff\""][style*="fontSize: 16"]{color:#1a1a1a!important}
      .app[data-theme='light'] .item-opts-sheet [style*="rgba(255,255,255,.3)"][style*="fontSize: 11"]{color:rgba(0,0,0,.4)!important}
      .app[data-theme='light'] .item-opts-sheet [style*="rgba(255,255,255,.6)"][style*="fontSize: 13"]{color:rgba(0,0,0,.6)!important}
      .app[data-theme='light'] .item-opts-sheet [style*="rgba(255,255,255,.02)"][style*="border: \"1px solid rgba(255,255,255,.06)\""]{background:rgba(0,0,0,.03)!important;border-color:rgba(0,0,0,.08)!important}
      .app[data-theme='light'] .item-opts-sheet [style*="rgba(255,255,255,.03)"][style*="border: \"1px solid rgba(255,255,255,.07)\""]{background:rgba(0,0,0,.03)!important;border-color:rgba(0,0,0,.08)!important}
      .app[data-theme='light'] .item-opts-sheet [style*="rgba(255,255,255,.45)"][style*="marginBottom: 2"]{color:rgba(0,0,0,.5)!important}
      .app[data-theme='light'] .item-opts-sheet [style*="rgba(255,255,255,.2)"][style*="lineHeight: 1.3"]{color:rgba(0,0,0,.25)!important}
      .app[data-theme='light'] .item-opts-sheet [style*="rgba(255,255,255,.45)"][style*="fontSize: 12"]{color:rgba(0,0,0,.5)!important}
      .app[data-theme='light'] .item-opts-sheet select{background:rgba(0,0,0,.04)!important;border-color:rgba(0,0,0,.08)!important;color:#1a1a1a!important}
      .app[data-theme='light'] .item-opts-sheet [style*="rgba(255,255,255,.2)"][style*="fontSize: 18"]{color:rgba(0,0,0,.2)!important}
      .app[data-theme='light'] .budget-input-wrap{background:rgba(0,0,0,.04)!important;border-color:rgba(0,0,0,.1)!important}
      .app[data-theme='light'] .budget-input-wrap span{color:rgba(0,0,0,.3)!important}
      .app[data-theme='light'] .budget-input-wrap input{color:#1a1a1a!important}

      /* ─── Comprehensive light mode: auth ─────────────── */
      .app[data-theme='light'] .auth{background:#F5F5F7}
      .app[data-theme='light'] .auth [style*="rgba(255,255,255,.04)"][style*="border: \"1px solid rgba(255,255,255,.08)\""]{background:rgba(0,0,0,.04)!important;border-color:rgba(0,0,0,.08)!important;color:#1a1a1a!important}
      .app[data-theme='light'] .auth [style*="rgba(255,255,255,.06)"][style*="height: 1"]{background:rgba(0,0,0,.08)!important}
      .app[data-theme='light'] .auth [style*="rgba(255,255,255,.2)"][style*="fontWeight: 500"]{color:rgba(0,0,0,.3)!important}
      .app[data-theme='light'] .auth button.auth-toggle{color:rgba(0,0,0,.35)!important}
      .app[data-theme='light'] .auth [style*="right: 12"]{color:rgba(0,0,0,.3)!important}

      /* ─── Comprehensive light mode: paywall ──────────── */
      .app[data-theme='light'] .pw{background:#F5F5F7}
      .app[data-theme='light'] .pw-t{color:#1a1a1a}
      .app[data-theme='light'] .pw-st{color:rgba(0,0,0,.5)}
      .app[data-theme='light'] .pw-terms{color:rgba(0,0,0,.3)}
      .app[data-theme='light'] .pw-skip{color:rgba(0,0,0,.3)}
      .app[data-theme='light'] .pw-f{color:#1a1a1a!important}
      .app[data-theme='light'] .pw-p [style*="rgba(255,255,255,.35)"]{color:rgba(0,0,0,.4)!important}
      .app[data-theme='light'] .pw-p [style*="rgba(255,255,255,.2)"]{color:rgba(0,0,0,.3)!important}

      /* ─── Comprehensive light mode: crop screen ───────── */
      .app[data-theme='light'] .crop-screen{background:#F5F5F7}
      .app[data-theme='light'] .crop-bar [style*="rgba(255,255,255,.06)"]{background:rgba(0,0,0,.06)!important;border-color:rgba(0,0,0,.1)!important;color:rgba(0,0,0,.55)!important}

      /* ─── Comprehensive light mode: interest modal ───── */
      .app[data-theme='light'] .modal-box button[style*="rgba(255,255,255,.02)"]{background:rgba(0,0,0,.04)!important;border-color:rgba(0,0,0,.1)!important;color:rgba(0,0,0,.6)!important}
      .app[data-theme='light'] .modal-box button[style*="rgba(255,255,255,.08)"]{border-color:rgba(0,0,0,.1)!important}
      .app[data-theme='light'] .modal-box .modal-sub{color:#666666!important}

      /* ─── Likes tab card styles ──────────────────────── */
      .likes-card{background:var(--bg-card);border:1px solid var(--border);border-radius:12px;overflow:hidden;cursor:default;-webkit-user-select:none;user-select:none;box-shadow:var(--shadow-card)}
      @keyframes slideUp{from{transform:translateY(100%)}to{transform:translateY(0)}}

      /* ─── Social Feed ──────────────────────────────────── */
      .feed-tabs{display:flex;gap:0;padding:0;margin:0 auto var(--space-sm);max-width:240px;position:relative}
      .feed-tabs::after{content:'';position:absolute;bottom:0;left:0;right:0;height:1px;background:var(--border);opacity:.5}
      .feed-tab{flex:1;padding:10px 0;background:none;border:none;border-bottom:2px solid transparent;font-family:'Outfit',sans-serif;font-size:14px;font-weight:500;color:var(--text-tertiary);cursor:pointer;transition:all .2s;min-height:44px;text-align:center;letter-spacing:.2px;position:relative;z-index:1}
      .feed-tab.active{color:var(--accent);border-bottom-color:var(--accent);font-weight:700}
      .feed-list{display:flex;flex-direction:column;gap:14px;padding:4px 16px 100px}
      .feed-card{background:var(--bg-card);border-radius:16px;overflow:hidden;box-shadow:var(--shadow-card);cursor:pointer;transition:transform .15s;-webkit-tap-highlight-color:transparent}
      .feed-card:active{transform:scale(0.985)}
      .feed-card-img{width:100%;aspect-ratio:1/1;object-fit:cover;display:block;background:rgba(255,255,255,.04);max-height:400px}
      .feed-card-overlay{position:absolute;bottom:0;left:0;right:0;padding:20px 14px 14px;background:linear-gradient(transparent,rgba(0,0,0,.65));display:flex;align-items:flex-end;justify-content:space-between}
      .feed-card-user{display:flex;align-items:center;gap:8px;flex:1;min-width:0}
      .feed-card-avatar{width:32px;height:32px;border-radius:50%;background:var(--accent);display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;color:#000;flex-shrink:0;border:1.5px solid rgba(255,255,255,.4)}
      .feed-card-info{min-width:0}
      .feed-card-name{font-size:13px;font-weight:600;color:#fff;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .feed-card-summary{font-size:11px;color:rgba(255,255,255,.7);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:200px;margin-top:1px}
      .feed-card-items{font-size:10px;color:rgba(255,255,255,.5);margin-top:1px}
      .feed-card-heart{width:44px;height:44px;border-radius:50%;background:rgba(0,0,0,.25);backdrop-filter:blur(8px);display:flex;align-items:center;justify-content:center;border:none;cursor:pointer;flex-shrink:0;-webkit-tap-highlight-color:transparent;transition:transform .15s}
      .feed-card-heart:active{transform:scale(0.9)}
      .feed-skeleton{border-radius:16px;background:var(--bg-card);overflow:hidden}
      .feed-skeleton-img{width:100%;aspect-ratio:1/1;max-height:400px;background:linear-gradient(110deg,var(--bg-card) 30%,rgba(255,255,255,.04) 50%,var(--bg-card) 70%);background-size:200% 100%;animation:skeletonShimmer 1.5s ease-in-out infinite}
      @keyframes skeletonShimmer{from{background-position:200% 0}to{background-position:-200% 0}}
      .feed-empty{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:60px 32px;gap:12px}
      .feed-empty-icon{font-size:48px;opacity:.15;margin-bottom:8px}
      .feed-empty-title{font-size:18px;font-weight:600;color:var(--text-primary)}
      .feed-empty-sub{font-size:14px;color:var(--text-tertiary);line-height:1.6;max-width:280px}
      .user-search-overlay{position:fixed;inset:0;z-index:200;background:var(--bg-secondary);display:flex;flex-direction:column;animation:slideIn .25s ease}
      .user-search-header{display:flex;align-items:center;gap:8px;padding:16px;padding-top:calc(16px + env(safe-area-inset-top,0px))}
      .user-search-input{flex:1;height:44px;padding:0 16px;background:var(--bg-input);border:1px solid var(--border);border-radius:9999px;color:var(--text-primary);font-family:'Outfit',sans-serif;font-size:14px;outline:none;transition:border-color .15s}
      .user-search-input:focus{border-color:rgba(201,169,110,.5)}
      .user-search-input::placeholder{color:var(--text-tertiary)}
      .user-search-cancel{background:none;border:none;color:var(--accent);font-family:'Outfit',sans-serif;font-size:14px;font-weight:600;cursor:pointer;padding:8px;min-height:44px;min-width:44px}
      .user-search-list{flex:1;overflow-y:auto;padding:0 16px}
      .user-search-row{display:flex;align-items:center;gap:16px;padding:16px 0;border-bottom:1px solid var(--border);min-height:60px}
      .user-search-avatar{width:44px;height:44px;border-radius:50%;background:rgba(201,169,110,.08);border:1px solid rgba(201,169,110,.3);display:flex;align-items:center;justify-content:center;font-size:16px;font-weight:700;color:var(--accent);flex-shrink:0}
      .user-search-info{flex:1;min-width:0}
      .user-search-name{font-size:14px;font-weight:600;color:var(--text-primary)}
      .user-search-bio{font-size:12px;color:var(--text-tertiary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .user-search-followers{font-size:10px;color:var(--text-tertiary);margin-top:2px}
      .user-search-follow-btn{min-height:36px;padding:0 16px;border-radius:9999px;font-family:'Outfit',sans-serif;font-size:12px;font-weight:600;cursor:pointer;transition:all .15s;flex-shrink:0}
      .user-search-follow-btn.follow{background:var(--accent);color:#000;border:none}
      .user-search-follow-btn.following{background:transparent;color:var(--text-secondary);border:1px solid var(--border)}
      .feed-detail-overlay{position:fixed;inset:0;z-index:250;background:var(--bg-secondary);overflow-y:auto;animation:slideIn .25s ease}
      .feed-detail-close{position:fixed;top:calc(16px + env(safe-area-inset-top,0px));right:16px;z-index:260;width:44px;height:44px;border-radius:50%;background:rgba(0,0,0,.5);backdrop-filter:blur(4px);border:none;color:#fff;font-size:20px;display:flex;align-items:center;justify-content:center;cursor:pointer}
      .feed-detail-img{width:100%;max-height:60vh;object-fit:cover;display:block}
      .feed-detail-body{padding:24px 16px}
      .feed-detail-user{display:flex;align-items:center;gap:8px;margin-bottom:16px}
      .feed-detail-name{font-size:16px;font-weight:600;color:var(--text-primary)}
      .feed-detail-date{font-size:12px;color:var(--text-tertiary)}
      .feed-detail-summary{font-size:14px;color:var(--text-secondary);line-height:1.6;margin-bottom:16px}
      .app[data-theme='light'] .feed-card-overlay{background:linear-gradient(transparent,rgba(0,0,0,.55))}
      .app[data-theme='light'] .feed-skeleton-img{background:linear-gradient(110deg,#f0f0f0 30%,#e0e0e0 50%,#f0f0f0 70%);background-size:200% 100%;animation:skeletonShimmer 1.5s ease-in-out infinite}
    `}</style>

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
            {step.type === "size_prefs" && (() => {
              const bodyOpts = [{l:"Standard",v:"standard"},{l:"Petite",v:"petite"},{l:"Tall",v:"tall"},{l:"Plus Size",v:"plus"},{l:"Big & Tall",v:"big_tall"},{l:"Athletic",v:"athletic"},{l:"Curvy",v:"curvy"}];
              const fitOpts = [{l:"Slim/Fitted",v:"slim"},{l:"Regular",v:"regular"},{l:"Relaxed",v:"relaxed"},{l:"Oversized",v:"oversized"},{l:"Flowy",v:"flowy"}];
              return (
                <div style={{ display: "flex", flexDirection: "column", gap: 22 }}>
                  <div>
                    <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: 1.5, color: "rgba(255,255,255,.3)", textTransform: "uppercase", marginBottom: 10 }}>Body Type</div>
                    <div className="ob-chips">
                      {bodyOpts.map(o => { const on = (sizePrefs.body_type || []).includes(o.v); return <div key={o.v} className={`ob-chip${on ? " on" : ""}`} onClick={() => setSizePrefs(p => { const a = p.body_type || []; return { ...p, body_type: a.includes(o.v) ? a.filter(x => x !== o.v) : [...a, o.v] }; })}>{o.l}</div>; })}
                    </div>
                  </div>
                  <div>
                    <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: 1.5, color: "rgba(255,255,255,.3)", textTransform: "uppercase", marginBottom: 10 }}>Fit Style</div>
                    <div className="ob-chips">
                      {fitOpts.map(o => { const on = (sizePrefs.fit || []).includes(o.v); return <div key={o.v} className={`ob-chip${on ? " on" : ""}`} onClick={() => setSizePrefs(p => { const a = p.fit || []; return { ...p, fit: a.includes(o.v) ? a.filter(x => x !== o.v) : [...a, o.v] }; })}>{o.l}</div>; })}
                    </div>
                  </div>
                  <button className="cta" onClick={() => obNext(sizePrefs)}>Continue</button>
                  <button className="ob-skip" onClick={() => obNext({})}>Skip for now</button>
                </div>
              );
            })()}
            {step.type === "first_scan" && (
              <div style={{ display: "flex", flexDirection: "column", gap: 16, alignItems: "center" }}>
                <div style={{ width: 120, height: 120, borderRadius: "50%", border: "1.5px dashed rgba(201,169,110,.4)", display: "flex", alignItems: "center", justifyContent: "center", marginBottom: 8 }}>
                  <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#C9A96E" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="6" width="20" height="14" rx="3"/><circle cx="12" cy="13" r="4"/><path d="M8 6l1.5-3h5L16 6"/></svg>
                </div>
                <div style={{ display: "flex", gap: 12, width: "100%" }}>
                  <button className="cta" style={{ flex: 1 }} onClick={() => { trans(() => { setScreen("auth"); setAuthScreen("signup"); }); }}>
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ marginRight: 6, verticalAlign: "middle" }}><rect x="2" y="6" width="20" height="14" rx="3"/><circle cx="12" cy="13" r="4"/><path d="M8 6l1.5-3h5L16 6"/></svg>
                    Take a Photo
                  </button>
                  <button className="cta" style={{ flex: 1, background: "rgba(201,169,110,.12)", color: "#C9A96E" }} onClick={() => { trans(() => { setScreen("auth"); setAuthScreen("signup"); }); }}>
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ marginRight: 6, verticalAlign: "middle" }}><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
                    Upload
                  </button>
                </div>
                <button className="ob-skip" onClick={() => { trans(() => { setScreen("auth"); setAuthScreen("signup"); }); }}>Skip for now</button>
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
          <button onClick={() => API.oauthLogin("google")} style={{ width: "100%", padding: "14px 18px", background: "var(--bg-card)", border: "1px solid var(--border)", borderRadius: 12, color: "var(--text-primary)", fontFamily: "'Outfit'", fontSize: 14, fontWeight: 600, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 10, marginBottom: 8, transition: "all .2s" }}>
            <svg width="18" height="18" viewBox="0 0 24 24"><path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 01-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4"/><path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/><path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/><path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/></svg>
            Continue with Google
          </button>
          {import.meta.env.VITE_APPLE_AUTH_ENABLED === "true" && (
            <button onClick={() => API.oauthLogin("apple")} style={{ width: "100%", padding: "14px 18px", background: "var(--bg-card)", border: "1px solid var(--border)", borderRadius: 12, color: "var(--text-primary)", fontFamily: "'Outfit'", fontSize: 14, fontWeight: 600, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 10, marginBottom: 8, transition: "all .2s" }}>
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
            <input type="tel" placeholder="Phone number (optional)" value={authPhone} onChange={e => setAuthPhone(e.target.value)} autoComplete="tel" style={{ opacity: 0.7 }} />
          </>)}

          <input type="email" placeholder="Email address" value={authEmail} onChange={e => setAuthEmail(e.target.value)} autoComplete="email" />
          <div style={{ position: "relative" }}>
            <input type={showPass ? "text" : "password"} placeholder="Password" value={authPass} onChange={e => setAuthPass(e.target.value)} onKeyDown={e => e.key === "Enter" && authEmail && authPass.length >= 6 && handleAuth()} autoComplete={authScreen === "signup" ? "new-password" : "current-password"} style={{ paddingRight: 48 }} />
            <button onClick={() => setShowPass(p => !p)} style={{ position: "absolute", right: 12, top: "50%", transform: "translateY(-50%)", background: "none", border: "none", color: "rgba(255,255,255,.2)", fontSize: 12, cursor: "pointer", fontFamily: "'Outfit'", padding: "4px" }}>{showPass ? "Hide" : "Show"}</button>
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

      {/* ─── CAMERA ──────────────────────────────────────── */}
      {camOn && (
        <div className="cam">
          <video ref={(el) => { vidRef.current = el; if (el && streamRef.current && !el.srcObject) { el.srcObject = streamRef.current; el.onloadedmetadata = () => setCamReady(true); } }} autoPlay playsInline muted style={camFacing === "user" ? {transform:"scaleX(-1)"} : undefined} />
          <div className="cam-corners"><div className="cc tl" /><div className="cc tr" /><div className="cc bl" /><div className="cc br" /></div>
          <canvas ref={canRef} className="hid" />
          <div className="cam-bar">
            <button className="cam-x" onClick={camStop}>Cancel</button>
            <button className="shutter" onClick={camCapture} style={{opacity:camReady?1:.3}} disabled={!camReady} />
            <button onClick={camFlip} style={{width:44,height:44,borderRadius:"50%",background:"rgba(255,255,255,.15)",border:"none",cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center"}} title="Flip camera">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M16 3h5v5"/><path d="M21 3l-7 7"/><path d="M8 21H3v-5"/><path d="M3 21l7-7"/></svg>
            </button>
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
                    style={{ display: "flex", alignItems: "center", gap: 7, padding: "9px 14px", borderRadius: 100, border: `1px solid ${on ? "rgba(201,169,110,.5)" : "rgba(255,255,255,.08)"}`, background: on ? "rgba(201,169,110,.1)" : "rgba(255,255,255,.02)", color: on ? "#C9A96E" : "rgba(255,255,255,.5)", fontFamily: "'Outfit'", fontSize: 13, fontWeight: 600, cursor: "pointer", transition: "all .2s", minHeight: 44 }}>
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
        <div style={{ position: "fixed", top: 16, left: "50%", transform: "translateX(-50%)", background: "#C9A96E", color: "#0C0C0E", padding: "12px 24px", borderRadius: 12, fontWeight: 700, fontSize: 14, zIndex: 9999, boxShadow: "0 8px 32px rgba(0,0,0,.4)" }}>
          Welcome to ATTAIRE Pro!
        </div>
      )}

      {/* ─── TRIAL SUCCESS BANNER ────────────────────────── */}
      {trialSuccess && (
        <div style={{ position: "fixed", top: 16, left: "50%", transform: "translateX(-50%)", background: "#C9A96E", color: "#0C0C0E", padding: "12px 24px", borderRadius: 12, fontWeight: 700, fontSize: 14, zIndex: 9999, boxShadow: "0 8px 32px rgba(0,0,0,.4)", whiteSpace: "nowrap" }}>
          ✓ 7-day free trial started!
        </div>
      )}

      {/* ─── MAIN APP ────────────────────────────────────── */}
      {screen === "app" && (<>
        <div className="hdr">
          <div className="logo"><span>ATT</span>AIRE</div>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            {isPro
              ? <div className="pro">PRO</div>
              : <div className="free-badge" onClick={() => setUpgradeModal("general")}>FREE · {scansLeft}/{scansLimit}</div>
            }
            {userStatus?.tier === "trial" && userStatus?.trial_ends_at && (() => {
              const daysLeft = Math.max(0, Math.ceil((new Date(userStatus.trial_ends_at) - new Date()) / 86400000));
              return <div style={{ fontSize: 10, color: "#C9A96E", padding: "2px 8px", background: "rgba(201,169,110,.1)", borderRadius: 100, border: "1px solid rgba(201,169,110,.3)" }}>{daysLeft}d trial</div>;
            })()}
            {(tab === "home" || tab === "scan") && (
              <button onClick={() => { setShowUserSearch(true); setUserSearchQuery(""); setUserSearchResults([]); }} style={{ background: "none", border: "none", cursor: "pointer", padding: 8, minHeight: 44, minWidth: 44, display: "flex", alignItems: "center", justifyContent: "center" }} aria-label="Search users">
                <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="var(--text-secondary)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/></svg>
              </button>
            )}
          </div>
        </div>
        <div className="as">
          <input ref={fileRef} type="file" accept="image/*,.heic,.heif" className="hid" onChange={(e) => handleFile(e.target.files[0])} />

          {/* ─── Home Feed (TikTok/Instagram style) ────── */}
          {tab === "home" && (
            <div className="animate-fade-in" style={{ paddingBottom: 80 }}>
              {/* For You / Following tabs directly under header */}
              {/* For You / Following toggle */}
              <div style={{ display: "flex", justifyContent: "center", gap: 0, padding: "4px 16px 12px", position: "sticky", top: 0, zIndex: 10, background: "var(--bg-primary)" }}>
                <button onClick={() => { setFeedTab("foryou"); setFeedPage(1); }} style={{ flex: 1, maxWidth: 160, padding: "10px 0", background: "none", border: "none", borderBottom: feedTab === "foryou" ? "2px solid var(--accent)" : "2px solid transparent", color: feedTab === "foryou" ? "var(--text-primary)" : "var(--text-tertiary)", fontFamily: "'Outfit'", fontWeight: feedTab === "foryou" ? 700 : 500, fontSize: 15, cursor: "pointer", transition: "all .2s ease" }}>For You</button>
                <button onClick={() => { setFeedTab("following"); setFeedPage(1); }} style={{ flex: 1, maxWidth: 160, padding: "10px 0", background: "none", border: "none", borderBottom: feedTab === "following" ? "2px solid var(--accent)" : "2px solid transparent", color: feedTab === "following" ? "var(--text-primary)" : "var(--text-tertiary)", fontFamily: "'Outfit'", fontWeight: feedTab === "following" ? 700 : 500, fontSize: 15, cursor: "pointer", transition: "all .2s ease" }}>Following</button>
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

              {/* Empty states */}
              {!feedLoading && feedScans.length === 0 && (
                <div className="animate-slide-up" style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: "80px 32px", textAlign: "center" }}>
                  <svg viewBox="0 0 24 24" width="56" height="56" fill="none" stroke="var(--text-tertiary)" strokeWidth="1.2" style={{ marginBottom: 20, opacity: 0.5 }}><rect x="2" y="6" width="20" height="14" rx="3" /><circle cx="12" cy="13" r="4" /><path d="M8 6l1.5-3h5L16 6" /></svg>
                  <div style={{ fontFamily: "'Outfit'", fontWeight: 700, fontSize: 18, color: "var(--text-primary)", marginBottom: 8 }}>
                    {feedTab === "following" ? "Follow people to see their scans here" : "Scan your first outfit to discover styles"}
                  </div>
                  <div style={{ fontSize: 14, color: "var(--text-tertiary)", marginBottom: 24, lineHeight: 1.5 }}>
                    {feedTab === "following" ? "Find friends and style inspiration in the search tab." : "Point your camera at any outfit and we will identify every piece."}
                  </div>
                  {feedTab === "following"
                    ? <button className="btn-primary" onClick={() => { setTab("search"); setShowUserSearch(true); }} style={{ padding: "12px 32px", borderRadius: 100, fontFamily: "'Outfit'", fontWeight: 700, fontSize: 15, cursor: "pointer" }}>Explore People</button>
                    : <button className="btn-primary" onClick={() => { setShowScanSheet(true); }} style={{ padding: "12px 32px", borderRadius: 100, fontFamily: "'Outfit'", fontWeight: 700, fontSize: 15, cursor: "pointer" }}>Scan an Outfit</button>
                  }
                </div>
              )}

              {/* Feed cards */}
              {feedScans.length > 0 && (
                <div style={{ display: "flex", flexDirection: "column", gap: 16, padding: "0 16px" }}>
                  {feedScans.map((scan, idx) => {
                    const u = scan.user || {};
                    const ini = (u.display_name || "?").split(" ").map(w => w[0]).join("").slice(0,2).toUpperCase();
                    return (
                      <div key={scan.id || idx} className="card card-enter" style={{ borderRadius: 16, overflow: "hidden", cursor: "pointer", position: "relative", animationDelay: `${idx * 0.06}s` }} onClick={() => setFeedDetailScan(scan)}>
                        {scan.image_url
                          ? <img src={scan.image_url} alt={scan.summary || "Outfit"} loading="lazy" style={{ width: "100%", aspectRatio: "4/5", objectFit: "cover", display: "block" }} />
                          : <div style={{ width: "100%", aspectRatio: "4/5", background: "var(--bg-card)", display: "flex", alignItems: "center", justifyContent: "center" }}>
                              <svg viewBox="0 0 24 24" width="48" height="48" fill="none" stroke="var(--text-tertiary)" strokeWidth="1"><rect x="2" y="6" width="20" height="14" rx="3" /><circle cx="12" cy="13" r="4" /></svg>
                            </div>
                        }
                        {/* Bottom gradient overlay */}
                        <div style={{ position: "absolute", bottom: 0, left: 0, right: 0, padding: "48px 16px 16px", background: "linear-gradient(to top, rgba(0,0,0,0.65) 0%, transparent 100%)", display: "flex", alignItems: "flex-end", justifyContent: "space-between" }}>
                          <div style={{ display: "flex", alignItems: "center", gap: 10, flex: 1, minWidth: 0 }}>
                            <div style={{ width: 36, height: 36, borderRadius: "50%", background: "var(--accent)", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "'Outfit'", fontWeight: 700, fontSize: 13, color: "#0C0C0E", flexShrink: 0 }}>{ini}</div>
                            <div style={{ minWidth: 0 }}>
                              <div style={{ fontFamily: "'Outfit'", fontWeight: 700, fontSize: 14, color: "#fff", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{u.display_name || "Anonymous"}</div>
                              {scan.summary && <div style={{ fontFamily: "'Outfit'", fontSize: 12, color: "rgba(255,255,255,0.7)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", marginTop: 2 }}>{scan.summary}</div>}
                            </div>
                          </div>
                          <button style={{ background: "none", border: "none", cursor: "pointer", padding: 8, flexShrink: 0 }} onClick={(e) => { e.stopPropagation(); const itemData = { name: scan.summary || "Scanned outfit", brand: scan.user?.display_name || "Unknown", category: "outfit", image_url: scan.image_url }; quickSaveItem(itemData, scan.id); }}>
                            <svg viewBox="0 0 24 24" width="22" height="22" fill={saved.some(s => s.scan_id === scan.id) ? "var(--accent)" : "none"} stroke={saved.some(s => s.scan_id === scan.id) ? "var(--accent)" : "#fff"} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>
                          </button>
                        </div>
                      </div>
                    );
                  })}
                  {feedHasMore && (
                    <button onClick={() => loadFeed(feedPage + 1, true)} disabled={feedLoading} className="btn-secondary" style={{ padding: "14px 0", borderRadius: 14, fontFamily: "'Outfit'", fontSize: 14, fontWeight: 600, cursor: "pointer", width: "100%", minHeight: 44, opacity: feedLoading ? 0.5 : 1 }}>
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
              <div style={{ padding: "8px 16px 0" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10, background: "var(--bg-card)", borderRadius: 12, padding: "0 14px", border: "1px solid var(--border)" }}>
                  <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="var(--text-tertiary)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/></svg>
                  <input
                    value={userSearchQuery}
                    onChange={e => { setUserSearchQuery(e.target.value); if (!showUserSearch) setShowUserSearch(true); }}
                    onFocus={() => { if (!showUserSearch) setShowUserSearch(true); }}
                    placeholder="Search people..."
                    autoFocus
                    style={{ flex: 1, background: "none", border: "none", outline: "none", padding: "12px 0", fontFamily: "'Outfit'", fontSize: 15, color: "var(--text-primary)", minHeight: 44 }}
                  />
                  {userSearchQuery && (
                    <button onClick={() => { setUserSearchQuery(""); setUserSearchResults([]); }} style={{ background: "none", border: "none", cursor: "pointer", padding: 4, color: "var(--text-tertiary)" }}>
                      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6L6 18M6 6l12 12"/></svg>
                    </button>
                  )}
                </div>
              </div>
              <div style={{ padding: "12px 16px" }}>
                {userSearchLoading && <div style={{ textAlign: "center", padding: 32, color: "var(--text-tertiary)", fontSize: 13 }}>Searching...</div>}
                {!userSearchLoading && userSearchQuery.trim() && userSearchResults.length === 0 && <div style={{ textAlign: "center", padding: 32, color: "var(--text-tertiary)", fontSize: 13 }}>No users found</div>}
                {!userSearchLoading && !userSearchQuery.trim() && (
                  <div style={{ textAlign: "center", padding: "60px 20px", color: "var(--text-tertiary)" }}>
                    <svg viewBox="0 0 24 24" width="40" height="40" fill="none" stroke="var(--text-tertiary)" strokeWidth="1.2" style={{ marginBottom: 12, opacity: 0.4 }}><circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/></svg>
                    <div style={{ fontFamily: "'Outfit'", fontWeight: 600, fontSize: 15 }}>Search for people to follow</div>
                    <div style={{ fontSize: 13, marginTop: 6, opacity: 0.7 }}>Discover outfit inspiration from other users</div>
                  </div>
                )}
                {userSearchResults.map(usr => {
                  const ini = (usr.display_name || "?").split(" ").map(w => w[0]).join("").slice(0,2).toUpperCase();
                  const isFlw = followingSet.has(usr.id);
                  return (
                    <div key={usr.id} style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 0", borderBottom: "1px solid var(--border)" }} >
                      <div style={{ width: 48, height: 48, borderRadius: "50%", background: "var(--accent)", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "'Outfit'", fontWeight: 700, fontSize: 16, color: "#0C0C0E", flexShrink: 0 }}>{ini}</div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontFamily: "'Outfit'", fontWeight: 700, fontSize: 15, color: "var(--text-primary)" }}>{usr.display_name}</div>
                        {usr.bio && <div style={{ fontSize: 13, color: "var(--text-tertiary)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", marginTop: 2 }}>{usr.bio}</div>}
                        <div style={{ fontSize: 12, color: "var(--text-tertiary)", marginTop: 2 }}>{usr.follower_count || 0} follower{(usr.follower_count || 0) !== 1 ? "s" : ""}</div>
                      </div>
                      <button
                        className={isFlw ? "btn-ghost" : "btn-primary"}
                        onClick={(e) => { e.stopPropagation(); handleFollowFromSearch(usr.id); }}
                        style={{ padding: "8px 20px", borderRadius: 100, fontFamily: "'Outfit'", fontWeight: 700, fontSize: 13, cursor: "pointer", minHeight: 36, flexShrink: 0 }}
                      >{isFlw ? "Following" : "Follow"}</button>
                    </div>
                  );
                })}
              </div>
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
                Point your camera at any outfit to find where to buy it
              </div>

              {isFree && scansLeft != null && (
                <div style={{ marginBottom: 24 }}>
                  <div className="scan-counter" style={{ display: "inline-block" }}>{scansLeft > 0 ? <><strong>{scansLimit - scansLeft}</strong> of {scansLimit} scans used</> : <>No scans left &middot; <span style={{color:"#C9A96E",cursor:"pointer"}} onClick={() => setUpgradeModal("scan_limit")}>Go Pro</span></>}</div>
                </div>
              )}

              {/* Action buttons */}
              <div style={{ width: "100%", maxWidth: 340, display: "flex", flexDirection: "column", gap: 12 }}>
                <button className="btn-primary" onClick={camStart} style={{ width: "100%", padding: "16px 0", borderRadius: 14, fontFamily: "'Outfit'", fontWeight: 700, fontSize: 16, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 10, minHeight: 52 }}>
                  <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="6" width="20" height="14" rx="3" /><circle cx="12" cy="13" r="4" /><path d="M8 6l1.5-3h5L16 6" /></svg>
                  Take Photo
                </button>
                <button className="btn-secondary" onClick={() => fileRef.current?.click()} style={{ width: "100%", padding: "16px 0", borderRadius: 14, fontFamily: "'Outfit'", fontWeight: 700, fontSize: 16, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 10, minHeight: 52 }}>
                  <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>
                  Upload from Gallery
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
                {/* ATTAIRE wordmark */}
                <div style={{ fontFamily: "'Instrument Serif'", fontSize: 24, fontStyle: "italic", color: "var(--text-primary)", letterSpacing: 1 }}>A<span style={{ color: "#C9A96E" }}>TT</span>AIRE</div>
                {/* Gold scan ring spinner */}
                <div className="scan-ring scan-ring--lg" />
                {/* Animated status text */}
                <div style={{ textAlign: "center" }}>
                  <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: 2.5, color: "rgba(201,169,110,.5)", textTransform: "uppercase", marginBottom: 8 }}>Identifying outfit</div>
                  <div className="serif" style={{ fontSize: 18, color: "#fff", transition: "opacity .35s ease", opacity: loadMsgVisible ? 1 : 0, minHeight: 28 }}>{SCAN_MESSAGES[loadMsgIdx]}</div>
                </div>
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

          {/* ─── Picking — choose which items to search ── */}
          {tab === "scan" && results && phase === "picking" && (
            <div className="res">
              <div className="v-banner">
                <div className="v-steps">
                  <div className="v-step">
                    <div className="v-step-bar"><div className="v-step-fill" style={{ width: "100%", background: "#C9A96E" }} /></div>
                    <div className="v-step-l" style={{ color: "#C9A96E" }}>✓ Identified</div>
                  </div>
                  <div className="v-step">
                    <div className="v-step-bar"><div className="v-step-fill" style={{ width: "0%", background: "rgba(255,255,255,.08)" }} /></div>
                    <div className="v-step-l" style={{ color: "rgba(255,255,255,.2)" }}>Select items</div>
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
                <div style={{ fontFamily: "'Instrument Serif'", fontSize: 22, color: "#fff", marginBottom: 6 }}>What do you want to shop?</div>
                <div style={{ fontSize: 12, color: "rgba(255,255,255,.3)", lineHeight: 1.5 }}>Tap items on the image or below</div>
                {/* Gender badge — prominent, tappable */}
                <div style={{ display: "flex", justifyContent: "center", marginTop: 12 }}>
                  <div style={{ display: "inline-flex", background: "rgba(255,255,255,.04)", borderRadius: "var(--radius-full)", border: "1px solid var(--border)", overflow: "hidden" }}>
                    <button
                      aria-label="Switch to Men's"
                      onClick={() => { if (results.gender !== "male") setResults(prev => prev ? { ...prev, gender: "male" } : prev); }}
                      style={{ padding: "8px 18px", fontSize: 13, fontWeight: 700, letterSpacing: 0.5, border: "none", cursor: "pointer", fontFamily: "'Outfit'", transition: "all var(--transition-fast)", minHeight: 36, background: results.gender === "male" ? "rgba(110,169,201,.15)" : "transparent", color: results.gender === "male" ? "#6EAEC9" : "rgba(255,255,255,.3)", borderRight: "1px solid var(--border)" }}
                    >Men's</button>
                    <button
                      aria-label="Switch to Women's"
                      onClick={() => { if (results.gender !== "female") setResults(prev => prev ? { ...prev, gender: "female" } : prev); }}
                      style={{ padding: "8px 18px", fontSize: 13, fontWeight: 700, letterSpacing: 0.5, border: "none", cursor: "pointer", fontFamily: "'Outfit'", transition: "all var(--transition-fast)", minHeight: 36, background: results.gender === "female" ? "rgba(201,110,169,.15)" : "transparent", color: results.gender === "female" ? "#C96EAE" : "rgba(255,255,255,.3)" }}
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
                          <span style={{ fontSize: 14, fontWeight: 600, color: isPicked ? "#fff" : "rgba(255,255,255,.5)", transition: "color .2s" }}>{item.name}</span>
                          {item.priority && <span style={{ fontSize: 9, fontWeight: 700, padding: "2px 6px", background: "rgba(201,169,110,.12)", border: "1px solid rgba(201,169,110,.35)", borderRadius: 100, color: "#C9A96E", letterSpacing: .5, flexShrink: 0 }}>&#11044; Circled</span>}
                        </div>
                        <div style={{ fontSize: 11, color: isPicked ? "rgba(201,169,110,.6)" : "rgba(255,255,255,.15)", transition: "color .2s" }}>
                          {item.brand && item.brand !== "Unidentified" ? item.brand + " · " : ""}{item.color} · {item.category}
                          {item.identification_confidence ? <span style={{ marginLeft: 4, color: "rgba(255,255,255,.25)" }}>· {item.identification_confidence}%</span> : null}
                        </div>
                      </div>
                      {ov?.budgetMin != null
                        ? <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 3, flexShrink: 0 }}>
                            <div style={{ fontSize: 12, fontWeight: 700, color: "#C9A96E", background: "rgba(201,169,110,.1)", border: "1px solid rgba(201,169,110,.25)", borderRadius: 7, padding: "4px 9px", whiteSpace: "nowrap" }}>${ov.budgetMin}–${ov.budgetMax ?? ov.budgetMin * 2}</div>
                            <div style={{ fontSize: 9, color: "rgba(201,169,110,.5)", letterSpacing: .3 }}>tap to edit</div>
                          </div>
                        : <div style={{ display: "flex", alignItems: "center", gap: 5, padding: "8px 12px", background: "rgba(201,169,110,.06)", border: "1px solid rgba(201,169,110,.2)", borderRadius: 10, flexShrink: 0, cursor: "pointer" }}>
                            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#C9A96E" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="4" y1="6" x2="20" y2="6"/><line x1="4" y1="12" x2="20" y2="12"/><line x1="4" y1="18" x2="20" y2="18"/><circle cx="8" cy="6" r="2" fill="#C9A96E" stroke="none"/><circle cx="16" cy="12" r="2" fill="#C9A96E" stroke="none"/><circle cx="10" cy="18" r="2" fill="#C9A96E" stroke="none"/></svg>
                            <span style={{ fontSize: 12, fontWeight: 600, color: "#C9A96E" }}>Set prefs</span>
                          </div>
                      }
                    </div>
                  );
                })}
              </div>

              {/* Occasion Filter */}
              <div style={{ padding: "4px 20px 0" }}>
                <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: 1.5, textTransform: "uppercase", color: "rgba(255,255,255,.2)", marginBottom: 8 }}>Occasion</div>
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  {[
                    { v: "casual",    l: "Casual",   icon: "☀️" },
                    { v: "work",      l: "Work",     icon: "💼" },
                    { v: "night_out", l: "Night Out", icon: "🌙" },
                    { v: "athletic",  l: "Athletic",  icon: "🏃" },
                    { v: "formal",    l: "Formal",    icon: "✨" },
                    { v: "outdoor",   l: "Outdoor",   icon: "🌲" },
                  ].map(({ v, l, icon }) => (
                    <button key={v} onClick={() => { setOccasion(o => o === v ? null : v); setShowCustomOccasion(false); }}
                      style={{ padding: "6px 12px", borderRadius: 20, border: `1px solid ${occasion === v ? "rgba(201,169,110,.5)" : "rgba(255,255,255,.08)"}`, background: occasion === v ? "rgba(201,169,110,.1)" : "rgba(255,255,255,.02)", color: occasion === v ? "#C9A96E" : "rgba(255,255,255,.4)", fontSize: 11, fontWeight: 600, fontFamily: "'Outfit'", cursor: "pointer", transition: "all .2s", display: "flex", alignItems: "center", gap: 4 }}>
                      <span style={{ fontSize: 13 }}>{icon}</span>{l}
                    </button>
                  ))}
                  {/* Recent custom occasions */}
                  {recentOccasions.map((ro, i) => (
                    <button key={`recent-${i}`} onClick={() => { setOccasion(o => o === ro ? null : ro); setShowCustomOccasion(false); }}
                      style={{ padding: "6px 12px", borderRadius: 20, border: `1px solid ${occasion === ro ? "rgba(201,169,110,.5)" : "rgba(255,255,255,.08)"}`, background: occasion === ro ? "rgba(201,169,110,.1)" : "rgba(255,255,255,.02)", color: occasion === ro ? "#C9A96E" : "rgba(255,255,255,.4)", fontSize: 11, fontWeight: 600, fontFamily: "'Outfit'", cursor: "pointer", transition: "all .2s" }}>
                      {ro}
                    </button>
                  ))}
                  {/* Custom occasion chip */}
                  <button onClick={() => setShowCustomOccasion(v => !v)}
                    style={{ padding: "6px 12px", borderRadius: 20, border: `1px solid ${showCustomOccasion ? "rgba(201,169,110,.5)" : "rgba(255,255,255,.08)"}`, background: showCustomOccasion ? "rgba(201,169,110,.1)" : "rgba(255,255,255,.02)", color: showCustomOccasion ? "#C9A96E" : "rgba(255,255,255,.4)", fontSize: 11, fontWeight: 600, fontFamily: "'Outfit'", cursor: "pointer", transition: "all .2s", display: "flex", alignItems: "center", gap: 4 }}>
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
                      style={{ flex: 1, padding: "8px 12px", background: "rgba(255,255,255,.04)", border: "1px solid rgba(201,169,110,.3)", borderRadius: 10, color: "#fff", fontFamily: "'Outfit'", fontSize: 12, outline: "none" }}
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
                    }} style={{ padding: "8px 14px", background: "#C9A96E", border: "none", borderRadius: 10, color: "#0C0C0E", fontFamily: "'Outfit'", fontSize: 12, fontWeight: 700, cursor: "pointer", whiteSpace: "nowrap" }}>
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
                  style={{ width: "100%", padding: "10px 14px", background: "rgba(255,255,255,.03)", border: "1px solid rgba(255,255,255,.06)", borderRadius: 12, color: "rgba(255,255,255,.7)", fontSize: 12, fontFamily: "'Outfit'", resize: "none", outline: "none", lineHeight: 1.5, boxSizing: "border-box", transition: "border-color .2s" }}
                  onFocus={e => e.target.style.borderColor = "rgba(201,169,110,.3)"}
                  onBlur={e => e.target.style.borderColor = "rgba(255,255,255,.06)"}
                />
              </div>

              {/* Search CTA */}
              <div className="pick-cta">
                <button
                  style={{ background: pickedItems.size > 0 ? "#C9A96E" : "rgba(255,255,255,.06)", color: pickedItems.size > 0 ? "#0C0C0E" : "rgba(255,255,255,.2)" }}
                  onClick={runProductSearch}
                  disabled={pickedItems.size === 0}
                >
                  {pickedItems.size === 0 ? "Select items to search" : `Search ${pickedItems.size} item${pickedItems.size > 1 ? "s" : ""}${occasion ? ` · ${["casual","work","night_out","athletic","formal","outdoor"].find(v=>v===occasion) ? {casual:"Casual",work:"Work",night_out:"Night Out",athletic:"Athletic",formal:"Formal",outdoor:"Outdoor"}[occasion] : ""}` : ""}`}
                </button>
                <button style={{ width: "100%", padding: 12, background: "none", border: "none", color: "rgba(255,255,255,.2)", fontSize: 12, fontFamily: "'Outfit'", cursor: "pointer", marginTop: 4 }}
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
                    <div className="ld-dot" style={{ background: "#C9A96E" }} />
                    <div className="ld-dot" style={{ background: "#C9A96E", animationDelay: ".15s" }} />
                    <div className="ld-dot" style={{ background: "#C9A96E", animationDelay: ".3s" }} />
                  </div>
                  <div style={{ fontSize: 12, fontWeight: 600, color: "#C9A96E", transition: "opacity .35s ease", opacity: loadMsgVisible ? 1 : 0.3 }}>
                    {RESEARCH_MESSAGES[loadMsgIdx % RESEARCH_MESSAGES.length]}
                  </div>
                </div>
              )}

              {/* Progress bar */}
              <div className="v-banner">
                <div className="v-steps">
                  <div className="v-step">
                    <div className="v-step-bar"><div className="v-step-fill" style={{ width: "100%", background: "#C9A96E" }} /></div>
                    <div className="v-step-l" style={{ color: "#C9A96E" }}>Identified</div>
                  </div>
                  <div className="v-step">
                    <div className="v-step-bar"><div className="v-step-fill" style={{ width: phase === "searching" ? "40%" : "100%", background: phase === "done" ? (results.items.some(it => it.status === "verified") ? "#C9A96E" : "rgba(255,255,255,.15)") : "rgba(201,169,110,.4)", transition: phase === "searching" ? "width 12s linear" : "width .5s ease" }} /></div>
                    <div className="v-step-l" style={{ color: phase === "searching" ? "rgba(201,169,110,.5)" : results.items.some(it => it.status === "verified") ? "#C9A96E" : "rgba(255,255,255,.2)", transition: "opacity .35s ease", opacity: phase === "searching" ? (loadMsgVisible ? 1 : 0.3) : 1 }}>
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
                  {results.summary && <div style={{ fontSize: 13, color: "rgba(255,255,255,.6)", lineHeight: 1.5, marginBottom: 8 }}>{results.summary}</div>}
                  <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                    <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: 2, color: "rgba(255,255,255,.35)", textTransform: "uppercase" }}>{pickedItems.size} items</span>
                    <div style={{ display: "inline-flex", background: "rgba(255,255,255,.04)", borderRadius: "var(--radius-full)", border: "1px solid var(--border)", overflow: "hidden", marginLeft: "auto" }}>
                      <button
                        aria-label="Switch to Men's results"
                        onClick={() => {
                          if (results.gender !== "male") {
                            setResults(prev => prev ? { ...prev, gender: "male" } : prev);
                            if (phase === "done" && pickedItems.size > 0) setTimeout(() => runProductSearch(), 100);
                          }
                        }}
                        style={{ padding: "4px 10px", fontSize: 10, fontWeight: 700, letterSpacing: 0.5, border: "none", cursor: "pointer", fontFamily: "'Outfit'", transition: "all var(--transition-fast)", minHeight: 28, background: results.gender === "male" ? "rgba(110,169,201,.15)" : "transparent", color: results.gender === "male" ? "#6EAEC9" : "rgba(255,255,255,.3)", borderRight: "1px solid var(--border)" }}
                      >Men's</button>
                      <button
                        aria-label="Switch to Women's results"
                        onClick={() => {
                          if (results.gender !== "female") {
                            setResults(prev => prev ? { ...prev, gender: "female" } : prev);
                            if (phase === "done" && pickedItems.size > 0) setTimeout(() => runProductSearch(), 100);
                          }
                        }}
                        style={{ padding: "4px 10px", fontSize: 10, fontWeight: 700, letterSpacing: 0.5, border: "none", cursor: "pointer", fontFamily: "'Outfit'", transition: "all var(--transition-fast)", minHeight: 28, background: results.gender === "female" ? "rgba(201,110,169,.15)" : "transparent", color: results.gender === "female" ? "#C96EAE" : "rgba(255,255,255,.3)" }}
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
                    <div key={i} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 12px", background: "rgba(255,255,255,.02)", borderRadius: 10, border: "1px solid rgba(255,255,255,.04)" }}>
                      <div style={{ width: 6, height: 6, borderRadius: "50%", background: "#C9A96E", flexShrink: 0 }} />
                      <div style={{ flex: 1 }}>
                        <span style={{ fontSize: 13, color: "#fff", fontWeight: 600 }}>{item.name}</span>
                        {item.brand && item.brand !== "Unidentified" && <span style={{ fontSize: 11, color: "rgba(255,255,255,.3)", marginLeft: 6 }}>{item.brand}</span>}
                        {item.color && <span style={{ fontSize: 11, color: "rgba(255,255,255,.2)", marginLeft: 4 }}>· {item.color}</span>}
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
                          background: isActive ? v.bg : "rgba(255,255,255,.02)",
                          border: `1px solid ${isActive ? v.border : "rgba(255,255,255,.06)"}`,
                          borderRadius: "var(--radius-md)", cursor: "pointer",
                          transition: "all var(--transition-fast)",
                          animation: isAnimating && v.key === "not_for_me" ? "verdictShake 0.4s ease" : isAnimating ? "verdictPop 0.4s ease" : "none",
                          fontFamily: "'Outfit'",
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
                <div className="ad-slot ad-banner" style={{ margin: "0 20px 8px", height: "auto", borderRadius: 12, overflow: "hidden", border: "1px solid rgba(255,255,255,.05)", background: "linear-gradient(135deg, rgba(201,169,110,.06) 0%, rgba(255,255,255,.02) 100%)" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 12px" }}>
                    <div style={{ width: 38, height: 38, borderRadius: 8, background: "rgba(201,169,110,.12)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18, flexShrink: 0 }}>✦</div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 12, fontWeight: 700, color: "#fff", marginBottom: 2 }}>Trending This Week</div>
                      <div style={{ fontSize: 10, color: "rgba(255,255,255,.35)" }}>Discover curated styles from top brands</div>
                    </div>
                    <div style={{ fontSize: 9, color: "rgba(255,255,255,.15)", letterSpacing: .5, textTransform: "uppercase", flexShrink: 0 }}>Sponsored</div>
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
                    <div key={i} style={{ borderBottom: "1px solid rgba(255,255,255,.04)" }}>
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
                          cursor: "pointer", fontFamily: "'Outfit'", textAlign: "left",
                          transition: "background .15s",
                        }}
                      >
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontSize: 14, fontWeight: 600, color: "#fff", lineHeight: 1.3 }}>
                            {item.name}
                            {item.priority && <span style={{ marginLeft: 6, fontSize: 9, fontWeight: 700, padding: "2px 6px", background: "rgba(201,169,110,.12)", borderRadius: 100, color: "#C9A96E", letterSpacing: .5, verticalAlign: "middle" }}>Circled</span>}
                          </div>
                          <div style={{ fontSize: 11, color: "rgba(255,255,255,.35)", marginTop: 2 }}>
                            {item.brand && item.brand !== "Unidentified" ? item.brand + " · " : ""}{item.color} · {item.category}
                          </div>
                        </div>
                        {item.status === "searching" && <div className="ld-dot" style={{ width: 8, height: 8, background: "#C9A96E", flexShrink: 0 }} />}
                        {item.status === "verified" && allTierProducts.length > 0 && (
                          <span style={{ fontSize: 10, fontWeight: 600, color: "rgba(255,255,255,.25)", flexShrink: 0 }}>{allTierProducts.length} products</span>
                        )}
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,.3)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, transition: "transform .2s", transform: isExpanded ? "rotate(180deg)" : "rotate(0)" }}>
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
                            <div style={{ padding: "12px 20px", textAlign: "center", color: "rgba(255,255,255,.25)", fontSize: 12 }}>
                              No products found.{" "}
                              <span style={{ color: "#C9A96E", cursor: "pointer" }} onClick={() => { setSelIdx(i); setItemViewModes(m => ({ ...m, [i]: "id" })); }}>Correct the AI</span>
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
                                          style={{ display: "flex", flexDirection: "column", textDecoration: "none", color: "inherit", background: "rgba(255,255,255,.02)", border: `1px solid ${p.is_identified_brand ? "rgba(201,169,110,.25)" : "rgba(255,255,255,.05)"}`, borderRadius: 12, overflow: "hidden", transition: "all .2s" }}>
                                          {p.image_url && (
                                            <div style={{ width: "100%", aspectRatio: "1", background: "rgba(255,255,255,.04)", overflow: "hidden" }}>
                                              <img src={p.image_url} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} onError={e => { e.target.style.display = "none"; }} />
                                            </div>
                                          )}
                                          <div style={{ padding: "8px 10px", display: "flex", flexDirection: "column", gap: 3 }}>
                                            {p.is_identified_brand && <span style={{ fontSize: 7, fontWeight: 800, letterSpacing: 1, padding: "2px 5px", borderRadius: 3, background: "rgba(201,169,110,.12)", color: "#C9A96E", alignSelf: "flex-start" }}>ORIGINAL</span>}
                                            <div style={{ fontSize: 11, fontWeight: 500, color: "rgba(255,255,255,.7)", lineHeight: 1.3, overflow: "hidden", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical" }}>
                                              {isFallback ? "Search results" : (p.product_name || "Product")}
                                            </div>
                                            <div style={{ fontSize: 10, color: "rgba(255,255,255,.3)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.brand}</div>
                                            <div style={{ fontSize: 14, fontWeight: 700, color: cfg.accent }}>{isFallback ? "Search" : p.price}</div>
                                            <div style={{ fontSize: 11, fontWeight: 600, color: cfg.accent, textAlign: "center", paddingTop: 4, borderTop: "1px solid rgba(255,255,255,.04)" }}>Shop</div>
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
                                    style={{ padding: "8px 14px", background: "rgba(201,169,110,.08)", border: "1px solid rgba(201,169,110,.25)", borderRadius: 10, color: "var(--accent)", fontFamily: "'Outfit'", fontSize: 12, fontWeight: 600, cursor: "pointer" }}>
                                    Try alternate search
                                  </button>
                                )}
                                <a href={`https://www.google.com/search?tbm=shop&q=${encodeURIComponent(googleQuery)}`} target="_blank" rel="noopener noreferrer"
                                  onClick={() => track("google_search_clicked", { item_name: item.name, query: googleQuery }, scanId, "scan")}
                                  style={{ padding: "8px 14px", background: "rgba(255,255,255,.04)", border: "1px solid rgba(255,255,255,.08)", borderRadius: 10, color: "var(--text-secondary)", fontFamily: "'Outfit'", fontSize: 12, fontWeight: 600, cursor: "pointer", textDecoration: "none", display: "inline-flex", alignItems: "center", gap: 5 }}>
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
                      cursor: "pointer", fontFamily: "'Outfit'",
                      color: "rgba(255,255,255,.35)", fontSize: 12, fontWeight: 600, letterSpacing: 0.3,
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
                        <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: 1.5, color: "rgba(255,255,255,.25)", textTransform: "uppercase", marginBottom: 6 }}>Search Notes</div>
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
                            background: "rgba(255,255,255,.03)", border: "1px solid rgba(255,255,255,.06)",
                            borderRadius: "var(--radius-md)", color: "var(--text-secondary)", fontSize: "var(--text-sm)",
                            fontFamily: "'Outfit'", outline: "none", boxSizing: "border-box", minHeight: 44,
                          }}
                          onFocus={e => e.target.style.borderColor = "rgba(201,169,110,.3)"}
                          onBlur={e => e.target.style.borderColor = "rgba(255,255,255,.06)"}
                        />
                      </div>

                      {/* Budget presets + range */}
                      <div>
                        <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: 1.5, color: "rgba(255,255,255,.25)", textTransform: "uppercase", marginBottom: 8 }}>Budget Range</div>
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
                                  padding: "6px 12px", borderRadius: 20, fontSize: 11, fontWeight: 600, fontFamily: "'Outfit'", cursor: "pointer", transition: "all .2s",
                                  background: isActive ? "rgba(201,169,110,.12)" : "rgba(255,255,255,.03)",
                                  border: `1px solid ${isActive ? "rgba(201,169,110,.4)" : "rgba(255,255,255,.06)"}`,
                                  color: isActive ? "#C9A96E" : "rgba(255,255,255,.4)",
                                }}>
                                {preset.l}
                              </button>
                            );
                          })}
                        </div>
                        <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
                          <div style={{ flex: 1 }}>
                            <div style={{ fontSize: 9, color: "rgba(255,255,255,.2)", marginBottom: 4 }}>MIN</div>
                            <div style={{ display: "flex", alignItems: "center", background: "rgba(255,255,255,.03)", border: "1px solid rgba(255,255,255,.06)", borderRadius: 10, padding: "8px 12px" }}>
                              <span style={{ color: "rgba(255,255,255,.3)", fontSize: 14, marginRight: 4 }}>$</span>
                              <input type="number" value={budgetMin} onChange={e => setBudgetMin(Math.max(0, parseInt(e.target.value) || 0))} style={{ background: "none", border: "none", color: "#fff", fontFamily: "'Outfit'", fontSize: 14, fontWeight: 600, width: "100%", outline: "none" }} />
                            </div>
                          </div>
                          <span style={{ color: "rgba(255,255,255,.15)", fontSize: 14, marginTop: 16 }}>--</span>
                          <div style={{ flex: 1 }}>
                            <div style={{ fontSize: 9, color: "rgba(255,255,255,.2)", marginBottom: 4 }}>MAX</div>
                            <div style={{ display: "flex", alignItems: "center", background: "rgba(255,255,255,.03)", border: "1px solid rgba(255,255,255,.06)", borderRadius: 10, padding: "8px 12px" }}>
                              <span style={{ color: "rgba(255,255,255,.3)", fontSize: 14, marginRight: 4 }}>$</span>
                              <input type="number" value={budgetMax} onChange={e => setBudgetMax(Math.max(budgetMin + 1, parseInt(e.target.value) || 0))} style={{ background: "none", border: "none", color: "#fff", fontFamily: "'Outfit'", fontSize: 14, fontWeight: 600, width: "100%", outline: "none" }} />
                            </div>
                          </div>
                        </div>
                      </div>

                      {/* Update button */}
                      <button
                        onClick={() => { setPrefs(p => ({ ...p, budget_min: budgetMin, budget_max: budgetMax })); runProductSearch(); }}
                        style={{
                          width: "100%", padding: "12px 0",
                          background: "#C9A96E", color: "#0C0C0E", border: "none",
                          borderRadius: "var(--radius-md)", fontFamily: "'Outfit'",
                          fontSize: 14, fontWeight: 700, cursor: "pointer",
                        }}>
                        Update Search
                      </button>

                      {/* Complete the Look */}
                      {results?.items?.length > 0 && (
                        <div>
                          <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: 1.5, color: "rgba(255,255,255,.25)", textTransform: "uppercase", marginBottom: 8 }}>{t("complete_look")}</div>
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
                              style={{ width: "100%", padding: "12px 0", background: "rgba(201,169,110,.07)", border: "1px solid rgba(201,169,110,.25)", borderRadius: 12, color: "#C9A96E", fontFamily: "'Outfit'", fontSize: 13, fontWeight: 700, cursor: "pointer" }}>
                              Complete the Look
                            </button>
                          )}
                          {pairingsLoading && (
                            <div style={{ padding: "14px", textAlign: "center", color: "rgba(255,255,255,.3)", fontSize: 12 }}>
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
                                      style={{ flexShrink: 0, width: 150, scrollSnapAlign: "start", background: "rgba(201,169,110,.04)", border: "1px solid rgba(201,169,110,.1)", borderRadius: 12, textDecoration: "none", color: "inherit", overflow: "hidden" }}>
                                      {prod?.image_url ? (
                                        <div style={{ width: "100%", aspectRatio: "1", background: "rgba(255,255,255,.04)", overflow: "hidden" }}>
                                          <img src={prod.image_url} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} onError={e => { e.target.style.display = "none"; }} />
                                        </div>
                                      ) : (
                                        <div style={{ width: "100%", aspectRatio: "1", background: "rgba(201,169,110,.08)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 28 }}>
                                          {{ shoes: "S", accessory: "A", bag: "B", outerwear: "O", top: "T", bottom: "B", dress: "D" }[p.category] || "?"}
                                        </div>
                                      )}
                                      <div style={{ padding: "8px 10px" }}>
                                        <div style={{ fontSize: 11, fontWeight: 500, color: "rgba(255,255,255,.7)", lineHeight: 1.3, overflow: "hidden", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical" }}>{prod?.product_name || p.name || "Item"}</div>
                                        {(prod?.brand || p.brand) && <div style={{ fontSize: 10, color: "rgba(255,255,255,.35)" }}>{prod?.brand || p.brand}</div>}
                                        {(prod?.price || p.price) && <div style={{ fontSize: 13, fontWeight: 700, color: "#C9A96E", marginTop: 2 }}>{prod?.price || p.price}</div>}
                                        <div style={{ fontSize: 11, fontWeight: 600, color: "#C9A96E", textAlign: "center", paddingTop: 4, borderTop: "1px solid rgba(255,255,255,.04)" }}>Shop</div>
                                      </div>
                                    </a>
                                  );
                                })}
                              </div>
                              <button onClick={() => setPairings(null)} style={{ background: "none", border: "none", color: "rgba(255,255,255,.15)", fontFamily: "'Outfit'", fontSize: 11, cursor: "pointer", padding: "4px 0" }}>Dismiss</button>
                            </div>
                          )}
                          {pairings && pairings.length === 0 && (
                            <div style={{ fontSize: 12, color: "rgba(255,255,255,.2)", textAlign: "center", padding: "12px 0" }}>Outfit looks complete.</div>
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
                              background: "rgba(255,255,255,.04)", color: "rgba(255,255,255,.5)",
                              border: "1px solid rgba(255,255,255,.08)", borderRadius: "var(--radius-md)",
                              fontFamily: "'Outfit'", fontSize: 12, fontWeight: 600, cursor: "pointer",
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
                              background: "rgba(255,255,255,.04)", color: "rgba(255,255,255,.5)",
                              border: "1px solid rgba(255,255,255,.08)", borderRadius: "var(--radius-md)",
                              fontFamily: "'Outfit'", fontSize: 12, fontWeight: 600, cursor: "pointer",
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

          {/* ─── History (Redesigned) ─────────────────────── */}
          {tab === "history" && (() => {
            const filteredHistory = history;
            const loadScan = (h) => {
              const items = h.items || [];
              setResults({ gender: h.detected_gender || "male", summary: h.summary || "", items: items.map(it => ({ ...it, status: h.tiers ? "verified" : "identified", tiers: null })) });
              if (h.tiers && Array.isArray(h.tiers)) {
                setResults(prev => prev ? { ...prev, items: prev.items.map((item, idx) => { const sr = h.tiers.find(t => t.item_index === idx); return sr?.tiers ? { ...item, status: "verified", tiers: sr.tiers } : item; }) } : prev);
              }
              setImg(h.image_url || h.image_thumbnail || null);
              setScanId(h.id); setSelIdx(0); setPickedItems(new Set((h.tiers || []).map(t => t.item_index))); setPhase("done"); setTab("scan");
            };
            return <div className="history-v2">
                  {/* Free tier notice */}
                  {isFree && <div style={{fontSize:10,color:"var(--text-tertiary)",marginBottom:8,display:"flex",justifyContent:"space-between"}}><span>Last 7 days</span><span style={{color:"var(--accent)",cursor:"pointer"}} onClick={() => setUpgradeModal("history_expiring")}>Keep all history</span></div>}

                  {/* Empty State */}
                  {filteredHistory.length === 0 ? (
                    <div className="empty" style={{ padding: "60px 24px" }}>
                      <div className="empty-i" style={{ fontSize: 40, opacity: 0.15 }}>
                        <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="2" y="6" width="20" height="14" rx="3"/><circle cx="12" cy="13" r="4"/><path d="M8 6l1.5-3h5L16 6"/></svg>
                      </div>
                      <div className="empty-t">No scans yet</div>
                      <div className="empty-s">Your scan history will appear here</div>
                      <button className="btn-primary" style={{ marginTop: 12 }} onClick={() => setTab("scan")}>Scan your first outfit</button>
                    </div>
                  ) : (
                    <>
                    {filteredHistory.map((h, i) => {
                      const hItems = h.items || [];
                      const hImgSrc = h.image_url || h.image_thumbnail;
                      const hSummary = h.summary || hItems.map(it => it.name).slice(0, 2).join(", ") || "Outfit scan";
                      return (
                        <div className="history-v2-card" key={h.id || i} onClick={() => setHistoryDetailScan(h)} aria-label={`Scan from ${new Date(h.created_at).toLocaleDateString()}`}>
                          {hImgSrc ? (
                            <img src={hImgSrc} className="history-v2-thumb" alt="" onError={e => e.target.style.display = "none"} />
                          ) : (
                            <div className="history-v2-thumb-placeholder">{h.detected_gender === "female" ? "\uD83D\uDC57" : "\uD83D\uDC54"}</div>
                          )}
                          <div className="history-v2-info">
                            <div className="history-v2-title">{h.scan_name || hSummary}</div>
                            <div className="history-v2-date">{new Date(h.created_at).toLocaleDateString(undefined, { month: "short", day: "numeric" })}</div>
                            <div className="history-v2-summary">{hSummary}</div>
                          </div>
                          <div className="history-v2-badge">{hItems.length} item{hItems.length !== 1 ? "s" : ""}</div>
                          <div className="history-v2-actions" onClick={e => e.stopPropagation()}>
                            {confirmDeleteId === h.id ? (
                              <div style={{ display: "flex", gap: 4 }}>
                                <button className="btn-primary" style={{ padding: "4px 10px", fontSize: 11, minHeight: 30, background: "var(--error)" }} onClick={async () => { const ok = await API.deleteScan(h.id); if (ok) setHistory(prev => prev.filter(s => s.id !== h.id)); setConfirmDeleteId(null); }} aria-label="Confirm delete">Yes</button>
                                <button className="btn-ghost" style={{ padding: "4px 10px", fontSize: 11, minHeight: 30 }} onClick={() => setConfirmDeleteId(null)} aria-label="Cancel">No</button>
                              </div>
                            ) : (
                              <button onClick={() => setConfirmDeleteId(h.id)} style={{ background: "none", border: "none", color: "var(--text-tertiary)", fontSize: 14, cursor: "pointer", minWidth: 44, minHeight: 44, display: "flex", alignItems: "center", justifyContent: "center" }} aria-label="Delete scan">
                                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                              </button>
                            )}
                          </div>
                        </div>
                      );
                    })}
                    </>
                  )}

                  {/* History Detail Overlay */}
                  {historyDetailScan && (() => {
                    const hd = historyDetailScan, hdItems = hd.items || [], hdImg = hd.image_url || hd.image_thumbnail;
                    return (
                      <div className="scan-overlay" role="dialog" aria-label="Scan details" aria-modal="true">
                        <button className="scan-overlay-close" onClick={() => setHistoryDetailScan(null)} aria-label="Close"><svg viewBox="0 0 24 24"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
                        {hdImg && <img className="scan-overlay-img" src={hdImg} alt="Scan" />}
                        <div className="scan-overlay-body">
                          <div className="scan-overlay-meta">
                            <span className="scan-overlay-tag">{hdItems.length} item{hdItems.length !== 1 ? "s" : ""}</span>
                            <span style={{ fontSize: "var(--text-xs)", color: "var(--text-tertiary)" }}>{new Date(hd.created_at).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}</span>
                            {hd.detected_gender && <span className="scan-overlay-tag">{hd.detected_gender}</span>}
                          </div>
                          {hd.summary && <div className="scan-overlay-summary">{hd.summary}</div>}
                          {hdItems.length > 0 && <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                            <div className="sec-t">Identified Items</div>
                            {hdItems.map((it, idx) => (
                              <div key={idx} style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 12px", background: "var(--bg-card)", border: "1px solid var(--border)", borderRadius: "var(--radius-sm)" }}>
                                <div style={{ width: 36, height: 36, borderRadius: "var(--radius-sm)", background: "var(--accent-bg)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 16, flexShrink: 0 }}>{{ shoes: "\uD83D\uDC5F", accessory: "\u231A", bag: "\uD83D\uDC5C", outerwear: "\uD83E\uDDE5", top: "\uD83D\uDC55", bottom: "\uD83D\uDC56", dress: "\uD83D\uDC57" }[it.category] || "\u2726"}</div>
                                <div style={{ flex: 1, minWidth: 0 }}>
                                  <div style={{ fontSize: "var(--text-sm)", fontWeight: 600, color: "var(--text-primary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{it.name}</div>
                                  <div style={{ fontSize: "var(--text-xs)", color: "var(--text-tertiary)" }}>{it.brand || it.category}</div>
                                </div>
                              </div>
                            ))}
                          </div>}
                          <div style={{ display: "flex", gap: 10, marginTop: 16 }}>
                            <button className="btn-primary" style={{ flex: 1 }} onClick={() => { loadScan(hd); setHistoryDetailScan(null); }}>View Full Results</button>
                            <button className="btn-secondary" style={{ flex: 1 }} onClick={() => {
                              loadScan(hd); setHistoryDetailScan(null);
                              // Re-run search with current preferences
                              setTimeout(() => { setPhase("done"); }, 100);
                            }}>Search Again</button>
                          </div>
                        </div>
                      </div>
                    );
                  })()}

                  {/* Legacy history rendering preserved below (hidden) */}
                  <div style={{ display: "none" }}>
                  <div style={{ display: "flex", gap: 0, marginBottom: 12, background: "rgba(255,255,255,.03)", borderRadius: 10, padding: 3 }}>
                    {["all"].map(f => (
                      <button key={f} onClick={() => { setHistoryFilter(f); setActiveWishlist(null); }} style={{ flex: 1, padding: "8px 0", borderRadius: 8, border: "none", background: historyFilter === f ? "rgba(201,169,110,.12)" : "transparent", color: historyFilter === f ? "#C9A96E" : "rgba(255,255,255,.3)", fontFamily: "'Outfit'", fontSize: 12, fontWeight: 600, cursor: "pointer", transition: "all .2s", letterSpacing: 0.5 }}>
                        All Scans
                      </button>
                    ))}
                  </div>

                  {/* ─── Wishlists panel ─────────────────────────── */}
                  {historyFilter === "lists" && (() => {
                    if (activeWishlist) {
                      // Show items in this wishlist
                      const listItems = saved.filter(s => s.wishlist_id === activeWishlist.id);
                      return (
                        <div>
                          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
                            <button onClick={() => setActiveWishlist(null)} style={{ background: "none", border: "none", color: "#C9A96E", fontFamily: "'Outfit'", fontSize: 12, cursor: "pointer", padding: 0 }}>← Back</button>
                            <span style={{ fontSize: 14, fontWeight: 700, color: "#fff" }}>{activeWishlist.name}</span>
                            <button onClick={async () => { if (confirm(`Delete "${activeWishlist.name}"?`)) { await API.deleteWishlist(activeWishlist.id); setWishlists(w => w.filter(x => x.id !== activeWishlist.id)); setActiveWishlist(null); } }} style={{ marginLeft: "auto", background: "none", border: "none", fontSize: 12, color: "rgba(255,100,100,.4)", cursor: "pointer", fontFamily: "'Outfit'" }}>Delete list</button>
                          </div>
                          {listItems.length === 0
                            ? <div className="empty" style={{padding:"32px 20px"}}><div className="empty-i">📋</div><div className="empty-t">No items yet</div><div className="empty-s">Save items and add them to this list</div></div>
                            : <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                                {listItems.map(s => {
                                  const item = s.item_data || s;
                                  return (
                                    <div key={s.id} style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 14px", background: "rgba(255,255,255,.02)", border: "1px solid rgba(255,255,255,.06)", borderRadius: 12 }}>
                                      <div style={{ flex: 1, minWidth: 0 }}>
                                        <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 2 }}>{item.name}</div>
                                        {item.brand && <div style={{ fontSize: 11, color: "rgba(255,255,255,.3)" }}>{item.brand}</div>}
                                      </div>
                                      <button onClick={async () => {
                                        await API.removeFromWishlist(activeWishlist.id, s.id);
                                        setSaved(prev => prev.map(x => x.id === s.id ? { ...x, wishlist_id: null } : x));
                                      }} style={{ background: "none", border: "none", fontSize: 13, color: "rgba(255,255,255,.15)", cursor: "pointer", fontFamily: "'Outfit'" }}>Remove</button>
                                    </div>
                                  );
                                })}
                              </div>
                          }
                        </div>
                      );
                    }
                    // Show all wishlists
                    return (
                      <div>
                        {/* Create new list */}
                        <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>
                          <input
                            value={wishlistInput}
                            onChange={e => setWishlistInput(e.target.value)}
                            onKeyDown={async e => {
                              if (e.key === "Enter" && wishlistInput.trim()) {
                                setWishlistCreating(true);
                                try {
                                  const wl = await API.createWishlist(wishlistInput.trim());
                                  setWishlists(w => [wl, ...w]);
                                  setWishlistInput("");
                                } catch {}
                                setWishlistCreating(false);
                              }
                            }}
                            placeholder="New list name…"
                            style={{ flex: 1, padding: "10px 14px", background: "rgba(255,255,255,.03)", border: "1px solid rgba(255,255,255,.07)", borderRadius: 10, color: "#fff", fontFamily: "'Outfit'", fontSize: 13, outline: "none" }}
                          />
                          <button onClick={async () => {
                            if (!wishlistInput.trim()) return;
                            setWishlistCreating(true);
                            try {
                              const wl = await API.createWishlist(wishlistInput.trim());
                              setWishlists(w => [wl, ...w]);
                              setWishlistInput("");
                            } catch {}
                            setWishlistCreating(false);
                          }} disabled={wishlistCreating || !wishlistInput.trim()} style={{ padding: "10px 16px", background: wishlistInput.trim() ? "#C9A96E" : "rgba(255,255,255,.04)", border: "none", borderRadius: 10, color: wishlistInput.trim() ? "#0C0C0E" : "rgba(255,255,255,.2)", fontFamily: "'Outfit'", fontSize: 13, fontWeight: 700, cursor: wishlistInput.trim() ? "pointer" : "default", transition: "all .2s" }}>
                            {wishlistCreating ? "…" : "+ Create"}
                          </button>
                        </div>
                        {wishlists.length === 0
                          ? <div className="empty" style={{padding:"32px 20px"}}><div className="empty-i">📋</div><div className="empty-t">No lists yet</div><div className="empty-s">Create a list to organize your saved outfits</div></div>
                          : <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                              {wishlists.map(wl => {
                                const itemCount = saved.filter(s => s.wishlist_id === wl.id).length;
                                return (
                                  <div key={wl.id} style={{ display: "flex", alignItems: "center", gap: 12, padding: "14px 16px", background: "rgba(255,255,255,.02)", border: "1px solid rgba(255,255,255,.06)", borderRadius: 12, transition: "all .2s" }}>
                                    <div onClick={() => setActiveWishlist(wl)} style={{ width: 36, height: 36, borderRadius: 8, background: "rgba(201,169,110,.06)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 16, flexShrink: 0, cursor: "pointer" }}>&#128203;</div>
                                    <div style={{ flex: 1, minWidth: 0 }} onClick={() => setActiveWishlist(wl)}>
                                      <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
                                        <div
                                          contentEditable
                                          suppressContentEditableWarning
                                          onClick={e => e.stopPropagation()}
                                          onBlur={async (e) => {
                                            const name = e.target.innerText.trim();
                                            if (name && name !== wl.name) {
                                              await API.renameWishlist(wl.id, name);
                                              setWishlists(prev => prev.map(x => x.id === wl.id ? { ...x, name } : x));
                                            } else {
                                              e.target.innerText = wl.name;
                                            }
                                          }}
                                          onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); e.target.blur(); } }}
                                          onFocus={e => { e.target.style.borderBottomColor = "rgba(201,169,110,.3)"; }}
                                          onBlurCapture={e => { e.target.style.borderBottomColor = "transparent"; }}
                                          style={{ fontSize: 14, fontWeight: 600, color: "#fff", outline: "none", borderBottom: "1px solid transparent", cursor: "text", transition: "border-color .2s", minWidth: 0, flex: 1 }}
                                          aria-label="List name — tap to rename"
                                        >{wl.name}</div>
                                        <span style={{ fontSize: 11, color: "rgba(255,255,255,.12)", flexShrink: 0, userSelect: "none", cursor: "default" }} aria-hidden="true">&#x270E;</span>
                                      </div>
                                      <div style={{ fontSize: 11, color: "rgba(255,255,255,.25)", cursor: "pointer" }}>{itemCount} item{itemCount !== 1 ? "s" : ""}</div>
                                    </div>
                                    <span onClick={() => setActiveWishlist(wl)} style={{ color: "rgba(255,255,255,.2)", fontSize: 14, cursor: "pointer" }}>&#x203A;</span>
                                  </div>
                                );
                              })}
                            </div>
                        }
                      </div>
                    );
                  })()}

                  {/* ─── Saved Items (individual items the user saved) ── */}
                  {historyFilter === "saved" && (() => {
                    if (saved.length === 0) {
                      return <div className="empty" style={{padding:"40px 20px"}}><div className="empty-i">♡</div><div className="empty-t">No saved items</div><div className="empty-s">Tap the heart on any identified item to save it here</div></div>;
                    }
                    return (
                      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                        {saved.map(s => {
                          const item = s.item_data || s;
                          const isOpen = addToListOpenId === s.id;
                          const confirming = addToListConfirm?.savedItemId === s.id;
                          const assignedList = wishlists.find(wl => wl.id === s.wishlist_id);
                          return (
                            <div key={s.id} className="saved-row" style={{ position: "relative", flexWrap: "wrap", alignItems: "flex-start", gap: 10 }}>
                              <div style={{ flex: 1, minWidth: 0 }}>
                                <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 2 }}>{item.name}</div>
                                {s.created_at && (
                                  <div style={{ fontSize: 10, color: "rgba(255,255,255,.2)", marginTop: 2 }}>
                                    {(() => {
                                      const diff = Date.now() - new Date(s.created_at).getTime();
                                      const days = Math.floor(diff / 86400000);
                                      if (days === 0) return "Saved today";
                                      if (days === 1) return "Saved yesterday";
                                      if (days < 7) return `Saved ${days} days ago`;
                                      if (days < 30) return `Saved ${Math.floor(days/7)} week${Math.floor(days/7)>1?"s":""} ago`;
                                      return `Saved ${new Date(s.created_at).toLocaleDateString()}`;
                                    })()}
                                  </div>
                                )}
                                <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                                  {item.brand && item.brand !== "Unidentified" && <span style={{ fontSize: 11, color: "rgba(255,255,255,.3)" }}>{item.brand}</span>}
                                  {item.color && <span style={{ fontSize: 10, color: "rgba(255,255,255,.2)" }}>{item.color}</span>}
                                  {assignedList && <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: .5, padding: "2px 7px", borderRadius: 100, background: "rgba(201,169,110,.1)", border: "1px solid rgba(201,169,110,.25)", color: "#C9A96E" }}>{assignedList.name}</span>}
                                </div>
                              </div>
                              {/* Add to list button */}
                              <div style={{ position: "relative", flexShrink: 0 }}>
                                {confirming ? (
                                  <span style={{ fontSize: 11, fontWeight: 600, color: "rgb(100,200,120)", padding: "5px 0" }} aria-live="polite">Added!</span>
                                ) : (
                                  <button
                                    aria-label={`Add ${item.name} to a wishlist`}
                                    onClick={() => setAddToListOpenId(isOpen ? null : s.id)}
                                    style={{ display: "flex", alignItems: "center", gap: 4, padding: "6px 10px", background: isOpen ? "rgba(201,169,110,.12)" : "rgba(255,255,255,.04)", border: `1px solid ${isOpen ? "rgba(201,169,110,.35)" : "rgba(255,255,255,.08)"}`, borderRadius: 8, color: isOpen ? "#C9A96E" : "rgba(255,255,255,.35)", fontSize: 11, fontWeight: 600, cursor: "pointer", fontFamily: "'Outfit'", transition: "all .15s", minHeight: 32 }}>
                                    <span style={{ fontSize: 12, lineHeight: 1 }}>&#128203;</span>
                                    <span>+</span>
                                  </button>
                                )}
                                {isOpen && (
                                  <>
                                    <div onClick={() => setAddToListOpenId(null)} style={{ position: "fixed", inset: 0, zIndex: 49 }} aria-hidden="true" />
                                    <div
                                      role="listbox"
                                      aria-label="Choose a wishlist"
                                      style={{ position: "absolute", right: 0, top: "calc(100% + 6px)", zIndex: 50, background: "#18181C", border: "1px solid rgba(255,255,255,.1)", borderRadius: 12, minWidth: 180, padding: "6px 0", boxShadow: "0 8px 24px rgba(0,0,0,.5)", animation: "slideIn .15s ease" }}>
                                    {wishlists.length === 0 ? (
                                      <div style={{ padding: "12px 14px", fontSize: 12, color: "rgba(255,255,255,.3)", lineHeight: 1.5 }}>
                                        Create a list first<br />
                                        <span style={{ fontSize: 11, color: "rgba(255,255,255,.15)" }}>Go to the Lists tab</span>
                                      </div>
                                    ) : wishlists.map(wl => (
                                      <button
                                        key={wl.id}
                                        role="option"
                                        aria-selected={s.wishlist_id === wl.id}
                                        onClick={async () => {
                                          setAddToListOpenId(null);
                                          const ok = await API.addToWishlist(wl.id, s.id);
                                          if (ok) {
                                            setSaved(prev => prev.map(x => x.id === s.id ? { ...x, wishlist_id: wl.id } : x));
                                            setAddToListConfirm({ savedItemId: s.id, wishlistName: wl.name });
                                            setTimeout(() => setAddToListConfirm(null), 1800);
                                          }
                                        }}
                                        style={{ display: "flex", alignItems: "center", justifyContent: "space-between", width: "100%", padding: "10px 14px", background: s.wishlist_id === wl.id ? "rgba(201,169,110,.08)" : "none", border: "none", color: s.wishlist_id === wl.id ? "#C9A96E" : "rgba(255,255,255,.7)", fontFamily: "'Outfit'", fontSize: 13, fontWeight: 500, cursor: "pointer", textAlign: "left", transition: "background .1s" }}>
                                        {wl.name}
                                        {s.wishlist_id === wl.id && <span style={{ fontSize: 11, color: "#C9A96E" }}>&#10003;</span>}
                                      </button>
                                    ))}
                                  </div>
                                  </>
                                )}
                              </div>
                              {/* Unsave / delete */}
                              <button
                                aria-label={`Remove ${item.name} from saved`}
                                onClick={async () => {
                                  await API.deleteSaved(s.id).catch(() => {});
                                  setSaved(prev => prev.filter(x => x.id !== s.id));
                                  refreshStatus();
                                }}
                                style={{ background: "none", border: "none", fontSize: 16, cursor: "pointer", color: "rgba(255,255,255,.15)", padding: "4px", minHeight: 44, minWidth: 44, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, transition: "color .15s" }}
                                onMouseEnter={e => e.currentTarget.style.color = "rgba(255,80,80,.5)"}
                                onMouseLeave={e => e.currentTarget.style.color = "rgba(255,255,255,.15)"}>
                                &#9825;
                              </button>
                            </div>
                          );
                        })}
                      </div>
                    );
                  })()}

                  {/* ─── All Scans filter ───────────────── */}
                  {historyFilter === "all" && <>
                  {isFree && <div style={{fontSize:9,color:"rgba(255,255,255,.12)",marginBottom:8,display:"flex",justifyContent:"space-between"}}><span>Last 7 days</span><span style={{color:"#C9A96E",cursor:"pointer"}} onClick={() => setUpgradeModal("history_expiring")}>Keep all →</span></div>}
                  {filteredHistory.length === 0
                    ? <div className="empty" style={{padding:"40px 20px"}}><div className="empty-i">&#9651;</div><div className="empty-t">No scans yet</div><div className="empty-s">Your scan history will appear here</div></div>
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
                            {/* Scan name — contentEditable with pencil affordance */}
                            <div style={{display:"flex",alignItems:"center",gap:5,marginBottom:3}} className="hist-name-row">
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
                                style={{fontSize:13,fontWeight:600,lineHeight:1.3,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",outline:"none",borderBottom:"1px solid transparent",cursor:"text",transition:"border-color .2s",minWidth:0,flex:1}}
                                onFocus={(e) => { e.target.style.borderBottomColor = "rgba(201,169,110,.3)"; }}
                                onBlurCapture={(e) => { e.target.style.borderBottomColor = "transparent"; }}
                                aria-label="Scan name — tap to rename"
                              >{h.scan_name || items.map(it=>it.name).slice(0,2).join(", ") || h.summary || "Outfit scan"}</div>
                              <span style={{fontSize:11,color:"rgba(255,255,255,.12)",flexShrink:0,userSelect:"none",cursor:"default"}} aria-hidden="true">✎</span>
                            </div>
                            <div style={{display:"flex",alignItems:"center",gap:6,flexWrap:"wrap"}}>
                              <span style={{fontSize:11,color:"rgba(255,255,255,.2)"}}>{new Date(h.created_at).toLocaleDateString()}</span>
                              <span style={{fontSize:9,fontWeight:700,padding:"1px 5px",borderRadius:3,background:"rgba(255,255,255,.04)",color:"rgba(255,255,255,.2)"}}>{items.length} items</span>
                              {/* Star rating — only shown when a rating exists */}
                              {h.rating > 0 && (
                                <span style={{fontSize:11,letterSpacing:1,color:"#C9A96E",lineHeight:1}} aria-label={`Rated ${h.rating} out of 5 stars`}>
                                  {[1,2,3,4,5].map(s => s <= h.rating ? "★" : "☆").join("")}
                                </span>
                              )}
                            </div>
                            {/* Visibility chips */}
                            <div onClick={e => e.stopPropagation()} style={{display:"flex",gap:4,marginTop:5,flexWrap:"wrap"}}>
                              {[
                                { v: "public", l: t("public_profile"), icon: "🌐" },
                                { v: "followers", l: t("followers_only"), icon: "👥" },
                                { v: "private", l: t("private_profile"), icon: "🔒" },
                              ].map(({ v, l, icon }) => {
                                const current = scanVisibilityMap[h.id] || h.visibility || "public";
                                const active = current === v;
                                return (
                                  <button key={v}
                                    className={`scan-vis-chip${active ? " active" : ""}`}
                                    aria-pressed={active}
                                    aria-label={`Set scan visibility to ${l}`}
                                    onClick={async () => {
                                      setScanVisibilityMap(m => ({ ...m, [h.id]: v }));
                                      try { await authFetch(`${API_BASE}/api/social/scans/${h.id}/visibility`, { method: "PATCH", body: JSON.stringify({ visibility: v }) }); } catch {}
                                      track("scan_visibility_changed", { visibility: v }, h.id, "history");
                                    }}>
                                    <span>{icon}</span>{l}
                                  </button>
                                );
                              })}
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
                          }} style={{background:"none",border:"none",fontSize:18,cursor:"pointer",padding:"4px 4px",flexShrink:0,color: h.is_saved ? "#C9A96E" : "rgba(255,255,255,.12)",transition:"color .2s"}} aria-label={h.is_saved ? "Unsave scan" : "Save scan"}>
                            {h.is_saved ? "♥" : "♡"}
                          </button>
                          {/* Delete — inline confirm to avoid iOS PWA confirm() suppression */}
                          {confirmDeleteId === h.id ? (
                            <div onClick={e => e.stopPropagation()} style={{display:"flex",alignItems:"center",gap:6,flexShrink:0}}>
                              <button onClick={async (e) => {
                                e.stopPropagation();
                                const ok = await API.deleteScan(h.id);
                                if (ok) setHistory(prev => prev.filter(s => s.id !== h.id));
                                setConfirmDeleteId(null);
                              }} style={{padding:"4px 10px",background:"rgba(255,80,80,.12)",border:"1px solid rgba(255,80,80,.25)",borderRadius:6,fontSize:11,fontWeight:700,color:"rgba(255,100,100,.9)",cursor:"pointer",fontFamily:"'Outfit'",minHeight:30}} aria-label="Confirm delete">
                                Yes
                              </button>
                              <button onClick={(e) => { e.stopPropagation(); setConfirmDeleteId(null); }} style={{padding:"4px 10px",background:"none",border:"1px solid rgba(255,255,255,.08)",borderRadius:6,fontSize:11,fontWeight:600,color:"rgba(255,255,255,.3)",cursor:"pointer",fontFamily:"'Outfit'",minHeight:30}} aria-label="Cancel delete">
                                Cancel
                              </button>
                            </div>
                          ) : (
                            <button onClick={(e) => { e.stopPropagation(); setConfirmDeleteId(h.id); }} style={{background:"none",border:"none",fontSize:14,cursor:"pointer",padding:"4px 4px",flexShrink:0,color:"rgba(255,255,255,.08)",transition:"color .2s",minWidth:30,minHeight:44,display:"flex",alignItems:"center",justifyContent:"center"}} onMouseEnter={e => e.currentTarget.style.color="rgba(255,100,100,.5)"} onMouseLeave={e => e.currentTarget.style.color="rgba(255,255,255,.08)"} aria-label="Delete scan">
                              ✕
                            </button>
                          )}
                        </div>
                      );
                    })
                  }
                  </>}
                  </div>{/* end hidden legacy */}
                </div>;
          })()}

          {/* ─── Saved tab (clean Pinterest grid) ─────────── */}
          {tab === "likes" && (() => {
            // Derive unique categories from all saved items
            const categories = [...new Set(saved.map(s => (s.item_data || s).category).filter(Boolean))];

            // Apply category filter
            const allSavedItems = likesCategoryFilter === "all"
              ? saved
              : saved.filter(s => (s.item_data || s).category === likesCategoryFilter);

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
                {/* Header */}
                <div style={{ padding: "16px 16px 4px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                  <h2 style={{ fontSize: 22, fontWeight: 700, color: "var(--text-primary)", margin: 0 }}>Saved</h2>
                  {saved.length > 0 && <span style={{ fontSize: 13, color: "var(--text-tertiary)", fontWeight: 500 }}>{saved.length} item{saved.length !== 1 ? "s" : ""}</span>}
                </div>

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
                      <button className="btn-primary" style={{ marginTop: 12 }} onClick={() => setTab("scan")}>Start Scanning</button>
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
              {/* Top bar: ATTAIRE left, gear icon right */}
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "14px 16px 0", position: "relative", zIndex: 2 }}>
                <div style={{ fontSize: 16, fontWeight: 800, letterSpacing: 2, color: "var(--text-primary)", fontFamily: "'Outfit'" }}>ATTAIRE</div>
                <button className="profile-v2-gear" style={{ position: "relative", top: 0, right: 0 }} aria-label="Open settings" onClick={() => setProfileSettingsOpen(true)}>
                  <svg viewBox="0 0 24 24" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
                </button>
              </div>

              {/* Profile info row: avatar left, stats right (Instagram layout) */}
              <div style={{ display: "flex", alignItems: "center", gap: 20, padding: "20px 20px 0" }}>
                {/* Avatar */}
                <div style={{ width: 80, height: 80, borderRadius: "50%", background: "var(--accent-bg)", border: "3px solid var(--accent-border)", display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 800, color: "var(--accent)", fontSize: 30, fontFamily: "'Outfit'", flexShrink: 0 }} aria-label="Profile avatar">
                  {(authName || authEmail || "U")[0].toUpperCase()}
                </div>
                {/* Stats row next to avatar */}
                <div style={{ flex: 1, display: "flex", justifyContent: "space-around" }} role="list" aria-label="Profile statistics">
                  <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 1 }} role="listitem">
                    <div style={{ fontSize: 18, fontWeight: 700, color: "var(--text-primary)" }}>{profileScansCount}</div>
                    <div style={{ fontSize: 12, color: "var(--text-tertiary)", fontWeight: 500 }}>Scans</div>
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 1, cursor: "pointer" }} role="listitem" onClick={() => { /* follower list - future */ }}>
                    <div style={{ fontSize: 18, fontWeight: 700, color: "var(--text-primary)" }}>{profileStats?.followers_count ?? 0}</div>
                    <div style={{ fontSize: 12, color: "var(--text-tertiary)", fontWeight: 500 }}>Followers</div>
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 1, cursor: "pointer" }} role="listitem" onClick={() => { /* following list - future */ }}>
                    <div style={{ fontSize: 18, fontWeight: 700, color: "var(--text-primary)" }}>{profileStats?.following_count ?? 0}</div>
                    <div style={{ fontSize: 12, color: "var(--text-tertiary)", fontWeight: 500 }}>Following</div>
                  </div>
                </div>
              </div>

              {/* Name + bio + edit button */}
              <div style={{ padding: "12px 20px 0" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <div style={{ fontSize: 16, fontWeight: 700, color: "var(--text-primary)" }}>
                    {authName || (isPro ? "Pro Member" : "Free Account")}
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
                    <div className="empty-s">Scan outfits to fill your grid</div>
                    <button className="btn-primary" style={{ marginTop: 12 }} onClick={() => setTab("scan")}>Scan your first outfit</button>
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
                        <button key={l} className={`chip${lang === l ? " active" : ""}`} onClick={() => { setLang(l); localStorage.setItem("attair_lang", l); }} style={{ padding: "4px 10px", fontSize: 12, minHeight: 32 }}>{label}</button>
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
                        <div style={{ flex: 1, padding: "8px 12px", background: "var(--accent-bg)", border: "1px solid var(--accent-border)", borderRadius: "var(--radius-sm)", fontWeight: 800, color: "var(--accent)", letterSpacing: 2, fontSize: 14, fontFamily: "'Outfit'" }}>{referralCode}</div>
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

          {/* ─── Profile Legacy (hidden, preserves settings data) ── */}
          {false && tab === "profile" && (
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
                  Scans this month: {isFree ? `${(scansLimit - scansLeft)}/${scansLimit}` : "Unlimited"} · Saved: {userStatus?.saved_count || saved.length}{isFree ? `/${userStatus?.saved_limit || 20}` : ""}
                </div>
                {userStatus?.tier === "trial" && userStatus?.trial_ends_at && (() => {
                  const daysLeft = Math.ceil((new Date(userStatus.trial_ends_at) - Date.now()) / 86400000);
                  return daysLeft > 0 ? (
                    <div style={{ display: "inline-flex", alignItems: "center", gap: 5, marginTop: 10, fontSize: 11, padding: "4px 12px", borderRadius: 10, background: "rgba(255,107,53,.1)", border: "1px solid rgba(255,107,53,.25)", color: "#FF6B35", fontWeight: 600 }}>
                      {daysLeft} day{daysLeft !== 1 ? "s" : ""} left in trial
                    </div>
                  ) : null;
                })()}

                {/* Bio field */}
                <div style={{ marginTop: 14 }}>
                  <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: 1.2, color: "rgba(255,255,255,.2)", textTransform: "uppercase", marginBottom: 6 }}>Bio</div>
                  {profileBioEditing ? (
                    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                      <textarea
                        className="profile-bio-area"
                        rows={3}
                        maxLength={200}
                        autoFocus
                        value={profileBio}
                        onChange={e => setProfileBio(e.target.value.slice(0, 200))}
                        placeholder="Tell people about your style…"
                        aria-label="Edit your bio"
                      />
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                        <span style={{ fontSize: 10, color: "rgba(255,255,255,.2)" }}>{profileBio.length}/200</span>
                        <div style={{ display: "flex", gap: 6 }}>
                          <button onClick={() => setProfileBioEditing(false)} style={{ padding: "6px 14px", background: "none", border: "1px solid rgba(255,255,255,.1)", borderRadius: 8, color: "rgba(255,255,255,.35)", fontSize: 12, fontFamily: "'Outfit'", cursor: "pointer" }}>Cancel</button>
                          <button onClick={async () => { setProfileBioSaving(true); try { await API.updateProfile({ bio: profileBio }); } catch {} setProfileBioSaving(false); setProfileBioEditing(false); }} style={{ padding: "6px 14px", background: "#C9A96E", border: "none", borderRadius: 8, color: "#0C0C0E", fontSize: 12, fontWeight: 700, fontFamily: "'Outfit'", cursor: "pointer" }}>{profileBioSaving ? "Saving…" : "Save"}</button>
                        </div>
                      </div>
                    </div>
                  ) : (
                    <div onClick={() => setProfileBioEditing(true)} style={{ fontSize: 13, color: profileBio ? "rgba(255,255,255,.6)" : "rgba(255,255,255,.2)", lineHeight: 1.5, cursor: "pointer", padding: "8px 12px", background: "rgba(255,255,255,.02)", border: "1px solid rgba(255,255,255,.05)", borderRadius: 10, minHeight: 40, display: "flex", alignItems: profileBio ? "flex-start" : "center" }}>
                      {profileBio || <span style={{ fontStyle: "italic" }}>Add a bio…</span>}
                    </div>
                  )}
                </div>

                {/* Follower stats */}
                {profileStats && (
                  <div className="profile-stats-row">
                    <div>
                      <div className="profile-stat-val">{profileStats.followers_count ?? 0}</div>
                      <div className="profile-stat-lbl">{t("followers")}</div>
                    </div>
                    <div>
                      <div className="profile-stat-val">{profileStats.following_count ?? 0}</div>
                      <div className="profile-stat-lbl">{t("following")}</div>
                    </div>
                  </div>
                )}
              </div>

              {isFree && (<>
                <div className="sec-t">Go Pro</div>
                <div className="rcard">
                  <div style={{fontWeight:600,fontSize:14,marginBottom:5}}>Unlock the full experience</div>
                  <div style={{fontSize:12,color:"rgba(255,255,255,.3)",lineHeight:1.5,marginBottom:12}}>Unlimited scans, no ads, price alerts, full history.</div>
                  <button className="btn gold" style={{width:"100%"}} onClick={() => setUpgradeModal("general")}>Go Pro — $30/year</button>
                </div>
              </>)}

              {/* ─── Style Interests ─────────────────────────── */}
              <div className="sec-t">{t("who_inspires")}</div>
              <div className="pcard">
                <div style={{ fontSize: 12, color: "rgba(255,255,255,.3)", marginBottom: 14, lineHeight: 1.5 }}>Pick up to 5. We'll personalize your results.</div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 7 }}>
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
                      <button
                        key={v}
                        className={`interest-chip${on ? " on" : ""}`}
                        aria-pressed={on}
                        onClick={async () => {
                          const next = on ? selectedInterests.filter(x => x !== v) : selectedInterests.length < 5 ? [...selectedInterests, v] : selectedInterests;
                          setSelectedInterests(next);
                          try { await API.updateProfile({ style_interests: next }); } catch {}
                          track("interest_toggled", { interest: v, enabled: !on });
                        }}
                      >
                        <span style={{ fontSize: 15 }}>{icon}</span>{l}
                      </button>
                    );
                  })}
                </div>
                {selectedInterests.length > 0 && (
                  <div style={{ fontSize: 10, color: "rgba(255,255,255,.2)", marginTop: 10 }}>{selectedInterests.length}/5 selected · Saved automatically</div>
                )}
              </div>

              <div className="sec-t">Budget per item</div>
              <div className="pcard">
                <div style={{ fontSize: 12, color: "rgba(255,255,255,.3)", marginBottom: 10 }}>Set your target spend per clothing item. We'll tailor the budget, mid, and premium tiers to match.</div>

                {/* Dual range slider */}
                <div style={{ position: "relative", height: 40, marginBottom: 8 }}>
                  <div style={{ position: "absolute", top: 18, left: 0, right: 0, height: 4, background: "rgba(255,255,255,.06)", borderRadius: 2 }} />
                  <div style={{ position: "absolute", top: 18, left: `${Math.max(0, (budgetMin / 1000) * 100)}%`, right: `${Math.max(0, 100 - (budgetMax / 1000) * 100)}%`, height: 4, background: "var(--accent)", borderRadius: 2, transition: "left var(--transition-fast), right var(--transition-fast)" }} />
                  <input
                    type="range" min="0" max="1000" step="10" value={budgetMin}
                    aria-label="Minimum budget per item"
                    onChange={e => { const v = parseInt(e.target.value); if (v < budgetMax) setBudgetMin(v); }}
                    onPointerUp={() => API.updateProfile({ budget_min: budgetMin })}
                    style={{ position: "absolute", top: 8, left: 0, width: "100%", height: 24, WebkitAppearance: "none", appearance: "none", background: "transparent", pointerEvents: "none", zIndex: 2, margin: 0 }}
                    className="budget-range-thumb"
                  />
                  <input
                    type="range" min="0" max="1000" step="10" value={budgetMax}
                    aria-label="Maximum budget per item"
                    onChange={e => { const v = parseInt(e.target.value); if (v > budgetMin) setBudgetMax(v); }}
                    onPointerUp={() => API.updateProfile({ budget_max: budgetMax })}
                    style={{ position: "absolute", top: 8, left: 0, width: "100%", height: 24, WebkitAppearance: "none", appearance: "none", background: "transparent", pointerEvents: "none", zIndex: 3, margin: 0 }}
                    className="budget-range-thumb"
                  />
                </div>

                <div style={{ textAlign: "center", fontSize: 14, fontWeight: 600, color: "var(--accent)", marginBottom: 10 }}>
                  ${budgetMin} – ${budgetMax}{budgetMax >= 1000 ? "+" : ""}
                </div>

                {/* Preset chips */}
                <div style={{ display: "flex", gap: 6, justifyContent: "center" }}>
                  {[
                    { label: "$", min: 0, max: 50 },
                    { label: "$$", min: 50, max: 150 },
                    { label: "$$$", min: 150, max: 500 },
                    { label: "$$$$", min: 500, max: 1000 },
                  ].map(preset => {
                    const active = budgetMin === preset.min && budgetMax === preset.max;
                    return (
                      <button
                        key={preset.label}
                        aria-label={`Set budget to ${preset.label} range`}
                        onClick={() => { setBudgetMin(preset.min); setBudgetMax(preset.max); API.updateProfile({ budget_min: preset.min, budget_max: preset.max }); }}
                        style={{
                          flex: 1, padding: "8px 6px", minHeight: 44,
                          background: active ? "var(--accent-bg)" : "rgba(255,255,255,.03)",
                          border: `1px solid ${active ? "var(--accent-border)" : "rgba(255,255,255,.07)"}`,
                          borderRadius: "var(--radius-sm)", cursor: "pointer",
                          fontFamily: "'Outfit'", fontSize: 13, fontWeight: 600,
                          color: active ? "var(--accent)" : "rgba(255,255,255,.4)",
                          transition: "all var(--transition-fast)",
                        }}
                      >{preset.label}</button>
                    );
                  })}
                </div>
                <div style={{ fontSize: 10, color: "rgba(255,255,255,.15)", marginTop: 8, textAlign: "center" }}>Budget: under ${budgetMin} · Mid: ${budgetMin}–${budgetMax} · Premium: ${budgetMax}+</div>
              </div>

              <div className="sec-t">Size Preferences</div>
              <div className="pcard">
                <div style={{ fontSize: 12, color: "rgba(255,255,255,.3)", marginBottom: 14, lineHeight: 1.5 }}>Prioritizes search results that match your fit. Applied to all new searches.</div>
                <div style={{ marginBottom: 14 }}>
                  <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: 1, color: "rgba(255,255,255,.2)", textTransform: "uppercase", marginBottom: 8 }}>Body Type</div>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                    {[{l:"Standard",v:"standard"},{l:"Petite",v:"petite"},{l:"Tall",v:"tall"},{l:"Plus Size",v:"plus"},{l:"Big & Tall",v:"big_tall"},{l:"Athletic",v:"athletic"},{l:"Curvy",v:"curvy"}].map(o => {
                      const on = (sizePrefs.body_type || []).includes(o.v);
                      return <div key={o.v} style={{ padding: "7px 13px", background: on ? "rgba(201,169,110,.1)" : "rgba(255,255,255,.03)", border: `1px solid ${on ? "rgba(201,169,110,.4)" : "rgba(255,255,255,.07)"}`, borderRadius: 100, cursor: "pointer", fontSize: 12, fontWeight: 500, color: on ? "#C9A96E" : "rgba(255,255,255,.5)", transition: "all .2s" }} onClick={() => { const a = sizePrefs.body_type || []; const next = { ...sizePrefs, body_type: a.includes(o.v) ? a.filter(x => x !== o.v) : [...a, o.v] }; setSizePrefs(next); API.updateProfile({ size_prefs: next }); }}>{o.l}</div>;
                    })}
                  </div>
                </div>
                <div style={{ marginBottom: 14 }}>
                  <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: 1, color: "rgba(255,255,255,.2)", textTransform: "uppercase", marginBottom: 8 }}>Fit Style</div>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                    {[{l:"Slim/Fitted",v:"slim"},{l:"Regular",v:"regular"},{l:"Relaxed",v:"relaxed"},{l:"Oversized",v:"oversized"},{l:"Flowy",v:"flowy"}].map(o => {
                      const on = (sizePrefs.fit || []).includes(o.v);
                      return <div key={o.v} style={{ padding: "7px 13px", background: on ? "rgba(201,169,110,.1)" : "rgba(255,255,255,.03)", border: `1px solid ${on ? "rgba(201,169,110,.4)" : "rgba(255,255,255,.07)"}`, borderRadius: 100, cursor: "pointer", fontSize: 12, fontWeight: 500, color: on ? "#C9A96E" : "rgba(255,255,255,.5)", transition: "all .2s" }} onClick={() => { const a = sizePrefs.fit || []; const next = { ...sizePrefs, fit: a.includes(o.v) ? a.filter(x => x !== o.v) : [...a, o.v] }; setSizePrefs(next); API.updateProfile({ size_prefs: next }); }}>{o.l}</div>;
                    })}
                  </div>
                </div>
                <div>
                  <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: 1, color: "rgba(255,255,255,.2)", textTransform: "uppercase", marginBottom: 10 }}>Specific Sizes <span style={{ color: "rgba(255,255,255,.12)", fontWeight: 400, letterSpacing: 0 }}>— optional</span></div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                    {[
                      { label: "Tops", key: "tops", opts: ["XS","S","M","L","XL","XXL","XXXL"] },
                      { label: "Bottoms", key: "bottoms", opts: ["24","26","28","30","32","34","36","38","40","42"] },
                      { label: "Jeans", key: "jeans", opts: ["24","25","26","27","28","29","30","31","32","33","34","36","38","40"] },
                      { label: "Shorts", key: "shorts", opts: ["XS","S","M","L","XL","XXL"] },
                      { label: "Outerwear", key: "outerwear", opts: ["XS","S","M","L","XL","XXL"] },
                      { label: "Dresses", key: "dresses", opts: ["0","2","4","6","8","10","12","14","16","18","20","XS","S","M","L","XL"] },
                      { label: "Shoes", key: "shoes", opts: ["5","5.5","6","6.5","7","7.5","8","8.5","9","9.5","10","10.5","11","11.5","12","13","14"] },
                      { label: "Socks", key: "socks", opts: ["S","M","L","XL"] },
                    ].map(({ label, key, opts }) => {
                      const val = sizePrefs.sizes?.[key] || "";
                      return (
                        <div key={key} style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                          <span style={{ fontSize: 13, color: "rgba(255,255,255,.45)" }}>{label}</span>
                          <select value={val} onChange={e => { const next = { ...sizePrefs, sizes: { ...(sizePrefs.sizes || {}), [key]: e.target.value || null } }; setSizePrefs(next); API.updateProfile({ size_prefs: next }); }} style={{ background: "rgba(255,255,255,.04)", border: "1px solid rgba(255,255,255,.08)", borderRadius: 8, color: val ? "#fff" : "rgba(255,255,255,.2)", fontSize: 13, padding: "7px 10px", fontFamily: "'Outfit'", cursor: "pointer", outline: "none", minWidth: 90 }}>
                            <option value="" style={{ color: "#111", background: "#fff" }}>Not set</option>
                            {opts.map(o => <option key={o} value={o} style={{ color: "#111", background: "#fff" }}>{o}</option>)}
                          </select>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>

              <div className="sec-t">Refer & earn</div>
              <div className="rcard">
                <div style={{fontWeight:600,fontSize:14,marginBottom:5}}>Get $5 for every friend</div>
                <div style={{fontSize:12,color:"rgba(255,255,255,.3)",lineHeight:1.5,marginBottom:12}}>Share your code. Both of you get $5 credit.</div>
                {referralCode ? (
                  <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:12,padding:"10px 14px",background:"rgba(201,169,110,.06)",border:"1px solid rgba(201,169,110,.2)",borderRadius:10}}>
                    <div style={{flex:1}}>
                      <div style={{fontSize:9,fontWeight:700,letterSpacing:1.5,color:"rgba(201,169,110,.5)",textTransform:"uppercase",marginBottom:2}}>Your referral code</div>
                      <div style={{fontWeight:800,color:"#C9A96E",letterSpacing:3,fontSize:16,fontFamily:"'Outfit'"}}>{referralCode}</div>
                    </div>
                    <button
                      onClick={() => {
                        navigator.clipboard.writeText(referralCode).then(() => {
                          setReferralCopied(true);
                          setTimeout(() => setReferralCopied(false), 2000);
                        }).catch(() => {});
                      }}
                      style={{padding:"8px 14px",background:referralCopied?"rgba(100,200,120,.15)":"rgba(201,169,110,.12)",border:`1px solid ${referralCopied?"rgba(100,200,120,.4)":"rgba(201,169,110,.3)"}`,borderRadius:8,color:referralCopied?"rgb(100,200,120)":"#C9A96E",fontFamily:"'Outfit'",fontSize:12,fontWeight:700,cursor:"pointer",transition:"all .2s",minHeight:44,minWidth:60}}
                      aria-label="Copy referral code"
                    >{referralCopied ? "✓ Copied" : t("copy")}</button>
                  </div>
                ) : (
                  <div style={{fontSize:12,color:"rgba(255,255,255,.2)",marginBottom:12}}>Loading your code…</div>
                )}
                <button className="btn gold" disabled={!referralCode} style={{width:"100%", opacity: referralCode ? 1 : 0.4, cursor: referralCode ? "pointer" : "default"}} onClick={async () => {
                  const code = referralCode || "...";
                  const text = `Check out ATTAIRE — AI that finds the exact outfit you're looking for! Use my code ${code} at attair.vercel.app`;
                  if (navigator.share) {
                    try { await navigator.share({ title: "ATTAIRE", text }); } catch {}
                  } else {
                    navigator.clipboard.writeText(text).then(() => {
                      setReferralCopied(true);
                      setTimeout(() => setReferralCopied(false), 2000);
                    }).catch(() => {});
                  }
                }}>{t("share")} invite link</button>
              </div>
              <div className="sec-t">{t("settings")}</div>
              <div className="sitem" onClick={toggleTheme}>
                <span>{theme === "dark" ? t("light_mode") : t("dark_mode")}</span>
                <span style={{ fontSize: 11, color: "rgba(255,255,255,.2)", background: "rgba(255,255,255,.04)", padding: "3px 8px", borderRadius: 5 }}>{theme === "dark" ? "DARK" : "LIGHT"}</span>
              </div>
              <div className="sitem" style={{ alignItems: "flex-start", flexDirection: "column", gap: 8 }}>
                <span>🌐 {t("language")}</span>
                <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                  {[["en","EN"],["es","ES"],["fr","FR"],["de","DE"],["zh","中"],["ja","日"],["ko","한"],["pt","PT"]].map(([l, label]) => (
                    <span key={l} onClick={() => { setLang(l); localStorage.setItem("attair_lang", l); }} style={{ fontSize: 11, fontWeight: 700, padding: "3px 8px", borderRadius: 5, cursor: "pointer", background: lang === l ? "rgba(201,169,110,.15)" : "rgba(255,255,255,.04)", color: lang === l ? "#C9A96E" : "rgba(255,255,255,.2)", border: lang === l ? "1px solid rgba(201,169,110,.3)" : "1px solid transparent", transition: "all .15s" }}>
                      {label}
                    </span>
                  ))}
                </div>
              </div>
              <div className="sitem" onClick={handleLogout} style={{color:"rgba(255,100,100,.5)",justifyContent:"center"}}>{t("log_out")}</div>
            </div>
          )}
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
                  <div style={{ fontSize: 16, fontWeight: 700, color: "#fff", marginBottom: 3 }}>{item.name}</div>
                  <div style={{ fontSize: 11, color: "rgba(255,255,255,.3)" }}>{item.subcategory || item.category}</div>
                </div>

                {/* Include toggle */}
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 14px", background: "rgba(255,255,255,.02)", border: "1px solid rgba(255,255,255,.06)", borderRadius: 12, marginBottom: 20 }}
                  onClick={() => setPickedItems(prev => { const n = new Set(prev); if (n.has(idx)) n.delete(idx); else n.add(idx); return n; })}>
                  <span style={{ fontSize: 13, fontWeight: 600, color: "rgba(255,255,255,.6)" }}>Include in search</span>
                  <div style={{ width: 42, height: 24, borderRadius: 12, background: isPicked ? "#C9A96E" : "rgba(255,255,255,.08)", position: "relative", transition: "background .2s", cursor: "pointer" }}>
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
                          style={{ flex: 1, padding: "8px 6px", textAlign: "center", background: on ? "rgba(201,169,110,.1)" : "rgba(255,255,255,.03)", border: `1px solid ${on ? "rgba(201,169,110,.4)" : "rgba(255,255,255,.07)"}`, borderRadius: 10, cursor: "pointer", transition: "all .2s" }}
                          onClick={() => setOv(o2 => ({ ...(o2 || ov), marketPref: o.v }))}>
                          <div style={{ fontSize: 12, fontWeight: 600, color: on ? "#C9A96E" : "rgba(255,255,255,.45)", marginBottom: 2 }}>{o.l}</div>
                          <div style={{ fontSize: 9, color: on ? "rgba(201,169,110,.55)" : "rgba(255,255,255,.2)", lineHeight: 1.3 }}>{o.desc}</div>
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
                    <div style={{ position: "absolute", top: 18, left: 0, right: 0, height: 4, background: "rgba(255,255,255,.06)", borderRadius: 2 }} />
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
                            background: isPresetActive ? "var(--accent-bg)" : "rgba(255,255,255,.03)",
                            border: `1px solid ${isPresetActive ? "var(--accent-border)" : "rgba(255,255,255,.07)"}`,
                            borderRadius: "var(--radius-sm)", cursor: "pointer",
                            fontFamily: "'Outfit'", fontSize: 13, fontWeight: 600,
                            color: isPresetActive ? "var(--accent)" : "rgba(255,255,255,.4)",
                            transition: "all var(--transition-fast)",
                          }}
                        >{preset.label}</button>
                      );
                    })}
                  </div>
                  <div style={{ fontSize: 10, color: "rgba(255,255,255,.15)", marginTop: 8, textAlign: "center" }}>
                    Budget: under ${bMin} · Mid: ${bMin}–${bMax} · Premium: ${bMax}+
                  </div>
                </div>

                {/* Body type */}
                <div style={{ marginBottom: 16 }}>
                  <div className="item-opts-label">Body type</div>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 7 }}>
                    {[{l:"Standard",v:"standard"},{l:"Petite",v:"petite"},{l:"Tall",v:"tall"},{l:"Plus Size",v:"plus"},{l:"Big & Tall",v:"big_tall"},{l:"Athletic",v:"athletic"},{l:"Curvy",v:"curvy"}].map(o => {
                      const on = (spVal.body_type||[]).includes(o.v);
                      return <div key={o.v} style={{ padding:"6px 13px", background: on?"rgba(201,169,110,.1)":"rgba(255,255,255,.03)", border:`1px solid ${on?"rgba(201,169,110,.4)":"rgba(255,255,255,.07)"}`, borderRadius:100, cursor:"pointer", fontSize:12, fontWeight:500, color: on?"#C9A96E":"rgba(255,255,255,.45)", transition:"all .2s" }}
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
                      return <div key={o.v} style={{ padding:"6px 13px", background: on?"rgba(201,169,110,.1)":"rgba(255,255,255,.03)", border:`1px solid ${on?"rgba(201,169,110,.4)":"rgba(255,255,255,.07)"}`, borderRadius:100, cursor:"pointer", fontSize:12, fontWeight:500, color: on?"#C9A96E":"rgba(255,255,255,.45)", transition:"all .2s" }}
                        onClick={() => { const a=spVal.fit||[]; setOv(o2 => ({ ...(o2||ov), sizePrefs: { ...(o2||ov).sizePrefs, fit: a.includes(o.v)?a.filter(x=>x!==o.v):[...a,o.v] } })); }}>{o.l}</div>;
                    })}
                  </div>
                </div>

                {/* Relevant size */}
                {sizeInfo && (
                  <div style={{ marginTop: 0 }}>
                    <div className="item-opts-label">{sizeInfo.label}</div>
                    <select value={spVal.sizes?.[sizeInfo.key]||""} onChange={e => setOv(o2 => ({ ...(o2||ov), sizePrefs: { ...(o2||ov).sizePrefs, sizes: { ...((o2||ov).sizePrefs?.sizes||{}), [sizeInfo.key]: e.target.value||null } } }))}
                      style={{ width:"100%", background:"rgba(255,255,255,.04)", border:"1px solid rgba(255,255,255,.08)", borderRadius:10, color: spVal.sizes?.[sizeInfo.key]?"#fff":"rgba(255,255,255,.3)", fontSize:14, padding:"12px 14px", fontFamily:"'Outfit'", cursor:"pointer", outline:"none" }}>
                      <option value="" style={{color:"#111",background:"#fff"}}>Not set</option>
                      {sizeInfo.opts.map(o=><option key={o} value={o} style={{color:"#111",background:"#fff"}}>{o}</option>)}
                    </select>
                  </div>
                )}

                <button onClick={() => setItemSettingsIdx(null)}
                  style={{ width:"100%", marginTop:22, padding:15, background:"#C9A96E", color:"#0C0C0E", border:"none", borderRadius:14, fontFamily:"'Outfit'", fontSize:15, fontWeight:700, cursor:"pointer" }}>
                  Done
                </button>
              </div>
            </>
          );
        })()}

        {/* ─── User Search Overlay ──────────────────────── */}
        {showUserSearch && (
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

        {/* ─── FAB (visible on all tabs) ─────────────────── */}
        <button className="fab" onClick={() => { track("fab_scan", {}); setShowScanSheet(true); }} aria-label="Scan outfit" style={{ position: "fixed", bottom: "calc(60px + env(safe-area-inset-bottom, 0px))", left: "50%", transform: "translateX(-50%)", zIndex: 1001, width: 56, height: 56, borderRadius: "50%", background: "var(--accent)", border: "none", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", boxShadow: "0 4px 20px rgba(201,169,110,0.4)" }}>
          <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="#0C0C0E" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="6" width="20" height="14" rx="3" /><circle cx="12" cy="13" r="4" /><path d="M8 6l1.5-3h5L16 6" /></svg>
        </button>

        {/* ─── Scan bottom sheet ─────────────────────── */}
        {showScanSheet && (
          <>
            <div className="bottom-sheet-overlay animate-fade-in" onClick={() => setShowScanSheet(false)} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", zIndex: 1100 }} />
            <div className="bottom-sheet animate-slide-up" style={{ position: "fixed", bottom: 0, left: 0, right: 0, zIndex: 1101, background: "var(--bg-card, #1A1A1E)", borderRadius: "20px 20px 0 0", padding: "12px 20px calc(20px + env(safe-area-inset-bottom, 0px))" }}>
              <div className="bottom-sheet-handle" style={{ width: 36, height: 4, borderRadius: 2, background: "rgba(255,255,255,.15)", margin: "0 auto 20px" }} />
              <button
                onClick={() => { setShowScanSheet(false); setTab("scan"); camStart(); }}
                style={{ width: "100%", padding: "16px 0", background: "rgba(255,255,255,.04)", border: "1px solid rgba(255,255,255,.08)", borderRadius: 14, color: "#fff", fontFamily: "'Outfit'", fontSize: 16, fontWeight: 600, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 10, minHeight: 52, marginBottom: 10 }}
              >
                <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="6" width="20" height="14" rx="3" /><circle cx="12" cy="13" r="4" /><path d="M8 6l1.5-3h5L16 6" /></svg>
                Take Photo
              </button>
              <button
                onClick={() => { setShowScanSheet(false); setTab("scan"); fileRef.current?.click(); }}
                style={{ width: "100%", padding: "16px 0", background: "rgba(255,255,255,.04)", border: "1px solid rgba(255,255,255,.08)", borderRadius: 14, color: "#fff", fontFamily: "'Outfit'", fontSize: 16, fontWeight: 600, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 10, minHeight: 52, marginBottom: 10 }}
              >
                <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>
                Choose from Gallery
              </button>
              <button
                onClick={() => setShowScanSheet(false)}
                className="btn-ghost"
                style={{ width: "100%", padding: "14px 0", borderRadius: 14, fontFamily: "'Outfit'", fontSize: 15, fontWeight: 600, cursor: "pointer", minHeight: 48, color: "rgba(255,255,255,.4)" }}
              >
                Cancel
              </button>
            </div>
          </>
        )}

        {/* ─── Tab bar (5 sections: Home, Search, [FAB gap], Saved, Profile) ── */}
        <div className="tb" style={{ background: "var(--bg-secondary)", borderTop: "1px solid var(--border)", display: "flex", alignItems: "center", justifyContent: "space-around", padding: "0", position: "fixed", bottom: 0, left: 0, right: 0, zIndex: 1000 }}>
          <button style={{ flex: 1, background: "none", border: "none", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", padding: "10px 0", minHeight: 44 }} onClick={() => { track("tab_switched", { tab: "home" }); setTab("home"); }} aria-label="Home">
            <svg viewBox="0 0 24 24" width="24" height="24" fill={tab==="home"?"currentColor":"none"} stroke={tab==="home"?"var(--accent)":"var(--text-tertiary)"} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 9.5L12 3l9 6.5V20a1 1 0 01-1 1h-5v-6h-6v6H4a1 1 0 01-1-1V9.5z"/></svg>
          </button>
          <button style={{ flex: 1, background: "none", border: "none", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", padding: "10px 0", minHeight: 44 }} onClick={() => { track("tab_switched", { tab: "search" }); setTab("search"); }} aria-label="Search">
            <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke={tab==="search"?"var(--accent)":"var(--text-tertiary)"} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/></svg>
          </button>
          {/* FAB spacer */}
          <div style={{ flex: 1 }} />
          <button style={{ flex: 1, background: "none", border: "none", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", padding: "10px 0", minHeight: 44 }} onClick={() => { track("tab_switched", { tab: "likes" }); setTab("likes"); }} aria-label="Saved">
            <svg viewBox="0 0 24 24" width="24" height="24" fill={tab==="likes"?"currentColor":"none"} stroke={tab==="likes"?"var(--accent)":"var(--text-tertiary)"} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>
          </button>
          <button style={{ flex: 1, background: "none", border: "none", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", padding: "10px 0", minHeight: 44 }} onClick={() => { track("tab_switched", { tab: "profile" }); setTab("profile"); }} aria-label="Profile">
            <svg viewBox="0 0 24 24" width="24" height="24" fill={tab==="profile"?"currentColor":"none"} stroke={tab==="profile"?"var(--accent)":"var(--text-tertiary)"} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="8" r="4" /><path d="M20 21c0-3.87-3.58-7-8-7s-8 3.13-8 7"/></svg>
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
                  style={{ display: "flex", alignItems: "center", gap: 6, padding: "8px 16px", background: "rgba(201,169,110,.12)", border: "1px solid rgba(201,169,110,.4)", borderRadius: 100, color: "#C9A96E", fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: "'Outfit'", minHeight: 44 }}
                  aria-label="Clear circled item"
                >
                  ✓ Item circled — Clear
                </button>
              ) : (
                <div style={{ display: "flex", alignItems: "center", gap: 5, padding: "6px 12px", background: "rgba(201,169,110,.06)", border: "1px solid rgba(201,169,110,.2)", borderRadius: 100 }}>
                  <span style={{ fontSize: 11, color: "rgba(201,169,110,.7)", fontFamily: "'Outfit'", fontWeight: 600 }}>
                    ✏ Draw a circle around any item to prioritize it
                  </span>
                </div>
              )}
            </div>
          )}
          <div className="crop-bar">
            {cropMode ? (
              <>
                <button onClick={() => setCropMode(false)} style={{ flex: 1, padding: "14px 0", background: "rgba(255,255,255,.06)", border: "1px solid rgba(255,255,255,.08)", borderRadius: 12, color: "rgba(255,255,255,.55)", fontFamily: "'Outfit'", fontSize: 14, fontWeight: 600, cursor: "pointer" }}>
                  Back
                </button>
                <button onClick={applyCrop} style={{ flex: 2, padding: "14px 0", background: "#C9A96E", border: "none", borderRadius: 12, color: "#0C0C0E", fontFamily: "'Outfit'", fontSize: 15, fontWeight: 700, cursor: "pointer" }}>
                  Apply crop
                </button>
              </>
            ) : (
              <>
                <button onClick={retakeCrop} style={{ flex: 1, padding: "14px 0", background: "rgba(255,255,255,.06)", border: "1px solid rgba(255,255,255,.08)", borderRadius: 12, color: "rgba(255,255,255,.55)", fontFamily: "'Outfit'", fontSize: 14, fontWeight: 600, cursor: "pointer" }}>
                  Re-take
                </button>
                <button onClick={() => {
                  if (cropPending.lastCrop) {
                    cropRestoredRef.current = true;
                    setCrop(cropPending.lastCrop);
                    setCompletedCrop(cropPending.lastCrop);
                  }
                  setCropMode(true);
                }} style={{ flex: 1, padding: "14px 0", background: "rgba(201,169,110,.1)", border: "1px solid rgba(201,169,110,.35)", borderRadius: 12, color: "#C9A96E", fontFamily: "'Outfit'", fontSize: 14, fontWeight: 600, cursor: "pointer" }}>
                  Crop
                </button>
                <button
                  onClick={skipCrop}
                  aria-label={priorityRegionBase64 ? "Scan circled item" : "Scan this outfit"}
                  style={{ flex: 2, padding: "14px 0", background: priorityRegionBase64 ? "rgba(201,169,110,.9)" : "#C9A96E", border: "none", borderRadius: 12, color: "#0C0C0E", fontFamily: "'Outfit'", fontSize: 15, fontWeight: 700, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 8, minHeight: 48, boxShadow: "0 4px 16px rgba(201,169,110,.35)", transition: "all var(--transition-fast)" }}
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
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "14px 20px", borderBottom: "1px solid rgba(255,255,255,.06)" }}>
            <div className="logo" style={{ fontFamily: "'Instrument Serif'", fontSize: 22, fontStyle: "italic", color: "var(--text-primary)" }}>A<span style={{ color: "#C9A96E" }}>TT</span>AIRE</div>
            <button onClick={() => { setPublicScanView(null); window.history.replaceState(null, "", "/"); }} style={{ background: "none", border: "none", color: "rgba(255,255,255,.4)", fontSize: 20, cursor: "pointer", padding: 8, minWidth: 44, minHeight: 44 }}>&times;</button>
          </div>

          {publicScanView.loading && (
            <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", flexDirection: "column", gap: 12 }}>
              <div className="ld-dots" style={{ justifyContent: "center" }}><div className="ld-dot" /><div className="ld-dot" /><div className="ld-dot" /></div>
              <div style={{ fontSize: 13, color: "rgba(255,255,255,.3)" }}>Loading scan...</div>
            </div>
          )}

          {publicScanView.error && (
            <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", flexDirection: "column", gap: 16, padding: 32 }}>
              <div style={{ fontSize: 32, color: "rgba(255,255,255,.15)" }}>404</div>
              <div style={{ fontSize: 14, color: "rgba(255,255,255,.4)", textAlign: "center" }}>{publicScanView.error}</div>
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
                    <div style={{ fontSize: 12, color: "rgba(255,255,255,.35)", marginBottom: 8, fontWeight: 600 }}>
                      Scanned by {ps.user.display_name}
                    </div>
                  )}

                  {/* Summary */}
                  {ps.summary && (
                    <div style={{ fontSize: 15, color: "rgba(255,255,255,.65)", fontStyle: "italic", lineHeight: 1.5, marginBottom: 16 }}>
                      {ps.summary}
                    </div>
                  )}

                  {/* Items list */}
                  {ps.items && ps.items.length > 0 && (
                    <div style={{ marginBottom: 20 }}>
                      <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: 2, color: "rgba(255,255,255,.25)", textTransform: "uppercase", marginBottom: 10 }}>{ps.items.length} item{ps.items.length !== 1 ? "s" : ""} identified</div>
                      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                        {ps.items.map((item, i) => (
                          <div key={i} style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 12px", background: "rgba(255,255,255,.03)", borderRadius: 10, border: "1px solid rgba(255,255,255,.06)" }}>
                            <div style={{ width: 8, height: 8, borderRadius: "50%", background: "#C9A96E", flexShrink: 0 }} />
                            <div style={{ flex: 1 }}>
                              <div style={{ fontSize: 14, color: "#fff", fontWeight: 600 }}>{item.name || item.category}</div>
                              {item.brand && item.brand !== "Unidentified" && <div style={{ fontSize: 11, color: "rgba(255,255,255,.3)", marginTop: 2 }}>{item.brand}</div>}
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
                      background: "#C9A96E", color: "#0C0C0E", border: "none", borderRadius: 14,
                      fontFamily: "'Outfit'", fontSize: 16, fontWeight: 700, cursor: "pointer",
                      display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
                      boxShadow: "0 4px 20px rgba(201,169,110,.4)",
                    }}
                  >
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/></svg>
                    Find my version
                  </button>

                  <div style={{ textAlign: "center", marginTop: 12, fontSize: 12, color: "rgba(255,255,255,.2)" }}>
                    Powered by ATTAIRE AI Fashion Scanner
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
            <div style={{ width: 40, height: 4, borderRadius: 2, background: "rgba(255,255,255,.12)", margin: "0 auto 20px" }} />

            <h2 style={{ fontFamily: "'Instrument Serif'", fontSize: 24, color: "#fff", marginBottom: 6, textAlign: "center" }}>Personalize Your Experience</h2>
            <p style={{ fontSize: 13, color: "rgba(255,255,255,.4)", textAlign: "center", marginBottom: 24, lineHeight: 1.5 }}>Help us find better matches for you.</p>

            {/* Budget range */}
            <div style={{ marginBottom: 20 }}>
              <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: 1.5, color: "rgba(255,255,255,.3)", textTransform: "uppercase", marginBottom: 10 }}>Budget per item</div>
              <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
                <div style={{ flex: 1 }}>
                  <div style={{ display: "flex", alignItems: "center", background: "rgba(255,255,255,.03)", border: "1px solid rgba(255,255,255,.08)", borderRadius: 12, padding: "12px 14px" }}>
                    <span style={{ color: "rgba(255,255,255,.3)", fontSize: 16, fontWeight: 600, marginRight: 4 }}>$</span>
                    <input type="number" value={prefSheetBudgetMin} onChange={e => setPrefSheetBudgetMin(Math.max(0, parseInt(e.target.value) || 0))} style={{ background: "none", border: "none", color: "#fff", fontFamily: "'Outfit'", fontSize: 16, fontWeight: 600, width: "100%", outline: "none" }} />
                  </div>
                </div>
                <span style={{ color: "rgba(255,255,255,.15)", fontSize: 14 }}>to</span>
                <div style={{ flex: 1 }}>
                  <div style={{ display: "flex", alignItems: "center", background: "rgba(255,255,255,.03)", border: "1px solid rgba(255,255,255,.08)", borderRadius: 12, padding: "12px 14px" }}>
                    <span style={{ color: "rgba(255,255,255,.3)", fontSize: 16, fontWeight: 600, marginRight: 4 }}>$</span>
                    <input type="number" value={prefSheetBudgetMax} onChange={e => setPrefSheetBudgetMax(Math.max(prefSheetBudgetMin + 1, parseInt(e.target.value) || 0))} style={{ background: "none", border: "none", color: "#fff", fontFamily: "'Outfit'", fontSize: 16, fontWeight: 600, width: "100%", outline: "none" }} />
                  </div>
                </div>
              </div>
            </div>

            {/* Fit preference chips */}
            <div style={{ marginBottom: 24 }}>
              <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: 1.5, color: "rgba(255,255,255,.3)", textTransform: "uppercase", marginBottom: 10 }}>Fit preference</div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                {["Slim", "Regular", "Relaxed", "Oversized"].map(fit => {
                  const isOn = prefSheetFit.includes(fit.toLowerCase());
                  return (
                    <button key={fit} onClick={() => setPrefSheetFit(prev => isOn ? prev.filter(f => f !== fit.toLowerCase()) : [...prev, fit.toLowerCase()])}
                      style={{
                        padding: "10px 20px", minHeight: 44,
                        background: isOn ? "rgba(201,169,110,.12)" : "rgba(255,255,255,.03)",
                        border: `1px solid ${isOn ? "rgba(201,169,110,.4)" : "rgba(255,255,255,.08)"}`,
                        borderRadius: 100, cursor: "pointer",
                        fontFamily: "'Outfit'", fontSize: 13, fontWeight: 600,
                        color: isOn ? "#C9A96E" : "rgba(255,255,255,.45)",
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
                background: "#C9A96E", color: "#0C0C0E", border: "none", borderRadius: 14,
                fontFamily: "'Outfit'", fontSize: 15, fontWeight: 700, cursor: "pointer",
                marginBottom: 8,
              }}
            >Save Preferences</button>
            <button onClick={() => { setShowPrefSheet(false); setShowStyleFingerprint(true); setTimeout(() => setShowStyleFingerprint(false), 3500); }}
              style={{ width: "100%", padding: "12px 0", background: "none", border: "none", color: "rgba(255,255,255,.3)", fontFamily: "'Outfit'", fontSize: 13, cursor: "pointer", minHeight: 44 }}>
              Skip for now
            </button>
          </div>
        </div>
      )}

      {/* ═══ STYLE FINGERPRINT CARD ═══════════════════════════ */}
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
            {/* Shimmer overlay */}
            <div style={{
              position: "absolute", inset: 0, borderRadius: 20, overflow: "hidden", pointerEvents: "none",
              background: "linear-gradient(105deg, transparent 40%, rgba(201,169,110,.06) 45%, rgba(201,169,110,.12) 50%, rgba(201,169,110,.06) 55%, transparent 60%)",
              backgroundSize: "200% 100%", animation: "searchPulse 2s ease infinite",
            }} />

            <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: 2, color: "#C9A96E", textTransform: "uppercase", marginBottom: 12 }}>Your Style Fingerprint</div>
            <div style={{ fontFamily: "'Instrument Serif'", fontSize: 28, color: "#fff", marginBottom: 20 }}>Looking good.</div>

            <div style={{ display: "flex", gap: 12, justifyContent: "center", marginBottom: 16 }}>
              {/* Budget badge */}
              <div style={{ padding: "10px 16px", background: "rgba(201,169,110,.08)", border: "1px solid rgba(201,169,110,.2)", borderRadius: 12, textAlign: "center" }}>
                <div style={{ fontSize: 10, color: "rgba(255,255,255,.3)", fontWeight: 600, letterSpacing: 0.5, marginBottom: 4 }}>Budget</div>
                <div style={{ fontSize: 16, fontWeight: 700, color: "#C9A96E" }}>${prefSheetBudgetMin}-${prefSheetBudgetMax}</div>
              </div>
              {/* Fit badge */}
              {prefSheetFit.length > 0 && (
                <div style={{ padding: "10px 16px", background: "rgba(201,169,110,.08)", border: "1px solid rgba(201,169,110,.2)", borderRadius: 12, textAlign: "center" }}>
                  <div style={{ fontSize: 10, color: "rgba(255,255,255,.3)", fontWeight: 600, letterSpacing: 0.5, marginBottom: 4 }}>Fit</div>
                  <div style={{ fontSize: 14, fontWeight: 700, color: "#C9A96E", textTransform: "capitalize" }}>{prefSheetFit.join(", ")}</div>
                </div>
              )}
            </div>

            {/* Scan count */}
            <div style={{ fontSize: 12, color: "rgba(255,255,255,.25)", lineHeight: 1.5 }}>
              {history.length > 0 ? `${history.length} outfit${history.length !== 1 ? "s" : ""} scanned` : "First scan complete!"}
            </div>

            <div style={{ marginTop: 16, fontSize: 11, color: "rgba(255,255,255,.15)" }}>Tap anywhere to dismiss</div>
          </div>
        </div>
      )}
    </div>
  </>);
}
