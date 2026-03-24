/**
 * ATTAIR Agent ↔ Human Communication via GitHub Issues
 * ─────────────────────────────────────────────────────
 * Lets the agent army ask questions, send updates, and wait for replies
 * from the human via GitHub Issues on julesblau/ATTAIR.
 *
 * Usage:
 *   import { askHuman, notifyHuman, getReply } from "./notify.js";
 *
 *   // Ask a question and wait for a reply (blocks until human responds)
 *   const answer = await askHuman("Should we remove light mode entirely or fix it?");
 *
 *   // Send a status update (non-blocking, no reply expected)
 *   await notifyHuman("Backend agent finished. Starting UI/UX agent now.");
 *
 *   // Low-level: create issue, poll for reply separately
 *   const issueNum = await createIssue("Question", "body text");
 *   const reply = await pollForReply(issueNum);
 */

import { execSync } from "child_process";

const GH = '"C:\\Program Files\\GitHub CLI\\gh.exe"';
const REPO = "julesblau/ATTAIR";
const HUMAN = "julesblau";
const POLL_INTERVAL_MS = 30_000;  // Check every 30 seconds
const MAX_WAIT_MS = 4 * 60 * 60 * 1000; // Give up after 4 hours

// ─── Core Functions ──────────────────────────────────────────────────────────

/**
 * Create a GitHub issue and return its number.
 */
export function createIssue(title, body, labels = [], assignee = "") {
  const labelArgs = labels.map(l => `--label ${l}`).join(" ");
  const assigneeArg = assignee ? `--assignee ${assignee}` : "";
  // Flags MUST come before --body to avoid being swallowed by shell escaping
  const cmd = `${GH} issue create --repo ${REPO} ${labelArgs} ${assigneeArg} --title "${esc(title)}" --body "${esc(body)}"`;
  const output = execSync(cmd, { encoding: "utf-8", timeout: 30_000 }).trim();
  // gh issue create returns the issue URL, extract the number
  const match = output.match(/\/issues\/(\d+)/);
  if (!match) throw new Error(`Failed to parse issue number from: ${output}`);
  return parseInt(match[1], 10);
}

/**
 * Add a comment to an existing issue.
 */
export function commentOnIssue(issueNum, body) {
  const cmd = `${GH} issue comment ${issueNum} --repo ${REPO} --body "${esc(body)}"`;
  execSync(cmd, { encoding: "utf-8", timeout: 30_000 });
}

/**
 * Close an issue.
 */
export function closeIssue(issueNum) {
  const cmd = `${GH} issue close ${issueNum} --repo ${REPO}`;
  execSync(cmd, { encoding: "utf-8", timeout: 30_000 });
}

/**
 * Get all comments on an issue (returns array of { author, body, createdAt }).
 */
export function getComments(issueNum) {
  const cmd = `${GH} issue view ${issueNum} --repo ${REPO} --json comments`;
  const output = execSync(cmd, { encoding: "utf-8", timeout: 30_000 });
  const data = JSON.parse(output);
  return (data.comments ?? []).map(c => ({
    author: c.author?.login ?? "unknown",
    body: c.body ?? "",
    createdAt: c.createdAt,
  }));
}

/**
 * Poll an issue for a human reply (any comment not from the bot/agent).
 * Returns the reply text, or null if timed out.
 */
export async function pollForReply(issueNum, timeoutMs = MAX_WAIT_MS) {
  const start = Date.now();
  // Brief delay to let GitHub propagate the issue before first poll
  await sleep(3_000);
  const knownComments = new Set(getComments(issueNum).map(c => c.createdAt));

  while (Date.now() - start < timeoutMs) {
    await sleep(POLL_INTERVAL_MS);

    const comments = getComments(issueNum);
    const newComment = comments.find(c => !knownComments.has(c.createdAt));

    if (newComment) {
      return newComment.body;
    }
  }

  return null; // Timed out
}

// ─── High-Level API ──────────────────────────────────────────────────────────

