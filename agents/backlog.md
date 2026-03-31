# Creative Backlog — Approved Ideas

> Feature backlog for ATTAIRE. Discord bot pulls from here by priority.
> Remove items after they're built.

## CRITICAL — Next Up (Updated 2026-03-30)

*All critical items completed — see Done section below.*

## QUEUED — Build Next (Specs Approved)

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

### 2. Style Match Score
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

## HIGH — Queued

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

## MEDIUM — Ideas (Approved, Not Specced)

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

## MEDIUM — Backlogged

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

### Run 7 (2026-03-30)
- **Budget Range Slider** — Settings → Budget Range opens inline slider with dual thumbs, tier chips, save/cancel (was already built in Run 6)
- **Size Preferences Popup** — Settings → Size Preferences opens centered modal with gender selector (Men/Women), size chips per category (Tops, Bottoms waist/length, Shoes, Dresses), saves to profile
- **Full i18n Fix** — Added 81 new translation keys to all 8 languages (EN/ES/FR/DE/ZH/JA/KO/PT), converted hardcoded UI strings to t() calls, added language change confirmation popup in target language
- **Followers/Following List** — Tapping follower/following count on Profile opens full-screen list with avatar, name, bio, follow/unfollow buttons per row, uses existing backend endpoints
- **My Scans Cleanup** — Removed Complete the Look toggle + grouped view from My Scans (already on results page), consolidated two filter rows into single bar (All / My Picks / Wishlists)

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

