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
 *   BELI_EMAIL         — Beli account email
 *   BELI_PASSWORD      — Beli account password
 *   NTFY_TOPIC         — Ntfy topic name (e.g. jules-beli-reservations)
 *   NTFY_URL           — Ntfy server URL (default: https://ntfy.sh)
 *   POLL_INTERVAL_MS   — How often to poll in ms (default: 60000 = 1 minute)
 */

import 'dotenv/config';

const API_BASE = 'https://backoffice-service-t57o3dxfca-nn.a.run.app/api';
const NTFY_URL = process.env.NTFY_URL || 'https://ntfy.sh';
const NTFY_TOPIC = process.env.NTFY_TOPIC;
const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS || '60000', 10);
const BELI_EMAIL = process.env.BELI_EMAIL;
const BELI_PASSWORD = process.env.BELI_PASSWORD;

if (!BELI_EMAIL || !BELI_PASSWORD) {
  console.error('ERROR: BELI_EMAIL and BELI_PASSWORD are required');
  process.exit(1);
}
if (!NTFY_TOPIC) {
  console.error('ERROR: NTFY_TOPIC is required');
  process.exit(1);
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

function isEligible(r) {
  // 1. NYC only
  const city = r.business?.city ?? '';
  if (!city.toLowerCase().includes('new york')) return false;

  // reservation_date: "Tue, Apr 7, 2026" | reservation_time: "5:00 PM" (both in ET/NYC)
  const dateStr = r.reservation_date ?? '';
  const timeStr = r.reservation_time ?? '';
  if (!dateStr || !timeStr) return false;

  const time = parseDisplayTime(timeStr);
  if (!time) return false;

  // Parse calendar date from "Tue, Apr 7, 2026" → strip weekday
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

  // 3. Weekday time window: Mon–Fri must be 18:00–21:30 ET
  const weekdayMatch = dateStr.match(/^(\w+),/);
  const weekday = weekdayMatch ? weekdayMatch[1] : '';
  const isWeekend = weekday === 'Sat' || weekday === 'Sun';
  if (!isWeekend) {
    const mins = time.h * 60 + time.min;
    if (mins < 18 * 60 || mins > 22 * 60) return false; // outside 6:00–10:00 PM ET
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
  // Actual field names from API:
  // reservation.business.name, reservation.business.quick_link,
  // reservation.reservation_date, reservation.reservation_time,
  // reservation.num_persons, reservation.table_type, reservation.user.username, reservation.id
  const restaurant = reservation.business?.name ?? 'Unknown restaurant';
  const date = reservation.reservation_date ?? '';  // "Tue, Apr 7, 2026"
  const time = reservation.reservation_time ?? '';  // "5:00 PM"
  const partySize = reservation.num_persons ?? '';
  const tableType = reservation.table_type ? ` (${reservation.table_type})` : '';
  const poster = reservation.user?.username ?? '';
  const id = reservation.id;

  const dateTimeStr = [date, time].filter(Boolean).join(' at ');
  const partySizeStr = partySize ? ` · ${partySize} people${tableType}` : '';
  const posterStr = poster ? ` — @${poster}` : '';

  const title = `[Beli] ${restaurant}`;
  const body = `${dateTimeStr}${partySizeStr}${posterStr}`;
  // business.quick_link (e.g. https://beliapp.co/cD1IZngNNEb) opens the restaurant in-app.
  // No per-reservation claim URL exists in the API — fall back to reservation sharing tab.
  const sharingTab = 'https://app.beliapp.com/reservation-sharing';
  const claimUrl = reservation.business?.quick_link ?? sharingTab;

  console.log(`[ntfy] Sending notification: #${id} ${restaurant} ${dateTimeStr}`);

  const res = await fetch(`${NTFY_URL}/${NTFY_TOPIC}`, {
    method: 'POST',
    headers: {
      Title: title,
      Priority: 'urgent',
      Tags: 'fork_and_knife,calendar',
      Click: claimUrl,
      Actions: `view, Claim Now, ${claimUrl}`,
    },
    body,
  });

  if (!res.ok) {
    console.error(`[ntfy] Failed to send notification: ${res.status} ${await res.text()}`);
  }
}

// --- Main poll loop ---
const seenIds = new Set();
let firstRun = true;
// On startup, seed reservations posted before this time (± 5 min buffer for redeploy gaps)
const START_TIME = new Date(Date.now() - 5 * 60 * 1000);

async function poll() {
  try {
    await ensureAuth();
    const postings = await fetchReservationPostings();

    console.log(`[poll] ${postings.length} reservation posting(s) found`);

    if (firstRun) {
      // Seed reservations that pre-date this process start (suppress startup spam).
      // Anything posted within the last 5 min gets notified — catches reservations
      // that appeared while the bot was down between deploys.
      let seeded = 0, notified = 0;
      for (const r of postings) {
        const postedAt = new Date(r.created_dt);
        if (postedAt < START_TIME) {
          seenIds.add(r.id);
          seeded++;
        }
        // recent ones fall through to the notify loop below
      }
      console.log(`[poll] Seeded ${seeded} pre-existing reservations (no notifications sent)`);
      firstRun = false;
    }

    // Notify on any unseen reservations (first-run recent ones + all subsequent runs)
    for (const reservation of postings) {
      if (!seenIds.has(reservation.id)) {
        seenIds.add(reservation.id);
        await sendNtfy(reservation);
      }
    }
  } catch (err) {
    console.error('[poll] Error:', err.message);
  }
}

// --- Startup ---
console.log(`[beli-monitor] Starting. Poll interval: ${POLL_INTERVAL_MS / 1000}s. Ntfy: ${NTFY_URL}/${NTFY_TOPIC}`);
poll();
setInterval(poll, POLL_INTERVAL_MS);
