# Creative Backlog — Approved Ideas

> Ideas proposed by the creative agent, filtered by PM, pending Jules approval.
> The agent army implements these alongside today.md requirements.
> Remove items after they're built.

## Priority 1 — Next Run

### [3] Scan-to-Share Deep Link
**Status:** APPROVED (2026-03-27) — implementing this run
**Effort:** M (1 backend + 1 frontend task)
**Summary:** Shareable public scan URLs (`attair.vercel.app/scan/:scanId`). Public scans render outfit image + identified items + "Find my version" CTA. Viewers tap CTA → enter scan flow → highest-quality acquisition. Native share sheet integration.
**Backend:** New route `GET /api/scan/:scanId/public` returns scan data if visibility="public"
**Frontend:** Minimal public scan view component (works without auth), share URL construction, share sheet integration
**Why:** This IS the viral loop. Without shareable scans, there is no word-of-mouth. Every shared scan is an acquisition funnel.

### [1] Outfit Verdict + Share Card
**Status:** APPROVED (2026-03-27) — implementing this run
**Effort:** S-M (mostly frontend)
**Summary:** Replace silent 1-5 star rating with named verdict system ("Would Wear" / "On the Fence" / "Not for Me") with distinct animations. "Share Verdict" generates a Canvas API shareable image card (outfit photo + items + verdict + ATTAIR wordmark) for TikTok/Instagram screenshots.
**Backend:** Add `verdict` column to scans (enum), or repurpose existing `rating`
**Frontend:** Verdict bar on results screen, Canvas share card generator, "Would Wear" auto-collection in Likes
**Why:** The TikTok screenshot moment. Zero backend cost, pure viral surface area.

### [6] Style Fingerprint Onboarding
**Status:** APPROVED (2026-03-27) — implementing this run
**Effort:** S (frontend only)
**Summary:** Compress pre-scan onboarding from 5→2 screens (value prop + scan). Move preference collection to post-first-scan slide-up sheet (budget range + fit preference only). Show visual "Style Fingerprint" summary card.
**Frontend:** Shorten OB_STEPS, add post-scan preference sheet, Style Fingerprint card component
**Why:** Fix the funnel. Users drop off before experiencing the product. Post-scan preference collection is proven (Spotify, Netflix).

### [4] Budget Tracker + Tier Mixer
**Status:** APPROVED (2026-03-27) — implementing this run
**Effort:** S (frontend only)
**Summary:** Outfit-level budget view in Likes tab. Tap scan group header → expand to show Budget/Mid/Premium cost bars. Users swap tiers per item, see running total. "Buy the look" CTA opens affiliate links. Tier mixing is PRO-ONLY gate.
**Frontend:** Price parsing utility, tier-swap UI, cost bar chart, Pro paywall for tier mixing
**Why:** Directly increases affiliate CTR. Most natural Pro upgrade moment. No competitor does outfit-level budget planning.

## Priority 2 — Later Runs

### [2] Style DNA Feed
**Status:** Proposed (2026-03-27) — deferred
**Effort:** M
**Summary:** "For You" horizontal card row in Likes tab (trending in your style, similar scans from follows, price alerts placeholder, look completion suggestions). Needs `GET /api/feed` endpoint.

### [7] The Closet
**Status:** Proposed (2026-03-27) — deferred
**Effort:** M
**Summary:** "My Closet" in Profile tab — deduplicated inventory of all scanned items by category. "Build outfit from what I own" uses pairings to cross-reference closet before suggesting purchases. Needs fuzzy deduplication.

### [5] Live Look / Collaborative Styling
**Status:** Proposed (2026-03-27) — deferred (needs social graph)
**Effort:** L
**Summary:** "Build a Look Together" mode — shareable collections where followers can suggest complementary pieces. Requires critical mass of follows to be useful.
