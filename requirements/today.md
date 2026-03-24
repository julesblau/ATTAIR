# Requirements — March 25, 2026

## Context from yesterday's run (March 24)
The agent army completed a full run: 133 tests passing, 13 files changed/created,
5 security fixes applied, all core features verified working. See standups/2026-03-24.md
for the full report.

ALREADY DONE — do NOT redo:
- Circle to Search (default ON, glow animation, canvas overlay) ✅
- Pairings visual grid (Pinterest-style 2-column) ✅
- Scan streak counter + GET /api/user/streak ✅
- Identification preview chips during search wait ✅
- Trial flow (start trial button + countdown badge) ✅
- Banner ad polish (Featured card with gradient border) ✅
- iPhone camera mirror fix ✅
- Referral code card with copy/share ✅
- BEST VALUE pill shadow ✅
- Search notes input wired end-to-end ✅
- Last-seen timestamps on saved items ✅
- Scan rename inline edit ✅
- OCCASION_MODIFIERS expanded (wedding, date, beach, smart_casual, festival) ✅
- MIME validation on uploads ✅
- Prompt injection caps on refineItem ✅
- Scan ownership check ✅
- Field length caps ✅
- Occasion allowlist ✅
- Pairings affiliate tracking through /api/go ✅

IMPORTANT: Read standups/2026-03-24.md and run `git log --oneline -30` before
starting. Do NOT rebuild anything listed above.

---

## 1. CORS VERIFICATION — Test the Live Flow

CORS_ORIGINS is already set to https://attair.vercel.app in Railway.
The code has a CORS_ORIGINS env var mechanism. Today's job:

- Read the CORS config in index.js — understand exactly how CORS_ORIGINS is used
- Verify the current deployed code on Railway respects CORS_ORIGINS when set
- If the code still reflects any origin regardless of CORS_ORIGINS: fix the logic
  so it uses the allowlist when the env var is present, falls back to permissive
  only when CORS_ORIGINS is not set (local dev)
- DO NOT break local development — localhost must still work
- DO NOT break the live app — test carefully

---

## 2. REDESIGN SAVED ITEMS + WISHLIST — New "Likes" System

The current Saved → Wishlist flow is confusing and buried. Rethink it entirely.

### The Problem
- Saved items are buried 2 taps deep inside the History tab
- "Wishlist" is a second concept layered on top of "Saved" — users don't think this way
- When you see something you like, your brain just says "want" — not "save to general
  pool, then organize into named list." That's filing cabinet logic, not shopping logic.
- Every top fashion app (GOAT, Depop, Pinterest) gives saves a primary nav slot

### The New Design: "Likes" Tab

**Bottom navigation:** Add a 4th tab — a heart icon labeled "Likes"
(replaces the current buried saved items flow)

**One-tap save:** Every product card gets a heart icon. One tap = saved.
No modal, no "which wishlist?", no friction. Just ❤️.

**Smart auto-organization inside Likes tab:**
- Items auto-group by the scan they came from ("From your March 22 scan")
- Show the original outfit photo as the group header
- Within each group, product cards in a clean grid
- Price drop indicators on items create urgency (prep for future price tracking)
- "Saved 2 days ago" relative timestamps on each item

**Optional collections (replaces "Wishlist"):**
- Long-press or swipe on any liked item → "Add to collection"
- Create named collections: "Summer wedding", "Gift ideas for Mom", etc.
- Collections are OPTIONAL — the default Likes feed works perfectly without them
- Collections appear as horizontal scrollable chips at the top of the Likes tab

**What to remove:**
- Remove the old "Wishlist" terminology everywhere — it's now "Collections"
- Remove any UI that forces users to pick a wishlist before saving
- Remove saved items from inside the History tab (they live in Likes now)

**Backend:**
- The existing wishlist CRUD routes can be reused — just rename the concept
- saved_items table stays as-is, it's the backend for "Likes"
- Wishlists become "Collections" — same table, new name in the UI

**The feel:** Instagram saves meets Pinterest boards, but the app organizes for you.

---

## 3. FIX LIGHT MODE — Make It Beautiful

Light mode exists but looks broken. We are COMMITTING to fixing it properly.
Do NOT remove it. Make it look great.

