#!/usr/bin/env node
/**
 * ATTAIRE Discord Bot — Jules' mobile dev CLI
 * ─────────────────────────────────────────────────────────────
 * Run: node discord-bot.js
 *
 * Features:
 *   - Opus-powered chat: brainstorm, plan, interview for features
 *   - Build→Judge→Fix loop: builds features to production quality
 *   - Token-maximizing: finishes one task, pulls next from backlog
 *   - Backlog management with priority + sizing
 *   - Creative agent for generating feature ideas
 *   - Screenshot-based visual QA against reference apps
 */

import { Client, GatewayIntentBits, Partials, EmbedBuilder } from "discord.js";
import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync, createWriteStream } from "fs";
import { spawn, execSync } from "child_process";
import { pipeline } from "stream/promises";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { config } from "dotenv";

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: join(__dirname, ".env") });

// ─── Config ──────────────────────────────────────────────────────────────────
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const CHAT_CHANNEL_ID = process.env.DISCORD_CHAT_CHANNEL_ID;
const LOGS_CHANNEL_ID = process.env.DISCORD_LOGS_CHANNEL_ID;
const REPO_ROOT = join(__dirname, "..");
const BACKLOG_PATH = join(__dirname, "backlog.md");

if (!DISCORD_TOKEN) {
  console.error("Missing DISCORD_TOKEN in agents/.env");
  process.exit(1);
}

// ─── Discord Client ──────────────────────────────────────────────────────────
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Message, Partials.Channel],
});

// ─── State ───────────────────────────────────────────────────────────────────
let activeProcess = null;           // current child process (build agent, creative agent, etc.)
let activeTaskLabel = null;         // what's currently running (for status)
let conversationHistory = [];       // Claude conversation context
let buildLoopRunning = false;       // is the build→judge→fix loop active?
let stopRequested = false;          // user asked to stop

// ─── System Prompt ──────────────────────────────────────────────────────────
const SYSTEM_PROMPT = `You're Jules' product partner for ATTAIRE (AI fashion shopping app). Discord on his phone.

RULES:
- TEXT like a coworker. 1-2 sentences max unless he asks for more.
- No intros, no "great question", no fluff. Just answer.
- If he says something vague, ask ONE clarifying question.
- You can push back, suggest things, and start conversations.
- Format for mobile: short lines, no walls of text, use bullet points sparingly.

CONTEXT: React 19 + Vite, Node/Express on Railway, Supabase, Claude AI vision, SerpAPI, freemium model.
Backlog lives at agents/backlog.md — markdown with priority sections and sizing.

HOW YOU WORK:
You're Jules' Claude CLI through Discord. You can interview him for feature ideas, manage the backlog,
and dispatch builds. When building, you use a quality loop: build → test → screenshot → judge against
reference apps (TikTok, Depop, Pickle, Instagram) → if not good enough, fix and repeat → only move on
when the feature is production-quality. You maximize token usage — when one task is done, pull the next
from backlog and keep going.

ACTIONS YOU CAN TRIGGER:
Include the action tag in your response. The system will execute it and strip the tag.

- [ACTION:BUILD:description] — Build a specific feature with the quality loop (build→judge→fix until perfect)
- [ACTION:BUILD_NEXT] — Pull the highest priority task from backlog and build it with the quality loop
- [ACTION:STOP] — Stop whatever is currently running
- [ACTION:STATUS] — Check what's running
- [ACTION:KILL_STALE] — Kill orphaned processes
- [ACTION:BACKLOG:PRIORITY:SIZE:idea] — Add to backlog (priority: CRITICAL/HIGH/MEDIUM/LOW, size: S/M/L)
- [ACTION:CREATIVE] — Dispatch creative agent to brainstorm features, results land in backlog

Combine actions with text. Example: "On it. [ACTION:BUILD:add dupe alert pills to results cards]"
Be smart about intent:
- "build this" / "let's do it" / "ship it" = BUILD with description from context
- "keep going" / "next" / "burn tokens" = BUILD_NEXT
- "save for later" / "backlog that" = BACKLOG
- "come up with ideas" / "brainstorm" = CREATIVE
- "what's running" = STATUS
- "stop" / "kill it" = STOP`;

