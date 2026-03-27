# Requirements — March 27, 2026 (Run 2: Full UI/UX Overhaul)

## Context
Run 1 today delivered: search algorithm refactor (synonyms, query builder, telemetry),
light mode CSS overhaul (280+ overrides), social profile features (bio, followers,
interests, visibility), 4 new test files (214 total passing), 5 security fixes.

ALREADY DONE — do NOT redo anything from standups/2026-03-24.md or standups/2026-03-27.md.
Run `git log --oneline -30` before starting.

---

## MISSION: Make ATTAIR feel like a world-class app

The app WORKS but looks and feels clunky. The goal of this run is a FULL visual and UX
overhaul. Think TikTok, Instagram, GOAT, Depop. Trendy, fun, dead-simple, beautiful.
Every screen should be immediately obvious to a first-time user.

---

## 1. LIGHT MODE — Buttons and Interactive Elements Are Invisible

The light mode overhaul from Run 1 fixed backgrounds and text but BUTTONS ARE INVISIBLE.
They don't change color with the theme — same dark color on a light background = can't see them.

### Fix:
- Audit EVERY button, toggle, chip, tab, and interactive element in light mode
- Buttons must have proper contrast in BOTH modes:
  - Primary buttons: solid accent color with white text (both modes)
  - Secondary buttons: outlined with visible border (both modes)
  - Tab indicators, active states, selected chips must all be visible
- Test at 390px width. Screenshot every screen in light mode and verify.

---

## 2. FULL UI/UX REDESIGN — Make It Intuitive

The app is information-dense and hard to follow. A user should be able to look at any
screen and immediately know what to do.

### Design Principles (apply to EVERY screen):
- **Visual hierarchy**: Most important action is the biggest, most colorful thing
- **Breathing room**: More whitespace between sections. Don't cram everything together.
- **Card-based layout**: Group related info into clean cards with rounded corners and subtle shadows
- **Consistent color language**: One accent color for actions, grays for secondary, red for destructive
- **TikTok/Instagram feel**: Dark mode should feel sleek and premium. Light mode should feel clean and airy.
- **Icons over text** where possible — universal language
- **Progressive disclosure**: Don't show everything at once. Expand on tap.

