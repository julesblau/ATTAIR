# Requirements — March 27, 2026 (Agent Infrastructure Upgrade)

## Context
The agent army produces low-quality UI output because:
1. Agents have zero visual references — they guess what "premium" means
2. Agent prompts say "TikTok meets Instagram" but show no actual screenshots
3. `run.js` uses `@anthropic-ai/claude-agent-sdk` `query()` instead of spawning `claude` CLI directly — should go through Max subscription like `discord-bot.js` does
4. The AI-reviewing-AI loop (e2e-agent) has no ground truth to compare against

This run fixes the infrastructure so future UI runs produce dramatically better output.

Run `git log --oneline -20` before starting. Do NOT redo anything already done.

---

## MISSION: Fix the builder infrastructure so agents produce visually excellent UI.

This is NOT a feature run. This is a tooling/infra run. After this, the agent army will:
- Have real-world reference screenshots to match when building UI
- Run through the Claude CLI (Max subscription) instead of the Agent SDK
- Have upgraded prompts that mandate visual reference matching before writing CSS

---

## TASK 1 — CLI Migration (`agents/run.js`)

**Goal:** Replace `@anthropic-ai/claude-agent-sdk` `query()` with direct `claude` CLI spawning, matching the pattern already used in `discord-bot.js`.

**Current state:**
- `run.js` imports `query` from `@anthropic-ai/claude-agent-sdk`
- Uses `query({ prompt, options: queryOptions })` with async generator
- `discord-bot.js` already spawns `claude` via `spawn("claude", ["-p", "--model", "opus", "--output-format", "text", "--allowedTools", ...