// ─── Helper: Send to channel (handles 2000 char limit, mobile-friendly) ─────
async function sendToChannel(channel, text) {
  if (!channel) return;

  let cleaned = text.replace(/\n{3,}/g, "\n\n").trim();

  const chunks = [];
  while (cleaned.length > 0) {
    if (cleaned.length <= 1900) {
      chunks.push(cleaned);
      break;
    }

    let breakAt = -1;
    const searchEnd = Math.min(cleaned.length, 1900);

    const codeBlockStart = cleaned.lastIndexOf("```", searchEnd);
    const codeBlockEnd = cleaned.indexOf("```", codeBlockStart + 3);
    if (codeBlockStart >= 0 && (codeBlockEnd < 0 || codeBlockEnd > searchEnd)) {
      breakAt = cleaned.lastIndexOf("\n", codeBlockStart);
      if (breakAt < 200) breakAt = codeBlockStart;
    }

    if (breakAt < 0) {
      breakAt = cleaned.lastIndexOf("\n\n", searchEnd);
    }
    if (breakAt < 200) {
      breakAt = cleaned.lastIndexOf("\n", searchEnd);
    }
    if (breakAt < 200) {
      breakAt = cleaned.lastIndexOf(" ", searchEnd);
    }
    if (breakAt < 200) {
      breakAt = searchEnd;
    }

    chunks.push(cleaned.slice(0, breakAt).trimEnd());
    cleaned = cleaned.slice(breakAt).trimStart();
  }

  for (const chunk of chunks) {
    if (chunk.trim()) await channel.send(chunk);
  }
}

// ─── Helper: Chat with Opus via Claude Code CLI ─────────────────────────────
async function chatWithOpus(userMessage) {
  conversationHistory.push({ role: "user", content: userMessage });

  if (conversationHistory.length > 40) {
    conversationHistory = conversationHistory.slice(-40);
  }

  const context = conversationHistory.slice(0, -1).map(m =>
    `${m.role === "user" ? "Jules" : "ATTAIRE"}: ${m.content}`
  ).join("\n\n");

  const fullPrompt = [
    SYSTEM_PROMPT,
    "",
    context ? `Previous conversation:\n${context}\n` : "",
    `Jules: ${userMessage}`,
  ].filter(Boolean).join("\n");

  const reply = await new Promise((resolve, reject) => {
    const proc = spawn("claude", [
      "-p", "--model", "opus", "--output-format", "text",
      "--dangerously-skip-permissions",
    ], {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: REPO_ROOT,
      env: { ...process.env, GH_TOKEN: process.env.GH_TOKEN ?? "" },
    });

    let output = "";
    let stderr = "";
    proc.stdout.on("data", d => output += d.toString());
    proc.stderr.on("data", d => stderr += d.toString());
    proc.on("close", (code) => {
      if (code !== 0 && !output.trim()) {
        reject(new Error(stderr.trim() || `claude exited with code ${code}`));
      } else {
        resolve(output.trim());
      }
    });
    proc.on("error", reject);

    proc.stdin.write(fullPrompt);
    proc.stdin.end();
  });

  conversationHistory.push({ role: "assistant", content: reply });
  return reply;
}

// ─── Helper: Run a Claude agent with a prompt, return its output ────────────
function runAgent(prompt, { label = "agent", onLog } = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn("claude", [
      "-p", "--model", "opus", "--output-format", "text",
      "--dangerously-skip-permissions",
      "--max-turns", "200",
    ], {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: REPO_ROOT,
      env: { ...process.env },
    });

    activeProcess = proc;
    activeTaskLabel = label;

    let output = "";
    let logBuffer = "";

    proc.stdout.on("data", (d) => {
      const text = d.toString();
      output += text;
      logBuffer += text;
      process.stdout.write(text);
    });

    proc.stderr.on("data", (d) => {
      const text = d.toString();
      logBuffer += text;
      process.stderr.write(text);
    });

    // Flush logs periodically
    const logInterval = setInterval(() => {
      if (logBuffer.trim() && onLog) {
        onLog(logBuffer.slice(0, 1900));
        logBuffer = logBuffer.length > 1900 ? logBuffer.slice(1900) : "";
      }
    }, 5000);

    proc.on("close", (code) => {
      clearInterval(logInterval);
      if (logBuffer.trim() && onLog) onLog(logBuffer.slice(0, 1900));
      activeProcess = null;
      activeTaskLabel = null;
      if (code !== 0 && !output.trim()) {
        reject(new Error(`${label} exited with code ${code}`));
      } else {
        resolve(output.trim());
      }
    });

    proc.on("error", (err) => {
      clearInterval(logInterval);
      activeProcess = null;
      activeTaskLabel = null;
      reject(err);
    });

    proc.stdin.write(prompt);
    proc.stdin.end();
  });
}

