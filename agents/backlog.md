# Creative Backlog — Approved Ideas

> Feature backlog for ATTAIRE. Discord bot pulls from here by priority.
> Remove items after they're built.

## CRITICAL — Must Fix Now (Jules priority update 2026-03-30)

### Fix Broken Scan/Search — No Results Returned
**Status:** DONE (2026-03-31)
**Effort:** M
**Spec:**
- **Problem:** Both Fast Search and Deep Search return "no products found" after loading. Happens with personal photos AND Google images. The core feature of the app is completely broken.
- **Investigate:** Trace the full flow end-to-end: frontend image upload → backend endpoint → SerpAPI queries → Claude vision analysis → results rendering. Find where results are being lost or requests are failing.
- **Fix:** Whatever is broken in the pipeline — API keys, request format, parsing, error handling. Must return real product results for any fashion image.
- **Verify:** Test with at least 3 different images (personal photo, Google image, screenshot) on both Fast Search and Deep Search. All must return results.

### Fix Logo Colors for Dark/Light Mode
**Status:** DONE (2026-03-31)
**Effort:** S
**Spec:**
- **Problem:** Logo in top-left header has wrong colors for dark/light mode.
- **Dark mode:** Logo background should be WHITE, letters should be BLACK.
- **Light mode:** Logo background should be BLACK, letters should be WHITE.
- **Scope:** Affects the logo on all pages (top-left header). Also ADD the logo to the landing/signup page for new users — it's missing there.

### Fix Logo Rectangle Spacing
**Status:** DONE (2026-03-31)
**Effort:** S
**Spec:**
- **Problem:** The rectangle behind the logo text is too wide horizontally and has uneven vertical padding.
- **Fix 1:** Tighten the rectangle horizontally — less space between the edges of the rectangle and the letters. Keep a small gap, not a wide one.
- **Fix 2:** Make vertical padding even — equal spacing above and below the letters relative to the rectangle edges. Currently uneven (text sits closer to one edge than the other).

