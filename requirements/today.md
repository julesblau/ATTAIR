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

## 6. OUT OF SCOPE TODAY
- RevenueCat (needs App Store/Play Store product setup)
- AdMob / real ads (needs Capacitor)
- Capacitor wrapper (separate day)
- Price drop alerts (needs background jobs)
- App.jsx full refactor (separate day)

---

## 7. AGENT NOTES

**PM:** Today is about VERIFICATION and POLISH, not new features. Most code was
written yesterday. Read the codebase first, verify what works, fix what doesn't.
DO NOT push until E2E confirms the app works.

**Backend agent:** Verify existing code works. Focus on half-done features (seen-on,
nearby-stores, trial flow). DO NOT change CORS, REQUIRED_ENV, or move credentials.

**Quant agent:** Verify SerpAPI caching works. Check that getCache/setCache functions
exist and properly read/write product_cache table. If they're missing, build them.

**UI/UX agent:** Verify Circle to Search works end-to-end. Polish half-done features
(scan rename UI, wishlist operations, referral share button). Test at 390px width.

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