// ─── Build → Judge → Fix Loop ───────────────────────────────────────────────
async function buildWithQualityLoop(taskDescription, chatChannel, logsChannel) {
  const MAX_ITERATIONS = 10;
  let iteration = 0;

  const logToDiscord = (text) => {
    if (logsChannel) {
      logsChannel.send("```\n" + text.slice(0, 1900) + "\n```").catch(() => {});
    }
  };

  await chatChannel.send(
    new EmbedBuilder()
      .setColor(0xC9A96E)
      .setTitle("Building")
      .setDescription(taskDescription.slice(0, 4096))
      .setFooter({ text: "Build→Judge→Fix loop started" })
  );

  while (iteration < MAX_ITERATIONS && !stopRequested) {
    iteration++;

    // ── Step 1: Build ──
    await chatChannel.send(`Iteration ${iteration} — building...`);

    const buildPrompt = `You are a senior full-stack engineer building a feature for ATTAIRE (AI fashion shopping app).

REPO: ${REPO_ROOT}
TECH: React 19 + Vite frontend (attair-app/src/App.jsx is the main file), Node/Express + Supabase backend (attair-backend/), Claude AI vision, SerpAPI.

TASK:
${taskDescription}

${iteration > 1 ? `This is iteration ${iteration}. The previous build did NOT pass quality review. Fix the issues identified by the judge (see below) and bring this to production quality.` : ""}

INSTRUCTIONS:
1. Read the relevant files first to understand current state.
2. Build the feature to FULL PRODUCTION quality — not a skeleton, not a placeholder. Ship-ready code.
3. Follow existing patterns in the codebase (design tokens in index.css, component styles in App.css).
4. The app should look and feel as polished as TikTok, Depop, Pickle, or Instagram.
5. After building, run the backend tests: cd attair-backend && npm test
6. Fix any test failures before finishing.
7. Commit your changes with: git add -A && git commit -m "feat: [short summary]"

Do NOT create new files unless absolutely necessary. Build within existing files.
Do NOT change function signatures in attair-backend/src/services/products.js.`;

    try {
      await runAgent(buildPrompt, { label: `build:${taskDescription.slice(0, 30)}`, onLog: logToDiscord });
    } catch (err) {
      await chatChannel.send(`Build agent error: ${err.message.slice(0, 200)}`);
      if (stopRequested) break;
      continue;
    }

    if (stopRequested) break;

    // ── Step 2: Test ──
    await chatChannel.send(`Iteration ${iteration} — running tests...`);

    let testOutput = "";
    try {
      testOutput = execSync("npm test 2>&1", {
        cwd: join(REPO_ROOT, "attair-backend"),
        encoding: "utf-8",
        timeout: 120000,
      });
    } catch (err) {
      testOutput = err.stdout || err.message;
    }

    const testsPass = testOutput.includes("Tests") && !testOutput.includes("FAIL") && !testOutput.includes("failed");

    // ── Step 3: Screenshot ──
    await chatChannel.send(`Iteration ${iteration} — taking screenshots...`);

    let screenshotPaths = [];
    try {
      screenshotPaths = await takeScreenshots();
    } catch (err) {
      await chatChannel.send(`Screenshot warning: ${err.message.slice(0, 200)} — judging without visuals.`);
    }

    if (stopRequested) break;

    // ── Step 4: Judge ──
    await chatChannel.send(`Iteration ${iteration} — judging quality...`);

    const screenshotInstructions = screenshotPaths.length > 0
      ? screenshotPaths.map(p => `Read the screenshot at: ${p}`).join("\n")
      : "No screenshots available — judge based on code quality and test results only.";

    const judgePrompt = `You are a ruthless quality judge for ATTAIRE (AI fashion shopping app).
Your job: decide if a feature is PRODUCTION-READY or needs more work.

THE FEATURE BEING JUDGED:
${taskDescription}

TEST RESULTS:
${testOutput.slice(-3000)}

SCREENSHOTS:
${screenshotInstructions}

QUALITY BAR — The app must feel as polished as TikTok, Depop, Pickle, or Instagram:
- UI: Clean, modern, mobile-first. No jank, no placeholder text, no broken layouts.
- Animations: Smooth transitions where expected. No jarring state changes.
- Code: No console errors, no broken imports, no dead code from this change.
- Tests: All tests must pass. New functionality should have test coverage.
- Polish: Hover states, loading states, error states, empty states all handled.

RESPOND WITH EXACTLY ONE OF:
1. "APPROVED" — if the feature is production-ready. Add a one-line summary of what's good.
2. "NEEDS_WORK" — if it's not ready. List SPECIFIC issues that must be fixed (not vague suggestions).

Be demanding. If tests fail, it's an automatic NEEDS_WORK. If the UI looks like a dev prototype, NEEDS_WORK.
Only approve work you'd ship to real users today.`;

    let judgeVerdict = "";
    try {
      judgeVerdict = await runAgent(judgePrompt, { label: "judge", onLog: logToDiscord });
    } catch (err) {
      await chatChannel.send(`Judge error: ${err.message.slice(0, 200)} — retrying build.`);
      continue;
    }

    if (stopRequested) break;

    // ── Step 5: Evaluate verdict ──
    const approved = judgeVerdict.toUpperCase().includes("APPROVED") && !judgeVerdict.toUpperCase().includes("NEEDS_WORK");

    if (approved) {
      await chatChannel.send(
        new EmbedBuilder()
          .setColor(0x2ECC71)
          .setTitle("Approved")
          .setDescription(`**${taskDescription.slice(0, 200)}**\n\nPassed quality review after ${iteration} iteration(s).`)
          .setFooter({ text: judgeVerdict.slice(0, 200) })
      );
      return true;
    }

    // Not approved — feed judge feedback into next iteration
    await chatChannel.send(
      new EmbedBuilder()
        .setColor(0xE74C3C)
        .setTitle(`Iteration ${iteration} — Needs Work`)
        .setDescription(judgeVerdict.slice(0, 4096))
    );

    // Append judge feedback to task description for next iteration
    taskDescription += `\n\nJUDGE FEEDBACK (iteration ${iteration}):\n${judgeVerdict}`;
  }

  if (stopRequested) {
    await chatChannel.send("Build loop stopped.");
    stopRequested = false;
    return false;
  }

  await chatChannel.send(`Hit max iterations (${MAX_ITERATIONS}) for this task. Moving on.`);
  return false;
}

