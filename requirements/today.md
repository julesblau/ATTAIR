# Requirements — March 27, 2026 (Run 2: Full UI/UX Overhaul)

## Context
Run 1 today delivered: search algorithm refactor, light mode CSS overhaul (280+ overrides),
social profile features, 214 tests passing, 5 security fixes. See standups/2026-03-27.md.

Run `git log --oneline -30` before starting. Do NOT redo anything already done.

---

## MISSION: Make ATTAIR feel like TikTok meets Instagram meets GOAT.

Trendy. Fun. Dead-simple. Beautiful. Every screen immediately obvious to a first-time user.

### THE VISION (from Jules — this is the north star):
- **Dark theme** with high-contrast accent colors and smooth animations
- **Bottom sheet** interaction patterns (pull-up panels, not page navigations)
- **Full-bleed photos** that dominate the screen — scan photos are the content
- **Minimal text, icon-heavy** navigation — universal language over words
- **The app gets influencers** (like Beli for restaurants). You follow influencers
  and see their scans. Think fashion TikTok where the content IS the outfits.
- **For You Page**: learns your styles and preferences, surfaces relevant public scans
- **Following Page**: what your friends and followed influencers are scanning
- **Profile = Instagram**: tap a scan in the grid → overlay/modal (not a new page)
- **Circle-to-search**: Apple Markup tool style (clean, precise, iOS-native feel)
- **Pricing**: $5/month, $30/year (may change later)

### DESIGN PRINCIPLES (every agent must follow these):
- Full-bleed imagery — photos are hero content, not thumbnails
- Bottom sheets over page navigations — slide up, don't navigate away
- Icons over text wherever possible
- Smooth transitions and animations — nothing should snap or jump
- Progressive disclosure — don't show everything at once, expand on tap
- 44px minimum touch targets — this is a thumb-driven app
- Card-based layout with generous whitespace and rounded corners

---

## PHASE 1 — FOUNDATION (no other UI work starts until this is done)

### 1. Design System + Light/Dark Mode Fix

The current UI is inconsistent — buttons are invisible in light mode, colors are arbitrary,
spacing is cramped, and there's no shared design language. Fix ALL of this at once by
establishing a proper design system.

**Design tokens (CSS custom properties in index.css):**
- Colors: accent, bg-primary, bg-card, text-primary, text-secondary, border, shadow-card,
  success, error, info — all with dark AND light mode variants that actually work
- Typography: xl (24px), lg (18px), md (16px), sm (14px), xs (12px)
- Spacing: xs (4px), sm (8px), md (16px), lg (24px), xl (32px)
- Radius: sm (8px), md (12px), lg (16px), xl (24px)

**Component base classes (App.css):**
- `.btn-primary`: solid accent bg, white text, rounded, 44px min height, visible in BOTH modes
- `.btn-secondary`: outlined, accent border, transparent bg, visible in BOTH modes
- `.btn-ghost`: no border, subtle hover
- `.card`: bg-card, rounded-xl, shadow-card, consistent padding
- `.chip`: small pill, selected/unselected states
- `.input`: bg-input, rounded, border, focus ring

