/**
 * ATTAIR Agent ↔ Human Communication
 * ─────────────────────────────────────────────────────
 * Routes through Discord (when DISCORD_BRIDGE=true) or GitHub Issues (fallback).
 *
 * Usage:
 *   import { askHuman, notifyHuman } from "./notify.js";
 *
 *   const answer = await askHuman("Should we remove light mode entirely or fix it?");
 *   await notifyHuman("Backend agent finished. Starting UI/UX agent now.");
 */

import { execSync } from "child_process";
import { readFileSync, writeFileSync, existsSync, unlinkSync } from "fs";
import { join } from "path";
import { randomUUID } from "crypto";

// ─── Mode Detection ──────────────────────────────────────────────────────────
const USE_DISCORD = process.env.DISCORD_BRIDGE === "true";
const BRIDGE_DIR = process.env.DISCORD_BRIDGE_DIR || join(process.cwd(), "agents", ".discord-bridge");

// GitHub fallback config
const GH = process.platform === "win32" ? '"C:\\Program Files\\GitHub CLI\\gh.exe"' : "gh";
const REPO = "julesblau/ATTAIR";
const HUMAN = "julesblau";
const POLL_INTERVAL_MS = USE_DISCORD ? 3_000 : 30_000; // Poll faster for Discord
const MAX_WAIT_MS = 4 * 60 * 60 * 1000;

// ─── Discord Bridge Functions ────────────────────────────────────────────────

function discordAsk(question, context = "") {
  const id = randomUUID().slice(0, 8);
  const questionFile = join(BRIDGE_DIR, "question.json");
  writeFileSync(questionFile, JSON.stringify({ id, text: question, context, ts: Date.now() }));
  return id;
}

async function discordPollReply(questionId, timeoutMs = MAX_WAIT_MS) {
  const responseFile = join(BRIDGE_DIR, `response-${questionId}.json`);
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    await sleep(POLL_INTERVAL_MS);

    if (existsSync(responseFile)) {
      try {
        const raw = readFileSync(responseFile, "utf-8");
        const data = JSON.parse(raw);
        // Clean up
        try { unlinkSync(responseFile); } catch {}
        return data.reply ?? null;
      } catch {
        // File might be mid-write
      }
    }
  }

  return null;
}

function discordNotify(message) {
  const notifyFile = join(BRIDGE_DIR, "notification.json");
  writeFileSync(notifyFile, JSON.stringify({ text: message, ts: Date.now() }));
}

// ─── GitHub Core Functions ───────────────────────────────────────────────────

export function createIssue(title, body, labels = [], assignee = "") {
  const labelArgs = labels.map(l => `--label ${l}`).join(" ");
  const assigneeArg = assignee ? `--assignee ${assignee}` : "";
  const cmd = `${GH} issue create --repo ${REPO} ${labelArgs} ${assigneeArg} --title "${esc(title)}" --body "${esc(body)}"`;
  const output = execSync(cmd, { encoding: "utf-8", timeout: 30_000 }).trim();
  const match = output.match(/\/issues\/(\d+)/);
  if (!match) throw new Error(`Failed to parse issue number from: ${output}`);
  return parseInt(match[1], 10);
}

export function commentOnIssue(issueNum, body) {
  const cmd = `${GH} issue comment ${issueNum} --repo ${REPO} --body "${esc(body)}"`;
  execSync(cmd, { encoding: "utf-8", timeout: 30_000 });
}

export function closeIssue(issueNum) {
  const cmd = `${GH} issue close ${issueNum} --repo ${REPO}`;
  execSync(cmd, { encoding: "utf-8", timeout: 30_000 });
}

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

export async function pollForReply(issueNum, timeoutMs = MAX_WAIT_MS) {
  const start = Date.now();
  await sleep(3_000);
  const knownComments = new Set(getComments(issueNum).map(c => c.createdAt));

  while (Date.now() - start < timeoutMs) {
    await sleep(POLL_INTERVAL_MS);
    const comments = getComments(issueNum);
    const newComment = comments.find(c => !knownComments.has(c.createdAt));
    if (newComment) return newComment.body;
  }
  return null;
}

// ─── High-Level API (auto-routes Discord or GitHub) ──────────────────────────