// ─── Screenshot Helper ──────────────────────────────────────────────────────
async function takeScreenshots() {
  const screenshotDir = join(__dirname, ".screenshots");
  if (!existsSync(screenshotDir)) mkdirSync(screenshotDir, { recursive: true });

  const timestamp = Date.now();
  const scriptPath = join(screenshotDir, `_capture_${timestamp}.mjs`);

  // Write a temporary Playwright script to capture key screens
  writeFileSync(scriptPath, `
import { chromium } from "playwright";
import { join } from "path";

const dir = ${JSON.stringify(screenshotDir)};
const ts = ${JSON.stringify(String(timestamp))};

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 }, // iPhone 14 Pro
    deviceScaleFactor: 3,
  });
  const page = await context.newPage();

  const screens = [
    { name: "home", url: "http://localhost:5173/", waitFor: 3000 },
    { name: "scan", url: "http://localhost:5173/", action: async () => {
      // Try clicking scan button if it exists
      const scanBtn = page.locator('[class*="scan"], [class*="camera"], button:has-text("Scan")').first();
      if (await scanBtn.isVisible().catch(() => false)) await scanBtn.click();
      await page.waitForTimeout(1000);
    }},
    { name: "profile", url: "http://localhost:5173/", action: async () => {
      const profileBtn = page.locator('[class*="profile"], [class*="avatar"], button:has-text("Profile")').first();
      if (await profileBtn.isVisible().catch(() => false)) await profileBtn.click();
      await page.waitForTimeout(1000);
    }},
  ];

  const paths = [];
  for (const screen of screens) {
    try {
      await page.goto(screen.url, { waitUntil: "networkidle", timeout: 10000 }).catch(() =>
        page.goto(screen.url, { waitUntil: "load", timeout: 10000 })
      );
      if (screen.waitFor) await page.waitForTimeout(screen.waitFor);
      if (screen.action) await screen.action();
      const path = join(dir, \`\${ts}-\${screen.name}.png\`);
      await page.screenshot({ path, fullPage: false });
      paths.push(path);
    } catch (e) {
      console.error(\`Failed to capture \${screen.name}: \${e.message}\`);
    }
  }

  await browser.close();
  console.log(JSON.stringify(paths));
})();
`);

  try {
    const result = execSync(`node "${scriptPath}"`, {
      cwd: REPO_ROOT,
      encoding: "utf-8",
      timeout: 60000,
      env: { ...process.env },
    });

    // Parse the JSON array of paths from the script output
    const match = result.match(/\[.*\]/);
    return match ? JSON.parse(match[0]) : [];
  } catch (err) {
    throw new Error(`Screenshot capture failed: ${err.message.slice(0, 200)}`);
  } finally {
    // Clean up temp script
    try { writeFileSync(scriptPath, ""); } catch {}
  }
}

