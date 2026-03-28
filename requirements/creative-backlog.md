# Creative Backlog — Approved Ideas

> Ideas proposed by the creative agent, filtered by PM, pending Jules approval.
> The agent army implements these alongside today.md requirements.
> Remove items after they're built.

## Approved by Jules — Run 3 (2026-03-28) — BUILD NOW

### Affiliate Network Expansion
**Status:** APPROVED — Build immediately
**Effort:** S (1 agent)
**Summary:** Expand tagUrl in affiliate.js to handle top 10 retailers beyond Amazon (Nordstrom, ASOS, Revolve, Zappos, Madewell, Anthropologie, Urban Outfitters, Shopbop, Lululemon, SSENSE). Currently earning $0 on ~80% of outbound clicks. Trivial code change, massive revenue impact (~$1,400/mo estimate).
**Why:** Highest ROI idea. Money left on the table every day.

### Style DNA Report
**Status:** APPROVED — Build
**Effort:** M (2 agents)
**Summary:** After 5+ scans, generate AI style archetype ("Off-Duty Minimalist", "Downtown Maximalist") via Claude Haiku from scan history. Shareable Instagram Story card. Full breakdown gated behind Pro.
**Why:** Every share = free acquisition. Viral growth engine.

### Price Drop Alerts (Real Implementation)
**Status:** APPROVED — Build
**Effort:** M (2 agents)
**Summary:** Daily background job checks saved items via SerpAPI. Notify when price drops 10%+. Pro-only. Click-throughs earn affiliate revenue. Already promised as Pro feature in upgrade modal.
**Why:** Fulfills existing promise. Strongest Pro retention argument.

## Backlog — Rethink Later

### Scan-to-Earn Referral Loop
**Status:** BACKLOG — Jules wants to rethink incentive structure
**Effort:** S (1 agent)
**Summary:** Post-scan-result banner "Share ATTAIRE — you both get a free scan." Referral attribution on signup. Need to redesign what both sides get.
**Why:** Growth mechanic at peak emotional moment. Incentive TBD.

### Occasion-Driven Event Mode
**Status:** DEFERRED to Run 4+ (complex)
**Effort:** M (2 agents)
**Summary:** "I have an event" flow — user describes event, AI generates outfit brief, scan one inspiration photo, auto-create shoppable Event Kit collection.

### Influencer Scan Packs
**Status:** DEFERRED (needs user base first)
**Effort:** M (2 agents)
**Summary:** Verified creator badges, curated "Scan Pack" collections with themes, priority feed placement. Platform play.

### Trending Feed ("What's Hot Right Now")
**Status:** DEFERRED (needs data volume)
**Effort:** S (1 agent)
**Summary:** Horizontal trending row on home feed — most-scanned items, rising brands, most-saved items. Hourly background aggregation.

## Implemented (Run 2, 2026-03-27) — DONE

- [3] Scan-to-Share Deep Link — IMPLEMENTED
- [1] Outfit Verdict + Share Card — IMPLEMENTED
- [6] Style Fingerprint Onboarding — IMPLEMENTED
- [4] Budget Tracker + Tier Mixer — IMPLEMENTED
- [NEW] Real Product Images in Pairings — IMPLEMENTED
- [NEW] Smart Re-Search / Alt-Search Button — IMPLEMENTED

## Priority 1 — Awaiting Jules' Approval (proposed Run 2)

