/**
 * Beli Reservation Monitor
 *
 * Polls the Beli API for new shared reservations and pushes notifications
 * to Jules's phone via Ntfy.
 *
 * Endpoints discovered via JS bundle analysis:
 *   POST https://backoffice-service-t57o3dxfca-nn.a.run.app/api/token/
 *     body: { email, password } → { access, refresh }
 *   GET  https://backoffice-service-t57o3dxfca-nn.a.run.app/api/reservation-posting/
 *     header: Authorization: Bearer {access}
 *     → paginated list of available reservations
 *   POST https://backoffice-service-t57o3dxfca-nn.a.run.app/api/token/refresh/
 *     body: { refresh } → { access }
 *
 * Required env vars:
 *   BELI_EMAIL             — Beli account email
 *   BELI_PASSWORD          — Beli account password
 *   NTFY_TOPIC             — Ntfy topic name (e.g. jules-beli-reservations)
 *   NTFY_URL               — Ntfy server URL (default: https://ntfy.sh)
 *   POLL_INTERVAL_MS       — How often to poll in ms (default: 60000 = 1 minute)
 *   SUPABASE_URL           — Supabase project URL
 *   SUPABASE_SERVICE_ROLE_KEY — Supabase service role key (for beli_seen_ids table)
 */

import 'dotenv/config';

const API_BASE = 'https://backoffice-service-t57o3dxfca-nn.a.run.app/api';
const NTFY_URL = process.env.NTFY_URL || 'https://ntfy.sh';
const NTFY_TOPIC = process.env.NTFY_TOPIC;
const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS || '60000', 10);
const BELI_EMAIL = process.env.BELI_EMAIL;
const BELI_PASSWORD = process.env.BELI_PASSWORD;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!BELI_EMAIL || !BELI_PASSWORD) {
  console.error('ERROR: BELI_EMAIL and BELI_PASSWORD are required');
  process.exit(1);
}
if (!NTFY_TOPIC) {
  console.error('ERROR: NTFY_TOPIC is required');
  process.exit(1);
}
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('ERROR: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required');
  process.exit(1);
}

// --- Supabase seen-IDs persistence ---
// Table: beli_seen_ids (id integer PRIMARY KEY, seen_at timestamptz DEFAULT now())

function sbFetch(path, opts = {}) {
  return fetch(`${SUPABASE_URL}/rest/v1${path}`, {
    ...opts,
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal',
      ...(opts.headers ?? {}),
    },
  });
}

async function loadSeenIds() {
  const res = await sbFetch('/beli_seen_ids?select=id');
  if (!res.ok) throw new Error(`Supabase load failed ${res.status}: ${await res.text()}`);
  const rows = await res.json();
  return new Set(rows.map(r => r.id));
}

async function markSeen(id) {
  const res = await sbFetch('/beli_seen_ids', {
    method: 'POST',
    headers: { Prefer: 'return=minimal,resolution=ignore-duplicates' },
    body: JSON.stringify({ id }),
  });
  if (!res.ok) {
    const body = await res.text();
    console.error(`[db] Failed to persist seen ID ${id}: ${body}`);
  }
}

// --- Auth state ---
let accessToken = null;
let refreshToken = null;
let tokenExpiry = 0; // epoch ms when access token expires

// JWT payload decoder (no signature verification needed — we trust our own server)
function decodeJwtExpiry(token) {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString());
    return payload.exp * 1000; // convert to ms
  } catch {
    return Date.now() + 4 * 60 * 1000; // fallback: treat as expiring in 4 min
  }
}

async function login() {
  console.log('[auth] Logging in...');
  const res = await fetch(`${API_BASE}/token/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: BELI_EMAIL, password: BELI_PASSWORD }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Login failed ${res.status}: ${body}`);
  }
  const data = await res.json();
  accessToken = data.access;
  refreshToken = data.refresh;
  tokenExpiry = decodeJwtExpiry(accessToken);
  console.log(`[auth] Logged in, token expires at ${new Date(tokenExpiry).toISOString()}`);
}