// ─── Token-Maximizing Work Loop ─────────────────────────────────────────────
async function buildFromBacklog(chatChannel, logsChannel) {
  if (buildLoopRunning) {
    await chatChannel.send("Build loop is already running.");
    return;
  }

  buildLoopRunning = true;
  stopRequested = false;

  await chatChannel.send("Starting backlog work loop. Building until I run out of tasks or tokens.");

  while (!stopRequested) {
    const task = getNextBacklogTask();
    if (!task) {
      await chatChannel.send("Backlog is empty — nothing left to build. Nice.");
      break;
    }

    await chatChannel.send(
      new EmbedBuilder()
        .setColor(0x3498DB)
        .setTitle("Next Task")
        .setDescription(`**${task.title}**\n${task.summary || ""}`.slice(0, 4096))
        .addFields(
          { name: "Priority", value: task.priority || "?", inline: true },
          { name: "Size", value: task.size || "?", inline: true },
        )
    );

    const success = await buildWithQualityLoop(
      `${task.title}\n\n${task.summary || ""}`,
      chatChannel,
      logsChannel,
    );

    if (success) {
      markBacklogTaskDone(task.title);
    }

    if (stopRequested) break;
  }

  buildLoopRunning = false;
  stopRequested = false;
  await chatChannel.send("Build loop finished.");
}

// ─── Backlog Management ─────────────────────────────────────────────────────
function readBacklog() {
  if (!existsSync(BACKLOG_PATH)) return "";
  return readFileSync(BACKLOG_PATH, "utf-8");
}

function getNextBacklogTask() {
  const content = readBacklog();
  if (!content) return null;

  // Parse backlog sections by priority order
  const priorities = ["CRITICAL", "HIGH", "MEDIUM", "LOW"];

  for (const priority of priorities) {
    // Find tasks in this priority section that aren't DONE/DEFERRED
    const sectionRegex = new RegExp(`## ${priority}[\\s\\S]*?(?=## |$)`, "i");
    const section = content.match(sectionRegex);
    if (!section) continue;

    // Find individual tasks (### headers) that have actionable status
    const taskRegex = /### (.+)\n([\s\S]*?)(?=###|$)/g;
    let match;
    while ((match = taskRegex.exec(section[0])) !== null) {
      const title = match[1].trim();
      const body = match[2].trim();

      // Skip done, deferred, or implemented tasks
      if (/status:\s*(done|deferred|implemented|completed)/i.test(body)) continue;

      // Extract summary
      const summaryMatch = body.match(/\*\*Summary:\*\*\s*(.+)/);
      const summary = summaryMatch ? summaryMatch[1].trim() : body.split("\n")[0];

      // Extract size
      const sizeMatch = body.match(/\*\*Effort:\*\*\s*(\S+)/);
      const size = sizeMatch ? sizeMatch[1].trim() : "M";

      return { title, summary, priority, size };
    }
  }

  // Also check "Approved" sections
  const approvedRegex = /## Approved[\s\S]*?(?=## |$)/gi;
  let approvedMatch;
  while ((approvedMatch = approvedRegex.exec(content)) !== null) {
    const taskRegex = /### (.+)\n([\s\S]*?)(?=###|$)/g;
    let match;
    while ((match = taskRegex.exec(approvedMatch[0])) !== null) {
      const title = match[1].trim();
      const body = match[2].trim();
      if (/status:\s*(done|deferred|implemented|completed)/i.test(body)) continue;

      const summaryMatch = body.match(/\*\*Summary:\*\*\s*(.+)/);
      const summary = summaryMatch ? summaryMatch[1].trim() : body.split("\n")[0];
      const sizeMatch = body.match(/\*\*Effort:\*\*\s*(\S+)/);
      const size = sizeMatch ? sizeMatch[1].trim() : "M";

      return { title, summary, priority: "APPROVED", size };
    }
  }

  return null;
}