### Approach:
- Audit every component, card, modal, button, input, and text element in light mode
- Create a proper light mode color palette:
  - Backgrounds: clean whites and light grays (not pure #fff everywhere)
  - Text: dark grays (#1a1a1a for primary, #666 for secondary)
  - Cards: white with subtle shadows (not borders)
  - Accent colors: keep the same coral/orange brand colors
  - Inputs: light gray backgrounds with subtle borders
- Fix contrast issues — every text element must pass WCAG AA contrast ratio
- Light mode should feel as polished as dark mode — same attention to detail
- Test at 390px width in both modes
- The toggle should be in Settings/Profile and persist via localStorage

---

## 4. SECURITY QUICK WINS

These are code-level fixes from yesterday's security audit:

### 4a. Add requireAuth to seenOn and nearbyStores
Both routes are callable without authentication, meaning anyone can burn our
SerpAPI credits anonymously.
- Add `requireAuth` middleware to `GET /api/seen-on` and `GET /api/nearby-stores`
- These routes should require a logged-in user

### 4b. Validate size_prefs JSONB schema
The `size_prefs` field is written to the DB without validation. Add a simple
schema check before writing:
- Must be an object (not array, not string)
- Only allow known keys: body_type, fit_style, shoe_size, top_size, bottom_size, dress_size
- Values must be strings, max 50 chars each
- Silently strip unknown keys (don't reject — old app versions may send different shapes)

### 4c. Stripe webhook error handling
The webhook handler swallows errors — if a checkout.session.completed event fails
to upgrade the user, it's permanently lost. Add:
- Log the full error (console.error with the session ID)
- Return 500 (not 200) so Stripe retries the webhook
- Consider writing failed events to a dead-letter table if one exists

---

## 5. i18n AUDIT — Verify Full Coverage

The i18n system was built in a previous run. Today:
- Switch to each of the 8 languages (EN, ES, FR, DE, ZH, JA, KO, PT)
- Check EVERY screen for untranslated English strings
- Fix any missing translations
- The `t` variable shadowing bug was fixed yesterday — verify it stays fixed
- Any NEW UI elements added today (Likes tab, collections, etc.) must have
  full translations in all 8 languages from the start

---

## 6. FIX & UPGRADE "NEARBY STORES"

The "Find Near Me" / nearby stores feature exists but is broken — sometimes returns
nothing, sometimes says "not authorized."

### Debug & Fix:
- Read the GET /api/nearby-stores route end-to-end
- Identify WHY it fails (likely: missing auth since requireAuth wasn't on it,
  or SerpAPI query isn't constructed well, or location isn't being passed correctly)
- After adding requireAuth (section 4a), make sure the frontend passes the auth token
- Make sure the frontend properly requests location permission (navigator.geolocation)
  and passes lat/lng to the API
- Test with a real location — it should return actual stores (not empty)

### UI:
- "Find Near Me" button on product result cards
- On tap: request location if not already granted, show a loading state,
  then display a clean list of stores with name, distance, and address
- If no stores found: show a helpful empty state ("No stores nearby carry this item.
  Try shopping online →" with a link to the product)
- If location denied: explain why location is needed, don't just silently fail

---

## 7. UPGRADE "AS SEEN ON" — Influencer & Celebrity Discovery

The current "Seen On" feature does a basic celebrity search but it's underwhelming.
This should be a KILLER feature — fashion is driven by who's wearing what.

### The Vision:
Users want to know: "Who's worn something like this?" — and not just A-list celebs.
They want TikTokers, Instagram influencers, athletes, YouTubers, K-pop stars, actors.
The results should feel like a curated style feed, not a dry list.

### Onboarding: User Interest Profiles
Add an optional interests step during signup (or first scan) — a quick, fun picker:

**Frontend (signup flow or first-scan prompt):**
- After sign-up (or as a skippable card on first app open), show:
  "Who inspires your style?" with a grid of tappable category chips:
  - 🎬 Actors & Actresses
  - 🎵 Musicians & K-Pop
  - 🏀 Athletes
  - 📱 TikTok Creators
  - 📸 Instagram Influencers
  - 🎮 Streamers & YouTubers
  - 👗 Fashion Icons & Models
  - 🌍 Street Style
- User taps 1-5 categories they care about
- Store as `style_interests` array on the profiles table (text[] or JSONB)
- This is SKIPPABLE — if they skip, default to all categories
- They can change it later in Profile/Settings

**Backend (upgrade GET /api/seen-on):**
- Accept the user's `style_interests` from their profile
- Use interests to tailor the search query — e.g., if user selected "Athletes"
  and "TikTok Creators", search for athletes and TikTokers wearing the item,
  not just generic "celebrity wearing [item]"
- The quant agent should optimize the SerpAPI query construction:
  - Current: probably just "celebrity wearing [item name]"
  - Better: "[interest category] wearing [item] [brand]" with multiple queries
    for each interest, merged and deduplicated
  - Even better: for each result, try to identify WHO the person is and WHAT
    platform they're known on (TikTok, Instagram, NBA, etc.)
- Return structured results: { name, platform, image_url, context, source_url }

**Frontend (results display):**
- Don't just show a text list. Show a visual card for each sighting:
  - Person's photo or the photo of them wearing the item
  - Their name and platform badge (🎵 TikTok, 📸 Instagram, 🏀 NBA, etc.)
  - Brief context ("Spotted at Coachella 2026", "Wore this on her latest TikTok")
  - Link to the source
- This should feel like browsing a style magazine, not reading a database
- Consider making this a swipeable horizontal carousel on product cards

---

## 8. CUSTOM OCCASION TYPES — Let Users Define Their Own

The occasion picker currently has a fixed set (work, date, wedding, beach, etc.).
Users should be able to ADD THEIR OWN occasions and let the AI figure out how
to search for them.

### Frontend:
- Add a "+ Custom" chip at the end of the occasion picker
- Tapping it opens a small input: "What's the occasion?" with placeholder
  "e.g., 'job interview at a tech startup', 'rooftop brunch', 'ski trip'"
- User types their custom occasion and it becomes the selected occasion
- Save custom occasions to localStorage so they appear as recent/quick picks
  next time (max 5 recent custom occasions)

### Backend:
- The findProducts route already accepts an `occasion` string
- If the occasion doesn't match a known key in OCCASION_MODIFIERS, instead of
  silently nulling it out (current behavior), send it to Claude:
  - Quick prompt: "The user is shopping for an outfit for: '[custom occasion]'.
    Generate 3-5 search modifier keywords that would help find appropriate
    clothing on Google Shopping. Return only the keywords, comma-separated."
  - Use Claude's response as the occasion modifier for the search query
  - Cache the result (custom_occasion_string → modifier_keywords) in memory
    or product_cache so we don't re-prompt Claude for the same occasion
- This means ANY occasion works: "cousin's quinceañera", "first day at Goldman Sachs",
  "Burning Man", "parent-teacher conference" — Claude figures out the right
  search terms automatically

### Why This Matters:
The fixed occasion list is limiting. Fashion is contextual and personal. A user
shopping for "rooftop brunch in Miami" needs very different results than "rooftop
brunch in London." Letting Claude interpret the occasion makes the search feel
magical and personalized — like having a personal stylist who actually understands
the vibe you're going for.

---

## 9. SOCIAL PROFILES — Follow, Share, Discover

Users should be able to follow each other and see what people they follow have
scanned, liked, and collected. Everything is public/private toggleable.

### The Vision
ATTAIR becomes a social fashion discovery platform, not just a personal tool.
When someone finds a great outfit match, their friends see it. When someone
curates a killer collection, others can browse it. This is the viral loop.

### Backend (database + API):
- **follows table:** `follower_id, following_id, created_at` with unique constraint
- **Privacy column on scans:** Add `visibility` to scans table: `'public'` | `'private'` | `'followers'` (default: `'private'`)
- **Privacy column on saved_items:** Add `visibility` to saved_items: `'public'` | `'private'` (default: `'private'`)
- **Privacy column on wishlists (collections):** Add `visibility`: `'public'` | `'private'` (default: `'private'`)
- **Public profile data on profiles:** Add `bio` (text, max 200 chars), `display_name` (text, max 50 chars)
- **API routes:**
  - `POST /api/follow/:userId` — follow a user (requireAuth)
  - `DELETE /api/follow/:userId` — unfollow (requireAuth)
  - `GET /api/followers/:userId` — list followers
  - `GET /api/following/:userId` — list who a user follows
  - `GET /api/profile/:userId` — public profile (scans, likes, collections filtered by visibility)
  - `PATCH /api/scans/:scanId/visibility` — toggle scan visibility
  - `PATCH /api/saved-items/:itemId/visibility` — toggle item visibility
  - `PATCH /api/collections/:collectionId/visibility` — toggle collection visibility

### Frontend:
- **Profile page:** Display name, bio, follower/following counts, grid of public scans
  - Each scan shows the outfit photo as a card; tap to see the results
  - Public likes shown in a separate tab on the profile
  - Public collections shown as browsable boards
- **Follow button** on any user's profile (follow/unfollow toggle)
- **Privacy toggles:**
  - On each scan card: tap "..." → "Make Public" / "Make Private" / "Followers Only"
  - On each liked item: long-press → visibility toggle
  - On each collection: settings icon → visibility toggle
  - Default for everything is PRIVATE — users opt-in to sharing
- **Feed / Discovery:**
  - In the Likes tab or a new "Discover" section: show public scans/collections
    from people you follow
  - This is NOT a priority for today — just build the data model and basic
    profile page. Feed can come next run.

### What NOT to build today:
- Full social feed / timeline (just the data model + profile page)
- Direct messaging
- Notifications for new followers (future)
- Search/discover users (future — for now, share profile links)

### Why This Matters:
Fashion is inherently social. The viral loop is: scan outfit → get results →
share your scan → friends follow you → they discover ATTAIR → they scan their
own outfits. Every social feature multiplies our user acquisition.

---

## 10. STRIPE CHECKOUT — Now Live

Stripe keys are configured in Railway. The backend already has webhook handling
code. Today's job: verify it works end-to-end.

- **Env vars set:** `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_MONTHLY`, `STRIPE_PRICE_YEARLY`
- **Pricing:** $4.99/month, $29.99/year
- **Webhook URL:** `https://attair-production.up.railway.app/api/stripe/webhook`
- **Events:** `checkout.session.completed`, `customer.subscription.updated`, `customer.subscription.deleted`

### Backend:
- Verify the checkout session creation route uses `STRIPE_PRICE_MONTHLY` and `STRIPE_PRICE_YEARLY` env vars
- Verify the webhook handler correctly processes `checkout.session.completed` → upgrades user to pro
- Verify subscription cancellation/update events are handled
- The webhook error handling fix from section 4c applies here — make sure errors return 500

### Frontend:
- The trial/subscription UI exists — verify the "Subscribe" buttons create checkout sessions
- Show correct pricing: "$4.99/mo" and "$29.99/yr (save 50%)"
- After successful checkout, user should see pro status immediately
- Test with Stripe test card: `4242 4242 4242 4242` (any future exp, any CVC)

---

## 11. REMAINING HALF-DONE FEATURES (OAuth)

### Google / Apple OAuth
- Buttons exist in the frontend. Test if they actually work.
- If broken: fix redirect URL configuration in Supabase dashboard settings
- Document any Supabase config changes needed (don't guess — note what needs manual setup)

---

## 11. OUT OF SCOPE TODAY
- RevenueCat / AdMob / Capacitor (needs native app setup)
- App.jsx full refactor (separate day)
- Price drop alerts (future feature, but Last Seen timestamps are ready)

---

## 13. AGENT NOTES

**PM:** Today has 3 phases:
  Phase 1: Quick wins — CORS verification, security fixes, i18n audit (sections 1, 4, 5)
  Phase 2: Major build — Likes tab redesign (section 2) + light mode fix (section 3)
    + nearby stores fix (section 6) + as-seen-on upgrade (section 7) + custom occasions (section 8)
    + social profiles with follow/privacy (section 9) + Stripe checkout (section 10)
  Phase 3: Creative agent run — after push, let the creative agent analyze and propose
  Work in order. Push only after E2E confirms. Then run creative agent.

**Backend agent:**
  - CORS logic fix if needed (section 1)
  - requireAuth on seenOn/nearbyStores (4a)
  - size_prefs validation (4b)
  - Stripe webhook error handling (4c)
  - Support any new backend needs for the Likes redesign (section 2)
  - Debug & fix GET /api/nearby-stores — auth, SerpAPI query, location passing (section 6)
  - Upgrade GET /api/seen-on — accept style_interests, tailor SerpAPI queries per
    interest category, return structured results with name/platform/image/context (section 7)
  - Add style_interests column to profiles table (text[] or JSONB) (section 7)
  - Custom occasion Claude interpretation in findProducts — if occasion not in
    OCCASION_MODIFIERS, prompt Claude for search keywords, cache result (section 8)
  - Social: follows table, visibility columns on scans/saved_items/wishlists,
    bio + display_name on profiles, all follow/unfollow/profile API routes (section 9)
  - Stripe: verify checkout session creation uses env var price IDs,
    webhook handles checkout.session.completed → pro upgrade,
    webhook returns 500 on error (not 200) (section 10)

**UI/UX agent:** Your MAIN job today is the Likes tab redesign (section 2).
  This is the biggest change. Make it feel like Instagram saves meets Pinterest.
  - Build the new Likes bottom nav tab
  - One-tap heart on all product cards
  - Auto-grouping by scan
  - Optional collections (long-press to organize)
  - Remove old Wishlist terminology
  - Fix light mode comprehensively (section 3)
  - "Find Near Me" button on product cards with location permission flow,
    loading state, store list, and empty/denied states (section 6)
  - User interest picker at signup/first-scan — "Who inspires your style?"
    grid of tappable category chips, store as style_interests (section 7)
  - As-seen-on visual cards — person photo, name, platform badge, context,
    source link; consider horizontal carousel on product cards (section 7)
  - "+ Custom" chip in occasion picker with text input, save recent custom
    occasions to localStorage (max 5) (section 8)
  - Social profile page — display name, bio, follower/following counts,
    public scans grid, public likes tab, public collections (section 9)
  - Follow/unfollow button on profiles (section 9)
  - Privacy toggles on scans, liked items, and collections —
    "..." menu → "Make Public" / "Private" / "Followers Only" (section 9)
  - Stripe: verify Subscribe buttons create checkout sessions with correct
    prices ($4.99/mo, $29.99/yr "save 50%"), test card works (section 10)
  - Ensure all new UI has i18n translations in all 8 languages
  - Test at 390px width in both dark and light mode

**Quant agent:** Busy day:
  - Verify search quality hasn't regressed from yesterday's OCCASION_MODIFIERS changes
  - Optimize SerpAPI query construction for as-seen-on (section 7):
    multiple queries per interest category, merge & deduplicate, identify
    person name and platform from results
  - Validate that custom occasion → Claude → search keywords produces good
    Google Shopping results (section 8) — test 3-4 custom occasions

**Security agent:** REPORT ONLY. Verify yesterday's 5 fixes are still in place.
  Check for any new issues introduced by today's changes.
  Pay special attention to: custom occasion prompt injection risk (section 8),
  nearby-stores auth now requiring token (section 6),
  follow/profile routes require auth (section 9),
  visibility checks — private content must NOT leak to non-followers (section 9).

**Testing agent:** Run all 133 tests first. Then add tests for:
  - Likes/collections CRUD operations
  - size_prefs validation
  - requireAuth on seenOn/nearbyStores
  - Light mode CSS custom properties (if testable)
  - Nearby stores with/without auth token (section 6)
  - As-seen-on with style_interests filtering (section 7)
  - Custom occasion → Claude modifier generation (section 8)
  - style_interests profile CRUD (section 7)
  - Follow/unfollow CRUD (section 9)
  - Profile visibility filtering — private items hidden from non-followers (section 9)
  - Visibility toggle on scans, saved items, collections (section 9)

**E2E agent:** Critical checks:
  - Likes tab exists in bottom nav and works
  - One-tap heart saves items
  - Collections can be created, items added/removed
  - Old wishlist references are gone
  - Light mode looks polished on every screen
  - Dark mode hasn't regressed
  - CORS works on live Vercel → Railway
  - All 8 languages have no untranslated strings
  - 133+ tests still passing
  - No console errors on any screen
  - "Find Near Me" shows stores or proper empty/denied state (section 6)
  - As-seen-on returns visual cards with platform badges (section 7)
  - Interest picker appears at signup and persists to profile (section 7)
  - Custom occasion input works and produces relevant search results (section 8)
  - Profile page renders with public scans, likes, collections (section 9)
  - Follow/unfollow works, follower counts update (section 9)
  - Privacy toggles work — private items invisible to others (section 9)
  - Cannot see private scans/items of users you don't follow (section 9)

**Creative agent:** After everything is pushed, analyze the app fresh.
  Focus especially on:
  - How does the new Likes tab FEEL? What would make it addictive?
  - What's the viral loop? How does someone discover ATTAIR and tell a friend?
  - What monetization angles are we missing?
  - How does the interest-based as-seen-on feel? Is it compelling enough to share?
  - How does the social layer feel? What would make people WANT to share their scans?
  - What's the onboarding funnel? How does someone go from "I just found this app"
    to "I've scanned 5 outfits and followed 3 friends" in under 10 minutes?
  - What would make this app #1 in the fashion category on the App Store?
