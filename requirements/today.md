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
that IS built actually work perfectly, and finish the half-done features. We have staged changes that were built before running out of tokens on main branch, please make sure you examine from there before building.

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

## 3b. SEARCH QUALITY — AUDIT PARAMETERS & ADD CUSTOM SEARCH INPUT

### Quant agent: Audit all search parameters
The search algorithm in products.js accepts occasion, gender, budget, size prefs.
VERIFY that ALL of these are actually being used effectively:
- Is `occasion` actually changing the search results? The OCCASION_MODIFIERS map
  only has 6 entries — are the modifier strings good? (e.g., "office business professional"
  for work — does that actually help Google Shopping find better results?)
- Is gender correctly prefixed on all queries?
- Are budget_min/budget_max actually filtering results or just used for tier partitioning?
- Are size_prefs (body_type, fit_style, shoe_size, etc.) making a measurable difference?
- Document any parameter that exists but isn't being used effectively

### NEW: Custom Search Notes (free-text input)
Add a text input field where the user can type custom search criteria to guide
their search. Examples: "looking for sustainable brands only", "needs to be
machine washable", "prefer linen or cotton", "for a beach wedding in Mexico".

**Frontend:**
- Add a text input below the occasion picker (before the Search button)
- Placeholder: "Add search notes (e.g., 'sustainable brands', 'linen fabric')..."
- Store as `searchNotes` state
- Pass to findProducts API call as a new `search_notes` field

**Backend (findProducts.js → products.js):**
- Accept `search_notes` string in the findProducts route
- Pass through to `findProductsForItems` as a new parameter
- In `textSearchForItem`: append the user's custom notes to the search query
  (after cleaning for safety — no injection, reasonable length cap ~200 chars)
- Also pass search_notes to Claude in the identify prompt so it can factor them
  into item identification (e.g., if user says "formal event", Claude should
  identify items with that context)

---

## 4. CIRCLE TO SEARCH — REWORKED: DEFAULT BEHAVIOR, NOT PRO-GATED

Circle to Search is now a DEFAULT feature for ALL users (free and pro).
It should be the default interaction — NOT hidden behind a button.

### Key changes from yesterday's implementation:
- ❌ REMOVE the Pro gate / lock icon — circling is available to everyone
- ❌ REMOVE the "Circle an item" button — the canvas overlay should be ON by default
  after the user crops/uploads a photo. The user should immediately be able to draw.
- ✅ Drawing is the default state — canvas overlay is always active on the image
- ✅ When the user lifts their finger after circling, play a satisfying GLOW ANIMATION
  on the circled region — a pulsing highlight/shimmer effect that confirms "got it"
- ✅ "Clear" button available to remove the circle and start over
- ✅ User can proceed without circling anything (just tap Identify directly)

### Verify end-to-end:
- Does drawing on the canvas work on touch and mouse?
- Does the cropped region get sent to the backend?
- Does Claude return a priority item?
- Does the priority item appear first in results with a badge?
- Does the glow animation look satisfying?

### Backend (already built):
- Accepts optional `priority_region_base64` in the POST /api/identify body
- Sends cropped region as second image to Claude with priority instruction
- Store `priority_item_index` on the scan row if useful for analytics

### Design notes:
- Draw stroke: bright color (coral/orange works well), 3px, semi-transparent fill
- Glow animation after circle: pulsing shimmer/highlight effect on the circled area,
  like a confirmation that the app "locked on" to that item. Think satisfying, premium.
- Keep it dead simple — one finger draws, lift to confirm + glow
- Should feel like the Samsung/Google circle-to-search gesture, not a complex editor

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

## 6. UX POLISH & NEW FEATURES (user-approved)

### CREATIVE LICENSE FOR UI/UX AGENT
The UI/UX agent has full creative freedom to improve anything that looks incomplete,
ugly, or unpolished. If something looks half-done, make it look world-class. The bar
is App Store top 10 — think GOAT, Depop, Pinterest, Nike. This includes:
- Improving the company logo / branding if it looks amateur
- Fixing any visual element that feels placeholder or unfinished
- Adding micro-interactions, transitions, and polish wherever it helps
- Making the overall design feel cohesive and premium