function markBacklogTaskDone(title) {
  let content = readBacklog();
  if (!content) return;

  // Find the task and update its status
  const escaped = title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const taskRegex = new RegExp(`(### ${escaped}\\n[\\s\\S]*?\\*\\*Status:\\*\\*)\\s*[^\\n]+`, "i");
  const match = content.match(taskRegex);

  if (match) {
    const date = new Date().toISOString().split("T")[0];
    content = content.replace(taskRegex, `$1 DONE (${date})`);
    writeFileSync(BACKLOG_PATH, content);
  }
}

function addToBacklog(priority, size, idea) {
  let content = readBacklog();
  const date = new Date().toISOString().split("T")[0];

  const entry = `\n### ${idea.split("\n")[0]}
**Status:** ${priority} — Queued
**Effort:** ${size}
**Summary:** ${idea}
**Added:** ${date} via Discord
`;

  // Try to insert under the right priority section
  const sectionHeader = `## ${priority}`;
  const sectionIndex = content.indexOf(sectionHeader);

  if (sectionIndex >= 0) {
    // Find the end of this section (next ## header or EOF)
    const nextSection = content.indexOf("\n## ", sectionIndex + sectionHeader.length);
    const insertAt = nextSection >= 0 ? nextSection : content.length;
    content = content.slice(0, insertAt) + entry + content.slice(insertAt);
  } else {
    // Create new section
    content += `\n${sectionHeader}\n${entry}`;
  }

  writeFileSync(BACKLOG_PATH, content);
}

// ─── Creative Agent ─────────────────────────────────────────────────────────
async function runCreativeAgent(chatChannel, logsChannel) {
  if (activeProcess) {
    await chatChannel.send("Something is already running. Say `stop` first.");
    return;
  }

  await chatChannel.send("Spinning up creative agent to brainstorm features...");

  const logToDiscord = (text) => {
    if (logsChannel) {
      logsChannel.send("```\n" + text.slice(0, 1900) + "\n```").catch(() => {});
    }
  };

  const creativePrompt = `You are the product strategist for ATTAIRE (AI fashion shopping app).

REPO: ${REPO_ROOT}
Read the app code deeply to understand what exists. Then read the backlog at agents/backlog.md.

YOUR JOB: Propose 3-5 bold, specific feature ideas that would drive growth, retention, or monetization.
Think like the best product minds at TikTok, Depop, Instagram, and Pickle.

For each idea, write:
- Title (catchy, specific)
- Summary (2-3 sentences, concrete not vague)
- Why it matters (growth/retention/revenue angle)
- Effort estimate: S (1 agent, <1hr), M (1-2 agents), L (2+ agents, complex)
- Priority recommendation: CRITICAL / HIGH / MEDIUM / LOW

After analyzing, append your ideas to agents/backlog.md under a new section:
## Proposed — Creative Agent ${new Date().toISOString().split("T")[0]}

Use the same markdown format as existing backlog entries. Set status to "Proposed — Pending Jules Approval".

Commit with: git add agents/backlog.md && git commit -m "feat: creative agent — new feature proposals"`;

  try {
    const output = await runAgent(creativePrompt, { label: "creative", onLog: logToDiscord });

    await chatChannel.send(
      new EmbedBuilder()
        .setColor(0x9B59B6)
        .setTitle("Creative Agent Done")
        .setDescription("New ideas added to backlog. Review them and tell me what to build.")
    );
  } catch (err) {
    await chatChannel.send(`Creative agent error: ${err.message.slice(0, 200)}`);
  }
}