export async function askHuman(question, opts = {}) {
  const { context = "", timeoutMs = MAX_WAIT_MS } = opts;

  if (USE_DISCORD) {
    const questionId = discordAsk(question, context);
    console.log(`📩 Question sent to Discord (id: ${questionId})`);
    console.log(`   Waiting for Jules' reply...`);

    const reply = await discordPollReply(questionId, timeoutMs);

    if (reply) {
      console.log(`✅ Got reply via Discord`);
    } else {
      console.log(`⏰ Timed out waiting for Discord reply`);
    }

    return { reply, issueNum: questionId };
  }

  // GitHub fallback
  const now = new Date().toLocaleString("en-US", { timeZone: "America/New_York" });
  const title = `[Agent] ${question.slice(0, 60)}${question.length > 60 ? "..." : ""}`;
  const body = [
    `@${HUMAN}`, ``, `## Agent Question`, ``, question, ``,
    context ? `### Context\n${context}\n` : "",
    `---`, `**Reply in a comment below.** The agent is waiting and will continue once you respond.`,
    ``, `_Sent at ${now} ET_`,
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

export async function followUp(issueNum, message, opts = {}) {
  const { timeoutMs = MAX_WAIT_MS } = opts;

  if (USE_DISCORD) {
    // In Discord mode, follow-ups are just new questions
    return (await askHuman(message, { timeoutMs })).reply;
  }

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

export function closeThread(issueNum, summary = "") {
  if (USE_DISCORD) {
    // No-op in Discord mode — threads are ephemeral
    console.log(`🔒 Thread closed (Discord mode)`);
    return;
  }

  const msg = summary
    ? `_Thread closed. ${summary}_`
    : `_Agent received your reply and is continuing. Thread closed._`;
  commentOnIssue(issueNum, msg);
  closeIssue(issueNum);
  console.log(`🔒 Closed issue #${issueNum}`);
}

export function notifyHuman(message, opts = {}) {
  if (USE_DISCORD) {
    discordNotify(message);
    console.log(`📤 Notification sent to Discord`);
    return "discord";
  }

  const now = new Date().toLocaleString("en-US", { timeZone: "America/New_York" });
  const title = opts.title || `[Agent Update] ${now}`;

  const body = [
    `@${HUMAN}`, ``, `## Status Update`, ``, message, ``,
    `---`, `_This is an automated update. No reply needed unless you have feedback._`,
    ``, `_Sent at ${now} ET_`,
  ].join("\n");

  const issueNum = createIssue(title, body, ["agent-update"], HUMAN);
  console.log(`📤 Update posted: https://github.com/${REPO}/issues/${issueNum}`);
  return issueNum;
}

// ─── Inbox ───────────────────────────────────────────────────────────────────

export function checkInbox() {
  if (USE_DISCORD) {
    // In Discord mode, messages come through the bridge in real-time
    // Check for any queued messages from the bot
    const inboxFile = join(BRIDGE_DIR, "inbox.json");
    if (existsSync(inboxFile)) {
      try {
        const raw = readFileSync(inboxFile, "utf-8");
        const items = JSON.parse(raw);
        // Clear after reading
        writeFileSync(inboxFile, "[]");
        return items;
      } catch { return []; }
    }
    return [];
  }

  const cmd = `${GH} issue list --repo ${REPO} --label from-jules --state open --json number,title,body`;
  const output = execSync(cmd, { encoding: "utf-8", timeout: 30_000 });
  const issues = JSON.parse(output);
  return issues.map(i => ({
    issueNum: i.number,
    title: i.title,
    body: i.body,
  }));
}

export function acknowledgeInbox(issueNum, response = "") {
  if (USE_DISCORD) {
    console.log(`📥 Acknowledged Discord message`);
    return;
  }

  const msg = response
    ? `_Agent received this. ${response}_`
    : `_Agent received this and will incorporate it into the current run._`;
  commentOnIssue(issueNum, msg);
  closeIssue(issueNum);
  console.log(`📥 Acknowledged inbox issue #${issueNum}`);
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function esc(str) {
  return str.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/`/g, "\\`").replace(/\$/g, "\\$");
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
