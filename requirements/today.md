# Requirements — March 27, 2026 (Discord Bot Overhaul — Batch 1)

## Context
Jules manages ATTAIR from his phone via Discord. Three critical pain points:
1. Bot responses are too verbose — hard to read on mobile
2. Message formatting breaks on Discord mobile (bad newlines, markdown rendering)
3. No way to query the database without opening Supabase dashboard

This is a focused `discord-bot.js` change. No app code touched.

Run `git log --oneline -20` before starting. Do NOT redo anything already done.

---

## MISSION: Make the Discord bot fast, clean, and useful from a phone.

After this run:
- Bot messages are terse and mobile-readable
- Formatting renders correctly on Discord mobile
- Jules can query Supabase directly from Discord chat

---

## TASK 1 — Terser Bot Responses + Mobile Formatting

**File:** `agents/discord-bot.js`

**Problem:** The system prompt for `chatWithOpus()` produces long responses. Discord mobile renders markdown inconsistently — bullet lists, headers, and code blocks can look broken.

**What to change:**

1. **Update the Claude system prompt** in `chatWithOpus()` to enforce brevity:
   - Add to the system prompt: "You are texting Jules on his phone via Discord. Keep responses to 1-3 sentences unless he asks for detail. No intros, no 'great question', no fluff. Use plain text, not markdown headers. Bullet points are OK but keep them short. Never use code blocks for non-code content."
   - The existing system prompt context (ATTAIR product partner, actions, etc.) stays — just prepend the brevity rules

2. **Fix `sendToChannel()` formatting:**
   - Strip triple-backtick code blocks from non-code content before sending (they render poorly on mobile)
   - Replace `###` and `##` headers with **bold text** instead (Discord mobile handles bold better than headers)
   - Replace `---` horizontal rules with empty lines
   - Ensure no double-newlines get sent (Discord collapses them weirdly on mobile)
   - Keep the 1900-char chunking logic but break at sentence boundaries, not just newlines

3. **Add a format helper function** `formatForMobile(text)`:
   - `### Header` → `**Header**`
   - `## Header` → `**Header**`
   - `# Header` → `**Header**`
   - Remove `---` dividers
   - Collapse 3+ consecutive newlines to 2
   - Strip code block fences (```) unless the content looks like actual code (contains `{`, `(`, `=`, `function`, `const`, etc.)
   - Apply this to ALL bot messages before sending

**Acceptance criteria:**
- Bot responses are visibly shorter (1-3 sentences for simple questions)
- No broken markdown rendering on Discord mobile
- Headers render as bold text
- Code blocks only appear for actual code

---

## TASK 2 — Individual Agent Dispatch from Discord

**File:** `agents/discord-bot.js`

**Problem:** Jules can only run the full army (``). Sometimes he just wants to run one agent for a quick task.

**What to add:**

1. **New action tag:** `[ACTION:RUN_AGENT:agent-name:task description