// ─── Handle incoming Discord messages ────────────────────────────────────────
async function handleMessage(message) {
  if (message.author.bot) return;
  if (message.channel.id !== CHAT_CHANNEL_ID) return;

  const content = message.content.trim();
  const attachments = [...message.attachments.values()];
  const hasImages = attachments.some(a => a.contentType?.startsWith("image/"));

  if (!content && !hasImages) return;

  lastMessageTime = Date.now();

  await message.channel.sendTyping();

  // ── Download any image attachments ──
  const imagePaths = [];
  if (hasImages) {
    const screenshotDir = join(__dirname, ".discord-screenshots");
    if (!existsSync(screenshotDir)) mkdirSync(screenshotDir, { recursive: true });

    for (const att of attachments) {
      if (!att.contentType?.startsWith("image/")) continue;
      const ext = att.name?.split(".").pop() || "png";
      const filename = `discord-${Date.now()}-${att.id}.${ext}`;
      const filepath = join(screenshotDir, filename);
      try {
        const res = await fetch(att.url);
        const fileStream = createWriteStream(filepath);
        await pipeline(res.body, fileStream);
        imagePaths.push(filepath);
      } catch (e) {
        console.error("Failed to download attachment:", e.message);
      }
    }
  }

  // ── Build prompt with image references ──
  let userMessage = content || "";
  if (imagePaths.length) {
    const imageInstructions = imagePaths.map(p =>
      `Jules sent a screenshot. Read the image at: ${p}`
    ).join("\n");
    userMessage = userMessage
      ? `${userMessage}\n\n${imageInstructions}`
      : imageInstructions;
  }

  // ── Everything goes through Claude — it decides what to do ──
  try {
    const thinking = await message.channel.send("...");

    const reply = await chatWithOpus(userMessage);

    await thinking.delete().catch(() => {});

    // Parse and execute any action tags Claude included
    const displayText = await executeActions(reply, message.channel);

    if (displayText.trim()) {
      if (displayText.length > 300) {
        const embed = new EmbedBuilder()
          .setColor(0xC9A96E)
          .setDescription(displayText.slice(0, 4096));
        await message.channel.send({ embeds: [embed] });
      } else {
        await sendToChannel(message.channel, displayText);
      }
    }
  } catch (err) {
    console.error("Claude error:", err.message);
    await message.reply("Error: " + err.message.slice(0, 200));
  }
}

