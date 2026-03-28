# Run 6 — Overnight Quality Sweep (2026-03-27 night → 2026-03-28 morning)

> **Mode:** Overnight autonomous. No human input expected until morning.
> **Goal:** Fix ALL E2E audit issues + ALL security bugs, then loop E2E + PM review until clean.
> **Source:** screenshots/e2e-audit-2026-03-28.md + screenshots/security-audit-2026-03-28.md

---

## Phase 1: E2E Audit Fixes (ALL issues)

Fix every issue from the E2E audit. Do NOT skip anything except the monolith refactor (that's a separate epic). Work in priority order.

### CRITICAL

1. **Fix ghost search bar / double search input**
   - File: `src/App.jsx`
   - Bug: When `tab === "search"`, both the inline search input (line ~3378) AND the `user-search-overlay` (line ~5492) render simultaneously. The overlay bleeds through behind the FAB and tab bar on ALL tabs.
   - Fix: Gate the `user-search-overlay` so it does NOT render when `tab === "search"`. The Search tab already has its own inline search. Also ensure the overlay is fully hidden/unmounted when not active (not just invisible).
   - This also fixes: FAB blocking Cancel button, "Type a name to search" text bleeding through.

2. **Fix dead History tab (~450 lines dead code)**
   - File: `src/App.jsx`, lines ~4252-4695
   - Bug: `setTab("history")` is never called anywhere. The entire History UI is unreachable.
   - Fix: Integrate scan history into the Profile tab as a scrollable grid (Instagram-style). Add a "Scan History" section below the stats row on Profile. Keep the history card rendering logic but move it into the profile section. Remove the standalone `tab === "history"` block after migrating.
   - If integration is complex, at minimum: add a "View History" button on the Profile tab that sets `tab` to `"history"`, and add History as a 5th bottom nav item OR as a sub-section.

### HIGH

3. **Add text labels to bottom nav**
   - File: `src/App.jsx`, lines ~5577-5598
   - Bug: Bottom nav is icon-only. Users can't tell what each icon means.
   - Fix: Add `<span>` text labels ("Home", "Search", "Saved", "Profile") below each SVG icon. Font size 10px, marginTop 2px. Use active gold color (#C9A96E) for active tab label, muted gray for inactive.

4. **Fix FAB overlapping Cancel button on search overlay**
   - This should be fixed by fix #1 (gating the overlay). Verify after fix #1.

5. **Fix Saved tab showing Home feed content**
   - File: `src/App.jsx`
   - Bug: Screenshot shows "For You" / "Following" on the Saved tab — it's rendering Home feed instead.
   - Fix: Verify the tab switching logic. When the Saved (heart) button is tapped, ensure `setTab("likes")` fires correctly and the Home feed content is gated behind `tab === "home"`. Test that the Saved tab renders its own header ("Saved"), empty state, or saved items grid.

6. **Fix username showing "ATTAIRE" instead of user's name on Profile**
   - File: `src/App.jsx`, line ~4800
   - Bug: `authName` falls back to brand name when profile API hasn't loaded.
   - Fix: Use `profile?.display_name || profile?.username || authName || "User"` — never show the brand name as a username. If no name is available, show "User" or the email prefix.

7. **Fix inline CSS re-injection (~2,700 lines)**
   - File: `src/App.jsx`, lines ~2330-2998
   - Fix: Move the `<style>` block content into `src/App.css` or a new `src/styles/` file. Remove the inline `<style>` tags from the JSX render. This is a big block — be careful not to break specificity. Test that styles still apply after moving.

### MEDIUM

8. **Fix phone input opacity**
   - File: `src/App.jsx`, line ~3158
   - Bug: Phone input has `opacity: 0.7` making it look disabled.
   - Fix: Remove the opacity. The "(optional)" label is sufficient.

9. **Fix error banner animation**
   - File: `src/App.jsx` (auth error state)
   - Bug: Error banner snaps into place instead of animating.
   - Fix: Add CSS transition or animation for the error banner — slide down with 200ms ease.

10. **Fix light mode button styling**
    - File: `src/App.jsx`
    - Bug: "Scan an Outfit" button is dark (#333) on light background — looks heavy.
    - Fix: In light mode, use gold accent background or a lighter variant for primary CTAs.

11. **Fix light mode tab underline visibility**
    - Bug: Gold underline on "For You"/"Following" tabs is hard to see on light background.
    - Fix: Make the underline 3px thick in light mode, or use a darker gold variant.

12. **Fix feed tab button touch targets**
    - Bug: "For You" / "Following" buttons are 160x41px — below 44px minimum.
    - Fix: Set min-height to 44px on feed tab buttons.

13. **Fix search Cancel button touch target**
    - Bug: Cancel button is 46x19px.
    - Fix: Set min-height to 44px, add padding.

14. **Fix Saved tab "Start Scanning" CTA**
    - Bug: CTA calls `setTab("scan")` which goes to idle scan screen, not the FAB sheet.
    - Fix: Call `setShowScanSheet(true)` instead for direct action.

15. **Fix light mode profile**
    - Bug: "Edit Profile" button looks disabled (mid-gray fill). Profile feels flat.
    - Fix: Make "Edit Profile" an outlined button (border only, no fill) in light mode. Add subtle gold gradient or warm tint to profile header area.

16. **Fix stray vertical line on Profile**
    - Bug: Thin dark line visible to right of username.
    - Fix: Find and remove the stray border/element.

### LOW

17. **Clean up dead onboarding code**
    - File: `src/App.jsx`, lines ~3024-3069
    - Bug: Old steps (gender, budget, size) defined but unreachable — `OB_STEPS` only has 2 entries.
    - Fix: Remove the dead step rendering code. Keep `OB_STEPS` as-is.

18. **Fix onboarding step 2 CTA text**
    - Bug: "Take a Photo" / "Upload" buttons redirect to signup — deceptive.
    - Fix: Change CTAs to "Create Account to Start Scanning" or similar.

19. **Remove legacy disabled profile code**
    - File: `src/App.jsx`, line ~5028
    - Bug: `{false && tab === "profile" && ...}` — explicitly dead code.
    - Fix: Delete it.

20. **Fix bottom sheet Cancel button contrast**
    - Bug: Cancel has `color: rgba(255,255,255,.4)` — too dim.
    - Fix: Change to `rgba(255,255,255,.7)`.

21. **Fix language chip touch targets in settings**
    - Bug: Language chips are 32px height, below 44px minimum.
    - Fix: Set min-height to 36px with generous padding.

22. **Font consistency**
    - Bug: Some elements fall back to system-ui instead of Outfit font.
    - Fix: Audit and ensure `font-family: 'Outfit', sans-serif` is applied consistently.

---

## Phase 2: Security Fixes (ALL 5 findings)

### HIGH-2: TOCTOU Race on saved_count
- File: `server/routes/user.js`, line ~284
- Bug: Read-modify-write on `saved_count` allows concurrent requests to desync, bypassing 20-item save limit.
- Fix: Use atomic SQL: `UPDATE profiles SET saved_count = saved_count + 1 WHERE saved_count < 20 RETURNING saved_count`. If no row returned, limit reached. Same for decrement: `UPDATE profiles SET saved_count = GREATEST(0, saved_count - 1)`.

### HIGH-3: Analytics Batch Bomb
- File: `server/routes/events.js`, line ~17
- Bug: `POST /api/events` accepts unlimited events per request. Attacker can insert 1M rows/min.
- Fix: Cap batch to 50 events max per request. Cap individual field lengths (event_name: 100 chars, metadata JSON: 1KB). Return 400 if exceeded. Add rate limit of 10 requests/min/IP on this endpoint.

### HIGH-4: Affiliate Click Fraud
- File: `server/routes/affiliate.js`, line ~160
- Bug: No per-user deduplication. Client-generated click IDs. 60 clicks/min/IP allowed.
- Fix: Generate click IDs server-side (UUID). Add per-user deduplication: one click per user per product per hour. Verify the clicking user owns the session. Rate limit to 10 clicks/min/user.

### HIGH-5: Follower List Privacy
- File: `server/routes/social.js`, line ~60
- Bug: Any authenticated user can enumerate any other user's full follower/following list.
- Fix: Check `profile.is_private` before returning the list. For private profiles, return only the count (`{ count: N }`), not the actual user list. For public profiles, paginate results (limit 50 per page).

### HIGH-6: Scan Rate Limit TOCTOU Race
- File: `server/middleware/rateLimit.js`, line ~84
- Bug: Check and increment are separate async operations. Concurrent requests bypass 12-scan limit.
- Fix: Create a Supabase RPC function `try_increment_scan(user_id)` that atomically checks and increments in a single query. Call this BEFORE invoking Claude. If it returns false, return 429.

---

## Phase 3: E2E Re-Audit Loop

After Phases 1 and 2 are complete:

1. **Run the E2E audit again** — Same Playwright script, same screenshots, same device config (iPhone 14 Pro, 390x844).
2. **PM agent reviews** — Compare new screenshots against the original audit findings. Check each fix individually.
3. **If issues remain** — Dev agent fixes them immediately. Then re-run E2E.
4. **Repeat until PM gives PASS verdict on all screens.**

The loop should run autonomously. Each cycle:
- Dev fixes → commit → E2E screenshot capture → PM review → report
- If PM says PASS: done, post final report to Discord
- If PM says NEEDS WORK: dev picks up remaining items, fixes, loops again
- Max 5 cycles to prevent infinite loops. If still failing after 5, post what's left to Discord.

---

## Agent Assignments

- **Dev Agent 1:** E2E fixes #1-7 (critical + high) — these are the most impactful
- **Dev Agent 2:** E2E fixes #8-22 (medium + low) — smaller fixes, parallelizable
- **Security Agent:** All 5 security fixes (Phase 2)
- **QA Agent:** Phase 3 E2E re-audit loop (runs after dev agents finish)
- **PM Agent:** Reviews QA output, approves or kicks back to dev

---

## Success Criteria

- [ ] Zero CRITICAL or HIGH issues in E2E re-audit
- [ ] All 5 security vulnerabilities patched with atomic/safe patterns
- [ ] All tests pass (existing 284 + any new ones)
- [ ] PM agent gives PASS on every screen
- [ ] Final report posted to Discord by morning