---

### 6-PREREQ. Change Free Tier from 3 Scans/Day to 12 Scans/Month
The free tier scan limit needs to change from 3 per day to 12 per month.
- Backend: update `rateLimit.js` (or wherever the daily scan counter is enforced)
  to track monthly usage instead of daily. Check the `scans` table for count of
  scans in the current calendar month instead of current day.
- Frontend: update any UI that shows "3 scans remaining today" to show
  "X of 12 scans used this month" or similar
- UpgradeModal scan_limit trigger message should reflect the new limit

---

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

### 6i. Fix iPhone Camera Mirror/Flip Bug
The front-facing camera on iPhone is reversing the image instead of flipping it
correctly. When a user takes a selfie or photos using the front camera, the preview
should match what they see (mirrored), but the captured/uploaded image should be
correctly oriented. Find the camera/image capture code in App.jsx and fix the
transform so it behaves like a native iPhone camera app.

### 6j. Fix Light Mode — It Looks Awful
The app has a light mode but it looks terrible. Either:
- Fix it properly: ensure all components, text, backgrounds, borders, and cards look
  good in light mode with proper contrast and readability
- OR: remove the light mode toggle entirely and commit to dark mode only
The current state where light mode exists but looks broken is worse than not having it.

### 6k. Full Internationalization — 8 Languages
The app currently has English and broken Spanish (not all buttons/text are translated).
Expand to 8 languages with COMPLETE coverage — every string, button, label, error
message, and placeholder must be translated:

Languages: English, Spanish, French, German, Chinese (Simplified), Japanese, Korean, Portuguese

Implementation:
- Create a translation system (i18n) — can be a simple JSON object per language
- Language selector in Settings/Profile
- Store user's language preference in localStorage and/or profile
- ALL UI text must go through the translation system — no hardcoded English strings
- Spanish needs to be FIXED — audit every string and complete the missing translations

### 6l. General Visual Polish Pass
The UI/UX agent should do a full visual audit and fix anything that looks:
- Unfinished (placeholder text, gray boxes, TODO comments visible to users)
- Inconsistent (different button styles, mixed fonts, mismatched colors)
- Amateur (bad spacing, misaligned elements, ugly empty states)
- The ATTAIR logo/branding should look premium and professional

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
  - Change free tier from 3 scans/day to 12 scans/month in rateLimit.js (6-PREREQ)
  - Make phone number optional in auth.js signup validation (6b)
  - Build pairings affiliate tracking through /api/go system (6h)
  - Finish half-done features (seen-on, nearby-stores, trial flow)
  - DO NOT change CORS, REQUIRED_ENV, or move credentials

**Quant agent:** Three jobs today:
  1. Verify SerpAPI caching works (getCache/setCache with product_cache table)
  2. Audit ALL search parameters — are occasion, gender, budget, size prefs actually
     improving results? Document findings and fix any that aren't working (3b)
  3. Wire up the new `search_notes` custom text input into the search queries (3b)

**UI/UX agent:** You have CREATIVE LICENSE. Make this app look world-class.
  - Verify Circle to Search end-to-end
  - Polish banner ad placeholders to look real (6a)
  - Remove phone field from signup form or make optional (6b)
  - Redesign pairings as visual grid like Pinterest (6c)
  - Add scan streak counter (6d)
  - Add "Last Seen" timestamps on saved items (6e)
  - Add shadow to BEST VALUE pill (6f)
  - Add mini identification preview before product search (6g)
  - Fix iPhone camera mirror/flip bug (6i)
  - Fix or remove light mode — it looks awful (6j)
  - Build full i18n for 8 languages (6k) — EN, ES, FR, DE, ZH, JA, KO, PT
  - General visual polish pass — logo, branding, spacing, consistency (6l)
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
- Camera doesn't mirror/flip incorrectly
- Light mode either looks good or is removed
- Language switcher works, all 8 languages translate fully
- No untranslated English strings when switching language
- Overall visual quality matches App Store top 10 apps