// ─── Action Parser ──────────────────────────────────────────────────────────
async function executeActions(reply, channel) {
  let text = reply;

  // [ACTION:BUILD:description]
  const buildMatch = text.match(/\[ACTION:BUILD:([\s\S]*?)\]/);
  if (buildMatch) {
    const description = buildMatch[1].trim();
    text = text.replace(buildMatch[0], "").trim();
    const logsChannel = LOGS_CHANNEL_ID ? await client.channels.fetch(LOGS_CHANNEL_ID).catch(() => null) : null;
    // Run build loop in background so we can keep chatting
    buildWithQualityLoop(description, channel, logsChannel).catch(err => {
      channel.send(`Build loop error: ${err.message.slice(0, 200)}`).catch(() => {});
    });
  }

  // [ACTION:BUILD_NEXT]
  if (text.includes("[ACTION:BUILD_NEXT]")) {
    text = text.replace(/\[ACTION:BUILD_NEXT\]/g, "").trim();
    const logsChannel = LOGS_CHANNEL_ID ? await client.channels.fetch(LOGS_CHANNEL_ID).catch(() => null) : null;
    buildFromBacklog(channel, logsChannel).catch(err => {
      channel.send(`Backlog loop error: ${err.message.slice(0, 200)}`).catch(() => {});
    });
  }

  // [ACTION:STOP]
  if (text.includes("[ACTION:STOP]")) {
    text = text.replace(/\[ACTION:STOP\]/g, "").trim();
    stopRequested = true;
    if (activeProcess) {
      activeProcess.kill("SIGTERM");
      text = text || "Sent stop signal.";
    } else if (!buildLoopRunning) {
      text = text || "Nothing running.";
    } else {
      text = text || "Stop requested — will halt after current step.";
    }
  }

  // [ACTION:STATUS]
  if (text.includes("[ACTION:STATUS]")) {
    text = text.replace(/\[ACTION:STATUS\]/g, "").trim();
    let status;
    if (buildLoopRunning) {
      status = `Build loop running. Current: ${activeTaskLabel || "between tasks"}`;
    } else if (activeProcess) {
      status = `Running: ${activeTaskLabel || "agent"}`;
    } else {
      status = "Nothing running.";
    }
    text = text ? `${text}\n${status}` : status;
  }

  // [ACTION:KILL_STALE]
  if (text.includes("[ACTION:KILL_STALE]")) {
    text = text.replace(/\[ACTION:KILL_STALE\]/g, "").trim();
    try {
      const myPid = process.pid;
      const ps = execSync("ps aux", { encoding: "utf-8" });
      const stale = ps.split("\n").filter(line => {
        if (!line.includes("claude") && !line.includes("node")) return false;
        if (line.includes("grep")) return false;
        if (line.includes("Code Helper")) return false;
        if (line.includes("node discord-bot.js")) return false;
        const pidMatch = line.match(/^\S+\s+(\d+)/);
        if (!pidMatch) return false;
        const pid = parseInt(pidMatch[1]);
        if (pid === myPid) return false;
        return line.includes("claude -p") || line.includes("node agents/");
      });
      let killed = 0;
      for (const line of stale) {
        const pidMatch = line.match(/^\S+\s+(\d+)/);
        if (pidMatch) {
          try { process.kill(parseInt(pidMatch[1])); killed++; } catch {}
        }
      }
      const msg = killed > 0 ? `Killed ${killed} stale process(es).` : "No stale processes found.";
      text = text ? `${text}\n${msg}` : msg;
    } catch (err) {
      text = text ? `${text}\nError checking processes: ${err.message}` : `Error: ${err.message}`;
    }
  }

  // [ACTION:BACKLOG:PRIORITY:SIZE:idea]
  const backlogMatch = text.match(/\[ACTION:BACKLOG:(\w+):(\w+):([\s\S]*?)\]/);
  if (backlogMatch) {
    const priority = backlogMatch[1].toUpperCase();
    const size = backlogMatch[2].toUpperCase();
    const idea = backlogMatch[3].trim();
    text = text.replace(backlogMatch[0], "").trim();
    addToBacklog(priority, size, idea);
    text = text ? `${text}\nAdded to backlog (${priority}, ${size}).` : `Added to backlog (${priority}, ${size}): ${idea.slice(0, 100)}`;
  }

  // [ACTION:CREATIVE]
  if (text.includes("[ACTION:CREATIVE]")) {
    text = text.replace(/\[ACTION:CREATIVE\]/g, "").trim();
    const logsChannel = LOGS_CHANNEL_ID ? await client.channels.fetch(LOGS_CHANNEL_ID).catch(() => null) : null;
    runCreativeAgent(channel, logsChannel).catch(err => {
      channel.send(`Creative agent error: ${err.message.slice(0, 200)}`).catch(() => {});
    });
  }

  return text;
}

// ─── Discord Events ──────────────────────────────────────────────────────────
client.once("ready", () => {
  console.log(`\nATTAIRE Bot online as ${client.user.tag}`);
  console.log(`Chat channel: ${CHAT_CHANNEL_ID || "(not set)"}`);
  console.log(`Logs channel: ${LOGS_CHANNEL_ID || "(not set)"}`);
  console.log("Waiting for messages...\n");

  if (CHAT_CHANNEL_ID) {
    client.channels.fetch(CHAT_CHANNEL_ID).then(ch => {
      ch.send("ATTAIRE is online. What are we building?");
    }).catch(() => {});
  }
});

client.on("messageCreate", handleMessage);

client.on("error", (err) => {
  console.error("Discord error:", err.message);
});

// ─── Proactive Check-ins ─────────────────────────────────────────────────────
let lastMessageTime = Date.now();
const CHECKIN_INTERVAL = 3 * 60 * 60 * 1000;

setInterval(async () => {
  if (!CHAT_CHANNEL_ID) return;
  if (buildLoopRunning || activeProcess) return;
  if (Date.now() - lastMessageTime < CHECKIN_INTERVAL) return;

  try {
    const channel = await client.channels.fetch(CHAT_CHANNEL_ID);
    const nextTask = getNextBacklogTask();

    if (nextTask) {
      await channel.send(`Backlog has work queued — next up: **${nextTask.title}** (${nextTask.priority}, ${nextTask.size}). Want me to start building?`);
    } else {
      await channel.send("Nothing in the backlog. Want to brainstorm or add something?");
    }
    lastMessageTime = Date.now();
  } catch {}
}, 30 * 60 * 1000);

// ─── Start ───────────────────────────────────────────────────────────────────
console.log("Connecting to Discord...");
client.login(DISCORD_TOKEN);
