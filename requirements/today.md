# Requirements — March 24, 2026

## Context from yesterday's run
The agent army ran on March 23 and committed 4056 lines across 27 files. However,
3 bugs were shipped that had to be manually fixed:
1. Supabase credentials moved to env vars with empty fallbacks (broke OAuth + all API calls)
2. STRIPE_SECRET_KEY added to REQUIRED_ENV (crashed entire backend)
3. CORS changed to strict allowlist defaulting to localhost (blocked Vercel→Railway)

These are now fixed. The code from yesterday IS deployed and includes:
- Stripe payments route (payments.js) — needs Stripe keys to activate
- SerpAPI caching in products.js — working
- Referral code generation on signup — working
- Circle to Search canvas overlay — built but untested end-to-end
- Upgrade modal wired to Stripe — needs keys
- 80 tests across 6 test files — passing
- Ad interstitial polished

## Priority (what matters most today)
The app is live at https://attair.vercel.app. Yesterday's run built the payment
plumbing but we can't test Stripe without keys yet. Today's focus: make everything
that IS built actually work perfectly, and finish the half-done features.

---

## 1. STRIPE WEB PAYMENTS — ALREADY BUILT, VERIFY ONLY

✅ DONE in yesterday's run. payments.js route exists with checkout + webhook.
The raw body parser is in index.js before express.json().

### Today's task:
- Review payments.js for correctness — does the webhook handler work?
- Verify the upgrade modal in App.jsx actually calls createCheckoutSession
- Make sure the success URL redirect handler works (?upgrade-success in URL)
- DO NOT add Stripe keys to REQUIRED_ENV — they should remain optional

---

## 2. SERPAPI CACHING — ✅ ALREADY BUILT, VERIFY ONLY

Caching was added to both googleLensSearch() and textSearch() in products.js.
- Verify getCache/setCache helpers exist and work with the product_cache table
- Verify garbage collection of expired rows runs
- If getCache/setCache don't exist, build them (check products.js first)

---

## 3. REFERRAL CODE — ✅ BACKEND DONE, VERIFY FRONTEND

Backend generates referral_code on signup (auth.js). Verify:
- GET /api/user/profile returns referral_code
- Profile tab in App.jsx shows the code and copy/share works

---

## 4. CIRCLE TO SEARCH — PARTIALLY BUILT, TEST AND POLISH

The canvas overlay (CircleToSearchOverlay) and backend support (priority_region_base64
in identify.js + claude.js) were built yesterday. Today:

### Verify end-to-end:
- Does the "Circle an item" button appear after cropping a photo?
- Does drawing on the canvas work on touch and mouse?
- Does the cropped region get sent to the backend?
- Does Claude return a priority item?
- Does the priority item appear first in results with a badge?
- Is it properly gated as a Pro-only feature?

### Fix any issues found. The backend already:
- Accepts optional `priority_region_base64` in the POST /api/identify body
- If present, send it to Claude as a second image in the vision prompt with instruction:
  "The second image is a cropped region the user circled. Identify this specific item first
   and mark it with priority: true in your response."
- Claude returns the same JSON structure but the priority item has `priority: true`
- Store `priority_item_index` on the scan row if useful for analytics

### Design notes:
- Draw stroke: bright color (coral/orange works well), 3px, semi-transparent fill
- "Clear" and "Done" buttons while drawing
- Keep it dead simple — one finger draws, lift to confirm
- Should feel like the Samsung/Google circle-to-search gesture, not a complex editor
- This is a PRO feature differentiator — show a "Circle to Search" lock icon for free users
  that triggers the upgrade modal (use trigger type "general" or add "circle_to_search")

---

## 5. FINISH ALL HALF-DONE FEATURES

The app has a graveyard of features that exist in the backend but are dead, broken, or
barely wired up in the frontend. Today, finish all of them. Read the codebase thoroughly
and find every half-built thing. Here are the known ones — there may be more:

### Scan Rename
- Backend: `PATCH /api/user/scan/:id` exists and works
- Frontend: `API.renameScan()` exists in the API layer
- Problem: unclear if there's any UI to trigger it. Add an inline edit on the scan name
  in the History tab — tap the name, it becomes an editable input, tap done to save.

### Wishlist UI
- Backend: full wishlist CRUD routes exist (create, list, rename, delete, add item, remove item)
- Problem: unclear how much of this is wired in the frontend. Find the wishlist UI and
  make sure every operation (create list, add item, remove item, rename, delete) actually works.
  If any operation is missing a UI, build it.

### "Seen On" Feature
- Backend: `GET /api/seen-on` route exists (finds celebrities wearing similar items)
- Problem: is there a UI for this? If not, add a "Seen On" button to product result cards
  that fetches and shows celebrity sightings for that item.

### "Nearby Stores" Feature
- Backend: `GET /api/nearby-stores` route exists (finds local stores selling the item)
- Problem: is there a UI for this? If not, add a "Find Near Me" button on product cards
  that requests location permission and shows nearby stores on a simple list.

### Trial Flow
- Backend: `trial_ends_at` column exists and expiry is checked, but no way to start a trial
- Add a "Start free trial" option in the UpgradeModal — 7 days free, no card required
- Backend: new route or extend signup to set `tier = 'trial'` and `trial_ends_at = now() + 7 days`
- Frontend: show a trial countdown badge somewhere visible (e.g., "6 days left in trial")