### Color Palette Refresh:
- Primary accent: Keep the gold/coral (#C9A96E) but make it pop more
- Dark mode: True black backgrounds (#000) with elevated cards (#1a1a1a)
- Light mode: Off-white (#F8F8FA) with white cards and soft shadows
- Success: Green. Error: Red. Info: Blue. These should be consistent app-wide.

### Typography:
- Headlines: Bold, large, confident
- Body: Clean, readable, not too small (min 14px)
- Labels/captions: Gray, subtle, 12px

---

## 3. SCAN & IDENTIFICATION UX — Guide the User

The scan/identify flow is confusing. Users don't know how to best use it.

### Improvements:
- **Clear CTA on home**: Big, obvious "Scan an Outfit" button with a camera icon
- **Upload vs Camera**: Two clear options — "Take Photo" and "Upload from Gallery"
- **Scan preview**: After selecting a photo, show it large with a "Scan This" confirmation button
- **Loading state**: Fun, branded animation during AI identification (not just a spinner)
- **Results preview**: Show identified items as they come in, not all at once after a long wait
- **Gender display**: Show the detected gender (Men's/Women's) prominently on the results screen
  so users know the search context. Allow them to toggle it if wrong.

---

## 4. CIRCLE-TO-SEARCH — Modernize the Drawing UI

The circle drawing tool looks outdated. Make it feel like iOS markup / Instagram stories.

### Changes:
- **Stroke style**: Smooth, glowing neon line (not a basic solid color)
- **Color**: Bright accent color that contrasts with any photo (white glow + colored core)
- **Animation**: Subtle pulse/glow after completing the circle
- **Thickness**: Thicker line (3-4px minimum) so it's visible on small screens
- **Feel**: Should feel like you're using a highlighter pen, not MSPaint

---

## 5. HISTORY — Click Into Old Scans

Users should be able to browse their scan history and tap into any old scan to see full results.

### Requirements:
- History list shows scan thumbnail, date, summary, item count
- Tap a scan → opens the full results screen with all identified items and product tiers
- Re-search button: "Search again" to re-run product search with current preferences
- Delete scan option (swipe to delete or long-press menu)

---

## 6. SETTINGS & PROFILE — TikTok-Style Layout

The settings/profile page looks terrible. Redesign it to feel like TikTok/Instagram profile.

### Layout:
- **Profile header**: Avatar (or initial), display name, bio, follower/following counts
- **Stats row**: Scans count, Likes count, Collections count (like TikTok's posts/followers/likes)
- **Grid below**: User's public scans as a photo grid (like Instagram profile grid)
- **Settings gear icon** → slides out a clean settings panel:
  - Theme toggle (dark/light)
  - Language selector
  - Budget preferences
  - Size preferences
  - Subscription status
  - Sign out

---

## 7. LIKES PAGE — Clean Up the Clutter

The likes/saved items page is clunky. Simplify it.

### Changes:
- Clean grid of saved items (2-column, Pinterest-style)
- Each card: product image, brand, price, heart icon to unlike
- Filter chips at top: All, by Category, by Price range
- Empty state: Friendly illustration + "Start scanning to save items you love"
- Remove any confusing collection/wishlist UI that adds friction

---

## 8. BUDGET SELECTION — iPhone-Friendly Slider

Typing numbers for budget is terrible on mobile. Replace with a range slider.

### Implementation:
- Dual-thumb range slider for min/max budget
- Preset chips: "$" (under $50), "$$" ($50-150), "$$$" ($150-500), "$$$$" ($500+)
- Tapping a preset sets the slider range
- Custom range via slider drag
- Show selected range as "$50 - $150" below the slider
- Apply everywhere budget is set: onboarding, settings, per-item override

---

## 9. AI IDENTIFICATION — Focus on Clear Items Only

The identification algorithm tries too hard to find every little thing in the photo.
It should focus on items that are CLEARLY visible unless the user specifically circles something.

### Changes to claude.js prompt:
- Default behavior: Only identify items where 70%+ of the garment is visible (was 50%)
- If user drew a circle: identify the circled item regardless of visibility percentage
- Maximum 4-5 items per scan (not 8+). Quality over quantity.
- Don't identify socks, undershirts, or barely-visible accessories unless circled
- The prompt should say: "Focus on the 3-5 most prominent, clearly visible garments.
  Ignore partially hidden items, undergarments, and small accessories."

---

## 10. SEARCH — User Can Pass Info to AI

Let users give the AI additional context about what they're looking for, beyond just
style/fit/occasion. A free-text field where they can say things like:
- "I think this is from Zara's new collection"
- "Looking for a cheaper alternative"
- "I want this in blue instead"
- "This is a vintage piece, find something similar"

### Implementation:
- Text input field on the results screen: "Tell us more about what you're looking for..."
- Pass this as `search_notes` to the findProducts API (already supported!)
- Show it as an editable pill/chip so the user can modify or remove it
- This should trigger a re-search with the updated notes

---

## 11. SIZE-AWARE SEARCH — Know What Sizes Apply to What

When scanning a hat, there's no "size Large" — hats have S/M/L or fitted sizes.
Shoes have numeric sizes. Pants have waist/length. The app needs to know this.

### Implementation:
- Category-aware size prompting on results screen:
  - Hats: "One size" / "S/M/L" / "Fitted (7 1/4)"
  - Shoes: Numeric size with half-sizes
  - Tops: XS/S/M/L/XL/XXL
  - Pants: Waist + Length (32x30)
  - Dresses: 0-20 or XS-XXL
- Show the appropriate size selector based on the item category
- Pass size to search query for better results
- Save preferred sizes per category in profile

---

## 12. HOME SCREEN — Social Discovery Feed

Now that there's a social aspect, the home screen should engage users with content
from people they follow. Think Instagram/TikTok home feed.

### Layout:
- **Top section**: "Scan an Outfit" CTA (always prominent)
- **Below**: "From People You Follow" feed showing public scans
  - Each card: outfit photo, user avatar + name, scan summary, item count
  - Tap → view their scan results
  - Heart/like button on each
- **If not following anyone**: Show trending/popular public scans as discovery
- **User search**: Search bar to find other users by display name
- Keep it simple — this is v1 of the social feed

---

## 13. COMPLETE THE LOOK — Real Product Images

The "Complete the Look" / pairings feature uses emojis instead of real product images.
Replace emojis with actual product images from the search results.

### Changes:
- When suggesting pairings, also run a quick product search for each suggestion
- Show the top result's image instead of an emoji
- Each pairing card: product image, name, price, "Shop" button
- If no product image found, use a clean category icon (not emoji)

---

## 14. MORE RESULTS — Horizontal Scroll

Currently showing only 2 results per tier. Show more and let users swipe through them.

### Changes:
- Each tier (Budget/Mid/Premium) becomes a horizontal scrollable row
- Show 4-6 results per tier (load more available)
- Swipe left/right to browse
- Each product card: image, brand, price, "Shop" link
- Active card is slightly larger/elevated

---

## 15. PRICING CONSISTENCY

The standup flagged: Upgrade Modal shows $29.99/yr ($4.99/mo), Paywall shows $39.99/yr ($9.99/mo).

### Correct pricing: $4.99/month, $29.99/year. Fix everywhere.

---

## 16. CREATIVE BACKLOG — Implement Priority 1 Ideas

From creative-backlog.md, implement ALL Priority 1 items:

### [3] Scan-to-Share Deep Link
- Public scan URLs: `attair.vercel.app/scan/:scanId`
- Backend: `GET /api/scan/:scanId/public` returns scan data if visibility="public"
- Frontend: Minimal public scan view, share sheet integration, "Find my version" CTA

### [1] Outfit Verdict + Share Card
- Replace 1-5 star rating with verdict system: "Would Wear" / "On the Fence" / "Not for Me"
- Canvas API shareable image card (outfit photo + items + verdict + ATTAIR wordmark)
- "Would Wear" auto-saves to Likes

### [6] Style Fingerprint Onboarding
- Compress onboarding from 5→2 screens (value prop + scan)
- Post-first-scan preference collection (budget + fit only)
- Visual "Style Fingerprint" summary card

### [4] Budget Tracker + Tier Mixer
- Outfit-level budget view in Likes tab
- Tap scan group → expand to Budget/Mid/Premium cost bars
- Users swap tiers per item, see running total
- "Buy the look" CTA opens affiliate links
- Tier mixing is PRO-ONLY gate

---

## AGENT NOTES

**PM:** This is a DESIGN-HEAVY run. Prioritize visual quality over feature count.

  Phase 1: Visual foundation — light mode buttons fix, color palette, typography,
    card system, whitespace (Sections 1, 2)
  Phase 2: Core UX — scan flow, circle tool, history, results with more products
    and horizontal scroll (Sections 3, 4, 5, 14)
  Phase 3: Feature polish — budget slider, size-aware search, AI focus tuning,
    user search notes, gender display (Sections 8, 9, 10, 11)
  Phase 4: Social & pages — home feed, profile redesign, likes cleanup,
    settings, pricing fix (Sections 6, 7, 12, 15)
  Phase 5: Creative backlog — share links, verdict cards, onboarding,
    budget tracker (Section 16)
  Phase 6: Complete the look real images, pairings product search (Section 13)

  Commit and push after EACH agent completes. Do NOT wait until the end.
  Check inbox between every agent dispatch.

**design-system-agent (NEW):** You own Sections 1 and 2. Establish the visual foundation
  that ALL other agents build on top of. Do this FIRST before anyone else touches UI.
  - Fix every button/interactive element for light mode visibility
  - Implement the color palette, typography scale, card system, spacing
  - Create CSS custom properties that other agents can reference
  - Document the design tokens in a comment block at the top of App.css

**uiux-agent:** You own Sections 3, 4, 5, 6, 7, 8, 14.
  WAIT for design-system-agent to finish before starting.
  Use the design tokens the design-system-agent establishes.
  - Scan flow UX improvements (Section 3)
  - Circle-to-search modernization (Section 4)
  - History click-through to old scans (Section 5)
  - Profile/settings TikTok-style redesign (Section 6)
  - Likes page cleanup (Section 7)
  - Budget slider (Section 8)
  - Horizontal scroll results with more products (Section 14)

**backend-agent:** You own Sections 10, 11, 13, 16 backend work.
  - Search notes UI integration (ensure findProducts handles search_notes — already does)
  - Category-aware size mapping for search queries (Section 11)
  - Public scan endpoint for share links: GET /api/scan/:scanId/public (Section 16)
  - Pairings product search — run findProducts for each pairing suggestion (Section 13)
  - Fix pricing to $4.99/mo, $29.99/yr everywhere in backend (Section 15)

**social-feed-agent (NEW):** You own Section 12.
  - Home screen social feed from followed users' public scans
  - User search/discovery
  - "Trending" fallback when not following anyone
  - Backend: GET /api/feed (public scans from follows, paginated)
  - Backend: GET /api/users/search?q=name

**ai-prompt-agent (NEW):** You own Sections 9 and 10.
  - Tune the Claude identification prompt to focus on 3-5 clear items (Section 9)
  - Raise visibility threshold to 70% (unless circled)
  - Ensure gender is returned prominently and displayed on frontend
  - Wire up search_notes field in frontend UI (Section 10)
  - Verdict system: add verdict column to scans, build verdict UI (Section 16 [1])

**creative-build-agent (NEW):** You own Section 16 frontend work.
  - Scan-to-Share deep link page (Section 16 [3])
  - Style Fingerprint onboarding (Section 16 [6])
  - Budget Tracker + Tier Mixer in Likes (Section 16 [4])
  - Share card Canvas API generator (Section 16 [1])

**Quant agent:** Light day. Verify search still works after any backend changes.
  Help with Section 13 — pairings need product search integration.

**Security agent:** REPORT ONLY. Check new social feed endpoints, public scan endpoint,
  user search for data leaks and auth gaps.

**Testing agent:** Add tests for new endpoints (feed, user search, public scan).
  Run full suite after all agents complete.

**E2E agent:** Test EVERY screen in both dark and light mode at 390px.
  Verify buttons are visible, flows are intuitive, no dead clicks.
