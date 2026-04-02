import { useState, useRef, useCallback, useEffect, Fragment } from "react";
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

  // Guest endpoints (no auth required)
  async guestIdentify(base64, mimeType, priorityRegionBase64 = null) {
    const res = await fetch(`${API_BASE}/api/guest/identify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ image: base64, mime_type: mimeType, ...(priorityRegionBase64 && { priority_region_base64: priorityRegionBase64 }) }),
    });
    if (res.status === 429) {
      const data = await res.json();
      throw new Error(data.message || "Guest scan limit reached");
    }
    if (!res.ok) {
      let data = {};
      try { data = await res.json(); } catch { data = { message: `HTTP ${res.status}` }; }
      throw new Error(data.message || data.error || `API error ${res.status}`);
    }
    return await res.json();
  },

  async guestFindProducts(items, gender, searchMode = "fast") {
    const res = await fetch(`${API_BASE}/api/guest/find-products`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ items, gender, search_mode: searchMode }),
    });
    if (!res.ok) { const data = await res.json(); throw new Error(data.message || "Product search failed"); }
    return await res.json();
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

  async findProducts(items, gender, scanId, occasion = null, searchNotes = null, searchMode = "fast") {
    const res = await authFetch(`${API_BASE}/api/find-products`, {
      method: "POST",
      body: JSON.stringify({ items, gender, scan_id: scanId, occasion, ...(searchNotes ? { search_notes: searchNotes } : {}), search_mode: searchMode }),
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

  async logAdEvent(ad_type, ad_placement, action, retailer) {
    authFetch(`${API_BASE}/api/ad-events`, {
      method: "POST",
      body: JSON.stringify({ ad_type, ad_placement, action, retailer }),
    }).catch(() => {});
  },

  async findDupes(productName, description, price, imageUrl, category, gender) {
    const res = await authFetch(`${API_BASE}/api/dupes`, {
      method: "POST",
      body: JSON.stringify({ product_name: productName, description, price, image_url: imageUrl, category, gender }),
    });
    if (!res.ok) { const data = await res.json(); throw new Error(data.error || "Dupe search failed"); }
    return await res.json();
  },

  affiliateUrl(clickId, url, scanId, itemIndex, tier, retailer) {
    const params = new URLSearchParams({ url, scan_id: scanId || "", item_index: itemIndex, tier, retailer });
    return `${API_BASE}/api/go/${clickId}?${params}`;
  },

  oauthLogin(provider) {
    const redirectTo = window.location.origin + "/";
    window.location.href = `${SUPABASE_URL}/auth/v1/authorize?provider=${provider}&redirect_to=${encodeURIComponent(redirectTo)}`;
  },

  async uploadAvatar(base64DataUri) {
    const res = await authFetch(`${API_BASE}/api/user/avatar`, {
      method: "POST",
      body: JSON.stringify({ image: base64DataUri }),
    });
    if (!res.ok) { const data = await res.json(); throw new Error(data.error || "Avatar upload failed"); }
    return await res.json();
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

  async refineItem(scanId, itemIndex, originalItem, userMessage, chatHistory, gender, memory = null) {
    // When memory exists, only send recent chat messages (last 4) — memory carries the rest
    const recentChat = memory && chatHistory.length > 4 ? chatHistory.slice(-4) : chatHistory;
    const res = await authFetch(`${API_BASE}/api/refine-item`, {
      method: "POST",
      body: JSON.stringify({ scan_id: scanId, item_index: itemIndex, original_item: originalItem, user_message: userMessage, chat_history: recentChat, gender, memory }),
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
  async getFollowers(userId) {
    return authFetch(`${API_BASE}/api/social/followers/${userId}`).then(r => r.json());
  },

  async getFollowing(userId) {
    return authFetch(`${API_BASE}/api/social/following/${userId}`).then(r => r.json());
  },

  async updateScanVisibility(scanId, visibility) {
    return authFetch(`${API_BASE}/api/social/scans/${scanId}/visibility`, { method: "PATCH", body: JSON.stringify({ visibility }) }).then(r => r.json());
  },

  async getFeed(page = 1, feedTab = "foryou") {
    const res = await authFetch(`${API_BASE}/api/feed?page=${page}&limit=20&tab=${feedTab}`);
    return res.json();
  },
  async getOOTW() {
    const res = await authFetch(`${API_BASE}/api/ootw/current`);
    return res.json();
  },
  async getMyWeeklyReport() {
    const res = await authFetch(`${API_BASE}/api/ootw/my-report`);
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

  async getStats() {
    const res = await fetch(`${API_BASE}/api/stats`);
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

  // ─── Style Challenges ─────────────────────────────────────
  async getChallenges() {
    const res = await authFetch(`${API_BASE}/api/challenges`);
    return res.json();
  },
  async getChallenge(id) {
    const res = await authFetch(`${API_BASE}/api/challenges/${id}`);
    return res.json();
  },
  async submitChallenge(id, imageUrl, caption, scanId) {
    const res = await authFetch(`${API_BASE}/api/challenges/${id}/submit`, {
      method: "POST",
      body: JSON.stringify({ image_url: imageUrl, caption, scan_id: scanId }),
    });
    return res.json();
  },
  async voteChallenge(id, submissionId) {
    const res = await authFetch(`${API_BASE}/api/challenges/${id}/vote`, {
      method: "POST",
      body: JSON.stringify({ submission_id: submissionId }),
    });
    return res.json();
  },
  async unvoteChallenge(id, submissionId) {
    const res = await authFetch(`${API_BASE}/api/challenges/${id}/vote`, {
      method: "DELETE",
      body: JSON.stringify({ submission_id: submissionId }),
    });
    return res.json();
  },

  // ─── Push Notifications ───────────────────────────────────
  async getVapidKey() {
    const res = await fetch(`${API_BASE}/api/notifications/vapid-key`);
    if (!res.ok) return null;
    const data = await res.json();
    return data.vapidPublicKey;
  },

  async subscribePush(subscription) {
    const res = await authFetch(`${API_BASE}/api/notifications/subscribe`, {
      method: "POST",
      body: JSON.stringify({ subscription }),
    });
    return res.ok;
  },

  async unsubscribePush(endpoint) {
    const res = await authFetch(`${API_BASE}/api/notifications/unsubscribe`, {
      method: "DELETE",
      body: JSON.stringify({ endpoint }),
    });
    return res.ok;
  },

  async getNotifications(limit = 20) {
    const res = await authFetch(`${API_BASE}/api/notifications?limit=${limit}`);
    if (!res.ok) return { notifications: [] };
    return await res.json();
  },

  async getUnreadNotifCount() {
    const res = await authFetch(`${API_BASE}/api/notifications/unread-count`);
    if (!res.ok) return { count: 0 };
    return await res.json();
  },

  async markNotifsRead(notificationIds) {
    await authFetch(`${API_BASE}/api/notifications/read`, {
      method: "PATCH",
      body: JSON.stringify({ notificationIds }),
    });
  },

  async updateNotifPrefs(preferences) {
    const res = await authFetch(`${API_BASE}/api/notifications/preferences`, {
      method: "PATCH",
      body: JSON.stringify({ preferences }),
    });
    return res.ok ? (await res.json()).preferences : null;
  },

  // ─── Follow-up Nudges ────────────────────────────────────────
  async scheduleNudge(scanId, context = "scan_results", itemName = null) {
    return authFetch(`${API_BASE}/api/notifications/nudge`, {
      method: "POST",
      body: JSON.stringify({ scan_id: scanId, context, item_name: itemName }),
    }).catch(() => {});
  },

  async cancelNudge(scanId = null) {
    return authFetch(`${API_BASE}/api/notifications/nudge`, {
      method: "DELETE",
      body: JSON.stringify({ scan_id: scanId }),
    }).catch(() => {});
  },

  // ─── Style Twins ──────────────────────────────────────────
  async getStyleTwins() {
    const res = await authFetch(`${API_BASE}/api/style-twins`);
    if (!res.ok) {
      console.warn("[API] getStyleTwins non-ok:", res.status, res.statusText);
      return { ready: false, twins: [] };
    }
    const data = await res.json();
    // Validate response shape
    if (typeof data !== "object" || data === null) {
      console.warn("[API] getStyleTwins unexpected response:", data);
      return { ready: false, twins: [] };
    }
    return data;
  },
  async checkSharedSave(itemName) {
    const res = await authFetch(`${API_BASE}/api/style-twins/shared-save-check?item_name=${encodeURIComponent(itemName)}`);
    if (!res.ok) return { match: false };
    return await res.json();
  },

  // ─── Hanger Test ──────────────────────────────────────────
  async hangerTestToday() {
    const res = await authFetch(`${API_BASE}/api/hanger-test/today`);
    return res.json();
  },
  async hangerTestVote(outfitId, verdict) {
    const res = await authFetch(`${API_BASE}/api/hanger-test/vote`, { method: "POST", body: JSON.stringify({ outfit_id: outfitId, verdict }) });
    return res.json();
  },
  async hangerTestTasteProfile() {
    const res = await authFetch(`${API_BASE}/api/hanger-test/taste-profile`);
    return res.json();
  },
  async hangerTestTranche(outfitId) {
    const res = await authFetch(`${API_BASE}/api/hanger-test/tranche/${outfitId}`);
    return res.json();
  },
  async hangerTestStreak() {
    const res = await authFetch(`${API_BASE}/api/hanger-test/streak`);
    if (!res.ok) return { current_streak: 0 };
    return await res.json();
  },
  async hangerTestHistory(limit = 20, offset = 0) {
    const res = await authFetch(`${API_BASE}/api/hanger-test/history?limit=${limit}&offset=${offset}`);
    if (!res.ok) return { history: [] };
    return await res.json();
  },

  // ─── Complete the Look ────────────────────────────────────
  async getLooks() {
    const res = await authFetch(`${API_BASE}/api/looks`);
    if (!res.ok) return { looks: [] };
    return await res.json();
  },
  async getLookDetail(scanId) {
    const res = await authFetch(`${API_BASE}/api/looks/${scanId}`);
    if (!res.ok) throw new Error("Failed to fetch look");
    return await res.json();
  },
  async getBuyAllLinks(scanId) {
    const res = await authFetch(`${API_BASE}/api/looks/${scanId}/buy-all`);
    if (!res.ok) throw new Error("Failed to get buy links");
    return await res.json();
  },
};

// ─── Push subscription helper ────────────────────────────────
function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

async function subscribeToPush() {
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) return false;
  try {
    const vapidKey = await API.getVapidKey();
    if (!vapidKey) return false;

    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(vapidKey),
    });

    await API.subscribePush(subscription.toJSON());
    return true;
  } catch (err) {
    console.error("[Push] Subscribe error:", err);
    return false;
  }
}

// ─── Relative date formatting helper ──────────────────────────
function relativeDate(dateStr) {
  const d = new Date(dateStr);
  const now = new Date();
  const diffH = Math.floor((now - d) / 3600000);
  if (diffH < 1) return "Just now";
  if (diffH < 24) return `${diffH}h ago`;
  if (diffH < 48) return "Yesterday";
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

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
    searching: { text: "SEARCHING...", bg: "var(--accent-bg)", color: "var(--accent)", dot: "var(--accent)", pulse: true },
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
          <div style={{ fontSize: 14, fontWeight: 600, lineHeight: 1.3 }}>{data.product_name || "Loading..."}</div>
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
        <div className="pw-badge">✦ ATTAIRE PRO</div>
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
            <div className="pw-pp">$29.99<span className="pw-pd">/yr</span></div>
            <div className="pw-pw">$0.58/week</div>
          </div>
          <div className={`pw-p${plan === "monthly" ? " sel" : ""}`} onClick={() => setPlan("monthly")} style={{ textAlign: "center" }}>
            <div className="pw-pp">$4.99<span className="pw-pd">/mo</span></div>
            <div className="pw-pw">$1.25/week</div>
          </div>
        </div>
        <button className="cta" onClick={handleCta} disabled={loadingPlan} style={{ opacity: loadingPlan ? 0.7 : 1 }}>
          {loadingPlan ? <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}><span style={{ display: "inline-block", width: 14, height: 14, border: "2px solid rgba(12,12,14,.3)", borderTopColor: "#0C0C0E", borderRadius: "50%", animation: "spin .7s linear infinite" }} />Processing...</span> : m.cta}
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

// ─── Retailer Spotlight Data ────────────────────────────────
const RETAILER_SPOTLIGHTS = [
  { name: "Nordstrom", tagline: "Free shipping. Free returns. All the time.", cta: "Shop Nordstrom", gradient: "linear-gradient(135deg, #1a1a2e 0%, #0d2137 100%)", accent: "#4A90D9", url: "https://www.nordstrom.com" },
  { name: "ASOS", tagline: "Discover fashion online. 850+ brands.", cta: "Shop ASOS", gradient: "linear-gradient(135deg, #1a1a1a 0%, #2d2d2d 100%)", accent: "#fff", url: "https://www.asos.com" },
  { name: "Revolve", tagline: "Designer fashion at your fingertips.", cta: "Shop Revolve", gradient: "linear-gradient(135deg, #1a1a2e 0%, #2a1a3e 100%)", accent: "#C77DFF", url: "https://www.revolve.com" },
  { name: "SSENSE", tagline: "Luxury & emerging designers. Curated.", cta: "Shop SSENSE", gradient: "linear-gradient(135deg, #0a0a0a 0%, #1a1a1a 100%)", accent: "#fff", url: "https://www.ssense.com" },
  { name: "Shopbop", tagline: "Designer women's fashion. Free 2-day shipping.", cta: "Shop Shopbop", gradient: "linear-gradient(135deg, #1a2e1a 0%, #0d372d 100%)", accent: "#5AC8A0", url: "https://www.shopbop.com" },
  { name: "Zara", tagline: "New collection just dropped.", cta: "Shop Zara", gradient: "linear-gradient(135deg, #1a1a1a 0%, #333333 100%)", accent: "#e0e0e0", url: "https://www.zara.com" },
  { name: "Madewell", tagline: "Jeans, tees & more. Designed to be lived in.", cta: "Shop Madewell", gradient: "linear-gradient(135deg, #2e261a 0%, #3e2e1a 100%)", accent: "#D4A76A", url: "https://www.madewell.com" },
  { name: "Lululemon", tagline: "Technical gear for yoga, running & training.", cta: "Shop Lululemon", gradient: "linear-gradient(135deg, #1a0a0a 0%, #2e1414 100%)", accent: "#D32F2F", url: "https://www.lululemon.com" },
];
const getSpotlight = () => RETAILER_SPOTLIGHTS[Math.floor(Math.random() * RETAILER_SPOTLIGHTS.length)];

// ─── Retailer Spotlight Interstitial ────────────────────────
const InterstitialAd = ({ onClose }) => {
  const [timer, setTimer] = useState(5);
  const [spot] = useState(getSpotlight);
  useEffect(() => {
    API.logAdEvent("interstitial", "post_scan", "impression", spot.name);
    const iv = setInterval(() => setTimer(t => { if (t <= 1) { clearInterval(iv); } return t - 1; }), 1000);
    return () => clearInterval(iv);
  }, []);
  return (
    <div className="modal-overlay" onClick={() => timer <= 3 && onClose()}>
      <div onClick={e => e.stopPropagation()} style={{ width: "100%", maxWidth: 400, aspectRatio: "9/16", background: "#111114", border: "1px solid rgba(255,255,255,.06)", borderRadius: 20, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 16, position: "relative" }}>
        <div className="ad-slot" style={{ width: "90%", height: "70%", borderRadius: 12, overflow: "hidden", display: "flex", flexDirection: "column", background: spot.gradient, border: "1px solid rgba(255,255,255,.08)" }}>
          <div style={{ padding: "8px 12px", display: "flex", justifyContent: "space-between", alignItems: "center", borderBottom: "1px solid rgba(255,255,255,.06)" }}>
            <span style={{ fontSize: 9, color: "rgba(255,255,255,.3)", letterSpacing: 1, textTransform: "uppercase" }}>Featured Retailer</span>
            <span style={{ fontSize: 9, color: "rgba(255,255,255,.15)" }}>Spotlight</span>
          </div>
          <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
            <div style={{ textAlign: "center" }}>
              <div style={{ fontSize: 32, fontWeight: 900, color: spot.accent, marginBottom: 8, fontFamily: "var(--font-sans)", letterSpacing: -1 }}>{spot.name}</div>
              <div style={{ fontSize: 13, color: "rgba(255,255,255,.55)", marginBottom: 20, lineHeight: 1.5 }}>{spot.tagline}</div>
              <a href={spot.url} target="_blank" rel="noopener noreferrer" onClick={() => { API.logAdEvent("interstitial", "post_scan", "click", spot.name); }} style={{ display: "inline-block", padding: "12px 28px", background: spot.accent, borderRadius: 100, fontSize: 13, fontWeight: 700, color: spot.accent === "#fff" || spot.accent === "#e0e0e0" ? "#0C0C0E" : "#fff", fontFamily: "var(--font-sans)", textDecoration: "none", border: "none", cursor: "pointer" }}>{spot.cta}</a>
            </div>
          </div>
          <div style={{ padding: "8px 12px", textAlign: "center", borderTop: "1px solid rgba(255,255,255,.06)" }}>
            <span style={{ fontSize: 10, color: "rgba(255,255,255,.2)" }}>Discover on ATTAIRE</span>
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
    analyzing: "Analyzing the look...",
    searching: "Searching the web...",
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
    search_notes_placeholder: "Add search notes (e.g., 'sustainable brands', 'linen fabric')...",
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
    loading: "Loading...",
    saving: "Saving...",
    cancel: "Cancel",
    confirm: "Confirm",
    done: "Done",
    save_btn: "Save",
    not_set: "Not set",
    appearance: "Appearance",
    dark: "Dark",
    light: "Light",
    budget_range: "Budget Range",
    budget_save_error: "Failed to save. Please try again.",
    budget_min_label: "MIN",
    budget_max_label: "MAX",
    budget_tier_under50: "$ Under $50",
    budget_tier_mid: "$$ $50–150",
    budget_tier_high: "$$$ $150–500",
    budget_tier_premium: "$$$$ $500+",
    size_preferences: "Size Preferences",
    subscription: "Subscription",
    free: "Free",
    notifications: "Notifications",
    enable_push: "Enable Push Notifications",
    push_enabled: "Push notifications are enabled",
    followup_reminders: "Follow-up reminders",
    followup_desc: "Nudge me if I forget to check my results",
    style_twins_notif: "Style Twins",
    style_twins_desc: "Weekly \"new style twins discovered\" alerts",
    refer_friend: "Refer a friend",
    refer_desc: "Share your code. Both of you get $5 credit.",
    size_prefs_title: "Size Preferences",
    size_prefs_sub: "Set your sizes for better product recommendations.",
    men: "Men",
    women: "Women",
    tops: "Tops",
    bottoms_waist: "Bottoms (Waist)",
    bottoms_length: "Bottoms (Length)",
    shoes_label: "Shoes",
    dresses: "Dresses",
    save_sizes: "Save Sizes",
    change_language_confirm: "Change language?",
    change_language_desc: "Your app language will be updated.",
    scans_label: "Scans",
    edit_profile: "Edit Profile",
    style_dna: "Style DNA",
    hanger_test: "Hanger Test",
    tell_style: "Tell people about your style...",
    no_followers: "No followers yet",
    no_following: "Not following anyone yet",
    my_scans: "My Scans",
    wardrobe: "Wardrobe",
    all: "All",
    my_picks: "My Picks",
    search_scans: "Search scans...",
    no_scans_yet: "No scans yet",
    no_match_search: "No scans match your search",
    scan_first: "Scan your first outfit to build your style library",
    try_different: "Try different keywords",
    scan_outfit: "Scan an Outfit",
    no_saved: "No saved items yet",
    heart_items: "Heart items from your scans to save them here",
    search_people: "Search people...",
    no_users_found: "No users found",
    type_to_search: "Type a name to search",
    view_results: "View Full Results",
    shop: "Shop",
    search_google: "Search Google Shopping",
    no_match: "No exact match found",
    original: "ORIGINAL",
    resale: "RESALE",
    take_photo: "Take a photo or upload an outfit",
    upload: "Upload",
    camera: "Camera",
    for_you: "For You",
    trending: "Trending",
    discover: "Discover",
    load_more: "Load more",
    continue_google: "Continue with Google",
    continue_apple: "Continue with Apple",
    create_account: "Create Account",
    log_in: "Log In",
    full_name: "Full name",
    email: "Email address",
    password: "Password",
    phone_optional: "Phone number (optional)",
    get_started: "Get started",
    maybe_later: "Maybe later",
    upgrade_to_pro: "Upgrade to Pro",
    go_pro: "Go Pro",
    appearance: "Appearance",
    dark: "Dark",
    light: "Light",
    budget_range: "Budget Range",
    size_preferences: "Size Preferences",
    not_set: "Not set",
    subscription: "Subscription",
    free: "Free",
    upgrade_to_pro: "Upgrade to Pro",
    notifications: "Notifications",
    enable_push: "Enable Push Notifications",
    push_enabled: "Push notifications are enabled",
    follow_up_reminders: "Follow-up reminders",
    nudge_desc: "Nudge me if I forget to check my results",
    style_twins_notif: "Style Twins",
    style_twins_desc: "Weekly \"new style twins discovered\" alerts",
    refer_friend: "Refer a friend",
    refer_desc: "Share your code. Both of you get $5 credit.",
    my_scans: "My Scans",
    wardrobe: "Wardrobe",
    scan_an_outfit: "Scan an Outfit",
    no_scans_yet: "No scans yet",
    no_scans_match: "No scans match your search",
    all_filter: "All",
    my_picks: "My Picks",
    all_scans: "All Scans",
    search_scans: "Search scans...",
    outfits: "Outfits",
    all_items: "All Items",
    no_outfits_saved: "No outfits saved yet",
    save_items_desc: "Save items from your scans to build complete outfits",
    edit_profile: "Edit Profile",
    save_bio: "Save",
    cancel: "Cancel",
    scans_stat: "Scans",
    complete_look_btn: "Complete the Look",
    finding_pieces: "Finding complementary pieces...",
    save_budget: "Save Budget",
    budget_save_error: "Failed to save. Please try again.",
    budget_min_label: "MIN",
    budget_max_label: "MAX",
    budget_tier_under50: "$ Under $50",
    budget_tier_mid: "$$ $50–150",
    budget_tier_high: "$$$ $150–500",
    budget_tier_premium: "$$$$ $500+",
    saving: "Saving...",
    confirm_language: "Change language?",
    confirm_language_desc: "Change language to",
    confirm_btn: "Confirm",
    cancel_btn: "Cancel",
    men: "Men",
    women: "Women",
    tops: "Tops",
    bottoms_waist: "Bottoms Waist",
    bottoms_length: "Bottoms Length",
    shoes: "Shoes",
    dresses: "Dresses",
    size_prefs_title: "Size Preferences",
    select_gender: "Select your gender",
    save_sizes: "Save Sizes",
    no_followers_yet: "No followers yet",
    no_following_yet: "Not following anyone yet",
  },
  es: {
    home: "Inicio",
    scan: "Escanear",
    history: "Historial",
    saved: "Guardados",
    profile: "Perfil",
    new_scan: "Nuevo escaneo",
    analyzing: "Analizando el look...",
    searching: "Buscando en la web...",
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
    search_notes_placeholder: "Añadir notas (ej. 'marcas sostenibles', 'tela de lino')...",
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
    loading: "Cargando...",
    saving: "Guardando...",
    cancel: "Cancelar",
    confirm: "Confirmar",
    done: "Listo",
    save_btn: "Guardar",
    not_set: "No configurado",
    appearance: "Apariencia",
    dark: "Oscuro",
    light: "Claro",
    budget_range: "Rango de presupuesto",
    size_preferences: "Preferencias de talla",
    subscription: "Suscripción",
    free: "Gratis",
    notifications: "Notificaciones",
    enable_push: "Activar notificaciones push",
    push_enabled: "Notificaciones push activadas",
    followup_reminders: "Recordatorios de seguimiento",
    followup_desc: "Avisarme si olvido revisar mis resultados",
    style_twins_notif: "Gemelos de estilo",
    style_twins_desc: "Alertas semanales de nuevos gemelos de estilo",
    refer_friend: "Invita a un amigo",
    refer_desc: "Comparte tu código. Ambos obtienen $5 de crédito.",
    size_prefs_title: "Preferencias de talla",
    size_prefs_sub: "Configura tus tallas para mejores recomendaciones.",
    men: "Hombre",
    women: "Mujer",
    tops: "Parte superior",
    bottoms_waist: "Parte inferior (Cintura)",
    bottoms_length: "Parte inferior (Largo)",
    shoes_label: "Zapatos",
    dresses: "Vestidos",
    save_sizes: "Guardar tallas",
    change_language_confirm: "¿Cambiar idioma?",
    change_language_desc: "El idioma de la app se actualizará.",
    scans_label: "Escaneos",
    edit_profile: "Editar perfil",
    style_dna: "ADN de estilo",
    hanger_test: "Prueba de percha",
    tell_style: "Cuéntale a la gente sobre tu estilo...",
    no_followers: "Sin seguidores aún",
    no_following: "No sigues a nadie aún",
    my_scans: "Mis escaneos",
    wardrobe: "Armario",
    all: "Todo",
    my_picks: "Mis favoritos",
    search_scans: "Buscar escaneos...",
    no_scans_yet: "Sin escaneos aún",
    no_match_search: "No hay escaneos que coincidan",
    scan_first: "Escanea tu primer outfit para crear tu biblioteca de estilo",
    try_different: "Intenta con diferentes palabras",
    scan_outfit: "Escanear un outfit",
    no_saved: "Sin artículos guardados",
    heart_items: "Dale corazón a los artículos de tus escaneos para guardarlos aquí",
    search_people: "Buscar personas...",
    no_users_found: "No se encontraron usuarios",
    type_to_search: "Escribe un nombre para buscar",
    view_results: "Ver resultados completos",
    shop: "Comprar",
    search_google: "Buscar en Google Shopping",
    no_match: "No se encontró coincidencia exacta",
    original: "ORIGINAL",
    resale: "REVENTA",
    take_photo: "Toma una foto o sube un outfit",
    upload: "Subir",
    camera: "Cámara",
    for_you: "Para ti",
    trending: "Tendencias",
    discover: "Descubrir",
    load_more: "Cargar más",
    continue_google: "Continuar con Google",
    continue_apple: "Continuar con Apple",
    create_account: "Crear cuenta",
    log_in: "Iniciar sesión",
    full_name: "Nombre completo",
    email: "Correo electrónico",
    password: "Contraseña",
    phone_optional: "Teléfono (opcional)",
    get_started: "Comenzar",
    maybe_later: "Quizás después",
    upgrade_to_pro: "Mejorar a Pro",
    go_pro: "Ir a Pro",
    appearance: "Apariencia",
    dark: "Oscuro",
    light: "Claro",
    budget_range: "Rango de presupuesto",
    size_preferences: "Preferencias de talla",
    not_set: "No configurado",
    subscription: "Suscripción",
    free: "Gratis",
    upgrade_to_pro: "Mejorar a Pro",
    notifications: "Notificaciones",
    enable_push: "Activar notificaciones push",
    push_enabled: "Las notificaciones push están activadas",
    follow_up_reminders: "Recordatorios de seguimiento",
    nudge_desc: "Recuérdame si olvido revisar mis resultados",
    style_twins_notif: "Style Twins",
    style_twins_desc: "Alertas semanales de \"nuevos gemelos de estilo\"",
    refer_friend: "Invita a un amigo",
    refer_desc: "Comparte tu código. Ambos obtienen $5 de crédito.",
    my_scans: "Mis escaneos",
    wardrobe: "Armario",
    scan_an_outfit: "Escanear un outfit",
    no_scans_yet: "Sin escaneos aún",
    no_scans_match: "Ningún escaneo coincide con tu búsqueda",
    all_filter: "Todos",
    my_picks: "Mis favoritos",
    all_scans: "Todos los escaneos",
    search_scans: "Buscar escaneos...",
    outfits: "Outfits",
    all_items: "Todos los artículos",
    no_outfits_saved: "Sin outfits guardados aún",
    save_items_desc: "Guarda artículos de tus escaneos para crear outfits completos",
    edit_profile: "Editar perfil",
    save_bio: "Guardar",
    cancel: "Cancelar",
    scans_stat: "Escaneos",
    complete_look_btn: "Completa el Look",
    finding_pieces: "Buscando piezas complementarias...",
    save_budget: "Guardar presupuesto",
    budget_save_error: "Error al guardar. Inténtalo de nuevo.",
    budget_min_label: "MÍN",
    budget_max_label: "MÁX",
    budget_tier_under50: "$ Menos de $50",
    budget_tier_mid: "$$ $50–150",
    budget_tier_high: "$$$ $150–500",
    budget_tier_premium: "$$$$ $500+",
    saving: "Guardando...",
    confirm_language: "¿Cambiar idioma?",
    confirm_language_desc: "Cambiar idioma a",
    confirm_btn: "Confirmar",
    cancel_btn: "Cancelar",
    men: "Hombres",
    women: "Mujeres",
    tops: "Tops",
    bottoms_waist: "Cintura",
    bottoms_length: "Largo",
    shoes: "Zapatos",
    dresses: "Vestidos",
    size_prefs_title: "Preferencias de talla",
    select_gender: "Selecciona tu género",
    save_sizes: "Guardar tallas",
    no_followers_yet: "Sin seguidores aún",
    no_following_yet: "No sigues a nadie aún",
  },
  fr: {
    home: "Accueil",
    scan: "Scanner",
    history: "Historique",
    saved: "Sauvegardes",
    profile: "Profil",
    new_scan: "Nouveau scan",
    analyzing: "Analyse du look...",
    searching: "Recherche en cours...",
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
    search_notes_placeholder: "Notes de recherche (ex. 'marques durables', 'tissu lin')...",
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
    loading: "Chargement...",
    saving: "Sauvegarde...",
    cancel: "Annuler",
    confirm: "Confirmer",
    done: "Terminé",
    save_btn: "Enregistrer",
    not_set: "Non défini",
    appearance: "Apparence",
    dark: "Sombre",
    light: "Clair",
    budget_range: "Gamme de budget",
    size_preferences: "Préférences de taille",
    subscription: "Abonnement",
    free: "Gratuit",
    notifications: "Notifications",
    enable_push: "Activer les notifications push",
    push_enabled: "Notifications push activées",
    followup_reminders: "Rappels de suivi",
    followup_desc: "Me rappeler si j'oublie de vérifier mes résultats",
    style_twins_notif: "Jumeaux de style",
    style_twins_desc: "Alertes hebdomadaires de nouveaux jumeaux de style",
    refer_friend: "Parrainez un ami",
    refer_desc: "Partagez votre code. Vous obtenez chacun 5$ de crédit.",
    size_prefs_title: "Préférences de taille",
    size_prefs_sub: "Définissez vos tailles pour de meilleures recommandations.",
    men: "Homme",
    women: "Femme",
    tops: "Hauts",
    bottoms_waist: "Bas (Taille)",
    bottoms_length: "Bas (Longueur)",
    shoes_label: "Chaussures",
    dresses: "Robes",
    save_sizes: "Enregistrer les tailles",
    change_language_confirm: "Changer la langue ?",
    change_language_desc: "La langue de l'application sera mise à jour.",
    scans_label: "Scans",
    edit_profile: "Modifier le profil",
    style_dna: "ADN de style",
    hanger_test: "Test du cintre",
    tell_style: "Parlez de votre style...",
    no_followers: "Pas encore d'abonnés",
    no_following: "Vous ne suivez personne encore",
    my_scans: "Mes scans",
    wardrobe: "Garde-robe",
    all: "Tout",
    my_picks: "Mes choix",
    search_scans: "Rechercher des scans...",
    no_scans_yet: "Aucun scan encore",
    no_match_search: "Aucun scan ne correspond à votre recherche",
    scan_first: "Scannez votre première tenue pour créer votre bibliothèque de style",
    try_different: "Essayez des mots-clés différents",
    scan_outfit: "Scanner une tenue",
    no_saved: "Aucun article sauvegardé",
    heart_items: "Aimez les articles de vos scans pour les sauvegarder ici",
    search_people: "Rechercher des personnes...",
    no_users_found: "Aucun utilisateur trouvé",
    type_to_search: "Tapez un nom pour rechercher",
    view_results: "Voir tous les résultats",
    shop: "Acheter",
    search_google: "Rechercher sur Google Shopping",
    no_match: "Aucune correspondance exacte",
    original: "ORIGINAL",
    resale: "REVENTE",
    take_photo: "Prenez une photo ou téléchargez une tenue",
    upload: "Télécharger",
    camera: "Appareil photo",
    for_you: "Pour vous",
    trending: "Tendances",
    discover: "Découvrir",
    load_more: "Charger plus",
    continue_google: "Continuer avec Google",
    continue_apple: "Continuer avec Apple",
    create_account: "Créer un compte",
    log_in: "Se connecter",
    full_name: "Nom complet",
    email: "Adresse e-mail",
    password: "Mot de passe",
    phone_optional: "Téléphone (optionnel)",
    get_started: "Commencer",
    maybe_later: "Peut-être plus tard",
    upgrade_to_pro: "Passer à Pro",
    go_pro: "Passer Pro",
    appearance: "Apparence",
    dark: "Sombre",
    light: "Clair",
    budget_range: "Fourchette de budget",
    size_preferences: "Préférences de taille",
    not_set: "Non défini",
    subscription: "Abonnement",
    free: "Gratuit",
    upgrade_to_pro: "Passer à Pro",
    notifications: "Notifications",
    enable_push: "Activer les notifications push",
    push_enabled: "Les notifications push sont activées",
    follow_up_reminders: "Rappels de suivi",
    nudge_desc: "Me rappeler si j'oublie de vérifier mes résultats",
    style_twins_notif: "Style Twins",
    style_twins_desc: "Alertes hebdomadaires \"nouveaux jumeaux de style\"",
    refer_friend: "Inviter un ami",
    refer_desc: "Partagez votre code. Vous recevez tous les deux 5$ de crédit.",
    my_scans: "Mes scans",
    wardrobe: "Garde-robe",
    scan_an_outfit: "Scanner une tenue",
    no_scans_yet: "Aucun scan encore",
    no_scans_match: "Aucun scan ne correspond à votre recherche",
    all_filter: "Tous",
    my_picks: "Mes choix",
    all_scans: "Tous les scans",
    search_scans: "Rechercher des scans...",
    outfits: "Tenues",
    all_items: "Tous les articles",
    no_outfits_saved: "Aucune tenue sauvegardée",
    save_items_desc: "Sauvegardez des articles de vos scans pour créer des tenues complètes",
    edit_profile: "Modifier le profil",
    save_bio: "Sauvegarder",
    cancel: "Annuler",
    scans_stat: "Scans",
    complete_look_btn: "Compléter le Look",
    finding_pieces: "Recherche de pièces complémentaires...",
    save_budget: "Sauvegarder le budget",
    budget_save_error: "Échec de la sauvegarde. Veuillez réessayer.",
    budget_min_label: "MIN",
    budget_max_label: "MAX",
    budget_tier_under50: "$ Moins de 50$",
    budget_tier_mid: "$$ 50–150$",
    budget_tier_high: "$$$ 150–500$",
    budget_tier_premium: "$$$$ 500$+",
    saving: "Sauvegarde...",
    confirm_language: "Changer de langue ?",
    confirm_language_desc: "Changer la langue en",
    confirm_btn: "Confirmer",
    cancel_btn: "Annuler",
    men: "Hommes",
    women: "Femmes",
    tops: "Hauts",
    bottoms_waist: "Taille pantalon",
    bottoms_length: "Longueur pantalon",
    shoes: "Chaussures",
    dresses: "Robes",
    size_prefs_title: "Préférences de taille",
    select_gender: "Sélectionnez votre genre",
    save_sizes: "Sauvegarder les tailles",
    no_followers_yet: "Aucun abonné encore",
    no_following_yet: "Vous ne suivez personne encore",
  },
  de: {
    home: "Start",
    scan: "Scannen",
    history: "Verlauf",
    saved: "Gespeichert",
    profile: "Profil",
    new_scan: "Neuer Scan",
    analyzing: "Look wird analysiert...",
    searching: "Web wird durchsucht...",
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
    search_notes_placeholder: "Suchnotizen (z.B. 'nachhaltige Marken', 'Leinenstoff')...",
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
    loading: "Laden...",
    saving: "Speichern...",
    cancel: "Abbrechen",
    confirm: "Bestätigen",
    done: "Fertig",
    save_btn: "Speichern",
    not_set: "Nicht eingestellt",
    appearance: "Erscheinungsbild",
    dark: "Dunkel",
    light: "Hell",
    budget_range: "Budgetbereich",
    size_preferences: "Größeneinstellungen",
    subscription: "Abonnement",
    free: "Kostenlos",
    notifications: "Benachrichtigungen",
    enable_push: "Push-Benachrichtigungen aktivieren",
    push_enabled: "Push-Benachrichtigungen aktiviert",
    followup_reminders: "Follow-up-Erinnerungen",
    followup_desc: "Erinnere mich, wenn ich vergesse, meine Ergebnisse zu prüfen",
    style_twins_notif: "Style-Zwillinge",
    style_twins_desc: "Wöchentliche Alerts zu neuen Style-Zwillingen",
    refer_friend: "Freund empfehlen",
    refer_desc: "Teile deinen Code. Ihr bekommt beide 5$ Guthaben.",
    size_prefs_title: "Größeneinstellungen",
    size_prefs_sub: "Lege deine Größen für bessere Empfehlungen fest.",
    men: "Herren",
    women: "Damen",
    tops: "Oberteile",
    bottoms_waist: "Unterteile (Taille)",
    bottoms_length: "Unterteile (Länge)",
    shoes_label: "Schuhe",
    dresses: "Kleider",
    save_sizes: "Größen speichern",
    change_language_confirm: "Sprache ändern?",
    change_language_desc: "Die App-Sprache wird aktualisiert.",
    scans_label: "Scans",
    edit_profile: "Profil bearbeiten",
    style_dna: "Stil-DNA",
    hanger_test: "Kleiderbügel-Test",
    tell_style: "Erzähle anderen von deinem Stil...",
    no_followers: "Noch keine Follower",
    no_following: "Du folgst niemandem",
    my_scans: "Meine Scans",
    wardrobe: "Garderobe",
    all: "Alle",
    my_picks: "Meine Auswahl",
    search_scans: "Scans durchsuchen...",
    no_scans_yet: "Noch keine Scans",
    no_match_search: "Keine Scans stimmen überein",
    scan_first: "Scanne dein erstes Outfit, um deine Stil-Bibliothek aufzubauen",
    try_different: "Versuche andere Suchbegriffe",
    scan_outfit: "Outfit scannen",
    no_saved: "Keine gespeicherten Artikel",
    heart_items: "Speichere Artikel aus deinen Scans mit dem Herz-Symbol",
    search_people: "Personen suchen...",
    no_users_found: "Keine Benutzer gefunden",
    type_to_search: "Namen eingeben zum Suchen",
    view_results: "Alle Ergebnisse anzeigen",
    shop: "Kaufen",
    search_google: "Bei Google Shopping suchen",
    no_match: "Kein genaues Ergebnis gefunden",
    original: "ORIGINAL",
    resale: "GEBRAUCHT",
    take_photo: "Mach ein Foto oder lade ein Outfit hoch",
    upload: "Hochladen",
    camera: "Kamera",
    for_you: "Für dich",
    trending: "Trending",
    discover: "Entdecken",
    load_more: "Mehr laden",
    continue_google: "Weiter mit Google",
    continue_apple: "Weiter mit Apple",
    create_account: "Konto erstellen",
    log_in: "Anmelden",
    full_name: "Vollständiger Name",
    email: "E-Mail-Adresse",
    password: "Passwort",
    phone_optional: "Telefon (optional)",
    get_started: "Los geht's",
    maybe_later: "Vielleicht später",
    upgrade_to_pro: "Auf Pro upgraden",
    go_pro: "Pro werden",
    appearance: "Erscheinungsbild",
    dark: "Dunkel",
    light: "Hell",
    budget_range: "Budgetbereich",
    size_preferences: "Größenpräferenzen",
    not_set: "Nicht festgelegt",
    subscription: "Abonnement",
    free: "Kostenlos",
    upgrade_to_pro: "Auf Pro upgraden",
    notifications: "Benachrichtigungen",
    enable_push: "Push-Benachrichtigungen aktivieren",
    push_enabled: "Push-Benachrichtigungen sind aktiviert",
    follow_up_reminders: "Erinnerungen",
    nudge_desc: "Erinnere mich, wenn ich vergesse, meine Ergebnisse zu prüfen",
    style_twins_notif: "Style Twins",
    style_twins_desc: "Wöchentliche Benachrichtigungen über neue Style-Zwillinge",
    refer_friend: "Freund einladen",
    refer_desc: "Teile deinen Code. Ihr erhaltet beide 5$ Guthaben.",
    my_scans: "Meine Scans",
    wardrobe: "Garderobe",
    scan_an_outfit: "Outfit scannen",
    no_scans_yet: "Noch keine Scans",
    no_scans_match: "Keine Scans entsprechen deiner Suche",
    all_filter: "Alle",
    my_picks: "Meine Auswahl",
    all_scans: "Alle Scans",
    search_scans: "Scans durchsuchen...",
    outfits: "Outfits",
    all_items: "Alle Artikel",
    no_outfits_saved: "Noch keine Outfits gespeichert",
    save_items_desc: "Speichere Artikel aus deinen Scans, um komplette Outfits zu erstellen",
    edit_profile: "Profil bearbeiten",
    save_bio: "Speichern",
    cancel: "Abbrechen",
    scans_stat: "Scans",
    complete_look_btn: "Look vervollständigen",
    finding_pieces: "Suche nach passenden Teilen...",
    save_budget: "Budget speichern",
    budget_save_error: "Speichern fehlgeschlagen. Bitte erneut versuchen.",
    budget_min_label: "MIN",
    budget_max_label: "MAX",
    budget_tier_under50: "$ Unter 50$",
    budget_tier_mid: "$$ 50–150$",
    budget_tier_high: "$$$ 150–500$",
    budget_tier_premium: "$$$$ 500$+",
    saving: "Wird gespeichert...",
    confirm_language: "Sprache ändern?",
    confirm_language_desc: "Sprache ändern zu",
    confirm_btn: "Bestätigen",
    cancel_btn: "Abbrechen",
    men: "Herren",
    women: "Damen",
    tops: "Oberteile",
    bottoms_waist: "Bundweite",
    bottoms_length: "Beinlänge",
    shoes: "Schuhe",
    dresses: "Kleider",
    size_prefs_title: "Größenpräferenzen",
    select_gender: "Geschlecht wählen",
    save_sizes: "Größen speichern",
    no_followers_yet: "Noch keine Follower",
    no_following_yet: "Du folgst noch niemandem",
  },
  zh: {
    home: "首页",
    scan: "扫描",
    history: "历史",
    saved: "已保存",
    profile: "个人",
    new_scan: "新扫描",
    analyzing: "正在分析穿搭...",
    searching: "正在搜索...",
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
    search_notes_placeholder: "添加搜索备注（如'可持续品牌'、'亚麻面料'）...",
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
    loading: "加载中...",
    saving: "保存中...",
    cancel: "取消",
    confirm: "确认",
    done: "完成",
    save_btn: "保存",
    not_set: "未设置",
    appearance: "外观",
    dark: "深色",
    light: "浅色",
    budget_range: "预算范围",
    size_preferences: "尺码偏好",
    subscription: "订阅",
    free: "免费",
    notifications: "通知",
    enable_push: "启用推送通知",
    push_enabled: "推送通知已启用",
    followup_reminders: "后续提醒",
    followup_desc: "提醒我查看我的结果",
    style_twins_notif: "时尚双胞胎",
    style_twins_desc: "每周\"发现新时尚双胞胎\"提醒",
    refer_friend: "推荐好友",
    refer_desc: "分享你的代码，双方各获得5美元。",
    size_prefs_title: "尺码偏好",
    size_prefs_sub: "设置你的尺码以获得更好的推荐。",
    men: "男性",
    women: "女性",
    tops: "上衣",
    bottoms_waist: "下装 (腰围)",
    bottoms_length: "下装 (长度)",
    shoes_label: "鞋子",
    dresses: "连衣裙",
    save_sizes: "保存尺码",
    change_language_confirm: "更换语言？",
    change_language_desc: "应用程序语言将被更新。",
    scans_label: "扫描",
    edit_profile: "编辑资料",
    style_dna: "风格DNA",
    hanger_test: "衣架测试",
    tell_style: "告诉大家你的穿搭风格...",
    no_followers: "还没有粉丝",
    no_following: "还没有关注任何人",
    my_scans: "我的扫描",
    wardrobe: "衣橱",
    all: "全部",
    my_picks: "我的精选",
    search_scans: "搜索扫描...",
    no_scans_yet: "暂无扫描",
    no_match_search: "没有匹配的扫描",
    scan_first: "扫描你的第一个穿搭来建立风格库",
    try_different: "尝试不同的关键词",
    scan_outfit: "扫描穿搭",
    no_saved: "暂无保存的商品",
    heart_items: "从扫描中点赞商品来保存到这里",
    search_people: "搜索用户...",
    no_users_found: "未找到用户",
    type_to_search: "输入名字搜索",
    view_results: "查看完整结果",
    shop: "购买",
    search_google: "在Google Shopping搜索",
    no_match: "未找到精确匹配",
    original: "正品",
    resale: "二手",
    take_photo: "拍照或上传穿搭",
    upload: "上传",
    camera: "相机",
    for_you: "推荐",
    trending: "热门",
    discover: "发现",
    load_more: "加载更多",
    continue_google: "使用Google继续",
    continue_apple: "使用Apple继续",
    create_account: "创建账号",
    log_in: "登录",
    full_name: "全名",
    email: "邮箱地址",
    password: "密码",
    phone_optional: "手机号（可选）",
    get_started: "开始使用",
    maybe_later: "以后再说",
    upgrade_to_pro: "升级到Pro",
    go_pro: "升级 Pro",
    appearance: "外观",
    dark: "深色",
    light: "浅色",
    budget_range: "预算范围",
    size_preferences: "尺码偏好",
    not_set: "未设置",
    subscription: "订阅",
    free: "免费",
    upgrade_to_pro: "升级到 Pro",
    notifications: "通知",
    enable_push: "启用推送通知",
    push_enabled: "推送通知已启用",
    follow_up_reminders: "后续提醒",
    nudge_desc: "如果我忘记查看结果，请提醒我",
    style_twins_notif: "风格双胞胎",
    style_twins_desc: "每周\"发现新风格双胞胎\"提醒",
    refer_friend: "邀请好友",
    refer_desc: "分享你的代码，你们都将获得5美元的奖励。",
    my_scans: "我的扫描",
    wardrobe: "衣橱",
    scan_an_outfit: "扫描穿搭",
    no_scans_yet: "暂无扫描",
    no_scans_match: "没有匹配的扫描",
    all_filter: "全部",
    my_picks: "我的精选",
    all_scans: "所有扫描",
    search_scans: "搜索扫描...",
    outfits: "穿搭",
    all_items: "所有单品",
    no_outfits_saved: "暂无保存的穿搭",
    save_items_desc: "保存扫描中的单品来搭配完整穿搭",
    edit_profile: "编辑资料",
    save_bio: "保存",
    cancel: "取消",
    scans_stat: "扫描",
    complete_look_btn: "完善穿搭",
    finding_pieces: "正在寻找搭配单品...",
    save_budget: "保存预算",
    budget_save_error: "保存失败，请重试。",
    budget_min_label: "最低",
    budget_max_label: "最高",
    budget_tier_under50: "$ $50以下",
    budget_tier_mid: "$$ $50–150",
    budget_tier_high: "$$$ $150–500",
    budget_tier_premium: "$$$$ $500+",
    saving: "保存中...",
    confirm_language: "更改语言？",
    confirm_language_desc: "将语言更改为",
    confirm_btn: "确认",
    cancel_btn: "取消",
    men: "男士",
    women: "女士",
    tops: "上装",
    bottoms_waist: "腰围",
    bottoms_length: "裤长",
    shoes: "鞋子",
    dresses: "连衣裙",
    size_prefs_title: "尺码偏好",
    select_gender: "选择性别",
    save_sizes: "保存尺码",
    no_followers_yet: "暂无粉丝",
    no_following_yet: "暂未关注任何人",
  },
  ja: {
    home: "ホーム",
    scan: "スキャン",
    history: "履歴",
    saved: "保存済み",
    profile: "プロフィール",
    new_scan: "新規スキャン",
    analyzing: "コーデを分析中...",
    searching: "検索中...",
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
    search_notes_placeholder: "検索メモ（例：'サステナブルブランド'、'リネン素材'）...",
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
    loading: "読み込み中...",
    saving: "保存中...",
    cancel: "キャンセル",
    confirm: "確認",
    done: "完了",
    save_btn: "保存",
    not_set: "未設定",
    appearance: "表示",
    dark: "ダーク",
    light: "ライト",
    budget_range: "予算範囲",
    size_preferences: "サイズ設定",
    subscription: "サブスクリプション",
    free: "無料",
    notifications: "通知",
    enable_push: "プッシュ通知を有効にする",
    push_enabled: "プッシュ通知が有効です",
    followup_reminders: "フォローアップリマインダー",
    followup_desc: "結果の確認を忘れた場合にリマインド",
    style_twins_notif: "スタイルツイン",
    style_twins_desc: "毎週「新しいスタイルツイン発見」アラート",
    refer_friend: "友達を紹介",
    refer_desc: "コードを共有。2人とも$5のクレジットをゲット。",
    size_prefs_title: "サイズ設定",
    size_prefs_sub: "より良いおすすめのためにサイズを設定してください。",
    men: "メンズ",
    women: "レディース",
    tops: "トップス",
    bottoms_waist: "ボトムス (ウエスト)",
    bottoms_length: "ボトムス (丈)",
    shoes_label: "シューズ",
    dresses: "ドレス",
    save_sizes: "サイズを保存",
    change_language_confirm: "言語を変更しますか？",
    change_language_desc: "アプリの言語が更新されます。",
    scans_label: "スキャン",
    edit_profile: "プロフィール編集",
    style_dna: "スタイルDNA",
    hanger_test: "ハンガーテスト",
    tell_style: "あなたのスタイルを教えてください...",
    no_followers: "まだフォロワーがいません",
    no_following: "まだ誰もフォローしていません",
    my_scans: "マイスキャン",
    wardrobe: "ワードローブ",
    all: "すべて",
    my_picks: "マイピック",
    search_scans: "スキャンを検索...",
    no_scans_yet: "スキャンはまだありません",
    no_match_search: "検索に一致するスキャンがありません",
    scan_first: "最初のコーデをスキャンしてスタイルライブラリを構築",
    try_different: "別のキーワードを試してください",
    scan_outfit: "コーデをスキャン",
    no_saved: "保存アイテムなし",
    heart_items: "スキャンからアイテムにハートをつけて保存",
    search_people: "ユーザーを検索...",
    no_users_found: "ユーザーが見つかりません",
    type_to_search: "名前を入力して検索",
    view_results: "すべての結果を見る",
    shop: "購入",
    search_google: "Google Shoppingで検索",
    no_match: "完全一致なし",
    original: "オリジナル",
    resale: "リセール",
    take_photo: "写真を撮るか、コーデをアップロード",
    upload: "アップロード",
    camera: "カメラ",
    for_you: "おすすめ",
    trending: "トレンド",
    discover: "発見",
    load_more: "もっと読み込む",
    continue_google: "Googleで続ける",
    continue_apple: "Appleで続ける",
    create_account: "アカウント作成",
    log_in: "ログイン",
    full_name: "氏名",
    email: "メールアドレス",
    password: "パスワード",
    phone_optional: "電話番号（任意）",
    get_started: "はじめる",
    maybe_later: "後で",
    upgrade_to_pro: "Proにアップグレード",
    go_pro: "Proにする",
    appearance: "外観",
    dark: "ダーク",
    light: "ライト",
    budget_range: "予算範囲",
    size_preferences: "サイズ設定",
    not_set: "未設定",
    subscription: "サブスクリプション",
    free: "無料",
    upgrade_to_pro: "Proにアップグレード",
    notifications: "通知",
    enable_push: "プッシュ通知を有効にする",
    push_enabled: "プッシュ通知は有効です",
    follow_up_reminders: "フォローアップリマインダー",
    nudge_desc: "結果の確認を忘れた場合にリマインド",
    style_twins_notif: "スタイルツイン",
    style_twins_desc: "毎週の「新しいスタイルツイン発見」アラート",
    refer_friend: "友達を招待",
    refer_desc: "コードをシェアして、お互い$5のクレジットを獲得。",
    my_scans: "マイスキャン",
    wardrobe: "ワードローブ",
    scan_an_outfit: "コーデをスキャン",
    no_scans_yet: "スキャンはまだありません",
    no_scans_match: "検索に一致するスキャンがありません",
    all_filter: "すべて",
    my_picks: "マイピック",
    all_scans: "すべてのスキャン",
    search_scans: "スキャンを検索...",
    outfits: "コーデ",
    all_items: "すべてのアイテム",
    no_outfits_saved: "保存されたコーデはありません",
    save_items_desc: "スキャンからアイテムを保存してコーデを完成させましょう",
    edit_profile: "プロフィール編集",
    save_bio: "保存",
    cancel: "キャンセル",
    scans_stat: "スキャン",
    complete_look_btn: "コーデを完成させる",
    finding_pieces: "コーディネートアイテムを検索中...",
    save_budget: "予算を保存",
    budget_save_error: "保存に失敗しました。もう一度お試しください。",
    budget_min_label: "最小",
    budget_max_label: "最大",
    budget_tier_under50: "$ $50以下",
    budget_tier_mid: "$$ $50〜150",
    budget_tier_high: "$$$ $150〜500",
    budget_tier_premium: "$$$$ $500+",
    saving: "保存中...",
    confirm_language: "言語を変更しますか？",
    confirm_language_desc: "言語を変更:",
    confirm_btn: "確認",
    cancel_btn: "キャンセル",
    men: "メンズ",
    women: "レディース",
    tops: "トップス",
    bottoms_waist: "ウエスト",
    bottoms_length: "股下",
    shoes: "シューズ",
    dresses: "ドレス",
    size_prefs_title: "サイズ設定",
    select_gender: "性別を選択",
    save_sizes: "サイズを保存",
    no_followers_yet: "フォロワーはまだいません",
    no_following_yet: "まだ誰もフォローしていません",
  },
  ko: {
    home: "홈",
    scan: "스캔",
    history: "기록",
    saved: "저장됨",
    profile: "프로필",
    new_scan: "새 스캔",
    analyzing: "스타일 분석 중...",
    searching: "검색 중...",
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
    search_notes_placeholder: "검색 메모 추가 (예: '지속가능 브랜드', '린넨 소재')...",
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
    loading: "로딩 중...",
    saving: "저장 중...",
    cancel: "취소",
    confirm: "확인",
    done: "완료",
    save_btn: "저장",
    not_set: "설정 안 됨",
    appearance: "외관",
    dark: "다크",
    light: "라이트",
    budget_range: "예산 범위",
    size_preferences: "사이즈 설정",
    subscription: "구독",
    free: "무료",
    notifications: "알림",
    enable_push: "푸시 알림 활성화",
    push_enabled: "푸시 알림이 활성화되었습니다",
    followup_reminders: "후속 알림",
    followup_desc: "결과 확인을 잊으면 알려주세요",
    style_twins_notif: "스타일 트윈",
    style_twins_desc: "주간 '새로운 스타일 트윈 발견' 알림",
    refer_friend: "친구 추천",
    refer_desc: "코드를 공유하세요. 둘 다 $5 크레딧을 받습니다.",
    size_prefs_title: "사이즈 설정",
    size_prefs_sub: "더 나은 추천을 위해 사이즈를 설정하세요.",
    men: "남성",
    women: "여성",
    tops: "상의",
    bottoms_waist: "하의 (허리)",
    bottoms_length: "하의 (길이)",
    shoes_label: "신발",
    dresses: "드레스",
    save_sizes: "사이즈 저장",
    change_language_confirm: "언어를 변경하시겠습니까?",
    change_language_desc: "앱 언어가 업데이트됩니다.",
    scans_label: "스캔",
    edit_profile: "프로필 편집",
    style_dna: "스타일 DNA",
    hanger_test: "옷걸이 테스트",
    tell_style: "당신의 스타일을 알려주세요...",
    no_followers: "아직 팔로워가 없습니다",
    no_following: "아직 아무도 팔로우하지 않았습니다",
    my_scans: "내 스캔",
    wardrobe: "옷장",
    all: "전체",
    my_picks: "내 선택",
    search_scans: "스캔 검색...",
    no_scans_yet: "아직 스캔이 없습니다",
    no_match_search: "검색과 일치하는 스캔이 없습니다",
    scan_first: "첫 번째 아웃핏을 스캔하여 스타일 라이브러리를 만드세요",
    try_different: "다른 키워드를 시도해 보세요",
    scan_outfit: "아웃핏 스캔",
    no_saved: "저장된 아이템 없음",
    heart_items: "스캔에서 아이템에 하트를 눌러 여기에 저장하세요",
    search_people: "사람 검색...",
    no_users_found: "사용자를 찾을 수 없습니다",
    type_to_search: "이름을 입력하여 검색",
    view_results: "전체 결과 보기",
    shop: "구매",
    search_google: "Google Shopping에서 검색",
    no_match: "정확한 일치 항목 없음",
    original: "정품",
    resale: "중고",
    take_photo: "사진을 찍거나 아웃핏을 업로드하세요",
    upload: "업로드",
    camera: "카메라",
    for_you: "추천",
    trending: "인기",
    discover: "발견",
    load_more: "더 보기",
    continue_google: "Google로 계속",
    continue_apple: "Apple로 계속",
    create_account: "계정 만들기",
    log_in: "로그인",
    full_name: "전체 이름",
    email: "이메일 주소",
    password: "비밀번호",
    phone_optional: "전화번호 (선택)",
    get_started: "시작하기",
    maybe_later: "나중에",
    upgrade_to_pro: "Pro로 업그레이드",
    go_pro: "Pro로 업그레이드",
    appearance: "외관",
    dark: "다크",
    light: "라이트",
    budget_range: "예산 범위",
    size_preferences: "사이즈 설정",
    not_set: "미설정",
    subscription: "구독",
    free: "무료",
    upgrade_to_pro: "Pro로 업그레이드",
    notifications: "알림",
    enable_push: "푸시 알림 활성화",
    push_enabled: "푸시 알림이 활성화됨",
    follow_up_reminders: "후속 알림",
    nudge_desc: "결과 확인을 잊으면 알려주세요",
    style_twins_notif: "스타일 트윈",
    style_twins_desc: "매주 \"새로운 스타일 트윈 발견\" 알림",
    refer_friend: "친구 초대",
    refer_desc: "코드를 공유하면 둘 다 $5 크레딧을 받습니다.",
    my_scans: "내 스캔",
    wardrobe: "옷장",
    scan_an_outfit: "스타일 스캔",
    no_scans_yet: "스캔 없음",
    no_scans_match: "검색과 일치하는 스캔이 없습니다",
    all_filter: "전체",
    my_picks: "내 선택",
    all_scans: "모든 스캔",
    search_scans: "스캔 검색...",
    outfits: "코디",
    all_items: "모든 아이템",
    no_outfits_saved: "저장된 코디 없음",
    save_items_desc: "스캔에서 아이템을 저장하여 완성된 코디를 만드세요",
    edit_profile: "프로필 편집",
    save_bio: "저장",
    cancel: "취소",
    scans_stat: "스캔",
    complete_look_btn: "룩 완성하기",
    finding_pieces: "코디 아이템 검색 중...",
    save_budget: "예산 저장",
    budget_save_error: "저장에 실패했습니다. 다시 시도해 주세요.",
    budget_min_label: "최소",
    budget_max_label: "최대",
    budget_tier_under50: "$ $50 미만",
    budget_tier_mid: "$$ $50–150",
    budget_tier_high: "$$$ $150–500",
    budget_tier_premium: "$$$$ $500+",
    saving: "저장 중...",
    confirm_language: "언어를 변경하시겠습니까?",
    confirm_language_desc: "다음으로 언어 변경:",
    confirm_btn: "확인",
    cancel_btn: "취소",
    men: "남성",
    women: "여성",
    tops: "상의",
    bottoms_waist: "허리",
    bottoms_length: "길이",
    shoes: "신발",
    dresses: "드레스",
    size_prefs_title: "사이즈 설정",
    select_gender: "성별 선택",
    save_sizes: "사이즈 저장",
    no_followers_yet: "아직 팔로워가 없습니다",
    no_following_yet: "아직 아무도 팔로우하지 않았습니다",
  },
  pt: {
    home: "Inicio",
    scan: "Escanear",
    history: "Histórico",
    saved: "Salvos",
    profile: "Perfil",
    new_scan: "Novo scan",
    analyzing: "Analisando o look...",
    searching: "Pesquisando na web...",
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
    search_notes_placeholder: "Notas de busca (ex: 'marcas sustentáveis', 'tecido linho')...",
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
    loading: "Carregando...",
    saving: "Salvando...",
    cancel: "Cancelar",
    confirm: "Confirmar",
    done: "Pronto",
    save_btn: "Salvar",
    not_set: "Não definido",
    appearance: "Aparência",
    dark: "Escuro",
    light: "Claro",
    budget_range: "Faixa de orçamento",
    size_preferences: "Preferências de tamanho",
    subscription: "Assinatura",
    free: "Grátis",
    notifications: "Notificações",
    enable_push: "Ativar notificações push",
    push_enabled: "Notificações push ativadas",
    followup_reminders: "Lembretes de acompanhamento",
    followup_desc: "Me lembrar se eu esquecer de verificar meus resultados",
    style_twins_notif: "Gêmeos de estilo",
    style_twins_desc: "Alertas semanais de novos gêmeos de estilo",
    refer_friend: "Indicar um amigo",
    refer_desc: "Compartilhe seu código. Ambos ganham $5 de crédito.",
    size_prefs_title: "Preferências de tamanho",
    size_prefs_sub: "Defina seus tamanhos para melhores recomendações.",
    men: "Masculino",
    women: "Feminino",
    tops: "Blusas",
    bottoms_waist: "Calças (Cintura)",
    bottoms_length: "Calças (Comprimento)",
    shoes_label: "Calçados",
    dresses: "Vestidos",
    save_sizes: "Salvar tamanhos",
    change_language_confirm: "Mudar idioma?",
    change_language_desc: "O idioma do app será atualizado.",
    scans_label: "Scans",
    edit_profile: "Editar perfil",
    style_dna: "DNA de estilo",
    hanger_test: "Teste do cabide",
    tell_style: "Conte às pessoas sobre seu estilo...",
    no_followers: "Nenhum seguidor ainda",
    no_following: "Não segue ninguém ainda",
    my_scans: "Meus scans",
    wardrobe: "Guarda-roupa",
    all: "Todos",
    my_picks: "Minhas escolhas",
    search_scans: "Pesquisar scans...",
    no_scans_yet: "Nenhum scan ainda",
    no_match_search: "Nenhum scan corresponde à sua pesquisa",
    scan_first: "Escaneie seu primeiro look para criar sua biblioteca de estilo",
    try_different: "Tente palavras-chave diferentes",
    scan_outfit: "Escanear um look",
    no_saved: "Nenhum item salvo",
    heart_items: "Curta itens dos seus scans para salvá-los aqui",
    search_people: "Pesquisar pessoas...",
    no_users_found: "Nenhum usuário encontrado",
    type_to_search: "Digite um nome para pesquisar",
    view_results: "Ver todos os resultados",
    shop: "Comprar",
    search_google: "Pesquisar no Google Shopping",
    no_match: "Nenhuma correspondência exata",
    original: "ORIGINAL",
    resale: "REVENDA",
    take_photo: "Tire uma foto ou envie um look",
    upload: "Enviar",
    camera: "Câmera",
    for_you: "Para você",
    trending: "Em alta",
    discover: "Descobrir",
    load_more: "Carregar mais",
    continue_google: "Continuar com Google",
    continue_apple: "Continuar com Apple",
    create_account: "Criar conta",
    log_in: "Entrar",
    full_name: "Nome completo",
    email: "Endereço de e-mail",
    password: "Senha",
    phone_optional: "Telefone (opcional)",
    get_started: "Começar",
    maybe_later: "Talvez depois",
    upgrade_to_pro: "Atualizar para Pro",
    go_pro: "Ir Pro",
    appearance: "Aparência",
    dark: "Escuro",
    light: "Claro",
    budget_range: "Faixa de orçamento",
    size_preferences: "Preferências de tamanho",
    not_set: "Não definido",
    subscription: "Assinatura",
    free: "Grátis",
    upgrade_to_pro: "Assinar Pro",
    notifications: "Notificações",
    enable_push: "Ativar notificações push",
    push_enabled: "Notificações push estão ativadas",
    follow_up_reminders: "Lembretes de acompanhamento",
    nudge_desc: "Me lembre se eu esquecer de verificar meus resultados",
    style_twins_notif: "Style Twins",
    style_twins_desc: "Alertas semanais de \"novos gêmeos de estilo\"",
    refer_friend: "Indicar um amigo",
    refer_desc: "Compartilhe seu código. Vocês dois ganham $5 de crédito.",
    my_scans: "Meus scans",
    wardrobe: "Guarda-roupa",
    scan_an_outfit: "Escanear um outfit",
    no_scans_yet: "Nenhum scan ainda",
    no_scans_match: "Nenhum scan corresponde à sua busca",
    all_filter: "Todos",
    my_picks: "Meus favoritos",
    all_scans: "Todos os scans",
    search_scans: "Buscar scans...",
    outfits: "Looks",
    all_items: "Todos os itens",
    no_outfits_saved: "Nenhum look salvo ainda",
    save_items_desc: "Salve itens dos seus scans para montar looks completos",
    edit_profile: "Editar perfil",
    save_bio: "Salvar",
    cancel: "Cancelar",
    scans_stat: "Scans",
    complete_look_btn: "Completar o Look",
    finding_pieces: "Buscando peças complementares...",
    save_budget: "Salvar orçamento",
    budget_save_error: "Falha ao salvar. Tente novamente.",
    budget_min_label: "MÍN",
    budget_max_label: "MÁX",
    budget_tier_under50: "$ Menos de $50",
    budget_tier_mid: "$$ $50–150",
    budget_tier_high: "$$$ $150–500",
    budget_tier_premium: "$$$$ $500+",
    saving: "Salvando...",
    confirm_language: "Mudar idioma?",
    confirm_language_desc: "Mudar idioma para",
    confirm_btn: "Confirmar",
    cancel_btn: "Cancelar",
    men: "Masculino",
    women: "Feminino",
    tops: "Blusas",
    bottoms_waist: "Cintura",
    bottoms_length: "Comprimento",
    shoes: "Sapatos",
    dresses: "Vestidos",
    size_prefs_title: "Preferências de tamanho",
    select_gender: "Selecione o gênero",
    save_sizes: "Salvar tamanhos",
    no_followers_yet: "Nenhum seguidor ainda",
    no_following_yet: "Não está seguindo ninguém ainda",
  },
};

// ═══════════════════════════════════════════════════════════════
// ONBOARDING
// ═══════════════════════════════════════════════════════════════
const OB_STEPS = [
  { id: "welcome", type: "info", icon: "✦", title: "Scan any outfit.\nFind where to buy it.", sub: "Upload any outfit photo. Our AI identifies every piece and finds you budget, mid, and premium options instantly.", cta: "Get Started" },
];

// Demo data for TikTok-speed onboarding animation
const OB_DEMO_ITEMS = [
  { emoji: "👕", name: "Cotton Crewneck Tee", color: "White", price: "$28" },
  { emoji: "👖", name: "Slim Straight Jeans", color: "Indigo", price: "$65" },
  { emoji: "👟", name: "Leather Sneakers", color: "White", price: "$95" },
];
const OB_DEMO_RESULTS = [
  { tier: "budget", store: "H&M", price: "$19", name: "Basic Cotton Tee" },
  { tier: "mid", store: "Everlane", price: "$35", name: "Premium Weight Tee" },
  { tier: "premium", store: "APC", price: "$95", name: "Petit New Standard" },
];

// ═══════════════════════════════════════════════════════════════
// INSPIRATION DATA — Gender-adaptive celebrity/influencer grid
// ═══════════════════════════════════════════════════════════════
const STYLE_AESTHETICS = [
  { name: "Minimalist", desc: "Clean lines, neutrals, less is more" },
  { name: "Streetwear", desc: "Urban edge, sneakers, graphic pieces" },
  { name: "Old Money", desc: "Classic, preppy, timeless polish" },
  { name: "Quiet Luxury", desc: "Understated, quality over logos" },
  { name: "Y2K", desc: "Early 2000s revival, bold & playful" },
  { name: "Coastal", desc: "Breezy, natural, effortless" },
  { name: "Avant-Garde", desc: "Experimental, editorial, boundary-pushing" },
  { name: "Athleisure", desc: "Sport meets street, performance comfort" },
  { name: "Vintage", desc: "Retro finds, thrift treasures" },
  { name: "Dark Academia", desc: "Scholarly, moody, layered" },
  { name: "Gorpcore", desc: "Outdoor tech meets everyday wear" },
  { name: "Cottagecore", desc: "Romantic, pastoral, soft textures" },
];

// ═══════════════════════════════════════════════════════════════
// ONBOARDING DEMO — TikTok-speed animated welcome
// ═══════════════════════════════════════════════════════════════
function OnboardingDemo({ fade, onGetStarted, onLogin }) {
  const [demoPhase, setDemoPhase] = useState(0); // 0=photo, 1=scanning, 2=items, 3=results, 4=fade-out
  const [cycleKey, setCycleKey] = useState(0);
  const [stats, setStats] = useState(null);

  useEffect(() => {
    API.getStats().then(setStats).catch(() => {});
  }, []);

  useEffect(() => {
    const timings = [1200, 1000, 1200, 1800, 600]; // ms per phase (last = fade-out before reset)
    const timer = setTimeout(() => {
      setDemoPhase(p => {
        if (p >= 4) {
          setCycleKey(k => k + 1);
          return 0;
        }
        return p + 1;
      });
    }, timings[demoPhase]);
    return () => clearTimeout(timer);
  }, [demoPhase, cycleKey]);

  return (
    <div className={`ob ob-demo ${fade}`}>
      {/* Logo pinned to top */}
      <img src="/logo-dark.svg" alt="ATTAIRE" style={{ display: "block", margin: "0 auto", paddingTop: 16, width: "60%", maxWidth: 220, height: "auto" }} />
      <h2 style={{ textAlign: "center", margin: "12px 0 4px", fontSize: 18, fontWeight: 600, letterSpacing: 1.5, color: "#FAFAFA" }}>
        See it. Scan it. <span style={{ color: "#C9A96E" }}>Shop it.</span>
      </h2>
      {/* Animated demo viewport */}
      <div className="ob-demo-viewport">
        {/* Mock phone frame */}
        <div className="ob-demo-phone" style={{ opacity: demoPhase === 4 ? 0 : 1, transition: "opacity 0.5s ease" }}>
          {/* Phase 0-1: Outfit photo with gradient */}
          <div className="ob-demo-photo" style={{ opacity: 1 }}>
            <img
              src="https://images.unsplash.com/photo-1600880292203-757bb62b4baf?w=400&h=700&fit=crop&crop=center"
              alt="Outfit: white tee, jeans, sneakers"
              style={{ width: "100%", height: "100%", objectFit: "cover", position: "absolute", inset: 0, borderRadius: "inherit" }}
            />

            {/* Phase 1: Scanning laser line */}
            <div key={cycleKey} className={`ob-demo-scan-line ${demoPhase >= 1 && demoPhase < 4 ? "active" : ""}`} />

            {/* Phase 2: Item labels pop in */}
            <div className="ob-demo-items">
              {OB_DEMO_ITEMS.map((item, i) => (
                <div
                  key={i}
                  className={`ob-demo-item-tag ${demoPhase >= 2 && demoPhase < 4 ? "visible" : ""}`}
                  style={{ transitionDelay: `${i * 150}ms`, top: `${18 + i * 28}%` }}
                >
                  <span className="ob-demo-item-emoji">{item.emoji}</span>
                  <span className="ob-demo-item-name">{item.name}</span>
                  <span className="ob-demo-item-check">✓</span>
                </div>
              ))}
            </div>
          </div>

          {/* Phase 3: Results cards slide up */}
          <div className={`ob-demo-results ${demoPhase >= 3 && demoPhase < 4 ? "visible" : ""}`}>
            <div className="ob-demo-results-header">
              <span className="ob-demo-results-dot" />
              Products found
            </div>
            {OB_DEMO_RESULTS.map((r, i) => (
              <div
                key={i}
                className={`ob-demo-result-card ${demoPhase >= 3 && demoPhase < 4 ? "visible" : ""}`}
                style={{ transitionDelay: `${i * 120}ms` }}
              >
                <div className={`ob-demo-tier-badge ob-demo-tier-${r.tier}`}>{r.tier}</div>
                <div className="ob-demo-result-info">
                  <div className="ob-demo-result-name">{r.name}</div>
                  <div className="ob-demo-result-store">{r.store}</div>
                </div>
                <div className="ob-demo-result-price">{r.price}</div>
              </div>
            ))}
          </div>
        </div>

        {/* Phase indicator dots */}
        <div className="ob-demo-dots">
          {["Photo", "Scan", "Identify", "Shop"].map((label, i) => (
            <div key={i} className={`ob-demo-dot ${demoPhase >= i && demoPhase < 4 ? "active" : ""}`}>
              <div className="ob-demo-dot-circle" />
              <span className="ob-demo-dot-label">{label}</span>
            </div>
          ))}
        </div>
      </div>

      {/* CTA section */}
      <div className="ob-demo-cta">
        <h1 className="ob-demo-title">
          Your AI-powered<br /><span className="ob-demo-title-gold">style assistant.</span>
        </h1>
        <p className="ob-demo-sub">
          Scan any outfit. Find every piece. Shop at any budget — solo or with friends.
        </p>
        <button className="cta" onClick={onGetStarted}>Get Started</button>
        <button className="ob-demo-login" onClick={onLogin}>
          Already have an account? Log in
        </button>
      </div>

      {/* Social proof bar */}
      {stats && (
        <div className="ob-social-proof">
          {stats.total_scans > 0 && (
            <div className="ob-social-stat">
              <span className="ob-social-stat-n">{stats.total_scans.toLocaleString()}+</span>
              <span className="ob-social-stat-l">outfits scanned</span>
            </div>
          )}
          {stats.recent_scans?.length > 0 && (
            <div className="ob-social-carousel">
              {stats.recent_scans.map((scan) => (
                <div key={scan.id} className="ob-social-scan">
                  <img src={scan.image_url} alt="" className="ob-social-scan-img" loading="lazy" />
                  <div className="ob-social-scan-count">{scan.item_count} items</div>
                </div>
              ))}
            </div>
          )}
          <div className="ob-social-trust">Trusted by style hunters everywhere</div>
        </div>
      )}

      {/* Social links */}
      <div style={{ display: "flex", justifyContent: "center", gap: 20, padding: "16px 0 24px" }}>
        {[
          { label: "Instagram", href: "https://instagram.com/attaire.app", path: "M7.8 2h8.4C19.4 2 22 4.6 22 7.8v8.4a5.8 5.8 0 0 1-5.8 5.8H7.8C4.6 22 2 19.4 2 16.2V7.8A5.8 5.8 0 0 1 7.8 2m-.2 2A3.6 3.6 0 0 0 4 7.6v8.8C4 18.39 5.61 20 7.6 20h8.8a3.6 3.6 0 0 0 3.6-3.6V7.6C20 5.61 18.39 4 16.4 4H7.6m9.65 1.5a1.25 1.25 0 1 1 0 2.5 1.25 1.25 0 0 1 0-2.5M12 7a5 5 0 1 1 0 10 5 5 0 0 1 0-10m0 2a3 3 0 1 0 0 6 3 3 0 0 0 0-6" },
          { label: "TikTok", href: "https://tiktok.com/@attaire.app", path: "M16.6 5.82s.51.64 1.62 1.13c.73.33 1.57.48 2.28.51v3.34s-1.16-.04-2.26-.46c-.75-.28-1.26-.65-1.26-.65s-.03 3.35-.03 4.8c0 1.34-.35 2.76-1.34 3.87-1.1 1.24-2.53 1.83-3.98 1.87-1.78.05-3.44-.77-4.39-2.15a5.27 5.27 0 0 1 3.08-7.9c.67-.15 1.35-.14 1.99-.02v3.42a2.34 2.34 0 0 0-1.6.39 2.3 2.3 0 0 0-.73 2.63c.36.84 1.2 1.38 2.15 1.34.94-.04 1.7-.63 2-1.48.1-.3.13-.63.13-1.01V2h3.3s-.06 1.53.04 2.2c.14.92.61 1.62.61 1.62" },
          { label: "X", href: "https://x.com/attaireapp", path: "M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" },
        ].map(({ label, href, path }) => (
          <a key={label} href={href} target="_blank" rel="noopener noreferrer" aria-label={label}
            style={{ width: 36, height: 36, display: "flex", alignItems: "center", justifyContent: "center", borderRadius: "50%", border: "1px solid rgba(255,255,255,.15)", background: "rgba(255,255,255,.05)", transition: "background .2s" }}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="rgba(255,255,255,.6)"><path d={path} /></svg>
          </a>
        ))}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// INSPIRATION PICKER — "Who inspires your style?"
// ═══════════════════════════════════════════════════════════════
function InspirationPicker({ fade, onContinue, onSkip }) {
  const [shopFor, setShopFor] = useState(null); // "women" | "men" | "both"
  const [selected, setSelected] = useState([]);

  const toggle = (name) => {
    setSelected(prev =>
      prev.includes(name) ? prev.filter(n => n !== name) : [...prev, name]
    );
  };

  const handleContinue = () => {
    localStorage.setItem("attair_inspirations", JSON.stringify(selected));
    if (shopFor) localStorage.setItem("attair_ob_gender", shopFor === "women" ? "female" : shopFor === "men" ? "male" : "both");
    onContinue(selected, shopFor === "women" ? "female" : shopFor === "men" ? "male" : null);
  };

  return (
    <div className={`ob ob-inspo ${fade}`}>
      <div className="ob-inspo-header">
        <h1 className="ob-inspo-title">What's your<br />style vibe?</h1>
        <p className="ob-inspo-sub">Pick 3 or more aesthetics. We'll tailor your experience.</p>
      </div>

      {/* Shopping preference */}
      <div className="ob-inspo-gender">
        {[{ key: "women", label: "Women's" }, { key: "men", label: "Men's" }, { key: "both", label: "Both" }].map(({ key, label }) => (
          <button
            key={key}
            className={`ob-inspo-gender-btn ${shopFor === key ? "active" : ""}`}
            onClick={() => setShopFor(key)}
          >
            {label}
          </button>
        ))}
      </div>

      {/* Aesthetics grid */}
      <div className="ob-inspo-grid">
        {STYLE_AESTHETICS.map((aesthetic) => {
          const on = selected.includes(aesthetic.name);
          return (
            <button
              key={aesthetic.name}
              className={`ob-inspo-card ${on ? "selected" : ""}`}
              onClick={() => toggle(aesthetic.name)}
            >
              <div className="ob-inspo-card-name">{aesthetic.name}</div>
              <div className="ob-inspo-card-tag">{aesthetic.desc}</div>
              {on && <div className="ob-inspo-card-check">✓</div>}
            </button>
          );
        })}
      </div>

      {/* Bottom CTA */}
      <div className="ob-inspo-footer">
        <button
          className="cta"
          style={{ opacity: selected.length < 3 ? 0.5 : 1 }}
          onClick={handleContinue}
          disabled={selected.length < 3}
        >
          {selected.length === 0
            ? "Pick at least 3"
            : selected.length < 3
            ? `${3 - selected.length} more to go`
            : `Continue with ${selected.length} picks`}
        </button>
        <button className="ob-inspo-skip" onClick={() => { localStorage.setItem("attair_inspirations", "[]"); onSkip(); }}>
          Skip for now
        </button>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// FEATURED SCANS — Empty feed state with real public scans
// ═══════════════════════════════════════════════════════════════
function FeaturedScansEmpty({ onScan, onDiscover }) {
  const [featured, setFeatured] = useState([]);

  useEffect(() => {
    API.getStats().then(data => {
      if (data.recent_scans?.length > 0) setFeatured(data.recent_scans);
    }).catch(() => {});
  }, []);

  return (
    <div className="animate-slide-up" style={{ padding: "0 16px 100px" }}>
      {/* Header */}
      <div style={{ padding: "20px 0 14px", display: "flex", alignItems: "center", gap: 8 }}>
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>
        <span style={{ fontSize: 15, fontWeight: 700, color: "var(--text-primary)", letterSpacing: 0.3 }}>Trending on ATTAIRE</span>
      </div>

      {/* Real scans from community */}
      {featured.length > 0 ? (
        <div className="feed-list" style={{ padding: 0 }}>
          {featured.map((scan, idx) => (
            <div key={scan.id} className="feed-card card-enter" style={{ animationDelay: `${idx * 0.08}s` }}>
              <div style={{ position: "relative" }}>
                <img
                  src={scan.image_url}
                  alt={scan.summary || "Outfit scan"}
                  className="feed-card-img"
                  loading="lazy"
                  style={{ width: "100%", aspectRatio: "3/4", objectFit: "cover" }}
                />
                <div className="feed-card-overlay">
                  <div className="feed-card-user">
                    <div className="feed-card-avatar" style={{ background: "var(--accent)" }}>✦</div>
                    <div className="feed-card-info">
                      <div className="feed-card-name">ATTAIRE</div>
                      <div className="feed-card-summary">{scan.summary || `${scan.item_count} items found`}</div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div style={{ textAlign: "center", padding: "40px 16px" }}>
          <div style={{ fontSize: 36, marginBottom: 12 }}>📸</div>
          <div style={{ fontSize: 15, fontWeight: 600, color: "var(--text-primary)", marginBottom: 6 }}>Be the first to scan</div>
          <div style={{ fontSize: 13, color: "var(--text-tertiary)", lineHeight: 1.5 }}>Scan an outfit to see it show up in the community feed.</div>
        </div>
      )}

      {/* CTA row */}
      <div style={{ display: "flex", gap: 10, padding: "24px 0 0" }}>
        <button className="btn-primary" onClick={onScan} style={{ flex: 1, borderRadius: 100, minHeight: 48 }}>Scan an outfit</button>
        <button className="btn-secondary" onClick={onDiscover} style={{ flex: 1, borderRadius: 100, minHeight: 48 }}>Discover people</button>
      </div>
    </div>
  );
}

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
  ctx.fillText("ATTAIR", 540, 1800);
  ctx.fillStyle = "rgba(201,169,110,0.5)";
  ctx.font = "400 24px 'Outfit', system-ui";
  ctx.fillText("AI Fashion Scanner", 540, 1850);

  return canvas.toDataURL("image/png");
}

// ═══════════════════════════════════════════════════════════════
// SCAN-TO-REEL VIDEO GENERATOR — Canvas + MediaRecorder (5s, 9:16)
// Optimized for TikTok/Reels. Pro-only feature.
// ═══════════════════════════════════════════════════════════════
async function generateScanReel({ imageUrl, summary, items, verdict, userName }) {
  const W = 1080, H = 1920, FPS = 30, DURATION = 5;
  const TOTAL_FRAMES = FPS * DURATION;
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d");

  // Pre-load outfit image
  let outfitImg = null;
  try {
    outfitImg = new Image();
    outfitImg.crossOrigin = "anonymous";
    await new Promise((resolve, reject) => {
      outfitImg.onload = resolve;
      outfitImg.onerror = reject;
      outfitImg.src = imageUrl;
    });
  } catch { outfitImg = null; }

  // Prepare items data (max 4 for the reel)
  const reelItems = (items || []).slice(0, 4).map(it => ({
    name: it.name || it.category || "Item",
    brand: it.tiers?.mid?.brand || it.tiers?.budget?.brand || it.tiers?.premium?.brand || "",
    price: it.tiers?.mid?.price || it.tiers?.budget?.price || it.tiers?.premium?.price || "",
    category: it.category || "",
  }));

  // Color palette
  const GOLD = "#C9A96E";
  const GOLD_DIM = "rgba(201,169,110,0.5)";
  const BG_DARK = "#0C0C0E";
  const BG_CARD = "#1A1A1A";
  const WHITE = "#FFFFFF";
  const WHITE_60 = "rgba(255,255,255,0.6)";
  const WHITE_35 = "rgba(255,255,255,0.35)";

  // Verdict info
  const verdictLabels = { would_wear: "Would Wear", on_the_fence: "On the Fence", not_for_me: "Not for Me" };
  const verdictColors = { would_wear: "#4CAF50", on_the_fence: "#FFB74D", not_for_me: "#FF5252" };

  // Easing functions
  const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);
  const easeInOutCubic = (t) => t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
  const easeOutBack = (t) => { const c1 = 1.70158; const c3 = c1 + 1; return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2); };

  // Helper: draw rounded rect fill
  const roundRect = (x, y, w, h, r) => { ctx.beginPath(); ctx.roundRect(x, y, w, h, r); };

  // Helper: clamp 0–1
  const clamp01 = (v) => Math.max(0, Math.min(1, v));

  // Helper: word-wrap text, returns array of lines
  const wrapText = (text, maxWidth, font) => {
    ctx.font = font;
    const words = text.split(" ");
    const lines = [];
    let current = "";
    for (const word of words) {
      const test = current ? current + " " + word : word;
      if (ctx.measureText(test).width > maxWidth && current) {
        lines.push(current);
        current = word;
      } else {
        current = test;
      }
    }
    if (current) lines.push(current);
    return lines;
  };

  // ─── Frame renderer ────────────────────────────────────────
  const drawFrame = (frameIndex) => {
    const t = frameIndex / TOTAL_FRAMES; // 0 → 1 over 5 seconds
    const frameTime = frameIndex / FPS; // seconds

    // Clear
    ctx.clearRect(0, 0, W, H);

    // ─── Background ────────────────────────────────────────
    const grad = ctx.createLinearGradient(0, 0, 0, H);
    grad.addColorStop(0, BG_DARK);
    grad.addColorStop(0.5, "#111114");
    grad.addColorStop(1, BG_DARK);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, W, H);

    // Animated ambient gold glow behind photo
    const glowPulse = 0.5 + 0.5 * Math.sin(frameTime * 1.5);
    const glowGrad = ctx.createRadialGradient(W / 2, 600, 100, W / 2, 600, 500 + glowPulse * 80);
    glowGrad.addColorStop(0, `rgba(201,169,110,${0.04 + glowPulse * 0.02})`);
    glowGrad.addColorStop(1, "transparent");
    ctx.fillStyle = glowGrad;
    ctx.fillRect(0, 0, W, H);

    // Subtle animated particles (gold dust)
    ctx.save();
    for (let p = 0; p < 12; p++) {
      const px = (((p * 137.5 + frameTime * 30) % W) + W) % W;
      const py = (((p * 89.3 + frameTime * (15 + p * 3)) % H) + H) % H;
      const pAlpha = 0.08 + 0.06 * Math.sin(frameTime * 2 + p);
      const pSize = 1.5 + Math.sin(frameTime + p * 0.7) * 0.8;
      ctx.beginPath();
      ctx.arc(px, py, pSize, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(201,169,110,${pAlpha})`;
      ctx.fill();
    }
    ctx.restore();

    // ─── Phase 1 (0–1.2s): Photo reveal with scan line ────
    const photoRevealT = clamp01(frameTime / 0.8);
    const photoAlpha = easeOutCubic(photoRevealT);

    if (outfitImg) {
      const photoX = 80, photoY = 140, photoW = W - 160, photoH = 1000;
      ctx.save();
      ctx.globalAlpha = photoAlpha;

      // Photo container with shadow
      ctx.shadowColor = "rgba(0,0,0,0.5)";
      ctx.shadowBlur = 40;
      ctx.shadowOffsetY = 10;
      roundRect(photoX, photoY, photoW, photoH, 28);
      ctx.fillStyle = BG_CARD;
      ctx.fill();
      ctx.shadowColor = "transparent";

      // Clip and draw image
      ctx.beginPath();
      ctx.roundRect(photoX, photoY, photoW, photoH, 28);
      ctx.clip();
      const scale = Math.max(photoW / outfitImg.width, photoH / outfitImg.height);
      const sw = photoW / scale, sh = photoH / scale;
      const sx = (outfitImg.width - sw) / 2, sy = (outfitImg.height - sh) / 2;
      ctx.drawImage(outfitImg, sx, sy, sw, sh, photoX, photoY, photoW, photoH);

      // Gradient overlay at bottom of photo for text readability
      const photoGrad = ctx.createLinearGradient(0, photoY + photoH - 300, 0, photoY + photoH);
      photoGrad.addColorStop(0, "rgba(0,0,0,0)");
      photoGrad.addColorStop(1, "rgba(0,0,0,0.7)");
      ctx.fillStyle = photoGrad;
      ctx.fillRect(photoX, photoY + photoH - 300, photoW, 300);

      ctx.restore();

      // Scan line animation (0–1.5s)
      if (frameTime < 1.5) {
        const scanLineT = clamp01(frameTime / 1.2);
        const scanLineY = photoY + scanLineT * photoH;
        const scanGrad = ctx.createLinearGradient(photoX, 0, photoX + photoW, 0);
        scanGrad.addColorStop(0, "transparent");
        scanGrad.addColorStop(0.2, `rgba(201,169,110,${0.7 * (1 - scanLineT)})`);
        scanGrad.addColorStop(0.8, `rgba(201,169,110,${0.7 * (1 - scanLineT)})`);
        scanGrad.addColorStop(1, "transparent");
        ctx.fillStyle = scanGrad;
        ctx.fillRect(photoX, scanLineY - 1.5, photoW, 3);

        // Glow below scan line
        const scanGlow = ctx.createLinearGradient(0, scanLineY, 0, scanLineY + 40);
        scanGlow.addColorStop(0, `rgba(201,169,110,${0.15 * (1 - scanLineT)})`);
        scanGlow.addColorStop(1, "transparent");
        ctx.fillStyle = scanGlow;
        ctx.fillRect(photoX, scanLineY, photoW, 40);
      }

      // Gold border shimmer on photo
      if (photoAlpha > 0.5) {
        ctx.save();
        ctx.globalAlpha = 0.3 + 0.2 * Math.sin(frameTime * 3);
        ctx.strokeStyle = GOLD;
        ctx.lineWidth = 2;
        roundRect(photoX, photoY, photoW, photoH, 28);
        ctx.stroke();
        ctx.restore();
      }
    }

    // ─── Phase 2 (1.0–3.0s): Items slide in staggered ─────
    const itemBaseY = 1200;
    reelItems.forEach((item, i) => {
      const itemDelay = 1.0 + i * 0.35;
      const itemT = clamp01((frameTime - itemDelay) / 0.5);
      if (itemT <= 0) return;

      const eased = easeOutBack(itemT);
      const itemX = 80;
      const itemY = itemBaseY + i * 110;
      const itemW = W - 160;
      const itemH = 96;
      const slideX = (1 - eased) * -120;

      ctx.save();
      ctx.globalAlpha = easeOutCubic(itemT);
      ctx.translate(slideX, 0);

      // Item card background
      roundRect(itemX, itemY, itemW, itemH, 16);
      ctx.fillStyle = "rgba(255,255,255,0.04)";
      ctx.fill();
      ctx.strokeStyle = "rgba(255,255,255,0.06)";
      ctx.lineWidth = 1;
      ctx.stroke();

      // Gold accent bar on left
      roundRect(itemX, itemY + 12, 3, itemH - 24, 2);
      ctx.fillStyle = GOLD;
      ctx.fill();

      // Item name
      ctx.fillStyle = WHITE;
      ctx.font = "600 32px 'Outfit', system-ui";
      ctx.textAlign = "left";
      const displayName = item.name.length > 28 ? item.name.slice(0, 26) + "..." : item.name;
      ctx.fillText(displayName, itemX + 24, itemY + 40);

      // Brand + price row
      ctx.font = "400 24px 'Outfit', system-ui";
      ctx.fillStyle = WHITE_60;
      const brandText = item.brand ? item.brand : item.category;
      ctx.fillText(brandText.length > 24 ? brandText.slice(0, 22) + "..." : brandText, itemX + 24, itemY + 72);

      if (item.price) {
        const priceStr = typeof item.price === "number" ? `$${item.price}` : `${item.price}`;
        ctx.fillStyle = GOLD;
        ctx.font = "700 26px 'Outfit', system-ui";
        ctx.textAlign = "right";
        ctx.fillText(priceStr, itemX + itemW - 20, itemY + 56);
      }

      ctx.restore();
    });

    // ─── Phase 3 (2.5–4.0s): Summary + verdict ────────────
    const summaryDelay = 2.5;
    const summaryT = clamp01((frameTime - summaryDelay) / 0.6);

    if (summaryT > 0 && summary) {
      ctx.save();
      ctx.globalAlpha = easeOutCubic(summaryT);
      const summaryY = itemBaseY + reelItems.length * 110 + 30;

      // Summary text
      ctx.fillStyle = WHITE_60;
      ctx.font = "400 28px 'Outfit', system-ui";
      ctx.textAlign = "center";
      const lines = wrapText(summary.substring(0, 80), W - 200, "400 28px 'Outfit', system-ui");
      lines.forEach((line, li) => {
        ctx.fillText(line, W / 2, summaryY + li * 38);
      });

      ctx.restore();
    }

    // Verdict badge
    if (verdict && verdictLabels[verdict]) {
      const verdictDelay = 3.0;
      const verdictT = clamp01((frameTime - verdictDelay) / 0.5);
      if (verdictT > 0) {
        ctx.save();
        const verdictScale = easeOutBack(verdictT);
        const verdictY = itemBaseY + reelItems.length * 110 + (summary ? 100 : 30);

        ctx.globalAlpha = easeOutCubic(verdictT);
        ctx.textAlign = "center";

        // Pill background
        const pillText = verdictLabels[verdict];
        ctx.font = "bold 34px 'Outfit', system-ui";
        const pillW = ctx.measureText(pillText).width + 60;
        const pillX = W / 2 - pillW / 2;
        const pillH = 52;

        ctx.save();
        ctx.translate(W / 2, verdictY);
        ctx.scale(verdictScale, verdictScale);
        ctx.translate(-W / 2, -verdictY);

        roundRect(pillX, verdictY - 34, pillW, pillH, pillH / 2);
        ctx.fillStyle = (verdictColors[verdict] || GOLD) + "18";
        ctx.fill();
        ctx.strokeStyle = (verdictColors[verdict] || GOLD) + "44";
        ctx.lineWidth = 1.5;
        ctx.stroke();

        ctx.fillStyle = verdictColors[verdict] || GOLD;
        ctx.fillText(pillText, W / 2, verdictY);
        ctx.restore();

        ctx.restore();
      }
    }

    // ─── Phase 4 (3.5–5.0s): Branding + CTA ───────────────
    const brandDelay = 3.8;
    const brandT = clamp01((frameTime - brandDelay) / 0.6);

    if (brandT > 0) {
      ctx.save();
      ctx.globalAlpha = easeOutCubic(brandT);
      ctx.textAlign = "center";

      // ATTAIR logo
      ctx.fillStyle = GOLD;
      ctx.font = "bold 52px 'Outfit', system-ui";
      ctx.fillText("ATTAIR", W / 2, H - 160);

      // Tagline
      ctx.fillStyle = GOLD_DIM;
      ctx.font = "400 24px 'Outfit', system-ui";
      ctx.fillText("AI Fashion Scanner", W / 2, H - 110);

      // User attribution
      if (userName) {
        ctx.fillStyle = WHITE_35;
        ctx.font = "400 22px 'Outfit', system-ui";
        ctx.fillText(`Scanned by @${userName}`, W / 2, H - 70);
      }

      ctx.restore();
    }

    // ─── Persistent: top "ATTAIR" watermark ────────────────
    if (frameTime > 0.5) {
      const wmT = clamp01((frameTime - 0.5) / 0.4);
      ctx.save();
      ctx.globalAlpha = 0.35 * easeOutCubic(wmT);
      ctx.fillStyle = GOLD;
      ctx.font = "bold 28px 'Outfit', system-ui";
      ctx.textAlign = "left";
      ctx.fillText("ATTAIR", 80, 100);
      ctx.restore();
    }

    // ─── Persistent: item count badge (top right) ──────────
    if (frameTime > 0.8) {
      const badgeT = clamp01((frameTime - 0.8) / 0.3);
      ctx.save();
      ctx.globalAlpha = easeOutCubic(badgeT);
      const countText = `${items?.length || 0} items`;
      ctx.font = "600 22px 'Outfit', system-ui";
      const countW = ctx.measureText(countText).width + 32;
      roundRect(W - 80 - countW, 80, countW, 36, 18);
      ctx.fillStyle = "rgba(201,169,110,0.12)";
      ctx.fill();
      ctx.strokeStyle = "rgba(201,169,110,0.25)";
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.fillStyle = GOLD;
      ctx.textAlign = "center";
      ctx.fillText(countText, W - 80 - countW / 2, 104);
      ctx.restore();
    }

    // ─── Outro fade (4.5–5.0s) ─────────────────────────────
    if (frameTime > 4.6) {
      const fadeT = clamp01((frameTime - 4.6) / 0.4);
      ctx.fillStyle = `rgba(12,12,14,${fadeT * 0.3})`;
      ctx.fillRect(0, 0, W, H);
    }
  };

  // ─── Record video via MediaRecorder ────────────────────────
  if (typeof MediaRecorder === "undefined") {
    throw new Error("MediaRecorder API is not supported in this browser");
  }
  if (!canvas.captureStream) {
    throw new Error("Canvas captureStream is not supported in this browser");
  }

  return new Promise((resolve, reject) => {
    try {
      const stream = canvas.captureStream(FPS);
      const mimeType = MediaRecorder.isTypeSupported("video/webm;codecs=vp9")
        ? "video/webm;codecs=vp9"
        : MediaRecorder.isTypeSupported("video/webm;codecs=vp8")
          ? "video/webm;codecs=vp8"
          : MediaRecorder.isTypeSupported("video/webm")
            ? "video/webm"
            : MediaRecorder.isTypeSupported("video/mp4")
              ? "video/mp4"
              : "";

      if (!mimeType) {
        reject(new Error("No supported video codec found"));
        return;
      }

      const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 5_000_000 });
      const chunks = [];
      recorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };

      recorder.onstop = () => {
        const blob = new Blob(chunks, { type: mimeType });
        if (blob.size === 0) {
          reject(new Error("Recording produced an empty video"));
          return;
        }
        resolve({ blob, url: URL.createObjectURL(blob), mimeType });
      };

      recorder.onerror = (e) => reject(e.error || new Error("Recording failed"));

      recorder.start();

      let frame = 0;
      const renderLoop = () => {
        if (frame >= TOTAL_FRAMES) {
          recorder.stop();
          return;
        }
        drawFrame(frame);
        frame++;
        if (frame < TOTAL_FRAMES) {
          setTimeout(() => requestAnimationFrame(renderLoop), 1000 / FPS);
        } else {
          setTimeout(() => recorder.stop(), 100);
        }
      };

      requestAnimationFrame(renderLoop);
    } catch (e) {
      reject(e);
    }
  });
}

// ─── Style DNA color name → hex mapping ─────────────────────
const SDNA_COLOR_MAP = {
  black: "#1a1a1a", white: "#f0f0f0", navy: "#1e3a5f", blue: "#3b82f6",
  red: "#ef4444", green: "#22c55e", brown: "#8b5836", beige: "#d4b896",
  gray: "#6b7280", grey: "#6b7280", cream: "#f5f0d0", tan: "#d2b48c",
  pink: "#ec4899", purple: "#8b5cf6", olive: "#6b8e23", burgundy: "#800020",
  teal: "#0d9488", coral: "#ff7f6b", khaki: "#bdb76b", maroon: "#800000",
  camel: "#c19a6b", ivory: "#fffce8", charcoal: "#36454f", denim: "#5b7fa3",
  gold: "#d4a030", silver: "#c0c0c0", orange: "#f97316", yellow: "#eab308",
  indigo: "#4f46e5", lavender: "#a78bfa", rust: "#b7410e", sage: "#87ae73",
  mint: "#3eb489", peach: "#ffb07c", mauve: "#c084a4", taupe: "#8b8589",
  wine: "#722f37", plum: "#673147", slate: "#64748b", forest: "#228b22",
  mustard: "#e1a836", blush: "#de98a0", chocolate: "#7b3f00", nude: "#e3bc9a"
};
function sdnaColorHex(name) {
  if (!name) return "#555";
  const lower = name.toLowerCase().trim();
  if (SDNA_COLOR_MAP[lower]) return SDNA_COLOR_MAP[lower];
  // Try first word (e.g. "Navy Blue" → "navy")
  const first = lower.split(/[\s-]/)[0];
  if (SDNA_COLOR_MAP[first]) return SDNA_COLOR_MAP[first];
  // Try last word (e.g. "Light Blue" → "blue")
  const words = lower.split(/[\s-]/);
  if (SDNA_COLOR_MAP[words[words.length - 1]]) return SDNA_COLOR_MAP[words[words.length - 1]];
  return "#555";
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
  ctx.fillText("ATTAIR", 540, 1810);
  ctx.fillStyle = "rgba(201,169,110,0.5)";
  ctx.font = "400 24px 'Outfit', system-ui";
  ctx.fillText("AI Fashion Scanner", 540, 1860);

  return canvas.toDataURL("image/png");
}

// ═══════════════════════════════════════════════════════════════
// ─── Loading message arrays ──────────────────────────────────
const SCAN_MESSAGES = [
  "Analyzing the look...",
  "Reading colors and silhouettes...",
  "Identifying brands and styles...",
  "Checking for visual details...",
  "Mapping the outfit...",
  "Almost there...",
];
const SEARCH_MESSAGES = [
  "Analyzing your photo...",
  "Searching stores...",
  "Finding matches...",
  "Comparing prices...",
  "Checking stock...",
  "Almost ready...",
];
const RESEARCH_MESSAGES = [
  "Re-running search...",
  "Finding better matches...",
  "Applying your changes...",
  "Searching with new criteria...",
  "Comparing results...",
  "Almost there...",
];

// ─── Circle to Search canvas overlay ────────────────────────
const CircleToSearchOverlay = ({ imageRef, onConfirm, onCancel }) => {
  const canvasRef = useRef(null);
  const [isDrawing, setIsDrawing] = useState(false);
  const [path, setPath] = useState([]);
  const [glowing, setGlowing] = useState(false);
  const pendingBase64Ref = useRef(null);
  const strokeColorRef = useRef("rgba(255, 204, 0, 0.7)");
  const strokeColorSolidRef = useRef("rgba(255, 204, 0, 0.8)");
  const fillColorRef = useRef("rgba(255, 220, 0, 0.06)");
  const fillColorSolidRef = useRef("rgba(255, 220, 0, 0.1)");

  useEffect(() => {
    const canvas = canvasRef.current;
    const img = imageRef?.current;
    if (!canvas || !img) return;

    const resize = () => {
      if (img.offsetWidth > 0 && img.offsetHeight > 0) {
        canvas.width = img.offsetWidth;
        canvas.height = img.offsetHeight;
      }
    };

    // Size immediately if already loaded
    if (img.complete && img.naturalWidth > 0) resize();

    // Re-size when image loads or changes layout
    img.addEventListener("load", resize);
    let ro;
    if (typeof ResizeObserver !== "undefined") {
      ro = new ResizeObserver(resize);
      ro.observe(img);
    }
    // Fallback timeouts for edge cases (cached images, slow layout)
    const t1 = setTimeout(resize, 150);
    const t2 = setTimeout(resize, 600);
    return () => {
      img.removeEventListener("load", resize);
      if (ro) ro.disconnect();
      clearTimeout(t1);
      clearTimeout(t2);
    };
  }, [imageRef]);

  // Sample image pixels around a point and pick a high-contrast stroke color
  const pickContrastColor = (x, y) => {
    const img = imageRef?.current;
    if (!img || !img.naturalWidth) return;
    try {
      const sampleCanvas = document.createElement("canvas");
      const scaleX = img.naturalWidth / img.offsetWidth;
      const scaleY = img.naturalHeight / img.offsetHeight;
      const radius = 40;
      const sx = Math.max(0, (x - radius) * scaleX);
      const sy = Math.max(0, (y - radius) * scaleY);
      const sw = Math.min(img.naturalWidth - sx, radius * 2 * scaleX);
      const sh = Math.min(img.naturalHeight - sy, radius * 2 * scaleY);
      if (sw < 1 || sh < 1) return;
      sampleCanvas.width = sw;
      sampleCanvas.height = sh;
      const sCtx = sampleCanvas.getContext("2d", { willReadFrequently: true });
      sCtx.drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh);
      const data = sCtx.getImageData(0, 0, sw, sh).data;
      let rSum = 0, gSum = 0, bSum = 0, count = 0;
      for (let i = 0; i < data.length; i += 16) {
        rSum += data[i]; gSum += data[i + 1]; bSum += data[i + 2]; count++;
      }
      if (count === 0) return;
      const avgR = rSum / count, avgG = gSum / count, avgB = bSum / count;
      const brightness = (avgR * 299 + avgG * 587 + avgB * 114) / 1000;
      if (brightness > 160) {
        strokeColorRef.current = "rgba(100, 20, 200, 0.8)";
        strokeColorSolidRef.current = "rgba(100, 20, 200, 0.9)";
        fillColorRef.current = "rgba(100, 20, 200, 0.06)";
        fillColorSolidRef.current = "rgba(100, 20, 200, 0.1)";
      } else if (brightness > 80) {
        strokeColorRef.current = "rgba(255, 255, 255, 0.85)";
        strokeColorSolidRef.current = "rgba(255, 255, 255, 0.95)";
        fillColorRef.current = "rgba(255, 255, 255, 0.06)";
        fillColorSolidRef.current = "rgba(255, 255, 255, 0.1)";
      } else {
        strokeColorRef.current = "rgba(255, 204, 0, 0.7)";
        strokeColorSolidRef.current = "rgba(255, 204, 0, 0.8)";
        fillColorRef.current = "rgba(255, 220, 0, 0.06)";
        fillColorSolidRef.current = "rgba(255, 220, 0, 0.1)";
      }
    } catch (_) { /* cross-origin or missing image — keep default gold */ }
  };

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
    pickContrastColor(pos.x, pos.y);
    setIsDrawing(true);
    setPath([pos]);

    pendingBase64Ref.current = null;
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
    ctx.strokeStyle = strokeColorRef.current;
    ctx.lineWidth = 5;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.stroke();
    ctx.closePath();
    ctx.fillStyle = fillColorRef.current;
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
    ctx.strokeStyle = strokeColorSolidRef.current;
    ctx.lineWidth = 5;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.stroke();
    ctx.fillStyle = fillColorSolidRef.current;
    ctx.fill();

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
    pendingBase64Ref.current = base64;
    // Pass base64 to parent immediately but keep overlay visible so user can judge/redraw
    onConfirm(base64);
  };

  const clear = () => {
    setPath([]);

    pendingBase64Ref.current = null;
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
  const [authAvatarUrl, setAuthAvatarUrl] = useState(null);
  const avatarInputRef = useRef(null);
  const [authPhone, setAuthPhone] = useState("");
  const [budgetMin, setBudgetMin] = useState(50);
  const [budgetMax, setBudgetMax] = useState(100);
  const [selectedBudgetTiers, setSelectedBudgetTiers] = useState(new Set());
  const [settingsBudgetError, setSettingsBudgetError] = useState(null);
  const [sizePrefs, setSizePrefs] = useState({ body_type: [], fit: [], sizes: {} });

  // ─── Guest mode ────────────────────────────────────────────
  const isGuest = !authed;
  const [guestScans, setGuestScans] = useState(() => parseInt(localStorage.getItem("attair_guest_scans") || "0", 10));
  const [signupPrompt, setSignupPrompt] = useState(null); // null | "scan_limit" | "save" | "social" | "post_scan"

  // ─── User status (from backend) ───────────────────────────
  const [userStatus, setUserStatus] = useState(null); // { tier, scans_remaining_today, saved_count, show_ads, ... }

  // ─── PWA install prompt ──────────────────────────────────
  const [installPrompt, setInstallPrompt] = useState(null);
  const [showInstallBanner, setShowInstallBanner] = useState(false);
  useEffect(() => {
    const handler = (e) => { e.preventDefault(); setInstallPrompt(e); setShowInstallBanner(true); };
    window.addEventListener("beforeinstallprompt", handler);
    return () => window.removeEventListener("beforeinstallprompt", handler);
  }, []);
  const handleInstall = async () => {
    if (!installPrompt) return;
    installPrompt.prompt();
    await installPrompt.userChoice;
    setInstallPrompt(null);
    setShowInstallBanner(false);
  };

  // ─── Push Notifications ──────────────────────────────────
  const [notifCount, setNotifCount] = useState(0);
  const [notifications, setNotifications] = useState([]);
  const [showNotifPanel, setShowNotifPanel] = useState(false);
  const [pushEnabled, setPushEnabled] = useState(false);
  const [showNotifPrompt, setShowNotifPrompt] = useState(false);
  const [nudgeBanner, setNudgeBanner] = useState(null); // null | { context, scanId, itemName }
  const nudgeScheduledRef = useRef(null); // track currently scheduled nudge scanId

  // ─── App state ────────────────────────────────────────────
  // Skip onboarding for returning authed users — go straight to "app" screen.
  // This also ensures Playwright screenshot captures see the tab bar immediately.
  const [screen, setScreen] = useState(() => Auth.getToken() ? "app" : "onboarding");
  const [obIdx, setObIdx] = useState(0);
  const [prefs, setPrefs] = useState({});
  const [selPlan, setSelPlan] = useState("yearly");
  const [tab, setTab] = useState(() => {
    if (Auth.getToken()) {
      const p = new URLSearchParams(window.location.search);
      if (p.get("tab") === "twins") return "search";
    }
    return "home";
  });
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
  const [historyFilter, setHistoryFilter] = useState("all"); // "all" | "saved" | "picks"
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
  const galleryRef = useRef(null);
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

  // ─── Share ──────────────────────────────────────────────────
  const [shareCardLoading, setShareCardLoading] = useState(false);
  const [shareLinkCopied, setShareLinkCopied] = useState(false);
  const [sharePublicToast, setSharePublicToast] = useState(false);
  const [showShareSheet, setShowShareSheet] = useState(false);

  // ─── Scan-to-Reel Video Export (Pro-only) ──────────────────
  const [reelGenerating, setReelGenerating] = useState(false);
  const [reelProgress, setReelProgress] = useState(0); // 0–100
  const [reelResult, setReelResult] = useState(null); // { blob, url, mimeType } | null
  const [showReelPreview, setShowReelPreview] = useState(false);
  const [reelError, setReelError] = useState(null); // user-visible error message
  const reelVideoRef = useRef(null);
  const reelSupported = typeof MediaRecorder !== "undefined" && typeof HTMLCanvasElement !== "undefined" && !!HTMLCanvasElement.prototype.captureStream;

  // Cleanup reel object URL on unmount or when result changes
  useEffect(() => {
    return () => {
      if (reelResult?.url) {
        try { URL.revokeObjectURL(reelResult.url); } catch {}
      }
    };
  }, [reelResult]);

  // Auto-dismiss reel error toast
  useEffect(() => {
    if (!reelError) return;
    const t = setTimeout(() => setReelError(null), 4000);
    return () => clearTimeout(t);
  }, [reelError]);

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
  const [styleDnaSlide, setStyleDnaSlide] = useState(0);

  // ─── Style Match tooltip ──────────────────────────────────
  const [styleMatchTooltip, setStyleMatchTooltip] = useState(null); // null | { key: string }

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
  const [wishlistPickerScan, setWishlistPickerScan] = useState(null); // scan object for wishlist picker modal
  const [newWishlistName, setNewWishlistName] = useState("");
  const [wishlistEditId, setWishlistEditId] = useState(null); // id of wishlist being edited
  const [wishlistEditName, setWishlistEditName] = useState(""); // rename input value
  const [wishlistEditOpen, setWishlistEditOpen] = useState(false); // action sheet visible
  const [wishlistRenaming, setWishlistRenaming] = useState(false); // inline rename mode
  const wishlistLongPressRef = useRef(null); // long-press timer

  // ─── Likes / Collections tab ──────────────────────────────
  const [likesCollectionFilter, setLikesCollectionFilter] = useState("all");
  const [likesLongPressItem, setLikesLongPressItem] = useState(null); // { savedItem } for collection sheet
  const [likesCollectionInput, setLikesCollectionInput] = useState("");
  const [likesCollectionCreating, setLikesCollectionCreating] = useState(false);
  const [likesCategoryFilter, setLikesCategoryFilter] = useState("all"); // category chip filter
  const [savedSearchQuery, setSavedSearchQuery] = useState(""); // search within saved items
  const [likesBudgetExpanded, setLikesBudgetExpanded] = useState(false); // budget tracker toggle
  const [flippedScans, setFlippedScans] = useState(new Set()); // which scan cards are flipped
  const [scanSearchQuery, setScanSearchQuery] = useState(""); // search within scan history

  // ─── Followers/Following List ──────────────────────────────────
  const [authUserId, setAuthUserId] = useState(null);
  const [followListOpen, setFollowListOpen] = useState(null); // null | "followers" | "following"
  const [followListData, setFollowListData] = useState([]);
  const [followListLoading, setFollowListLoading] = useState(false);

  // ─── Language confirmation popup ──────────────────────────────
  const [langConfirmOpen, setLangConfirmOpen] = useState(null); // null | language code

  // ─── Complete the Look ──────────────────────────────────────
  const [looks, setLooks] = useState([]);                          // grouped looks from backend
  const [looksLoading, setLooksLoading] = useState(false);
  const [looksView, setLooksView] = useState("flat");               // "grouped" | "flat"
  const [expandedLook, setExpandedLook] = useState(null);          // scan_id of expanded look
  const [lookDetail, setLookDetail] = useState(null);              // full detail for expanded look
  const [lookDetailLoading, setLookDetailLoading] = useState(false);
  const [buyAllLoading, setBuyAllLoading] = useState(null);        // scan_id being processed

  // ─── Hanger Test ────────────────────────────────────────────
  const [hangerOutfits, setHangerOutfits] = useState([]);
  const [hangerVotes, setHangerVotes] = useState({});
  const [hangerStatsMap, setHangerStatsMap] = useState({});
  const [hangerCadence, setHangerCadence] = useState(null);
  const [hangerCurrentIndex, setHangerCurrentIndex] = useState(0);
  const [hangerTranche, setHangerTranche] = useState(null);
  const [hangerTasteProfile, setHangerTasteProfile] = useState(null);
  const [hangerTasteProfileOpen, setHangerTasteProfileOpen] = useState(false);
  const [hangerStreak, setHangerStreak] = useState(null);         // { current_streak, ... }
  const [hangerLoading, setHangerLoading] = useState(false);
  const [hangerVoting, setHangerVoting] = useState(false);
  const [hangerFullscreen, setHangerFullscreen] = useState(false); // show fullscreen verdict card
  const [hangerVoteAnim, setHangerVoteAnim] = useState(null);     // 'wear'|'pass' for animation
  const [hangerInsight, setHangerInsight] = useState(null);        // style insight modal data
  const [hangerHistory, setHangerHistory] = useState([]);
  const [hangerHistoryOpen, setHangerHistoryOpen] = useState(false);
  const [hangerSwipeX, setHangerSwipeX] = useState(0);             // swipe offset
  const hangerTouchRef = useRef(null);

  // ─── Derived status helpers (must be before any useEffect that references them) ───
  const isFree = !userStatus || userStatus.tier === "free" || userStatus.tier === "expired";
  const isPro = userStatus?.tier === "pro" || userStatus?.tier === "trial";
  const scansLeft = userStatus?.scans_remaining_today ?? 12;
  const scansLimit = userStatus?.scans_limit ?? 12;
  const showAds = userStatus?.show_ads ?? true;
  const deepSearchesLeft = userStatus?.extended_searches_remaining ?? 3;
  const fastSearchesLeft = userStatus?.fast_searches_remaining ?? 12;

  // ─── Load Hanger Test (batch of 5) ────────────────
  useEffect(() => {
    if (!authed || screen !== "app") return;
    if (tab !== "home" && !hangerFullscreen) return;
    (async () => {
      setHangerLoading(true);
      try {
        const data = await API.hangerTestToday();
        setHangerOutfits(data.outfits || []);
        setHangerVotes(data.user_votes || {});
        setHangerStatsMap(data.stats || {});
        setHangerCadence(data.cadence || null);
        if (data.streak) setHangerStreak(data.streak);
        if (data.taste_profile) setHangerTasteProfile(data.taste_profile);
        // Set index to first unvoted outfit
        const firstUnvoted = (data.outfits || []).findIndex(o => !data.user_votes?.[o.id]);
        setHangerCurrentIndex(firstUnvoted >= 0 ? firstUnvoted : (data.outfits?.length || 0));
      } catch {}
      setHangerLoading(false);
    })();
  }, [authed, screen, tab]);

  // Check URL param for deep link from push notification
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("hanger") === "1" && authed) {
      setHangerFullscreen(true);
      window.history.replaceState({}, "", window.location.pathname);
    }
    // If returning from a nudge push notification, show the nudge banner
    if (params.get("nudge") === "1" && authed) {
      setNudgeBanner({ context: params.get("context") || "scan_results" });
      window.history.replaceState({}, "", window.location.pathname);
    }
    // Deep link from Weekly Style Report push notification
    if (window.location.pathname === "/weekly-report" && authed) {
      setWeeklyReportOpen(true);
      setWeeklyReportLoading(true);
      setWeeklyReportError(false);
      setWeeklyReportNotPro(false);
      API.getMyWeeklyReport()
        .then(d => {
          if (d.reason === "not_pro") {
            // Free user tapped a stale push link — show upgrade nudge
            setWeeklyReportNotPro(true);
            setWeeklyReportLoading(false);
          } else if (d.report && d.report.scans && d.report.scans.length > 0) {
            setWeeklyReport(d.report);
            setWeeklyReportLoading(false);
          } else {
            // No report this week — fallback to generic OOTW
            setWeeklyReportOpen(false);
            setOotwLoading(true);
            API.getOOTW()
              .then(od => { if (od.ootw) { setOotwData(od.ootw); setOotwExpanded(true); } })
              .catch(err => { console.error("[OOTW] deep-link fetch failed:", err); setOotwError(true); })
              .finally(() => setOotwLoading(false));
          }
        })
        .catch(() => {
          setWeeklyReportLoading(false);
          setWeeklyReportError(true);
        });
      window.history.replaceState({}, "", "/");
    }
    // Deep link from Style Twins weekly notification
    if (params.get("tab") === "twins" && authed) {
      setTab("search");
      setSearchSubTab("twins");
      setStyleTwinsLoading(true); // eagerly show spinner, prevent "Unlock" CTA flash
      window.history.replaceState({}, "", window.location.pathname);
    }
  }, [authed]);

  // ─── Visibility change: show nudge banner when user returns after being away ──
  useEffect(() => {
    let hiddenAt = null;
    const NUDGE_AWAY_THRESHOLD = 5 * 60 * 1000; // 5 min away triggers in-app nudge

    const handleVisibility = () => {
      if (document.hidden) {
        hiddenAt = Date.now();
      } else if (hiddenAt) {
        const awayMs = Date.now() - hiddenAt;
        hiddenAt = null;
        // If user was away 5+ min and has pending results, show subtle nudge
        if (awayMs >= NUDGE_AWAY_THRESHOLD && phase === "done" && results && scanId && authed) {
          setNudgeBanner({ context: "scan_results", scanId });
          // Auto-dismiss after 8 seconds
          setTimeout(() => setNudgeBanner(null), 8000);
        }
      }
    };

    document.addEventListener("visibilitychange", handleVisibility);
    return () => document.removeEventListener("visibilitychange", handleVisibility);
  }, [phase, results, scanId, authed]);

  const handleHangerVote = useCallback(async (verdict) => {
    const outfit = hangerOutfits[hangerCurrentIndex];
    if (!outfit || hangerVoting || hangerVotes[outfit.id]) return;
    setHangerVoting(true);
    setHangerVoteAnim(verdict);
    if (navigator.vibrate) navigator.vibrate(20);

    try {
      const data = await API.hangerTestVote(outfit.id, verdict);
      setHangerVotes(prev => ({ ...prev, [outfit.id]: verdict }));
      if (data.stats) setHangerStatsMap(prev => ({ ...prev, [outfit.id]: data.stats }));
      if (data.cadence) setHangerCadence(data.cadence);
      if (data.streak) setHangerStreak(data.streak);
      if (data.tranche_stats) setHangerTranche(data.tranche_stats);

      // Animate card off, then advance after delay
      setTimeout(() => {
        setHangerCurrentIndex(prev => prev + 1);
        setHangerVoteAnim(null);
        setHangerTranche(null);
        setHangerSwipeX(0);
      }, 1200);

      if (data.earned_insight && data.style_insight) {
        setTimeout(() => setHangerInsight(data.style_insight), 1800);
      }
      if (data.taste_profile_updated && data.taste_profile) {
        setHangerTasteProfile(data.taste_profile);
      }
    } catch {}
    setTimeout(() => setHangerVoting(false), 1200);
  }, [hangerOutfits, hangerCurrentIndex, hangerVoting, hangerVotes]);

  // Load scan history, price alerts, and looks when Saved tab is opened
  useEffect(() => {
    if (tab === "likes" && authed && history.length === 0) {
      API.getHistory().then(d => setHistory(d.scans || [])).catch(() => {});
    }
    if (tab === "likes" && authed && isPro && priceAlerts.length === 0) {
      API.priceAlerts().then(d => setPriceAlerts(d.data || [])).catch(() => {});
    }
    if (tab === "likes" && authed && looks.length === 0) {
      setLooksLoading(true);
      API.getLooks().then(d => { setLooks(d.looks || []); setLooksLoading(false); }).catch(() => setLooksLoading(false));
    }
  }, [tab, authed]);

  // ─── Profile redesign ──────────────────────────────────────
  const [profileSettingsOpen, setProfileSettingsOpen] = useState(false);
  const [settingsSheetY, setSettingsSheetY] = useState(0);
  const settingsDragRef = useRef({ startY: 0, currentY: 0, dragging: false });
  const [settingsBudgetExpanded, setSettingsBudgetExpanded] = useState(false);
  const [settingsBudgetDirty, setSettingsBudgetDirty] = useState(false);
  const [settingsBudgetSaving, setSettingsBudgetSaving] = useState(false);
  const budgetModalOrigRef = useRef({ min: 50, max: 100 });
  // ─── Size Preferences Modal ────────────────────────────────
  const [sizePrefsModalOpen, setSizePrefsModalOpen] = useState(false);
  const [sizePrefsGender, setSizePrefsGender] = useState("women");
  const [sizePrefsEdit, setSizePrefsEdit] = useState({ tops: "", bottoms_waist: "", bottoms_length: "", shoes: "", dresses: "" });
  const [sizePrefsSaving, setSizePrefsSaving] = useState(false);
  const sizePrefsOrigRef = useRef(null);
  // ─── Language Change Confirmation ──────────────────────────
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
  const [occasion, setOccasion] = useState(null);       // null | "casual"|"work"|"night_out"|"athletic"|"formal"|"outdoor"|"date_night"|"vacation"|"brunch"|"streetwear"|"athleisure"|"festival"|"wedding_guest"|"business_casual"|"lounge"|"travel"

  // ─── Search notes ─────────────────────────────────────────
  const [searchNotes, setSearchNotes] = useState("");
  const [searchMode, setSearchMode] = useState("fast"); // "fast" or "extended"

  // ─── Scan streak ──────────────────────────────────────────
  const [scanStreak, setScanStreak] = useState(0);

  // ─── Identification preview ───────────────────────────────
  const [identPreview, setIdentPreview] = useState(null); // array of identified items | null

  // ─── Re-search indicator ──────────────────────────────────
  const [isResearch, setIsResearch] = useState(false); // true when re-running a search (not first run)

  // ─── Searching screen staggered reveal ────────────────────
  const [revealedSearchItems, setRevealedSearchItems] = useState(new Set()); // items revealed during search takeover

  // ─── Advanced section toggle (results screen) ─────────────
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [showAllPickItems, setShowAllPickItems] = useState(false);

  // ─── Expanded items in results ────────────────────────────
  const [expandedItems, setExpandedItems] = useState(new Set()); // which item indices are expanded

  // ─── Social profile ───────────────────────────────────────
  const [profileBio, setProfileBio] = useState("");
  const [profileBioEditing, setProfileBioEditing] = useState(false);
  const [profileBioSaving, setProfileBioSaving] = useState(false);
  const [profileStats, setProfileStats] = useState({ followers_count: 0, following_count: 0 }); // { followers_count, following_count }
  const [scanVisibilityMap, setScanVisibilityMap] = useState({}); // { [scanId]: "public"|"private"|"followers" }

  // ─── Social Feed ───────────────────────────────────────────
  const [feedTab, setFeedTab] = useState("foryou"); // "foryou" | "following" | "trending"
  const [feedScans, setFeedScans] = useState([]);
  const [feedPage, setFeedPage] = useState(1);
  const [feedLoading, setFeedLoading] = useState(false);
  const [feedHasMore, setFeedHasMore] = useState(false);
  const [feedDetailScan, setFeedDetailScan] = useState(null); // scan object for overlay
  const [feedDetailIdx, setFeedDetailIdx] = useState(-1); // index in feedScans for swipe navigation
  const reelScrollerRef = useRef(null);
  const [feedFilterQuery, setFeedFilterQuery] = useState(""); // "I'm looking for..." filter
  const [showUserSearch, setShowUserSearch] = useState(false);
  const [userSearchQuery, setUserSearchQuery] = useState("");
  const [userSearchResults, setUserSearchResults] = useState([]);
  const [userSearchLoading, setUserSearchLoading] = useState(false);
  const [followingSet, setFollowingSet] = useState(new Set()); // user ids we follow
  const userSearchTimerRef = useRef(null);
  const feedSentinelRef = useRef(null);
  const [searchSubTab, setSearchSubTab] = useState(() => {
    if (Auth.getToken()) {
      const p = new URLSearchParams(window.location.search);
      if (p.get("tab") === "twins") return "twins";
    }
    return "people";
  }); // "people" | "products" | "twins"
  const [productSearchQuery, setProductSearchQuery] = useState("");
  const [productSearchResults, setProductSearchResults] = useState([]);

  // ─── Outfit of the Week ────────────────────────────────────
  const [ootwData, setOotwData] = useState(null);           // { headline, editorial, cover_image, scans, ... }
  const [ootwLoading, setOotwLoading] = useState(false);
  const [ootwError, setOotwError] = useState(false);        // true when fetch failed — shows tap-to-retry
  const [ootwExpanded, setOotwExpanded] = useState(false);   // full detail overlay open

  // ─── Weekly Style Report (Pro users) ────────────────────────
  const [weeklyReport, setWeeklyReport] = useState(null);     // { scans, week_start, ... }
  const [weeklyReportOpen, setWeeklyReportOpen] = useState(false);
  const [weeklyReportLoading, setWeeklyReportLoading] = useState(false);
  const [weeklyReportError, setWeeklyReportError] = useState(false);
  const [weeklyReportNotPro, setWeeklyReportNotPro] = useState(false); // free user tapped push link

  // ─── Style Twins ────────────────────────────────────────────
  const [styleTwins, setStyleTwins] = useState([]);
  const [styleTwinsLoading, setStyleTwinsLoading] = useState(() => {
    if (Auth.getToken()) {
      const p = new URLSearchParams(window.location.search);
      if (p.get("tab") === "twins") return true;
    }
    return false;
  });
  const [styleTwinsReady, setStyleTwinsReady] = useState(false);
  const [styleTwinsError, setStyleTwinsError] = useState(null);
  const [styleTwinsMyArchetype, setStyleTwinsMyArchetype] = useState(null);
  const [styleTwinsTotalMatches, setStyleTwinsTotalMatches] = useState(0);
  const [styleTwinSaveBanner, setStyleTwinSaveBanner] = useState(null); // { message, twin_name }
  const [styleTwinCompare, setStyleTwinCompare] = useState(null); // twin object for comparison sheet
  const [styleTwinsMyScore, setStyleTwinsMyScore] = useState(null); // user's own style_score for comparison bars
  const [styleTwinsHasFetched, setStyleTwinsHasFetched] = useState(false); // tracks if we've attempted a fetch
  const styleTwinsLoadingRef = useRef(false); // ref guard to prevent concurrent fetches

  // ─── Style Challenges ──────────────────────────────────────
  const [challenges, setChallenges] = useState([]);
  const [activeChallengeDetail, setActiveChallengeDetail] = useState(null); // full challenge with submissions
  const [challengeLoading, setChallengeLoading] = useState(false);

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
  const [itemMemories, setItemMemories] = useState({});    // { [idx]: { corrections, confirmed_facts, user_preferences, context_notes, turn_count } }
  const [refineInputs, setRefineInputs] = useState({});    // { [idx]: string }
  const [refineLoadings, setRefineLoadings] = useState({}); // { [idx]: bool }

  // ─── Restore chat memories: merge Supabase + localStorage (localStorage wins) ─
  useEffect(() => {
    if (!scanId) return;

    // Layer 1: Supabase _memory fields from historical scan items
    const supabaseMemories = {};
    if (results?.items?.length) {
      results.items.forEach((item, idx) => {
        if (item._memory && typeof item._memory === "object") {
          supabaseMemories[idx] = item._memory;
        }
      });
    }

    // Layer 2: localStorage (more recent, takes priority over Supabase)
    let localMemories = {};
    try {
      localMemories = JSON.parse(localStorage.getItem(`attaire_mem_${scanId}`) || "{}");
      if (typeof localMemories !== "object" || Array.isArray(localMemories)) localMemories = {};
    } catch { localMemories = {}; }

    // Merge: Supabase is base, localStorage overwrites per-item
    const merged = { ...supabaseMemories, ...localMemories };
    if (Object.keys(merged).length > 0) {
      setItemMemories(merged);
    }
  }, [scanId, results?.items?.length]); // eslint-disable-line react-hooks/exhaustive-deps

  // ─── Dupe Finder state ────────────────────────────────────
  const [dupeModal, setDupeModal] = useState(null);         // null | { product, itemIdx, tierKey }
  const [dupeResults, setDupeResults] = useState(null);     // null | { dupes: [], original: {} }
  const [dupeLoading, setDupeLoading] = useState(false);
  const [dupeError, setDupeError] = useState(null);
  const [dupeSlide, setDupeSlide] = useState(0);            // current swipe index
  const [dupeShareLoading, setDupeShareLoading] = useState(false);
  const dupeScrollRef = useRef(null);

  // ─── Dupe Finder: trigger search ──────────────────────────
  const openDupeModal = useCallback(async (product, itemData, tierKey) => {
    const priceNum = parseFloat((product.price || "").replace(/[^0-9.]/g, ""));
    if (!priceNum || priceNum < 150) return;

    const modalData = {
      product_name: product.product_name || itemData?.name || "Product",
      description: [itemData?.color, itemData?.material, itemData?.subcategory, itemData?.fit, itemData?.construction_details].filter(Boolean).join(", "),
      price: priceNum,
      image_url: product.image_url || "",
      category: itemData?.category || "",
      gender: results?.gender || prefs?.gender || "female",
    };

    setDupeModal({ product: modalData, itemIdx: null, tierKey });
    setDupeResults(null);
    setDupeError(null);
    setDupeLoading(true);
    setDupeSlide(0);

    track("dupe_search_started", { product_name: modalData.product_name, price: priceNum }, scanId, "scan");

    try {
      const data = await API.findDupes(
        modalData.product_name,
        modalData.description,
        modalData.price,
        modalData.image_url,
        modalData.category,
        modalData.gender,
      );
      setDupeResults(data);
      track("dupe_search_completed", { product_name: modalData.product_name, dupe_count: data.dupes?.length || 0 }, scanId, "scan");
    } catch (err) {
      setDupeError(err.message || "Failed to find similar looks");
      track("dupe_search_failed", { product_name: modalData.product_name, error: err.message }, scanId, "scan");
    } finally {
      setDupeLoading(false);
    }
  }, [results, prefs, scanId]);

  // ─── Dupe Share Card: generate 1080x1920 story image ──────
  const generateDupeShareCard = useCallback(async (original, dupe) => {
    setDupeShareLoading(true);
    try {
      const canvas = document.createElement("canvas");
      canvas.width = 1080;
      canvas.height = 1920;
      const ctx = canvas.getContext("2d");

      // Background gradient
      const grad = ctx.createLinearGradient(0, 0, 0, 1920);
      grad.addColorStop(0, "#0C0C0E");
      grad.addColorStop(1, "#1A1A1A");
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, 1080, 1920);

      // Header: "DUPE ALERT"
      ctx.fillStyle = "#C9A96E";
      ctx.font = "bold 56px system-ui, -apple-system, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("DUPE ALERT", 540, 140);

      // Divider line
      ctx.strokeStyle = "rgba(201,169,110,0.4)";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(140, 180);
      ctx.lineTo(940, 180);
      ctx.stroke();

      // Load images
      const loadImg = (url) => new Promise((resolve) => {
        if (!url) { resolve(null); return; }
        const img = new Image();
        img.crossOrigin = "anonymous";
        img.onload = () => resolve(img);
        img.onerror = () => resolve(null);
        img.src = url;
      });

      const [origImg, dupeImg] = await Promise.all([
        loadImg(original.image_url),
        loadImg(dupe.image_url),
      ]);

      // Cards config
      const cardW = 440;
      const cardH = 560;
      const cardY = 260;
      const leftX = 60;
      const rightX = 580;
      const cardRadius = 24;

      // Draw card backgrounds
      const drawCard = (x, y, w, h) => {
        ctx.beginPath();
        ctx.roundRect(x, y, w, h, cardRadius);
        ctx.fillStyle = "#222";
        ctx.fill();
        ctx.strokeStyle = "rgba(255,255,255,0.08)";
        ctx.lineWidth = 1;
        ctx.stroke();
      };

      drawCard(leftX, cardY, cardW, cardH);
      drawCard(rightX, cardY, cardW, cardH);

      // Draw images
      const imgH = 380;
      if (origImg) {
        ctx.save();
        ctx.beginPath();
        ctx.roundRect(leftX, cardY, cardW, imgH, [cardRadius, cardRadius, 0, 0]);
        ctx.clip();
        const scale = Math.max(cardW / origImg.width, imgH / origImg.height);
        const sw = origImg.width * scale;
        const sh = origImg.height * scale;
        ctx.drawImage(origImg, leftX + (cardW - sw) / 2, cardY + (imgH - sh) / 2, sw, sh);
        ctx.restore();
      }
      if (dupeImg) {
        ctx.save();
        ctx.beginPath();
        ctx.roundRect(rightX, cardY, cardW, imgH, [cardRadius, cardRadius, 0, 0]);
        ctx.clip();
        const scale = Math.max(cardW / dupeImg.width, imgH / dupeImg.height);
        const sw = dupeImg.width * scale;
        const sh = dupeImg.height * scale;
        ctx.drawImage(dupeImg, rightX + (cardW - sw) / 2, cardY + (imgH - sh) / 2, sw, sh);
        ctx.restore();
      }

      // Labels under images
      const labelY = cardY + imgH + 32;
      ctx.font = "600 22px system-ui, -apple-system, sans-serif";
      ctx.textAlign = "center";
      ctx.fillStyle = "rgba(255,255,255,0.5)";
      ctx.fillText("ORIGINAL", leftX + cardW / 2, labelY);
      ctx.fillStyle = "#4CAF50";
      ctx.fillText("THE DUPE", rightX + cardW / 2, labelY);

      // Prices
      const priceY = labelY + 46;
      ctx.font = "bold 40px system-ui, -apple-system, sans-serif";
      ctx.fillStyle = "#fff";
      ctx.fillText(`$${Math.round(original.price)}`, leftX + cardW / 2, priceY);
      ctx.fillStyle = "#4CAF50";
      ctx.fillText(dupe.price, rightX + cardW / 2, priceY);

      // Stores
      const storeY = priceY + 36;
      ctx.font = "500 20px system-ui, -apple-system, sans-serif";
      ctx.fillStyle = "rgba(255,255,255,0.4)";
      ctx.textAlign = "center";
      ctx.fillText((original.name || "").slice(0, 30), leftX + cardW / 2, storeY);
      ctx.fillText((dupe.store || "").slice(0, 30), rightX + cardW / 2, storeY);

      // VS badge in the middle
      const vsY = cardY + imgH / 2;
      ctx.beginPath();
      ctx.arc(540, vsY, 40, 0, Math.PI * 2);
      ctx.fillStyle = "#C9A96E";
      ctx.fill();
      ctx.font = "bold 28px system-ui, -apple-system, sans-serif";
      ctx.fillStyle = "#000";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("VS", 540, vsY);
      ctx.textBaseline = "alphabetic";

      // Savings badge
      const savingsY = storeY + 100;
      const savingsText = `Save ${dupe.savings_pct}%`;
      ctx.beginPath();
      ctx.roundRect(340, savingsY - 36, 400, 72, 36);
      ctx.fillStyle = "rgba(76,175,80,0.15)";
      ctx.fill();
      ctx.strokeStyle = "#4CAF50";
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.font = "bold 38px system-ui, -apple-system, sans-serif";
      ctx.fillStyle = "#4CAF50";
      ctx.textAlign = "center";
      ctx.fillText(savingsText, 540, savingsY + 10);

      // Similarity score
      if (dupe.similarity_score) {
        const simY = savingsY + 80;
        ctx.font = "500 22px system-ui, -apple-system, sans-serif";
        ctx.fillStyle = "rgba(255,255,255,0.4)";
        ctx.fillText(`${dupe.similarity_score}% visual match`, 540, simY);
      }

      // ATTAIRE watermark
      ctx.font = "bold 32px 'Instrument Serif', Georgia, serif";
      ctx.fillStyle = "rgba(201,169,110,0.6)";
      ctx.textAlign = "center";
      ctx.fillText("ATTAIRE", 540, 1820);
      ctx.font = "400 18px system-ui, -apple-system, sans-serif";
      ctx.fillStyle = "rgba(255,255,255,0.25)";
      ctx.fillText("attaire.app", 540, 1855);

      // Convert to blob and trigger share/download
      const blob = await new Promise(resolve => canvas.toBlob(resolve, "image/png"));
      if (navigator.share && navigator.canShare && navigator.canShare({ files: [new File([blob], "dupe.png", { type: "image/png" })] })) {
        await navigator.share({
          title: "ATTAIRE Dupe Alert",
          text: `Found a dupe! Save ${dupe.savings_pct}% on a similar look`,
          files: [new File([blob], "attaire-dupe.png", { type: "image/png" })],
        });
      } else {
        // Fallback: download
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = "attaire-dupe.png";
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      }
      track("dupe_share", { product_name: original.name, dupe_name: dupe.product_name, savings_pct: dupe.savings_pct }, scanId, "scan");
    } catch (err) {
      console.error("[Dupe Share]", err);
    } finally {
      setDupeShareLoading(false);
    }
  }, [scanId]);

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
        if (jwt?.sub) setAuthUserId(jwt.sub);
      }
      refreshStatus();
      authFetch(`${API_BASE}/api/user/profile`)
        .then(r => r.json())
        .then(profile => {
          if (profile.id) setAuthUserId(profile.id);
          if (profile.display_name) setAuthName(profile.display_name);
          if (profile.avatar_url) setAuthAvatarUrl(profile.avatar_url);
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
          // Populate followingSet so follow buttons show correct state
          if (profile.id) {
            API.getFollowing(profile.id).then(fd => {
              const ids = (fd.following || []).map(f => f.following_id || f.id).filter(Boolean);
              if (ids.length) setFollowingSet(new Set(ids));
            }).catch(() => {});
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
      API.getUnreadNotifCount().then(d => setNotifCount(d.count || 0)).catch(() => {});

      // Auto-subscribe to push if permission already granted
      if ("Notification" in window && Notification.permission === "granted") {
        subscribeToPush().then(ok => setPushEnabled(ok)).catch(() => {});
      } else if ("Notification" in window && Notification.permission === "default") {
        // Show prompt after a short delay (not on first visit)
        const prompted = localStorage.getItem("attair_notif_prompted");
        if (!prompted) {
          setTimeout(() => setShowNotifPrompt(true), 8000);
        }
      }

      if (!styleDna && !styleDnaLoading) {
        setStyleDnaLoading(true);
        API.styleDna().then(data => setStyleDna(data)).catch(() => {}).finally(() => setStyleDnaLoading(false));
      }
      if (screen === "onboarding" || screen === "inspiration") setScreen("app");

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

  // ─── Feed loader (with localStorage cache for instant load) ──
  const FEED_CACHE_KEY = "attair_feed_cache";
  const FEED_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

  const loadFeed = useCallback(async (page = 1, append = false) => {
    if (feedLoading) return;

    // For page 1 (initial load), try cache first for instant render
    if (page === 1 && !append) {
      try {
        const raw = localStorage.getItem(`${FEED_CACHE_KEY}_${feedTab}`);
        if (raw) {
          const cached = JSON.parse(raw);
          if (cached.scans?.length) {
            setFeedScans(cached.scans);
            setFeedHasMore(cached.has_more || false);
            setFeedPage(1);
            // If cache is fresh enough, skip network call
            if (Date.now() - cached.ts < FEED_CACHE_TTL) return;
          }
        }
      } catch {}
    }

    setFeedLoading(true);
    try {
      const data = await API.getFeed(page, feedTab);
      const scans = data.scans || [];
      setFeedScans(prev => append ? [...prev, ...scans] : scans);
      setFeedHasMore(data.has_more || false);
      setFeedPage(page);

      // Cache page 1 results
      if (page === 1 && !append) {
        try {
          localStorage.setItem(`${FEED_CACHE_KEY}_${feedTab}`, JSON.stringify({
            scans, has_more: data.has_more || false, ts: Date.now(),
          }));
        } catch {}
      }
    } catch (err) {
      console.error("[ATTAIR] Feed load error:", err);
    } finally {
      setFeedLoading(false);
    }
  }, [feedLoading, feedTab]);

  useEffect(() => {
    if (authed && screen === "app" && (tab === "home" || (tab === "scan" && phase === "idle" && !img))) {
      loadFeed(1, false);
      // Load challenges for the home feed (once)
      if (challenges.length === 0) {
        API.getChallenges().then(d => setChallenges(d.data || [])).catch(() => {});
      }
    }
  }, [authed, screen, tab, feedTab]);

  // Infinite scroll — pre-fetch when sentinel enters viewport
  useEffect(() => {
    if (!feedSentinelRef.current) return;
    const obs = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting && feedHasMore && !feedLoading) {
        loadFeed(feedPage + 1, true);
      }
    }, { rootMargin: "600px" }); // pre-fetch 600px before visible
    obs.observe(feedSentinelRef.current);
    return () => obs.disconnect();
  }, [feedHasMore, feedLoading, feedPage, loadFeed]);

  // ─── Outfit of the Week loader ────────────────────────────
  const loadOOTW = useCallback(() => {
    setOotwLoading(true);
    setOotwError(false);
    API.getOOTW()
      .then(d => { if (d.ootw) setOotwData(d.ootw); })
      .catch(err => { console.error("[OOTW] fetch failed:", err); setOotwError(true); })
      .finally(() => setOotwLoading(false));
  }, []);

  useEffect(() => {
    if (authed && screen === "app" && (tab === "home" || (tab === "scan" && phase === "idle" && !img)) && !ootwData && !ootwLoading && !ootwError) {
      loadOOTW();
    }
  }, [authed, screen, tab, phase, img]);

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

  // ─── Load Style Twins when user taps the Twins sub-tab ───
  const loadStyleTwins = useCallback(async () => {
    if (!authed) return;
    // Prevent concurrent calls but with safety timeout to avoid permanent deadlock
    if (styleTwinsLoadingRef.current) {
      console.log("[StyleTwins] skipping: already loading");
      return;
    }
    styleTwinsLoadingRef.current = true;
    setStyleTwinsLoading(true);
    setStyleTwinsError(null);
    // Safety: auto-release ref after 15s to prevent deadlocks
    const safetyTimer = setTimeout(() => {
      if (styleTwinsLoadingRef.current) {
        console.warn("[StyleTwins] safety timeout — releasing loading lock");
        styleTwinsLoadingRef.current = false;
        setStyleTwinsLoading(false);
        setStyleTwinsHasFetched(true);
        setStyleTwinsError("Request timed out. Tap to retry.");
      }
    }, 15000);
    try {
      let data;
      try {
        data = await API.getStyleTwins();
      } catch (fetchErr) {
        console.error("[StyleTwins] fetch error:", fetchErr);
        throw fetchErr;
      }
      console.log("[StyleTwins] API response:", JSON.stringify(data).slice(0, 200));
      if (data && data.ready === true) {
        const twins = Array.isArray(data.twins) ? data.twins : [];
        setStyleTwins(twins);
        setStyleTwinsReady(true);
        setStyleTwinsMyArchetype(data.my_archetype || null);
        setStyleTwinsMyScore(data.my_style_score || null);
        setStyleTwinsTotalMatches(data.total_matches || 0);
      } else if (data && data.ready === false) {
        // User doesn't have Style DNA yet
        setStyleTwinsReady(false);
        setStyleTwins([]);
      } else {
        // Unexpected response shape — treat as error so user sees feedback
        console.warn("[StyleTwins] unexpected response shape:", data);
        setStyleTwinsError("Unexpected response. Tap to retry.");
        setStyleTwins([]);
      }
    } catch (err) {
      console.error("[StyleTwins] load error:", err);
      setStyleTwinsError("Could not load Style Twins. Tap to retry.");
      setStyleTwins([]);
    } finally {
      clearTimeout(safetyTimer);
      styleTwinsLoadingRef.current = false;
      setStyleTwinsLoading(false);
      setStyleTwinsHasFetched(true);
    }
  }, [authed]);

  useEffect(() => {
    if (tab === "search" && searchSubTab === "twins" && authed && !styleTwinsLoadingRef.current) {
      // Always set loading synchronously on tab activation to guarantee loading spinner shows
      // before any async gap. loadStyleTwins has internal guards (ref + hasFetched check is optional).
      setStyleTwinsLoading(true);
      loadStyleTwins();
    }
  }, [tab, searchSubTab, authed, loadStyleTwins]);

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
    else trans(() => setScreen("inspiration"));
  };
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
        if (jwt?.sub) setAuthUserId(jwt.sub);
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
          if (profile.avatar_url) setAuthAvatarUrl(profile.avatar_url);
          if (profile.gender_pref) setPrefs(p => ({ ...p, gender: profile.gender_pref }));
          if (profile.budget_min != null) setBudgetMin(profile.budget_min);
          if (profile.budget_max != null) setBudgetMax(profile.budget_max);
        } catch {}
      }
      setAuthed(true);
      setScreen("app");
      // Clear guest scan counter on signup (they now get 12 free scans)
      localStorage.removeItem("attair_guest_scans");
      setGuestScans(0);
      // Persist onboarding inspirations if stored
      if (authScreen === "signup") {
        try {
          const storedInspo = JSON.parse(localStorage.getItem("attair_inspirations") || "[]");
          const storedGender = localStorage.getItem("attair_ob_gender");
          if (storedInspo.length > 0 || storedGender) {
            API.updateProfile({
              ...(storedInspo.length > 0 && { style_interests: storedInspo }),
              ...(storedGender && { gender_pref: storedGender }),
            }).catch(() => {});
          }
        } catch {}
      }
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
    if (isGuest) {
      if (guestScans >= 3) {
        setSignupPrompt("scan_limit");
        return false;
      }
      return true;
    }
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
    setCropPending(null);
    setCropMode(false);
    setCircleSearchActive(false);
    setPriorityRegionBase64(null);
    setCircleConfirmed(false);
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
      const raw = isGuest
        ? await API.guestIdentify(base64, mime, priorityRegionBase64)
        : await API.identifyClothing(base64, mime, prefs, priorityRegionBase64);
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
      // Auto-select circled (priority) items so user sees their intent pre-picked
      const priorityPicks = new Set();
      items.forEach((item, i) => { if (item.priority) priorityPicks.add(i); });
      if (priorityPicks.size > 0) setPickedItems(priorityPicks);
      setPhase("picking"); // Stop here — let user choose which items to search
      track("scan_completed", { item_count: items.length, gender: raw.gender, guest: isGuest }, raw.scan_id, "scan");

      if (isGuest) {
        // Increment guest scan counter
        const newCount = guestScans + 1;
        setGuestScans(newCount);
        localStorage.setItem("attair_guest_scans", String(newCount));
      } else {
        // Update status (scan count changed) — optimistic local update + server confirm
        setUserStatus(prev => prev ? { ...prev, scans_remaining_today: Math.max(0, (prev.scans_remaining_today ?? 12) - 1) } : prev);
        refreshStatus();
      }

      // Show interstitial ad for free users (skip on first-ever scan — don't be hostile)
      if (!isGuest && showAds && scansLeft < 2) {
        setShowInterstitial(true);
      }
      if (!isGuest && showAds && scansLeft <= 1) {
        setTimeout(() => setUpgradeModal("ad_fatigue"), 800);
      }
    } catch (err) {
      setPhase("idle");
      if (isGuest && (err.message.includes("Guest scan limit") || err.message.includes("sign up") || err.message.includes("Sign up"))) {
        setSignupPrompt("scan_limit");
        return;
      }
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
    setRevealedSearchItems(new Set()); // Reset staggered reveals
    setPhase("searching");
    setResults(prev => prev ? {
      ...prev,
      items: prev.items.map((it, i) => pickedItems.has(i) ? { ...it, status: "searching" } : it)
    } : prev);
    setSelIdx(pickedIndices[0]); // Auto-select first picked item

    let searchFailed = false;
    try {
      const searchResults = isGuest
        ? await API.guestFindProducts(picked, results.gender, searchMode)
        : await API.findProducts(picked, results.gender, scanId, occasion, searchNotes || null, searchMode);
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
      searchFailed = true;
      console.error("Product search failed:", err);
      setResults(prev => prev ? { ...prev, items: prev.items.map(it => it.status === "searching" ? { ...it, status: "failed" } : it) } : prev);
      if (err.message.includes("limit") || err.message.includes("Limit") || err.message.includes("Deep Search") || err.message.includes("Fast Search")) {
        setUpgradeModal("search_limit");
        setError(err.message);
        refreshStatus();
      } else {
        setError(t("search_failed") || "Search failed. Please try refining your items and searching again.");
      }
    }

    // Staggered reveal for first-time search takeover (not re-search)
    if (!wasAlreadySearched && !searchFailed) {
      for (let k = 0; k < pickedIndices.length; k++) {
        await new Promise(r => setTimeout(r, 400));
        setRevealedSearchItems(prev => new Set([...prev, pickedIndices[k]]));
      }
      await new Promise(r => setTimeout(r, 800));
    }

    setPhase("done");
    setIsResearch(false);
    // Refresh status to update search remaining counts
    if (!isGuest && !searchFailed) refreshStatus();
    // Auto-expand first picked item in results
    setExpandedItems(new Set([pickedIndices[0]]));
    // Auto-switch picked items to "shop" view once search completes
    setItemViewModes(prev => {
      const next = { ...prev };
      [...pickedItems].forEach(idx => { next[idx] = "shop"; });
      return next;
    });

    // Post-first-scan preference sheet — show once after the user's very first scan (authed only)
    if (!isGuest && !localStorage.getItem("attair_pref_sheet_shown")) {
      setTimeout(() => {
        setShowPrefSheet(true);
        localStorage.setItem("attair_pref_sheet_shown", "1");
      }, 1200);
    }

    // Guest post-scan signup nudge — show after 2nd scan with a compelling message
    if (isGuest && guestScans >= 2) {
      setTimeout(() => setSignupPrompt("post_scan"), 2000);
    }

    // Refresh history + saved so those tabs are up to date (authed only)
    if (!isGuest) {
      API.getHistory().then(d => setHistory(d.scans || [])).catch(() => {});
      API.getSaved().then(d => setSaved(d.items || [])).catch(() => {});
    }

    // Schedule a follow-up nudge (10-15 min) so if the user leaves without
    // saving or refining, we ping them back with a push notification
    if (!isGuest && scanId && !searchFailed) {
      const firstName = results?.items?.[pickedIndices[0]]?.name;
      API.scheduleNudge(scanId, "scan_results", firstName || null);
      nudgeScheduledRef.current = scanId;
    }
  };

  const reset = () => { if (nudgeScheduledRef.current) { API.cancelNudge(nudgeScheduledRef.current); nudgeScheduledRef.current = null; } setNudgeBanner(null); setImg(null); setResults(null); setSelIdx(null); setPickedItems(new Set()); setError(null); setPhase("idle"); setScanId(null); setItemOverrides({}); setItemSettingsIdx(null); setItemViewModes({}); setItemChats({}); setItemMemories({}); setRefineInputs({}); setRefineLoadings({}); setPairings(null); setPairingsLoading(false); setSeenOnData({}); setNearbyData({}); setOccasion(null); setSearchNotes(""); setIdentPreview(null); setCircleSearchActive(false); setPriorityRegionBase64(null); setCircleConfirmed(false); setIsResearch(false); setShowAdvanced(false); setExpandedItems(new Set()); setShowAllPickItems(false); };

  // ─── AI item refinement ────────────────────────────────────
  const handleRefine = async (itemIdx) => {
    const msg = (refineInputs[itemIdx] || "").trim();
    if (!msg || refineLoadings[itemIdx]) return;
    // User is actively engaging — cancel any pending nudge
    if (nudgeScheduledRef.current) {
      API.cancelNudge(nudgeScheduledRef.current);
      nudgeScheduledRef.current = null;
      setNudgeBanner(null);
    }
    const item = results.items[itemIdx];
    const chat = itemChats[itemIdx] || [];
    const memory = itemMemories[itemIdx] || null;
    setRefineLoadings(l => ({ ...l, [itemIdx]: true }));
    setRefineInputs(i => ({ ...i, [itemIdx]: "" }));
    try {
      const res = await API.refineItem(scanId, itemIdx, item, msg, chat, results.gender, memory);
      const newChat = [...chat, { role: "user", content: msg }, { role: "assistant", content: res.ai_message || "Updated." }];
      setItemChats(c => ({ ...c, [itemIdx]: newChat }));
      // Update memory from response — this replaces reliance on full chat history
      if (res.memory) {
        setItemMemories(m => ({ ...m, [itemIdx]: res.memory }));
        // Persist memory to localStorage for session recovery
        try {
          const key = `attaire_mem_${scanId}`;
          const stored = JSON.parse(localStorage.getItem(key) || "{}");
          stored[itemIdx] = res.memory;
          localStorage.setItem(key, JSON.stringify(stored));
        } catch { /* localStorage quota exceeded — non-critical */ }
      }
      // Merge updated_item fields, preserving status/tiers
      setResults(prev => {
        if (!prev) return prev;
        const items = prev.items.map((it, i) => i === itemIdx ? { ...it, ...res.updated_item, status: it.status, tiers: res.new_tiers || it.tiers } : it);
        return { ...prev, items };
      });
      // Auto-switch to shop if new tiers came back
      if (res.new_tiers) setItemViewModes(m => ({ ...m, [itemIdx]: "shop" }));
      track("item_refined", { item_index: itemIdx, memory_turns: res.memory?.turn_count || 0 }, scanId, "scan");
    } catch (err) {
      setItemChats(c => ({ ...c, [itemIdx]: [...(c[itemIdx] || []), { role: "user", content: msg }, { role: "assistant", content: "Sorry, I couldn't process that. Try rephrasing." }] }));
    }
    setRefineLoadings(l => ({ ...l, [itemIdx]: false }));
  };

  // ─── Refresh looks data (debounced) ────────────────────────
  const refreshLooks = useCallback(() => {
    API.getLooks().then(d => setLooks(d.looks || [])).catch(() => {});
  }, []);

  // ─── Save with backend persistence ────────────────────────
  const toggleSave = async (item) => {
    if (isGuest) { setSignupPrompt("save"); return; }
    // User is engaging — cancel pending nudge
    if (nudgeScheduledRef.current) { API.cancelNudge(nudgeScheduledRef.current); nudgeScheduledRef.current = null; setNudgeBanner(null); }
    const existing = saved.find(i => (i.item_data || i).name === item.name);
    if (existing) {
      await API.deleteSaved(existing.id).catch(() => {});
      setSaved(s => s.filter(i => i.id !== existing.id));
      refreshStatus();
      refreshLooks();
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
        refreshLooks();
        track("item_saved", { item_name: item.name }, scanId, "scan");
        // Check if a Style Twin also saved this (non-blocking)
        if (item.name) {
          API.checkSharedSave(item.name).then(d => {
            if (d.match) {
              setStyleTwinSaveBanner({ message: d.message, twin_name: d.twin_name });
              setTimeout(() => setStyleTwinSaveBanner(null), 5000);
            }
          }).catch(() => {});
        }
      } catch (err) {
        if (err.message.includes("limit")) setUpgradeModal("save_limit");
      }
    }
  };
  const isSaved = (item) => saved.some(i => (i.item_data || i).name === item.name);

  // ─── Toggle scan visibility (public/private) ──────────────
  const toggleVisibility = async (e, scan) => {
    e.stopPropagation();
    const newVis = scan.visibility === "public" ? "private" : "public";
    // Optimistic update
    setHistory(prev => prev.map(s => s.id === scan.id ? { ...s, visibility: newVis } : s));
    setProfileScanOverlay(prev => prev?.id === scan.id ? { ...prev, visibility: newVis } : prev);
    try {
      await API.updateScanVisibility(scan.id, newVis);
    } catch {
      // Revert on failure
      setHistory(prev => prev.map(s => s.id === scan.id ? { ...s, visibility: scan.visibility } : s));
      setProfileScanOverlay(prev => prev?.id === scan.id ? { ...prev, visibility: scan.visibility } : prev);
    }
  };

  // ─── One-tap heart save from product cards ─────────────────
  const quickSaveItem = async (item, scanIdOverride) => {
    if (isGuest) { setSignupPrompt("save"); return; }
    const sid = scanIdOverride || scanId;
    const existing = saved.find(i => (i.item_data || i).name === item.name);
    if (existing) {
      await API.deleteSaved(existing.id).catch(() => {});
      setSaved(s => s.filter(i => i.id !== existing.id));
      refreshStatus();
      refreshLooks();
    } else {
      if (isFree && (userStatus?.saved_count || 0) >= (userStatus?.saved_limit || 20)) {
        setUpgradeModal("save_limit");
        return;
      }
      try {
        const res = await API.saveItem(sid, item);
        setSaved(s => [...s, { id: res.id, item_data: item, scan_id: sid, created_at: new Date().toISOString() }]);
        refreshStatus();
        refreshLooks();
        track("item_saved", { item_name: item.name }, sid, "scan");
        // Check if a Style Twin also saved this (non-blocking)
        if (item.name) {
          API.checkSharedSave(item.name).then(d => {
            if (d.match) {
              setStyleTwinSaveBanner({ message: d.message, twin_name: d.twin_name });
              setTimeout(() => setStyleTwinSaveBanner(null), 5000);
            }
          }).catch(() => {});
        }
      } catch (err) {
        if (err.message?.includes("limit")) setUpgradeModal("save_limit");
      }
    }
  };

  const brandConfLabel = (c) => ({ confirmed: { t: "Confirmed", c: "#C9A96E" }, high: { t: "High confidence", c: "rgba(201,169,110,0.7)" }, moderate: { t: "Moderate", c: "rgba(255,255,255,0.4)" }, low: { t: "Estimated", c: "rgba(255,255,255,0.25)" } }[c] || { t: "Unknown", c: "rgba(255,255,255,0.2)" });

  const handleLogout = () => { trackBeacon("logout", {}); Auth.clear(); setAuthed(false); setAuthEmail(""); setAuthName(""); setAuthAvatarUrl(null); setUserStatus(null); setScreen("onboarding"); setObIdx(0); };

  const step = OB_STEPS[obIdx];
  const prog = ((obIdx + 1) / OB_STEPS.length) * 100;

  return (<>
    {/* Styles moved to App.css — imported at top of file */}
    {/* REMOVED: ~690 lines of inline <style> */}

    <div className="app" data-theme={["onboarding","inspo","paywall","auth"].includes(screen) ? "dark" : theme}>
      {/* ─── ONBOARDING (TikTok-speed visual demo) ──────── */}
      {screen === "onboarding" && (
        <OnboardingDemo
          fade={fade}
          onGetStarted={() => obNext()}
          onLogin={() => { setScreen("auth"); setAuthScreen("login"); }}
        />
      )}

      {/* ─── INSPIRATION PICKER ────────────────────────── */}
      {screen === "inspiration" && (
        <InspirationPicker
          fade={fade}
          onContinue={(picks, gender) => {
            setPrefs(p => ({ ...p, gender }));
            if (authed) {
              API.updateProfile({ style_interests: picks, gender_pref: gender }).catch(() => {});
            }
            trans(() => setScreen("app"));
          }}
          onSkip={() => trans(() => setScreen("app"))}
        />
      )}

      {/* ─── PAYWALL ─────────────────────────────────────── */}
      {screen === "paywall" && (
        <div className={`pw ${fade}`}>
          <button className="pw-skip" onClick={() => trans(() => setScreen(authed ? "app" : "auth"))}>{authed ? "Maybe later" : "Skip — start free"}</button>
          <div className="pw-badge">✦ LIMITED OFFER</div>
          <h1 className="pw-t">Unlock unlimited<br />outfit scans</h1>
          <p className="pw-st">Unlimited scans, zero ads, and priority results. Three price options for every item.</p>
          <div className="pw-fs">
            {["Unlimited AI outfit scans","Completely ad-free experience","Web-verified product links","Price drop alerts on saved items","Full scan history forever"].map((f,i) => <div className="pw-f" key={i}><div className="pw-ck">✓</div>{f}</div>)}
          </div>
          <div className="pw-plans">
            <div className={`pw-p ${selPlan==="yearly"?"sel":""}`} onClick={() => setSelPlan("yearly")}><div className="pw-ptag">BEST VALUE · SAVE 50%</div><div className="pw-pp">$29.99<span className="pw-pd"> /year</span></div><div className="pw-pw">$0.58/week</div></div>
            <div className={`pw-p ${selPlan==="monthly"?"sel":""}`} onClick={() => setSelPlan("monthly")}><div className="pw-pp">$4.99<span className="pw-pd"> /mo</span></div><div className="pw-pw">$1.25/week</div></div>
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
            {authed ? (upgradeLoading ? "Loading..." : `Start Pro — ${selPlan === "yearly" ? "$29.99/yr" : "$4.99/mo"}`) : "Get started"}
          </button>
          <div className="pw-terms">12 free scans per month. Upgrade anytime.</div>
        </div>
      )}

      {/* ─── AUTH (Login / Signup) ────────────────────────── */}
      {screen === "auth" && (
        <div className={`auth ${fade}`}>
          <div style={{ textAlign: "center", marginBottom: 28 }}>
            <svg width="32" height="32" viewBox="0 0 100 100" style={{ display: "block", margin: "0 auto 8px" }}><path d="M34.5,2.4 L65.5,2.4 L65,24 L83.5,12.8 L98.9,39.6 L80,50 L98.9,60.4 L83.5,87.2 L65,76 L65.5,97.6 L34.5,97.6 L35,76 L16.5,87.2 L1.1,60.4 L20,50 L1.1,39.6 L16.5,12.8 L35,24 Z" fill="#C9A96E"/></svg>
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
            {authLoading ? "Loading..." : authScreen === "signup" ? "Create Account" : "Log In"}
          </button>
          <button className="auth-toggle" onClick={() => { setAuthScreen(authScreen === "login" ? "signup" : "login"); setAuthErr(null); setShowPass(false); }}>
            {authScreen === "login" ? "Don't have an account? Sign up" : "Already have an account? Log in"}
          </button>
          {guestScans > 0 && (
            <button style={{ background: "none", border: "none", color: "var(--text-tertiary)", fontSize: 12, cursor: "pointer", fontFamily: "var(--font-sans)", padding: "8px 0", marginTop: 4, minHeight: 44 }}
              onClick={() => trans(() => setScreen("app"))}>
              Continue browsing
            </button>
          )}
        </div>
      )}

      {/* ─── CAMERA removed — native file picker only ─── */}

      {/* ─── INTERSTITIAL AD (free users, post-scan) ─────── */}
      {showInterstitial && showAds && (
        <InterstitialAd onClose={() => setShowInterstitial(false)} />
      )}

      {/* ─── DUPE FINDER MODAL ─────────────────────────── */}
      {dupeModal && (
        <div className="modal-overlay" onClick={() => { setDupeModal(null); setDupeResults(null); setDupeError(null); }} style={{ zIndex: 350 }}>
          <div onClick={e => e.stopPropagation()} style={{
            width: "100%", maxWidth: 420, maxHeight: "90vh", background: "var(--bg-secondary)",
            borderRadius: 24, overflow: "hidden", position: "relative",
            display: "flex", flexDirection: "column",
            animation: "slideIn .3s ease", border: "1px solid var(--border)",
          }}>
            {/* Header */}
            <div style={{ padding: "16px 20px", borderBottom: "1px solid var(--border)", display: "flex", alignItems: "center", justifyContent: "space-between", flexShrink: 0 }}>
              <div>
                <div style={{ fontSize: 16, fontWeight: 700, color: "var(--text-primary)", fontFamily: "var(--font-sans)" }}>Similar Look</div>
                <div style={{ fontSize: 11, color: "var(--text-tertiary)", marginTop: 2 }}>
                  {dupeModal.product.product_name?.slice(0, 40)}{dupeModal.product.product_name?.length > 40 ? "..." : ""}
                </div>
              </div>
              <button onClick={() => { setDupeModal(null); setDupeResults(null); setDupeError(null); }}
                style={{ width: 36, height: 36, borderRadius: "50%", background: "var(--bg-input)", border: "1px solid var(--border)", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", color: "var(--text-tertiary)", fontSize: 16, fontFamily: "var(--font-sans)" }}>
                ✕
              </button>
            </div>

            {/* Content area */}
            <div style={{ flex: 1, overflowY: "auto", padding: "0 0 16px" }}>
              {/* Loading state */}
              {dupeLoading && (
                <div style={{ padding: "60px 24px", textAlign: "center" }}>
                  <div className="ld-dot" style={{ width: 12, height: 12, background: "#4CAF50", margin: "0 auto 20px" }} />
                  <div style={{ fontSize: 16, fontWeight: 600, color: "var(--text-primary)", marginBottom: 6 }}>Hunting similar looks...</div>
                  <div style={{ fontSize: 12, color: "var(--text-tertiary)" }}>Searching for visually similar styles at lower prices</div>
                </div>
              )}

              {/* Error state */}
              {dupeError && (
                <div style={{ padding: "48px 24px", textAlign: "center" }}>
                  <div style={{ fontSize: 32, marginBottom: 12 }}>😕</div>
                  <div style={{ fontSize: 14, fontWeight: 600, color: "var(--text-primary)", marginBottom: 6 }}>Search failed</div>
                  <div style={{ fontSize: 12, color: "var(--text-tertiary)", marginBottom: 16 }}>{dupeError}</div>
                  <button onClick={() => { setDupeError(null); openDupeModal({ product_name: dupeModal.product.product_name, price: `$${dupeModal.product.price}`, image_url: dupeModal.product.image_url }, { name: dupeModal.product.product_name, category: dupeModal.product.category, color: "", material: "", subcategory: "", fit: "", construction_details: "" }, dupeModal.tierKey); }}
                    style={{ padding: "10px 20px", background: "#4CAF50", color: "#fff", border: "none", borderRadius: 10, fontSize: 13, fontWeight: 600, cursor: "pointer", fontFamily: "var(--font-sans)" }}>
                    Try Again
                  </button>
                </div>
              )}

              {/* Empty state — no dupes found */}
              {dupeResults && dupeResults.dupes.length === 0 && (
                <div style={{ padding: "48px 24px", textAlign: "center" }}>
                  <div style={{ fontSize: 32, marginBottom: 12 }}>🔍</div>
                  <div style={{ fontSize: 14, fontWeight: 600, color: "var(--text-primary)", marginBottom: 6 }}>No similar looks found</div>
                  <div style={{ fontSize: 12, color: "var(--text-tertiary)", lineHeight: 1.5 }}>
                    We couldn't find visually similar alternatives at a lower price point for this item. Try again later — new products are added constantly.
                  </div>
                </div>
              )}

              {/* Results — swipeable dupe comparison cards */}
              {dupeResults && dupeResults.dupes.length > 0 && (
                <>
                  {/* Dupe count + swipe hint */}
                  <div style={{ padding: "12px 20px 8px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                    <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: 1, color: "#4CAF50", textTransform: "uppercase" }}>
                      {dupeResults.dupes.length} match{dupeResults.dupes.length > 1 ? "es" : ""} found
                    </span>
                    {dupeResults.dupes.length > 1 && (
                      <span style={{ fontSize: 10, color: "var(--text-tertiary)" }}>
                        {dupeSlide + 1}/{dupeResults.dupes.length} · Swipe →
                      </span>
                    )}
                  </div>

                  {/* Swipeable card container */}
                  <div
                    ref={dupeScrollRef}
                    onScroll={e => {
                      const el = e.target;
                      const cardW = el.scrollWidth / dupeResults.dupes.length;
                      setDupeSlide(Math.round(el.scrollLeft / cardW));
                    }}
                    style={{
                      display: "flex", overflowX: "auto", scrollSnapType: "x mandatory",
                      WebkitOverflowScrolling: "touch", msOverflowStyle: "none", scrollbarWidth: "none",
                      paddingLeft: 16, paddingRight: 16, gap: 12,
                    }}
                  >
                    {dupeResults.dupes.map((dupe, di) => (
                      <div key={di} style={{
                        flexShrink: 0, width: "calc(100% - 32px)", scrollSnapAlign: "center",
                        background: "var(--bg-card)", border: "1px solid var(--border)",
                        borderRadius: 16, overflow: "hidden",
                      }}>
                        {/* Side-by-side comparison */}
                        <div style={{ display: "flex", gap: 0, position: "relative" }}>
                          {/* Original (left) */}
                          <div style={{ flex: 1, borderRight: "1px solid var(--border)" }}>
                            <div style={{ fontSize: 8, fontWeight: 700, letterSpacing: 1.2, textTransform: "uppercase", textAlign: "center", padding: "8px 0 4px", color: "var(--text-tertiary)" }}>ORIGINAL</div>
                            <div style={{ aspectRatio: "3/4", background: "var(--bg-input)", overflow: "hidden" }}>
                              {dupeResults.original.image_url ? (
                                <img src={dupeResults.original.image_url} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} onError={e => { e.target.style.display = "none"; }} />
                              ) : (
                                <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-tertiary)", fontSize: 11 }}>No image</div>
                              )}
                            </div>
                            <div style={{ padding: "10px 8px", textAlign: "center" }}>
                              <div style={{ fontSize: 11, fontWeight: 500, color: "var(--text-secondary)", overflow: "hidden", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", lineHeight: 1.3, marginBottom: 4 }}>
                                {dupeResults.original.name}
                              </div>
                              <div style={{ fontSize: 18, fontWeight: 700, color: "var(--text-primary)" }}>${Math.round(dupeResults.original.price)}</div>
                            </div>
                          </div>

                          {/* Savings badge (center divider) */}
                          <div style={{ position: "absolute", left: "50%", top: "50%", transform: "translate(-50%, -80%)", zIndex: 2 }}>
                            <div style={{
                              width: 52, height: 52, borderRadius: "50%", background: "#4CAF50",
                              display: "flex", alignItems: "center", justifyContent: "center", flexDirection: "column",
                              boxShadow: "0 4px 16px rgba(76,175,80,0.4)", border: "3px solid var(--bg-card)",
                            }}>
                              <div style={{ fontSize: 13, fontWeight: 800, color: "#fff", lineHeight: 1 }}>{dupe.savings_pct}%</div>
                              <div style={{ fontSize: 7, fontWeight: 600, color: "rgba(255,255,255,.7)", letterSpacing: 0.5 }}>OFF</div>
                            </div>
                          </div>

                          {/* Dupe (right) */}
                          <div style={{ flex: 1, position: "relative" }}>
                            <div style={{ fontSize: 8, fontWeight: 700, letterSpacing: 1.2, textTransform: "uppercase", textAlign: "center", padding: "8px 0 4px", color: "#4CAF50" }}>SIMILAR LOOK</div>
                            <div style={{ aspectRatio: "3/4", background: "var(--bg-input)", overflow: "hidden" }}>
                              {dupe.image_url ? (
                                <img src={dupe.image_url} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} onError={e => { e.target.style.display = "none"; }} />
                              ) : (
                                <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-tertiary)", fontSize: 11 }}>No image</div>
                              )}
                            </div>
                            <div style={{ padding: "10px 8px", textAlign: "center" }}>
                              <div style={{ fontSize: 11, fontWeight: 500, color: "var(--text-secondary)", overflow: "hidden", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", lineHeight: 1.3, marginBottom: 4 }}>
                                {dupe.product_name}
                              </div>
                              <div style={{ fontSize: 18, fontWeight: 700, color: "#4CAF50" }}>{dupe.price}</div>
                              <div style={{ fontSize: 10, color: "var(--text-tertiary)", marginTop: 2 }}>{dupe.store}</div>
                            </div>
                          </div>
                        </div>

                        {/* Similarity score bar */}
                        {dupe.similarity_score && (
                          <div style={{ padding: "0 12px 8px" }}>
                            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}>
                              <span style={{ fontSize: 9, fontWeight: 600, color: "var(--text-tertiary)", letterSpacing: 0.3 }}>Visual Match</span>
                              <span style={{ fontSize: 9, fontWeight: 700, color: dupe.similarity_score >= 80 ? "#4CAF50" : dupe.similarity_score >= 60 ? "#C9A96E" : "var(--text-tertiary)" }}>{dupe.similarity_score}%</span>
                            </div>
                            <div style={{ height: 3, borderRadius: 2, background: "var(--bg-input)", overflow: "hidden" }}>
                              <div style={{ height: "100%", borderRadius: 2, width: `${dupe.similarity_score}%`, background: dupe.similarity_score >= 80 ? "#4CAF50" : dupe.similarity_score >= 60 ? "#C9A96E" : "var(--text-tertiary)", transition: "width .5s ease" }} />
                            </div>
                            {dupe.similarity_reason && (
                              <div style={{ fontSize: 9, color: "var(--text-tertiary)", marginTop: 4, lineHeight: 1.3, fontStyle: "italic" }}>
                                {dupe.similarity_reason}
                              </div>
                            )}
                          </div>
                        )}

                        {/* Action buttons */}
                        <div style={{ padding: "8px 12px 12px", display: "flex", gap: 8 }}>
                          <a
                            href={dupe.url || "#"}
                            target="_blank"
                            rel="noopener noreferrer"
                            onClick={() => track("dupe_shop_clicked", { product_name: dupe.product_name, store: dupe.store, price: dupe.price, savings_pct: dupe.savings_pct }, scanId, "scan")}
                            style={{
                              flex: 1, padding: "10px 16px", background: "#4CAF50", color: "#fff",
                              border: "none", borderRadius: 10, fontSize: 13, fontWeight: 700,
                              textAlign: "center", textDecoration: "none", fontFamily: "var(--font-sans)",
                              display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
                              transition: "all .2s",
                            }}
                          >
                            Shop
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
                          </a>
                          <button
                            onClick={() => generateDupeShareCard(dupeResults.original, dupe)}
                            disabled={dupeShareLoading}
                            style={{
                              padding: "10px 16px", background: "var(--bg-input)", color: "var(--text-secondary)",
                              border: "1px solid var(--border)", borderRadius: 10, fontSize: 13, fontWeight: 600,
                              cursor: dupeShareLoading ? "wait" : "pointer", fontFamily: "var(--font-sans)",
                              display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
                              transition: "all .2s", opacity: dupeShareLoading ? 0.6 : 1,
                            }}
                          >
                            {dupeShareLoading ? (
                              <div className="ld-dot" style={{ width: 6, height: 6, background: "var(--text-secondary)" }} />
                            ) : (
                              <>
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>
                                Share
                              </>
                            )}
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>

                  {/* Dot indicators */}
                  {dupeResults.dupes.length > 1 && (
                    <div style={{ display: "flex", justifyContent: "center", gap: 6, padding: "12px 0 4px" }}>
                      {dupeResults.dupes.map((_, di) => (
                        <div key={di} style={{
                          width: di === dupeSlide ? 16 : 6, height: 6, borderRadius: 3,
                          background: di === dupeSlide ? "#4CAF50" : "var(--border)",
                          transition: "all .2s",
                        }} />
                      ))}
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        </div>
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

      {/* ─── SIGNUP PROMPT (guest users) ────────────────── */}
      {signupPrompt && (
        <div className="modal-overlay" onClick={() => setSignupPrompt(null)}>
          <div className="modal-box" onClick={e => e.stopPropagation()} style={{ textAlign: "center", padding: "32px 24px" }}>
            <button className="modal-x" onClick={() => setSignupPrompt(null)}>✕</button>
            <div style={{ fontSize: 40, marginBottom: 16 }}>
              {signupPrompt === "scan_limit" ? "✦" : signupPrompt === "save" ? "♡" : signupPrompt === "social" ? "👥" : "✦"}
            </div>
            <h2 className="modal-title" style={{ fontSize: 22, marginBottom: 8 }}>
              {signupPrompt === "scan_limit" ? "You're on a roll!"
                : signupPrompt === "save" ? "Save your favorites"
                : signupPrompt === "social" ? "Join the community"
                : "Loving what you see?"}
            </h2>
            <p className="modal-sub" style={{ marginBottom: 24, lineHeight: 1.5 }}>
              {signupPrompt === "scan_limit"
                ? "Create a free account to keep scanning outfits — you get 12 scans per month, plus save items and build wishlists."
                : signupPrompt === "save"
                ? "Sign up for free to save items, create wishlists, and get price drop alerts on your favorites."
                : signupPrompt === "social"
                ? "Create a free account to follow other stylists, share your looks, and build your style profile."
                : "Sign up for free to save your results, unlock more scans, and get personalized recommendations."}
            </p>
            <button className="cta" style={{ width: "100%", marginBottom: 12 }} onClick={() => {
              setSignupPrompt(null);
              trans(() => { setScreen("auth"); setAuthScreen("signup"); });
            }}>
              Create Free Account
            </button>
            <button style={{ background: "none", border: "none", color: "var(--text-tertiary)", fontSize: 13, cursor: "pointer", fontFamily: "var(--font-sans)", padding: "8px 0", minHeight: 44 }}
              onClick={() => setSignupPrompt(null)}>
              Maybe later
            </button>
          </div>
        </div>
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
          Welcome to ATTAIRE Pro!
        </div>
      )}

      {/* ─── TRIAL SUCCESS BANNER ────────────────────────── */}
      {trialSuccess && (
        <div style={{ position: "fixed", top: 16, left: "50%", transform: "translateX(-50%)", background: "var(--accent)", color: "var(--text-inverse)", padding: "12px 24px", borderRadius: 12, fontWeight: 700, fontSize: 14, zIndex: 9999, boxShadow: "0 8px 32px rgba(0,0,0,.4)", whiteSpace: "nowrap" }}>
          ✓ 7-day free trial started!
        </div>
      )}

      {/* ─── FOLLOW-UP NUDGE BANNER ────────────────────── */}
      {nudgeBanner && screen === "app" && (
        <div className="animate-slide-up" style={{ position: "fixed", top: 56, left: 12, right: 12, background: "linear-gradient(135deg, rgba(201,169,110,.12), rgba(201,169,110,.04))", backdropFilter: "blur(20px)", WebkitBackdropFilter: "blur(20px)", border: "1px solid rgba(201,169,110,.25)", borderRadius: 16, padding: "14px 16px", zIndex: 9997, display: "flex", gap: 12, alignItems: "center", boxShadow: "0 8px 32px rgba(0,0,0,.3)" }}>
          <div style={{ width: 36, height: 36, borderRadius: 12, background: "rgba(201,169,110,.15)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg>
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: "var(--text-primary)", marginBottom: 2 }}>
              {nudgeBanner.context === "refinement" ? "Your AI stylist is waiting" : "Your results are ready"}
            </div>
            <div style={{ fontSize: 11, color: "var(--text-secondary)", lineHeight: 1.4 }}>
              {nudgeBanner.context === "refinement"
                ? "Tap to continue refining your outfit picks."
                : "Swipe through your matches and save your favorites."}
            </div>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 4, flexShrink: 0 }}>
            <button onClick={() => { setNudgeBanner(null); setTab("scan"); }} style={{ background: "var(--accent)", color: "#000", border: "none", borderRadius: 100, padding: "6px 14px", fontSize: 11, fontWeight: 700, cursor: "pointer", whiteSpace: "nowrap" }}>View</button>
            <button onClick={() => setNudgeBanner(null)} style={{ background: "none", border: "none", color: "var(--text-tertiary)", fontSize: 9, cursor: "pointer", padding: "2px 0" }}>Dismiss</button>
          </div>
        </div>
      )}

      {/* ─── Style Twin Save Banner ────────────────────── */}
      {styleTwinSaveBanner && screen === "app" && (
        <div className="animate-slide-up style-twin-save-toast" onClick={() => setStyleTwinSaveBanner(null)}>
          <div style={{ width: 36, height: 36, borderRadius: 12, background: "rgba(201,169,110,.15)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="var(--accent)" strokeWidth="2"><circle cx="9" cy="7" r="3"/><circle cx="15" cy="7" r="3"/><path d="M3 21c0-3.31 2.69-6 6-6h0c1.1 0 2.12.3 3 .82A5.98 5.98 0 0115 15h0c3.31 0 6 2.69 6 6"/></svg>
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: "var(--text-primary)", marginBottom: 2 }}>Style Twin Match!</div>
            <div style={{ fontSize: 11, color: "var(--text-secondary)", lineHeight: 1.4 }}>{styleTwinSaveBanner.message}</div>
          </div>
          <button onClick={() => { setStyleTwinSaveBanner(null); setTab("search"); setSearchSubTab("twins"); if (authed && !styleTwinsLoadingRef.current) { setStyleTwinsLoading(true); loadStyleTwins(); } }} style={{ background: "var(--accent)", color: "#000", border: "none", borderRadius: 100, padding: "6px 14px", fontSize: 11, fontWeight: 700, cursor: "pointer", whiteSpace: "nowrap", flexShrink: 0 }}>View Twins</button>
        </div>
      )}

      {/* ─── Style Twin Comparison Sheet ─────────────────── */}
      {styleTwinCompare && (
        <>
          <div className="bottom-sheet-overlay" onClick={() => setStyleTwinCompare(null)} />
          <div className="bottom-sheet style-twin-compare-sheet" role="dialog" aria-label="Style comparison" aria-modal="true">
            <div className="bottom-sheet-handle" />
            {/* Header */}
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20 }}>
              <div style={{ fontSize: 18, fontWeight: 700, color: "var(--text-primary)" }}>Style Comparison</div>
              <button onClick={() => setStyleTwinCompare(null)} aria-label="Close comparison" style={{ width: 32, height: 32, display: "flex", alignItems: "center", justifyContent: "center", background: "none", border: "none", cursor: "pointer", borderRadius: "50%", color: "var(--text-secondary)" }}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
              </button>
            </div>

            {/* Match circle */}
            <div style={{ display: "flex", justifyContent: "center", marginBottom: 24 }}>
              <div className="style-twin-compare-ring">
                <span className="style-twin-compare-pct">{styleTwinCompare.match_pct}%</span>
                <span style={{ fontSize: 11, color: "var(--text-tertiary)" }}>match</span>
              </div>
            </div>

            {/* Two profiles side by side */}
            <div style={{ display: "flex", justifyContent: "center", gap: 32, marginBottom: 24 }}>
              <div style={{ textAlign: "center" }}>
                <div className="style-twin-avatar-sm" style={{ margin: "0 auto 8px", width: 48, height: 48 }}>
                  <span style={{ fontSize: 16 }}>{(user?.display_name || "You").split(" ").map(w => w[0]).join("").slice(0,2).toUpperCase()}</span>
                </div>
                <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text-primary)" }}>You</div>
                {styleTwinsMyArchetype && <div style={{ fontSize: 11, color: "var(--accent)", fontWeight: 500, marginTop: 2 }}>{styleTwinsMyArchetype}</div>}
              </div>
              <div style={{ textAlign: "center" }}>
                <div className="style-twin-avatar-sm" style={{ margin: "0 auto 8px", width: 48, height: 48 }}>
                  {styleTwinCompare.avatar_url ? (
                    <img src={styleTwinCompare.avatar_url} alt="" style={{ width: "100%", height: "100%", objectFit: "cover", borderRadius: "50%" }} />
                  ) : (
                    <span style={{ fontSize: 16 }}>{(styleTwinCompare.display_name || "?").split(" ").map(w => w[0]).join("").slice(0,2).toUpperCase()}</span>
                  )}
                </div>
                <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text-primary)" }}>{styleTwinCompare.display_name || "Anonymous"}</div>
                {styleTwinCompare.archetype && <div style={{ fontSize: 11, color: "var(--accent)", fontWeight: 500, marginTop: 2 }}>{styleTwinCompare.archetype}</div>}
              </div>
            </div>

            {/* Style Score Comparison Bars */}
            {styleTwinsMyScore && styleTwinCompare.style_score && (
              <div style={{ marginBottom: 24 }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: "var(--text-tertiary)", textTransform: "uppercase", letterSpacing: 1, marginBottom: 14 }}>Style DNA Comparison</div>
                {[
                  { key: "classic_vs_trendy", low: "Classic", high: "Trendy" },
                  { key: "minimal_vs_maximal", low: "Minimal", high: "Maximal" },
                  { key: "casual_vs_formal", low: "Casual", high: "Formal" },
                  { key: "budget_vs_luxury", low: "Budget", high: "Luxury" },
                ].map(({ key, low, high }) => {
                  const myVal = styleTwinsMyScore[key] ?? 5;
                  const theirVal = styleTwinCompare.style_score[key] ?? 5;
                  const myPct = ((myVal - 1) / 9) * 100;
                  const theirPct = ((theirVal - 1) / 9) * 100;
                  return (
                    <div key={key} className="style-twin-compare-axis">
                      <div className="style-twin-compare-axis-labels">
                        <span>{low}</span>
                        <span>{high}</span>
                      </div>
                      <div className="style-twin-compare-axis-track">
                        <div className="style-twin-compare-axis-marker style-twin-compare-marker-you" style={{ left: `${myPct}%` }} title={`You: ${myVal}`}>
                          <span className="style-twin-compare-marker-dot" />
                        </div>
                        <div className="style-twin-compare-axis-marker style-twin-compare-marker-twin" style={{ left: `${theirPct}%` }} title={`${styleTwinCompare.display_name || "Twin"}: ${theirVal}`}>
                          <span className="style-twin-compare-marker-dot" />
                        </div>
                      </div>
                    </div>
                  );
                })}
                <div className="style-twin-compare-legend">
                  <span><span className="style-twin-compare-legend-dot" style={{ background: "var(--accent)" }} /> You</span>
                  <span><span className="style-twin-compare-legend-dot" style={{ background: "#78b478" }} /> {styleTwinCompare.display_name || "Twin"}</span>
                </div>
              </div>
            )}

            {/* Shared style axes */}
            {styleTwinCompare.shared_axes && styleTwinCompare.shared_axes.length > 0 && (
              <div style={{ marginBottom: 20 }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: "var(--text-tertiary)", textTransform: "uppercase", letterSpacing: 1, marginBottom: 10 }}>You both lean</div>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  {styleTwinCompare.shared_axes.map((axis, i) => (
                    <span key={i} className="style-twin-axis-chip" style={{ fontSize: 13, padding: "6px 16px" }}>{axis}</span>
                  ))}
                </div>
              </div>
            )}

            {/* Traits */}
            {styleTwinCompare.traits && styleTwinCompare.traits.length > 0 && (
              <div style={{ marginBottom: 20 }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: "var(--text-tertiary)", textTransform: "uppercase", letterSpacing: 1, marginBottom: 10 }}>Their style traits</div>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  {styleTwinCompare.traits.map((t, i) => (
                    <span key={i} className="style-twin-trait-chip" style={{ fontSize: 12, padding: "5px 14px" }}>{t}</span>
                  ))}
                </div>
              </div>
            )}

            {/* Color palette */}
            {styleTwinCompare.dominant_colors && styleTwinCompare.dominant_colors.length > 0 && (
              <div style={{ marginBottom: 20 }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: "var(--text-tertiary)", textTransform: "uppercase", letterSpacing: 1, marginBottom: 10 }}>Their palette</div>
                <div style={{ display: "flex", gap: 8 }}>
                  {styleTwinCompare.dominant_colors.map((c, i) => (
                    <div key={i} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 4 }}>
                      <span className="style-twin-color-dot" style={{ width: 32, height: 32, background: sdnaColorHex(c), fontSize: 0 }} />
                      <span style={{ fontSize: 10, color: "var(--text-tertiary)", textTransform: "capitalize" }}>{c}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Shared saves */}
            {styleTwinCompare.shared_saves_count > 0 && (
              <div style={{ marginBottom: 20 }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: "var(--text-tertiary)", textTransform: "uppercase", letterSpacing: 1, marginBottom: 10 }}>Shared saves</div>
                <div className="style-twin-shared-saves" style={{ marginTop: 0 }}>
                  <svg viewBox="0 0 24 24" width="14" height="14" fill="var(--accent)" stroke="none"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>
                  <span>{styleTwinCompare.shared_saves_count} item{styleTwinCompare.shared_saves_count !== 1 ? "s" : ""} you both saved{styleTwinCompare.shared_saves.length > 0 ? `: ${styleTwinCompare.shared_saves.join(", ")}` : ""}</span>
                </div>
              </div>
            )}

            {/* Follow action */}
            <button
              className={`user-search-follow-btn ${followingSet.has(styleTwinCompare.id) ? "following" : "follow"}`}
              onClick={() => handleFollowFromSearch(styleTwinCompare.id)}
              style={{ width: "100%", minHeight: 48, fontSize: 15, borderRadius: 12, fontWeight: 600, marginTop: 8 }}
            >{followingSet.has(styleTwinCompare.id) ? "Following" : "Follow Your Style Twin"}</button>
          </div>
        </>
      )}

      {/* ─── MAIN APP ────────────────────────────────────── */}
      {screen === "app" && (<>
        <div className="hdr">
          <><img src="/logo-dark.svg" alt="ATTAIRE" className="logo-img logo-img--dark" /><img src="/logo-light.svg" alt="ATTAIRE" className="logo-img logo-img--light" /></>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            {authed && !isGuest && (
              <button onClick={async () => { setShowNotifPanel(p => !p); if (!showNotifPanel) { const data = await API.getNotifications(); setNotifications(data.notifications || []); const uids = (data.notifications || []).filter(n => !n.read_at).map(n => n.id); if (uids.length > 0) API.markNotifsRead(uids).then(() => setNotifCount(0)).catch(() => {}); } }} style={{ position: "relative", background: "none", border: "none", padding: "4px 6px", cursor: "pointer", display: "flex", alignItems: "center" }} aria-label="Notifications">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--text-secondary)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>
                {notifCount > 0 && (<span style={{ position: "absolute", top: 0, right: 2, minWidth: 16, height: 16, background: "#E53935", color: "#fff", fontSize: 10, fontWeight: 700, borderRadius: 100, display: "flex", alignItems: "center", justifyContent: "center", padding: "0 4px" }}>{notifCount > 99 ? "99+" : notifCount}</span>)}
              </button>
            )}
            {isGuest
              ? <button className="cta" style={{ padding: "6px 16px", fontSize: 12, borderRadius: 100 }} onClick={() => trans(() => { setScreen("auth"); setAuthScreen("signup"); })}>Sign Up Free</button>
              : isPro
              ? <div className="pro">PRO</div>
              : <div className="free-badge" onClick={() => setUpgradeModal("general")}>FREE · {scansLeft}/{scansLimit}</div>
            }
            {userStatus?.tier === "trial" && userStatus?.trial_ends_at && (() => {
              const daysLeft = Math.max(0, Math.ceil((new Date(userStatus.trial_ends_at) - new Date()) / 86400000));
              return <div style={{ fontSize: 10, color: "var(--accent)", padding: "2px 8px", background: "var(--accent-bg)", borderRadius: 100, border: "1px solid var(--accent-border)" }}>{daysLeft}d trial</div>;
            })()}
          </div>
        </div>

        {/* Notification panel overlay */}
        {showNotifPanel && (<div onClick={() => setShowNotifPanel(false)} style={{ position: "fixed", inset: 0, zIndex: 9998 }} />)}
        {showNotifPanel && (
          <div style={{ position: "fixed", top: 52, right: 8, width: "min(360px, calc(100vw - 16px))", maxHeight: "70vh", background: "var(--card-bg)", borderRadius: 16, border: "1px solid var(--border)", boxShadow: "0 16px 48px rgba(0,0,0,.5)", zIndex: 9999, overflow: "hidden", display: "flex", flexDirection: "column" }}>
            <div style={{ padding: "14px 16px 10px", borderBottom: "1px solid var(--border)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div style={{ fontSize: 15, fontWeight: 700, color: "var(--text-primary)" }}>{t("notifications")}</div>
              <button onClick={() => setShowNotifPanel(false)} style={{ background: "none", border: "none", color: "var(--text-tertiary)", fontSize: 18, cursor: "pointer", padding: "2px 6px" }}>x</button>
            </div>
            {("Notification" in window) && Notification.permission === "default" && !pushEnabled && (
              <div style={{ padding: "12px 16px", borderBottom: "1px solid var(--border)", background: "rgba(201,169,110,.06)" }}>
                <div style={{ fontSize: 13, color: "var(--text-primary)", marginBottom: 8 }}>Enable push notifications for price drops, new posts, and more.</div>
                <button onClick={async () => { const perm = await Notification.requestPermission(); if (perm === "granted") { const ok = await subscribeToPush(); setPushEnabled(ok); } localStorage.setItem("attair_notif_prompted", "1"); setShowNotifPrompt(false); }} className="cta" style={{ padding: "8px 20px", fontSize: 12, borderRadius: 100, width: "100%" }}>Enable Notifications</button>
              </div>
            )}
            <div style={{ overflow: "auto", flex: 1 }}>
              {notifications.length === 0 ? (
                <div style={{ padding: "40px 16px", textAlign: "center" }}>
                  <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="var(--text-tertiary)" strokeWidth="1.5" style={{ opacity: 0.3, marginBottom: 8 }}><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>
                  <div style={{ fontSize: 13, color: "var(--text-tertiary)" }}>No notifications yet</div>
                  <div style={{ fontSize: 11, color: "var(--text-tertiary)", marginTop: 4, opacity: 0.7 }}>Price drops, followers, and posts will show up here</div>
                </div>
              ) : notifications.map(n => (
                <div key={n.id} style={{ padding: "12px 16px", borderBottom: "1px solid var(--border)", background: n.read_at ? "transparent" : "rgba(201,169,110,.04)", cursor: n.data?.url ? "pointer" : "default" }} onClick={() => { if (n.data?.url) { setShowNotifPanel(false); if (n.data.url === "/discover?tab=twins") { setTab("search"); setSearchSubTab("twins"); if (authed && !styleTwinsLoadingRef.current) { setStyleTwinsLoading(true); loadStyleTwins(); } } else if (!n.data.url.startsWith("/")) { window.open(n.data.url, "_blank", "noopener"); } } }}>
                  <div style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
                    <div style={{ width: 32, height: 32, borderRadius: "50%", flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", background: n.type === "price_drop" ? "rgba(76,175,80,.15)" : n.type === "social" ? "rgba(201,169,110,.15)" : n.type === "style_twins" ? "rgba(201,169,110,.15)" : n.type === "new_post" ? "rgba(100,181,246,.15)" : n.type === "follow_up" ? "rgba(201,169,110,.12)" : "rgba(255,255,255,.08)" }}>
                      {n.type === "price_drop" ? <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#4CAF50" strokeWidth="2"><path d="M12 2v20M17 17l-5 5-5-5"/></svg> : n.type === "social" ? <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg> : n.type === "style_twins" ? <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2"><circle cx="9" cy="7" r="3"/><circle cx="15" cy="7" r="3"/><path d="M3 21c0-3.31 2.69-6 6-6h0c1.1 0 2.12.3 3 .82A5.98 5.98 0 0115 15h0c3.31 0 6 2.69 6 6"/></svg> : n.type === "new_post" ? <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#64B5F6" strokeWidth="2"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="m21 15-5-5L5 21"/></svg> : n.type === "follow_up" ? <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg> : <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--text-tertiary)" strokeWidth="2"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/></svg>}
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text-primary)", marginBottom: 2 }}>{n.title}</div>
                      <div style={{ fontSize: 12, color: "var(--text-secondary)", lineHeight: 1.4 }}>{n.body}</div>
                      <div style={{ fontSize: 10, color: "var(--text-tertiary)", marginTop: 4 }}>{relativeDate(n.sent_at)}</div>
                    </div>
                    {!n.read_at && <div style={{ width: 8, height: 8, borderRadius: "50%", background: "var(--accent)", flexShrink: 0, marginTop: 4 }} />}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Push notification permission prompt */}
        {showNotifPrompt && !showNotifPanel && (
          <div className="animate-slide-up" style={{ position: "fixed", bottom: 90, left: 16, right: 16, background: "var(--card-bg)", borderRadius: 16, border: "1px solid var(--border)", boxShadow: "0 12px 40px rgba(0,0,0,.5)", padding: "16px", zIndex: 9990, display: "flex", gap: 12, alignItems: "center" }}>
            <div style={{ width: 40, height: 40, borderRadius: 12, background: "rgba(201,169,110,.1)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>
            </div>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text-primary)", marginBottom: 2 }}>Stay in the loop</div>
              <div style={{ fontSize: 11, color: "var(--text-tertiary)", lineHeight: 1.4 }}>Get notified about price drops, new posts, and more.</div>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <button onClick={async () => { localStorage.setItem("attair_notif_prompted", "1"); const perm = await Notification.requestPermission(); if (perm === "granted") { const ok = await subscribeToPush(); setPushEnabled(ok); } setShowNotifPrompt(false); }} style={{ background: "var(--accent)", color: "#000", border: "none", borderRadius: 100, padding: "6px 14px", fontSize: 11, fontWeight: 700, cursor: "pointer", whiteSpace: "nowrap" }}>Enable</button>
              <button onClick={() => { setShowNotifPrompt(false); localStorage.setItem("attair_notif_prompted", "1"); }} style={{ background: "none", border: "none", color: "var(--text-tertiary)", fontSize: 10, cursor: "pointer" }}>Not now</button>
            </div>
          </div>
        )}

        <div className="as">
          <input ref={fileRef} type="file" accept="image/*,.heic,.heif" capture="environment" className="hid" onChange={(e) => handleFile(e.target.files[0])} />
          <input ref={galleryRef} type="file" accept=".jpg,.jpeg,.png,.heic,.heif,.webp,.gif" className="hid" onChange={(e) => handleFile(e.target.files[0])} />

          {/* ─── Home Feed (TikTok/Instagram style) ────── */}
          {tab === "home" && (
            <div className="animate-fade-in" style={{ paddingBottom: 80 }}>
              {/* Guest welcome banner */}
              {isGuest && (
                <div style={{ margin: "8px 16px 12px", padding: "16px 18px", background: "linear-gradient(135deg, rgba(201,169,110,.08), rgba(201,169,110,.03))", border: "1px solid rgba(201,169,110,.15)", borderRadius: 16, textAlign: "center" }}>
                  <div style={{ fontSize: 15, fontWeight: 700, color: "var(--text-primary)", marginBottom: 4 }}>Try it free — scan any outfit</div>
                  <div style={{ fontSize: 12, color: "var(--text-secondary)", marginBottom: 12, lineHeight: 1.4 }}>Upload a photo and we'll find where to buy every piece</div>
                  <button className="cta" style={{ padding: "10px 28px", fontSize: 13, borderRadius: 100 }} onClick={() => setTab("scan")}>
                    Scan Your First Outfit
                  </button>
                </div>
              )}
              {/* For You / Following tabs directly under header */}
              {/* For You / Following toggle */}
              <div className="feed-tabs-wrap">
                <button className={`feed-tab${feedTab === "foryou" ? " active" : ""}`} onClick={() => { setFeedTab("foryou"); setFeedPage(1); }}>{t("for_you")}</button>
                <button className={`feed-tab${feedTab === "following" ? " active" : ""}`} onClick={() => { setFeedTab("following"); setFeedPage(1); }}>{t("following")}</button>
              </div>

              {/* "I'm looking for..." filter */}
              <div className="feed-filter-wrap">
                <svg className="feed-filter-icon" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="var(--text-tertiary)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
                <input
                  className="feed-filter-input"
                  type="text"
                  placeholder="I'm looking for..."
                  value={feedFilterQuery}
                  onChange={e => setFeedFilterQuery(e.target.value)}
                />
                {feedFilterQuery && (
                  <button className="feed-filter-clear" onClick={() => setFeedFilterQuery("")}>&times;</button>
                )}
              </div>

              {/* ─── Active Style Challenge card ─── */}
              {challenges.length > 0 && (() => {
                const active = challenges.find(c => c.status === "active" || c.status === "voting");
                if (!active) return null;
                const isVoting = active.status === "voting";
                const timeLeft = Math.max(0, Math.ceil((new Date(active.ends_at) - Date.now()) / (1000 * 60 * 60 * 24)));
                return (
                  <div className="card-press" onClick={async () => {
                    setChallengeLoading(true);
                    try {
                      const d = await API.getChallenge(active.id);
                      setActiveChallengeDetail(d.data);
                    } catch {}
                    setChallengeLoading(false);
                  }} style={{ margin: "4px 12px 8px", padding: "14px 16px", background: "linear-gradient(135deg, rgba(201,169,110,.08), rgba(199,125,255,.06))", border: "1px solid rgba(201,169,110,.15)", borderRadius: 14, cursor: "pointer" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
                      <div style={{ width: 32, height: 32, borderRadius: 8, background: "linear-gradient(135deg, #C9A96E, #C77DFF)", display: "flex", alignItems: "center", justifyContent: "center" }}>
                        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>
                      </div>
                      <div style={{ flex: 1 }}>
                        <div style={{ fontSize: 13, fontWeight: 700, color: "var(--text-primary)" }}>{active.title}</div>
                        <div style={{ fontSize: 10, color: "var(--text-tertiary)" }}>{active.description}</div>
                      </div>
                      <div style={{ textAlign: "right", flexShrink: 0 }}>
                        <div style={{ fontSize: 10, fontWeight: 700, color: isVoting ? "#C77DFF" : "var(--accent)" }}>{isVoting ? "VOTING" : `${timeLeft}d left`}</div>
                        <div style={{ fontSize: 10, color: "var(--text-tertiary)" }}>{active.submission_count} entries</div>
                      </div>
                    </div>
                    <div style={{ display: "flex", gap: 6 }}>
                      {!active.user_submitted && !isVoting && <span style={{ fontSize: 10, fontWeight: 700, padding: "3px 10px", borderRadius: 100, background: "var(--accent)", color: "var(--text-inverse)" }}>Submit Outfit</span>}
                      {isVoting && <span style={{ fontSize: 10, fontWeight: 700, padding: "3px 10px", borderRadius: 100, background: "rgba(199,125,255,.15)", color: "#C77DFF" }}>Vote Now</span>}
                      {active.user_submitted && !isVoting && <span style={{ fontSize: 10, fontWeight: 600, padding: "3px 10px", borderRadius: 100, background: "rgba(90,200,160,.1)", color: "#5AC8A0" }}>Submitted</span>}
                    </div>
                  </div>
                );
              })()}

              {/* ─── Hanger Test daily card ─── */}
              {hangerOutfits.length > 0 && !isGuest && (
                <div
                  className="card-press hanger-home-card"
                  onClick={() => setHangerFullscreen(true)}
                  style={{ margin: "4px 12px 8px", borderRadius: 14, overflow: "hidden", position: "relative", cursor: "pointer", border: "1px solid rgba(201,169,110,.15)" }}
                >
                  <div style={{ position: "relative", width: "100%", height: 140, overflow: "hidden" }}>
                    {/* Stack preview: show up to 3 overlapping images */}
                    {hangerOutfits.slice(0, 3).map((o, i) => (
                      <img key={o.id} src={o.image_url} alt="" style={{
                        position: "absolute", top: i * 3, left: i * 6,
                        width: `calc(100% - ${i * 12}px)`, height: `calc(100% - ${i * 6}px)`,
                        objectFit: "cover", zIndex: 3 - i, opacity: 1 - i * 0.15,
                        filter: i === 0 ? "brightness(0.6)" : "brightness(0.4)",
                      }} />
                    ))}
                    <div style={{ position: "absolute", inset: 0, background: "linear-gradient(to bottom, rgba(0,0,0,0.1) 0%, rgba(0,0,0,0.7) 100%)", zIndex: 4 }} />
                    <div style={{ position: "absolute", top: 10, left: 12, display: "flex", alignItems: "center", gap: 6, zIndex: 5 }}>
                      <div style={{ width: 24, height: 24, borderRadius: 6, background: "linear-gradient(135deg, #C9A96E, #E8D5A8)", display: "flex", alignItems: "center", justifyContent: "center" }}>
                        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="#000" strokeWidth="2.5" strokeLinecap="round"><path d="M12 2C12 2 8 6 8 10C8 14 12 16 12 16C12 16 16 14 16 10C16 6 12 2 12 2Z"/><path d="M8 16L4 20M16 16L20 20"/></svg>
                      </div>
                      <span style={{ fontSize: 11, fontWeight: 700, color: "#fff", letterSpacing: 1.2, textTransform: "uppercase" }}>Hanger Test</span>
                    </div>
                    {hangerStreak && hangerStreak.current_streak > 0 && (
                      <div style={{ position: "absolute", top: 10, right: 12, fontSize: 12, fontWeight: 700, color: "#FFB74D", display: "flex", alignItems: "center", gap: 3, zIndex: 5 }}>
                        <span style={{ fontSize: 14 }}>&#128293;</span> {hangerStreak.current_streak}
                      </div>
                    )}
                    <div style={{ position: "absolute", bottom: 10, left: 12, right: 12, zIndex: 5 }}>
                      {hangerCadence?.completed ? (
                        <div style={{ fontSize: 13, fontWeight: 600, color: "#fff" }}>All {hangerCadence.total} judged — come back tomorrow</div>
                      ) : (
                        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                          <div style={{ fontSize: 13, fontWeight: 600, color: "#fff" }}>
                            {hangerCadence ? `${hangerCadence.votes_today}/${hangerCadence.total}` : "0/5"} outfits judged
                          </div>
                          {/* Progress dots */}
                          <div style={{ display: "flex", gap: 4 }}>
                            {Array.from({ length: hangerCadence?.total || 5 }).map((_, i) => (
                              <div key={i} style={{
                                width: 6, height: 6, borderRadius: "50%",
                                background: i < (hangerCadence?.votes_today || 0) ? "#C9A96E" : "rgba(255,255,255,.3)",
                              }} />
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              )}

              {/* ─── Outfit of the Week: loading skeleton ─── */}
              {ootwLoading && !ootwData && (
                <div className="ootw-card ootw-skeleton" style={{ margin: "4px 12px 8px", borderRadius: 16, overflow: "hidden", border: "1px solid rgba(201,169,110,.1)", background: "var(--bg-card)" }}>
                  <div style={{ width: "100%", height: 180, background: "linear-gradient(135deg, var(--bg-input) 0%, var(--bg-card) 50%, var(--bg-input) 100%)", backgroundSize: "200% 100%", animation: "ootwShimmer 1.5s ease-in-out infinite" }} />
                  <div style={{ padding: "14px 14px 12px", display: "flex", flexDirection: "column", gap: 8 }}>
                    <div style={{ width: "70%", height: 14, borderRadius: 6, background: "linear-gradient(135deg, var(--bg-input) 0%, var(--bg-card) 50%, var(--bg-input) 100%)", backgroundSize: "200% 100%", animation: "ootwShimmer 1.5s ease-in-out infinite" }} />
                    <div style={{ width: "90%", height: 10, borderRadius: 4, background: "linear-gradient(135deg, var(--bg-input) 0%, var(--bg-card) 50%, var(--bg-input) 100%)", backgroundSize: "200% 100%", animation: "ootwShimmer 1.5s ease-in-out infinite", animationDelay: "0.15s" }} />
                    <div style={{ display: "flex", gap: 6, marginTop: 4 }}>
                      {[0,1,2,3,4,5].map(i => (
                        <div key={i} style={{ width: 48, height: 48, borderRadius: 8, background: "linear-gradient(135deg, var(--bg-input) 0%, var(--bg-card) 50%, var(--bg-input) 100%)", backgroundSize: "200% 100%", flexShrink: 0, animation: "ootwShimmer 1.5s ease-in-out infinite", animationDelay: `${i * 0.08}s` }} />
                      ))}
                    </div>
                  </div>
                </div>
              )}

              {/* ─── Outfit of the Week: error / tap-to-retry ─── */}
              {ootwError && !ootwData && !ootwLoading && (
                <div
                  className="card-press ootw-card"
                  onClick={loadOOTW}
                  style={{ margin: "4px 12px 8px", borderRadius: 16, overflow: "hidden", cursor: "pointer", border: "1px solid rgba(201,169,110,.15)", background: "var(--bg-card)", padding: "20px 16px", display: "flex", flexDirection: "column", alignItems: "center", gap: 8, textAlign: "center" }}
                >
                  <div style={{ width: 36, height: 36, borderRadius: 10, background: "rgba(201,169,110,.08)", display: "flex", alignItems: "center", justifyContent: "center" }}>
                    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
                  </div>
                  <div style={{ fontSize: 13, fontWeight: 700, color: "var(--text-primary)" }}>Couldn't load this week's picks</div>
                  <div style={{ fontSize: 11, color: "var(--text-tertiary)" }}>Tap to retry</div>
                </div>
              )}

              {/* ─── Outfit of the Week pinned card ─── */}
              {ootwData && (
                <div
                  className="card-press ootw-card animate-slide-up"
                  onClick={() => setOotwExpanded(true)}
                  style={{ margin: "4px 12px 8px", borderRadius: 16, overflow: "hidden", position: "relative", cursor: "pointer", border: "1px solid rgba(201,169,110,.2)", background: "var(--bg-card)" }}
                >
                  {/* Cover image with gradient */}
                  <div style={{ position: "relative", width: "100%", height: 180, overflow: "hidden" }}>
                    {ootwData.cover_image ? (
                      <img src={ootwData.cover_image} alt="This Week's Look" style={{ width: "100%", height: "100%", objectFit: "cover", filter: "brightness(0.55)" }} onError={e => { e.target.style.display = "none"; }} />
                    ) : (
                      <div style={{ width: "100%", height: "100%", background: "linear-gradient(135deg, #1A1A1A 0%, #2A2520 100%)" }} />
                    )}
                    <div style={{ position: "absolute", inset: 0, background: "linear-gradient(to bottom, rgba(0,0,0,0) 0%, rgba(0,0,0,0.8) 100%)" }} />

                    {/* Top badge */}
                    <div style={{ position: "absolute", top: 12, left: 12, display: "flex", alignItems: "center", gap: 7 }}>
                      <div style={{ width: 26, height: 26, borderRadius: 7, background: "linear-gradient(135deg, #C9A96E, #E8D5A8)", display: "flex", alignItems: "center", justifyContent: "center" }}>
                        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="#000" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>
                      </div>
                      <span style={{ fontSize: 10, fontWeight: 700, color: "#fff", letterSpacing: 1.5, textTransform: "uppercase" }}>This Week's Look</span>
                    </div>

                    {/* View count */}
                    {ootwData?.view_count > 0 && (
                      <div style={{ position: "absolute", top: 12, right: 12, fontSize: 10, fontWeight: 600, color: "rgba(255,255,255,0.7)", display: "flex", alignItems: "center", gap: 4 }}>
                        <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
                        {ootwData.view_count.toLocaleString()}
                      </div>
                    )}

                    {/* Headline + editorial */}
                    <div style={{ position: "absolute", bottom: 14, left: 14, right: 14 }}>
                      <div style={{ fontSize: 17, fontWeight: 800, color: "#fff", lineHeight: 1.2, marginBottom: 4 }}>
                        {ootwData?.headline || "This Week's Look"}
                      </div>
                      <div style={{ fontSize: 12, color: "rgba(255,255,255,0.75)", lineHeight: 1.4, display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>
                        {ootwData?.editorial || "Check out the top trending outfits this week."}
                      </div>
                    </div>
                  </div>

                  {/* Scan thumbnails strip */}
                  {ootwData.scans && ootwData.scans.length > 0 && (
                    <div style={{ padding: "10px 12px", display: "flex", gap: 6, overflowX: "auto", WebkitOverflowScrolling: "touch" }}>
                      {ootwData.scans.slice(0, 6).map((s, i) => (
                        <div key={s.id || i} style={{ width: 48, height: 48, borderRadius: 8, overflow: "hidden", flexShrink: 0, border: "1px solid rgba(255,255,255,0.08)" }}>
                          {s.image_url ? (
                            <img src={s.image_url} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} onError={e => { e.target.style.display = "none"; }} />
                          ) : (
                            <div style={{ width: "100%", height: "100%", background: "var(--bg-input)" }} />
                          )}
                        </div>
                      ))}
                      {ootwData.scans.length > 6 && (
                        <div style={{ width: 48, height: 48, borderRadius: 8, flexShrink: 0, background: "rgba(201,169,110,.08)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: 700, color: "var(--accent)" }}>
                          +{ootwData.scans.length - 6}
                        </div>
                      )}
                      <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "flex-end", paddingRight: 2 }}>
                        <span style={{ fontSize: 11, fontWeight: 700, color: "var(--accent)" }}>See all</span>
                        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="var(--accent)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ marginLeft: 2 }}><polyline points="9 18 15 12 9 6"/></svg>
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* Skeleton loading */}
              {feedLoading && feedScans.length === 0 && (
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, padding: "4px 12px" }}>
                  {[0,1,2,3].map(i => (
                    <div key={i} className="skeleton" style={{ borderRadius: 12, overflow: "hidden" }}>
                      <div className="skeleton-image" style={{ width: "100%", aspectRatio: "3/4" }} />
                    </div>
                  ))}
                </div>
              )}

              {/* Empty state — For You / Trending: featured scans from community */}
              {!feedLoading && feedScans.length === 0 && feedTab === "foryou" && (
                <FeaturedScansEmpty onScan={() => setTab("scan")} onDiscover={() => { setTab("search"); setShowUserSearch(true); }} />
              )}

              {/* Empty state — Following: curated style accounts + featured scans */}
              {!feedLoading && feedScans.length === 0 && feedTab === "following" && (
                <div className="animate-slide-up" style={{ padding: "0 16px 100px" }}>
                  {/* Prompt header */}
                  <div style={{ textAlign: "center", padding: "32px 16px 8px" }}>
                    <div style={{ fontSize: 18, fontWeight: 700, color: "var(--text-primary)", marginBottom: 6 }}>Your feed is waiting</div>
                    <div style={{ fontSize: 13, color: "var(--text-tertiary)", lineHeight: 1.5, maxWidth: 280, margin: "0 auto" }}>Follow style accounts to fill your feed with curated looks and inspiration.</div>
                  </div>

                  {/* Curated style accounts */}
                  <div style={{ padding: "20px 0 0" }}>
                    <div style={{ fontSize: 11, fontWeight: 700, color: "var(--text-tertiary)", letterSpacing: 1.5, textTransform: "uppercase", marginBottom: 12, paddingLeft: 4 }}>Style accounts to follow</div>
                    <div className="feed-suggested-users" role="list" aria-label="Curated style accounts">
                      {[
                        { name: "Street Style Daily", ini: "SS", desc: "NYC, London, Tokyo street looks", color: "#C9A96E" },
                        { name: "Luxury Finds", ini: "LF", desc: "Designer pieces at every price point", color: "#AB82FF" },
                        { name: "Drip Check", ini: "DC", desc: "Best men's streetwear fits", color: "#EF5350" },
                        { name: "TikTok Trending", ini: "TT", desc: "Viral fits everyone is talking about", color: "#EE1D52" },
                        { name: "Celeb Spotted", ini: "CS", desc: "Celebrity style decoded", color: "#FFD54F" },
                        { name: "Vintage Vibes", ini: "VV", desc: "Retro-inspired fits and thrift gems", color: "#A8884A" },
                        { name: "Athleisure Edit", ini: "AE", desc: "Gym to brunch outfit inspo", color: "#66BB6A" },
                        { name: "Minimal Wardrobe", ini: "MW", desc: "Clean lines, neutral tones", color: "#8B8B8B" },
                      ].map((acct, idx) => (
                        <div key={idx} className="feed-suggested-row" role="listitem" style={{ animationDelay: `${idx * 0.05}s` }}>
                          <div className="feed-suggested-avatar" style={{ background: acct.color, fontSize: 12, fontWeight: 700, color: "#fff", display: "flex", alignItems: "center", justifyContent: "center" }}>{acct.ini}</div>
                          <div className="feed-suggested-info">
                            <div className="feed-suggested-name">{acct.name}</div>
                            <div className="feed-suggested-meta">{acct.desc}</div>
                          </div>
                          <button className="feed-suggested-follow-btn" onClick={(e) => { e.stopPropagation(); API.searchUsers(acct.name).then(r => { const user = (r.users || []).find(u => u.display_name === acct.name); if (user) API.followUser(user.id).then(() => { e.target.textContent = "Following"; e.target.style.opacity = "0.5"; }); }); }}>Follow</button>
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* Discover People button */}
                  <div style={{ textAlign: "center", padding: "24px 0 0" }}>
                    <button className="btn-primary" onClick={() => { setTab("search"); setShowUserSearch(true); }} style={{ padding: "14px 36px", borderRadius: 100, fontSize: 15, minHeight: 48 }}>Discover People</button>
                  </div>
                </div>
              )}

              {/* Feed cards */}
              {feedScans.length > 0 && (() => {
                const fq = feedFilterQuery.toLowerCase().trim();
                const filteredFeedScans = fq ? feedScans.filter(scan => {
                  const items = scan.items || [];
                  const haystack = [
                    scan.summary,
                    scan.user?.display_name,
                    ...items.map(it => [it.name, it.brand, it.category, ...(it.tags || [])].join(" "))
                  ].join(" ").toLowerCase();
                  return haystack.includes(fq);
                }) : feedScans;
                return (
                <div className="feed-list">
                  {fq && filteredFeedScans.length === 0 && (
                    <div style={{ textAlign: "center", padding: "40px 16px", color: "var(--text-tertiary)", fontSize: 13 }}>
                      No outfits match "{feedFilterQuery}"
                    </div>
                  )}
                  {filteredFeedScans.map((scan, idx) => {
                    const u = scan.user || {};
                    const ini = (u.display_name || "?").split(" ").map(w => w[0]).join("").slice(0,2).toUpperCase();
                    const isSaved = saved.some(s => s.scan_id === scan.id);
                    const isTrending = (scan.save_count || 0) >= 3;
                    const trendingRank = null;
                    const showAd = userStatus?.tier !== "pro" && userStatus?.tier !== "trial" && idx > 0 && idx % 5 === 0;
                    return (
                      <Fragment key={scan.id || idx}>
                        {showAd && (
                          <div className="feed-card feed-ad-card card-enter" style={{ animationDelay: `${idx * 0.06}s` }}>
                            <div style={{ position: "relative", background: "linear-gradient(135deg, rgba(201,169,110,.06), rgba(201,169,110,.02))", border: "1px solid rgba(201,169,110,.12)", borderRadius: 16, padding: "20px 16px", textAlign: "center", minHeight: 200, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 10 }}>
                              <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: 1.5, color: "var(--text-tertiary)", textTransform: "uppercase" }}>Sponsored</div>
                              <div style={{ width: 48, height: 48, borderRadius: 12, background: "linear-gradient(135deg, var(--accent), #E8D5A8)", display: "flex", alignItems: "center", justifyContent: "center" }}>
                                <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="#000" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M6 2L3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z"/><line x1="3" y1="6" x2="21" y2="6"/><path d="M16 10a4 4 0 0 1-8 0"/></svg>
                              </div>
                              <div style={{ fontSize: 15, fontWeight: 700, color: "var(--text-primary)" }}>Upgrade to Pro</div>
                              <div style={{ fontSize: 12, color: "var(--text-tertiary)", lineHeight: 1.5, maxWidth: 220 }}>Remove ads and unlock Style DNA, unlimited scans, and more</div>
                              <button className="cta" onClick={() => setScreen("paywall")} style={{ padding: "10px 28px", fontSize: 12, borderRadius: 100, marginTop: 4 }}>Go Pro</button>
                            </div>
                          </div>
                        )}
                        <div className="feed-card card-enter" style={{ animationDelay: `${idx * 0.06}s` }} onClick={() => { const realIdx = feedScans.indexOf(scan); setFeedDetailScan(scan); setFeedDetailIdx(realIdx >= 0 ? realIdx : idx); }}>
                          <div style={{ position: "relative" }}>
                            {scan.image_url
                              ? <img className="feed-card-img" src={scan.image_url} alt={scan.summary || "Outfit"} loading="lazy" onError={e => { e.target.style.display = "none"; }} />
                              : <div className="feed-card-img" style={{ background: "var(--bg-card)", display: "flex", alignItems: "center", justifyContent: "center" }}>
                                  <svg viewBox="0 0 24 24" width="48" height="48" fill="none" stroke="var(--text-tertiary)" strokeWidth="1"><rect x="2" y="6" width="20" height="14" rx="3" /><circle cx="12" cy="13" r="4" /></svg>
                                </div>
                            }
                            {trendingRank && trendingRank <= 10 && (
                              <div className="feed-card-rank">#{trendingRank}</div>
                            )}
                            <div className="feed-card-pills">
                              {isTrending && (
                                <div className="feed-card-pill feed-card-trending">
                                  <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/></svg>
                                  Trending
                                </div>
                              )}
                              {scan.save_count > 0 && (
                                <div className="feed-card-pill">
                                  <svg viewBox="0 0 24 24" width="12" height="12" fill="var(--accent)" stroke="none"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>
                                  {scan.save_count}
                                </div>
                              )}
                              {scan.item_count > 0 && (
                                <div className="feed-card-pill feed-card-items-pill">
                                  {scan.item_count} {scan.item_count === 1 ? "item" : "items"}
                                </div>
                              )}
                            </div>
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
                      </Fragment>
                    );
                  })}
                  {feedHasMore && <div ref={feedSentinelRef} style={{ height: 1 }} />}
                  {feedLoading && feedScans.length > 0 && (
                    <div style={{ display: "flex", justifyContent: "center", padding: "20px 0" }}>
                      <div className="spinner" style={{ width: 24, height: 24 }} />
                    </div>
                  )}
                </div>
                );
              })()}
            </div>
          )}

          {/* ─── Discover Tab ──────────────────────────────── */}
          {tab === "search" && (
            <div className="animate-fade-in" style={{ paddingBottom: 80 }}>
              {/* People / Products / Style Twins sub-tabs */}
              <div className="feed-tabs-wrap">
                <button className={`feed-tab${searchSubTab === "people" ? " active" : ""}`} onClick={() => setSearchSubTab("people")}>People</button>
                <button className={`feed-tab${searchSubTab === "products" ? " active" : ""}`} onClick={() => setSearchSubTab("products")}>Products</button>
                <button className={`feed-tab${searchSubTab === "twins" ? " active" : ""}`} onClick={() => {
                  setSearchSubTab("twins");
                  // Always trigger fresh fetch when tab is tapped. Reset ref if stuck to prevent deadlock.
                  if (authed) {
                    // Force-release the ref lock to prevent permanent deadlock
                    styleTwinsLoadingRef.current = false;
                    // Set loading state synchronously BEFORE calling loadStyleTwins
                    // to guarantee spinner renders on next paint. DO NOT set hasFetched=false
                    // here — it causes a brief flash where no condition matches if React
                    // renders between the false and the loadStyleTwins finally block true.
                    setStyleTwinsLoading(true);
                    setStyleTwinsError(null);
                    loadStyleTwins();
                  }
                }}>
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="9" cy="7" r="3"/><circle cx="15" cy="7" r="3"/><path d="M3 21c0-3.31 2.69-6 6-6h0c1.1 0 2.12.3 3 .82A5.98 5.98 0 0115 15h0c3.31 0 6 2.69 6 6"/></svg>
                    Twins
                  </span>
                </button>
              </div>

              {/* Search input (hidden for twins tab) */}
              {searchSubTab !== "twins" && <div style={{ padding: "8px 16px 0" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10, background: "var(--bg-card)", borderRadius: 12, padding: "0 14px", border: "1px solid var(--border)" }}>
                  <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="var(--text-tertiary)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/></svg>
                  {searchSubTab === "people" ? (
                    <input
                      value={userSearchQuery}
                      onChange={e => { setUserSearchQuery(e.target.value); if (!showUserSearch) setShowUserSearch(true); }}
                      onFocus={() => { if (!showUserSearch) setShowUserSearch(true); }}
                      placeholder={t("search_people")}
                      style={{ flex: 1, background: "none", border: "none", outline: "none", padding: "12px 0", fontFamily: "var(--font-sans)", fontSize: 15, color: "var(--text-primary)", minHeight: 44 }}
                    />
                  ) : (
                    <input
                      value={productSearchQuery}
                      onChange={e => setProductSearchQuery(e.target.value)}
                      placeholder="Search products, brands..."
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
              </div>}

              {/* ─── People search results ─── */}
              {searchSubTab === "people" && (
                <div style={{ padding: "12px 16px" }}>
                  {userSearchLoading && <div style={{ textAlign: "center", padding: 32, color: "var(--text-tertiary)", fontSize: 13 }}>Searching...</div>}
                  {!userSearchLoading && userSearchQuery.trim() && userSearchResults.length === 0 && <div style={{ textAlign: "center", padding: 32, color: "var(--text-tertiary)", fontSize: 13 }}>{t("no_users_found")}</div>}
                  {!userSearchLoading && !userSearchQuery.trim() && (
                    <div>
                      <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: 1.5, color: "var(--text-tertiary)", textTransform: "uppercase", marginBottom: 12, paddingTop: 8 }}>Suggested for you</div>
                      <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 10 }}>
                        {([
                          { id: "s1", display_name: "Style Scout", bio: "Curating everyday looks", follower_count: 2400 },
                          { id: "s2", display_name: "Outfit Daily", bio: "One fit per day", follower_count: 8100 },
                          { id: "s3", display_name: "Thrift Finds", bio: "Budget fashion that slaps", follower_count: 5300 },
                          { id: "s4", display_name: "Minimalist Closet", bio: "Less is more", follower_count: 3700 },
                          { id: "s5", display_name: "Street Looks", bio: "City style worldwide", follower_count: 12000 },
                          { id: "s6", display_name: "Fit Check", bio: "Rate my outfit", follower_count: 6600 },
                        ]).map(usr => {
                          const ini = (usr.display_name || "?").split(" ").map(w => w[0]).join("").slice(0,2).toUpperCase();
                          const isFlw = followingSet.has(usr.id);
                          return (
                            <div key={usr.id} style={{ background: "var(--bg-card)", borderRadius: 14, border: "1px solid var(--border)", padding: 16, display: "flex", flexDirection: "column", alignItems: "center", textAlign: "center", gap: 8 }}>
                              <div style={{ width: 52, height: 52, borderRadius: "50%", background: "linear-gradient(135deg, rgba(201,169,110,.2), rgba(201,169,110,.05))", display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 800, fontSize: 16, color: "var(--accent)", letterSpacing: 1 }}>{ini}</div>
                              <div>
                                <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text-primary)" }}>{usr.display_name}</div>
                                {usr.bio && <div style={{ fontSize: 11, color: "var(--text-tertiary)", marginTop: 2 }}>{usr.bio}</div>}
                                <div style={{ fontSize: 10, color: "var(--text-tertiary)", marginTop: 4 }}>{usr.follower_count?.toLocaleString()} followers</div>
                              </div>
                              <button
                                className={`user-search-follow-btn ${isFlw ? "following" : "follow"}`}
                                onClick={(e) => { e.stopPropagation(); handleFollowFromSearch(usr.id); }}
                                style={{ width: "100%", minHeight: 36, fontSize: 12, borderRadius: 8 }}
                              >{isFlw ? "Following" : "Follow"}</button>
                            </div>
                          );
                        })}
                      </div>
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
                    <div>
                      <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: 1.5, color: "var(--text-tertiary)", textTransform: "uppercase", marginBottom: 12, paddingTop: 8 }}>Recommended for you</div>
                      <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 10 }}>
                        {(saved.length > 0 ? saved.slice(0, 8).map((s, i) => ({
                          id: s.id || `rec-${i}`,
                          name: s.item_name || s.product_name || "Style Pick",
                          brand: s.brand || "",
                          image_url: s.image_url || s.product_image || "",
                          price: s.price || "",
                        })) : [
                          { id: "r1", name: "Classic White Sneakers", brand: "Nike", image_url: "", price: "$95" },
                          { id: "r2", name: "Oversized Blazer", brand: "Zara", image_url: "", price: "$89" },
                          { id: "r3", name: "High-Rise Straight Jeans", brand: "Levi's", image_url: "", price: "$78" },
                          { id: "r4", name: "Minimal Watch", brand: "Daniel Wellington", image_url: "", price: "$169" },
                          { id: "r5", name: "Crossbody Bag", brand: "Coach", image_url: "", price: "$195" },
                          { id: "r6", name: "Cotton Crew Tee", brand: "Uniqlo", image_url: "", price: "$15" },
                        ]).map(product => (
                          <div key={product.id} style={{ background: "var(--bg-card)", borderRadius: 12, border: "1px solid var(--border)", overflow: "hidden" }}>
                            {product.image_url ? (
                              <img src={product.image_url} alt={product.name} loading="lazy" style={{ width: "100%", aspectRatio: "3/4", objectFit: "cover" }} onError={e => { e.target.style.display = "none"; }} />
                            ) : (
                              <div style={{ width: "100%", aspectRatio: "3/4", background: "linear-gradient(135deg, rgba(201,169,110,.08), rgba(201,169,110,.02))", display: "flex", alignItems: "center", justifyContent: "center" }}>
                                <svg viewBox="0 0 24 24" width="32" height="32" fill="none" stroke="rgba(201,169,110,.3)" strokeWidth="1.5"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
                              </div>
                            )}
                            <div style={{ padding: 10 }}>
                              {product.brand && <div style={{ fontSize: 11, fontWeight: 600, color: "var(--accent)", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 2 }}>{product.brand}</div>}
                              <div style={{ fontSize: 13, fontWeight: 500, color: "var(--text-primary)", lineHeight: 1.3 }}>{product.name}</div>
                              {product.price && <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text-secondary)", marginTop: 4 }}>{product.price}</div>}
                            </div>
                          </div>
                        ))}
                      </div>
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

              {/* ─── Style Twins section ─── */}
              {searchSubTab === "twins" && (
                <div style={{ padding: "12px 16px" }}>
                  {/* Not logged in */}
                  {!authed && (
                    <div className="style-twins-empty">
                      <div className="style-twins-empty-icon">
                        <svg viewBox="0 0 24 24" width="48" height="48" fill="none" stroke="var(--accent)" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
                          <circle cx="9" cy="7" r="3"/><circle cx="15" cy="7" r="3"/><path d="M3 21c0-3.31 2.69-6 6-6h0c1.1 0 2.12.3 3 .82A5.98 5.98 0 0115 15h0c3.31 0 6 2.69 6 6"/>
                        </svg>
                      </div>
                      <h3 style={{ fontSize: 18, fontWeight: 700, color: "var(--text-primary)", margin: "16px 0 8px" }}>Sign In to Find Twins</h3>
                      <p style={{ fontSize: 14, color: "var(--text-secondary)", lineHeight: 1.5, maxWidth: 280, margin: "0 auto 20px" }}>
                        Create an account and scan outfits to discover people who dress just like you.
                      </p>
                      <button className="btn-primary" onClick={() => { setShowAuth(true); }} style={{ padding: "12px 32px", borderRadius: 12, fontSize: 14, fontWeight: 600 }}>
                        Sign In
                      </button>
                    </div>
                  )}

                  {/* Loading state — shown during fetch AND before initial fetch to prevent "Unlock" CTA flash.
                       The key guard: if hasFetched is false, ALWAYS show loading (never Unlock CTA). */}
                  {authed && (styleTwinsLoading || !styleTwinsHasFetched) && !styleTwinsError && (
                    <div className="style-twins-loading">
                      <div className="style-twins-loading-orbit">
                        <div className="style-twins-loading-ring" />
                        <div className="style-twins-loading-ring" style={{ animationDelay: "-0.5s", width: 44, height: 44 }} />
                        <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="var(--accent)" strokeWidth="2" style={{ position: "absolute" }}>
                          <circle cx="9" cy="7" r="3"/><circle cx="15" cy="7" r="3"/><path d="M3 21c0-3.31 2.69-6 6-6h0c1.1 0 2.12.3 3 .82A5.98 5.98 0 0115 15h0c3.31 0 6 2.69 6 6"/>
                        </svg>
                      </div>
                      <div style={{ fontSize: 14, color: "var(--text-secondary)", marginTop: 16 }}>Finding your Style Twins...</div>
                    </div>
                  )}

                  {/* Error state with retry — also handles the edge case where error was set while still loading */}
                  {authed && styleTwinsError && (
                    <div className="style-twins-empty">
                      <div className="style-twins-empty-icon">
                        <svg viewBox="0 0 24 24" width="48" height="48" fill="none" stroke="var(--text-tertiary)" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
                          <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
                        </svg>
                      </div>
                      <h3 style={{ fontSize: 18, fontWeight: 700, color: "var(--text-primary)", margin: "16px 0 8px" }}>Something Went Wrong</h3>
                      <p style={{ fontSize: 14, color: "var(--text-secondary)", lineHeight: 1.5, maxWidth: 280, margin: "0 auto 20px" }}>
                        {styleTwinsError}
                      </p>
                      <button className="btn-primary" onClick={() => { styleTwinsLoadingRef.current = false; setStyleTwinsError(null); setStyleTwinsLoading(true); loadStyleTwins(); }} style={{ padding: "12px 32px", borderRadius: 12, fontSize: 14, fontWeight: 600 }}>
                        Try Again
                      </button>
                    </div>
                  )}

                  {/* Unlock state — no Style DNA yet (ONLY after fetch completes AND confirms no DNA).
                       styleTwinsHasFetched must be true AND styleTwinsLoading must be false — both required to prevent flash. */}
                  {authed && styleTwinsHasFetched && !styleTwinsLoading && !styleTwinsError && !styleTwinsReady && (
                    <div className="style-twins-empty">
                      <div className="style-twins-empty-icon">
                        <svg viewBox="0 0 24 24" width="48" height="48" fill="none" stroke="var(--accent)" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
                          <circle cx="9" cy="7" r="3"/><circle cx="15" cy="7" r="3"/><path d="M3 21c0-3.31 2.69-6 6-6h0c1.1 0 2.12.3 3 .82A5.98 5.98 0 0115 15h0c3.31 0 6 2.69 6 6"/>
                        </svg>
                      </div>
                      <h3 style={{ fontSize: 18, fontWeight: 700, color: "var(--text-primary)", margin: "16px 0 8px" }}>Unlock Style Twins</h3>
                      <p style={{ fontSize: 14, color: "var(--text-secondary)", lineHeight: 1.5, maxWidth: 280, margin: "0 auto 20px" }}>
                        Scan 5 outfits to generate your Style DNA, then discover people who dress just like you.
                      </p>
                      <button className="btn-primary" onClick={() => { setTab("scan"); }} style={{ padding: "12px 32px", borderRadius: 12, fontSize: 14, fontWeight: 600 }}>
                        Start Scanning
                      </button>
                    </div>
                  )}

                  {/* Ready but no matches yet */}
                  {authed && !styleTwinsLoading && !styleTwinsError && styleTwinsReady && styleTwins.length === 0 && (
                    <div className="style-twins-empty">
                      <div className="style-twins-empty-icon">
                        <svg viewBox="0 0 24 24" width="48" height="48" fill="none" stroke="var(--text-tertiary)" strokeWidth="1.2">
                          <circle cx="9" cy="7" r="3"/><circle cx="15" cy="7" r="3"/><path d="M3 21c0-3.31 2.69-6 6-6h0c1.1 0 2.12.3 3 .82A5.98 5.98 0 0115 15h0c3.31 0 6 2.69 6 6"/>
                        </svg>
                      </div>
                      <h3 style={{ fontSize: 18, fontWeight: 700, color: "var(--text-primary)", margin: "16px 0 8px" }}>No Twins Yet</h3>
                      <p style={{ fontSize: 14, color: "var(--text-secondary)", lineHeight: 1.5, maxWidth: 280, margin: "0 auto 20px" }}>
                        As more people join ATTAIRE and build their Style DNA, your twins will appear here. Check back soon!
                      </p>
                      <button className="btn-ghost" onClick={() => { styleTwinsLoadingRef.current = false; setStyleTwinsLoading(true); setStyleTwinsError(null); loadStyleTwins(); }} style={{ padding: "10px 24px", borderRadius: 10, fontSize: 13, fontWeight: 600 }}>
                        <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
                          Refresh
                        </span>
                      </button>
                    </div>
                  )}

                  {authed && !styleTwinsLoading && !styleTwinsError && styleTwinsReady && styleTwins.length > 0 && (
                    <div>
                      {/* Header with archetype */}
                      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16, paddingTop: 4 }}>
                        <div>
                          <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: 1.5, color: "var(--accent)", textTransform: "uppercase", marginBottom: 4 }}>Your Style Twins</div>
                          <div style={{ fontSize: 13, color: "var(--text-secondary)" }}>
                            {styleTwinsMyArchetype && <span style={{ color: "var(--text-primary)", fontWeight: 600 }}>{styleTwinsMyArchetype}</span>}
                            {styleTwinsMyArchetype && " · "}{styleTwinsTotalMatches} {styleTwinsTotalMatches === 1 ? "match" : "matches"}
                          </div>
                        </div>
                        <button onClick={() => { styleTwinsLoadingRef.current = false; setStyleTwinsLoading(true); setStyleTwinsError(null); loadStyleTwins(); }} className="style-twins-refresh-btn" title="Refresh">
                          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
                        </button>
                      </div>

                      {/* Top Twin — featured card */}
                      {styleTwins[0] && (() => {
                        const top = styleTwins[0];
                        const ini = ((top.display_name || "?") + "").split(" ").filter(Boolean).map(w => (w[0] || "")).join("").slice(0,2).toUpperCase() || "?";
                        const isFlw = followingSet ? followingSet.has(top.id) : false;
                        const matchTier = (top.match_pct || 0) >= 85 ? "high" : (top.match_pct || 0) >= 70 ? "mid" : "low";
                        return (
                          <div className="style-twin-featured" key={top.id} onClick={() => setStyleTwinCompare(top)}>
                            <div className="style-twin-featured-glow" />
                            {/* Top match label */}
                            <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 14 }}>
                              <svg viewBox="0 0 24 24" width="14" height="14" fill="var(--accent)" stroke="none"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>
                              <span style={{ fontSize: 11, fontWeight: 700, color: "var(--accent)", textTransform: "uppercase", letterSpacing: 1 }}>Closest Match</span>
                            </div>
                            <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
                              <div className="style-twin-avatar-lg">
                                {top.avatar_url ? (
                                  <img src={top.avatar_url} alt="" style={{ width: "100%", height: "100%", objectFit: "cover", borderRadius: "50%" }} />
                                ) : (
                                  <span>{ini}</span>
                                )}
                              </div>
                              <div style={{ flex: 1, minWidth: 0 }}>
                                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 2 }}>
                                  <span style={{ fontSize: 16, fontWeight: 700, color: "var(--text-primary)" }}>{top.display_name || "Anonymous"}</span>
                                  <span className={`style-twin-match-badge style-twin-match-${matchTier}`}>{top.match_pct || 0}%</span>
                                </div>
                                {top.archetype && <div style={{ fontSize: 12, color: "var(--accent)", fontWeight: 600, marginBottom: 4 }}>{top.archetype}</div>}
                                {top.bio && <div style={{ fontSize: 12, color: "var(--text-tertiary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{top.bio}</div>}
                              </div>
                            </div>
                            {/* Shared style axes + traits */}
                            {(Array.isArray(top.shared_axes) && top.shared_axes.length > 0 || Array.isArray(top.traits) && top.traits.length > 0) && (
                              <div style={{ display: "flex", gap: 6, marginTop: 12, flexWrap: "wrap" }}>
                                {(top.shared_axes || []).map((axis, i) => (
                                  <span key={i} className="style-twin-axis-chip">{axis}</span>
                                ))}
                                {(top.traits || []).map((t, i) => (
                                  <span key={`t-${i}`} className="style-twin-trait-chip">{t}</span>
                                ))}
                              </div>
                            )}
                            {/* Color palette dots */}
                            {Array.isArray(top.dominant_colors) && top.dominant_colors.length > 0 && (
                              <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 10 }}>
                                <span style={{ fontSize: 11, color: "var(--text-tertiary)", marginRight: 2 }}>Palette</span>
                                {top.dominant_colors.map((c, i) => (
                                  <span key={i} className="style-twin-color-dot" style={{ background: sdnaColorHex(c) }} title={c || ""} />
                                ))}
                              </div>
                            )}
                            {/* Shared saves */}
                            {(top.shared_saves_count || 0) > 0 && (
                              <div className="style-twin-shared-saves">
                                <svg viewBox="0 0 24 24" width="14" height="14" fill="var(--accent)" stroke="none"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>
                                <span>{top.shared_saves_count} shared save{top.shared_saves_count !== 1 ? "s" : ""}{Array.isArray(top.shared_saves) && top.shared_saves.length > 0 ? `: ${top.shared_saves.join(", ")}` : ""}</span>
                              </div>
                            )}
                            {/* Actions */}
                            <div style={{ marginTop: 14, display: "flex", gap: 10 }}>
                              <button
                                className={`user-search-follow-btn ${isFlw ? "following" : "follow"}`}
                                onClick={(e) => { e.stopPropagation(); handleFollowFromSearch(top.id); }}
                                style={{ flex: 1, minHeight: 40, fontSize: 13, borderRadius: 10, fontWeight: 600 }}
                              >{isFlw ? "Following" : "Follow Twin"}</button>
                              <button
                                className="btn-ghost"
                                onClick={(e) => { e.stopPropagation(); setStyleTwinCompare(top); }}
                                style={{ minHeight: 40, fontSize: 13, borderRadius: 10, fontWeight: 600, padding: "0 16px" }}
                              >Compare</button>
                            </div>
                          </div>
                        );
                      })()}

                      {/* Remaining twins grid */}
                      {styleTwins.length > 1 && (
                        <div className="style-twins-grid">
                          {styleTwins.slice(1).map((twin, idx) => {
                            if (!twin || !twin.id) return null;
                            const ini = ((twin.display_name || "?") + "").split(" ").filter(Boolean).map(w => (w[0] || "")).join("").slice(0,2).toUpperCase() || "?";
                            const isFlw = followingSet ? followingSet.has(twin.id) : false;
                            const matchTier = (twin.match_pct || 0) >= 85 ? "high" : (twin.match_pct || 0) >= 70 ? "mid" : "low";
                            return (
                              <div key={twin.id || idx} className="style-twin-card" onClick={() => setStyleTwinCompare(twin)}>
                                <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
                                  <div className="style-twin-avatar-sm">
                                    {twin.avatar_url ? (
                                      <img src={twin.avatar_url} alt="" style={{ width: "100%", height: "100%", objectFit: "cover", borderRadius: "50%" }} />
                                    ) : (
                                      <span>{ini}</span>
                                    )}
                                  </div>
                                  <span className={`style-twin-match-badge style-twin-match-${matchTier}`}>{twin.match_pct || 0}%</span>
                                </div>
                                <div style={{ fontSize: 14, fontWeight: 600, color: "var(--text-primary)", marginBottom: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{twin.display_name || "Anonymous"}</div>
                                {twin.archetype && <div style={{ fontSize: 11, color: "var(--accent)", fontWeight: 600, marginBottom: 6 }}>{twin.archetype}</div>}
                                {/* Shared axes chips */}
                                {Array.isArray(twin.shared_axes) && twin.shared_axes.length > 0 && (
                                  <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginBottom: 6 }}>
                                    {twin.shared_axes.slice(0, 2).map((axis, i) => (
                                      <span key={i} className="style-twin-axis-chip" style={{ fontSize: 10, padding: "2px 8px" }}>{axis}</span>
                                    ))}
                                  </div>
                                )}
                                {/* Color palette mini-dots */}
                                {Array.isArray(twin.dominant_colors) && twin.dominant_colors.length > 0 && (
                                  <div style={{ display: "flex", gap: 4, marginBottom: 6 }}>
                                    {twin.dominant_colors.map((c, i) => (
                                      <span key={i} className="style-twin-color-dot" style={{ width: 16, height: 16, fontSize: 0, background: sdnaColorHex(c) }} title={c || ""} />
                                    ))}
                                  </div>
                                )}
                                {/* Shared saves pill */}
                                {(twin.shared_saves_count || 0) > 0 && (
                                  <div style={{ fontSize: 11, color: "var(--accent)", display: "flex", alignItems: "center", gap: 4, marginBottom: 8 }}>
                                    <svg viewBox="0 0 24 24" width="11" height="11" fill="var(--accent)" stroke="none"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>
                                    {twin.shared_saves_count} shared
                                  </div>
                                )}
                                <button
                                  className={`user-search-follow-btn ${isFlw ? "following" : "follow"}`}
                                  onClick={(e) => { e.stopPropagation(); handleFollowFromSearch(twin.id); }}
                                  style={{ width: "100%", minHeight: 34, fontSize: 12, borderRadius: 8 }}
                                >{isFlw ? "Following" : "Follow"}</button>
                              </div>
                            );
                          })}
                        </div>
                      )}
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
              <div style={{ fontFamily: "'Instrument Serif'", fontSize: 28, color: "var(--text-primary)", marginBottom: 8 }}>{t("scan_outfit")}</div>
              <div style={{ fontSize: 13, color: "var(--text-tertiary)", lineHeight: 1.6, maxWidth: 280, marginBottom: 32 }}>
                Upload a photo of any outfit to find where to buy it
              </div>

              {isGuest ? (
                <div style={{ marginBottom: 24 }}>
                  <div className="scan-counter" style={{ display: "inline-block" }}><strong>{guestScans}</strong> of 3 free scans used</div>
                </div>
              ) : isFree && scansLeft != null ? (
                <div style={{ marginBottom: 24 }}>
                  <div className="scan-counter" style={{ display: "inline-block" }}>{scansLeft > 0 ? <><strong>{scansLimit - scansLeft}</strong> of {scansLimit} scans used</> : <>No scans left &middot; <span style={{color:"var(--accent)",cursor:"pointer"}} onClick={() => setUpgradeModal("scan_limit")}>Go Pro</span></>}</div>
                </div>
              ) : null}

              {/* Scan actions — camera or gallery */}
              <div style={{ width: "100%", maxWidth: 340, display: "flex", flexDirection: "column", gap: 12 }}>
                <button className="btn-primary" onClick={() => fileRef.current?.click()} style={{ width: "100%", padding: "16px 0", borderRadius: 14, fontFamily: "var(--font-sans)", fontWeight: 700, fontSize: 16, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 10, minHeight: 52 }}>
                  <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="6" width="20" height="14" rx="3" /><circle cx="12" cy="13" r="4" /><path d="M8 6l1.5-3h5L16 6" /></svg>
                  Take Photo
                </button>
                <button className="btn-secondary" onClick={() => galleryRef.current?.click()} style={{ width: "100%", padding: "16px 0", borderRadius: 14, fontFamily: "var(--font-sans)", fontWeight: 700, fontSize: 16, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 10, minHeight: 52 }}>
                  <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
                  Choose from Gallery
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
              {/* Centered content panel — fixed width to prevent layout shift */}
              <div className="animate-scale-in" style={{ position: "relative", zIndex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 24, padding: "40px 32px", background: "rgba(12,12,14,0.7)", backdropFilter: "blur(20px)", WebkitBackdropFilter: "blur(20px)", borderRadius: 20, border: "1px solid rgba(201,169,110,.15)", width: 300 }}>
                {/* Branded logo spinner — triple orbit rings + floating logo + particles */}
                <div className="identify-logo-container">
                  <div className="identify-orbit-outer" />
                  <div className="identify-orbit" />
                  <div className="identify-orbit-inner" />
                  <div className="identify-progress-arc" />
                  <div className="identify-glow" />
                  <div className="identify-scan-line" />
                  <div className="identify-particle" />
                  <div className="identify-particle" />
                  <div className="identify-particle" />
                  <img src="/logo-dark.svg" alt="ATTAIRE" className="identify-logo-img identify-logo-img--dark" /><img src="/logo-light.svg" alt="ATTAIRE" className="identify-logo-img identify-logo-img--light" />
                </div>

                {/* Animated status text */}
                <div style={{ textAlign: "center" }}>
                  <div className="identify-shimmer" style={{ fontSize: 10, fontWeight: 700, letterSpacing: 2.5, textTransform: "uppercase", marginBottom: 10 }}>Identifying outfit</div>
                  <div className="serif" style={{ fontSize: 18, color: "var(--text-primary)", transition: "opacity .35s ease", opacity: loadMsgVisible ? 1 : 0, minHeight: 28 }}>{SCAN_MESSAGES[loadMsgIdx]}</div>
                </div>

                {/* Step dots progress */}
                <div className="identify-steps">
                  {SCAN_MESSAGES.map((_, i) => (
                    <div key={i} className={`identify-step-dot${i <= loadMsgIdx ? " active" : ""}`} />
                  ))}
                </div>

                {/* Free user ad slot during loading */}
                {isFree && (
                  <div onClick={() => setUpgradeModal("identifying_ad")} style={{ width: "100%", padding: "12px 16px", background: "linear-gradient(135deg, rgba(201,169,110,.08), rgba(201,169,110,.02))", border: "1px solid rgba(201,169,110,.15)", borderRadius: 12, cursor: "pointer", textAlign: "center" }}>
                    <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: 1.5, color: "rgba(201,169,110,.4)", textTransform: "uppercase", marginBottom: 4 }}>Sponsored</div>
                    <div style={{ fontSize: 13, fontWeight: 600, color: "var(--accent)" }}>Skip the wait — Go Pro</div>
                    <div style={{ fontSize: 11, color: "var(--text-tertiary)", marginTop: 2 }}>Unlimited scans &middot; Priority results</div>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* ─── Error (enhanced) ──────────────────────── */}
          {tab === "scan" && error && phase === "idle" && (
            <div className="animate-slide-up" style={{ padding: "0 20px 80px" }}>
              {img && <img src={img} style={{width:"100%",maxHeight:"25vh",objectFit:"cover",display:"block",filter:"brightness(0.25)",borderRadius:16,marginBottom:16}} alt="" />}
              <div className="scan-error-state">
                <div className="scan-error-icon">
                  {error.includes("internet") || error.includes("server") ? "📡" : error.includes("scan") && error.includes("limit") ? "🔒" : "🔍"}
                </div>
                <div className="scan-error-title">
                  {error.includes("internet") || error.includes("server") ? "Connection issue" : error.includes("scan") && error.includes("limit") ? "Scan limit reached" : "Scan didn't work"}
                </div>
                <div className="scan-error-msg">{error}</div>
                <div className="scan-error-tips">
                  <div className="scan-error-tip">Make sure the outfit is clearly visible</div>
                  <div className="scan-error-tip">Try a well-lit, head-to-toe photo</div>
                  <div className="scan-error-tip">Screenshots from social media work great</div>
                </div>
                <button className="btn-primary" style={{width:"100%",marginTop:16}} onClick={reset}>Try another photo</button>
              </div>
            </div>
          )}

          {/* ─── Empty identification (0 items found) ──── */}
          {tab === "scan" && results && results.items.length === 0 && phase === "picking" && (
            <div className="animate-slide-up" style={{ padding: "0 20px 80px" }}>
              {img && <img src={img} style={{width:"100%",maxHeight:"25vh",objectFit:"cover",display:"block",filter:"brightness(0.25)",borderRadius:16,marginBottom:16}} alt="" />}
              <div className="scan-error-state">
                <div className="scan-error-icon">👀</div>
                <div className="scan-error-title">No clothing detected</div>
                <div className="scan-error-msg">Our AI couldn't identify any clothing items in this photo. This usually means the image doesn't contain a clear outfit.</div>
                <div className="scan-error-tips">
                  <div className="scan-error-tip">Upload a photo with visible clothing</div>
                  <div className="scan-error-tip">Close-ups of single items work too</div>
                  <div className="scan-error-tip">Avoid photos that are mostly scenery</div>
                </div>
                <button className="btn-primary" style={{width:"100%",marginTop:16}} onClick={reset}>Try another photo</button>
              </div>
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
              </div>

              {/* Global budget — preset chips + dual-thumb slider */}
              <div style={{ padding: "12px 20px 4px" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                  <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text-secondary)" }}>Budget</span>
                  <span style={{ fontSize: 13, fontWeight: 700, color: "var(--accent)" }}>
                    {`$${budgetMin} – ${budgetMax >= 500 ? "$500+" : `$${budgetMax}`}`}
                  </span>
                </div>
                {(() => {
                  const presets = [
                    { label: "$", min: 0, max: 50, desc: t("budget_tier_under50") },
                    { label: "$$", min: 50, max: 150, desc: t("budget_tier_mid") },
                    { label: "$$$", min: 150, max: 300, desc: t("budget_tier_high") },
                    { label: "$$$$", min: 300, max: 500, desc: t("budget_tier_premium") },
                  ];
                  const sel = selectedBudgetTiers;
                  const minIdx = sel.size > 0 ? Math.min(...sel) : -1;
                  const maxIdx = sel.size > 0 ? Math.max(...sel) : -1;
                  const fillLeft = sel.size > 0 ? (minIdx / presets.length) * 100 : 0;
                  const fillWidth = sel.size > 0 ? ((maxIdx - minIdx + 1) / presets.length) * 100 : 0;
                  return (
                    <div className="budget-tier-bar-wrap">
                      <div className="budget-tier-bar-track" />
                      {sel.size > 0 && <div className="budget-tier-bar-fill" style={{ left: `${fillLeft}%`, width: `${fillWidth}%` }} />}
                      {presets.map((p, idx) => {
                        const active = sel.has(idx);
                        const inRange = sel.size > 0 && idx >= minIdx && idx <= maxIdx;
                        return (
                          <button key={p.label} aria-label={`Budget tier ${p.label}: ${p.desc}`}
                            onClick={() => {
                              setSelectedBudgetTiers(prev => {
                                const next = new Set(prev);
                                if (next.has(idx)) next.delete(idx); else next.add(idx);
                                if (next.size === 0) { setBudgetMin(0); setBudgetMax(500); }
                                else {
                                  setBudgetMin(Math.min(...[...next].map(i => presets[i].min)));
                                  setBudgetMax(Math.max(...[...next].map(i => presets[i].max)));
                                }
                                return next;
                              });
                            }}
                            className={`budget-tier-btn${active ? " budget-tier-active" : ""}${inRange && !active ? " budget-tier-inrange" : ""}`}
                          >
                            <span>{p.label}</span>
                            <span style={{ fontSize: 9, fontWeight: 400, opacity: 0.7 }}>{p.desc}</span>
                          </button>
                        );
                      })}
                    </div>
                  );
                })()}
                {/* Dual-thumb range slider */}
                <div style={{ position: "relative", height: 28, marginTop: 8 }}>
                  <div style={{ position: "absolute", top: 12, left: 0, right: 0, height: 4, background: "var(--bg-input)", borderRadius: 2 }} />
                  <div style={{ position: "absolute", top: 12, left: `${(budgetMin / 500) * 100}%`, right: `${100 - (budgetMax / 500) * 100}%`, height: 4, background: "var(--accent)", borderRadius: 2 }} />
                  <input type="range" min={0} max={500} step={10} value={budgetMin}
                    onChange={e => { const v = parseInt(e.target.value); if (v < budgetMax) { setBudgetMin(v); setSelectedBudgetTiers(new Set()); } }}
                    aria-label="Minimum budget"
                    style={{ position: "absolute", top: 0, left: 0, width: "100%", height: 28, appearance: "none", WebkitAppearance: "none", background: "transparent", pointerEvents: "none", zIndex: 2 }}
                    className="budget-range-thumb"
                  />
                  <input type="range" min={0} max={500} step={10} value={budgetMax}
                    onChange={e => { const v = parseInt(e.target.value); if (v > budgetMin) { setBudgetMax(v); setSelectedBudgetTiers(new Set()); } }}
                    aria-label="Maximum budget"
                    style={{ position: "absolute", top: 0, left: 0, width: "100%", height: 28, appearance: "none", WebkitAppearance: "none", background: "transparent", pointerEvents: "none", zIndex: 3 }}
                    className="budget-range-thumb"
                  />
                </div>
              </div>

              {/* Advanced filters — above item list for visibility */}
              <div style={{ padding: "0 20px 8px" }}>
                <button
                  className="advanced-toggle"
                  aria-label={showAdvanced ? "Collapse advanced filters" : "Expand advanced filters"}
                  aria-expanded={showAdvanced}
                  onClick={() => setShowAdvanced(v => !v)}
                >
                  <span>Advanced filters{occasion || searchNotes ? " (active)" : ""}</span>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                    style={{ transform: showAdvanced ? "rotate(180deg)" : "rotate(0deg)" }}>
                    <polyline points="6 9 12 15 18 9"/>
                  </svg>
                </button>
                {showAdvanced && (
                  <div className="animate-slide-down" style={{ paddingBottom: 12 }}>
                    {/* Style Preference */}
                    <div style={{ marginBottom: 12 }}>
                      <div className="item-opts-label">Style Preference</div>
                      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                        {[
                          { v: "auto", l: "Auto-detect" },
                          { v: "menswear", l: "Menswear" },
                          { v: "womenswear", l: "Womenswear" },
                          { v: "unisex", l: "Unisex" },
                        ].map(({ v, l }) => {
                          const currentPref = results.stylePref || "auto";
                          return (
                            <button key={v} className={`scan-vis-chip${currentPref === v ? " active" : ""}`} onClick={() => {
                              setResults(prev => prev ? { ...prev, stylePref: v, gender: v === "menswear" ? "male" : v === "womenswear" ? "female" : prev.gender } : prev);
                            }}>
                              {l}
                            </button>
                          );
                        })}
                      </div>
                    </div>

                    {/* Occasion chips */}
                    <div style={{ marginBottom: 12 }}>
                      <div className="item-opts-label">Occasion</div>
                      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                        {[
                          { v: "casual",          l: "Casual",          icon: "\u2600\uFE0F" },
                          { v: "work",            l: "Work",            icon: "\uD83D\uDCBC" },
                          { v: "night_out",       l: "Night Out",       icon: "\uD83C\uDF19" },
                          { v: "date_night",      l: "Date Night",      icon: "\uD83D\uDC95" },
                          { v: "business_casual", l: "Business Casual", icon: "\uD83D\uDC54" },
                          { v: "formal",          l: "Formal",          icon: "\u2728" },
                          { v: "athletic",        l: "Athletic",        icon: "\uD83C\uDFC3" },
                          { v: "athleisure",      l: "Athleisure",      icon: "\uD83E\uDDD8" },
                          { v: "streetwear",      l: "Streetwear",      icon: "\uD83D\uDD25" },
                          { v: "brunch",          l: "Brunch",          icon: "\uD83E\uDD42" },
                          { v: "vacation",        l: "Vacation",        icon: "\uD83C\uDFD6\uFE0F" },
                          { v: "outdoor",         l: "Outdoor",         icon: "\uD83C\uDF32" },
                          { v: "festival",        l: "Festival",        icon: "\uD83C\uDFB6" },
                          { v: "wedding_guest",   l: "Wedding Guest",   icon: "\uD83D\uDC92" },
                          { v: "lounge",          l: "Lounge",          icon: "\uD83D\uDECB\uFE0F" },
                          { v: "travel",          l: "Travel",          icon: "\u2708\uFE0F" },
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
                          }} style={{ padding: "8px 14px", background: "var(--accent)", border: "none", borderRadius: 10, color: "var(--text-inverse)", fontFamily: "var(--font-sans)", fontSize: 12, fontWeight: 700, cursor: "pointer", whiteSpace: "nowrap", minHeight: 44 }}>
                            Set
                          </button>
                        </div>
                      )}
                    </div>

                    {/* Search Notes */}
                    <div>
                      <div className="item-opts-label">Search notes</div>
                      <textarea
                        value={searchNotes}
                        onChange={e => setSearchNotes(e.target.value.slice(0, 200))}
                        placeholder={t("search_notes_placeholder")}
                        rows={2}
                        className="refine-input"
                        style={{ width: "100%", fontSize: 12 }}
                      />
                    </div>
                  </div>
                )}
              </div>

              {/* ── Divider between filters and item list ── */}
              <div style={{ margin: "4px 20px 8px", display: "flex", alignItems: "center", gap: 10 }}>
                <div style={{ flex: 1, height: 1, background: "var(--border)" }} />
                <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: 1.5, color: "var(--text-tertiary)", textTransform: "uppercase", flexShrink: 0 }}>Items found</span>
                <div style={{ flex: 1, height: 1, background: "var(--border)" }} />
              </div>

              {/* Item pick list — circle intent: only show circled items unless expanded */}
              {(() => {
                const hasCircled = results.items.some(it => it.priority);
                const hiddenCount = hasCircled && !showAllPickItems ? results.items.filter(it => !it.priority).length : 0;
                const visibleItems = hasCircled && !showAllPickItems
                  ? results.items.map((item, i) => ({ item, i })).filter(({ item }) => item.priority)
                  : results.items.map((item, i) => ({ item, i }));
                return (
                  <div className="pick-list">
                    {hasCircled && !showAllPickItems && (
                      <div style={{ padding: "8px 0 4px", textAlign: "center" }}>
                        <span style={{ fontSize: 12, color: "var(--accent)", fontWeight: 600 }}>Showing circled items only</span>
                      </div>
                    )}
                    {visibleItems.map(({ item, i }) => {
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
                    {hasCircled && hiddenCount > 0 && (
                      <button className="btn-ghost" style={{ width: "100%", fontSize: 12, padding: "10px 0", marginTop: 4 }}
                        onClick={() => setShowAllPickItems(true)}>
                        Show all {results.items.length} items ({hiddenCount} more)
                      </button>
                    )}
                    {hasCircled && showAllPickItems && (
                      <button className="btn-ghost" style={{ width: "100%", fontSize: 12, padding: "10px 0", marginTop: 4 }}
                        onClick={() => setShowAllPickItems(false)}>
                        Show circled only
                      </button>
                    )}
                  </div>
                );
              })()}

              {/* Search Mode Toggle */}
              <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
                <button
                  onClick={() => { if (isFree && fastSearchesLeft <= 0) { setUpgradeModal("search_limit"); return; } setSearchMode("fast"); }}
                  style={{
                    flex: 1, padding: "8px 0", borderRadius: 8, fontSize: 13, fontWeight: 600,
                    border: searchMode === "fast" ? "2px solid var(--accent)" : "1px solid var(--border)",
                    background: searchMode === "fast" ? "var(--accent-bg)" : "transparent",
                    color: searchMode === "fast" ? "var(--accent)" : "var(--text-secondary)",
                    opacity: (isFree && fastSearchesLeft <= 0) ? 0.45 : 1,
                  }}
                >
                  <div>⚡ Fast Search</div>
                  {isFree && <div style={{ fontSize: 10, fontWeight: 400, opacity: .7, marginTop: 2 }}>{fastSearchesLeft > 0 ? `${fastSearchesLeft} left this month` : "Limit reached"}</div>}
                </button>
                <button
                  onClick={() => { if (isFree && deepSearchesLeft <= 0) { setUpgradeModal("search_limit"); return; } setSearchMode("extended"); }}
                  style={{
                    flex: 1, padding: "8px 0", borderRadius: 8, fontSize: 13, fontWeight: 600,
                    border: searchMode === "extended" ? "2px solid var(--accent)" : "1px solid var(--border)",
                    background: searchMode === "extended" ? "var(--accent-bg)" : "transparent",
                    color: searchMode === "extended" ? "var(--accent)" : "var(--text-secondary)",
                    opacity: (isFree && deepSearchesLeft <= 0) ? 0.45 : 1,
                  }}
                >
                  <div>🔍 Deep Search</div>
                  {isFree && <div style={{ fontSize: 10, fontWeight: 400, opacity: .7, marginTop: 2 }}>{deepSearchesLeft > 0 ? `${deepSearchesLeft} left this week` : "Limit reached"}</div>}
                </button>
              </div>
              <div style={{ fontSize: 11, color: "var(--text-tertiary)", textAlign: "center", marginBottom: 8 }}>
                {searchMode === "fast" ? "Quick results in ~5 seconds" : "AI-ranked results, deeper matching (~15-20s)"}
              </div>

              {/* Search CTA */}
              <div className="pick-cta">
                <button
                  style={{ background: pickedItems.size > 0 ? "var(--accent)" : "var(--accent-bg)", color: pickedItems.size > 0 ? "var(--text-inverse)" : "var(--text-tertiary)" }}
                  onClick={runProductSearch}
                  disabled={pickedItems.size === 0}
                >
                  {pickedItems.size === 0 ? "Select items to search" : `${searchMode === "extended" ? "Deep " : ""}Search ${pickedItems.size} item${pickedItems.size > 1 ? "s" : ""}${occasion ? ` \u00b7 ${({casual:"Casual",work:"Work",night_out:"Night Out",date_night:"Date Night",business_casual:"Business Casual",formal:"Formal",athletic:"Athletic",athleisure:"Athleisure",streetwear:"Streetwear",brunch:"Brunch",vacation:"Vacation",outdoor:"Outdoor",festival:"Festival",wedding_guest:"Wedding Guest",lounge:"Lounge",travel:"Travel"})[occasion] || occasion}` : ""}`}
                </button>
                <button className="btn-ghost" style={{ width: "100%", fontSize: 12, marginTop: 4 }}
                  onClick={() => { setPickedItems(new Set(results.items.map((_, i) => i))); }}>
                  Select all
                </button>
              </div>
            </div>
          )}

          {/* ─── Search Takeover (A+B combo: branded full-screen + item cards) ── */}
          {tab === "scan" && results && phase === "searching" && !isResearch && (
            <div className="search-takeover">
              {/* Back button */}
              <button className="search-takeover-back" onClick={() => { setPhase("picking"); setExpandedItems(new Set()); }}>
                &larr; Back
              </button>

              {/* Blurred photo background */}
              <div className="search-takeover-bg">
                <img src={img} alt="" />
              </div>

              {/* Content */}
              <div className="search-takeover-content">
                {/* Branded logo spinner — reuse identifying animation */}
                <div className="identify-logo-container">
                  <div className="identify-orbit-outer" />
                  <div className="identify-orbit" />
                  <div className="identify-orbit-inner" />
                  <div className="identify-progress-arc" />
                  <div className="identify-glow" />
                  <div className="identify-scan-line" />
                  <div className="identify-particle" />
                  <div className="identify-particle" />
                  <div className="identify-particle" />
                  <img src="/logo-dark.svg" alt="ATTAIRE" className="identify-logo-img identify-logo-img--dark" /><img src="/logo-light.svg" alt="ATTAIRE" className="identify-logo-img identify-logo-img--light" />
                </div>

                {/* Cycling status text */}
                <div className="search-takeover-status">
                  <div className="identify-shimmer search-takeover-status-label">Finding your matches</div>
                  <div className="search-takeover-status-msg serif" style={{ opacity: loadMsgVisible ? 1 : 0, transition: "opacity .35s ease" }}>
                    {SEARCH_MESSAGES[loadMsgIdx % SEARCH_MESSAGES.length]}
                  </div>
                </div>

                {/* Item cards */}
                <div className="search-item-cards">
                  {results.items.map((item, i) => {
                    if (!pickedItems.has(i)) return null;
                    const isRevealed = revealedSearchItems.has(i);
                    const isFailed = isRevealed && item.status === "failed";
                    const productCount = item.tiers ? ["budget", "mid", "premium", "resale"].reduce((sum, tk) => sum + asTierArray(item.tiers[tk]).length, 0) : 0;
                    return (
                      <div key={i} className={`search-item-card${isRevealed ? (isFailed ? " failed" : " found") : ""}`} style={{ animationDelay: `${i * 0.1}s` }}>
                        <div className={`search-card-icon${isRevealed ? (isFailed ? " failed" : " found") : " searching"}`}>
                          {!isRevealed ? (
                            <div className="ld-dot" style={{ width: 8, height: 8, background: "var(--accent)" }} />
                          ) : isFailed ? (
                            <svg width="14" height="14" viewBox="0 0 14 14"><path d="M3 3l8 8M11 3l-8 8" fill="none" stroke="#FF5252" strokeWidth="2" strokeLinecap="round"/></svg>
                          ) : (
                            <svg width="14" height="14" viewBox="0 0 14 14"><path d="M2 7.5L5.5 11L12 3" fill="none" stroke="#C9A96E" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
                          )}
                        </div>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div className="search-card-name">{item.name}</div>
                          <div className={`search-card-detail${isRevealed ? (isFailed ? " failed" : " found") : ""}`}>
                            {!isRevealed
                              ? `${item.brand && item.brand !== "Unidentified" ? item.brand + " · " : ""}${item.category}`
                              : isFailed ? "No matches" : `${productCount} match${productCount !== 1 ? "es" : ""} found`}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>

                {/* Progress dots */}
                <div className="identify-steps" style={{ marginTop: 4 }}>
                  {results.items.filter((_, i) => pickedItems.has(i)).map((_, i) => (
                    <div key={i} className={`identify-step-dot${i < revealedSearchItems.size ? " active" : ""}`} />
                  ))}
                </div>

                {/* ATTAIRE promo for free users during search */}
                {(isFree || isGuest) && (
                  <div style={{ marginTop: 24, padding: "20px 24px", background: "rgba(201,169,110,.08)", border: "1px solid rgba(201,169,110,.15)", borderRadius: 16, textAlign: "center", maxWidth: 320 }}>
                    <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: 1.5, color: "var(--accent)", marginBottom: 8, textTransform: "uppercase" }}>ATTAIRE Pro</div>
                    <div style={{ fontSize: 14, fontWeight: 600, color: "var(--text-primary)", marginBottom: 6 }}>Unlock unlimited scans</div>
                    <div style={{ fontSize: 12, color: "var(--text-secondary)", marginBottom: 14, lineHeight: 1.4 }}>
                      Extended search, price alerts, Style DNA, and priority results.
                    </div>
                    <button onClick={() => { setUpgradeModal("search_promo"); track("promo_clicked", { location: "search_loading" }); }} style={{ padding: "10px 28px", background: "linear-gradient(135deg, #C9A96E 0%, #B8944F 100%)", border: "none", borderRadius: 100, fontSize: 12, fontWeight: 700, color: "#0C0C0E", cursor: "pointer", fontFamily: "var(--font-sans)" }}>
                      Try Pro Free
                    </button>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* ─── Results (Minimalist Redesign) ───────────────────────────────── */}
          {tab === "scan" && results && (phase === "done" || (phase === "searching" && isResearch)) && (
            <div className="res">
              {/* Re-search banner */}
              {phase === "searching" && isResearch && (
                <div style={{ position: "fixed", inset: 0, zIndex: 9999, background: "rgba(0,0,0,.75)", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 16, backdropFilter: "blur(6px)", WebkitBackdropFilter: "blur(6px)" }}>
                  <div style={{ display: "flex", gap: 6 }}>
                    <div className="ld-dot" style={{ background: "var(--accent)", width: 10, height: 10 }} />
                    <div className="ld-dot" style={{ background: "var(--accent)", width: 10, height: 10, animationDelay: ".15s" }} />
                    <div className="ld-dot" style={{ background: "var(--accent)", width: 10, height: 10, animationDelay: ".3s" }} />
                  </div>
                  <div style={{ fontSize: 15, fontWeight: 600, color: "var(--accent)", transition: "opacity .35s ease", opacity: loadMsgVisible ? 1 : 0.3, textAlign: "center", padding: "0 32px" }}>
                    {RESEARCH_MESSAGES[loadMsgIdx % RESEARCH_MESSAGES.length]}
                  </div>
                  {searchNotes && <div style={{ fontSize: 12, color: "rgba(255,255,255,.5)", marginTop: 4 }}>"{searchNotes}"</div>}
                </div>
              )}

              {/* Progress bar */}
              <div className="v-banner">
                <div className="v-steps">
                  <div className="v-step" style={{ cursor: "pointer" }} onClick={() => { setPhase("picking"); setExpandedItems(new Set()); }}>
                    <div className="v-step-bar"><div className="v-step-fill" style={{ width: "100%", background: "var(--accent)" }} /></div>
                    <div className="v-step-l" style={{ color: "var(--accent)" }}>&larr; Identified</div>
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

              {/* ─── Retailer Spotlight banner (free users) ─── */}
              {showAds && (() => { const s = RETAILER_SPOTLIGHTS[(results?.items?.length || 0) % RETAILER_SPOTLIGHTS.length]; return (
                <a href={s.url} target="_blank" rel="noopener noreferrer" onClick={() => API.logAdEvent("banner", "results", "click", s.name)} className="ad-slot ad-banner" style={{ margin: "0 20px 8px", height: "auto", borderRadius: 12, overflow: "hidden", border: "1px solid var(--border)", background: "var(--accent-bg)", textDecoration: "none", display: "block" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 12px" }}>
                    <div style={{ width: 38, height: 38, borderRadius: 8, background: s.gradient, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                      <span style={{ fontSize: 14, fontWeight: 900, color: s.accent, fontFamily: "var(--font-sans)" }}>{s.name.charAt(0)}</span>
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 12, fontWeight: 700, color: "var(--text-primary)", marginBottom: 2 }}>{s.name}</div>
                      <div style={{ fontSize: 10, color: "var(--text-tertiary)" }}>{s.tagline}</div>
                    </div>
                    <div style={{ fontSize: 9, color: "var(--accent)", fontWeight: 700, letterSpacing: .3, flexShrink: 0 }}>Shop</div>
                  </div>
                </a>
              ); })()}

              {/* ═══════════════════════════════════════════════════════════
                  COMPLETE THE LOOK — always visible
                  ═══════════════════════════════════════════════════════════ */}
              {phase === "done" && results?.items?.length > 0 && (
                <div style={{ padding: "12px 20px 8px" }}>
                  <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: 1.5, color: "var(--text-tertiary)", textTransform: "uppercase", marginBottom: 10 }}>{t("complete_look")}</div>
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
                      {t("complete_look_btn")}
                    </button>
                  )}
                  {pairingsLoading && (
                    <div style={{ padding: "14px", textAlign: "center", color: "var(--text-tertiary)", fontSize: 12 }}>
                      <div className="ld-dots" style={{ justifyContent: "center", marginBottom: 6 }}><div className="ld-dot" /><div className="ld-dot" /><div className="ld-dot" /></div>
                      {t("finding_pieces")}
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

              {/* ═══════════════════════════════════════════════════════════
                  REFINE SEARCH — AI chat input
                  ═══════════════════════════════════════════════════════════ */}
              {phase === "done" && (
                <div style={{ padding: "0 20px" }}>
                  {/* AI refine chat input — always visible */}
                  <div style={{ marginBottom: 12 }}>
                    <div className="refine-input-row">
                      <input
                        value={searchNotes}
                        onChange={e => setSearchNotes(e.target.value.slice(0, 200))}
                        onKeyDown={e => { if (e.key === "Enter" && searchNotes.trim()) { e.target.blur(); runProductSearch(); } }}
                        placeholder="Refine your results with AI..."
                        className="refine-input"
                        style={{ flex: 1, minHeight: 44 }}
                      />
                      <button
                        className="refine-send"
                        disabled={!searchNotes.trim()}
                        onClick={() => { if (searchNotes.trim()) runProductSearch(); }}
                        aria-label="Run refined search"
                      >
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
                      </button>
                    </div>
                    {searchNotes && (
                      <div style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "4px 10px", background: "var(--accent-bg)", border: "1px solid var(--accent-border)", borderRadius: "var(--radius-full)", marginTop: 6, fontSize: 11, color: "var(--accent)" }}>
                        Active: {searchNotes}
                        <button aria-label="Clear refine" onClick={() => { setSearchNotes(""); setTimeout(() => runProductSearch(), 100); }}
                          style={{ background: "none", border: "none", color: "var(--accent)", cursor: "pointer", fontSize: 13, padding: 0, lineHeight: 1 }}>&times;</button>
                      </div>
                    )}
                  </div>

                  {/* More options toggle — visually separated */}
                  <div style={{ marginTop: 12, paddingTop: 12, borderTop: "1px dashed var(--border)" }}>
                    <button
                      onClick={() => setShowAdvanced(a => !a)}
                      style={{ width: "100%", display: "flex", alignItems: "center", justifyContent: "center", gap: 6, padding: "8px 0", background: "none", border: "none", cursor: "pointer", fontFamily: "var(--font-sans)", color: "var(--text-tertiary)", fontSize: 11, fontWeight: 600, letterSpacing: 0.3 }}
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
                      More options
                      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ transition: "transform .2s", transform: showAdvanced ? "rotate(180deg)" : "rotate(0)" }}>
                        <polyline points="6 9 12 15 18 9"/>
                      </svg>
                    </button>
                  </div>

                  {showAdvanced && (
                    <div style={{ paddingBottom: 16, display: "flex", flexDirection: "column", gap: 16, animation: "slideDown .2s ease" }}>

                      {/* Budget presets + range */}
                      <div>
                        <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: 1.5, color: "var(--text-tertiary)", textTransform: "uppercase", marginBottom: 8 }}>{t("budget_range")}</div>
                        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 10 }}>
                          {[
                            { l: t("budget_tier_under50"), min: 0, max: 50 },
                            { l: t("budget_tier_mid"), min: 50, max: 150 },
                            { l: t("budget_tier_high"), min: 150, max: 500 },
                            { l: t("budget_tier_premium"), min: 500, max: 2000 },
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
                    </div>
                  )}

                  {/* Visibility toggle */}
                  {scanId && (
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "8px 20px" }}>
                      <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text-secondary)" }}>
                        {(history.find(h => h.id === scanId)?.visibility || "public") === "public" ? "Public" : "Private"}
                      </span>
                      <div onClick={() => { const scan = history.find(h => h.id === scanId); if (scan) toggleVisibility({ stopPropagation: () => {} }, scan); }}
                        style={{ width: 44, height: 26, borderRadius: 13, background: (history.find(h => h.id === scanId)?.visibility || "public") === "public" ? "var(--accent)" : "var(--border)", position: "relative", transition: "background 0.2s", cursor: "pointer" }}>
                        <div style={{ width: 20, height: 20, borderRadius: "50%", background: "#fff", position: "absolute", top: 3, left: (history.find(h => h.id === scanId)?.visibility || "public") === "public" ? 21 : 3, transition: "left 0.2s", boxShadow: "0 1px 3px rgba(0,0,0,.2)" }} />
                      </div>
                    </div>
                  )}

                  {/* Share button — opens share sheet */}
                      {scanId && (<>
                        <div style={{ height: 1, background: "var(--border)", margin: "14px 0" }} />
                        <button
                          aria-label="Share Your Look"
                          onClick={() => {
                            API.updateScanVisibility(scanId, "public").catch(() => {});
                            setShowShareSheet(true);
                          }}
                          style={{
                            width: "100%", display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
                            padding: "14px 16px", minHeight: 48,
                            background: "var(--accent)", color: "var(--text-inverse)",
                            border: "none", borderRadius: "var(--radius-md)",
                            fontFamily: "var(--font-sans)", fontSize: 14, fontWeight: 700, cursor: "pointer",
                            boxShadow: "0 2px 12px rgba(201,169,110,.3)",
                          }}
                        >
                          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>
                          Share This Look
                        </button>
                  </>)}
                </div>
              )}

              {/* All searches failed banner */}
              {phase === "done" && results.items.filter(it => pickedItems.has(results.items.indexOf(it))).every(it => it.status === "failed") && (
                <div className="scan-error-state" style={{ margin: "0 20px 16px" }}>
                  <div className="scan-error-icon">🔍</div>
                  <div className="scan-error-title">No products found</div>
                  <div className="scan-error-msg">We couldn't find matching products for these items. This can happen with very unique or niche items.</div>
                  <div className="scan-error-tips">
                    <div className="scan-error-tip">Try adjusting your budget range</div>
                    <div className="scan-error-tip">Use the Deep Search mode for better results</div>
                    <div className="scan-error-tip">Add search notes to describe what you're looking for</div>
                  </div>
                  <button className="btn-secondary" style={{width:"100%",marginTop:12}} onClick={() => { setPhase("picking"); }}>Back to items</button>
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

                  // Dupe detection: find highest-priced product, flag 40%+ cheaper alternatives
                  const dupeMap = new Map(); // key: "tierKey_j" → { savings, vsPrice, vsStore, vsTier }
                  if (item.tiers) {
                    const allPriced = allTierProducts
                      .map(p => ({ ...p, _numPrice: parseFloat((p.price || "").replace(/[^0-9.]/g, "")) }))
                      .filter(p => p._numPrice > 0);
                    if (allPriced.length >= 2) {
                      const maxProduct = allPriced.reduce((a, b) => a._numPrice > b._numPrice ? a : b);
                      allPriced.forEach(p => {
                        if (p === maxProduct) return;
                        const savings = 1 - (p._numPrice / maxProduct._numPrice);
                        if (savings >= 0.4) {
                          const tierProducts = asTierArray(item.tiers[p._tier]);
                          const idx = tierProducts.findIndex(tp => tp.url === p.url && tp.product_name === p.product_name);
                          if (idx >= 0) {
                            dupeMap.set(`${p._tier}_${idx}`, {
                              savings: Math.round(savings * 100),
                              vsPrice: maxProduct.price,
                              vsStore: maxProduct.brand,
                              vsTier: maxProduct._tier,
                              vsUrl: maxProduct.url,
                            });
                          }
                        }
                      });
                    }
                  }

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
                                <div style={{ padding: "0 20px 6px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                                  <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: 1.5, color: cfg.accent, textTransform: "uppercase" }}>{cfg.label}</span>
                                  {products.length > 2 && <span style={{ fontSize: 10, color: "var(--text-tertiary)", paddingRight: 4 }}>Swipe &rarr;</span>}
                                </div>
                                <div className="scroll-x scroll-x-fade" style={{ display: "flex", gap: 10, overflowX: "auto", paddingLeft: 20, paddingRight: 20, paddingBottom: 4, scrollSnapType: "x mandatory", WebkitOverflowScrolling: "touch", msOverflowStyle: "none", scrollbarWidth: "none" }}>
                                  {products.map((p, j) => {
                                    const isFallback = !p.is_product_page && p.brand === "Google Shopping";
                                    const clickId = `${scanId || "x"}_${i}_${tierKey}_${j}`;
                                    const href = p.url ? API.affiliateUrl(clickId, p.url, scanId, i, tierKey, p.brand) : "#";
                                    const isSavedProduct = saved.some(s => (s.item_data?.name || s.name) === (p.product_name || item.name));
                                    const dupeInfo = dupeMap.get(`${tierKey}_${j}`);
                                    return (
                                      <div key={j} className="card-press" style={{ flexShrink: 0, width: 150, scrollSnapAlign: "start", position: "relative" }}>
                                        {/* Style Match Score pill */}
                                        {p.style_match != null && p.style_match >= 50 ? (
                                          <div
                                            className={`style-match-pill ${p.style_match >= 80 ? "style-match-green" : "style-match-yellow"}`}
                                            onClick={e => { e.preventDefault(); e.stopPropagation(); setStyleMatchTooltip(prev => prev?.key === `${i}_${tierKey}_${j}` ? null : { key: `${i}_${tierKey}_${j}` }); }}
                                            style={{ cursor: "pointer" }}
                                          >
                                            <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
                                            {p.style_match}% your style
                                            {styleMatchTooltip?.key === `${i}_${tierKey}_${j}` && (
                                              <div className="style-match-tooltip" onClick={e => e.stopPropagation()}>
                                                Based on your Style DNA profile
                                              </div>
                                            )}
                                          </div>
                                        ) : p.style_match === null && j === 0 && (
                                          <div
                                            className="style-match-pill style-match-new"
                                            onClick={e => { e.preventDefault(); e.stopPropagation(); setStyleMatchTooltip(prev => prev?.key === `${i}_${tierKey}_${j}` ? null : { key: `${i}_${tierKey}_${j}` }); }}
                                            style={{ cursor: "pointer" }}
                                          >
                                            <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}><path d="M12 2L15.09 8.26L22 9.27L17 14.14L18.18 21.02L12 17.77L5.82 21.02L7 14.14L2 9.27L8.91 8.26L12 2Z"/></svg>
                                            New to you
                                            {styleMatchTooltip?.key === `${i}_${tierKey}_${j}` && (
                                              <div className="style-match-tooltip" onClick={e => e.stopPropagation()}>
                                                <span>Scan more outfits to unlock match scores</span>
                                                <div onClick={e => { e.stopPropagation(); setTab("profile"); setStyleMatchTooltip(null); }} style={{ marginTop: 4, fontSize: 9, fontWeight: 700, color: "var(--accent)", cursor: "pointer", letterSpacing: 0.3 }}>
                                                  Build your Style DNA &rarr;
                                                </div>
                                              </div>
                                            )}
                                          </div>
                                        )}
                                        {/* Dupe Alert pill — reserved for affiliate items only (TODO: re-enable for affiliates) */}
                                        <a href={href} target="_blank" rel="noopener noreferrer"
                                          onClick={() => track("product_clicked", { tier: tierKey, brand: p.brand, price: p.price, is_fallback: isFallback, is_dupe: !!dupeInfo }, scanId, "scan")}
                                          style={{ display: "flex", flexDirection: "column", textDecoration: "none", color: "inherit", background: "var(--bg-card)", border: `1px solid ${dupeInfo ? "rgba(201,169,110,.4)" : p.is_identified_brand ? "rgba(201,169,110,.25)" : "var(--border)"}`, borderRadius: 12, overflow: "hidden", transition: "all .2s" }}>
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
                                        {/* Find Similar Look button — only on products $150+ */}
                                        {(() => { const pNum = parseFloat((p.price || "").replace(/[^0-9.]/g, "")); return pNum >= 150 && !isFallback; })() && (
                                          <button
                                            onClick={e => { e.preventDefault(); e.stopPropagation(); openDupeModal(p, item, tierKey); }}
                                            className="dupe-finder-btn"
                                            style={{ position: "absolute", bottom: 54, left: 4, right: 4, zIndex: 2, padding: "5px 8px", background: "rgba(76,175,80,.9)", backdropFilter: "blur(8px)", border: "none", borderRadius: 8, color: "#fff", fontSize: 9, fontWeight: 700, fontFamily: "var(--font-sans)", cursor: "pointer", letterSpacing: 0.3, display: "flex", alignItems: "center", justifyContent: "center", gap: 4, transition: "all .2s" }}
                                          >
                                            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
                                            Similar Look
                                          </button>
                                        )}
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

              <div className="aff-note" style={{ padding: "8px 20px calc(80px + env(safe-area-inset-bottom, 0px))" }}>Links may include affiliate partnerships</div>
            </div>
          )}

          {/* History tab removed — scan history is integrated in Profile grid.
             Dead code (~430 lines) was removed in the Run 6 quality sweep. */}

          {/* ─── Wardrobe tab (Saved Items) ─────────── */}
          {tab === "likes" && (() => {

            return (
              <div className="likes-v2 animate-fade-in">
                {/* Header */}
                <div style={{ padding: "16px 16px 4px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                  <h2 style={{ fontSize: 22, fontWeight: 700, color: "var(--text-primary)", margin: 0 }}>{t("wardrobe")}</h2>
                  <span style={{ fontSize: 13, color: "var(--text-tertiary)", fontWeight: 500 }}>{saved.length} items</span>
                </div>

                {/* Filter row: wishlist chips */}
                <div className="scroll-x" style={{ display: "flex", gap: 8, overflowX: "auto", padding: "8px 16px 0", scrollbarWidth: "none" }}>
                  {wishlists.map(wl => (
                    <button
                      key={wl.id}
                      className={`scan-vis-chip${activeWishlist?.id === wl.id ? " active" : ""}`}
                      onClick={() => { setActiveWishlist(activeWishlist?.id === wl.id ? null : wl); if (activeWishlist?.id !== wl.id) setHistoryFilter("all"); }}
                      onTouchStart={() => { wishlistLongPressRef.current = setTimeout(() => { setWishlistEditId(wl.id); setWishlistEditName(wl.name); setWishlistEditOpen(true); }, 500); }}
                      onTouchEnd={() => { clearTimeout(wishlistLongPressRef.current); }}
                      onTouchMove={() => { clearTimeout(wishlistLongPressRef.current); }}
                      onMouseDown={() => { wishlistLongPressRef.current = setTimeout(() => { setWishlistEditId(wl.id); setWishlistEditName(wl.name); setWishlistEditOpen(true); }, 500); }}
                      onMouseUp={() => { clearTimeout(wishlistLongPressRef.current); }}
                      onMouseLeave={() => { clearTimeout(wishlistLongPressRef.current); }}
                      onContextMenu={e => { e.preventDefault(); setWishlistEditId(wl.id); setWishlistEditName(wl.name); setWishlistEditOpen(true); }}
                      style={{ flexShrink: 0 }}
                    >
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg>
                      {wl.name}
                    </button>
                  ))}
                </div>

                {/* Price drops banner */}
                {priceAlertCount > 0 && (
                  <div style={{ padding: "8px 16px 0" }}>
                    <button onClick={() => setShowPriceAlerts(true)} style={{
                      width: "100%", padding: "10px 16px", marginBottom: 12, borderRadius: "var(--radius-sm)",
                      background: "linear-gradient(135deg, rgba(76,175,80,.08), rgba(76,175,80,.02))",
                      border: "1px solid rgba(76,175,80,.2)", color: "#4CAF50",
                      fontSize: 13, fontWeight: 600, cursor: "pointer", display: "flex", alignItems: "center", gap: 8,
                      fontFamily: "var(--font-sans)"
                    }}>
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/></svg>
                      {priceAlertCount} price drop{priceAlertCount !== 1 ? "s" : ""} on saved items
                    </button>
                  </div>
                )}

                {/* Saved items grid (no Complete the Look here — moved to results page) */}

                {/* Complete the Look removed — lives on results page now */}
                {false && (() => {
                  // Use backend looks data, fallback to client-side grouping
                  const looksData = looks.length > 0 ? looks : (() => {
                    const outfitMap = new Map();
                    saved.forEach(s => {
                      if (!s.scan_id) return;
                      if (!outfitMap.has(s.scan_id)) outfitMap.set(s.scan_id, []);
                      outfitMap.get(s.scan_id).push(s);
                    });
                    const result = [];
                    outfitMap.forEach((items, scanId) => {
                      const scan = history.find(h => h.id === scanId);
                      const totalItems = scan?.items?.length || items.length;
                      result.push({
                        scan_id: scanId,
                        scan_name: scan?.scan_name || scan?.summary || "Outfit",
                        scan_thumbnail: scan?.image_url || scan?.image_thumbnail,
                        scan_image: scan?.image_url || scan?.image_thumbnail,
                        total_items: totalItems,
                        saved_count: items.length,
                        progress: Math.min(1, items.length / Math.max(1, totalItems)),
                        total_price_estimate: null,
                        saved_items: items.map(i => ({ id: i.id, item_data: i.item_data, tier_product: i.tier_product, created_at: i.created_at })),
                        scan_items: (scan?.items || []).map((si, idx) => ({ ...si, index: idx, is_saved: items.some(sv => (sv.item_data?.name || "").toLowerCase() === (si.name || "").toLowerCase()) })),
                      });
                    });
                    result.sort((a, b) => b.saved_count - a.saved_count);
                    return result;
                  })();

                  if (looksLoading) {
                    return (
                      <div style={{ padding: "40px 16px", display: "flex", flexDirection: "column", alignItems: "center", gap: 12 }}>
                        <div className="look-skeleton-card" />
                        <div className="look-skeleton-card" />
                      </div>
                    );
                  }

                  if (looksData.length === 0) {
                    return (
                      <div style={{ padding: "40px 32px", textAlign: "center", display: "flex", flexDirection: "column", alignItems: "center", gap: 8 }}>
                        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1" style={{ opacity: 0.12, marginBottom: 4 }}>
                          <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/>
                        </svg>
                        <div style={{ fontSize: 15, fontWeight: 600, color: "var(--text-primary)" }}>No outfits saved yet</div>
                        <div style={{ fontSize: 13, color: "var(--text-tertiary)", lineHeight: 1.5, maxWidth: 260 }}>
                          Save items from your scans to build complete outfits
                        </div>
                        <button className="btn-primary" style={{ marginTop: 8, padding: "10px 24px", fontSize: 13, borderRadius: 100 }} onClick={() => setTab("scan")}>
                          Scan an Outfit
                        </button>
                      </div>
                    );
                  }

                  return (
                    <div style={{ padding: "12px 0 0" }}>
                      <div style={{ padding: "0 16px 10px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                        <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: 1.5, color: "var(--text-tertiary)", textTransform: "uppercase" }}>Complete the Look</span>
                        <span style={{ fontSize: 11, color: "var(--text-tertiary)" }}>{looksData.length} outfit{looksData.length !== 1 ? "s" : ""}</span>
                      </div>

                      {looksData.map(look => {
                        const pct = Math.round(look.progress * 100);
                        const isComplete = pct === 100;
                        const isExpanded = expandedLook === look.scan_id;
                        const unsavedItems = (look.scan_items || []).filter(si => !si.is_saved);
                        const savedItemsList = look.saved_items || [];
                        const allUrls = savedItemsList.map(s => (s.item_data || s)?.url || (s.tier_product || {})?.url).filter(Boolean);

                        const handleExpand = async () => {
                          if (isExpanded) {
                            setExpandedLook(null);
                            setLookDetail(null);
                            return;
                          }
                          setExpandedLook(look.scan_id);
                          if (!look.scan_items || look.scan_items.length === 0) {
                            setLookDetailLoading(true);
                            try {
                              const detail = await API.getLookDetail(look.scan_id);
                              setLookDetail(detail);
                            } catch {}
                            setLookDetailLoading(false);
                          }
                        };

                        const handleBuyAll = async (e) => {
                          e.stopPropagation();
                          setBuyAllLoading(look.scan_id);
                          try {
                            const data = await API.getBuyAllLinks(look.scan_id);
                            if (data.links && data.links.length > 0) {
                              data.links.forEach((link, i) => {
                                setTimeout(() => {
                                  const affiliateUrl = API.affiliateUrl(crypto.randomUUID(), link.url, look.scan_id, 0, "saved", link.retailer || "");
                                  window.open(affiliateUrl, "_blank");
                                }, i * 300);
                              });
                              track("buy_all_clicked", { scan_id: look.scan_id, count: data.links.length, total_price: data.total_price });
                            }
                          } catch {}
                          setBuyAllLoading(null);
                        };

                        const formatPrice = (p) => {
                          if (!p) return null;
                          const n = typeof p === "string" ? parseFloat(p.replace(/[^0-9.]/g, "")) : p;
                          return n && isFinite(n) ? `$${n.toFixed(2)}` : null;
                        };

                        // Use detail data if available for expanded view
                        const detailItems = isExpanded && lookDetail?.scan_id === look.scan_id ? lookDetail.items : look.scan_items;
                        const detailUnsaved = (detailItems || []).filter(si => !si.is_saved);

                        return (
                          <div key={look.scan_id} className={`look-card${isExpanded ? " look-card-expanded" : ""}`} style={{ margin: "0 16px 12px", background: "var(--bg-card)", border: "1px solid var(--border)", borderRadius: 16, overflow: "hidden", transition: "all .3s ease" }}>
                            {/* Header with scan thumbnail */}
                            <div style={{ display: "flex", gap: 12, padding: 12, cursor: "pointer" }} onClick={handleExpand}>
                              <div style={{ width: 64, height: 64, borderRadius: 12, overflow: "hidden", flexShrink: 0, background: "var(--bg-input)" }}>
                                {look.scan_thumbnail ? (
                                  <img src={look.scan_thumbnail} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} loading="lazy" />
                                ) : (
                                  <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center" }}>
                                    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" style={{ opacity: 0.2 }}><rect x="2" y="6" width="20" height="14" rx="3"/><circle cx="12" cy="13" r="4"/><path d="M8 6l1.5-3h5L16 6"/></svg>
                                  </div>
                                )}
                              </div>
                              <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", justifyContent: "center" }}>
                                <div style={{ fontSize: 14, fontWeight: 600, color: "var(--text-primary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{look.scan_name}</div>
                                <div style={{ fontSize: 12, color: "var(--text-tertiary)", marginTop: 2 }}>
                                  {look.saved_count} of {look.total_items} items saved
                                </div>
                                {/* Progress bar */}
                                <div style={{ marginTop: 6, height: 4, borderRadius: 2, background: "var(--border)", overflow: "hidden" }}>
                                  <div style={{ height: "100%", borderRadius: 2, background: isComplete ? "#5AC8A0" : "var(--accent)", width: `${pct}%`, transition: "width .4s ease" }} />
                                </div>
                              </div>
                              {/* Progress percentage */}
                              <div style={{ display: "flex", alignItems: "center", flexShrink: 0 }}>
                                <span style={{ fontSize: 13, fontWeight: 700, color: isComplete ? "#5AC8A0" : "var(--accent)" }}>{pct}%</span>
                                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--text-tertiary)" strokeWidth="2" strokeLinecap="round" style={{ marginLeft: 4, transform: isExpanded ? "rotate(180deg)" : "rotate(0)", transition: "transform .3s ease" }}>
                                  <polyline points="6 9 12 15 18 9"/>
                                </svg>
                              </div>
                            </div>

                            {/* Saved items horizontal scroll */}
                            {savedItemsList.length > 0 && (
                              <div className="scroll-x" style={{ display: "flex", gap: 8, overflowX: "auto", padding: "0 12px 12px", scrollSnapType: "x mandatory", scrollbarWidth: "none" }}>
                                {savedItemsList.map(si => {
                                  const item = si.item_data || si;
                                  const product = si.tier_product || {};
                                  const img = product.image_url || item.image_url || item.thumbnail;
                                  const name = item.name || product.name || "Item";
                                  const price = formatPrice(product.price || item.price || item.estimated_price);
                                  const url = product.url || item.url;
                                  return (
                                    <div key={si.id} className="look-item-card" style={{ flexShrink: 0, width: 100, scrollSnapAlign: "start" }}>
                                      <div style={{ width: 100, height: 100, borderRadius: 10, overflow: "hidden", background: "var(--bg-input)", position: "relative" }}>
                                        {img ? (
                                          <img src={img} alt={name} style={{ width: "100%", height: "100%", objectFit: "cover" }} loading="lazy" onError={e => { e.target.style.display = "none"; }} />
                                        ) : (
                                          <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 10, color: "var(--text-tertiary)" }}>
                                            {item.category || "Item"}
                                          </div>
                                        )}
                                        {/* Saved badge */}
                                        <div style={{ position: "absolute", top: 4, right: 4, width: 18, height: 18, borderRadius: "50%", background: "rgba(201,169,110,.9)", display: "flex", alignItems: "center", justifyContent: "center" }}>
                                          <svg width="10" height="10" viewBox="0 0 24 24" fill="#fff" stroke="none"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>
                                        </div>
                                        {url && (
                                          <a href={API.affiliateUrl(crypto.randomUUID(), url, look.scan_id, 0, "saved", "")} target="_blank" rel="noopener noreferrer" onClick={e => e.stopPropagation()} style={{ position: "absolute", inset: 0 }} aria-label={`Shop ${name}`} />
                                        )}
                                      </div>
                                      <div style={{ padding: "4px 2px 0", overflow: "hidden" }}>
                                        <div style={{ fontSize: 10, fontWeight: 600, color: "var(--text-primary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{name}</div>
                                        {price && <div style={{ fontSize: 10, color: "var(--accent)", fontWeight: 600, marginTop: 1 }}>{price}</div>}
                                      </div>
                                    </div>
                                  );
                                })}
                              </div>
                            )}

                            {/* Expanded: unsaved items (Complete the Look CTA) */}
                            {isExpanded && (
                              <div className="look-expand-section" style={{ borderTop: "1px solid var(--border)", padding: 12, animation: "lookExpandIn .3s ease" }}>
                                {lookDetailLoading ? (
                                  <div style={{ display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
                                    <div className="look-spinner" />
                                  </div>
                                ) : detailUnsaved.length > 0 ? (
                                  <>
                                    <div style={{ fontSize: 11, fontWeight: 700, color: "var(--text-tertiary)", textTransform: "uppercase", letterSpacing: 1, marginBottom: 8 }}>
                                      Complete your look ({detailUnsaved.length} remaining)
                                    </div>
                                    <div className="scroll-x" style={{ display: "flex", gap: 8, overflowX: "auto", scrollbarWidth: "none", paddingBottom: 4 }}>
                                      {detailUnsaved.map((ui, idx) => {
                                        const name = ui.name || ui.category || "Item";
                                        const img = ui.image_url || ui.thumbnail;
                                        const price = formatPrice(ui.estimated_price || ui.price);
                                        return (
                                          <div key={idx} style={{ flexShrink: 0, width: 90, opacity: 0.7 }}>
                                            <div style={{ width: 90, height: 90, borderRadius: 10, overflow: "hidden", background: "var(--bg-input)", border: "1px dashed var(--border)", display: "flex", alignItems: "center", justifyContent: "center", position: "relative" }}>
                                              {img ? (
                                                <img src={img} alt={name} style={{ width: "100%", height: "100%", objectFit: "cover", opacity: 0.6 }} loading="lazy" />
                                              ) : (
                                                <div style={{ fontSize: 9, color: "var(--text-tertiary)", textAlign: "center", padding: 4 }}>{name}</div>
                                              )}
                                              {/* Plus icon */}
                                              <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center" }}>
                                                <div style={{ width: 24, height: 24, borderRadius: "50%", background: "rgba(201,169,110,.85)", display: "flex", alignItems: "center", justifyContent: "center" }}>
                                                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="3" strokeLinecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
                                                </div>
                                              </div>
                                            </div>
                                            <div style={{ padding: "3px 2px 0", overflow: "hidden" }}>
                                              <div style={{ fontSize: 9, fontWeight: 600, color: "var(--text-secondary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{name}</div>
                                              {price && <div style={{ fontSize: 9, color: "var(--text-tertiary)", marginTop: 1 }}>{price}</div>}
                                            </div>
                                          </div>
                                        );
                                      })}
                                    </div>
                                    <button
                                      className="btn-primary"
                                      style={{ width: "100%", marginTop: 10, padding: "10px 0", fontSize: 13, fontWeight: 600, borderRadius: 10 }}
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        // Navigate to scan results to save remaining items
                                        const scan = history.find(h => h.id === look.scan_id);
                                        if (scan) {
                                          const hsItems = scan.items || [];
                                          setResults({ gender: scan.detected_gender || "male", summary: scan.summary || "", items: hsItems.map(it => ({ ...it, status: scan.tiers ? "verified" : "identified", tiers: null })) });
                                          if (scan.tiers && Array.isArray(scan.tiers)) {
                                            setResults(prev => prev ? { ...prev, items: prev.items.map((item, idx) => { const sr = scan.tiers.find(t2 => t2.item_index === idx); return sr?.tiers ? { ...item, status: "verified", tiers: sr.tiers } : item; }) } : prev);
                                          }
                                          setImg(scan.image_url || scan.image_thumbnail || null);
                                          setScanId(scan.id); setSelIdx(0); setPickedItems(new Set((scan.tiers || []).map(t2 => t2.item_index))); setPhase("done"); setTab("scan");
                                        }
                                        track("complete_look_clicked", { scan_id: look.scan_id, remaining: detailUnsaved.length });
                                      }}
                                    >
                                      Complete the Look
                                    </button>
                                  </>
                                ) : (
                                  <div style={{ textAlign: "center", padding: "8px 0", fontSize: 13, color: "#5AC8A0", fontWeight: 600 }}>
                                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#5AC8A0" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ verticalAlign: -3, marginRight: 6 }}><polyline points="20 6 9 17 4 12"/></svg>
                                    Look complete!
                                  </div>
                                )}
                              </div>
                            )}

                            {/* Buy All + Price footer */}
                            {allUrls.length > 0 && (
                              <div style={{ padding: "0 12px 12px", display: "flex", alignItems: "center", gap: 8 }}>
                                <button
                                  className="look-buy-all-btn"
                                  onClick={handleBuyAll}
                                  disabled={buyAllLoading === look.scan_id}
                                  style={{ flex: 1, padding: "10px 0", background: "var(--accent)", border: "none", borderRadius: 10, fontSize: 13, fontWeight: 700, color: "var(--text-inverse)", cursor: "pointer", fontFamily: "var(--font-sans)", display: "flex", alignItems: "center", justifyContent: "center", gap: 6, opacity: buyAllLoading === look.scan_id ? 0.6 : 1, transition: "opacity .2s" }}
                                >
                                  {buyAllLoading === look.scan_id ? (
                                    <div className="look-spinner-sm" />
                                  ) : (
                                    <>
                                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="9" cy="21" r="1"/><circle cx="20" cy="21" r="1"/><path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6"/></svg>
                                      Buy All ({allUrls.length})
                                    </>
                                  )}
                                </button>
                                {look.total_price_estimate && (
                                  <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text-secondary)", flexShrink: 0 }}>
                                    ~${look.total_price_estimate.toFixed(2)}
                                  </div>
                                )}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  );
                })()}

                {/* ── Saved items grid ── */}
                {saved.length > 0 && (() => {
                  const displayedItems = activeWishlist ? saved.filter(si => si.wishlist_id === activeWishlist.id) : saved;
                  if (displayedItems.length === 0 && activeWishlist) return (
                    <div style={{ padding: "40px 32px", textAlign: "center", display: "flex", flexDirection: "column", alignItems: "center", gap: 8 }}>
                      <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1" style={{ opacity: 0.12, marginBottom: 4 }}><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg>
                      <div style={{ fontSize: 14, fontWeight: 600, color: "var(--text-primary)" }}>No items in this list</div>
                      <div style={{ fontSize: 12, color: "var(--text-tertiary)" }}>Add items from your scans</div>
                    </div>
                  );
                  return (
                  <div style={{ padding: "12px 16px 0" }}>
                    {activeWishlist && <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
                      <span style={{ fontSize: 12, fontWeight: 600, color: "var(--text-secondary)" }}>{activeWishlist.name} · {displayedItems.length} item{displayedItems.length !== 1 ? "s" : ""}</span>
                    </div>}
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(100px, 1fr))", gap: 10 }}>
                      {displayedItems.map(si => {
                        const item = si.item_data || si;
                        const product = si.tier_product || {};
                        const img = product.image_url || item.image_url || item.thumbnail;
                        const name = item.name || product.name || "Item";
                        const price = (() => { const p = product.price || item.price || item.estimated_price; if (!p) return null; const n = typeof p === "string" ? parseFloat(p.replace(/[^0-9.]/g, "")) : p; return n && isFinite(n) ? `$${n.toFixed(2)}` : null; })();
                        const url = product.url || item.url;
                        return (
                          <div key={si.id} className="look-item-card" style={{ position: "relative" }}>
                            <div style={{ width: "100%", aspectRatio: "1", borderRadius: 10, overflow: "hidden", background: "var(--bg-input)", position: "relative" }}>
                              {img ? (
                                <img src={img} alt={name} style={{ width: "100%", height: "100%", objectFit: "cover" }} loading="lazy" onError={e => { e.target.style.display = "none"; }} />
                              ) : (
                                <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 10, color: "var(--text-tertiary)" }}>
                                  {item.category || "Item"}
                                </div>
                              )}
                              {url && (
                                <a href={API.affiliateUrl(crypto.randomUUID(), url, si.scan_id || "", 0, "saved", "")} target="_blank" rel="noopener noreferrer" onClick={e => e.stopPropagation()} style={{ position: "absolute", inset: 0 }} aria-label={`Shop ${name}`} />
                              )}
                              {/* Delete button */}
                              <button onClick={async (e) => { e.preventDefault(); e.stopPropagation(); await API.deleteSaved(si.id).catch(() => {}); setSaved(s => s.filter(i => i.id !== si.id)); refreshStatus(); }} style={{ position: "absolute", top: 4, right: 4, width: 22, height: 22, borderRadius: "50%", background: "rgba(0,0,0,.6)", border: "none", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", padding: 0 }} aria-label="Remove saved item">
                                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="3" strokeLinecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                              </button>
                              {/* Remove from list button (only when viewing a wishlist) */}
                              {activeWishlist && (
                                <button onClick={async (e) => {
                                  e.preventDefault(); e.stopPropagation();
                                  await API.removeFromWishlist(activeWishlist.id, si.id).catch(() => {});
                                  setSaved(s => s.map(i => i.id === si.id ? { ...i, wishlist_id: null } : i));
                                }} style={{ position: "absolute", top: 4, left: 4, width: 22, height: 22, borderRadius: "50%", background: "rgba(0,0,0,.6)", border: "none", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", padding: 0 }} aria-label="Remove from list">
                                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="3" strokeLinecap="round"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg>
                                </button>
                              )}
                            </div>
                            <div style={{ padding: "4px 2px 0", overflow: "hidden" }}>
                              <div style={{ fontSize: 10, fontWeight: 600, color: "var(--text-primary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{name}</div>
                              {price && <div style={{ fontSize: 10, color: "var(--accent)", fontWeight: 600, marginTop: 1 }}>{price}</div>}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                  );
                })()}

                {saved.length === 0 && (
                  <div style={{ padding: "40px 32px", textAlign: "center", display: "flex", flexDirection: "column", alignItems: "center", gap: 8 }}>
                    <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1" style={{ opacity: 0.12, marginBottom: 4 }}>
                      <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/>
                    </svg>
                    <div style={{ fontSize: 15, fontWeight: 600, color: "var(--text-primary)" }}>{t("no_saved")}</div>
                    <div style={{ fontSize: 13, color: "var(--text-tertiary)", lineHeight: 1.5, maxWidth: 260 }}>
                      Heart items from your scans to save them here
                    </div>
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
                <button className="profile-v2-gear" aria-label="Open settings" onClick={() => { setSettingsSheetY(0); setProfileSettingsOpen(true); }}>
                  <svg viewBox="0 0 24 24" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
                </button>
              </div>

              {/* Profile info row: avatar left, stats right (Instagram layout) */}
              <div className="profile-v2-row">
                <div className="profile-v2-avatar" aria-label="Profile avatar" onClick={() => avatarInputRef.current?.click()} style={{ cursor: "pointer", position: "relative" }}>
                  {authAvatarUrl ? (
                    <img src={authAvatarUrl} alt="Profile" style={{ width: "100%", height: "100%", objectFit: "cover", borderRadius: "50%" }} onError={() => setAuthAvatarUrl(null)} />
                  ) : (
                    (authName || authEmail || "U")[0].toUpperCase()
                  )}
                  <div className="profile-avatar-camera">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>
                  </div>
                  <input
                    ref={avatarInputRef}
                    type="file"
                    accept="image/*"
                    style={{ display: "none" }}
                    onChange={async (e) => {
                      const file = e.target.files?.[0];
                      if (!file) return;
                      if (file.size > 5 * 1024 * 1024) { alert("Image too large. Max 5MB."); return; }
                      const reader = new FileReader();
                      reader.onload = async () => {
                        try {
                          const { avatar_url } = await API.uploadAvatar(reader.result);
                          setAuthAvatarUrl(avatar_url);
                        } catch (err) {
                          console.error("Avatar upload failed:", err);
                          alert("Failed to upload avatar. Please try again.");
                        }
                      };
                      reader.readAsDataURL(file);
                      e.target.value = "";
                    }}
                  />
                </div>
                <div className="profile-v2-stats" role="list" aria-label="Profile statistics">
                  <div className="profile-v2-stat" role="listitem">
                    <div className="profile-stat-val">{profileScansCount}</div>
                    <div className="profile-stat-lbl">{t("scans_stat")}</div>
                  </div>
                  <div className="profile-v2-stat" role="listitem" style={{ cursor: "pointer" }} onClick={async () => {
                    if (!authUserId) return;
                    setFollowListOpen("followers");
                    setFollowListLoading(true);
                    try {
                      const data = await API.getFollowers(authUserId);
                      setFollowListData(data.followers || data || []);
                    } catch { setFollowListData([]); }
                    setFollowListLoading(false);
                  }}>
                    <div className="profile-stat-val">{profileStats?.followers_count ?? 0}</div>
                    <div className="profile-stat-lbl">{t("followers")}</div>
                  </div>
                  <div className="profile-v2-stat" role="listitem" style={{ cursor: "pointer" }} onClick={async () => {
                    if (!authUserId) return;
                    setFollowListOpen("following");
                    setFollowListLoading(true);
                    try {
                      const data = await API.getFollowing(authUserId);
                      setFollowListData(data.following || data || []);
                    } catch { setFollowListData([]); }
                    setFollowListLoading(false);
                  }}>
                    <div className="profile-stat-val">{profileStats?.following_count ?? 0}</div>
                    <div className="profile-stat-lbl">{t("following")}</div>
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
                    <textarea className="profile-bio-area" rows={3} maxLength={200} autoFocus value={profileBio} onChange={e => setProfileBio(e.target.value.slice(0, 200))} placeholder={t("tell_style")} aria-label="Edit your bio" />
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 4 }}>
                      <span style={{ fontSize: 10, color: "var(--text-tertiary)" }}>{profileBio.length}/200</span>
                      <div style={{ display: "flex", gap: 6 }}>
                        <button className="btn-ghost" style={{ padding: "6px 14px", fontSize: 12 }} onClick={() => setProfileBioEditing(false)}>{t("cancel")}</button>
                        <button className="btn-primary" style={{ padding: "6px 14px", fontSize: 12 }} onClick={async () => { setProfileBioSaving(true); try { await API.updateProfile({ bio: profileBio }); } catch {} setProfileBioSaving(false); setProfileBioEditing(false); }}>{profileBioSaving ? t("saving") : t("save_bio")}</button>
                      </div>
                    </div>
                  </div>
                ) : (
                  <div style={{ fontSize: 14, color: "var(--text-secondary)", marginTop: 4, lineHeight: 1.4, display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>
                    {profileBio || <span style={{ fontStyle: "italic", color: "var(--text-tertiary)" }}>No bio yet</span>}
                  </div>
                )}
                {/* Edit Profile button */}
                <button className="btn-secondary" style={{ width: "100%", marginTop: 12, padding: "8px 0", fontSize: 14, fontWeight: 600, borderRadius: "var(--radius-sm)" }} onClick={() => setProfileBioEditing(true)}>{t("edit_profile")}</button>

                {/* Style DNA button */}
                {styleDna?.ready && isPro ? (
                  <button onClick={() => { setStyleDnaSlide(0); setShowStyleDna(true); }} aria-label="View your Style DNA report" style={{
                    width: "100%", marginTop: 8, padding: "12px 0", fontSize: 14, fontWeight: 600,
                    borderRadius: "var(--radius-sm)", background: "linear-gradient(135deg, rgba(201,169,110,.12), rgba(201,169,110,.04))",
                    border: "1px solid rgba(201,169,110,.25)", color: "var(--accent)",
                    cursor: "pointer", fontFamily: "var(--font-sans)", letterSpacing: 0.3,
                    display: "flex", alignItems: "center", justifyContent: "center", gap: 8
                  }}>
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 2L15.09 8.26L22 9.27L17 14.14L18.18 21.02L12 17.77L5.82 21.02L7 14.14L2 9.27L8.91 8.26L12 2Z"/></svg>
                    Your Style DNA: {styleDna.archetype}
                  </button>
                ) : !isPro ? (
                  <button onClick={() => trans(() => setScreen("paywall"))} aria-label="Upgrade to unlock Style DNA" style={{
                    width: "100%", marginTop: 8, padding: "12px 0", fontSize: 14, fontWeight: 600,
                    borderRadius: "var(--radius-sm)", background: "linear-gradient(135deg, rgba(201,169,110,.06), rgba(201,169,110,.02))",
                    border: "1px solid rgba(201,169,110,.18)", color: "var(--text-secondary)",
                    cursor: "pointer", fontFamily: "var(--font-sans)", letterSpacing: 0.3,
                    display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
                    position: "relative"
                  }}>
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2L15.09 8.26L22 9.27L17 14.14L18.18 21.02L12 17.77L5.82 21.02L7 14.14L2 9.27L8.91 8.26L12 2Z"/></svg>
                    Your Style DNA
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ marginLeft: 2 }}><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
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

                {/* Hanger Test streak + entry point */}
                <button onClick={async () => {
                  setHangerFullscreen(true);
                  if (hangerOutfits.length === 0) {
                    setHangerLoading(true);
                    try {
                      const d = await API.hangerTestToday();
                      setHangerOutfits(d.outfits || []);
                      setHangerVotes(d.user_votes || {});
                      setHangerStatsMap(d.stats || {});
                      setHangerCadence(d.cadence || null);
                      if (d.streak) setHangerStreak(d.streak);
                      if (d.taste_profile) setHangerTasteProfile(d.taste_profile);
                      const firstUnvoted = (d.outfits || []).findIndex(o => !d.user_votes?.[o.id]);
                      setHangerCurrentIndex(firstUnvoted >= 0 ? firstUnvoted : (d.outfits?.length || 0));
                    } catch {}
                    setHangerLoading(false);
                  }
                }} style={{
                  width: "100%", marginTop: 8, padding: "12px 16px", fontSize: 14, fontWeight: 600,
                  borderRadius: "var(--radius-sm)", background: "linear-gradient(135deg, rgba(255,183,77,.08), rgba(201,169,110,.04))",
                  border: "1px solid rgba(255,183,77,.2)", color: "#FFB74D",
                  cursor: "pointer", fontFamily: "var(--font-sans)", letterSpacing: 0.3,
                  display: "flex", alignItems: "center", justifyContent: "center", gap: 8
                }}>
                  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M12 2C12 2 8 6 8 10C8 14 12 16 12 16C12 16 16 14 16 10C16 6 12 2 12 2Z"/><path d="M8 16L4 20M16 16L20 20"/></svg>
                  Hanger Test {hangerStreak?.current_streak > 0 ? `\u00B7 ${hangerStreak.current_streak} day streak \uD83D\uDD25` : "\u00B7 Daily Outfit Verdict"}
                </button>
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
                          {hx.visibility === "private" && (
                            <div className="profile-grid-private-badge">
                              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                                <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/>
                                <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/>
                                <line x1="1" y1="1" x2="23" y2="23"/>
                              </svg>
                            </div>
                          )}
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
                      </div>
                      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 0", borderBottom: "1px solid var(--border)" }}
                        onClick={(e) => { e.stopPropagation(); toggleVisibility(e, hs); }}
                        role="switch" aria-checked={hs.visibility === "public"}
                      >
                        <span style={{ fontSize: 14, fontWeight: 600, color: "var(--text-secondary)" }}>
                          {hs.visibility === "public" ? "Public" : "Private"}
                        </span>
                        <div style={{ width: 44, height: 26, borderRadius: 13, background: hs.visibility === "public" ? "var(--accent)" : "var(--border)", position: "relative", transition: "background 0.2s", cursor: "pointer" }}>
                          <div style={{ width: 20, height: 20, borderRadius: "50%", background: "#fff", position: "absolute", top: 3, left: hs.visibility === "public" ? 21 : 3, transition: "left 0.2s", boxShadow: "0 1px 3px rgba(0,0,0,.2)" }} />
                        </div>
                      </div>
                      {hs.summary && <div className="scan-overlay-summary">{hs.summary}</div>}
                      {hsItems.length > 0 && <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                        <div className="sec-t">Identified Items</div>
                        {hsItems.map((it, idx) => {
                          const tierData = (hs.tiers || []).find(t2 => t2.item_index === idx);
                          const tierObj = tierData?.tiers || {};
                          const allTierProducts = [...(tierObj.mid || []), ...(tierObj.budget || []), ...(tierObj.premium || [])];
                          const bestProduct = allTierProducts.find(p => p.url && p.is_product_page !== false);
                          const cleanName = (it.name || "").replace(/[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}\u{FE00}-\u{FEFF}\u{1F900}-\u{1F9FF}]/gu, "").trim();
                          return (
                          <div key={idx} style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 12px", background: "var(--bg-card)", border: "1px solid var(--border)", borderRadius: "var(--radius-sm)" }}>
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <div style={{ fontSize: "var(--text-sm)", fontWeight: 600, color: "var(--text-primary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{cleanName || it.name}</div>
                              <div style={{ fontSize: "var(--text-xs)", color: "var(--text-tertiary)" }}>{it.brand || it.category}</div>
                            </div>
                            {bestProduct ? (
                              <a href={bestProduct.url} target="_blank" rel="noopener noreferrer" onClick={e => e.stopPropagation()} style={{ fontSize: "var(--text-xs)", fontWeight: 600, color: "var(--accent)", textDecoration: "none", whiteSpace: "nowrap", padding: "4px 10px", border: "1px solid var(--accent)", borderRadius: "var(--radius-sm)", flexShrink: 0 }}>Shop this</a>
                            ) : (
                              <button onClick={(e) => { e.stopPropagation(); setResults({ gender: hs.detected_gender || "male", summary: hs.summary || "", items: hsItems.map(i => ({ ...i, status: hs.tiers ? "verified" : "identified", tiers: null })) }); if (hs.tiers && Array.isArray(hs.tiers)) setResults(prev => prev ? { ...prev, items: prev.items.map((item, i2) => { const sr = hs.tiers.find(t2 => t2.item_index === i2); return sr?.tiers ? { ...item, status: "verified", tiers: sr.tiers } : item; }) } : prev); setImg(hs.image_url || hs.image_thumbnail || null); setScanId(hs.id); setSelIdx(idx); setPickedItems(new Set((hs.tiers || []).map(t2 => t2.item_index))); setPhase("done"); setTab("scan"); setProfileScanOverlay(null); }} style={{ fontSize: "var(--text-xs)", fontWeight: 600, color: "var(--accent)", background: "none", border: "1px solid var(--accent)", borderRadius: "var(--radius-sm)", padding: "4px 10px", cursor: "pointer", whiteSpace: "nowrap", flexShrink: 0 }}>Find it</button>
                            )}
                          </div>
                          );
                        })}
                      </div>}
                      <button className="btn-primary" style={{ width: "100%", marginTop: 16 }} onClick={() => {
                        setResults({ gender: hs.detected_gender || "male", summary: hs.summary || "", items: hsItems.map(it => ({ ...it, status: hs.tiers ? "verified" : "identified", tiers: null })) });
                        if (hs.tiers && Array.isArray(hs.tiers)) setResults(prev => prev ? { ...prev, items: prev.items.map((item, idx) => { const sr = hs.tiers.find(t2 => t2.item_index === idx); return sr?.tiers ? { ...item, status: "verified", tiers: sr.tiers } : item; }) } : prev);
                        setImg(hs.image_url || hs.image_thumbnail || null);
                        setScanId(hs.id); setSelIdx(0); setPickedItems(new Set((hs.tiers || []).map(t2 => t2.item_index))); setPhase("done"); setTab("scan"); setProfileScanOverlay(null);
                      }}>{t("view_results")}</button>
                    </div>
                  </div>
                );
              })()}

              {/* Settings bottom sheet */}
              {profileSettingsOpen && <>
                <div className="bottom-sheet-overlay" onClick={() => { setProfileSettingsOpen(false); }} />
                <div className="bottom-sheet" role="dialog" aria-label="Settings" aria-modal="true"
                  style={{ transform: settingsSheetY > 0 ? `translateY(${settingsSheetY}px)` : undefined, transition: settingsDragRef.current.dragging ? 'none' : 'transform 0.3s ease' }}
                  onTouchStart={e => { settingsDragRef.current = { startY: e.touches[0].clientY, currentY: e.touches[0].clientY, dragging: true }; }}
                  onTouchMove={e => { const dy = e.touches[0].clientY - settingsDragRef.current.startY; settingsDragRef.current.currentY = e.touches[0].clientY; if (dy > 0) { setSettingsSheetY(dy); } }}
                  onTouchEnd={() => { const dy = settingsDragRef.current.currentY - settingsDragRef.current.startY; settingsDragRef.current.dragging = false; if (dy > 120) { setSettingsSheetY(window.innerHeight); setTimeout(() => { setProfileSettingsOpen(false); setSettingsSheetY(0); }, 300); } else { setSettingsSheetY(0); } }}>
                  <div className="bottom-sheet-handle" />
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20 }}>
                    <div style={{ fontSize: 18, fontWeight: 700, color: "var(--text-primary)" }}>{t("settings")}</div>
                    <button onClick={() => setProfileSettingsOpen(false)} aria-label="Close settings" style={{ width: 32, height: 32, display: "flex", alignItems: "center", justifyContent: "center", background: "none", border: "none", cursor: "pointer", borderRadius: "50%", color: "var(--text-secondary)" }}>
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                    </button>
                  </div>

                  {/* Theme toggle */}
                  <div className="settings-sheet-item" onClick={toggleTheme} role="button" aria-label="Toggle theme">
                    <span className="settings-label">{t("appearance")}</span>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <span className="settings-value">{theme === "dark" ? t("dark") : t("light")}</span>
                      <div style={{ width: 44, height: 26, borderRadius: 13, background: theme === "dark" ? "var(--accent)" : "var(--border)", position: "relative", transition: "background 0.2s", cursor: "pointer", flexShrink: 0 }}>
                        <div style={{ width: 20, height: 20, borderRadius: "50%", background: "#fff", position: "absolute", top: 3, left: theme === "dark" ? 21 : 3, transition: "left 0.2s", boxShadow: "0 1px 3px rgba(0,0,0,.2)" }} />
                      </div>
                    </div>
                  </div>

                  {/* Language */}
                  <div className="settings-sheet-item" style={{ alignItems: "flex-start", flexDirection: "column", gap: 8, cursor: "default" }}>
                    <span className="settings-label">{t("language")}</span>
                    <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                      {[["en","EN"],["es","ES"],["fr","FR"],["de","DE"],["zh","\u4E2D"],["ja","\u65E5"],["ko","\uD55C"],["pt","PT"]].map(([l, label]) => (
                        <button key={l} className={`chip${lang === l ? " active" : ""}`} onClick={() => { if (l !== lang) setLangConfirmOpen(l); }} style={{ padding: "8px 14px", fontSize: 12, minHeight: 44 }}>{label}</button>
                      ))}
                    </div>
                  </div>

                  {/* Budget Range — tappable row toggles inline expansion */}
                  <div className="settings-budget-section">
                    <div className="settings-sheet-item" style={{ cursor: "pointer" }} onClick={() => {
                      if (!settingsBudgetExpanded) {
                        budgetModalOrigRef.current = { min: budgetMin, max: budgetMax };
                        setSettingsBudgetDirty(false);
                        setSettingsBudgetError(null);
                      } else if (settingsBudgetDirty) {
                        setBudgetMin(budgetModalOrigRef.current.min);
                        setBudgetMax(budgetModalOrigRef.current.max);
                      }
                      setSettingsBudgetExpanded(prev => !prev);
                    }} role="button" aria-label="Edit budget range">
                      <span className="settings-label">{t("budget_range")}</span>
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <span className="settings-value">${budgetMin} – {budgetMax >= 1000 ? "$1000+" : `$${budgetMax}`}</span>
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" style={{ color: "var(--text-tertiary)", flexShrink: 0, transition: "transform .2s", transform: settingsBudgetExpanded ? "rotate(90deg)" : "rotate(0)" }}><polyline points="9 18 15 12 9 6"/></svg>
                      </div>
                    </div>

                    {settingsBudgetExpanded && (
                      <div style={{ padding: "0 16px 16px", animation: "slideDown .2s ease" }}>
                        {/* Preset chips */}
                        <div style={{ display: "flex", gap: 6, marginBottom: 14 }}>
                          {[
                            { l: t("budget_tier_under50"), min: 0, max: 50 },
                            { l: t("budget_tier_mid"), min: 50, max: 150 },
                            { l: t("budget_tier_high"), min: 150, max: 500 },
                            { l: t("budget_tier_premium"), min: 500, max: 1000 },
                          ].map(preset => {
                            const isActive = budgetMin === preset.min && budgetMax === preset.max;
                            return (
                              <button key={preset.l}
                                onClick={() => { setBudgetMin(preset.min); setBudgetMax(preset.max); setSettingsBudgetDirty(true); setSettingsBudgetError(null); }}
                                style={{
                                  flex: 1, padding: "8px 4px", borderRadius: 20, fontSize: 10, fontWeight: 600, fontFamily: "var(--font-sans)", cursor: "pointer", transition: "all .2s", minHeight: 44,
                                  background: isActive ? "rgba(201,169,110,.12)" : "var(--bg-input)",
                                  border: `1px solid ${isActive ? "rgba(201,169,110,.4)" : "var(--border)"}`,
                                  color: isActive ? "var(--accent)" : "var(--text-tertiary)",
                                }}>
                                {preset.l}
                              </button>
                            );
                          })}
                        </div>

                        {/* Dual-thumb range slider */}
                        <div style={{ position: "relative", height: 32, marginBottom: 4 }}>
                          <div style={{ position: "absolute", top: 14, left: 0, right: 0, height: 4, background: "var(--bg-input)", borderRadius: 2 }} />
                          <div style={{ position: "absolute", top: 14, left: `${(budgetMin / 1000) * 100}%`, right: `${100 - (budgetMax / 1000) * 100}%`, height: 4, background: "var(--accent)", borderRadius: 2 }} />
                          <input type="range" min={0} max={1000} step={10} value={budgetMin}
                            onChange={e => { const v = parseInt(e.target.value); if (v < budgetMax) { setBudgetMin(v); setSettingsBudgetDirty(true); setSettingsBudgetError(null); } }}
                            aria-label="Minimum budget"
                            style={{ position: "absolute", top: 0, left: 0, width: "100%", height: 32, appearance: "none", WebkitAppearance: "none", background: "transparent", pointerEvents: "none", zIndex: 2 }}
                            className="budget-range-thumb"
                          />
                          <input type="range" min={0} max={1000} step={10} value={budgetMax}
                            onChange={e => { const v = parseInt(e.target.value); if (v > budgetMin) { setBudgetMax(v); setSettingsBudgetDirty(true); setSettingsBudgetError(null); } }}
                            aria-label="Maximum budget"
                            style={{ position: "absolute", top: 0, left: 0, width: "100%", height: 32, appearance: "none", WebkitAppearance: "none", background: "transparent", pointerEvents: "none", zIndex: 3 }}
                            className="budget-range-thumb"
                          />
                        </div>

                        {/* Scale labels */}
                        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: "var(--text-tertiary)", marginBottom: 14, padding: "0 2px" }}>
                          <span>$0</span><span>$250</span><span>$500</span><span>$750</span><span>$1000+</span>
                        </div>

                        {/* Min / Max number inputs */}
                        <div style={{ display: "flex", gap: 12, marginBottom: 14 }}>
                          <div style={{ flex: 1 }}>
                            <div style={{ fontSize: 9, color: "var(--text-tertiary)", marginBottom: 4, fontWeight: 600, letterSpacing: 0.5 }}>{t("budget_min_label")}</div>
                            <div className="budget-input-wrap">
                              <span>$</span>
                              <input type="number" value={budgetMin} min={0} max={budgetMax - 1}
                                onChange={e => { const v = Math.max(0, parseInt(e.target.value) || 0); if (v < budgetMax) { setBudgetMin(v); setSettingsBudgetDirty(true); setSettingsBudgetError(null); } }}
                              />
                            </div>
                          </div>
                          <span style={{ color: "var(--text-tertiary)", fontSize: 14, marginTop: 22, fontWeight: 600 }}>–</span>
                          <div style={{ flex: 1 }}>
                            <div style={{ fontSize: 9, color: "var(--text-tertiary)", marginBottom: 4, fontWeight: 600, letterSpacing: 0.5 }}>{t("budget_max_label")}</div>
                            <div className="budget-input-wrap">
                              <span>$</span>
                              <input type="number" value={budgetMax} min={budgetMin + 1}
                                onChange={e => { const v = Math.max(budgetMin + 1, parseInt(e.target.value) || 0); setBudgetMax(v); setSettingsBudgetDirty(true); setSettingsBudgetError(null); }}
                              />
                            </div>
                          </div>
                        </div>

                        {/* Error message */}
                        {settingsBudgetError && (
                          <div style={{ fontSize: 12, color: "var(--error)", marginBottom: 10, textAlign: "center", fontWeight: 500 }}>{settingsBudgetError}</div>
                        )}

                        {/* Save / Cancel buttons */}
                        <div style={{ display: "flex", gap: 8 }}>
                          <button
                            className="btn-ghost"
                            style={{ flex: 1, fontSize: 13 }}
                            onClick={() => {
                              setBudgetMin(budgetModalOrigRef.current.min);
                              setBudgetMax(budgetModalOrigRef.current.max);
                              setSettingsBudgetExpanded(false);
                              setSettingsBudgetDirty(false);
                              setSettingsBudgetError(null);
                            }}
                          >{t("cancel")}</button>
                          <button
                            className="btn-primary"
                            disabled={!settingsBudgetDirty || settingsBudgetSaving}
                            style={{ flex: 1, fontSize: 13, opacity: !settingsBudgetDirty ? 0.4 : 1 }}
                            onClick={async () => {
                              setSettingsBudgetSaving(true);
                              setSettingsBudgetError(null);
                              try {
                                await API.updateProfile({ budget_min: budgetMin, budget_max: budgetMax });
                                setSettingsBudgetDirty(false);
                                setSettingsBudgetExpanded(false);
                                budgetModalOrigRef.current = { min: budgetMin, max: budgetMax };
                              } catch (err) {
                                console.error("Budget save failed:", err);
                                setSettingsBudgetError(t("budget_save_error"));
                              }
                              setSettingsBudgetSaving(false);
                            }}
                          >{settingsBudgetSaving ? t("saving") : t("save_btn")}</button>
                        </div>
                      </div>
                    )}
                  </div>

                  {/* Size Preferences — tappable row opens popup */}
                  <div className="settings-sheet-item" style={{ cursor: "pointer" }} onClick={() => {
                    sizePrefsOrigRef.current = JSON.parse(JSON.stringify(sizePrefs));
                    setSizePrefsEdit({ tops: sizePrefs.sizes?.tops || "", bottoms_waist: sizePrefs.sizes?.bottoms_waist || "", bottoms_length: sizePrefs.sizes?.bottoms_length || "", shoes: sizePrefs.sizes?.shoes || "", dresses: sizePrefs.sizes?.dresses || "" });
                    setSizePrefsGender(sizePrefs.gender || "women");
                    setSizePrefsModalOpen(true);
                  }} role="button" aria-label="Edit size preferences">
                    <span className="settings-label">{t("size_preferences")}</span>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <span className="settings-value">{(() => {
                        const sizes = sizePrefs.sizes || {};
                        const set2 = Object.values(sizes).filter(Boolean);
                        return set2.length > 0 ? set2.slice(0, 3).join(", ") + (set2.length > 3 ? "..." : "") : t("not_set");
                      })()}</span>
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" style={{ color: "var(--text-tertiary)", flexShrink: 0 }}><polyline points="9 18 15 12 9 6"/></svg>
                    </div>
                  </div>

                  {/* Subscription */}
                  <div className="settings-sheet-item" style={{ cursor: "default" }}>
                    <span className="settings-label">{t("subscription")}</span>
                    <span className="settings-value" style={{ color: isPro ? "var(--accent)" : undefined }}>{isPro ? "Pro" : t("free")}</span>
                  </div>
                  {isFree && (
                    <button className="btn-primary" style={{ width: "100%", margin: "8px 0 12px", padding: "10px 0", fontSize: 14, fontWeight: 600 }} onClick={() => { setProfileSettingsOpen(false); setUpgradeModal("general"); }}>
                      {t("upgrade_to_pro")}
                    </button>
                  )}

                  {/* Push Notifications */}
                  <div style={{ padding: "14px 0", borderTop: "1px solid var(--border)" }}>
                    <div style={{ fontSize: 14, fontWeight: 600, color: "var(--text-primary)", marginBottom: 10 }}>{t("notifications")}</div>
                    {("Notification" in window) && Notification.permission !== "granted" ? (
                      <button className="btn-secondary" style={{ width: "100%", padding: "10px 0", fontSize: 13 }} onClick={async () => { const perm = await Notification.requestPermission(); if (perm === "granted") { const ok = await subscribeToPush(); setPushEnabled(ok); } }}>
                        {t("enable_push")}
                      </button>
                    ) : (
                      <>
                        <div style={{ fontSize: 12, color: "var(--text-tertiary)", marginBottom: 4 }}>{t("push_enabled")}</div>
                        {/* Follow-up nudge toggle */}
                        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 8, padding: "8px 0" }}>
                          <div>
                            <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text-primary)" }}>{t("follow_up_reminders")}</div>
                            <div style={{ fontSize: 10, color: "var(--text-tertiary)", lineHeight: 1.3 }}>{t("nudge_desc")}</div>
                          </div>
                          <button onClick={() => {
                            const current = !(localStorage.getItem("attair_nudge_off") === "1");
                            localStorage.setItem("attair_nudge_off", current ? "1" : "0");
                            API.updateNotifPrefs({ follow_up_nudges: !current });
                          }} style={{ width: 40, height: 22, borderRadius: 11, border: "none", cursor: "pointer", position: "relative", background: localStorage.getItem("attair_nudge_off") === "1" ? "var(--border)" : "var(--accent)", transition: "background .2s" }}>
                            <div style={{ width: 18, height: 18, borderRadius: 9, background: "#fff", position: "absolute", top: 2, transition: "left .2s", left: localStorage.getItem("attair_nudge_off") === "1" ? 2 : 20 }} />
                          </button>
                        </div>
                        {/* Style Twins weekly notification toggle */}
                        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 4, padding: "8px 0" }}>
                          <div>
                            <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text-primary)" }}>{t("style_twins_notif")}</div>
                            <div style={{ fontSize: 10, color: "var(--text-tertiary)", lineHeight: 1.3 }}>{t("style_twins_desc")}</div>
                          </div>
                          <button onClick={() => {
                            const current = !(localStorage.getItem("attair_twins_notif_off") === "1");
                            localStorage.setItem("attair_twins_notif_off", current ? "1" : "0");
                            API.updateNotifPrefs({ style_twins: !current });
                          }} style={{ width: 40, height: 22, borderRadius: 11, border: "none", cursor: "pointer", position: "relative", background: localStorage.getItem("attair_twins_notif_off") === "1" ? "var(--border)" : "var(--accent)", transition: "background .2s" }}>
                            <div style={{ width: 18, height: 18, borderRadius: 9, background: "#fff", position: "absolute", top: 2, transition: "left .2s", left: localStorage.getItem("attair_twins_notif_off") === "1" ? 2 : 20 }} />
                          </button>
                        </div>
                      </>
                    )}
                  </div>

                  {/* Referral */}
                  {referralCode && (
                    <div style={{ padding: "14px 0", borderTop: "1px solid var(--border)" }}>
                      <div style={{ fontSize: 14, fontWeight: 600, color: "var(--text-primary)", marginBottom: 6 }}>{t("refer_friend")}</div>
                      <div style={{ fontSize: 12, color: "var(--text-tertiary)", marginBottom: 10, lineHeight: 1.4 }}>{t("refer_desc")}</div>
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <div style={{ flex: 1, padding: "8px 12px", background: "var(--accent-bg)", border: "1px solid var(--accent-border)", borderRadius: "var(--radius-sm)", fontWeight: 800, color: "var(--accent)", letterSpacing: 2, fontSize: 14, fontFamily: "var(--font-sans)" }}>{referralCode}</div>
                        <button className="btn-secondary" style={{ padding: "8px 14px", fontSize: 12, whiteSpace: "nowrap" }} onClick={() => {
                          navigator.clipboard.writeText(referralCode).then(() => { setReferralCopied(true); setTimeout(() => setReferralCopied(false), 2000); }).catch(() => {});
                        }}>{referralCopied ? t("copied") : t("copy")}</button>
                      </div>
                    </div>
                  )}

                  {/* Sign out */}
                  <div className="settings-sheet-item danger" style={{ marginTop: 8 }} onClick={() => { setProfileSettingsOpen(false); handleLogout(); }} role="button" aria-label="Sign out">{t("log_out")}</div>
                </div>
              </>}


              {/* ─── Size Preferences Modal ───────────────── */}
              {sizePrefsModalOpen && (
                <div className="modal-overlay" onClick={() => setSizePrefsModalOpen(false)}>
                  <div className="modal-box" onClick={e => e.stopPropagation()} style={{ padding: "28px 24px 24px", maxHeight: "80vh", overflowY: "auto" }}>
                    <button className="modal-x" onClick={() => setSizePrefsModalOpen(false)}>✕</button>
                    <h2 className="modal-title" style={{ fontSize: 22, marginBottom: 4 }}>{t("size_prefs_title")}</h2>
                    <p className="modal-sub" style={{ marginBottom: 16 }}>{t("size_prefs_sub")}</p>

                    {/* Size categories — universal, no gender split */}
                    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
                      {/* Tops */}
                      <div>
                        <label style={{ fontSize: 12, fontWeight: 600, color: "var(--text-secondary)", marginBottom: 6, display: "block" }}>{t("tops")}</label>
                        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                          {["XS","S","M","L","XL","XXL"].map(s => (
                            <button key={s} onClick={() => setSizePrefsEdit(p => ({ ...p, tops: p.tops === s ? "" : s }))}
                              style={{ padding: "8px 14px", borderRadius: 8, border: `1.5px solid ${sizePrefsEdit.tops === s ? "var(--accent-border)" : "var(--border)"}`, background: sizePrefsEdit.tops === s ? "var(--accent-bg)" : "var(--bg-input)", color: sizePrefsEdit.tops === s ? "var(--accent)" : "var(--text-tertiary)", fontSize: 13, fontWeight: 600, cursor: "pointer", fontFamily: "var(--font-sans)", minHeight: 40 }}>
                              {s}
                            </button>
                          ))}
                        </div>
                      </div>

                      {/* Bottoms Waist */}
                      <div>
                        <label style={{ fontSize: 12, fontWeight: 600, color: "var(--text-secondary)", marginBottom: 6, display: "block" }}>{t("bottoms_waist")}</label>
                        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                          {["24","25","26","27","28","29","30","31","32","33","34","36","38","40"].map(s => (
                            <button key={s} onClick={() => setSizePrefsEdit(p => ({ ...p, bottoms_waist: p.bottoms_waist === s ? "" : s }))}
                              style={{ padding: "8px 12px", borderRadius: 8, border: `1.5px solid ${sizePrefsEdit.bottoms_waist === s ? "var(--accent-border)" : "var(--border)"}`, background: sizePrefsEdit.bottoms_waist === s ? "var(--accent-bg)" : "var(--bg-input)", color: sizePrefsEdit.bottoms_waist === s ? "var(--accent)" : "var(--text-tertiary)", fontSize: 13, fontWeight: 600, cursor: "pointer", fontFamily: "var(--font-sans)", minHeight: 40 }}>
                              {s}
                            </button>
                          ))}
                        </div>
                      </div>

                      {/* Bottoms Length */}
                      <div>
                        <label style={{ fontSize: 12, fontWeight: 600, color: "var(--text-secondary)", marginBottom: 6, display: "block" }}>{t("bottoms_length")}</label>
                        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                          {["28","29","30","31","32","34","36"].map(s => (
                            <button key={s} onClick={() => setSizePrefsEdit(p => ({ ...p, bottoms_length: p.bottoms_length === s ? "" : s }))}
                              style={{ padding: "8px 12px", borderRadius: 8, border: `1.5px solid ${sizePrefsEdit.bottoms_length === s ? "var(--accent-border)" : "var(--border)"}`, background: sizePrefsEdit.bottoms_length === s ? "var(--accent-bg)" : "var(--bg-input)", color: sizePrefsEdit.bottoms_length === s ? "var(--accent)" : "var(--text-tertiary)", fontSize: 13, fontWeight: 600, cursor: "pointer", fontFamily: "var(--font-sans)", minHeight: 40 }}>
                              {s}
                            </button>
                          ))}
                        </div>
                      </div>

                      {/* Shoes */}
                      <div>
                        <label style={{ fontSize: 12, fontWeight: 600, color: "var(--text-secondary)", marginBottom: 6, display: "block" }}>{t("shoes")}</label>
                        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                          {["5","5.5","6","6.5","7","7.5","8","8.5","9","9.5","10","10.5","11","11.5","12","13","14","15"].map(s => (
                            <button key={s} onClick={() => setSizePrefsEdit(p => ({ ...p, shoes: p.shoes === s ? "" : s }))}
                              style={{ padding: "8px 12px", borderRadius: 8, border: `1.5px solid ${sizePrefsEdit.shoes === s ? "var(--accent-border)" : "var(--border)"}`, background: sizePrefsEdit.shoes === s ? "var(--accent-bg)" : "var(--bg-input)", color: sizePrefsEdit.shoes === s ? "var(--accent)" : "var(--text-tertiary)", fontSize: 13, fontWeight: 600, cursor: "pointer", fontFamily: "var(--font-sans)", minHeight: 40 }}>
                              {s}
                            </button>
                          ))}
                        </div>
                      </div>

                      {/* Dresses — optional for anyone */}
                      <div>
                        <label style={{ fontSize: 12, fontWeight: 600, color: "var(--text-secondary)", marginBottom: 6, display: "block" }}>{t("dresses")}</label>
                        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                          {["0","2","4","6","8","10","12","14","16"].map(s => (
                            <button key={s} onClick={() => setSizePrefsEdit(p => ({ ...p, dresses: p.dresses === s ? "" : s }))}
                              style={{ padding: "8px 12px", borderRadius: 8, border: `1.5px solid ${sizePrefsEdit.dresses === s ? "var(--accent-border)" : "var(--border)"}`, background: sizePrefsEdit.dresses === s ? "var(--accent-bg)" : "var(--bg-input)", color: sizePrefsEdit.dresses === s ? "var(--accent)" : "var(--text-tertiary)", fontSize: 13, fontWeight: 600, cursor: "pointer", fontFamily: "var(--font-sans)", minHeight: 40 }}>
                              {s}
                            </button>
                          ))}
                        </div>
                      </div>
                    </div>

                    {/* Save / Cancel */}
                    <button
                      className="btn-primary"
                      disabled={sizePrefsSaving}
                      style={{ width: "100%", padding: "12px 0", fontSize: 14, fontWeight: 600, marginTop: 20 }}
                      onClick={async () => {
                        setSizePrefsSaving(true);
                        try {
                          const newSizePrefs = {
                            ...sizePrefs,
                            sizes: {
                              ...sizePrefs.sizes,
                              tops: sizePrefsEdit.tops || null,
                              bottoms_waist: sizePrefsEdit.bottoms_waist || null,
                              bottoms_length: sizePrefsEdit.bottoms_length || null,
                              shoes: sizePrefsEdit.shoes || null,
                              dresses: sizePrefsEdit.dresses || null,
                            },
                          };
                          await API.updateProfile({ size_prefs: newSizePrefs });
                          setSizePrefs(newSizePrefs);
                          setSizePrefsModalOpen(false);
                        } catch {}
                        setSizePrefsSaving(false);
                      }}
                    >{sizePrefsSaving ? t("saving") : t("save_sizes")}</button>
                    <button className="modal-later" onClick={() => {
                      if (sizePrefsOrigRef.current) setSizePrefs(sizePrefsOrigRef.current);
                      setSizePrefsModalOpen(false);
                    }}>{t("cancel")}</button>
                  </div>
                </div>
              )}

              {/* ─── Followers / Following List ───────────── */}
              {followListOpen && (
                <div className="scan-overlay" role="dialog" aria-modal="true" style={{ zIndex: 340, background: "var(--bg-primary)" }}>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "16px 20px 12px" }}>
                    <h2 style={{ fontSize: 18, fontWeight: 700, color: "var(--text-primary)", margin: 0 }}>
                      {followListOpen === "followers" ? t("followers") : t("following")}
                    </h2>
                    <button onClick={() => setFollowListOpen(null)} style={{ width: 32, height: 32, display: "flex", alignItems: "center", justifyContent: "center", background: "none", border: "none", cursor: "pointer", borderRadius: "50%", color: "var(--text-secondary)" }}>
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                    </button>
                  </div>
                  <div style={{ padding: "0 20px", overflowY: "auto", flex: 1 }}>
                    {followListLoading ? (
                      <div style={{ display: "flex", justifyContent: "center", padding: 40 }}>
                        <div className="ld-dots"><div className="ld-dot" /><div className="ld-dot" /><div className="ld-dot" /></div>
                      </div>
                    ) : followListData.length === 0 ? (
                      <div style={{ textAlign: "center", padding: "40px 20px", color: "var(--text-tertiary)", fontSize: 14 }}>
                        {followListOpen === "followers" ? t("no_followers_yet") : t("no_following_yet")}
                      </div>
                    ) : (
                      followListData.map(user => {
                        const isFlw = followingSet.has(user.id);
                        return (
                          <div key={user.id} style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 0", borderBottom: "1px solid var(--border)" }}>
                            <div style={{ width: 44, height: 44, borderRadius: "50%", background: "var(--accent-bg)", border: "1.5px solid var(--accent-border)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 16, fontWeight: 700, color: "var(--accent)", flexShrink: 0 }}>
                              {(user.display_name || "U")[0].toUpperCase()}
                            </div>
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <div style={{ fontSize: 14, fontWeight: 600, color: "var(--text-primary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{user.display_name || "User"}</div>
                              {user.bio && <div style={{ fontSize: 12, color: "var(--text-tertiary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", marginTop: 1 }}>{user.bio}</div>}
                            </div>
                            <button
                              className={`user-search-follow-btn ${isFlw ? "following" : "follow"}`}
                              onClick={async (e) => {
                                e.stopPropagation();
                                try {
                                  if (isFlw) {
                                    await API.unfollowUser(user.id);
                                    setFollowingSet(prev => { const n = new Set(prev); n.delete(user.id); return n; });
                                    setProfileStats(ps => ps ? { ...ps, following_count: Math.max(0, (ps.following_count || 0) - 1) } : ps);
                                  } else {
                                    await API.followUser(user.id);
                                    setFollowingSet(prev => new Set(prev).add(user.id));
                                    setProfileStats(ps => ps ? { ...ps, following_count: (ps.following_count || 0) + 1 } : ps);
                                  }
                                } catch {}
                              }}
                              style={{ flexShrink: 0, padding: "6px 16px", fontSize: 12, fontWeight: 600, borderRadius: 8, cursor: "pointer", minHeight: 32 }}
                            >{isFlw ? t("unfollow") : t("follow")}</button>
                          </div>
                        );
                      })
                    )}
                  </div>
                </div>
              )}

              {/* ─── Language Change Confirmation ─────────── */}
              {langConfirmOpen && (
                <div className="modal-overlay" onClick={() => setLangConfirmOpen(null)} style={{ zIndex: 360 }}>
                  <div className="modal-box" onClick={e => e.stopPropagation()} style={{ padding: "28px 24px 24px", textAlign: "center" }}>
                    <h2 className="modal-title" style={{ fontSize: 20, marginBottom: 8 }}>
                      {STRINGS[langConfirmOpen]?.confirm_language || "Change language?"}
                    </h2>
                    <p className="modal-sub" style={{ marginBottom: 20 }}>
                      {STRINGS[langConfirmOpen]?.confirm_language_desc || "Change language to"} {({en:"English",es:"Español",fr:"Français",de:"Deutsch",zh:"中文",ja:"日本語",ko:"한국어",pt:"Português"})[langConfirmOpen] || langConfirmOpen}?
                    </p>
                    <button className="btn-primary" style={{ width: "100%", padding: "12px 0", fontSize: 14, fontWeight: 600 }}
                      onClick={() => {
                        setLang(langConfirmOpen);
                        localStorage.setItem("attair_lang", langConfirmOpen);
                        setLangConfirmOpen(null);
                      }}
                    >{STRINGS[langConfirmOpen]?.confirm_btn || "Confirm"}</button>
                    <button className="modal-later" onClick={() => setLangConfirmOpen(null)}>
                      {STRINGS[langConfirmOpen]?.cancel_btn || "Cancel"}
                    </button>
                  </div>
                </div>
              )}
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
                    {[{l:"Standard",v:"standard"},{l:"Petite",v:"petite"},{l:"Tall",v:"tall"},{l:"Plus Size",v:"plus"},{l:"Big & Tall",v:"big_tall"},{l:"Athletic",v:"athletic"},{l:"Curvy",v:"curvy"},{l:"Hourglass",v:"hourglass"},{l:"Pear",v:"pear"},{l:"Apple",v:"apple"},{l:"Rectangle",v:"rectangle"},{l:"Inverted Triangle",v:"inverted_triangle"},{l:"Long Torso",v:"long_torso"},{l:"Short Torso",v:"short_torso"}].map(o => {
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
                    {[{l:"Slim/Fitted",v:"slim"},{l:"Regular",v:"regular"},{l:"Relaxed",v:"relaxed"},{l:"Oversized",v:"oversized"},{l:"Flowy",v:"flowy"},{l:"Tailored",v:"tailored"},{l:"Cropped",v:"cropped"},{l:"Longline",v:"longline"},{l:"Structured",v:"structured"},{l:"Draped",v:"draped"},{l:"Boxy",v:"boxy"},{l:"A-Line",v:"a_line"},{l:"Bodycon",v:"bodycon"}].map(o => {
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
              <input className="user-search-input" placeholder={t("search_people")} autoFocus value={userSearchQuery} onChange={e => setUserSearchQuery(e.target.value)} />
              <button className="user-search-cancel" onClick={() => { setShowUserSearch(false); setUserSearchQuery(""); setUserSearchResults([]); }}>{t("cancel")}</button>
            </div>
            <div className="user-search-list">
              {userSearchLoading && <div style={{ textAlign: "center", padding: 32, color: "var(--text-tertiary)", fontSize: 13 }}>Searching...</div>}
              {!userSearchLoading && userSearchQuery.trim() && userSearchResults.length === 0 && <div style={{ textAlign: "center", padding: 32, color: "var(--text-tertiary)", fontSize: 13 }}>{t("no_users_found")}</div>}
              {!userSearchLoading && !userSearchQuery.trim() && <div style={{ textAlign: "center", padding: 32, color: "var(--text-tertiary)", fontSize: 13 }}>{t("type_to_search")}</div>}
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

        {/* ─── Outfit of the Week Detail Overlay ────────── */}
        {ootwExpanded && ootwData && (
          <div className="ootw-overlay animate-fade-in" style={{ position: "fixed", inset: 0, zIndex: 1100, background: "var(--bg-primary)", overflowY: "auto", WebkitOverflowScrolling: "touch" }}>
            {/* Close button */}
            <button
              aria-label="Close"
              onClick={() => setOotwExpanded(false)}
              style={{ position: "fixed", top: 12, right: 12, zIndex: 1101, width: 36, height: 36, borderRadius: "50%", background: "rgba(0,0,0,0.6)", backdropFilter: "blur(10px)", border: "none", color: "#fff", fontSize: 18, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}
            >&#x2715;</button>

            {/* Hero cover */}
            <div style={{ position: "relative", width: "100%", height: 280, overflow: "hidden" }}>
              {ootwData.cover_image ? (
                <img src={ootwData.cover_image} alt="" style={{ width: "100%", height: "100%", objectFit: "cover", filter: "brightness(0.5)" }} onError={e => { e.target.style.display = "none"; }} />
              ) : (
                <div style={{ width: "100%", height: "100%", background: "linear-gradient(135deg, #1A1A1A 0%, #2A2520 100%)" }} />
              )}
              <div style={{ position: "absolute", inset: 0, background: "linear-gradient(to bottom, rgba(0,0,0,0) 30%, rgba(0,0,0,0.85) 100%)" }} />
              <div style={{ position: "absolute", bottom: 24, left: 20, right: 20 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
                  <div style={{ width: 28, height: 28, borderRadius: 7, background: "linear-gradient(135deg, #C9A96E, #E8D5A8)", display: "flex", alignItems: "center", justifyContent: "center" }}>
                    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="#000" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>
                  </div>
                  <span style={{ fontSize: 10, fontWeight: 700, color: "var(--accent)", letterSpacing: 1.5, textTransform: "uppercase" }}>This Week's Look</span>
                </div>
                <h1 style={{ fontSize: 24, fontWeight: 800, color: "#fff", lineHeight: 1.15, margin: 0 }}>{ootwData?.headline || "This Week's Look"}</h1>
              </div>
            </div>

            {/* Editorial */}
            <div style={{ padding: "20px 20px 8px" }}>
              <p style={{ fontSize: 15, color: "var(--text-secondary)", lineHeight: 1.6, margin: 0 }}>{ootwData?.editorial || "Check out the top trending outfits this week."}</p>
              <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 12, fontSize: 11, color: "var(--text-tertiary)" }}>
                <span>Week of {ootwData?.week_start ? new Date(ootwData.week_start + "T00:00:00Z").toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "This week"}</span>
                {ootwData?.view_count > 0 && <span>{ootwData.view_count.toLocaleString()} views</span>}
                <span>{(ootwData.scans || []).length} looks</span>
              </div>
            </div>

            {/* Divider */}
            <div style={{ height: 1, background: "var(--border)", margin: "12px 20px" }} />

            {/* Scan grid */}
            <div style={{ padding: "0 12px 120px" }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: "var(--text-primary)", padding: "8px 8px 12px", letterSpacing: 0.3 }}>Top {(ootwData.scans || []).length} Looks</div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                {(ootwData.scans || []).map((scan, idx) => {
                  const u = scan.user || {};
                  const ini = (u.display_name || "?").split(" ").map(w => w[0]).join("").slice(0,2).toUpperCase();
                  return (
                    <div key={scan.id || idx} className="feed-card card-enter" style={{ animationDelay: `${idx * 0.06}s` }} onClick={() => { setOotwExpanded(false); setFeedDetailScan(scan); }}>
                      <div style={{ position: "relative" }}>
                        {scan.image_url
                          ? <img className="feed-card-img" src={scan.image_url} alt={scan.summary || "Outfit"} loading="lazy" onError={e => { e.target.style.display = "none"; }} />
                          : <div className="feed-card-img" style={{ background: "var(--bg-card)", display: "flex", alignItems: "center", justifyContent: "center" }}>
                              <svg viewBox="0 0 24 24" width="48" height="48" fill="none" stroke="var(--text-tertiary)" strokeWidth="1"><rect x="2" y="6" width="20" height="14" rx="3" /><circle cx="12" cy="13" r="4" /></svg>
                            </div>
                        }
                        {/* Rank badge — gold gradient for top 3, muted for 4-10 */}
                        <div style={{ position: "absolute", top: 8, left: 8, padding: "2px 8px", borderRadius: 100, background: idx < 3 ? "linear-gradient(135deg, #C9A96E, #E8D5A8)" : "rgba(255,255,255,0.12)", fontSize: 11, fontWeight: 800, color: idx < 3 ? "#0C0C0E" : "rgba(255,255,255,0.7)", backdropFilter: idx >= 3 ? "blur(8px)" : "none" }}>#{idx + 1}</div>
                        <div className="feed-card-pills">
                          {scan.save_count > 0 && (
                            <div className="feed-card-pill">
                              <svg viewBox="0 0 24 24" width="12" height="12" fill="var(--accent)" stroke="none"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>
                              {scan.save_count}
                            </div>
                          )}
                          {scan.item_count > 0 && (
                            <div className="feed-card-pill feed-card-items-pill">
                              {scan.item_count} {scan.item_count === 1 ? "item" : "items"}
                            </div>
                          )}
                        </div>
                        <div className="feed-card-overlay">
                          <div className="feed-card-user">
                            <div className="feed-card-avatar">{ini}</div>
                            <div className="feed-card-info">
                              <div className="feed-card-name">{u.display_name || "Anonymous"}</div>
                              {scan.summary && <div className="feed-card-summary">{scan.summary}</div>}
                            </div>
                          </div>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        )}

        {/* ─── Weekly Style Report Overlay (Pro users) ── */}
        {weeklyReportOpen && (
          <div className="ootw-overlay animate-fade-in" style={{ position: "fixed", inset: 0, zIndex: 1100, background: "var(--bg-primary)", overflowY: "auto", WebkitOverflowScrolling: "touch" }}>
            <button
              aria-label="Close"
              onClick={() => { setWeeklyReportOpen(false); setWeeklyReportError(false); setWeeklyReportNotPro(false); }}
              style={{ position: "fixed", top: 12, right: 12, zIndex: 1101, width: 36, height: 36, borderRadius: "50%", background: "rgba(0,0,0,0.6)", backdropFilter: "blur(10px)", border: "none", color: "#fff", fontSize: 18, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}
            >&#x2715;</button>

            {/* Loading state */}
            {weeklyReportLoading && (
              <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", minHeight: "60vh", gap: 16, padding: 32 }}>
                <div style={{ width: "100%", maxWidth: 340 }}>
                  <div className="skeleton" style={{ width: "100%", height: 200, borderRadius: 16, marginBottom: 16 }} />
                  <div className="skeleton" style={{ width: "60%", height: 14, borderRadius: 8, marginBottom: 10 }} />
                  <div className="skeleton" style={{ width: "85%", height: 22, borderRadius: 8, marginBottom: 12 }} />
                  <div className="skeleton" style={{ width: "100%", height: 160, borderRadius: 16, marginBottom: 12 }} />
                  <div className="skeleton" style={{ width: "100%", height: 160, borderRadius: 16, marginBottom: 12 }} />
                  <div className="skeleton" style={{ width: "100%", height: 160, borderRadius: 16 }} />
                </div>
              </div>
            )}

            {/* Error state */}
            {weeklyReportError && !weeklyReportLoading && (
              <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", minHeight: "60vh", gap: 16, padding: 32, textAlign: "center" }}>
                <div style={{ width: 56, height: 56, borderRadius: 16, background: "rgba(255,59,48,0.12)", display: "flex", alignItems: "center", justifyContent: "center", marginBottom: 4 }}>
                  <svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="#FF3B30" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
                </div>
                <div style={{ fontSize: 17, fontWeight: 700, color: "var(--text-primary)" }}>Couldn't load your report</div>
                <div style={{ fontSize: 13, color: "var(--text-secondary)", lineHeight: 1.5, maxWidth: 260 }}>Something went wrong fetching your Weekly Style Report. Check your connection and try again.</div>
                <button
                  onClick={() => {
                    setWeeklyReportError(false);
                    setWeeklyReportLoading(true);
                    API.getMyWeeklyReport()
                      .then(d => {
                        if (d.report && d.report.scans && d.report.scans.length > 0) {
                          setWeeklyReport(d.report);
                        } else {
                          setWeeklyReportOpen(false);
                          setOotwLoading(true);
                          API.getOOTW()
                            .then(od => { if (od.ootw) { setOotwData(od.ootw); setOotwExpanded(true); } })
                            .catch(() => setOotwError(true))
                            .finally(() => setOotwLoading(false));
                        }
                      })
                      .catch(() => setWeeklyReportError(true))
                      .finally(() => setWeeklyReportLoading(false));
                  }}
                  style={{ marginTop: 8, padding: "10px 28px", borderRadius: 100, background: "var(--accent)", color: "#0C0C0E", fontSize: 14, fontWeight: 700, border: "none", cursor: "pointer" }}
                >Retry</button>
              </div>
            )}

            {/* Not Pro — upgrade nudge */}
            {weeklyReportNotPro && !weeklyReportLoading && (
              <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", minHeight: "60vh", gap: 16, padding: 32, textAlign: "center" }}>
                <div style={{ width: 56, height: 56, borderRadius: 16, background: "linear-gradient(135deg, rgba(201,169,110,0.15), rgba(232,213,168,0.15))", display: "flex", alignItems: "center", justifyContent: "center", marginBottom: 4 }}>
                  <svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg>
                </div>
                <div style={{ fontSize: 17, fontWeight: 700, color: "var(--text-primary)" }}>Weekly Style Reports are for Pro</div>
                <div style={{ fontSize: 13, color: "var(--text-secondary)", lineHeight: 1.5, maxWidth: 280 }}>Upgrade to Pro to get 3 personalized looks delivered every Sunday, curated from trending scans that match your style.</div>
                <button
                  onClick={() => { setWeeklyReportOpen(false); setWeeklyReportNotPro(false); setTab("profile"); }}
                  style={{ marginTop: 8, padding: "10px 28px", borderRadius: 100, background: "linear-gradient(135deg, #C9A96E, #E8D5A8)", color: "#0C0C0E", fontSize: 14, fontWeight: 700, border: "none", cursor: "pointer" }}
                >Upgrade to Pro</button>
                <button
                  onClick={() => { setWeeklyReportOpen(false); setWeeklyReportNotPro(false); }}
                  style={{ padding: "8px 20px", background: "none", border: "none", color: "var(--text-tertiary)", fontSize: 13, cursor: "pointer" }}
                >Maybe later</button>
              </div>
            )}

            {/* Report content — only shown when data loaded */}
            {weeklyReport && !weeklyReportLoading && !weeklyReportError && !weeklyReportNotPro && (<>
            {/* Hero */}
            <div style={{ position: "relative", width: "100%", height: 220, overflow: "hidden" }}>
              {weeklyReport.scans[0]?.image_url ? (
                <img src={weeklyReport.scans[0].image_url} alt="" style={{ width: "100%", height: "100%", objectFit: "cover", filter: "brightness(0.4) saturate(1.2)" }} />
              ) : (
                <div style={{ width: "100%", height: "100%", background: "linear-gradient(135deg, #1A1A1A 0%, #2A2520 100%)" }} />
              )}
              <div style={{ position: "absolute", inset: 0, background: "linear-gradient(to bottom, rgba(0,0,0,0.1) 0%, rgba(0,0,0,0.85) 100%)" }} />
              <div style={{ position: "absolute", bottom: 24, left: 20, right: 20 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
                  <div style={{ width: 28, height: 28, borderRadius: 7, background: "linear-gradient(135deg, #C9A96E, #E8D5A8)", display: "flex", alignItems: "center", justifyContent: "center" }}>
                    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="#000" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>
                  </div>
                  <span style={{ fontSize: 10, fontWeight: 700, color: "var(--accent)", letterSpacing: 1.5, textTransform: "uppercase" }}>Your Weekly Style Report</span>
                </div>
                <h1 style={{ fontSize: 22, fontWeight: 800, color: "#fff", lineHeight: 1.15, margin: 0 }}>3 Looks Picked Just for You</h1>
                <p style={{ fontSize: 13, color: "rgba(255,255,255,0.65)", margin: "8px 0 0", lineHeight: 1.4 }}>Curated from trending scans that match your saved styles and preferences.</p>
              </div>
            </div>

            {/* Week label */}
            <div style={{ padding: "16px 20px 4px", display: "flex", alignItems: "center", gap: 12, fontSize: 11, color: "var(--text-tertiary)" }}>
              <span>Week of {new Date(weeklyReport.week_start + "T00:00:00Z").toLocaleDateString(undefined, { month: "short", day: "numeric" })}</span>
              <span>{weeklyReport.scans.length} personalized {weeklyReport.scans.length === 1 ? "look" : "looks"}</span>
            </div>

            <div style={{ height: 1, background: "var(--border)", margin: "12px 20px" }} />

            {/* Looks grid — full-width cards for 3 items */}
            <div style={{ padding: "0 16px 120px" }}>
              {weeklyReport.scans.map((scan, idx) => {
                const u = scan.user || {};
                const ini = (u.display_name || "?").split(" ").map(w => w[0]).join("").slice(0,2).toUpperCase();
                return (
                  <div
                    key={scan.id || idx}
                    className="card-press animate-slide-up"
                    onClick={() => { setWeeklyReportOpen(false); setFeedDetailScan(scan); }}
                    style={{ marginBottom: 12, borderRadius: 16, overflow: "hidden", border: "1px solid var(--border)", background: "var(--bg-card)", cursor: "pointer", animationDelay: `${idx * 0.1}s` }}
                  >
                    <div style={{ position: "relative" }}>
                      {scan.image_url ? (
                        <img src={scan.image_url} alt={scan.summary || "Outfit"} loading="lazy" style={{ width: "100%", aspectRatio: "4/3", objectFit: "cover", display: "block" }} />
                      ) : (
                        <div style={{ width: "100%", aspectRatio: "4/3", background: "var(--bg-input)", display: "flex", alignItems: "center", justifyContent: "center" }}>
                          <svg viewBox="0 0 24 24" width="48" height="48" fill="none" stroke="var(--text-tertiary)" strokeWidth="1"><rect x="2" y="6" width="20" height="14" rx="3" /><circle cx="12" cy="13" r="4" /></svg>
                        </div>
                      )}
                      {/* Pick number badge */}
                      <div style={{ position: "absolute", top: 12, left: 12, padding: "4px 12px", borderRadius: 100, background: "linear-gradient(135deg, #C9A96E, #E8D5A8)", fontSize: 12, fontWeight: 800, color: "#0C0C0E" }}>Pick #{idx + 1}</div>
                      {scan.save_count > 0 && (
                        <div style={{ position: "absolute", top: 12, right: 12, padding: "4px 10px", borderRadius: 100, background: "rgba(0,0,0,0.6)", backdropFilter: "blur(8px)", fontSize: 11, fontWeight: 700, color: "#fff", display: "flex", alignItems: "center", gap: 4 }}>
                          <svg viewBox="0 0 24 24" width="12" height="12" fill="var(--accent)" stroke="none"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>
                          {scan.save_count}
                        </div>
                      )}
                    </div>
                    <div style={{ padding: "12px 14px" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                        <div style={{ width: 28, height: 28, borderRadius: "50%", background: "linear-gradient(135deg, var(--accent), #E8D5A8)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 10, fontWeight: 800, color: "#0C0C0E" }}>{ini}</div>
                        <span style={{ fontSize: 13, fontWeight: 700, color: "var(--text-primary)" }}>{u.display_name || "Anonymous"}</span>
                      </div>
                      {scan.summary && <div style={{ fontSize: 13, color: "var(--text-secondary)", lineHeight: 1.4, display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>{scan.summary}</div>}
                      {scan.item_count > 0 && <div style={{ fontSize: 11, color: "var(--text-tertiary)", marginTop: 6 }}>{scan.item_count} item{scan.item_count !== 1 ? "s" : ""} identified</div>}
                    </div>
                  </div>
                );
              })}
            </div>
          </>)}
          </div>
        )}

        {/* ─── Feed Detail Overlay (Reels-style fullscreen) ─────────────────────── */}
        {feedDetailScan && (() => {
          const renderPost = (scan, idx) => {
            const u = scan.user || {};
            const ini = (u.display_name || "?").split(" ").map(w => w[0]).join("").slice(0,2).toUpperCase();
            const items = scan.items || [];
            const isSaved = saved.some(s => s.scan_id === scan.id);
            const isFlw = followingSet.has(u.id);
            const q0 = (item) => item.search_query || item.alt_search || `${item.brand || ""} ${item.name || item.category || ""}`.trim();
            return (
              <div key={scan.id || idx} className="reel-slide">
                {/* Background image — fills entire viewport */}
                {scan.image_url && <img className="reel-bg" src={scan.image_url} alt="" />}

                {/* Gradient overlays for text readability */}
                <div className="reel-grad-top" />
                <div className="reel-grad-bot" />

                {/* Right action bar (like TikTok/Reels) */}
                <div className="reel-actions">
                  <button className="reel-action" onClick={(e) => { e.stopPropagation(); const itemData = { name: scan.summary || "Scanned outfit", brand: u.display_name || "Unknown", category: "outfit", image_url: scan.image_url }; quickSaveItem(itemData, scan.id); }}>
                    <svg viewBox="0 0 24 24" width="26" height="26" fill={isSaved ? "#C9A96E" : "none"} stroke={isSaved ? "#C9A96E" : "#fff"} strokeWidth="2"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>
                    <span className="reel-action-label">{scan.save_count || ""}</span>
                  </button>
                  <button className="reel-action" onClick={(e) => { e.stopPropagation(); if (navigator.share) navigator.share({ title: scan.summary || "Check out this outfit on ATTAIRE", url: `${window.location.origin}/scan/${scan.id}` }).catch(() => {}); else navigator.clipboard.writeText(`${window.location.origin}/scan/${scan.id}`); }}>
                    <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>
                    <span className="reel-action-label">Share</span>
                  </button>
                  {items.length > 0 && (
                    <button className="reel-action" onClick={(e) => { e.stopPropagation(); const el = e.currentTarget.closest(".reel-slide").querySelector(".reel-items"); if (el) el.classList.toggle("open"); }}>
                      <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M6 2L3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z"/><line x1="3" y1="6" x2="21" y2="6"/><path d="M16 10a4 4 0 0 1-8 0"/></svg>
                      <span className="reel-action-label">Shop</span>
                    </button>
                  )}
                </div>

                {/* Bottom overlay — user info + caption */}
                <div className="reel-bottom">
                  <div className="reel-user-row">
                    <div className="reel-avatar">{ini}</div>
                    <span className="reel-username">{u.display_name || "Anonymous"}</span>
                    {u.id && u.id !== authUserId && (
                      <button className={`reel-follow${isFlw ? " following" : ""}`} onClick={(e) => { e.stopPropagation(); handleFollowFromSearch(u.id); }}>
                        {isFlw ? "Following" : "Follow"}
                      </button>
                    )}
                  </div>
                  {scan.summary && <div className="reel-caption">{scan.summary}</div>}
                  {scan.item_count > 0 && <div className="reel-meta">{scan.item_count} item{scan.item_count !== 1 ? "s" : ""} identified{(scan.save_count || 0) >= 3 ? " \u00B7 Trending" : ""}</div>}
                </div>

                {/* Shop drawer — slides up when Shop button tapped */}
                {items.length > 0 && (
                  <div className="reel-items">
                    <div className="reel-items-handle" onClick={(e) => { e.stopPropagation(); e.currentTarget.closest(".reel-items").classList.remove("open"); }} />
                    <div className="reel-items-title">Shop this look</div>
                    <div className="reel-items-list">
                      {items.map((item, i) => (
                        <button key={i} className="reel-item-chip" onClick={(e) => { e.stopPropagation(); window.open(`https://www.google.com/search?tbm=shop&q=${encodeURIComponent(q0(item))}`, "_blank"); }}>
                          <div className="reel-item-name">{item.name || item.category || "Item"}</div>
                          <div className="reel-item-sub">{[item.brand !== "Unidentified" && item.brand, item.price_range].filter(Boolean).join(" \u00B7 ")}</div>
                          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="reel-item-arrow"><line x1="7" y1="17" x2="17" y2="7"/><polyline points="7 7 17 7 17 17"/></svg>
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            );
          };

          return (
            <div className="reel-overlay">
              {/* Close button */}
              <button className="reel-close" onClick={() => { setFeedDetailScan(null); setFeedDetailIdx(-1); }}>
                <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="#fff" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
              </button>

              {/* Snap scroll container */}
              <div className="reel-scroller" ref={el => {
                if (el && !el._initScrolled) {
                  el._initScrolled = true;
                  el.scrollTop = feedDetailIdx * el.clientHeight;
                }
              }} onScroll={(e) => {
                const el = e.currentTarget;
                const slideH = el.clientHeight;
                const newIdx = Math.round(el.scrollTop / slideH);
                if (newIdx !== feedDetailIdx && newIdx >= 0 && newIdx < feedScans.length) {
                  setFeedDetailIdx(newIdx);
                  setFeedDetailScan(feedScans[newIdx]);
                  // Pre-fetch more when near end
                  if (newIdx + 3 >= feedScans.length && feedHasMore && !feedLoading) {
                    loadFeed(feedPage + 1, true);
                  }
                }
              }}>
                {feedScans.map((scan, idx) => renderPost(scan, idx))}
              </div>
            </div>
          );
        })()}

        {/* ─── PWA Install Banner ── */}
        {showInstallBanner && (
          <div style={{ padding: "10px 16px", background: "linear-gradient(135deg, rgba(201,169,110,.12) 0%, rgba(201,169,110,.06) 100%)", borderTop: "1px solid rgba(201,169,110,.2)", display: "flex", alignItems: "center", gap: 12 }}>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: "var(--text-primary)" }}>Add ATTAIRE to Home Screen</div>
              <div style={{ fontSize: 11, color: "var(--text-tertiary)" }}>Get the full app experience</div>
            </div>
            <button onClick={handleInstall} style={{ padding: "6px 16px", background: "var(--accent)", border: "none", borderRadius: 100, fontSize: 11, fontWeight: 700, color: "#0C0C0E", cursor: "pointer" }}>Install</button>
            <button onClick={() => setShowInstallBanner(false)} style={{ background: "none", border: "none", color: "var(--text-tertiary)", fontSize: 16, cursor: "pointer", padding: 4 }}>&times;</button>
          </div>
        )}

        {/* ─── Tab bar (5 tabs: Feed, Discover, Scan, Saved, Profile) ── */}
        <div className="tb">
          <button className={`tab${tab==="home"?" on":""}`} onClick={() => { track("tab_switched", { tab: "home" }); setTab("home"); setFeedTab("foryou"); setFeedPage(1); setShowUserSearch(false); }} aria-label="Feed">
            <svg viewBox="0 0 24 24" fill={tab==="home"?"currentColor":"none"} stroke="currentColor" strokeWidth="1.5"><path d="M3 9.5L12 3l9 6.5V20a1 1 0 01-1 1h-5v-6h-6v6H4a1 1 0 01-1-1V9.5z"/></svg>
            <span className="tab-l">Feed</span>
          </button>
          <button className={`tab${tab==="search"?" on":""}`} onClick={() => { track("tab_switched", { tab: "search" }); setTab("search"); setShowUserSearch(false); }} aria-label="Discover">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/></svg>
            <span className="tab-l">Discover</span>
          </button>
          <button className="tab-scan" onClick={() => { track("tab_switched", { tab: "scan" }); if (tab === "scan" && phase !== "idle") { reset(); if (fileRef.current) fileRef.current.value = ""; if (galleryRef.current) galleryRef.current.value = ""; } setTab("scan"); setShowUserSearch(false); }} aria-label="Scan outfit">
            <div className="tab-scan-icon">
              <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
            </div>
            <span className="tab-l">Scan</span>
          </button>
          <button className={`tab${tab==="likes"?" on":""}`} onClick={() => { if (isGuest) { setSignupPrompt("save"); return; } track("tab_switched", { tab: "likes" }); setTab("likes"); setShowUserSearch(false); }} aria-label="Wardrobe">
            <svg viewBox="0 0 24 24" fill={tab==="likes"?"currentColor":"none"} stroke="currentColor" strokeWidth="1.5"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>
            <span className="tab-l">{t("wardrobe")}</span>
            {priceAlertCount > 0 && (
              <span className="tab-badge" />
            )}
          </button>
          <button className={`tab${tab==="profile"?" on":""}`} onClick={() => { if (isGuest) { setSignupPrompt("social"); return; } track("tab_switched", { tab: "profile" }); setTab("profile"); setShowUserSearch(false); }} aria-label="Profile">
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
            <><img src="/logo-dark.svg" alt="ATTAIRE" className="logo-img logo-img--dark" /><img src="/logo-light.svg" alt="ATTAIRE" className="logo-img logo-img--light" /></>
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
                  {(ps.user_display_name || ps.user?.display_name) && (
                    <div style={{ fontSize: 12, color: "var(--text-tertiary)", marginBottom: 8, fontWeight: 600 }}>
                      Scanned by {ps.user_display_name || ps.user?.display_name}
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
                {["Slim", "Regular", "Relaxed", "Oversized", "Flowy", "Tailored", "Cropped", "Longline", "Structured", "Draped", "Boxy", "A-Line", "Bodycon"].map(fit => {
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

      {/* ═══ STYLE DNA — WRAPPED EXPERIENCE ═══════════════════ */}
      {showStyleDna && styleDna?.ready && (() => {
        const slide = styleDnaSlide;
        const TOTAL_SLIDES = 7;
        const stats = styleDna.stats || {};
        const scores = styleDna.style_score || {};

        const handleSlideNav = (e) => {
          e.stopPropagation();
          const rect = e.currentTarget.getBoundingClientRect();
          const x = e.clientX || (e.touches?.[0]?.clientX ?? rect.width);
          const relX = x - rect.left;
          // Tap left 30% = back, rest = forward
          if (relX < rect.width * 0.3 && slide > 0) {
            setStyleDnaSlide(s => s - 1);
          } else if (slide < TOTAL_SLIDES - 1) {
            setStyleDnaSlide(s => s + 1);
          }
        };

        const handleClose = () => {
          setShowStyleDna(false);
          setStyleDnaSlide(0);
        };

        const GRADIENTS = [
          "linear-gradient(165deg, #0C0C0E 0%, #1a1520 50%, #0C0C0E 100%)",
          "linear-gradient(165deg, #1a0a2e 0%, #12081e 50%, #0C0C0E 100%)",
          "linear-gradient(165deg, #0a1e1e 0%, #081414 50%, #0C0C0E 100%)",
          "linear-gradient(165deg, #1e1508 0%, #141008 50%, #0C0C0E 100%)",
          "linear-gradient(165deg, #1e0a14 0%, #14080e 50%, #0C0C0E 100%)",
          "linear-gradient(165deg, #0a0e1e 0%, #080a14 50%, #0C0C0E 100%)",
          "linear-gradient(165deg, #1a1508 0%, #12100a 50%, #0C0C0E 100%)",
        ];

        return (
          <div className="sdna-overlay" role="dialog" aria-label="Style DNA report" aria-modal="true">
            {/* Progress bar — Instagram Stories style */}
            <div className="sdna-progress">
              {Array.from({ length: TOTAL_SLIDES }).map((_, i) => (
                <div key={i} className={`sdna-seg${i < slide ? " done" : ""}${i === slide ? " active" : ""}`} />
              ))}
            </div>

            {/* Close button */}
            <button className="sdna-close" onClick={handleClose} aria-label="Close Style DNA">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </button>

            {/* Card — full screen, tap to advance */}
            <div className="sdna-card" style={{ background: GRADIENTS[slide] }} onClick={handleSlideNav} key={slide}>
              {/* Ambient glow */}
              <div className="sdna-glow" />

              {/* ── Slide 0: Intro ── */}
              {slide === 0 && (
                <div className="sdna-content">
                  <div className="sdna-label sdna-reveal">YOUR STYLE DNA</div>
                  <div className="sdna-big-num sdna-reveal" style={{ animationDelay: ".2s" }}>
                    {stats.total_scans || 0}
                  </div>
                  <div className="sdna-sub sdna-reveal" style={{ animationDelay: ".4s" }}>
                    outfits analyzed
                  </div>
                  <div className="sdna-body sdna-reveal" style={{ animationDelay: ".7s" }}>
                    Let's see what your style says about you
                  </div>
                </div>
              )}

              {/* ── Slide 1: Archetype Reveal ── */}
              {slide === 1 && (
                <div className="sdna-content">
                  <div className="sdna-label sdna-reveal">YOU ARE</div>
                  <div className="sdna-archetype sdna-scale-in" style={{ animationDelay: ".3s" }}>
                    {styleDna.archetype}
                  </div>
                  <div className="sdna-desc sdna-reveal" style={{ animationDelay: ".9s" }}>
                    {styleDna.description}
                  </div>
                </div>
              )}

              {/* ── Slide 2: Traits ── */}
              {slide === 2 && (
                <div className="sdna-content">
                  <div className="sdna-label sdna-reveal">YOUR STYLE IN FOUR WORDS</div>
                  <div className="sdna-traits">
                    {(styleDna.traits || []).map((trait, i) => (
                      <div key={i} className="sdna-trait sdna-reveal" style={{ animationDelay: `${0.3 + i * 0.2}s` }}>
                        {trait}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* ── Slide 3: Style Spectrum ── */}
              {slide === 3 && (
                <div className="sdna-content">
                  <div className="sdna-label sdna-reveal">YOUR STYLE SPECTRUM</div>
                  <div className="sdna-scores">
                    {[
                      { label: "Classic", label2: "Trendy", key: "classic_vs_trendy" },
                      { label: "Minimal", label2: "Maximal", key: "minimal_vs_maximal" },
                      { label: "Casual", label2: "Formal", key: "casual_vs_formal" },
                      { label: "Budget", label2: "Luxury", key: "budget_vs_luxury" }
                    ].map(({ label, label2, key }, i) => (
                      <div key={key} className="sdna-score-row sdna-reveal" style={{ animationDelay: `${0.3 + i * 0.2}s` }}>
                        <div className="sdna-score-labels">
                          <span>{label}</span><span>{label2}</span>
                        </div>
                        <div className="sdna-score-track">
                          <div className="sdna-score-fill" style={{ width: `${(scores[key] || 5) * 10}%`, animationDelay: `${0.5 + i * 0.2}s` }} />
                          <div className="sdna-score-dot" style={{ left: `${(scores[key] || 5) * 10}%`, animationDelay: `${0.7 + i * 0.2}s` }} />
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* ── Slide 4: Color Palette ── */}
              {slide === 4 && (
                <div className="sdna-content">
                  <div className="sdna-label sdna-reveal">YOUR COLOR PALETTE</div>
                  <div className="sdna-colors">
                    {(stats.dominant_colors || []).slice(0, 5).map((cObj, i) => {
                      const name = typeof cObj === "string" ? cObj : cObj.value;
                      return (
                        <div key={i} className="sdna-color sdna-reveal" style={{ animationDelay: `${0.3 + i * 0.15}s` }}>
                          <div className="sdna-swatch" style={{ background: sdnaColorHex(name) }} />
                          <span>{name}</span>
                        </div>
                      );
                    })}
                  </div>
                  {stats.price_tier && (
                    <div className="sdna-price sdna-reveal" style={{ animationDelay: ".95s" }}>
                      <span className="sdna-price-lbl">Your Price Zone</span>
                      <span className="sdna-price-val">{stats.price_tier}</span>
                    </div>
                  )}
                </div>
              )}

              {/* ── Slide 5: Top Brands ── */}
              {slide === 5 && (
                <div className="sdna-content">
                  <div className="sdna-label sdna-reveal">YOUR TOP BRANDS</div>
                  <div className="sdna-brands">
                    {(stats.top_brands || []).slice(0, 5).map((bObj, i) => {
                      const name = typeof bObj === "string" ? bObj : bObj.value;
                      return (
                        <div key={i} className="sdna-brand sdna-scale-in" style={{ animationDelay: `${0.3 + i * 0.2}s` }}>
                          {name}
                        </div>
                      );
                    })}
                  </div>
                  {stats.category_breakdown && Object.keys(stats.category_breakdown).length > 0 && (
                    <div className="sdna-cats sdna-reveal" style={{ animationDelay: "1.2s" }}>
                      {Object.entries(stats.category_breakdown).slice(0, 3).map(([cat, pct]) => (
                        <div key={cat} className="sdna-cat-chip">
                          <span className="sdna-cat-pct">{Math.round(pct)}%</span>
                          <span>{cat}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* ── Slide 6: Summary + Share ── */}
              {slide === 6 && (
                <div className="sdna-content sdna-final">
                  <div className="sdna-label sdna-reveal">YOUR STYLE DNA</div>
                  <div className="sdna-final-arch sdna-reveal" style={{ animationDelay: ".2s" }}>
                    {styleDna.archetype}
                  </div>
                  <div className="sdna-final-traits sdna-reveal" style={{ animationDelay: ".4s" }}>
                    {(styleDna.traits || []).join(" · ")}
                  </div>
                  <div className="sdna-final-chips sdna-reveal" style={{ animationDelay: ".6s" }}>
                    {(stats.dominant_colors || []).slice(0, 3).map((c, i) => (
                      <span key={i} className="sdna-chip">{typeof c === "string" ? c : c.value}</span>
                    ))}
                    {stats.price_tier && <span className="sdna-chip gold">{stats.price_tier}</span>}
                  </div>
                  {stats.top_brands?.length > 0 && (
                    <div className="sdna-final-brands sdna-reveal" style={{ animationDelay: ".8s" }}>
                      {stats.top_brands.slice(0, 3).map(b => typeof b === "string" ? b : b.value).join(" · ")}
                    </div>
                  )}
                  <button className="sdna-share-btn sdna-reveal" style={{ animationDelay: "1s" }}
                    disabled={styleDnaShareLoading}
                    onClick={async (e) => {
                      e.stopPropagation();
                      setStyleDnaShareLoading(true);
                      try {
                        const cardUrl = await generateStyleDnaCard(styleDna, authName);
                        if (navigator.share) {
                          const blob = await (await fetch(cardUrl)).blob();
                          const file = new File([blob], "style-dna.png", { type: "image/png" });
                          await navigator.share({ files: [file], title: "My Style DNA \u2014 ATTAIR" });
                        } else {
                          const a = document.createElement("a");
                          a.href = cardUrl;
                          a.download = "style-dna.png";
                          a.click();
                        }
                      } catch {}
                      setStyleDnaShareLoading(false);
                    }}>
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M4 12v8a2 2 0 002 2h12a2 2 0 002-2v-8"/><polyline points="16 6 12 2 8 6"/><line x1="12" y1="2" x2="12" y2="15"/></svg>
                    {styleDnaShareLoading ? "Generating..." : "Share Your Style DNA"}
                  </button>
                  <div className="sdna-count sdna-reveal" style={{ animationDelay: "1.1s" }}>
                    Based on {stats.total_scans || 0} scans
                  </div>
                </div>
              )}

              {/* Tap hint (not on final slide) */}
              {slide < TOTAL_SLIDES - 1 && (
                <div className="sdna-tap sdna-reveal" style={{ animationDelay: "1.5s" }}>
                  Tap to continue
                </div>
              )}
            </div>
          </div>
        );
      })()}

      {/* ═══ STYLE CHALLENGE DETAIL OVERLAY ═══════════════════════ */}
      {activeChallengeDetail && (
        <div style={{ position: "fixed", inset: 0, zIndex: 9997, background: "var(--bg-primary)", overflowY: "auto" }}>
          {/* Header */}
          <div style={{ position: "sticky", top: 0, zIndex: 1, background: "var(--bg-primary)", borderBottom: "1px solid var(--border)", padding: "12px 16px", display: "flex", alignItems: "center", gap: 12 }}>
            <button onClick={() => setActiveChallengeDetail(null)} style={{ background: "none", border: "none", cursor: "pointer", padding: 8, minHeight: 44, minWidth: 44, display: "flex", alignItems: "center", justifyContent: "center" }}>
              <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="var(--text-primary)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
            </button>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 16, fontWeight: 700, color: "var(--text-primary)" }}>{activeChallengeDetail.title}</div>
              <div style={{ fontSize: 11, color: "var(--text-tertiary)" }}>{activeChallengeDetail.description}</div>
            </div>
            <div style={{ fontSize: 10, fontWeight: 700, color: activeChallengeDetail.status === "voting" ? "#C77DFF" : activeChallengeDetail.status === "completed" ? "#5AC8A0" : "var(--accent)", padding: "4px 10px", borderRadius: 100, background: activeChallengeDetail.status === "voting" ? "rgba(199,125,255,.1)" : activeChallengeDetail.status === "completed" ? "rgba(90,200,160,.1)" : "rgba(201,169,110,.1)", textTransform: "uppercase", letterSpacing: .5 }}>
              {activeChallengeDetail.status}
            </div>
          </div>

          {/* Submit button */}
          {activeChallengeDetail.status === "active" && !activeChallengeDetail.submissions?.some(s => s.user_id === (activeChallengeDetail._userId || "")) && (
            <div style={{ padding: "16px" }}>
              <button onClick={() => {
                // Open scan sheet to submit — user scans an outfit, then submits
                // For now, use the most recent scan
                const recentScan = history[0];
                if (recentScan?.image_url) {
                  API.submitChallenge(activeChallengeDetail.id, recentScan.image_url, recentScan.summary || "", recentScan.id)
                    .then(d => {
                      if (d.success) {
                        // Refresh challenge
                        API.getChallenge(activeChallengeDetail.id).then(r => setActiveChallengeDetail(r.data)).catch(() => {});
                      }
                    }).catch(() => {});
                } else {
                  // No scans yet — prompt to scan first
                  setActiveChallengeDetail(null);
                  setTab("scan");
                }
              }} style={{ width: "100%", padding: "14px 0", background: "linear-gradient(135deg, #C9A96E, #C77DFF)", border: "none", borderRadius: 12, fontSize: 14, fontWeight: 700, color: "#fff", cursor: "pointer", fontFamily: "var(--font-sans)" }}>
                Submit Your Look
              </button>
            </div>
          )}

          {/* Submissions grid */}
          <div style={{ padding: "0 12px 100px" }}>
            <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: 1.5, color: "var(--text-tertiary)", textTransform: "uppercase", padding: "12px 4px 8px" }}>
              {(activeChallengeDetail.submissions || []).length} Entries
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
              {(activeChallengeDetail.submissions || []).map((sub, si) => {
                const u = sub.user || {};
                const ini = (u.display_name || "?").split(" ").map(w => w[0]).join("").slice(0, 2).toUpperCase();
                const isWinner = activeChallengeDetail.winner_id === sub.user_id && activeChallengeDetail.status === "completed";
                return (
                  <div key={sub.id} style={{ background: "var(--bg-card)", border: isWinner ? "2px solid var(--accent)" : "1px solid var(--border)", borderRadius: 14, overflow: "hidden" }}>
                    <div style={{ position: "relative" }}>
                      <img src={sub.image_url} alt="" style={{ width: "100%", aspectRatio: "3/4", objectFit: "cover" }} loading="lazy" />
                      {si === 0 && activeChallengeDetail.status !== "active" && (
                        <div style={{ position: "absolute", top: 8, left: 8, padding: "3px 8px", borderRadius: 100, background: "rgba(201,169,110,.9)", fontSize: 9, fontWeight: 700, color: "#fff" }}>
                          {isWinner ? "WINNER" : "#1"}
                        </div>
                      )}
                      {sub.ai_verified && (
                        <div style={{ position: "absolute", top: 8, right: 8, width: 20, height: 20, borderRadius: "50%", background: "rgba(90,200,160,.9)", display: "flex", alignItems: "center", justifyContent: "center" }}>
                          <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="#fff" strokeWidth="3"><polyline points="20 6 9 17 4 12"/></svg>
                        </div>
                      )}
                    </div>
                    <div style={{ padding: "8px 10px" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
                        <div style={{ width: 20, height: 20, borderRadius: "50%", background: "var(--accent)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 8, fontWeight: 700, color: "var(--text-inverse)" }}>{ini}</div>
                        <span style={{ fontSize: 11, fontWeight: 600, color: "var(--text-primary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{u.display_name || "Anonymous"}</span>
                        {(u.challenge_wins || 0) > 0 && <span style={{ fontSize: 8, fontWeight: 700, padding: "1px 4px", borderRadius: 3, background: "rgba(201,169,110,.12)", color: "var(--accent)" }}>{u.challenge_wins}x</span>}
                      </div>
                      {sub.caption && <div style={{ fontSize: 10, color: "var(--text-tertiary)", marginBottom: 6, overflow: "hidden", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical" }}>{sub.caption}</div>}
                      <button
                        onClick={() => {
                          if (sub.user_voted) {
                            API.unvoteChallenge(activeChallengeDetail.id, sub.id).then(() => {
                              setActiveChallengeDetail(prev => ({
                                ...prev,
                                submissions: prev.submissions.map(s => s.id === sub.id ? { ...s, vote_count: Math.max(0, s.vote_count - 1), user_voted: false } : s),
                              }));
                            }).catch(() => {});
                          } else {
                            API.voteChallenge(activeChallengeDetail.id, sub.id).then(() => {
                              setActiveChallengeDetail(prev => ({
                                ...prev,
                                submissions: prev.submissions.map(s => s.id === sub.id ? { ...s, vote_count: s.vote_count + 1, user_voted: true } : s),
                              }));
                            }).catch(() => {});
                          }
                        }}
                        style={{ width: "100%", display: "flex", alignItems: "center", justifyContent: "center", gap: 4, padding: "6px 0", background: sub.user_voted ? "rgba(201,169,110,.15)" : "var(--bg-input)", border: `1px solid ${sub.user_voted ? "var(--accent)" : "var(--border)"}`, borderRadius: 8, cursor: "pointer", fontFamily: "var(--font-sans)" }}
                      >
                        <svg viewBox="0 0 24 24" width="14" height="14" fill={sub.user_voted ? "var(--accent)" : "none"} stroke={sub.user_voted ? "var(--accent)" : "var(--text-tertiary)"} strokeWidth="2"><path d="M14 9V5a3 3 0 0 0-3-3l-4 9v11h11.28a2 2 0 0 0 2-1.7l1.38-9a2 2 0 0 0-2-2.3zM7 22H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3"/></svg>
                        <span style={{ fontSize: 12, fontWeight: 600, color: sub.user_voted ? "var(--accent)" : "var(--text-secondary)" }}>{sub.vote_count}</span>
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
            {(activeChallengeDetail.submissions || []).length === 0 && (
              <div style={{ textAlign: "center", padding: "40px 20px", color: "var(--text-tertiary)" }}>
                <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>No entries yet</div>
                <div style={{ fontSize: 12 }}>Be the first to submit!</div>
              </div>
            )}
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
      {/* ─── Wishlist Picker Modal ─── */}
      {wishlistPickerScan && (
        <div style={{ position: "fixed", inset: 0, zIndex: 9999, display: "flex", alignItems: "flex-end", justifyContent: "center" }} onClick={() => { setWishlistPickerScan(null); setNewWishlistName(""); }}>
          <div style={{ position: "absolute", inset: 0, background: "rgba(0,0,0,.6)", backdropFilter: "blur(4px)" }} />
          <div style={{ position: "relative", width: "100%", maxWidth: 400, background: "var(--bg-secondary)", borderRadius: "20px 20px 0 0", padding: "20px 20px 32px", maxHeight: "60vh", overflowY: "auto" }} onClick={e => e.stopPropagation()}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
              <div style={{ fontSize: 16, fontWeight: 700, color: "var(--text-primary)" }}>Add to Collection</div>
              <button onClick={() => { setWishlistPickerScan(null); setNewWishlistName(""); }} style={{ background: "none", border: "none", color: "var(--text-tertiary)", fontSize: 20, cursor: "pointer", padding: 8, minHeight: 44, minWidth: 44, display: "flex", alignItems: "center", justifyContent: "center" }}>&times;</button>
            </div>
            {wishlists.length > 0 && wishlists.map(wl => (
              <button key={wl.id} onClick={async () => {
                const itemId = wishlistPickerScan.id;
                if (itemId) {
                  await API.addToWishlist(wl.id, itemId).catch(() => {});
                  setAddToListConfirm({ savedItemId: itemId, wishlistName: wl.name });
                  setTimeout(() => setAddToListConfirm(null), 2000);
                  // Instant refresh
                  API.getWishlists().then(w => setWishlists(w.wishlists || [])).catch(() => {});
                  API.getSaved().then(s => setSaved(s.items || [])).catch(() => {});
                }
                setWishlistPickerScan(null);
              }} style={{ width: "100%", display: "flex", alignItems: "center", gap: 12, padding: "14px 16px", background: "var(--bg-card)", border: "1px solid var(--border)", borderRadius: 12, cursor: "pointer", marginBottom: 8, minHeight: 48 }}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg>
                <span style={{ fontSize: 14, fontWeight: 600, color: "var(--text-primary)" }}>{wl.name}</span>
              </button>
            ))}
            <div style={{ display: "flex", gap: 8, marginTop: wishlists.length > 0 ? 8 : 0 }}>
              <input
                value={newWishlistName}
                onChange={e => setNewWishlistName(e.target.value)}
                placeholder="New wishlist name..."
                style={{ flex: 1, padding: "12px 14px", background: "var(--bg-input)", border: "1px solid var(--border)", borderRadius: 10, color: "var(--text-primary)", fontFamily: "var(--font-sans)", fontSize: 14, outline: "none", minHeight: 44 }}
                onKeyDown={e => {
                  if (e.key === "Enter" && newWishlistName.trim()) {
                    API.createWishlist(newWishlistName.trim()).then(async d => {
                      if (d?.wishlist) {
                        setWishlists(prev => [...prev, d.wishlist]);
                        const itemId = wishlistPickerScan.id;
                        if (itemId) await API.addToWishlist(d.wishlist.id, itemId).catch(() => {});
                        setAddToListConfirm({ savedItemId: itemId, wishlistName: d.wishlist.name });
                        setTimeout(() => setAddToListConfirm(null), 2000);
                        // Instant refresh: re-fetch wishlists + saved items
                        API.getWishlists().then(w => setWishlists(w.wishlists || [])).catch(() => {});
                        API.getSaved().then(s => setSaved(s.items || [])).catch(() => {});
                      }
                      setWishlistPickerScan(null);
                      setNewWishlistName("");
                    }).catch(() => {});
                  }
                }}
              />
              <button
                disabled={!newWishlistName.trim()}
                onClick={() => {
                  if (!newWishlistName.trim()) return;
                  API.createWishlist(newWishlistName.trim()).then(async d => {
                    if (d?.wishlist) {
                      setWishlists(prev => [...prev, d.wishlist]);
                      const itemId = wishlistPickerScan.id;
                      if (itemId) await API.addToWishlist(d.wishlist.id, itemId).catch(() => {});
                      setAddToListConfirm({ savedItemId: itemId, wishlistName: d.wishlist.name });
                      setTimeout(() => setAddToListConfirm(null), 2000);
                      // Instant refresh: re-fetch wishlists + saved items
                      API.getWishlists().then(w => setWishlists(w.wishlists || [])).catch(() => {});
                      API.getSaved().then(s => setSaved(s.items || [])).catch(() => {});
                    }
                    setWishlistPickerScan(null);
                    setNewWishlistName("");
                  }).catch(() => {});
                }}
                style={{ padding: "12px 18px", background: newWishlistName.trim() ? "var(--accent)" : "var(--bg-input)", color: newWishlistName.trim() ? "#000" : "var(--text-tertiary)", border: "none", borderRadius: 10, fontWeight: 700, fontSize: 13, cursor: newWishlistName.trim() ? "pointer" : "default", fontFamily: "var(--font-sans)", minHeight: 44, transition: "all .2s" }}
              >Create</button>
            </div>
          </div>
        </div>
      )}

      {/* ═══ Wishlist Edit Action Sheet ═══════════════════════════ */}
      {wishlistEditOpen && wishlistEditId && (
        <div style={{ position: "fixed", inset: 0, zIndex: 9999, display: "flex", alignItems: "flex-end", justifyContent: "center" }} onClick={() => { setWishlistEditOpen(false); setWishlistRenaming(false); }}>
          <div style={{ position: "absolute", inset: 0, background: "rgba(0,0,0,.6)", backdropFilter: "blur(4px)" }} />
          <div style={{ position: "relative", width: "100%", maxWidth: 400, background: "var(--bg-secondary)", borderRadius: "20px 20px 0 0", padding: "20px 20px 32px", animation: "slideUp .25s ease" }} onClick={e => e.stopPropagation()}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
              <div style={{ fontSize: 16, fontWeight: 700, color: "var(--text-primary)" }}>Edit Collection</div>
              <button onClick={() => { setWishlistEditOpen(false); setWishlistRenaming(false); }} style={{ background: "none", border: "none", color: "var(--text-tertiary)", fontSize: 20, cursor: "pointer", padding: 8, minHeight: 44, minWidth: 44, display: "flex", alignItems: "center", justifyContent: "center" }}>&times;</button>
            </div>
            {wishlistRenaming ? (
              <div style={{ display: "flex", gap: 8 }}>
                <input
                  autoFocus
                  value={wishlistEditName}
                  onChange={e => setWishlistEditName(e.target.value)}
                  placeholder="List name..."
                  style={{ flex: 1, padding: "12px 14px", background: "var(--bg-input)", border: "1px solid var(--border)", borderRadius: 10, color: "var(--text-primary)", fontFamily: "var(--font-sans)", fontSize: 14, outline: "none", minHeight: 44 }}
                  onKeyDown={async e => {
                    if (e.key === "Enter" && wishlistEditName.trim()) {
                      await API.renameWishlist(wishlistEditId, wishlistEditName.trim()).catch(() => {});
                      setWishlists(prev => prev.map(wl => wl.id === wishlistEditId ? { ...wl, name: wishlistEditName.trim() } : wl));
                      if (activeWishlist?.id === wishlistEditId) setActiveWishlist(prev => ({ ...prev, name: wishlistEditName.trim() }));
                      setWishlistEditOpen(false);
                      setWishlistRenaming(false);
                    }
                  }}
                />
                <button
                  disabled={!wishlistEditName.trim()}
                  onClick={async () => {
                    if (!wishlistEditName.trim()) return;
                    await API.renameWishlist(wishlistEditId, wishlistEditName.trim()).catch(() => {});
                    setWishlists(prev => prev.map(wl => wl.id === wishlistEditId ? { ...wl, name: wishlistEditName.trim() } : wl));
                    if (activeWishlist?.id === wishlistEditId) setActiveWishlist(prev => ({ ...prev, name: wishlistEditName.trim() }));
                    setWishlistEditOpen(false);
                    setWishlistRenaming(false);
                  }}
                  style={{ padding: "12px 18px", background: wishlistEditName.trim() ? "var(--accent)" : "var(--bg-input)", color: wishlistEditName.trim() ? "#000" : "var(--text-tertiary)", border: "none", borderRadius: 10, fontWeight: 700, fontSize: 13, cursor: wishlistEditName.trim() ? "pointer" : "default", fontFamily: "var(--font-sans)", minHeight: 44, transition: "all .2s" }}
                >Save</button>
              </div>
            ) : (
              <>
                <button onClick={() => setWishlistRenaming(true)} style={{ width: "100%", display: "flex", alignItems: "center", gap: 12, padding: "14px 16px", background: "var(--bg-card)", border: "1px solid var(--border)", borderRadius: 12, cursor: "pointer", marginBottom: 8, minHeight: 48 }}>
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--text-secondary)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
                  <span style={{ fontSize: 14, fontWeight: 600, color: "var(--text-primary)" }}>Rename</span>
                </button>
                <button onClick={async () => {
                  if (!confirm("Delete this collection? Items will be kept in your wardrobe.")) return;
                  await API.deleteWishlist(wishlistEditId).catch(() => {});
                  setWishlists(prev => prev.filter(wl => wl.id !== wishlistEditId));
                  if (activeWishlist?.id === wishlistEditId) setActiveWishlist(null);
                  setWishlistEditOpen(false);
                }} style={{ width: "100%", display: "flex", alignItems: "center", gap: 12, padding: "14px 16px", background: "var(--bg-card)", border: "1px solid rgba(255,59,48,.2)", borderRadius: 12, cursor: "pointer", marginBottom: 8, minHeight: 48 }}>
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#FF3B30" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
                  <span style={{ fontSize: 14, fontWeight: 600, color: "#FF3B30" }}>Delete Collection</span>
                </button>
              </>
            )}
          </div>
        </div>
      )}

      {/* ═══ Share Bottom Sheet ═══════════════════════════════════ */}
      {showShareSheet && scanId && (
        <div style={{ position: "fixed", inset: 0, zIndex: 9999, background: "rgba(0,0,0,.55)", backdropFilter: "blur(6px)" }}
          onClick={(e) => { if (e.target === e.currentTarget) setShowShareSheet(false); }}>
          <div style={{
            position: "absolute", bottom: 0, left: 0, right: 0,
            background: "var(--bg-card, #1A1A1C)", borderRadius: "20px 20px 0 0",
            padding: "20px 20px 36px", maxWidth: 430, margin: "0 auto",
            animation: "slideUp .25s ease",
          }}>
            {/* Header */}
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20 }}>
              <div style={{ fontSize: 16, fontWeight: 700, color: "var(--text-primary)", fontFamily: "var(--font-sans)" }}>Share This Look</div>
              <button onClick={() => setShowShareSheet(false)} style={{ background: "none", border: "none", color: "var(--text-tertiary)", fontSize: 22, cursor: "pointer", padding: 6, minWidth: 36, minHeight: 36 }}>&times;</button>
            </div>

            {/* Share options grid */}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 16, marginBottom: 20 }}>
              {/* Copy Link */}
              <button onClick={async () => {
                const shareUrl = `${API_BASE}/share/${scanId}`;
                try {
                  await navigator.clipboard.writeText(shareUrl);
                  setShareLinkCopied(true);
                  setTimeout(() => setShareLinkCopied(false), 2000);
                  track("share_link", { method: "clipboard" }, scanId, "scan");
                } catch {}
              }} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 8, background: "none", border: "none", cursor: "pointer" }}>
                <div style={{ width: 52, height: 52, borderRadius: 14, background: "var(--bg-input)", border: "1px solid var(--border)", display: "flex", alignItems: "center", justifyContent: "center" }}>
                  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="var(--text-secondary)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
                </div>
                <span style={{ fontSize: 11, color: shareLinkCopied ? "var(--accent)" : "var(--text-tertiary)", fontWeight: 600, fontFamily: "var(--font-sans)" }}>{shareLinkCopied ? "Copied!" : "Copy Link"}</span>
              </button>

              {/* Text / Native Share */}
              <button onClick={async () => {
                const shareUrl = `${API_BASE}/share/${scanId}`;
                const shareData = { title: "ATTAIR - Check out this outfit", text: results?.summary || "Check out this outfit I scanned on ATTAIR!", url: shareUrl };
                if (navigator.share) {
                  try { await navigator.share(shareData); track("share_link", { method: "native" }, scanId, "scan"); } catch {}
                } else {
                  try { await navigator.clipboard.writeText(shareUrl); setShareLinkCopied(true); setTimeout(() => setShareLinkCopied(false), 2000); } catch {}
                }
                setShowShareSheet(false);
              }} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 8, background: "none", border: "none", cursor: "pointer" }}>
                <div style={{ width: 52, height: 52, borderRadius: 14, background: "var(--bg-input)", border: "1px solid var(--border)", display: "flex", alignItems: "center", justifyContent: "center" }}>
                  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="var(--text-secondary)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
                </div>
                <span style={{ fontSize: 11, color: "var(--text-tertiary)", fontWeight: 600, fontFamily: "var(--font-sans)" }}>Text</span>
              </button>

              {/* Instagram */}
              <button onClick={async () => {
                const shareUrl = `${API_BASE}/share/${scanId}`;
                if (navigator.share) {
                  try { await navigator.share({ title: "Check out this look on ATTAIR", url: shareUrl }); track("share_link", { method: "instagram" }, scanId, "scan"); } catch {}
                } else {
                  try { await navigator.clipboard.writeText(shareUrl); setShareLinkCopied(true); setTimeout(() => setShareLinkCopied(false), 2000); } catch {}
                }
                setShowShareSheet(false);
              }} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 8, background: "none", border: "none", cursor: "pointer" }}>
                <div style={{ width: 52, height: 52, borderRadius: 14, background: "linear-gradient(135deg, #833AB4, #FD1D1D, #F77737)", display: "flex", alignItems: "center", justifyContent: "center" }}>
                  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="2" width="20" height="20" rx="5"/><circle cx="12" cy="12" r="5"/><circle cx="17.5" cy="6.5" r="1.5" fill="#fff" stroke="none"/></svg>
                </div>
                <span style={{ fontSize: 11, color: "var(--text-tertiary)", fontWeight: 600, fontFamily: "var(--font-sans)" }}>Instagram</span>
              </button>

              {/* TikTok */}
              <button onClick={async () => {
                const shareUrl = `${API_BASE}/share/${scanId}`;
                if (navigator.share) {
                  try { await navigator.share({ title: "Check out this look on ATTAIR", url: shareUrl }); track("share_link", { method: "tiktok" }, scanId, "scan"); } catch {}
                } else {
                  try { await navigator.clipboard.writeText(shareUrl); setShareLinkCopied(true); setTimeout(() => setShareLinkCopied(false), 2000); } catch {}
                }
                setShowShareSheet(false);
              }} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 8, background: "none", border: "none", cursor: "pointer" }}>
                <div style={{ width: 52, height: 52, borderRadius: 14, background: "#010101", border: "1px solid #333", display: "flex", alignItems: "center", justifyContent: "center" }}>
                  <svg width="20" height="22" viewBox="0 0 20 22" fill="#fff"><path d="M17.2 5.5a4.5 4.5 0 0 1-3-1.3 4.5 4.5 0 0 1-1.1-3h-3v12.8a2.8 2.8 0 0 1-2.8 2.7 2.8 2.8 0 0 1-2.8-2.8 2.8 2.8 0 0 1 2.8-2.8c.3 0 .6 0 .8.1V8a5.9 5.9 0 0 0-.9-.1 5.8 5.8 0 0 0-5.8 5.9A5.8 5.8 0 0 0 7.3 20a5.8 5.8 0 0 0 5.8-5.9V7.8A7.5 7.5 0 0 0 17.5 9V6a4.5 4.5 0 0 1-.3-.5z"/></svg>
                </div>
                <span style={{ fontSize: 11, color: "var(--text-tertiary)", fontWeight: 600, fontFamily: "var(--font-sans)" }}>TikTok</span>
              </button>
            </div>

            {/* Second row */}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 16, marginBottom: 24 }}>
              {/* Snapchat */}
              <button onClick={async () => {
                const shareUrl = `${API_BASE}/share/${scanId}`;
                if (navigator.share) {
                  try { await navigator.share({ title: "Check out this look on ATTAIR", url: shareUrl }); track("share_link", { method: "snapchat" }, scanId, "scan"); } catch {}
                } else {
                  try { await navigator.clipboard.writeText(shareUrl); setShareLinkCopied(true); setTimeout(() => setShareLinkCopied(false), 2000); } catch {}
                }
                setShowShareSheet(false);
              }} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 8, background: "none", border: "none", cursor: "pointer" }}>
                <div style={{ width: 52, height: 52, borderRadius: 14, background: "#FFFC00", display: "flex", alignItems: "center", justifyContent: "center" }}>
                  <svg width="22" height="22" viewBox="0 0 24 24" fill="#000"><path d="M12 2C6.5 2 3 5.7 3 9.5c0 1.8.8 3.4 2 4.7-.2.8-.7 2.2-1.5 3 0 0 2.2-.3 3.7-1.5.6.2 1.2.3 1.8.3h.2c-.1-.3-.1-.7-.1-1 0-3.3 2.7-6 6-6s6 2.7 6 6c0 .3 0 .7-.1 1h.2c.6 0 1.2-.1 1.8-.3 1.5 1.2 3.7 1.5 3.7 1.5-.8-.8-1.3-2.2-1.5-3 1.2-1.3 2-2.9 2-4.7C21 5.7 17.5 2 12 2z"/></svg>
                </div>
                <span style={{ fontSize: 11, color: "var(--text-tertiary)", fontWeight: 600, fontFamily: "var(--font-sans)" }}>Snapchat</span>
              </button>

              {/* Share Card (image) */}
              <button disabled={shareCardLoading} onClick={async () => {
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
                    try { await navigator.share({ title: "My ATTAIR Outfit", files: [file] }); track("share_card", { method: "native" }, scanId, "scan"); } catch {}
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
                setShowShareSheet(false);
              }} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 8, background: "none", border: "none", cursor: "pointer", opacity: shareCardLoading ? 0.5 : 1 }}>
                <div style={{ width: 52, height: 52, borderRadius: 14, background: "var(--bg-input)", border: "1px solid var(--border)", display: "flex", alignItems: "center", justifyContent: "center" }}>
                  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="var(--text-secondary)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
                </div>
                <span style={{ fontSize: 11, color: "var(--text-tertiary)", fontWeight: 600, fontFamily: "var(--font-sans)" }}>{shareCardLoading ? "Creating..." : "Share Card"}</span>
              </button>

              {/* Create Reel (Pro-only) — hidden if browser doesn't support MediaRecorder */}
              {reelSupported && (
              <button disabled={reelGenerating} onClick={async () => {
                if (!isPro) {
                  setShowShareSheet(false);
                  setUpgradeModal("general");
                  return;
                }
                setReelGenerating(true);
                setReelProgress(0);
                setReelError(null);
                track("reel_started", {}, scanId, "scan");
                try {
                  const userName = authName || (authEmail ? authEmail.split("@")[0] : "");
                  const reelData = await generateScanReel({
                    imageUrl: img,
                    summary: results?.summary,
                    items: results?.items?.filter((_, idx) => pickedItems.has(idx)),
                    verdict: scanVerdicts[scanId],
                    userName,
                  });
                  setReelResult(reelData);
                  setShowShareSheet(false);
                  setShowReelPreview(true);
                  track("reel_generated", { size: reelData.blob.size }, scanId, "scan");
                } catch (e) {
                  console.error("Reel generation failed:", e);
                  setReelError("Reel creation failed — your browser may not support video recording. Try Chrome or Safari.");
                  setShowShareSheet(false);
                }
                setReelGenerating(false);
                setReelProgress(100);
              }} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 8, background: "none", border: "none", cursor: "pointer", opacity: reelGenerating ? 0.5 : 1, position: "relative" }}>
                <div style={{
                  width: 52, height: 52, borderRadius: 14, position: "relative", overflow: "hidden",
                  background: isPro ? "linear-gradient(135deg, #C9A96E, #E8D5A3)" : "var(--bg-input)",
                  border: isPro ? "none" : "1px solid var(--border)",
                  display: "flex", alignItems: "center", justifyContent: "center",
                }}>
                  {reelGenerating ? (
                    <div style={{ width: 22, height: 22, border: "2.5px solid rgba(0,0,0,0.2)", borderTopColor: "#000", borderRadius: "50%", animation: "spin .7s linear infinite" }} />
                  ) : (
                    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke={isPro ? "#000" : "var(--text-secondary)"} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2"/></svg>
                  )}
                </div>
                <span style={{ fontSize: 11, color: isPro ? "var(--accent)" : "var(--text-tertiary)", fontWeight: 600, fontFamily: "var(--font-sans)" }}>
                  {reelGenerating ? "Creating..." : "Create Reel"}
                </span>
                {!isPro && (
                  <span style={{
                    position: "absolute", top: -2, right: -2, fontSize: 8, fontWeight: 800,
                    background: "var(--accent)", color: "#000", padding: "2px 5px", borderRadius: 6,
                    letterSpacing: 0.5, fontFamily: "var(--font-sans)",
                  }}>PRO</span>
                )}
              </button>
              )}
            </div>

            {/* Link preview */}
            <div style={{ background: "var(--bg-input)", border: "1px solid var(--border)", borderRadius: 12, padding: "12px 14px", display: "flex", alignItems: "center", gap: 10 }}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--text-tertiary)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>
              <div style={{ flex: 1, fontSize: 12, color: "var(--text-tertiary)", fontFamily: "var(--font-sans)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {window.location.origin}/scan/{scanId?.slice(0, 8)}...
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ═══ Scan-to-Reel Video Preview Modal ═══════════════════ */}
      {showReelPreview && reelResult && (
        <div className="reel-preview-overlay" onClick={(e) => { if (e.target === e.currentTarget) { setShowReelPreview(false); URL.revokeObjectURL(reelResult.url); setReelResult(null); } }}>
          <div className="reel-preview-container">
            {/* Header */}
            <div className="reel-preview-header">
              <button onClick={() => { setShowReelPreview(false); URL.revokeObjectURL(reelResult.url); setReelResult(null); }}
                className="reel-preview-close">&times;</button>
              <div className="reel-preview-title">Your Reel</div>
              <div style={{ width: 36 }} />
            </div>

            {/* Video player */}
            <div className="reel-preview-video-wrap">
              <video
                ref={reelVideoRef}
                src={reelResult.url}
                autoPlay
                loop
                muted
                playsInline
                className="reel-preview-video"
              />
              {/* TikTok/Reels format badge */}
              <div className="reel-format-badge">9:16</div>
            </div>

            {/* Action buttons */}
            <div className="reel-preview-actions">
              {/* Download */}
              <button className="reel-action-btn reel-action-download" onClick={() => {
                const a = document.createElement("a");
                a.href = reelResult.url;
                a.download = `attair-reel-${scanId?.slice(0, 8) || "scan"}.webm`;
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                track("reel_downloaded", {}, scanId, "scan");
              }}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                Save Video
              </button>

              {/* Share via native share API */}
              <button className="reel-action-btn reel-action-share" onClick={async () => {
                try {
                  const file = new File([reelResult.blob], `attair-reel.webm`, { type: reelResult.mimeType });
                  if (navigator.share && navigator.canShare?.({ files: [file] })) {
                    await navigator.share({ title: "My ATTAIR Outfit Reel", files: [file] });
                    track("reel_shared", { method: "native" }, scanId, "scan");
                  } else {
                    // Fallback: download
                    const a = document.createElement("a");
                    a.href = reelResult.url;
                    a.download = `attair-reel-${scanId?.slice(0, 8) || "scan"}.webm`;
                    document.body.appendChild(a);
                    a.click();
                    document.body.removeChild(a);
                    track("reel_shared", { method: "download_fallback" }, scanId, "scan");
                  }
                } catch (e) {
                  // User-cancel (AbortError) is not a real failure — silently ignore
                  if (e?.name === "AbortError") return;
                  console.error("Reel share failed:", e);
                  setReelError("Sharing failed — try downloading the video instead.");
                }
              }}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>
                Share
              </button>
            </div>

            {/* Tip text */}
            <div className="reel-preview-tip">
              Optimized for TikTok, Reels & Shorts
            </div>
          </div>
        </div>
      )}

      {/* Reel error toast — auto-dismisses after 4s, or tap × to close */}
      {reelError && (
        <div style={{
          position: "fixed", bottom: 140, left: "50%", transform: "translateX(-50%)", zIndex: 10001,
          background: "var(--error, #FF5252)", color: "#fff", padding: "12px 20px", borderRadius: 14,
          fontWeight: 700, fontSize: 13, fontFamily: "var(--font-sans)",
          boxShadow: "0 4px 24px rgba(0,0,0,.4)", animation: "slideUp .3s ease",
          display: "flex", alignItems: "center", gap: 8, maxWidth: "90vw", textAlign: "center",
        }}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>
          {reelError}
          <button onClick={() => setReelError(null)} style={{
            background: "none", border: "none", color: "#fff", cursor: "pointer",
            padding: "0 0 0 4px", fontSize: 18, lineHeight: 1, fontWeight: 700,
            opacity: 0.8, flexShrink: 0,
          }} aria-label="Dismiss error">&times;</button>
        </div>
      )}

      {/* Share auto-public toast */}
      {sharePublicToast && (
        <div style={{ position: "fixed", bottom: 140, left: "50%", transform: "translateX(-50%)", zIndex: 10000, background: "var(--accent)", color: "#000", padding: "10px 20px", borderRadius: 12, fontWeight: 700, fontSize: 13, fontFamily: "var(--font-sans)", boxShadow: "0 4px 20px rgba(0,0,0,.3)", animation: "slideUp .3s ease", display: "flex", alignItems: "center", gap: 6 }}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2a10 10 0 1 0 10 10A10 10 0 0 0 12 2z"/><path d="M12 6v6l4 2"/></svg>
          Link is now public
        </div>
      )}

      {/* Wishlist added confirmation toast */}
      {addToListConfirm && (
        <div style={{ position: "fixed", bottom: 100, left: "50%", transform: "translateX(-50%)", zIndex: 10000, background: "var(--accent)", color: "#000", padding: "10px 20px", borderRadius: 12, fontWeight: 700, fontSize: 13, fontFamily: "var(--font-sans)", boxShadow: "0 4px 20px rgba(0,0,0,.3)", animation: "slideUp .3s ease" }}>
          Added to {addToListConfirm.wishlistName}
        </div>
      )}
      {/* ═══ Hanger Test Fullscreen Overlay ═══ */}
      {hangerFullscreen && (
        <div className="hanger-overlay" style={{ position: "fixed", inset: 0, zIndex: 10001, background: "var(--bg-app, #0C0C0E)", display: "flex", flexDirection: "column", minHeight: "100vh", minHeight: "100dvh" }}>
          {/* Header */}
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 16px", paddingTop: "max(12px, env(safe-area-inset-top))" }}>
            <button onClick={() => setHangerFullscreen(false)} style={{ background: "none", border: "none", color: "var(--text-primary)", fontSize: 24, cursor: "pointer", padding: 4 }}>&#x2715;</button>
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{ fontSize: 15, fontWeight: 700, color: "var(--text-primary)" }}>Hanger Test</span>
              {hangerStreak?.current_streak > 0 && <span style={{ fontSize: 13, color: "#FFB74D" }}>&#128293; {hangerStreak.current_streak}</span>}
            </div>
            <button onClick={() => { setHangerHistoryOpen(true); API.hangerTestHistory(20, 0).then(d => setHangerHistory(d.history || [])).catch(() => {}); }} style={{ background: "none", border: "none", color: "var(--text-tertiary)", fontSize: 13, cursor: "pointer", padding: 4 }}>History</button>
          </div>

          {/* Progress dots */}
          <div style={{ display: "flex", justifyContent: "center", gap: 6, padding: "4px 0 12px" }}>
            {Array.from({ length: hangerOutfits.length || 5 }).map((_, i) => (
              <div key={i} style={{
                width: 8, height: 8, borderRadius: "50%", transition: "all .3s",
                background: i < hangerCurrentIndex ? "#C9A96E" : i === hangerCurrentIndex ? "#C9A96E" : "rgba(var(--text-rgb, 255,255,255),.15)",
                transform: i === hangerCurrentIndex ? "scale(1.3)" : "scale(1)",
                boxShadow: i === hangerCurrentIndex ? "0 0 6px rgba(201,169,110,.5)" : "none",
              }} />
            ))}
          </div>

          {/* Card stack area */}
          <div style={{ flex: "1 1 0%", position: "relative", overflow: "hidden", minHeight: 0 }}>
            {hangerCurrentIndex < hangerOutfits.length ? (
              <>
                {hangerOutfits.map((outfit, idx) => {
                  const isActive = idx === hangerCurrentIndex;
                  const isBehind1 = idx === hangerCurrentIndex + 1;
                  const isBehind2 = idx === hangerCurrentIndex + 2;
                  if (idx < hangerCurrentIndex || idx > hangerCurrentIndex + 2) return null;

                  const swipeDir = hangerSwipeX > 0 ? "wear" : hangerSwipeX < 0 ? "pass" : null;
                  const swipeProgress = Math.min(Math.abs(hangerSwipeX) / 150, 1);

                  return (
                    <div key={outfit.id} style={{
                      position: "absolute", inset: 0, margin: "0 16px",
                      borderRadius: 20, overflow: "hidden",
                      background: "var(--bg-card)", border: "1px solid var(--border)",
                      transform: isActive
                        ? `translateX(${hangerSwipeX}px) rotate(${hangerSwipeX * 0.04}deg)`
                        : `scale(${isBehind1 ? 0.95 : 0.9}) translateY(${isBehind1 ? 8 : 16}px)`,
                      transition: isActive && hangerSwipeX === 0 ? "transform .3s cubic-bezier(.4,0,.2,1)" : !isActive ? "transform .3s ease" : "none",
                      zIndex: 10 - (idx - hangerCurrentIndex),
                      pointerEvents: isActive ? "auto" : "none",
                      opacity: isBehind2 ? 0.6 : 1,
                    }}
                      onTouchStart={isActive ? (e) => { hangerTouchRef.current = { x: e.touches[0].clientX, y: e.touches[0].clientY, time: Date.now() }; } : undefined}
                      onTouchMove={isActive ? (e) => {
                        if (!hangerTouchRef.current) return;
                        const dx = e.touches[0].clientX - hangerTouchRef.current.x;
                        setHangerSwipeX(dx);
                      } : undefined}
                      onTouchEnd={isActive ? () => {
                        if (!hangerTouchRef.current) return;
                        if (Math.abs(hangerSwipeX) > 100) {
                          const verdict = hangerSwipeX > 0 ? "wear" : "pass";
                          setHangerSwipeX(hangerSwipeX > 0 ? 400 : -400);
                          handleHangerVote(verdict);
                        } else {
                          setHangerSwipeX(0);
                        }
                        hangerTouchRef.current = null;
                      } : undefined}
                    >
                      {/* Outfit image */}
                      <img src={outfit.image_url} alt="" style={{ width: "100%", height: "65%", objectFit: "cover", display: "block" }} onError={e => { e.target.style.display = "none"; }} />

                      {/* Swipe labels */}
                      {isActive && swipeDir === "wear" && (
                        <div style={{ position: "absolute", top: 40, left: 20, padding: "8px 20px", border: "3px solid #4CAF50", borderRadius: 8, fontSize: 24, fontWeight: 900, color: "#4CAF50", transform: "rotate(-15deg)", opacity: swipeProgress, letterSpacing: 2 }}>WEAR</div>
                      )}
                      {isActive && swipeDir === "pass" && (
                        <div style={{ position: "absolute", top: 40, right: 20, padding: "8px 20px", border: "3px solid #EF5350", borderRadius: 8, fontSize: 24, fontWeight: 900, color: "#EF5350", transform: "rotate(15deg)", opacity: swipeProgress, letterSpacing: 2 }}>PASS</div>
                      )}

                      {/* Info section */}
                      <div style={{ padding: "14px 18px", flex: 1 }}>
                        <div style={{ fontSize: 15, fontWeight: 600, color: "var(--text-primary)", lineHeight: 1.4, marginBottom: 8 }}>{outfit.description}</div>
                        {outfit.style_tags?.length > 0 && (
                          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                            {outfit.style_tags.slice(0, 4).map((tag, ti) => (
                              <span key={ti} style={{ fontSize: 11, padding: "4px 10px", borderRadius: 100, background: "rgba(201,169,110,.1)", color: "var(--accent)", fontWeight: 600 }}>{tag}</span>
                            ))}
                          </div>
                        )}

                        {/* Post-vote stats */}
                        {hangerVotes[outfit.id] && hangerStatsMap[outfit.id] && (
                          <div style={{ marginTop: 12, padding: "10px 0", borderTop: "1px solid var(--border)" }}>
                            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: "var(--text-tertiary)", marginBottom: 6 }}>
                              <span>&#128154; {hangerStatsMap[outfit.id].wear_pct}% would wear</span>
                              <span>{hangerStatsMap[outfit.id].total_votes} votes</span>
                            </div>
                            <div style={{ height: 6, borderRadius: 3, background: "rgba(239,83,80,.2)", overflow: "hidden" }}>
                              <div style={{ height: "100%", borderRadius: 3, background: "linear-gradient(90deg, #4CAF50, #66BB6A)", width: `${hangerStatsMap[outfit.id].wear_pct}%`, transition: "width .6s ease" }} />
                            </div>
                            {hangerTranche && hangerTranche.tranche_wear_pct != null && (
                              <div style={{ fontSize: 11, color: "var(--accent)", marginTop: 6, fontWeight: 600 }}>
                                {hangerTranche.tranche_wear_pct}% of {hangerTranche.tranche_archetype} voters agree
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </>
            ) : (
              /* Cadence complete screen */
              <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: "100%", padding: "0 32px", textAlign: "center" }}>
                <div style={{ fontSize: 48, marginBottom: 12 }}>&#10024;</div>
                <div style={{ fontSize: 24, fontWeight: 800, color: "var(--text-primary)", marginBottom: 8 }}>All Done!</div>
                {hangerStreak?.current_streak > 0 && (
                  <div style={{ fontSize: 16, color: "#FFB74D", marginBottom: 16 }}>&#128293; {hangerStreak.current_streak} day streak</div>
                )}
                {hangerTasteProfile && (
                  <div style={{ padding: 16, background: "var(--bg-card)", borderRadius: 14, border: "1px solid var(--border)", marginBottom: 16, width: "100%", maxWidth: 280 }}>
                    <div style={{ fontSize: 11, fontWeight: 700, color: "var(--text-tertiary)", letterSpacing: 1.2, textTransform: "uppercase", marginBottom: 4 }}>Your Taste</div>
                    <div style={{ fontSize: 18, fontWeight: 800, color: "var(--accent)", marginBottom: 8 }}>{hangerTasteProfile.archetype}</div>
                    {hangerTasteProfile.style_breakdown?.slice(0, 3).map((s, i) => (
                      <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                        <span style={{ fontSize: 11, color: "var(--text-secondary)", width: 70, textAlign: "right" }}>{s.style}</span>
                        <div style={{ flex: 1, height: 4, borderRadius: 2, background: "var(--border)" }}>
                          <div style={{ height: "100%", borderRadius: 2, background: "var(--accent)", width: `${s.pct}%`, transition: "width .5s" }} />
                        </div>
                        <span style={{ fontSize: 11, color: "var(--text-tertiary)", width: 30 }}>{s.pct}%</span>
                      </div>
                    ))}
                  </div>
                )}
                <button onClick={() => setHangerTasteProfileOpen(true)} style={{ padding: "12px 28px", borderRadius: 100, background: "var(--accent)", color: "#000", fontWeight: 700, fontSize: 14, border: "none", cursor: "pointer", marginBottom: 10 }}>View Taste Profile</button>
                <button onClick={() => { setHangerFullscreen(false); setTab("scan"); }} style={{ padding: "12px 28px", borderRadius: 100, background: "var(--bg-card)", color: "var(--text-primary)", fontWeight: 600, fontSize: 14, border: "1px solid var(--border)", cursor: "pointer" }}>Find Similar Items</button>
                <div style={{ fontSize: 12, color: "var(--text-tertiary)", marginTop: 16 }}>Next batch at midnight</div>
              </div>
            )}
          </div>

          {/* Bottom buttons (only when card is active and not yet voted) */}
          {hangerCurrentIndex < hangerOutfits.length && !hangerVotes[hangerOutfits[hangerCurrentIndex]?.id] && !hangerVoteAnim && (
            <div style={{ display: "flex", justifyContent: "center", gap: 24, padding: "16px 0 max(16px, env(safe-area-inset-bottom))" }}>
              <button className="hanger-btn-pass" onClick={() => { setHangerSwipeX(-400); handleHangerVote("pass"); }} style={{ width: 64, height: 64, borderRadius: "50%", border: "2px solid #EF5350", background: "rgba(239,83,80,.08)", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer" }}>
                <svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="#EF5350" strokeWidth="2.5" strokeLinecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
              </button>
              <button className="hanger-btn-wear" onClick={() => { setHangerSwipeX(400); handleHangerVote("wear"); }} style={{ width: 64, height: 64, borderRadius: "50%", border: "none", background: "linear-gradient(135deg, #C9A96E, #E8D5A8)", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", boxShadow: "0 4px 16px rgba(201,169,110,.3)" }}>
                <svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="#000" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>
              </button>
            </div>
          )}

          {/* Swipe hint */}
          {hangerCurrentIndex < hangerOutfits.length && !hangerVotes[hangerOutfits[hangerCurrentIndex]?.id] && (
            <div style={{ textAlign: "center", padding: "0 0 8px", fontSize: 11, color: "var(--text-tertiary)", opacity: 0.5 }}>Swipe right to wear, left to pass</div>
          )}
        </div>
      )}

      {/* ═══ Hanger Test Style Insight Modal ═══ */}
      {hangerInsight && (
        <div style={{ position: "fixed", inset: 0, zIndex: 10002, background: "rgba(0,0,0,.7)", backdropFilter: "blur(8px)", display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}
          onClick={() => setHangerInsight(null)}>
          <div className="animate-scale-in" onClick={e => e.stopPropagation()} style={{ width: "100%", maxWidth: 360, background: "var(--bg-card)", borderRadius: 24, padding: "28px 24px", border: "1px solid var(--accent-border)" }}>
            {hangerInsight.gated ? (
              <>
                <div style={{ textAlign: "center", marginBottom: 16 }}>
                  <div style={{ fontSize: 40, marginBottom: 8 }}>&#128274;</div>
                  <div style={{ fontSize: 18, fontWeight: 700, color: "var(--text-primary)" }}>Style Insight Locked</div>
                  <div style={{ fontSize: 13, color: "var(--text-secondary)", marginTop: 6, lineHeight: 1.5 }}>{hangerInsight.message}</div>
                </div>
                <button onClick={() => { setHangerInsight(null); setUpgradeModal("hanger_insight"); }} className="btn-primary" style={{ width: "100%", borderRadius: 14, padding: "14px 0" }}>Unlock with Pro</button>
                <button onClick={() => setHangerInsight(null)} className="btn-ghost" style={{ width: "100%", marginTop: 8 }}>Maybe later</button>
              </>
            ) : (
              <>
                <div style={{ textAlign: "center", marginBottom: 16 }}>
                  <div style={{ fontSize: 40, marginBottom: 8 }}>&#10024;</div>
                  <div style={{ fontSize: 18, fontWeight: 700, color: "var(--text-primary)" }}>Your Style Insight</div>
                  {hangerInsight.archetype && (
                    <div style={{ fontSize: 14, fontWeight: 600, color: "var(--accent)", marginTop: 4 }}>{hangerInsight.archetype}</div>
                  )}
                </div>
                <div style={{ fontSize: 14, color: "var(--text-secondary)", lineHeight: 1.6, marginBottom: 16, textAlign: "center" }}>
                  {hangerInsight.insight}
                </div>
                {hangerInsight.style_breakdown && (
                  <div style={{ marginBottom: 16 }}>
                    {hangerInsight.style_breakdown.map((s, i) => (
                      <div key={i} style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
                        <div style={{ width: 60, fontSize: 11, fontWeight: 600, color: "var(--text-secondary)", textTransform: "capitalize" }}>{s.style}</div>
                        <div style={{ flex: 1, height: 6, borderRadius: 3, background: "var(--bg-input)", overflow: "hidden" }}>
                          <div style={{ width: `${s.pct}%`, height: "100%", borderRadius: 3, background: i === 0 ? "var(--accent)" : i === 1 ? "rgba(201,169,110,.5)" : "rgba(201,169,110,.25)", transition: "width 0.8s ease" }} />
                        </div>
                        <div style={{ width: 30, fontSize: 11, fontWeight: 700, color: "var(--text-primary)", textAlign: "right" }}>{s.pct}%</div>
                      </div>
                    ))}
                  </div>
                )}
                {hangerInsight.favorite_vibes && (
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 6, justifyContent: "center", marginBottom: 12 }}>
                    {hangerInsight.favorite_vibes.map(v => (
                      <span key={v} style={{ fontSize: 10, fontWeight: 600, padding: "3px 10px", borderRadius: 100, background: "rgba(201,169,110,.1)", color: "var(--accent)", border: "1px solid rgba(201,169,110,.2)" }}>{v}</span>
                    ))}
                  </div>
                )}
                <button onClick={() => setHangerInsight(null)} className="btn-primary" style={{ width: "100%", borderRadius: 14, padding: "14px 0" }}>Nice!</button>
              </>
            )}
          </div>
        </div>
      )}

      {/* ═══ Hanger Test History Modal ═══ */}
      {hangerHistoryOpen && (
        <div style={{ position: "fixed", inset: 0, zIndex: 10001, background: "var(--bg-primary)", display: "flex", flexDirection: "column" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "max(env(safe-area-inset-top), 12px) 16px 12px", borderBottom: "1px solid var(--border)" }}>
            <button onClick={() => setHangerHistoryOpen(false)} style={{ background: "none", border: "none", color: "var(--text-primary)", fontSize: 13, cursor: "pointer", padding: "8px 4px", fontFamily: "var(--font-sans)" }}>
              <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" style={{ verticalAlign: -4, marginRight: 4 }}><path d="M19 12H5M12 19l-7-7 7-7"/></svg>
              Back
            </button>
            <div style={{ fontSize: 15, fontWeight: 700 }}>My Verdicts</div>
            <div style={{ width: 60 }} />
          </div>

          {/* Streak summary */}
          {hangerStreak && (
            <div style={{ display: "flex", justifyContent: "center", gap: 24, padding: "16px 20px", borderBottom: "1px solid var(--border)" }}>
              <div style={{ textAlign: "center" }}>
                <div style={{ fontSize: 20, fontWeight: 800, color: "var(--accent)" }}>{hangerStreak.current_streak || 0}</div>
                <div style={{ fontSize: 10, color: "var(--text-tertiary)" }}>Current</div>
              </div>
              <div style={{ textAlign: "center" }}>
                <div style={{ fontSize: 20, fontWeight: 800, color: "var(--text-primary)" }}>{hangerStreak.longest_streak || 0}</div>
                <div style={{ fontSize: 10, color: "var(--text-tertiary)" }}>Best</div>
              </div>
              <div style={{ textAlign: "center" }}>
                <div style={{ fontSize: 20, fontWeight: 800, color: "var(--text-primary)" }}>{hangerStreak.total_votes || 0}</div>
                <div style={{ fontSize: 10, color: "var(--text-tertiary)" }}>Total</div>
              </div>
              {hangerStreak.taste_badge && (
                <div style={{ textAlign: "center" }}>
                  <div style={{ fontSize: 20 }}>&#127942;</div>
                  <div style={{ fontSize: 10, color: "var(--text-tertiary)" }}>Badge</div>
                </div>
              )}
            </div>
          )}

          <div style={{ flex: 1, overflow: "auto", padding: "12px 12px 80px" }}>
            {hangerHistory.length === 0 ? (
              <div style={{ textAlign: "center", padding: "60px 20px" }}>
                <div style={{ fontSize: 13, color: "var(--text-tertiary)" }}>No votes yet. Start your streak!</div>
              </div>
            ) : (
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                {hangerHistory.map(h => (
                  <div key={h.id} style={{ borderRadius: 14, overflow: "hidden", background: "var(--bg-card)", border: "1px solid var(--border)" }}>
                    {h.outfit?.image_url && (
                      <div style={{ position: "relative", width: "100%", aspectRatio: "3/4", overflow: "hidden" }}>
                        <img src={h.outfit.image_url} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                        <div style={{ position: "absolute", top: 8, right: 8, padding: "3px 10px", borderRadius: 100, fontSize: 10, fontWeight: 700, background: h.verdict === "wear" ? "rgba(76,175,80,.85)" : "rgba(255,82,82,.85)", color: "#fff", backdropFilter: "blur(4px)" }}>
                          {h.verdict === "wear" ? "Wear" : "Pass"}
                        </div>
                        <div style={{ position: "absolute", bottom: 0, left: 0, right: 0, padding: "20px 10px 8px", background: "linear-gradient(transparent, rgba(0,0,0,.7))" }}>
                          {h.outfit.wear_pct != null && (
                            <div style={{ fontSize: 11, fontWeight: 600, color: "rgba(255,255,255,.8)" }}>{h.outfit.wear_pct}% would wear</div>
                          )}
                          <div style={{ fontSize: 10, color: "rgba(255,255,255,.5)", marginTop: 2 }}>{h.outfit.date}</div>
                        </div>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* ─── Taste Profile Modal ─────────────────────── */}
      {hangerTasteProfileOpen && (
        <div style={{ position: "fixed", inset: 0, zIndex: 10002, background: "var(--bg-app)", overflowY: "auto" }}>
          <div style={{ display: "flex", alignItems: "center", padding: "12px 16px", paddingTop: "max(12px, env(safe-area-inset-top))", borderBottom: "1px solid var(--border)" }}>
            <button onClick={() => setHangerTasteProfileOpen(false)} style={{ background: "none", border: "none", color: "var(--text-primary)", fontSize: 24, cursor: "pointer", padding: 4 }}>&#x2190;</button>
            <span style={{ flex: 1, textAlign: "center", fontSize: 15, fontWeight: 700, color: "var(--text-primary)" }}>Your Taste Profile</span>
            <div style={{ width: 32 }} />
          </div>

          <div style={{ padding: "24px 20px 80px" }}>
            {!hangerTasteProfile || !hangerTasteProfile.archetype ? (
              <div style={{ textAlign: "center", padding: "60px 20px" }}>
                <div style={{ fontSize: 40, marginBottom: 12 }}>&#128083;</div>
                <div style={{ fontSize: 18, fontWeight: 700, color: "var(--text-primary)", marginBottom: 8 }}>Keep Swiping!</div>
                <div style={{ fontSize: 14, color: "var(--text-tertiary)", lineHeight: 1.5 }}>Complete a few daily cadences to build your taste profile</div>
              </div>
            ) : (
              <>
                {/* Archetype hero */}
                <div style={{ textAlign: "center", marginBottom: 24 }}>
                  <div style={{ fontSize: 11, fontWeight: 700, color: "var(--text-tertiary)", letterSpacing: 1.5, textTransform: "uppercase", marginBottom: 6 }}>Your Style Archetype</div>
                  <div style={{ fontSize: 26, fontWeight: 800, color: "var(--accent)" }}>{hangerTasteProfile.archetype}</div>
                </div>

                {/* Style breakdown */}
                <div style={{ marginBottom: 24 }}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: "var(--text-primary)", marginBottom: 12 }}>Style Breakdown</div>
                  {(hangerTasteProfile.style_breakdown || []).map((s, i) => (
                    <div key={i} style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
                      <span style={{ fontSize: 13, color: "var(--text-secondary)", width: 90, textAlign: "right", textTransform: "capitalize" }}>{s.style}</span>
                      <div style={{ flex: 1, height: 8, borderRadius: 4, background: "var(--bg-input)" }}>
                        <div style={{ height: "100%", borderRadius: 4, background: i === 0 ? "var(--accent)" : "rgba(201,169,110,.4)", width: `${s.pct}%`, transition: "width .6s ease" }} />
                      </div>
                      <span style={{ fontSize: 13, fontWeight: 700, color: i === 0 ? "var(--accent)" : "var(--text-tertiary)", width: 40 }}>{s.pct}%</span>
                    </div>
                  ))}
                </div>

                {/* Wear rate */}
                <div style={{ padding: 16, background: "var(--bg-card)", borderRadius: 14, border: "1px solid var(--border)", marginBottom: 24, textAlign: "center" }}>
                  <div style={{ fontSize: 36, fontWeight: 800, color: "var(--accent)" }}>{hangerTasteProfile.wear_rate}%</div>
                  <div style={{ fontSize: 12, color: "var(--text-tertiary)" }}>of outfits you'd wear</div>
                  <div style={{ fontSize: 11, color: "var(--text-tertiary)", marginTop: 4 }}>Based on {hangerTasteProfile.total_votes} votes</div>
                </div>

                {/* Pro-gated sections */}
                {hangerTasteProfile.favorite_vibes && hangerTasteProfile.favorite_vibes.length > 0 && (
                  <div style={{ marginBottom: 20 }}>
                    <div style={{ fontSize: 13, fontWeight: 700, color: "var(--text-primary)", marginBottom: 8 }}>Vibes You Love</div>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                      {hangerTasteProfile.favorite_vibes.map((v, i) => (
                        <span key={i} style={{ fontSize: 12, padding: "6px 14px", borderRadius: 100, background: "rgba(76,175,80,.1)", color: "#66BB6A", fontWeight: 600 }}>{v}</span>
                      ))}
                    </div>
                  </div>
                )}

                {hangerTasteProfile.avoid_vibes && hangerTasteProfile.avoid_vibes.length > 0 && (
                  <div style={{ marginBottom: 20 }}>
                    <div style={{ fontSize: 13, fontWeight: 700, color: "var(--text-primary)", marginBottom: 8 }}>Not Your Thing</div>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                      {hangerTasteProfile.avoid_vibes.map((v, i) => (
                        <span key={i} style={{ fontSize: 12, padding: "6px 14px", borderRadius: 100, background: "rgba(239,83,80,.08)", color: "#EF5350", fontWeight: 600 }}>{v}</span>
                      ))}
                    </div>
                  </div>
                )}

                {hangerTasteProfile.is_pro_gated && (
                  <div style={{ padding: 20, background: "linear-gradient(135deg, rgba(201,169,110,.08), rgba(201,169,110,.03))", border: "1px solid rgba(201,169,110,.15)", borderRadius: 16, textAlign: "center" }}>
                    <div style={{ fontSize: 14, fontWeight: 700, color: "var(--text-primary)", marginBottom: 6 }}>Unlock Full Taste Profile</div>
                    <div style={{ fontSize: 12, color: "var(--text-tertiary)", lineHeight: 1.5, marginBottom: 12 }}>See your favorite vibes, styles to avoid, and deep analytics with Pro</div>
                    <button onClick={() => { setHangerTasteProfileOpen(false); setScreen("paywall"); }} style={{ padding: "12px 28px", borderRadius: 100, background: "var(--accent)", color: "#000", fontWeight: 700, fontSize: 14, border: "none", cursor: "pointer" }}>Go Pro</button>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      )}

    </div>
  </>);
}