### Google / Apple OAuth
- Frontend: `API.oauthLogin('google')` and `API.oauthLogin('apple')` exist
- Supabase handles the OAuth flow
- Test if these actually work end-to-end. If the buttons exist but OAuth is broken or
  redirects incorrectly, fix the redirect URL configuration.

### Ad Interstitial Polish
- The InterstitialAd component shows a gray placeholder box
- Can't add real AdMob yet (needs Capacitor) but make the placeholder look intentional:
  a polished "Featured" content card with a real-looking ad layout, sponsor label,
  and proper dismiss/skip behavior. It should feel like a real ad unit, not a gray box.

### General Rule for Half-Done Features
Read ALL route files and ALL frontend state/API calls. If a backend route exists but has
no frontend UI, build a minimal but complete UI for it. If a UI element exists but the
backend call is wired to nothing, fix the wiring. Leave nothing half-done.

---

## 6. UX POLISH & NEW FEATURES (from E2E agent suggestions, user-approved)

### 6a. Banner Ad Placeholders — Make Them Look Real
The `BANNER AD` / `SPONSORED` plain text ad slots look unfinished and cheap.
Make them look like real, polished ad units — similar to what was done for the
interstitial ad. Use styled "Featured" / "Trending" cards with product imagery,
brand labels, and proper layout. They should feel intentional, not placeholder.

### 6b. Remove Phone Number Requirement from Signup
Phone number is currently required in both backend validation (auth.js) and the
signup form. Make it optional in both places. Instagram/Depop/GOAT don't require
it — it's a conversion killer for a beta app.

### 6c. "Complete the Look" Pairings — Visual Grid Layout
The pairings section currently shows as text rows. Redesign it as a visual grid
like Pinterest — product image cards in a grid/masonry layout. Should feel editorial
and browsable, not like a data table.

### 6d. Scan Streak Counter
Add a streak counter: "You've scanned 3 days in a row!" Show it somewhere visible
(home screen or after a scan completes). Builds habit and engagement. Track in the
profiles table or derive from scan history timestamps.

### 6e. "Last Seen" Timestamp on Saved Items
Add a "Saved 2 days ago" or "Last seen: March 22" timestamp to each saved item card.
Creates urgency and primes users for price drop alerts (future feature). Derive from
the saved_items.created_at column.

### 6f. "BEST VALUE" Pill Shadow in Upgrade Modal
Add a subtle drop shadow to the "BEST VALUE" pill on the yearly plan toggle in the
UpgradeModal. Small touch, high polish. Should make it pop more.

### 6g. Mini Identification Preview Before Product Search
After Claude identifies the items but BEFORE product search runs, show a quick preview
of what was identified (item name + brand + color). This gives the user immediate
feedback during the 5-10 second product search wait. Currently the user stares at a
spinner with no info about what was found.

### 6h. Pairings Affiliate Tracking
Wire "Complete the Look" pairing clicks through the existing affiliate system
(`/api/go/:clickId`). Currently pairing clicks are tracked via analytics but don't
generate affiliate click records in the DB. Build the backend to create affiliate
records for pairing product links, so when we onboard affiliate partners later
(beyond the existing Amazon Associates account), we're already tracking everything.

---

## 7. OUT OF SCOPE TODAY
- RevenueCat (needs App Store/Play Store product setup)
- AdMob / real ads (needs Capacitor)
- Capacitor wrapper (separate day)
- Price drop alerts (needs background jobs, but "Last Seen" timestamps prepare for it)
- App.jsx full refactor (separate day)

---

## 8. AGENT NOTES

**PM:** Today has two phases:
  Phase 1: VERIFY yesterday's work (Stripe, caching, Circle to Search, referral)
  Phase 2: BUILD the 8 user-approved improvements from section 6
Work in order: verify first, then tackle section 6. Push only after E2E confirms.

**Backend agent:**
  - Verify existing payments/caching/referral code works
  - Make phone number optional in auth.js signup validation (6b)
  - Build pairings affiliate tracking through /api/go system (6h)
  - Finish half-done features (seen-on, nearby-stores, trial flow)
  - DO NOT change CORS, REQUIRED_ENV, or move credentials

**Quant agent:** Verify SerpAPI caching works. Check that getCache/setCache functions
exist and properly read/write product_cache table. If they're missing, build them.

**UI/UX agent:**
  - Verify Circle to Search end-to-end
  - Polish banner ad placeholders to look real (6a)
  - Remove phone field from signup form or make optional (6b)
  - Redesign pairings as visual grid (6c)
  - Add scan streak counter (6d)
  - Add "Last Seen" timestamps on saved items (6e)
  - Add shadow to BEST VALUE pill (6f)
  - Add mini identification preview before product search (6g)
  - Finish half-done features (scan rename, wishlist ops, referral share)
  - Test everything at 390px width

**Security agent:** REPORT ONLY. Do not modify code. Document findings for PM review.

**Testing agent:** Run existing 80 tests first. Fix any failures. Then add tests for
any new code written today.

**E2E agent:** Test EVERYTHING before push. Critical checks:
- Photo upload + identify works
- Google login works
- All navigation tabs work
- No console errors on any screen
- Upgrade modal appears and shows loading state
- Referral code visible on Profile tab
- Pairings show as visual grid, not text list
- Scan streak counter appears
- Saved items show "Last Seen" timestamp
- Signup works without phone number
- Banner ads look polished, not placeholder
