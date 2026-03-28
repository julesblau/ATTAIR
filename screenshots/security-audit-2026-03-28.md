# ATTAIR Security Audit -- 2026-03-28

**Auditor:** Security Agent (automated review)
**Scope:** attair-backend/src/, attair-app/src/App.jsx, attair-backend/sql/, agents/
**Files reviewed:** auth.js, rateLimit.js, all 16 route files, claude.js, products.js, App.jsx, all SQL migration files

---

## CRITICAL FINDINGS

### [CRITICAL-1] agents/.env -- Real Credentials Committed to Git

The file `agents/.env` is tracked in git and contains live credentials:
- `DATABASE_URL` with Postgres superuser password (bypasses all RLS)
- `GH_TOKEN` (GitHub PAT)
- `SERPAPI_KEY` (live API key)
- `DISCORD_TOKEN` (bot token)
- `TEST_PASSWORD` (matches DB password)

**Exploitable now: YES.** Anyone with repo read access has full DB superuser access.

**Fix:** Rotate ALL credentials immediately. Remove from git history with `git filter-repo` or BFG. Add `agents/.env` to `.gitignore`.

### [CRITICAL-2] App.jsx:17 -- Hardcoded Live Supabase URL + Anon Key

Hardcoded fallback values for `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`. The anon key is public by Supabase design (acceptable), but the hardcoded fallback means rotating keys requires a code change.

**Fix:** Remove hardcoded fallbacks; require env vars to be set.

---

## HIGH FINDINGS

### [HIGH-1] auth.js:13 -- /api/auth/config Exposes Config Publicly
Unauthenticated endpoint returns Supabase URL + anon key. Redundant with hardcoded frontend values.

### [HIGH-2] user.js:284 -- TOCTOU Race on saved_count
Read-modify-write on `saved_count` allows concurrent requests to desync the count, bypassing the 20-item save limit.
**Fix:** Use atomic `UPDATE profiles SET saved_count = GREATEST(0, saved_count - 1)`.

### [HIGH-3] events.js:17 -- No Batch Size Limits on Analytics
`POST /api/events` accepts unlimited events per request. Attacker can insert 1M rows/min per IP.
**Fix:** Cap batch to 50 events, cap field lengths.

### [HIGH-4] affiliate.js:160 -- Click Fraud via No Deduplication
No per-user dedup, client-generated click IDs, 60 clicks/min/IP allowed.
**Fix:** Server-generated click IDs, per-user dedup, ownership verification.

### [HIGH-5] social.js:60 -- Follower List Exposed to All Users
Any authenticated user can enumerate any other user's full follower/following list.
**Fix:** Check profile visibility; only return count (not list) for private profiles.

### [HIGH-6] rateLimit.js:84 -- Scan Rate Limit TOCTOU Race
Check and increment are separate async operations. Concurrent requests bypass the 12-scan limit.
**Fix:** Atomic increment-and-check via `try_increment_scan` RPC before calling Claude.

---

## MEDIUM FINDINGS

### [MEDIUM-1] auth.js:24 -- Password Min Length is 6
### [MEDIUM-2] user.js:86 -- gender_pref and phone Not Validated
### [MEDIUM-3] user.js:248 -- UUID Format Not Validated in Most /:id Routes
### [MEDIUM-4] claude.js:96 -- User Message Injected into AI Prompt
### [MEDIUM-5] findProducts.js:61 -- Custom Occasion in AI Prompt (well-sanitized, low risk)
### [MEDIUM-6] 001-schema.sql:109 -- Wishlists Has No RLS Policies in Main Schema
### [MEDIUM-7] social.js:449 -- ilike Without GIN Index (DoS via search at scale)
### [MEDIUM-8] styleDna.js:12 -- In-Memory Cache Has No Eviction (memory leak risk)

---

## LOW FINDINGS

### [LOW-1] index.js:51 -- trust proxy=1 assumption
### [LOW-2] index.js:148 -- Error messages leak in non-production
### [LOW-3] payments.js:44 -- Admin auth dependency in payment route
### [LOW-4] affiliate.js:213 -- parseInt without overflow check
### [LOW-5] App.jsx:1881 -- OAuth hash extraction without origin check
### [LOW-6] priceAlerts.js:138 -- CRON_SECRET timing attack (theoretical)
### [LOW-7] social.js:355 -- Full items JSONB exposed in public feed

---

## POSITIVE SECURITY NOTES

1. No `dangerouslySetInnerHTML` in App.jsx -- React escaping provides XSS protection
2. No service role key in frontend -- only anon key used client-side
3. URL scheme validation consistently applied (affiliate, avatar, nearbyStores)
4. Error messages sanitized in identify.js and findProducts.js
5. Stripe webhook signature verification implemented correctly
6. `rel="noopener noreferrer"` on all `target="_blank"` links
7. RLS auto-enable trigger provides safety net against open tables
8. Scan rate limit correctly handles trial expiry at runtime

---

## SUMMARY

| Severity | Count | Exploitable Now |
|----------|-------|----------------|
| CRITICAL | 2 | 1 YES, 1 Partial |
| HIGH | 6 | 4 YES, 2 Low |
| MEDIUM | 8 | Mostly theoretical |
| LOW | 7 | None |

**IMMEDIATE ACTION:** Rotate all credentials in `agents/.env` and remove from git history.
