## Build Queue — 2026-03-28

### Feature 1: TikTok-Speed Onboarding
**Screen:** Welcome/landing screen before auth
**Behavior:** 3-second looping animation showing: photo of outfit → AI identification overlay → shopping results. No text walls. Think Instagram Reels energy. Below animation: "Scan any outfit. Shop it instantly." + "Get Started" CTA.
**Files:** `client/src/pages/WelcomePage.tsx`, `client/src/components/onboarding/`
**Test:** New user lands on welcome, animation plays, CTA leads to app. Mobile-first.

### Feature 2: "Who Inspires You?" in Onboarding
**Screen:** Post-welcome, pre-app (after "Get Started" tap)
**Behavior:** Grid of style icons (celebrities, influencers) user taps to select 3+. Selections saved to user profile `style_inspirations` field. Used later for feed personalization + Style DNA.
**Files:** `client/src/pages/OnboardingPage.tsx`, `client/src/components/onboarding/InspirationPicker.tsx`
**Test:** Selections persist to Supabase. Can skip. Shows in profile settings after.

### Feature 3: Social Proof in Onboarding
**Screen:** Welcome page + throughout app
**Behavior:** Counter showing "X outfits scanned" (real number from DB). Example scan results carousel on welcome page showing real past scans (public ones). "Trusted by style hunters" social proof bar.
**Files:** `client/src/pages/WelcomePage.tsx`, `server/routes/stats.ts`
**Test:** Counter pulls real data. Carousel shows actual scan results.

### Feature 4: Seed Content for Following Tab
**Screen:** Following tab, Explore/discover
**Behavior:** Create 5-8 curated "style accounts" (e.g. "Street Style Daily", "Luxury Finds", "Vintage Vibes") with pre-loaded scan content. New users auto-follow 2-3 based on their inspiration picks. Feed feels alive day one.
**Files:** `server/scripts/seedContent.ts`, `client/src/pages/FollowingFeed.tsx`
**Test:** New user sees populated Following feed immediately after onboarding.

### Feature 5: Dupe Alert Pills
**Screen:** Scan results cards
**Behavior:** When search finds a similar item at 40%+ lower price from a different retailer, show a gold pill on the card: "Found for $47 at Zara". Compare against highest-priced match in same item group.
**Files:** `server/services/searchService.ts` (scoring), `client/src/components/scan/ResultCard.tsx`
**Test:** Upload a designer item, verify dupe pills appear on cheaper alternatives.

### Feature 6: Interactive Share Links (OG Meta)
**Screen:** Public scan page (`/scan/:id`)
**Behavior:** Proper Open Graph meta tags (title, description, image) so shared links render rich previews on iMessage, Instagram, Twitter, etc. Dynamic image = scan photo. Title = "Check out this look on ATTAIR". Description = item summary.
**Files:** `server/routes/scan.ts` (SSR meta), `client/index.html` (fallback meta)
**Test:** Share a scan link in iMessage/Slack, verify rich preview renders with image.

### Feature 7: Failed Scan Error Handling
**Screen:** Scan results page
**Behavior:** When identification returns 0 items OR all search queries fail: show friendly error with retry button + tips ("Try a clearer photo", "Make sure the outfit is visible"). No blank screens, no infinite spinners. Log failure reason server-side.
**Files:** `client/src/pages/ScanResultsPage.tsx`, `client/src/components/scan/EmptyState.tsx`
**Test:** Upload a non-clothing image (landscape), verify graceful error. Upload blurry photo, verify helpful message.

### Feature 8: Mobile Responsiveness Audit
**Screen:** All screens
**Behavior:** Full audit on iPhone SE (375px), iPhone 14 (390px), iPhone 14 Pro Max (430px). Fix overflow, touch targets < 44px, text truncation, bottom sheet heights, horizontal scroll issues. Feed cards, scan results, modals, auth screens.
**Files:** Various component files
**Test:** Every screen usable on 375px width. No horizontal scroll. All buttons tappable.

### Feature 9: Style DNA Report
**Screen:** New page `/style-dna`, accessible after 3+ scans
**Behavior:** Analyze user's scan history with Claude to generate: 4-word style summary (e.g. "Bold Minimal Street Luxe"), color palette, brand affinity, style breakdown chart (% casual, % formal, etc.). Shareable card with custom OG image. Prompt: "You've unlocked your Style DNA!"
**Files:** `server/routes/styleDna.ts`, `client/src/pages/StyleDnaPage.tsx`, `client/src/components/StyleDnaCard.tsx`
**Test:** User with 3+ scans gets accurate style analysis. Share card renders properly.