### Logo Polish — Spacing, Dot Removal, AI Highlight
**Status:** QUEUED — Must fix now
**Effort:** S
**Spec:**
- **Side spacing:** Reduce horizontal padding of the rectangle to ~40% of current. Almost flush to the letters with just a small breathing room.
- **Orange dot:** Do NOT remove. Move it to the top-right of the E, positioned like an exponent. Triple its current size. This dot is part of the brand identity — treat it as the secondary logo mark.
- **Highlight "AI":** The letters "AI" in ATTAIRE should be subtly colored in gold (#C9A96E). Rest of the letters stay the normal color (white in dark mode, black in light mode). Should be subtle — not loud, but once you notice it you can't unsee it.
- **Do NOT break anything else about the logo** — the dark/light mode colors and rectangle are already correct.

### Fix Style DNA Text Contrast (Light Mode Only)
**Status:** QUEUED — Must fix now
**Effort:** S
**Spec:**
- **Problem:** On Profile → Style DNA in LIGHT MODE, the description text is small black text on a purple background. Unreadable.
- **Dark mode looks perfect — do NOT change dark mode styling.**
- **Fix:** Light mode description text needs to match what dark mode does — white/light text for proper contrast against the purple background.
- **Scope:** Only the description text in light mode — layout and content are fine.

### Budget Range Slider in Settings
**Status:** QUEUED — Must fix now
**Effort:** S
**Spec:**
- **Problem:** Profile → Settings → Default Budget Range does nothing when tapped.
- **Fix:** Tapping opens a centered popup modal with a range slider (min and max). User drags to set their default budget range. Save on confirm.
- **Range:** $0 – $1000 (or appropriate max).

### Size Preferences Popup in Settings
**Status:** QUEUED — Must fix now
**Effort:** M
**Spec:**
- **Problem:** Profile → Settings → Size Preferences does nothing when tapped.
- **Fix:** Tapping opens a centered popup modal to set sizes per clothing category.
- **Flow:**
  1. User picks gender (Men / Women) — determines which size scales to show
  2. Set size per category: Tops (XS/S/M/L/XL/XXL), Bottoms waist (28-40), Bottoms length (28-36), Shoes (men 6-15 / women 5-12), Dresses (women only, 0-16)
  3. Each category has the appropriate scale for the selected gender
  4. Save on confirm.

### Fix Language Setting — Full i18n
**Status:** QUEUED — Must fix now
**Effort:** M
**Spec:**
- **Problem:** Profile → Settings → Language only changes select text. Many buttons, labels, and UI elements remain in English.
- **Fix:** All existing languages must translate ALL text — every button, label, modal, placeholder, error message. Nothing should remain in English when a language is selected.
- **Confirmation:** When user changes language, show a centered confirmation popup in the NEW language before applying the change.
- **Scope:** Fix all existing languages in the app, don't add new ones.

### Fix Followers/Following
**Status:** QUEUED — Must fix now
**Effort:** M
**Spec:**
- **Problem:** Tapping followers/following count on Profile does nothing.
- **Fix:** Tapping opens a list view showing follower or following users.
  - Each row: avatar, display name, style info
  - Tappable to view their profile
  - Follow/unfollow button on each row
- **Data:** Use existing seeded AI users to populate lists. The feature should work end-to-end with the fake data.

### Fix My Scans Page — Remove Clutter
**Status:** QUEUED — Must fix now
**Effort:** S
**Spec:**
- **Problem 1:** "Complete the Look" button is at the top of the My Scans page. It doesn't belong here.
  - **Move** "Complete the Look" to the search results page (both fresh scan results AND when tapping into a past scan to view its results).
  - **Remove** it from the My Scans page entirely.
- **Problem 2:** Two redundant filter rows at the top — "All / My Picks" AND "All Scans / Wishlist / Bookmarks". Confusing and duplicative.
  - **Fix:** Consolidate into ONE clean filter bar. Merge the logic into a single row of filter options.

## CRITICAL — Build This Run (Jules priority update 2026-03-28)

### ATTAIRE Rename + Branding
**Status:** DONE (Run 5, 2026-03-28) — All user-facing strings updated to ATTAIRE
**Effort:** S

### Discord Bot UX Improvements
**Status:** DONE (Run 5, 2026-03-28) — terser responses, individual agent dispatch
**Effort:** M (2 agents)

### Discord Bot Formatting Cleanup
**Status:** DONE (Run 5, 2026-03-28) — mobile formatting fixed
**Effort:** S (1 agent)

### SQL Access via Claude CLI
**Status:** DONE (Run 5, 2026-03-28) — agents/db-query.js, needs service role key
**Effort:** S (1 agent)

### Overnight / Autonomous Mode
**Status:** DONE (Run 5, 2026-03-28) — autonomous mode implemented
**Effort:** S (1 agent)

## QUEUED — Build This Run (Specs Approved 2026-03-29)

### 1. Budget Dupe Finder
**Status:** QUEUED — Spec approved by Jules
**Effort:** M (2 agents)
**Spec:**
- **What it does:** User sees a luxury item in results -> taps "Find the Dupe" -> gets dedicated view of visually similar items at way lower price points, with a shareable comparison card.
- **Entry points:** "Find the Dupe" button on any product card priced $150+. Existing dupe alert pills become tappable -> opens dupe view.
- **Flow:**
  1. User taps "Find the Dupe"
  2. Loading state: "Hunting dupes..."
  3. Backend hits SerpAPI with visual-similarity queries (item description + "dupe" / "alternative" / "inspired by", filtered to <40% of original price)
  4. Results screen: side-by-side comparison card — original on left, dupe on right, savings % badge between them
  5. Swipeable if multiple dupes found (up to 5)
  6. Each dupe card has: product image, price, store, savings %, "Shop" CTA
  7. Share button -> generates a "Dupe Card" image (original vs dupe, prices, ATTAIRE watermark) for TikTok/IG stories
- **Backend:**
  - New endpoint: `POST /api/dupes` — takes product name, description, price, image URL -> returns ranked dupe results
  - Uses Claude vision to score visual similarity between original and candidates
  - Filters: must be <40% of original price, must score 60%+ visual similarity
- **UI:**
  - Comparison card is a modal/overlay, not a new page
  - Swipe horizontally between dupes
  - Share generates a 1080x1920 story-format image
  - "Similar Look" in UI copy (avoid "dupe" legally), shareable card can say "dupe"
- **NOT building yet:** Dupe Feed on trending tab, push notifs for new dupes, user-submitted dupes

### 2. Hanger Test — Daily Outfit Verdict Habit
**Status:** DONE (2026-03-29) — Full-screen verdict cards with streaks, Would Wear / Pass voting
**Effort:** M (2 agents)

### 3. Style Match Score
**Status:** QUEUED — Spec drafted by agent
**Effort:** M
**Spec:**
- **What it does:** Every product card in results shows a "92% your style" compatibility pill based on the user's Style DNA profile.
- **How it works:**
  - When results come back from a scan, backend compares each item's attributes (category, aesthetic, price tier) against user's Style DNA scores
  - Generates a 0-100% match score
  - Score displayed as a colored pill on each product card (green 80%+, yellow 50-79%, hidden <50%)
- **Backend:**
  - Extend existing scan results endpoint to include match_score per item
  - Scoring logic: weighted average of style archetype overlap, price tier alignment, category preference
  - Falls back to "New to you" pill if user has no Style DNA yet (encourages onboarding)
- **UI:**
  - Small pill on product card, next to existing dupe alert pill
  - Tappable -> tooltip: "Based on your Style DNA profile"
- **Dependencies:** Style DNA must exist for the user. If not, shows prompt to take Style Fingerprint quiz.

### 4. Complete the Look
**Status:** QUEUED — Spec drafted by agent
**Effort:** M
**Spec:**
- **What it does:** Groups saved items by scan session. Shows progress toward a full outfit and offers a "Buy All" batch affiliate link.
- **Flow:**
  1. In Likes/Saves tab, items grouped by scan (e.g. "From your blue jacket scan — 3 of 5 items saved")
  2. Progress bar showing how many items from that scan are saved
  3. "Complete the Look" CTA suggests remaining items from that scan
  4. "Buy All" button -> opens multi-retailer cart (affiliate links for each)
- **Backend:**
  - Group saved items by scan_id
  - New endpoint: `GET /api/looks/:scanId` — returns all items from scan + which are saved
  - "Buy All" generates a redirect page that opens each retailer link
- **UI:**
  - Grouped cards in Saves tab with scan thumbnail header
  - Progress ring/bar
  - "Buy All" button with total price estimate
- **NOT building yet:** AI-suggested additions beyond original scan results

### 5. Logo Tweaks
**Status:** IN PROGRESS (2026-03-29) — black bg + dark/light mode variants, started before stop
**Effort:** S
**Spec:**
- Black rectangular background behind logo mark
- Light mode: invert logo colors
- Add logo to landing/marketing page
- Quick pass, no new components needed

## HIGH

### Smaller/More Frequent Agent Commits
**Status:** DONE (2026-03-29)
**Effort:** S
**Summary:** Each agent commits after completing each sub-task rather than batching at the end. Prevents losing work on process death.

### Migrate Discord Bot to Hosted Environment
**Status:** DONE (2026-03-29)
**Effort:** M
**Summary:** Move the Discord bot off Jules' laptop to a hosted environment (Railway, VPS, or similar). Currently requires laptop to stay on and awake. Should run 24/7 without depending on personal hardware.
**Added:** 2026-03-29 via Discord

## MEDIUM

### Social Proof Signals on Feed
**Status:** DONE (Run 5, 2026-03-28)
**Effort:** S (1 agent)

### Process Keep-Alive Pings
**Status:** DONE (2026-03-29)
**Effort:** S (1 agent)
**Summary:** Discord bot pings Jules when any Claude Code process is about to shut down or sleep, so he can confirm to keep it running.

## LOW

### Scan-to-Reel Video Export
**Status:** DONE (2026-03-29)
**Effort:** M (2 agents)
**Summary:** 5-second animated video of scan results using Canvas + MediaRecorder API. Pro-only. Optimized for TikTok/Reels.

### Follow-up Nudge System
**Status:** DONE (2026-03-29)
**Effort:** S (1 agent)
**Summary:** Bot re-pings Jules after 10-15 min timeout if he misses a message that needs input.

### Chat Context Persistence
**Status:** DONE (2026-03-29)
**Effort:** S
**Summary:** Pass key context forward via memory system instead of relying on conversation compression.

## Backlog — Rethink Later

### Scan-to-Earn Referral Loop
**Status:** BACKLOG — Jules wants to rethink incentive structure
**Effort:** S (1 agent)
**Summary:** Post-scan-result banner "Share ATTAIRE — you both get a free scan." Incentive TBD.

### Occasion-Driven Event Mode
**Status:** DEFERRED to Run 4+ (complex)
**Effort:** M (2 agents)

### Influencer Scan Packs
**Status:** DEFERRED (needs user base first)
**Effort:** M (2 agents)

### Trending Feed ("What's Hot Right Now")
**Status:** DEFERRED (needs data volume)
**Effort:** S (1 agent)

## Proposed — Creative Run 2026-03-25 (Remaining)

### Style Twins — Find Your Fashion Doppelganger
**Status:** DONE (2026-03-29) — Discover tab with score comparison bars, shared-save triggers, weekly cron, 20+ commits of polish
**Effort:** M (1-2 agents)

### Outfit of the Week — AI Editorial That Runs on Autopilot
**PM Verdict:** QUEUE — Low effort, high retention. Uses existing AI content infra.
**Effort:** S-M (1 agent)
**Summary:** Monday cron picks top 10 trending scans. Claude writes editorial caption. Pinned "This Week's Look" card on Feed. Pro users get Sunday "Weekly Style Report" push with 3 personalized looks.
**Revenue:** Monday habit loop. Pro benefit: exclusive Weekly Style Report.

### Shop My Feed — Shoppable User Storefronts
**PM Verdict:** LATER — Strong monetization but needs social graph maturity.
**Effort:** M (2 agents)
**Summary:** Pro users enable "Shop My Style" on profile. Each public scan gets "Shop This Look" with affiliate links. Vanity URL: attair.app/@username. Revenue split for top creators (future).
**Revenue:** Every public profile becomes an affiliate distribution channel. SEO surface area.

### "Spotted This" Share Extension
**PM Verdict:** LATER — Highest viral potential but needs native app (Capacitor).
**Effort:** M+ (needs native setup)
**Summary:** iOS Share Sheet / Android Intent handler. Share any image from Instagram/TikTok directly to ATTAIRE. Compact modal shows results without leaving source app.

### Budget Lock — Real-Time Outfit Budget Guard
**PM Verdict:** LATER — Good UX but less viral than other options.
**Effort:** M (2 agents)
**Summary:** "I want to spend $____ on this outfit" input. Running total with progress bar. Auto-adjusts tier suggestions. "Mix and Match" optimizer. Shareable "Budget Build" links.

## Approved — Creative Run 5 Proposals (2026-03-28)

### Retailer Spotlight
**Status:** DONE (2026-03-29)
**Effort:** S

### Dupe Alert
**Status:** DONE (Run 5, 2026-03-28)
**Effort:** S

### Trending Feed
**Status:** DONE (Run 5, 2026-03-28)
**Effort:** M

### Interactive Share Link
**Status:** DONE (Run 5, 2026-03-28)
**Effort:** M

### Style Match Score
**Status:** Moved to QUEUED section with full spec
**Effort:** M

### Complete the Look
**Status:** Moved to QUEUED section with full spec
**Effort:** M

### Scan History Replay
**Status:** Approved — backlogged
**Effort:** L
**Summary:** Weekly "price dropped since you scanned this" notifications. Needs SerpAPI budget increase.

### Style Challenge
**Status:** Approved — backlogged
**Effort:** L
**Summary:** Weekly AI-verified outfit challenges with voting + winner badges. Needs critical mass of users.

## Priority 2 — Later Runs

### Style DNA Feed
**Status:** Deferred
**Effort:** M
**Summary:** "For You" horizontal card row in Likes tab.

### The Closet
**Status:** Deferred
**Effort:** M
**Summary:** Deduplicated wardrobe inventory by category.

### Live Look / Collaborative Styling
**Status:** Deferred (needs social graph)
**Effort:** L

### Occasion Planner
**Status:** Deferred
**Effort:** L

### Smart Re-Search Enhancements
**Status:** Deferred
**Effort:** S

### Agent Audit
**Status:** Pending — review agent prompts and quality
**Effort:** M
**Summary:** Review all agent prompts, workflows, and outputs to diagnose quality issues and propose fixes.

## Implemented — DONE

### Run 3 (2026-03-28)
- Affiliate Network Expansion — 10 retailers in tagUrl (Nordstrom, ASOS, Revolve, Zappos, Madewell, Anthropologie, UO, Shopbop, Lululemon, SSENSE)
- Style DNA Report — AI archetype from scan history, shareable card, Pro gate
- Price Drop Alerts — background job checks saved items via SerpAPI, Pro-only

### Run 2 (2026-03-27)
- Scan-to-Share Deep Link
- Outfit Verdict + Share Card
- Style Fingerprint Onboarding
- Budget Tracker + Tier Mixer
- Real Product Images in Pairings
- Smart Re-Search / Alt-Search Button

### Run 6 (2026-03-29)
- **Hanger Test** — daily outfit verdict habit with streaks, Would Wear / Pass voting
- **Style Twins** — fashion doppelganger on Discover tab, score comparison bars, shared-save triggers, weekly cron
- **Scan-to-Reel** — 5s animated video export of scan results (3 iterations of polish)
- **Follow-up Nudge System** — re-pings after 10-15 min inactivity
- **Chat Context Persistence** — structured memory system for convo context
- **Process Keep-Alive Pings** — Discord bot pings before shutdown
- **Discord Bot Hosted Migration** — moved off Jules' laptop to hosted env
- **Smaller/More Frequent Commits** — agents commit per sub-task
- VAPID keys generated and set on Railway (push notifications enabled)
- scan-images bucket verified (exists, public)
- style_challenges table + RPCs created and verified (endpoints working)
- CRON_SECRET set on Railway (AI content endpoints unlocked)
- NODE_ENV + FRONTEND_URL set on Railway
- Seeded 119 AI users with ~1009 diverse fashion scans, 624 saved items
- Gender-diverse content: 56 female / 44 male AI users with 15+ style archetypes
- Style DNA 400 error diagnosed: depleted Anthropic API credits (code handles gracefully)
- Backlog cleanup: marked 5 completed items as DONE

### Run 5 (2026-03-28)
- ATTAIRE rename across codebase

### 2026-03-28 — Jules via Discord
Retailer Spotlight — replace placeholder interstitial ad with real retailer branding + affiliate CTA (size S, recommended)
**Status:** Pending review
