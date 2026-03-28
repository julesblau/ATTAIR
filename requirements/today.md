# ATTAIR UI/UX Revamp — Requirements (Locked 2026-03-28)

## 1. Nav Bar
- 5 tabs: Feed | Search | [Scan] | Saved | Profile
- Instagram/TikTok-style bottom nav (reference those apps for look and feel)
- Scan button centered and flush with bar (NOT floating above)
- Text labels on all tabs
- Thumb-friendly tap targets (min 44px)
- Only 2 icons showing currently (heart + person) — must show all 5

## 2. Camera / Scan Entry
- Replace in-browser getUserMedia camera with native iOS camera picker (`<input type="file" accept="image/*" capture="camera">`)
- User takes photo or picks from camera roll via native UI
- Returns to our app -> show crop/edit screen (existing ReactCrop)
- Kill the janky in-browser camera entirely (remove getUserMedia, video element, camOn/camReady/camFacing state)
- Remove mystery button below camera viewfinder

## 3. Feed (Home Tab)
- Pure content feed — NO scan CTAs, no scan pages bleeding in
- Keep "For You" / "Following" sub-tabs
- New users: pre-seeded "For You" content (not empty state)
- Following tab for new users: "Follow people" prompt with suggested influencers list

## 4. Saved Tab
- Pinterest-style card grid layout
- Card flip animation — tap card, it flips to show scan info on back
- Content = user's scan history library
- Searchable (by clothing type, scan name, etc.)
- Public/private toggle per scan
- NOT rendering Home feed content (current bug)

## 5. Search Tab
- Product search + user/influencer search (dual purpose)
- Fix ghost search bar bleeding onto other tabs
- Clean, minimal search UI

## 6. Scan Results Flow (Post-Capture)
- Minimalist flow: pick items -> see matches -> done
- Budget setting = slider (NOT form input)
- Advanced filters (gender, body type, fit, market type) tucked behind expandable "Advanced" section
- Default flow = few taps, thumb-friendly
- Advanced = optional drill-down

## 7. Profile Tab
- Keep current layout (mostly solid)
- Fix hardcoded "ATTAIRE" username -> show actual user name
- Clean up bio to Instagram-style layout
- Fix stray vertical line

## 8. Global Requirements
- Updated logo (NOT old logo) — check public/ for logo options
- Updated color scheme
- Dark mode only (light mode -> backlog)
- Smooth animations throughout (CSS transitions, not janky)
- EVERY button, popup, modal, sheet must be thumb-friendly (min 44px touch targets)
- iPhone-first UX throughout

## 9. Verification Protocol
- Each feature: dev builds -> screenshot at 390x844 -> PM (me) reviews against this doc
- If it doesn't match requirement visually: reject, fix, re-screenshot, re-review
- No feature marked done until it passes visual review
- No cycle cap — loop until clean
- Only ping Jules when ALL features pass review

## Backlog (NOT this run)
- Light mode polish
- Ads/paywall screen updates
- Retailer Spotlight
- Dupe Alert
