# Creative Backlog — Approved Ideas

> Ideas proposed by the creative agent, filtered by PM, pending Jules approval.
> The agent army implements these alongside today.md requirements.
> Remove items after they're built.

## CRITICAL — Build This Run (Jules priority update 2026-03-28)

### ATTAIRE Rename + Branding
**Status:** DONE (Run 5, 2026-03-28) — All user-facing strings updated to ATTAIRE
**Effort:** S

### Discord Bot UX Improvements
**Status:** CRITICAL — terser responses, individual agent dispatch
**Effort:** M (2 agents)
**Summary:** (1) Accept shorter/terser responses from Jules — less typing on mobile. (2) Ability to deploy individual agents for side tasks (e.g. "run the brand agent") instead of only launching the full army.

### Discord Bot Formatting Cleanup
**Status:** CRITICAL — Fix formatting for mobile
**Effort:** S (1 agent)
**Summary:** Fix message formatting issues — newlines, markdown rendering on mobile. Make messages easier to read in Discord on phone.

### SQL Access via Claude CLI
**Status:** CRITICAL — Give Claude direct DB access
**Effort:** S (1 agent)
**Summary:** Give Claude Code direct access to query the Supabase database (read/write) so agents and chat can inspect data, debug issues, run queries.

### Overnight / Autonomous Mode
**Status:** CRITICAL — Build immediately
**Effort:** S (1 agent)
**Summary:** `--overnight` flag on run.js — agents make best judgment calls instead of blocking on permission prompts. Daytime runs keep current behavior.

## HIGH

### Smaller/More Frequent Agent Commits
**Status:** HIGH — Improve agent reliability
**Effort:** S
**Summary:** Each agent commits after completing each sub-task rather than batching at the end. Prevents losing work on process death.

## MEDIUM

### Social Proof Signals on Feed
**Status:** MEDIUM — Approved by Jules
**Effort:** S (1 agent)
**Summary:** Add "Saved by N people" pills and trending badges to feed cards. Backend adds save_count subquery to feed endpoint.
**Why:** Social proof is the most powerful conversion mechanism.

### Process Keep-Alive Pings
**Status:** MEDIUM
**Effort:** S (1 agent)
**Summary:** Discord bot pings Jules when any Claude Code process is about to shut down or sleep, so he can confirm to keep it running.

## LOW

### Scan-to-Reel Video Export
**Status:** LOW — Deferred
**Effort:** M (2 agents)
**Summary:** 5-second animated video of scan results using Canvas + MediaRecorder API. Pro-only. Optimized for TikTok/Reels.

### Follow-up Nudge System
**Status:** LOW — Deferred
**Effort:** S (1 agent)
**Summary:** Bot re-pings Jules after 10-15 min timeout if he misses a message that needs input.

### Chat Context Persistence
**Status:** LOW — Deferred
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

### Run 5 (2026-03-28)
- ATTAIRE rename across codebase