async function refreshAccessToken() {
  console.log('[auth] Refreshing token...');
  const res = await fetch(`${API_BASE}/token/refresh/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refresh: refreshToken }),
  });
  if (!res.ok) {
    console.warn('[auth] Refresh failed, re-logging in...');
    await login();
    return;
  }
  const data = await res.json();
  accessToken = data.access;
  if (data.refresh) refreshToken = data.refresh; // SimpleJWT may rotate refresh token
  tokenExpiry = decodeJwtExpiry(accessToken);
  console.log(`[auth] Token refreshed, expires at ${new Date(tokenExpiry).toISOString()}`);
}

async function ensureAuth() {
  if (!accessToken || !refreshToken) {
    await login();
    return;
  }
  // Refresh 2 minutes before expiry
  if (Date.now() >= tokenExpiry - 2 * 60 * 1000) {
    await refreshAccessToken();
  }
}

// --- Eligibility filter ---
// Parse time from display strings (e.g. "5:00 PM") — already in ET/NYC local time
function parseDisplayTime(timeStr) {
  const m = timeStr.match(/(\d+):(\d+)\s*(AM|PM)/i);
  if (!m) return null;
  let h = parseInt(m[1]), min = parseInt(m[2]);
  if (m[3].toUpperCase() === 'PM' && h !== 12) h += 12;
  if (m[3].toUpperCase() === 'AM' && h === 12) h = 0;
  return { h, min };
}

// Current ET date/time components
function nowET() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: 'numeric', minute: '2-digit', hour12: false,
  }).formatToParts(new Date());
  const get = type => parseInt(parts.find(p => p.type === type).value);
  return { year: get('year'), month: get('month') - 1, day: get('day'), h: get('hour'), min: get('minute') };
}

const JULES_TIER = 5; // Jules's Beli reservation sharing priority level

// VIP restaurants — bypass ALL filters (time, day, city, party size).
// Any POSTED reservation at these spots within Jules's tier notifies immediately.
// Matching is fuzzy/case-insensitive substring.
const VIP_RESTAURANTS = [
  '4 charles',
  'corner store', // matches "The Corner Store", "Corner Store" etc.
  'oresh',
  'the 86',
  '86 nyc',       // fallback if Beli drops "The"
];

function isVip(r) {
  const name = (r.business?.name ?? '').toLowerCase();
  return VIP_RESTAURANTS.some(v => name.includes(v));
}

function isEligible(r) {
  // 0. Tier filter — only show reservations Jules can see in-app (priority_level <= his tier)
  if ((r.priority_level ?? 0) > JULES_TIER) return false;

  // VIP bypass — skip all remaining filters for must-try restaurants
  if (isVip(r)) return true;

  // 1. NYC only
  const city = r.business?.city ?? '';
  if (!city.toLowerCase().includes('new york')) return false;

  // reservation_date: "Tue, Apr 7, 2026" | reservation_time: "5:00 PM" (both in ET/NYC)
  const dateStr = r.reservation_date ?? '';
  const timeStr = r.reservation_time ?? '';
  if (!dateStr || !timeStr) return false;

  const time = parseDisplayTime(timeStr);
  if (!time) return false;

  // Parse calendar date from "Tue, Apr 7, 2026" -> strip weekday
  const datePart = dateStr.replace(/^\w+,\s*/, ''); // "Apr 7, 2026"
  const resDate = new Date(`${datePart} 00:00:00 UTC`); // just for Y/M/D
  const resYear = resDate.getUTCFullYear();
  const resMonth = resDate.getUTCMonth();
  const resDay = resDate.getUTCDate();

  // 2. Future only — compare in ET
  const now = nowET();
  const nowDate = new Date(Date.UTC(now.year, now.month, now.day));
  const resDateOnly = new Date(Date.UTC(resYear, resMonth, resDay));
  if (resDateOnly < nowDate) return false;
  if (resDateOnly.getTime() === nowDate.getTime()) {
    if (time.h < now.h || (time.h === now.h && time.min <= now.min)) return false;
  }

  // 3. Time window: Mon-Thu must be 18:00-22:00 ET; Fri/Sat/Sun unrestricted
  const weekdayMatch = dateStr.match(/^(\w+),/);
  const weekday = weekdayMatch ? weekdayMatch[1] : '';
  const isWeekendOrFri = weekday === 'Fri' || weekday === 'Sat' || weekday === 'Sun';
  if (!isWeekendOrFri) {
    const mins = time.h * 60 + time.min;
    if (mins < 18 * 60 || mins > 22 * 60) return false; // outside 6:00-10:00 PM ET
  }

  return true;
}

// --- Reservation polling ---
async function fetchReservationPostings() {
  const res = await fetch(`${API_BASE}/reservation-posting/`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
  });
  if (res.status === 401) {
    // Token expired unexpectedly — force re-auth and retry once
    await login();
    return fetchReservationPostings();
  }
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`reservation-posting fetch failed ${res.status}: ${body}`);
  }
  const data = await res.json();
  // DRF paginated response: { count, next, previous, results: [...] }
  // Non-paginated: just an array
  const all = Array.isArray(data) ? data : (data.results ?? []);
  // Only show unclaimed reservations (status is "POSTED" while available, "CLAIMED" after)
  return all.filter(r => r.status === 'POSTED').filter(isEligible);
}

// --- Ntfy notification ---
async function sendNtfy(reservation) {
  const restaurant = reservation.business?.name ?? 'Unknown restaurant';
  const date = reservation.reservation_date ?? '';  // "Tue, Apr 7, 2026"
  const time = reservation.reservation_time ?? '';  // "5:00 PM"
  const partySize = reservation.num_persons ?? '';
  const tableType = reservation.table_type ? ` (${reservation.table_type})` : '';
  const poster = reservation.user?.username ?? '';
  const id = reservation.id;

  const dateTimeStr = [date, time].filter(Boolean).join(' at ');
  // Use ASCII-safe separators — ntfy treats multi-byte chars in body as binary (file attachment)
  const partySizeStr = partySize ? ` | ${partySize} people${tableType}` : '';
  const posterStr = poster ? ` | @${poster}` : '';

  // Beli has no working deep links to specific reservations — reservation routes are inside
  // the authenticated Ionic shell and not registered as top-level routes. Universal links
  // always land on the app home. Link to beliapp.co to open the app, then go to Sharing tab.
  const title = `[Beli] ${restaurant}`;
  const body = `${dateTimeStr}${partySizeStr}${posterStr} | Sharing tab`;
  const appUrl = 'https://beliapp.co';

  console.log(`[ntfy] Sending notification: #${id} ${restaurant} ${dateTimeStr}`);

  const res = await fetch(`${NTFY_URL}/${NTFY_TOPIC}`, {
    method: 'POST',
    headers: {
      Title: title,
      Priority: 'urgent',
      Tags: 'fork_and_knife,calendar',
      Click: appUrl,
      Actions: `view, Open Beli, ${appUrl}`,
    },
    body,
  });

  if (!res.ok) {
    console.error(`[ntfy] Failed to send notification: ${res.status} ${await res.text()}`);
  }
}

// --- Main poll loop ---
// seenIds is loaded from Supabase on startup — persists across redeploys
const seenIds = new Set();

async function poll() {
  try {
    await ensureAuth();
    const postings = await fetchReservationPostings();

    console.log(`[poll] ${postings.length} reservation posting(s) found`);

    for (const reservation of postings) {
      if (!seenIds.has(reservation.id)) {
        seenIds.add(reservation.id);
        await markSeen(reservation.id);
        await sendNtfy(reservation);
      }
    }
  } catch (err) {
    console.error('[poll] Error:', err.message);
  }
}

// --- Startup ---
console.log(`[beli-monitor] Starting. Poll interval: ${POLL_INTERVAL_MS / 1000}s. Ntfy: ${NTFY_URL}/${NTFY_TOPIC}`);
console.log('[db] Loading seen IDs from Supabase...');
loadSeenIds().then(ids => {
  ids.forEach(id => seenIds.add(id));
  console.log(`[db] Loaded ${seenIds.size} previously seen IDs`);
  poll();
  setInterval(poll, POLL_INTERVAL_MS);
}).catch(err => {
  console.error('[db] Failed to load seen IDs:', err.message);
  console.error('[db] Aborting — cannot start without persistence (risk of duplicate notifications)');
  process.exit(1);
});