/**
 * Ask the human a question via GitHub issue. Blocks until they reply.
 * Returns their reply text.
 *
 * @param {string} question - The question to ask
 * @param {object} opts
 * @param {string} opts.context - Additional context to include in the issue body
 * @param {number} opts.timeoutMs - How long to wait (default 4 hours)
 * @returns {Promise<string|null>} The human's reply, or null if timed out
 */
export async function askHuman(question, opts = {}) {
  const { context = "", timeoutMs = MAX_WAIT_MS } = opts;
  const now = new Date().toLocaleString("en-US", { timeZone: "America/New_York" });

  const title = `[Agent] ${question.slice(0, 60)}${question.length > 60 ? "..." : ""}`;
  const body = [
    `@${HUMAN}`,
    ``,
    `## Agent Question`,
    ``,
    question,
    ``,
    context ? `### Context\n${context}\n` : "",
    `---`,
    `**Reply in a comment below.** The agent is waiting and will continue once you respond.`,
    ``,
    `_Sent at ${now} ET_`,
  ].filter(Boolean).join("\n");

  const issueNum = createIssue(title, body, ["agent-question"], HUMAN);
  console.log(`📩 Question posted: https://github.com/${REPO}/issues/${issueNum}`);
  console.log(`   Waiting for your reply...`);

  const reply = await pollForReply(issueNum, timeoutMs);

  if (reply) {
    console.log(`✅ Got reply on issue #${issueNum}`);
  } else {
    console.log(`⏰ Timed out waiting for reply on issue #${issueNum}`);
    commentOnIssue(issueNum, `_Agent timed out waiting for a reply after ${Math.round(timeoutMs / 60000)} minutes._`);
  }

  return { reply, issueNum };
}

/**
 * Follow up on an existing issue — post a comment and wait for a reply.
 * Use this to have a back-and-forth chat on the same GitHub issue thread.
 *
 * @param {number} issueNum - The issue to comment on
 * @param {string} message - The follow-up message
 * @param {object} opts
 * @param {number} opts.timeoutMs - How long to wait (default 4 hours)
 * @returns {Promise<string|null>} The human's reply, or null if timed out
 */
export async function followUp(issueNum, message, opts = {}) {
  const { timeoutMs = MAX_WAIT_MS } = opts;

  commentOnIssue(issueNum, `@${HUMAN}\n\n${message}`);
  console.log(`💬 Follow-up posted on issue #${issueNum}`);

  const reply = await pollForReply(issueNum, timeoutMs);

  if (reply) {
    console.log(`✅ Got reply on issue #${issueNum}`);
  } else {
    console.log(`⏰ Timed out waiting for reply on issue #${issueNum}`);
  }

  return reply;
}

/**
 * Close a conversation thread when done.
 *
 * @param {number} issueNum - The issue to close
 * @param {string} summary - Optional closing summary
 */
export function closeThread(issueNum, summary = "") {
  const msg = summary
    ? `_Thread closed. ${summary}_`
    : `_Agent received your reply and is continuing. Thread closed._`;
  commentOnIssue(issueNum, msg);
  closeIssue(issueNum);
  console.log(`🔒 Closed issue #${issueNum}`);
}

/**
 * Send the human a status update / notification (non-blocking).
 *
 * @param {string} message - The update message
 * @param {object} opts
 * @param {string} opts.title - Custom issue title (auto-generated if omitted)
 */
export function notifyHuman(message, opts = {}) {
  const now = new Date().toLocaleString("en-US", { timeZone: "America/New_York" });
  const title = opts.title || `[Agent Update] ${now}`;

  const body = [
    `@${HUMAN}`,
    ``,
    `## Status Update`,
    ``,
    message,
    ``,
    `---`,
    `_This is an automated update. No reply needed unless you have feedback._`,
    ``,
    `_Sent at ${now} ET_`,
  ].join("\n");

  const issueNum = createIssue(title, body, ["agent-update"], HUMAN);
  console.log(`📤 Update posted: https://github.com/${REPO}/issues/${issueNum}`);
  return issueNum;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function esc(str) {
  // Escape double quotes and backticks for shell safety
  return str.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/`/g, "\\`").replace(/\$/g, "\\$");
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