### Social Proof Signals on Feed
**Status:** Proposed (2026-03-27) — awaiting approval (#60)
**Effort:** S (1 agent)
**Summary:** Add "Saved by N people" pills and trending badges to feed cards. Creates virality loop. Backend adds save_count subquery to feed endpoint.
**Why:** Social proof is the most powerful conversion mechanism. A scan with "Saved by 24 people" is 10x more clickable.

### Price Drop Radar
**Status:** Proposed (2026-03-27) — awaiting approval (#60)
**Effort:** M (2 agents)
**Summary:** Monitor prices on saved items, show in-app alerts when prices drop 10%+. Fulfills the already-promised Pro feature. PRO-only gate.
**Why:** Creates pull retention loop. Highest-intent affiliate clicks. Already promised in upgrade modal.

### Style DNA Learning Engine
**Status:** Proposed (2026-03-27) — awaiting approval (#60)
**Effort:** M (2 agents)
**Summary:** Aggregate scan history into a style profile (dominant categories, colors, brand tier, fit). Feed back into product search for personalization. Show Style DNA card on profile.
**Why:** Personalization is the most defensible competitive moat. Users who see better results over time have concrete reason to keep scanning.

### Scan-to-Reel Video Export
**Status:** Proposed (2026-03-27) — awaiting approval (#60)
**Effort:** M (2 agents)
**Summary:** 5-second animated video of scan results using Canvas + MediaRecorder API. Pro-only. Optimized for TikTok/Reels.
**Why:** Every export is a branded billboard. Safari/iOS support is risky but PNG fallback exists.

## Priority 2 — Later Runs

### [2] Style DNA Feed
**Status:** Proposed (2026-03-27) — deferred
**Effort:** M
**Summary:** "For You" horizontal card row in Likes tab. Feed endpoint now exists.

### [7] The Closet
**Status:** Proposed (2026-03-27) — deferred
**Effort:** M
**Summary:** Deduplicated wardrobe inventory by category. "Build outfit from what I own."

### [5] Live Look / Collaborative Styling
**Status:** Proposed (2026-03-27) — deferred (needs social graph)
**Effort:** L
**Summary:** Shareable collections where followers suggest complementary pieces.

### Occasion Planner
**Status:** Proposed (2026-03-27) — deferred
**Effort:** L
**Summary:** Calendar-backed outfit planning with fast-shipping bias for upcoming events. PRO-only.

### Smart Re-Search Enhancements
**Status:** Proposed (2026-03-27) — deferred
**Effort:** S
**Summary:** Surface fallback recovery more prominently, add "refine with AI" collapsed section below alt-search.

### 2026-03-27 — Jules via Discord
Rename everywhere from ATTAIR to ATTAIRE — update app name, repo references, brand assets, logo, favicon, and all code/config that references the old spelling
**Status:** Pending review

### 2026-03-27 — Jules via Discord
Discord bot UX improvements: (1) Accept shorter/terser responses from Jules — less typing needed on mobile. (2) Ability to deploy individual agents for side tasks (e.g. "run the brand agent" or "kick off the scraper") instead of only launching the full army. Review and spec out next session.
**Status:** Pending review

### 2026-03-27 — Jules via Discord
Process keep-alive notifications: Implement a way for the Discord bot to ping Jules when any Claude Code process (army, individual agent, or this chat) is about to shut down or sleep, so he can confirm to keep it running. Prevents silent deaths from laptop sleep/timeout.
**Status:** Pending review

### 2026-03-27 — Jules via Discord
Agent reliability: Make agents commit more frequently in smaller chunks during army runs — prevents losing work if a process dies or hits token cap mid-task. Each agent should commit after completing each sub-task rather than batching everything at the end.
**Status:** Pending review

### 2026-03-28 — Jules via Discord
Follow-up nudges: If Jules misses a message or doesn't respond to something that needs his input (blocker, decision, brainstorm), the bot should re-ping him after a timeout (e.g. 10-15 min). Prevents things from stalling silently while he's AFK.
**Status:** Pending review

### 2026-03-28 — Jules via Discord
Agent audit: Review all agent prompts, workflows, and outputs to figure out why quality is low — identify which agents are underperforming, diagnose root causes (bad prompts, wrong context, missing constraints), and propose fixes.
**Status:** Pending review

### 2026-03-28 — Jules via Discord
Discord bot formatting cleanup: Fix message formatting issues — newlines don't render well, markdown may not display correctly on mobile. Make messages easier to read in Discord, especially on phone. Test formatting on mobile before shipping.
**Status:** Pending review

### 2026-03-28 — Jules via Discord
SQL access via Claude CLI: Give Claude Code direct access to query the Supabase database (read/write) so agents and this chat can inspect data, debug issues, and run queries without needing a separate tool or dashboard.
**Status:** Pending review

### 2026-03-28 — Jules via Discord
## Overnight / Autonomous Mode for Agent Army
When Jules kicks off a run and marks it as "overnight" (or it's after a certain hour), agents should NOT block on permission prompts or questions — they should make their best judgment call and keep going. During daytime runs, keep the current behavior where agents can ask Jules questions via Discord. Could be a simple `--overnight` flag on `run.js` or a Discord command like `/run overnight`.
**Status:** Pending review

### 2026-03-28 — Jules via Discord
PRIORITY UPDATE — All pending items now reviewed and prioritized:
CRITICAL: ATTAIRE rename+branding, Discord bot UX (terser+individual agents), Discord formatting cleanup, SQL access via CLI, Overnight autonomous mode
HIGH: Smaller/more frequent agent commits
MEDIUM: Social proof signals on feed cards, Process keep-alive pings
LOW: Scan-to-Reel video export, Follow-up nudge system
Previously approved (unchanged): Affiliate expansion (S), Style DNA report (M), Price drop alerts (M)
**Status:** Pending review

### 2026-03-28 — Jules via Discord
Update creative-backlog.md statuses — mark Discord bot UX, Discord formatting cleanup, and SQL access via CLI as "IN PROGRESS (Batch 1 — March 27)" since they're being built now
**Status:** Pending review

### 2026-03-28 — Jules via Discord
Chat context persistence — instead of compressing conversation history, pass key context forward via memory system so nothing important gets lost between messages. Priority: LOW
**Status:** Pending review