**Color palette:**
- Dark: true black (#000) bg, elevated cards (#1a1a1a), gold accent (#C9A96E)
- Light: off-white (#F8F8FA) bg, white cards with soft shadow, same gold accent
- ALL buttons, tabs, chips, toggles, active states must have proper contrast in both modes

**Typography:** Bold confident headlines, clean readable body (min 14px), gray subtle captions.

**Spacing:** More breathing room between sections. Card-based layout with rounded corners.

**This agent must also audit and fix every existing button/interactive element for visibility.**

---

## PHASE 2 — BACKEND + AI (runs in parallel with Phase 1, no UI dependency)

### 2. AI Identification Tuning

The identification algorithm tries too hard to find every little thing.

**Changes to claude.js prompt:**
- Raise visibility threshold to 70% (was 50%). Exception: circled items bypass this.
- Cap at 3-5 items per scan. Prompt: "Focus on the 3-5 most prominent, clearly visible
  garments. Ignore partially hidden items, undergarments, socks, and small accessories."
- Ensure gender is returned clearly in the response

### 3. Backend — New Endpoints + Fixes

All backend work that doesn't depend on the design system. Do it now.

**Category-aware sizes (Section 11 from Jules' list):**
- When searching, know that hats = S/M/L/fitted, shoes = numeric, pants = waist/length,
  tops = XS-XXL, dresses = 0-20. Pass appropriate size format to search queries.
- Add a SIZE_CATEGORIES map in products.js or a new util

**Pairings product search (Section 13):**
- "Complete the Look" suggestions currently show emojis. Run a quick product search
  for each pairing suggestion and return top result's image + price + URL.
- Modify suggestPairings flow to also call findProducts for each suggestion

**Social feed endpoint:**
- `GET /api/feed` — public scans from users the authenticated user follows, paginated.
  If following nobody, return trending/recent public scans. Include: scan image,
  user display_name, summary, item count, created_at.
- `GET /api/users/search?q=name` — search users by display_name (ILIKE), return
  id, display_name, bio, follower_count. Limit 20. requireAuth.

**Public scan endpoint (for share links):**
- `GET /api/scan/:scanId/public` — returns scan data if visibility="public".
  No auth required. Returns: image_url, summary, items, user display_name.

**Verdict column:**
- SQL migration (005-verdict.sql): add `verdict` column to scans table
  (enum: 'would_wear', 'on_the_fence', 'not_for_me', NULL)

**Pricing fix:**
- Correct pricing everywhere: $5/month, $30/year. Fix any discrepancy in both frontend and backend.

---

## PHASE 3 — CORE FLOWS (starts after Phase 1 design system is done)

### 4. Scan & Identification UX

The scan flow is confusing. Users don't know how to use it.

- **Home CTA**: Big obvious "Scan an Outfit" button with camera icon
- **Upload vs Camera**: Two clear options — "Take Photo" and "Upload from Gallery"
- **Scan preview**: Show photo large with "Scan This" confirmation before processing
- **Loading state**: Branded animation during AI identification (not just a spinner)
- **Gender display**: Show detected gender ("Men's" / "Women's") prominently on results.
  Add toggle to switch if wrong — switching re-triggers product search.
- **Circle-to-search modernization**: Apple Markup tool style — clean, precise, iOS-native.
  Smooth yellow highlighter stroke, slightly transparent, thick (4-5px). Clean rounded
  endpoints. Subtle animation on completion (brief highlight then fade to selection).
  Should feel like the native iOS screenshot annotation tool, not a drawing app.

### 5. Results Screen Overhaul

The results screen needs to show more, let users interact more, and be easier to browse.

- **Horizontal scroll per tier**: Budget/Mid/Premium each become a swipeable row.
  Show 4-6 results per tier. Active card slightly larger/elevated.
- **Search notes input**: Text field — "Tell us more..." where users can type things like
  "I think this is Zara" or "Looking for a cheaper alternative". Pass as `search_notes`
  to findProducts (already supported). Show as editable chip. Changing triggers re-search.
- **Verdict system**: Replace 1-5 star rating with "Would Wear" / "On the Fence" / "Not for Me".
  Each has distinct icon + color + animation. "Would Wear" auto-saves items to Likes.
- **Complete the Look**: Show real product images from search results instead of emojis.
  Each pairing card: product image, name, price, "Shop" button.
- **Budget selection**: Replace number inputs with dual-thumb range slider.
  Preset chips: "$" (<$50), "$$" ($50-150), "$$$" ($150-500), "$$$$" ($500+).
  Tapping a preset sets the slider. Show range as "$50 – $150" below.

---

## PHASE 4 — PAGES (starts after Phase 1, can run in parallel with Phase 3)

### 6. Home Screen — TikTok-Style Feed with For You + Following

The home screen IS the app now. This is where users spend their time.

**Layout: Two tabs at the top — "For You" and "Following"**

**For You tab:**
- Algorithm-driven feed of public scans the user would like
- Based on: their style interests, liked items, scan history, followed categories
- Full-bleed scan photos as feed cards (like TikTok/Instagram)
- Each card: full-width outfit photo, user avatar + name overlay at bottom,
  scan summary, item count, heart/like button
- Tap → Instagram-style overlay/modal showing full results (NOT a page navigation)
- This is the discovery engine — how new users find influencers and styles
- If user has no history yet: show trending/popular scans as bootstrap

**Following tab:**
- Chronological feed of scans from people you follow
- Same card format as For You
- This is your friends + influencers you chose to follow

**Scan button:**
- Floating action button (FAB) — always visible, bottom-center, above the tab bar
- Camera icon, accent color, slightly elevated
- Tapping opens camera/upload bottom sheet (not a page navigation)

**User search:**
- Search icon in top-right → search bar slides down
- Search users by display name
- Results show avatar, name, bio preview, "Follow" button
- Tap user → Instagram-style profile overlay

### 7. Profile & Settings — TikTok/Instagram Style

Redesign to feel like TikTok/Instagram profile page.

- **Profile header**: Avatar/initial, display name, bio, follower/following counts
- **Stats row**: Scans, Likes, Collections counts (like TikTok's posts/followers/likes)
- **Photo grid below**: User's scans as Instagram-style 3-column grid
- **Tap a scan → Instagram-style overlay/modal** showing full results with items and
  product tiers. Swipe down or tap X to dismiss. NOT a page navigation.
- **Other users' profiles**: Same layout. Follow/unfollow button. Only shows public scans.
- **Settings gear** → bottom sheet (not a page): theme toggle, language, budget prefs,
  size prefs, subscription status, sign out

### 8. History — Click Into Old Scans

- History list: scan thumbnail, date, summary, item count
- Tap a scan → full results screen with all items and product tiers
- "Search again" button to re-run product search with current preferences
- Swipe-to-delete or long-press menu for delete

### 9. Likes Page — Clean and Simple

- 2-column Pinterest-style grid of saved items
- Each card: product image, brand, price, heart icon to unlike
- Filter chips: All, by Category, by Price
- Budget tracker: Tap scan group header → expand to cost breakdown per tier.
  Swap items between tiers, see running total. "Buy the look" CTA. PRO-ONLY gate.
- Empty state: friendly illustration + "Start scanning to save items you love"

---

## PHASE 5 — VIRAL & ONBOARDING (after core flows work)

### 10. Shareable Scans + Share Cards

- **Public scan URLs**: `/scan/:scanId` renders outfit + items + "Find my version" CTA
- **Share card generator**: Canvas API image — outfit photo, items, verdict, ATTAIR watermark.
  Optimized for Instagram stories (9:16). "Share Your Look" button → native share sheet.

### 11. Onboarding Compression

- Compress from 5→2 screens: (1) value prop + CTA, (2) camera/upload
- Post-first-scan: slide-up preference sheet (budget slider + fit chips only)
- "Style Fingerprint" summary card that feels personalized

---

## AGENT NOTES

**Execution order is CRITICAL. Do not skip ahead.**

**Phase 1 (FIRST — blocks Phase 3 and 4):**
  design-system-agent → Section 1. Commit + push when done.

**Phase 2 (IN PARALLEL with Phase 1 — no UI dependency):**
  ai-prompt-agent → Section 2 (claude.js prompt) + verdict migration
  backend-agent → Section 3 (all backend endpoints, sizes, pairings, feed, pricing)
  Commit + push each when done.

**Phase 3 (AFTER Phase 1 completes):**
  uiux-agent → Sections 4, 5 (scan flow, results overhaul, budget slider, circle tool)
  Commit + push when done.

**Phase 4 (AFTER Phase 1, can overlap with Phase 3):**
  social-feed-agent → Section 6 (home feed, user search)
  uiux-agent (or second pass) → Sections 7, 8, 9 (profile, history, likes)
  Commit + push each when done.

**Phase 5 (AFTER core flows work):**
  creative-build-agent → Sections 10, 11 (share links, cards, onboarding)
  Commit + push when done.

**Post-build (after all phases):**
  security-agent → audit all new endpoints and UI for vulnerabilities (REPORT ONLY)
  testing-agent → add tests for new endpoints, run full suite
  e2e-agent → test EVERY screen in dark + light at 390px, verify all buttons visible
  Commit + push when done.

**PM REMINDERS:**
  - Check inbox between EVERY agent dispatch
  - Commit + push after EACH agent finishes
  - design-system-agent MUST complete before any Phase 3/4 agent starts
  - Phase 2 backend/AI work can run in parallel with Phase 1
