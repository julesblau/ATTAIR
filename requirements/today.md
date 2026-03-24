# Requirements — March 23, 2026

## Priority (what matters most today)
The app is live at https://attair.vercel.app and in beta but makes zero money.
The entire upgrade funnel is already built — modals, triggers, pricing UI, tier logic —
it just has no payment plumbing. Today's #1 job is to make the app collect real money.

---

## 1. STRIPE WEB PAYMENTS — HIGHEST PRIORITY

The app needs to collect payments before the native app (Capacitor/RevenueCat) is ready.
Use Stripe Checkout as the interim web payment solution.

### Backend (attair-backend):
- Install `stripe` npm package
- Add `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` to .env.example (not .env)
- New route: `POST /api/payments/create-checkout-session`
  - Auth required
  - Accepts `{ plan: "yearly" | "monthly" }`
  - Creates a Stripe Checkout session:
    - Yearly: $39.99/yr, Monthly: $9.99/mo
    - success_url: `${CORS_ORIGINS}/upgrade-success?session_id={CHECKOUT_SESSION_ID}`
    - cancel_url: `${CORS_ORIGINS}`
    - customer_email from user profile
    - metadata: `{ user_id: req.userId }`
  - Returns `{ url: checkoutSession.url }`
- New route: `POST /api/payments/webhook`
  - NO auth middleware — Stripe signs its own requests
  - Verify Stripe signature using `stripe.webhooks.constructEvent`
  - On `checkout.session.completed`: set `profiles.tier = 'pro'`, set `upgrade_source`
  - On `customer.subscription.deleted` or `invoice.payment_failed`: set `profiles.tier = 'expired'`
  - Always return 200 to Stripe (prevents retries)
- IMPORTANT: The webhook endpoint needs `express.raw()` body parser, not `express.json()`.
  Add this special case in index.js BEFORE the global express.json() middleware.
- Use `price_data` inline (not Stripe price IDs) so it works without dashboard setup.

### Frontend (attair-app/src/App.jsx):
- Add `createCheckoutSession(plan)` to the API service layer
- Find the UpgradeModal `onUpgrade` handler (has a RevenueCat TODO comment)
- Replace TODO with: call API, on success redirect to `result.url`, show loading spinner
- Handle `?upgrade-success` in the URL on return — refresh user status, show welcome message

---

## 2. SERPAPI CACHING — SECOND PRIORITY

SerpAPI is $50+/mo and is the biggest cost driver. The `product_cache` table already
exists in Supabase with `cache_key`, `results (JSONB)`, `cached_at`, `expires_at`.

What to build in `attair-backend/src/services/products.js`:
- Before each SerpAPI call (Lens + text search), check product_cache table
- Cache key: MD5 hash of the search query string (use Node's built-in `crypto`)
- Cache hit (expires_at > now()): return cached results, skip SerpAPI
- Cache miss: call SerpAPI, store results with `expires_at = now() + 24 hours`
- Log hits/misses: `console.log('[cache] HIT:', cacheKey)` / `'[cache] MISS:', cacheKey`
- Garbage collect expired rows at the start of `findProductsForItems`

---

## 3. REFERRAL CODE DISPLAY — QUICK WIN

The "Share invite link" button on the Profile tab is dead. `referral_code` column exists
in profiles but is never generated or displayed.

### Backend:
- In `POST /api/auth/signup`: generate 8-char code on profile creation
  (`Math.random().toString(36).substring(2, 10).toUpperCase()`)
- In `GET /api/user/profile`: if `referral_code` is null, generate + save one, then return it

### Frontend:
- In Profile tab, find the dead share button and make it:
  - Display the user's code: "Your code: ATTX7K2M"
  - On click: `navigator.share()` if available, else copy to clipboard
  - Show "Copied!" confirmation
  - Share text: "Check out ATTAIR — AI that finds the exact outfit you're looking for! Use my code [CODE] at attair.vercel.app"

---

## 4. CIRCLE TO SEARCH — DRAW TO PRIORITIZE

Inspired by Samsung's Circle to Search: after the user takes/uploads a photo, they can
draw a circle or freehand lasso around a specific item in the outfit. That circled item
becomes the #1 priority in the search — the app focuses on finding that exact piece first.

### How it should work (user flow):
1. User scans/uploads a photo as normal
2. Before hitting "Identify", a "Circle an item" button appears below the image
3. Tapping it overlays a transparent canvas on top of the photo
4. User draws a freehand circle/loop around the item they care most about
5. When they lift their finger, the drawn shape highlights that region (semi-transparent colored overlay)
6. They can clear and redraw, or confirm
7. The circled region is extracted as a cropped sub-image
8. That sub-image is sent to Claude Vision alongside the full image, marked as the priority item
9. In results, that item appears first and gets a "Your pick" or "Circled" badge

### Frontend (App.jsx):
- Add a canvas drawing overlay component that sits on top of the cropped photo
- Use pointer events (works for both touch and mouse) to capture freehand path
- When the path closes (finger lifts), calculate the bounding box of the drawn shape
- Crop that region from the image using a hidden canvas + `drawImage()` + `toDataURL()`
- Store the cropped region as `priorityImageBase64` in state
- Pass it to the identify API call as a new optional field `priority_region_base64`
- In results, sort/pin the priority item to the top with a visual badge

### Backend (identify.js + claude.js):
- Accept optional `priority_region_base64` in the POST /api/identify body
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

## 6. AGENT NOTES

**PM:** Work in order: Stripe → Caching → Referral. All three are independent — Backend
and Quant can work in parallel after PM reviews the plan.

**Backend agent:** Own Stripe payments, referral backend, and the identify.js changes
for priority_region_base64. Read index.js carefully before adding the raw body parser —
it must go BEFORE the global express.json() call.

**Quant agent:** Own the SerpAPI caching in products.js only.

**UI/UX agent:** Own the Stripe redirect flow, referral UI, and the circle-to-search
canvas drawing overlay. The canvas drawing is the most complex UI task today — read the
existing image crop flow in App.jsx carefully before building on top of it.

**Security agent:** After Stripe is wired up, specifically check:
- Webhook signature verification (CRITICAL — without this anyone can fake a payment)
- Checkout session requires valid auth
- Referral code not enumerable

**Testing agent:** Write tests for:
- Stripe webhook handler with mock events
- Cache hit/miss logic
- Referral code generation

**E2E agent:** Test:
- Clicking upgrade shows loading state (even without live Stripe keys)
- Referral code appears on Profile tab and copy works
- No console errors on any screen
