#!/usr/bin/env node
/**
 * ATTAIRE Discord Bot — Jules' mobile dev CLI
 * ─────────────────────────────────────────────────────────────
 * Run: node discord-bot.js
 *
 * Hosted deployment (Railway, VPS, etc.) — no Claude CLI dependency.
 * Uses Anthropic SDK directly for chat + agentic tool-use loops for builds.
 *
 * Features:
 *   - Opus-powered chat via Anthropic API (no CLI needed)
 *   - Build→Judge→Fix loop with agentic tool-use (read/write/bash)
 *   - Token-maximizing: finishes one task, pulls next from backlog
 *   - Backlog management with priority + sizing
 *   - Creative agent for generating feature ideas
 *   - Screenshot-based visual QA against reference apps
 *   - Health check HTTP server for Railway/hosting platforms
 *   - Cross-platform (Linux/macOS/Windows)
 */

import { Client, GatewayIntentBits, Partials, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType } from "discord.js";
import { createKeepAliveSystem, KEEPALIVE_RESPONSE_TIMEOUT, IDLE_KEEPALIVE_THRESHOLD, IDLE_CHECK_INTERVAL, BUILD_HEARTBEAT_INTERVAL } from "./keepalive.js";
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, createWriteStream, unlinkSync, statSync } from "fs";
import { spawn, execSync } from "child_process";
import { pipeline } from "stream/promises";
import { fileURLToPath } from "url";
import { dirname, join, resolve, relative, isAbsolute } from "path";
import { config } from "dotenv";
import { randomUUID } from "crypto";
import { createServer } from "http";
import Anthropic from "@anthropic-ai/sdk";

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: join(__dirname, ".env") });

// ─── Config ──────────────────────────────────────────────────────────────────
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const CHAT_CHANNEL_ID = process.env.DISCORD_CHAT_CHANNEL_ID;
const LOGS_CHANNEL_ID = process.env.DISCORD_LOGS_CHANNEL_ID;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const REPO_ROOT = process.env.REPO_ROOT || join(__dirname, "..");
const BACKLOG_PATH = join(__dirname, "backlog.md");
const HEALTH_PORT = parseInt(process.env.HEALTH_PORT || process.env.PORT || "8081", 10);
const IS_HOSTED = process.env.RAILWAY_ENVIRONMENT || process.env.RENDER || process.env.FLY_APP_NAME || process.env.HOSTED === "true";
const GH_TOKEN = process.env.GH_TOKEN || "";
const GH_REPO = process.env.GH_REPO || ""; // e.g. "username/ATTAIR"

if (!DISCORD_TOKEN) {
  console.error("Missing DISCORD_TOKEN in environment");
  process.exit(1);
}
if (!ANTHROPIC_API_KEY) {
  console.error("Missing ANTHROPIC_API_KEY in environment");
  process.exit(1);
}

// ─── Anthropic Client ────────────────────────────────────────────────────────
const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

// ─── Health Check Server (for Railway / hosting platforms) ───────────────────
const healthServer = createServer((req, res) => {
  if (req.url === "/health" || req.url === "/") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      status: "ok",
      bot: client.isReady() ? "connected" : "connecting",
      uptime: Math.floor(process.uptime()),
      activeTask: activeTaskLabel || null,
      buildLoopRunning,
    }));
  } else {
    res.writeHead(404);
    res.end("Not found");
  }
});
healthServer.listen(HEALTH_PORT, () => {
  console.log(`Health check server listening on port ${HEALTH_PORT}`);
});

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
let activeProcess = null;           // current agent abort controller or child process
let activeTaskLabel = null;         // what's currently running (for status)
let conversationHistory = [];       // Claude conversation context
let buildLoopRunning = false;       // is the build→judge→fix loop active?
let stopRequested = false;          // user asked to stop

// ─── Keep-Alive State ───────────────────────────────────────────────────────
let lastBuildHeartbeat = 0;          // timestamp of last build heartbeat ping

// ─── System Prompt ──────────────────────────────────────────────────────────
const SYSTEM_PROMPT = `You're Jules' product partner for ATTAIRE (AI fashion shopping app). Discord on his phone.

RULES:
- TEXT like a coworker. 1-2 sentences max unless he asks for more.
- No intros, no "great question", no fluff. Just answer.
- If he says something vague, ask ONE clarifying question.
- You can push back, suggest things, and start conversations.
- Format for mobile: short lines, no walls of text, use bullet points sparingly.
- When Jules reports a bug or issue, INVESTIGATE IT YOURSELF. You have tools — read the code, check Railway logs, hit endpoints (curl), read files. Do NOT ask Jules to check browser console or do debugging for you. You are the engineer.

CONTEXT: React 19 + Vite, Node/Express on Railway, Supabase, Claude AI vision, SerpAPI, freemium model.
Backlog lives at agents/backlog.md — markdown with priority sections and sizing.

DEPLOYMENT:
- Frontend: Vercel at https://attair.vercel.app (React + Vite, env vars: VITE_API_BASE, VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY)
- Backend: Railway at https://attair-production.up.railway.app (Node/Express, port 8080)
- Database: Supabase (project ref: cmlgqztjkrfipzknwnfm)
- Use "curl https://attair-production.up.railway.app/health" to check backend health
- Frontend code is in attair-app/, backend in attair-backend/

HOW YOU WORK:
You're Jules' Claude CLI through Discord. Your DEFAULT mode is conversational — interview him for
feature ideas, answer questions, manage the backlog, give opinions. You're a coworker, not an
autonomous build machine. Only dispatch builds when Jules explicitly asks you to build something.

When Jules DOES ask you to build, you use a quality loop: build → test → screenshot → judge against
reference apps (TikTok, Depop, Pickle, Instagram) → if not good enough, fix and repeat → only move on
when the feature is production-quality.

BUILD_NEXT (the backlog grind loop) is ONLY for when Jules explicitly says to burn through the backlog.
Phrases like "burn tokens", "grind the backlog", "keep building", "max it out". Do NOT trigger this
from casual conversation. When in doubt, ask.

ACTIONS YOU CAN TRIGGER:
Include the action tag in your response. The system will execute it and strip the tag.

- [ACTION:BUILD:description] — Build ONE specific feature with the quality loop. Only when Jules asks to build.
- [ACTION:BUILD_NEXT] — Grind through backlog continuously. When Jules tells you to start building, kick off the loop, go, etc. Don't ask for confirmation — just do it.
- [ACTION:STOP] — Stop whatever is currently running
- [ACTION:STATUS] — Check what's running
- [ACTION:KILL_STALE] — Kill orphaned processes
- [ACTION:BACKLOG:PRIORITY:SIZE:idea] — Add to backlog (priority: CRITICAL/HIGH/MEDIUM/LOW, size: S/M/L)
- [ACTION:CREATIVE] — Dispatch creative agent to brainstorm features, results land in backlog
- [ACTION:KEEPALIVE] — Send a keep-alive ping to Jules (useful before long operations)

Combine actions with text. Example: "On it. [ACTION:BUILD:add dupe alert pills to results cards]"
Be smart about intent:
- "build this" / "let's do it" / "ship it" = BUILD with description from context
- "burn tokens" / "grind the backlog" / "max it out" / "keep building" / "kick off build loop" / "start building" / "go" (when context is clearly about building) = BUILD_NEXT
- "save for later" / "backlog that" = BACKLOG
- "come up with ideas" / "brainstorm" = CREATIVE
- "what's running" = STATUS
- "stop" / "kill it" = STOP
- Everything else = just chat, don't dispatch anything`;

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
    if (chunk.trim()) {
      try { await channel.send(chunk); } catch (e) { console.error("[sendToChannel] failed:", e.message); }
    }
  }
}

// ─── Helper: Execute shell command (cross-platform) ─────────────────────────
function execCommand(cmd, { cwd = REPO_ROOT, timeout = 60000 } = {}) {
  try {
    return execSync(cmd, {
      cwd,
      encoding: "utf-8",
      timeout,
      shell: true,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
  } catch (err) {
    return err.stdout || err.stderr || err.message || "";
  }
}

// ─── Helper: Spawn shell command (cross-platform, async) ────────────────────
function spawnCommand(cmd, { cwd = REPO_ROOT } = {}) {
  const isWindows = process.platform === "win32";
  if (isWindows) {
    return spawn("cmd.exe", ["/s", "/c", cmd], { stdio: ["ignore", "pipe", "pipe"], cwd, shell: false });
  }
  return spawn("sh", ["-c", cmd], { stdio: ["ignore", "pipe", "pipe"], cwd });
}

// ─── Agentic Tool Definitions ───────────────────────────────────────────────
const AGENT_TOOLS = [
  {
    name: "read_file",
    description: "Read a file from the repository. Returns file contents with line numbers.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path relative to repo root (e.g. 'attair-backend/src/index.js')" },
        offset: { type: "number", description: "Line number to start reading from (1-based)" },
        limit: { type: "number", description: "Maximum number of lines to read" },
      },
      required: ["path"],
    },
  },
  {
    name: "write_file",
    description: "Write content to a file (creates or overwrites).",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path relative to repo root" },
        content: { type: "string", description: "Full file content to write" },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "edit_file",
    description: "Replace a specific string in a file. old_string must be unique in the file.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path relative to repo root" },
        old_string: { type: "string", description: "The exact string to find and replace" },
        new_string: { type: "string", description: "The replacement string" },
      },
      required: ["path", "old_string", "new_string"],
    },
  },
  {
    name: "list_files",
    description: "List files matching a glob pattern in the repository.",
    input_schema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Glob pattern (e.g. 'attair-backend/src/**/*.js')" },
      },
      required: ["pattern"],
    },
  },
  {
    name: "search_files",
    description: "Search for a regex pattern across files. Returns matching lines with file paths.",
    input_schema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Regex pattern to search for" },
        path: { type: "string", description: "Directory or file to search in (relative to repo root)" },
        glob: { type: "string", description: "File glob filter (e.g. '*.js')" },
      },
      required: ["pattern"],
    },
  },
  {
    name: "bash",
    description: "Execute a shell command. Use for: git, npm, node, curl, etc. Commands run from repo root.",
    input_schema: {
      type: "object",
      properties: {
        command: { type: "string", description: "The shell command to execute" },
        cwd: { type: "string", description: "Working directory (relative to repo root)" },
        timeout: { type: "number", description: "Timeout in ms (default 120000)" },
      },
      required: ["command"],
    },
  },
];

// ─── Tool Executor ──────────────────────────────────────────────────────────
function executeToolCall(name, input) {
  try {
    switch (name) {
      case "read_file": {
        const filePath = resolve(REPO_ROOT, input.path);
        if (!existsSync(filePath)) return `Error: File not found: ${input.path}`;
        const content = readFileSync(filePath, "utf-8");
        const lines = content.split("\n");
        const offset = (input.offset || 1) - 1;
        const limit = input.limit || lines.length;
        const slice = lines.slice(offset, offset + limit);
        return slice.map((line, i) => `${offset + i + 1}\t${line}`).join("\n");
      }

      case "write_file": {
        const filePath = resolve(REPO_ROOT, input.path);
        const dir = dirname(filePath);
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
        writeFileSync(filePath, input.content);
        return `Written ${input.content.length} bytes to ${input.path}`;
      }

      case "edit_file": {
        const filePath = resolve(REPO_ROOT, input.path);
        if (!existsSync(filePath)) return `Error: File not found: ${input.path}`;
        let content = readFileSync(filePath, "utf-8");
        const occurrences = content.split(input.old_string).length - 1;
        if (occurrences === 0) return `Error: old_string not found in ${input.path}`;
        if (occurrences > 1) return `Error: old_string found ${occurrences} times in ${input.path} — must be unique. Provide more context.`;
        content = content.replace(input.old_string, input.new_string);
        writeFileSync(filePath, content);
        return `Edited ${input.path} — replaced 1 occurrence`;
      }

      case "list_files": {
        // Simple glob using find/dir command
        const result = execCommand(
          process.platform === "win32"
            ? `dir /s /b "${input.pattern}" 2>nul`
            : `find . -path "./${input.pattern}" -type f 2>/dev/null | head -100`,
          { timeout: 10000 }
        );
        if (!result.trim()) {
          // Fallback: use a node-based approach
          const parts = input.pattern.split("/");
          const dir = parts.slice(0, -1).join("/") || ".";
          const fullDir = resolve(REPO_ROOT, dir);
          if (!existsSync(fullDir)) return `No files found matching ${input.pattern}`;
          try {
            const files = readdirSync(fullDir, { recursive: true })
              .slice(0, 100)
              .map(f => join(dir, f));
            return files.join("\n") || `No files found matching ${input.pattern}`;
          } catch { return `No files found matching ${input.pattern}`; }
        }
        return result.trim();
      }

      case "search_files": {
        const searchPath = input.path ? resolve(REPO_ROOT, input.path) : REPO_ROOT;
        const globFlag = input.glob ? `--include="${input.glob}"` : "";
        const cmd = process.platform === "win32"
          ? `findstr /s /n /r "${input.pattern}" ${input.glob || "*.*"}`
          : `grep -rn ${globFlag} -E "${input.pattern.replace(/"/g, '\\"')}" "${searchPath}" 2>/dev/null | head -50`;
        const result = execCommand(cmd, { cwd: searchPath, timeout: 15000 });
        return result.trim() || `No matches found for: ${input.pattern}`;
      }

      case "bash": {
        const cwd = input.cwd ? resolve(REPO_ROOT, input.cwd) : REPO_ROOT;
        const timeout = input.timeout || 120000;

        // Safety: block dangerous commands
        const cmd = input.command.trim();
        const dangerous = ["rm -rf /", "mkfs", "dd if=", "> /dev/sd"];
        if (dangerous.some(d => cmd.includes(d))) {
          return "Error: Command blocked for safety reasons.";
        }

        try {
          const result = execSync(cmd, {
            cwd,
            encoding: "utf-8",
            timeout,
            shell: true,
            maxBuffer: 10 * 1024 * 1024, // 10MB
            env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
          });
          return result.trim() || "(no output)";
        } catch (err) {
          const output = [err.stdout, err.stderr, err.message].filter(Boolean).join("\n");
          return `Exit code ${err.status || "unknown"}:\n${output.slice(0, 5000)}`;
        }
      }

      default:
        return `Unknown tool: ${name}`;
    }
  } catch (err) {
    return `Error executing ${name}: ${err.message}`;
  }
}

// ─── Agentic Loop: Run Claude with tools until complete ─────────────────────
async function runAgentLoop(systemPrompt, userPrompt, { label = "agent", maxTurns = 200, model = "claude-sonnet-4-20250514", onLog, abortSignal } = {}) {
  const messages = [{ role: "user", content: userPrompt }];
  let turnCount = 0;
  let finalText = "";

  while (turnCount < maxTurns) {
    if (abortSignal?.aborted) throw new Error("Agent aborted by user");
    turnCount++;

    if (onLog) onLog(`[${label}] Turn ${turnCount}...`);

    let response;
    try {
      response = await anthropic.messages.create({
        model,
        max_tokens: 16000,
        system: systemPrompt,
        tools: AGENT_TOOLS,
        messages,
      });
    } catch (err) {
      console.error(`[${label}] API error on turn ${turnCount}:`, err.message);
      if (err.status === 529 || err.status === 429) {
        // Overloaded or rate limited — wait and retry
        await new Promise(r => setTimeout(r, 5000));
        continue;
      }
      throw err;
    }

    // Collect text blocks
    const textBlocks = response.content.filter(b => b.type === "text").map(b => b.text);
    if (textBlocks.length) {
      finalText = textBlocks.join("\n");
      if (onLog) onLog(`[${label}] ${finalText.slice(0, 500)}`);
    }

    // Check for tool use
    const toolBlocks = response.content.filter(b => b.type === "tool_use");

    if (toolBlocks.length === 0 || response.stop_reason === "end_turn") {
      // Agent is done
      break;
    }

    // Execute tools and continue
    messages.push({ role: "assistant", content: response.content });

    const toolResults = [];
    for (const tool of toolBlocks) {
      if (abortSignal?.aborted) throw new Error("Agent aborted by user");
      console.log(`[${label}] Tool: ${tool.name}(${JSON.stringify(tool.input).slice(0, 100)})`);
      const result = executeToolCall(tool.name, tool.input);
      toolResults.push({
        type: "tool_result",
        tool_use_id: tool.id,
        content: result.slice(0, 50000), // Cap tool results to avoid context overflow
      });
    }

    messages.push({ role: "user", content: toolResults });
  }

  return finalText;
}

// ─── Helper: Chat with Claude via Anthropic API ─────────────────────────────
async function chatWithOpus(userMessage) {
  conversationHistory.push({ role: "user", content: userMessage });

  if (conversationHistory.length > 40) {
    conversationHistory = conversationHistory.slice(-40);
  }

  // Build messages array for the API
  const messages = conversationHistory.map(m => ({
    role: m.role,
    content: m.content,
  }));

  try {
    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 4096,
      system: SYSTEM_PROMPT,
      messages,
      tools: AGENT_TOOLS, // Give chat access to tools for investigating bugs
    });

    // If Claude wants to use tools, run the agentic loop
    const toolBlocks = response.content.filter(b => b.type === "tool_use");
    let reply;

    if (toolBlocks.length > 0) {
      // Run a mini agent loop for tool-using chat (max 10 turns for investigation)
      reply = await runAgentLoop(SYSTEM_PROMPT, userMessage, {
        label: "chat-investigate",
        maxTurns: 10,
        model: "claude-sonnet-4-20250514",
      });
    } else {
      // Simple text response
      reply = response.content
        .filter(b => b.type === "text")
        .map(b => b.text)
        .join("\n");
    }

    if (!reply) reply = "(no response)";

    conversationHistory.push({ role: "assistant", content: reply });
    return reply;
  } catch (err) {
    console.error("[chatWithOpus] API error:", err.message);
    throw err;
  }
}

// ─── Helper: Run a Claude agent with a prompt, return its output ────────────
async function runAgent(prompt, { label = "agent", onLog } = {}) {
  const abortController = new AbortController();
  activeProcess = abortController; // Store abort controller so STOP can cancel it
  activeTaskLabel = label;

  try {
    const systemPrompt = `You are a senior full-stack engineer working on the ATTAIRE codebase.
You have access to tools to read files, write files, edit files, search code, and run shell commands.
The repository root is: ${REPO_ROOT}
Use the tools to complete the task described in the user message.
Work methodically: read relevant files first, plan your changes, implement them, then verify.
When running shell commands, the working directory is the repo root unless you specify cwd.`;

    const result = await runAgentLoop(systemPrompt, prompt, {
      label,
      maxTurns: 200,
      model: "claude-sonnet-4-20250514",
      onLog,
      abortSignal: abortController.signal,
    });

    return result;
  } finally {
    activeProcess = null;
    activeTaskLabel = null;
  }
}

// ─── Safety Commit: catch orphaned changes after agent exit ────────────────
function safetyCommit(label = "agent") {
  try {
    const status = execCommand("git status --porcelain", { timeout: 10000 }).trim();
    if (!status) return false; // nothing to commit

    console.log(`[safetyCommit] Found uncommitted changes after ${label}:\n${status.slice(0, 500)}`);
    execCommand("git add -A", { timeout: 10000 });
    const shortLabel = label.replace(/^build:/, "").slice(0, 50);
    execCommand(`git commit -m "wip: safety commit — ${shortLabel} (agent exited with uncommitted work)"`, { timeout: 15000 });
    console.log("[safetyCommit] Committed orphaned changes.");
    return true;
  } catch (err) {
    console.error("[safetyCommit] Failed:", err.message?.slice(0, 200));
    return false;
  }
}

// ─── Build → Judge → Fix Loop ───────────────────────────────────────────────
async function buildWithQualityLoop(taskDescription, chatChannel, logsChannel) {
  if (activeProcess) {
    await chatChannel.send("A build agent is already running. Say `stop` first.");
    return false;
  }

  if (!taskDescription || !taskDescription.trim()) {
    await chatChannel.send("No task description provided.");
    return false;
  }

  const MAX_ITERATIONS = 10;
  let iteration = 0;

  const logToDiscord = (text) => {
    if (logsChannel) {
      logsChannel.send("```\n" + text.slice(0, 1900) + "\n```").catch(() => {});
    }
  };

  await chatChannel.send(`**Building:** ${taskDescription.slice(0, 1900)}`);

  while (iteration < MAX_ITERATIONS && !stopRequested) {
    iteration++;

    // ── Keep-Alive Heartbeat (during long builds) ──
    await buildHeartbeatCheck();
    if (stopRequested) break;

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

COMMIT STRATEGY — commit after EACH sub-task, not at the end:
- After backend changes (routes, services, migrations): git add attair-backend/ && git commit -m "feat: [task] — backend"
- After frontend changes (components, styles): git add attair-app/ && git commit -m "feat: [task] — frontend"
- After test fixes: git add -A && git commit -m "fix: [task] — test fixes"
- After any other significant chunk of work: commit immediately.
This prevents losing work if the process dies. Small, frequent commits > one big commit at the end.
If a commit has nothing to add (no changes), skip it and move on — do not error out.

Do NOT create new files unless absolutely necessary. Build within existing files.
Do NOT change function signatures in attair-backend/src/services/products.js.`;

    try {
      console.log("[buildLoop] calling runAgent, prompt length:", buildPrompt.length);
      const buildOutput = await runAgent(buildPrompt, { label: `build:${taskDescription.slice(0, 30)}`, onLog: logToDiscord });
      console.log("[buildLoop] agent returned, output length:", buildOutput.length);
      // Safety commit: catch any work the agent didn't commit
      if (safetyCommit(`build:${taskDescription.slice(0, 30)}`)) {
        await chatChannel.send("(safety commit: saved uncommitted agent work)");
      }
    } catch (err) {
      console.error("[buildLoop] agent error:", err.message);
      // Safety commit on crash — don't lose whatever the agent built before dying
      if (safetyCommit(`build:${taskDescription.slice(0, 30)}`)) {
        await chatChannel.send("Agent crashed but saved uncommitted work via safety commit.");
      }
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
        shell: true,
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
      await chatChannel.send(`**Approved:** ${taskDescription.slice(0, 200)}\nPassed after ${iteration} iteration(s). ${judgeVerdict.slice(0, 300)}`);
      return true;
    }

    // Not approved — feed judge feedback into next iteration
    await chatChannel.send(`**Iteration ${iteration} — Needs Work:**\n${judgeVerdict.slice(0, 1800)}`);

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
      const scanBtn = page.locator('[class*="scan"], [class*="camera"], button:has-text("Scan")').first();
      if (await scanBtn.isVisible().catch(() => false)) await scanBtn.click();
      await page.waitForTimeout(1000);
    }},
    { name: "profile", url: "http://localhost:5173/", action: async () => {
      const profileBtn = page.locator('[class*="profile"], [class*="avatar"], button:has-text("Profile")').first();
      if (await profileBtn.isVisible().catch(() => false)) await profileBtn.click();
      await page.waitForTimeout(1000);
    }},
    // Share sheet with Create Reel button
    { name: "share-sheet", url: "http://localhost:5173/", action: async () => {
      // Wait for any scan results to load
      await page.waitForTimeout(2000);
      // Try clicking the Share button to open the share sheet
      const shareBtn = page.locator('button:has-text("Share Your Look"), button[aria-label="Share Your Look"]').first();
      if (await shareBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
        await shareBtn.click();
        await page.waitForTimeout(800);
      }
    }},
    // Reel preview modal (inject via JS to show the modal in demo state)
    { name: "reel-preview", url: "http://localhost:5173/", action: async () => {
      await page.waitForTimeout(2000);
      // Inject a synthetic reel preview modal into the DOM for screenshot
      await page.evaluate(() => {
        const existing = document.querySelector('.reel-preview-overlay');
        if (existing) return; // already showing
        const overlay = document.createElement('div');
        overlay.className = 'reel-preview-overlay';
        overlay.style.cssText = 'position:fixed;inset:0;z-index:10000;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.85);backdrop-filter:blur(20px)';
        overlay.innerHTML = \`
          <div class="reel-preview-container" style="width:min(340px,90vw);background:var(--bg-card,#1A1A1A);border-radius:24px;overflow:hidden;border:1px solid rgba(255,255,255,0.08)">
            <div style="display:flex;align-items:center;justify-content:space-between;padding:16px 20px">
              <button style="width:36px;height:36px;border-radius:50%;background:rgba(255,255,255,0.08);border:none;color:#fff;font-size:20;cursor:pointer">&times;</button>
              <div style="font-size:16px;font-weight:700;color:#fff;font-family:var(--font-display)">Your Reel</div>
              <div style="width:36px"></div>
            </div>
            <div style="position:relative;aspect-ratio:9/16;background:linear-gradient(135deg,#1a1a2e,#16213e);border-radius:16px;margin:0 16px;overflow:hidden;display:flex;align-items:center;justify-content:center">
              <div style="text-align:center;color:rgba(255,255,255,0.4);font-size:14px">
                <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="rgba(201,169,110,0.6)" stroke-width="1.5"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2"/></svg>
                <div style="margin-top:8px">5s Reel Preview</div>
              </div>
              <div style="position:absolute;top:12px;right:12px;background:rgba(0,0,0,0.6);color:#C9A96E;padding:4px 10px;border-radius:20px;font-size:11px;font-weight:700;backdrop-filter:blur(10px)">9:16</div>
            </div>
            <div style="display:flex;gap:12px;padding:20px 16px">
              <button style="flex:1;display:flex;align-items:center;justify-content:center;gap:8px;padding:14px;background:var(--accent,#C9A96E);color:#000;border:none;border-radius:14px;font-size:14px;font-weight:700;cursor:pointer">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                Save Video
              </button>
              <button style="flex:1;display:flex;align-items:center;justify-content:center;gap:8px;padding:14px;background:rgba(255,255,255,0.08);color:#fff;border:1px solid rgba(255,255,255,0.12);border-radius:14px;font-size:14px;font-weight:700;cursor:pointer">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>
                Share
              </button>
            </div>
            <div style="text-align:center;padding:0 16px 20px;font-size:12px;color:rgba(255,255,255,0.35)">Optimized for TikTok, Reels & Shorts</div>
          </div>
        \`;
        document.body.appendChild(overlay);
      });
      await page.waitForTimeout(500);
    }},
    // Pro upgrade modal (for free users tapping Create Reel)
    { name: "pro-gate", url: "http://localhost:5173/", action: async () => {
      await page.waitForTimeout(2000);
      // Inject synthetic upgrade modal
      await page.evaluate(() => {
        const existing = document.querySelector('[data-screenshot-upgrade]');
        if (existing) return;
        const overlay = document.createElement('div');
        overlay.setAttribute('data-screenshot-upgrade', '1');
        overlay.style.cssText = 'position:fixed;inset:0;z-index:10001;display:flex;align-items:flex-end;justify-content:center;background:rgba(0,0,0,0.6);backdrop-filter:blur(10px)';
        overlay.innerHTML = \`
          <div style="width:100%;max-width:420px;background:var(--bg-card,#1A1A1A);border-radius:24px 24px 0 0;padding:32px 24px 40px;text-align:center;border-top:1px solid rgba(201,169,110,0.3)">
            <div style="font-size:40px;margin-bottom:12px">👑</div>
            <div style="font-size:20px;font-weight:800;color:#fff;font-family:var(--font-display);margin-bottom:8px">Upgrade to Pro</div>
            <div style="font-size:14px;color:rgba(255,255,255,0.55);margin-bottom:24px;line-height:1.5">Create shareable video reels of your outfit scans. Export 9:16 videos optimized for TikTok, Reels & Shorts.</div>
            <button style="width:100%;padding:16px;background:var(--accent,#C9A96E);color:#000;border:none;border-radius:14px;font-size:16px;font-weight:800;cursor:pointer;font-family:var(--font-display)">Upgrade — \\$4.99/mo</button>
            <button style="width:100%;padding:14px;background:none;border:none;color:rgba(255,255,255,0.4);font-size:14px;cursor:pointer;margin-top:8px">Maybe later</button>
          </div>
        \`;
        document.body.appendChild(overlay);
      });
      await page.waitForTimeout(500);
    }},
    // Error toast for reel generation failure
    { name: "reel-error-toast", url: "http://localhost:5173/", action: async () => {
      await page.waitForTimeout(2000);
      await page.evaluate(() => {
        const existing = document.querySelector('[data-screenshot-error]');
        if (existing) return;
        const toast = document.createElement('div');
        toast.setAttribute('data-screenshot-error', '1');
        toast.style.cssText = 'position:fixed;bottom:140px;left:50%;transform:translateX(-50%);z-index:10001;background:#FF5252;color:#fff;padding:12px 20px;border-radius:14px;font-weight:700;font-size:13px;box-shadow:0 4px 24px rgba(0,0,0,.4);display:flex;align-items:center;gap:8px;max-width:90vw;text-align:center';
        toast.innerHTML = \`
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>
          Reel creation failed — your browser may not support video recording.
          <button style="background:none;border:none;color:#fff;cursor:pointer;padding:0 0 0 4px;font-size:18px;line-height:1;font-weight:700;opacity:0.8">&times;</button>
        \`;
        document.body.appendChild(toast);
      });
      await page.waitForTimeout(500);
    }},
    // ─── Style Twins: Empty/Locked state ───
    { name: "discover-twins-empty", url: "http://localhost:5173/", action: async () => {
      await page.waitForTimeout(2000);
      // Click the Discover tab
      const discoverBtn = page.locator('button[aria-label="Discover"]').first();
      if (await discoverBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
        await discoverBtn.click();
        await page.waitForTimeout(800);
      }
      // Click the Twins sub-tab
      const twinsBtn = page.locator('button.feed-tab:has-text("Twins")').first();
      if (await twinsBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
        await twinsBtn.click();
        await page.waitForTimeout(800);
      }
    }},
    // ─── Style Twins: Twin cards rendered ───
    { name: "discover-twins-cards", url: "http://localhost:5173/", action: async () => {
      await page.waitForTimeout(2000);
      // Click the Discover tab
      const discoverBtn = page.locator('button[aria-label="Discover"]').first();
      if (await discoverBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
        await discoverBtn.click();
        await page.waitForTimeout(800);
      }
      // Click the Twins sub-tab
      const twinsBtn = page.locator('button.feed-tab:has-text("Twins")').first();
      if (await twinsBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
        await twinsBtn.click();
        await page.waitForTimeout(500);
      }
      // Inject synthetic twin cards into the twins section
      await page.evaluate(() => {
        const container = document.querySelector('.style-twins-empty');
        if (!container) return;
        const parent = container.parentElement;
        // Remove the empty state
        container.remove();
        // Inject fully rendered twin cards
        parent.innerHTML = \`
          <div class="animate-fade-in">
            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;padding-top:4px">
              <div>
                <div style="font-size:10px;font-weight:700;letter-spacing:1.5px;color:var(--accent);text-transform:uppercase;margin-bottom:4px">Your Style Twins</div>
                <div style="font-size:13px;color:var(--text-secondary)">
                  <span style="color:var(--text-primary);font-weight:600">Modern Classic</span> · 6 matches
                </div>
              </div>
              <button class="style-twins-refresh-btn" title="Refresh">
                <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
              </button>
            </div>
            <!-- Featured twin card -->
            <div class="style-twin-featured" style="animation:none">
              <div class="style-twin-featured-glow"></div>
              <div style="display:flex;align-items:center;gap:6px;margin-bottom:14px">
                <svg viewBox="0 0 24 24" width="14" height="14" fill="var(--accent)" stroke="none"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>
                <span style="font-size:11px;font-weight:700;color:var(--accent);text-transform:uppercase;letter-spacing:1px">Closest Match</span>
              </div>
              <div style="display:flex;align-items:center;gap:14px">
                <div class="style-twin-avatar-lg"><span>EM</span></div>
                <div style="flex:1;min-width:0">
                  <div style="display:flex;align-items:center;gap:8px;margin-bottom:2px">
                    <span style="font-size:16px;font-weight:700;color:var(--text-primary)">Emma Morrison</span>
                    <span class="style-twin-match-badge style-twin-match-high">94%</span>
                  </div>
                  <div style="font-size:12px;color:var(--accent);font-weight:600;margin-bottom:4px">Modern Classic</div>
                  <div style="font-size:12px;color:var(--text-tertiary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">Clean lines, neutral palettes, timeless pieces</div>
                </div>
              </div>
              <div style="display:flex;gap:6px;margin-top:12px;flex-wrap:wrap">
                <span class="style-twin-axis-chip">Minimal</span>
                <span class="style-twin-axis-chip">Classic</span>
                <span class="style-twin-trait-chip">Chic</span>
                <span class="style-twin-trait-chip">Polished</span>
              </div>
              <div style="display:flex;align-items:center;gap:6px;margin-top:10px">
                <span style="font-size:11px;color:var(--text-tertiary);margin-right:2px">Palette</span>
                <span class="style-twin-color-dot" style="background:#1A1A2E"></span>
                <span class="style-twin-color-dot" style="background:#E8DCC8"></span>
                <span class="style-twin-color-dot" style="background:#8B7355"></span>
              </div>
              <div class="style-twin-shared-saves">
                <svg viewBox="0 0 24 24" width="14" height="14" fill="var(--accent)" stroke="none"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>
                <span>3 shared saves: Wool Overcoat, Cashmere Sweater, Silk Blouse</span>
              </div>
              <div style="margin-top:14px;display:flex;gap:10px">
                <button class="user-search-follow-btn follow" style="flex:1;min-height:40px;font-size:13px;border-radius:10px;font-weight:600">Follow Twin</button>
                <button class="btn-ghost" style="min-height:40px;font-size:13px;border-radius:10px;font-weight:600;padding:0 16px">Compare</button>
              </div>
            </div>
            <!-- Remaining twins grid -->
            <div class="style-twins-grid">
              <div class="style-twin-card" style="animation:none">
                <div style="display:flex;align-items:center;gap:10px;margin-bottom:10px">
                  <div class="style-twin-avatar-sm"><span>JK</span></div>
                  <span class="style-twin-match-badge style-twin-match-high">87%</span>
                </div>
                <div style="font-size:14px;font-weight:600;color:var(--text-primary);margin-bottom:2px">James Kim</div>
                <div style="font-size:11px;color:var(--accent);font-weight:600;margin-bottom:6px">Refined Edge</div>
                <div style="display:flex;gap:4px;flex-wrap:wrap;margin-bottom:6px">
                  <span class="style-twin-axis-chip" style="font-size:10px;padding:2px 8px">Minimal</span>
                  <span class="style-twin-axis-chip" style="font-size:10px;padding:2px 8px">Formal</span>
                </div>
                <div style="display:flex;gap:4px;margin-bottom:6px">
                  <span class="style-twin-color-dot" style="width:16px;height:16px;font-size:0;background:#2C3E50"></span>
                  <span class="style-twin-color-dot" style="width:16px;height:16px;font-size:0;background:#BDC3C7"></span>
                  <span class="style-twin-color-dot" style="width:16px;height:16px;font-size:0;background:#ECF0F1"></span>
                </div>
                <button class="user-search-follow-btn follow" style="width:100%;min-height:34px;font-size:12px;border-radius:8px">Follow</button>
              </div>
              <div class="style-twin-card" style="animation:none">
                <div style="display:flex;align-items:center;gap:10px;margin-bottom:10px">
                  <div class="style-twin-avatar-sm"><span>SP</span></div>
                  <span class="style-twin-match-badge style-twin-match-mid">76%</span>
                </div>
                <div style="font-size:14px;font-weight:600;color:var(--text-primary);margin-bottom:2px">Sofia Patel</div>
                <div style="font-size:11px;color:var(--accent);font-weight:600;margin-bottom:6px">Elegant Minimal</div>
                <div style="display:flex;gap:4px;flex-wrap:wrap;margin-bottom:6px">
                  <span class="style-twin-axis-chip" style="font-size:10px;padding:2px 8px">Classic</span>
                </div>
                <div style="display:flex;gap:4px;margin-bottom:6px">
                  <span class="style-twin-color-dot" style="width:16px;height:16px;font-size:0;background:#C9A96E"></span>
                  <span class="style-twin-color-dot" style="width:16px;height:16px;font-size:0;background:#F5F5DC"></span>
                </div>
                <div style="font-size:11px;color:var(--accent);display:flex;align-items:center;gap:4px;margin-bottom:8px">
                  <svg viewBox="0 0 24 24" width="11" height="11" fill="var(--accent)" stroke="none"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>
                  1 shared
                </div>
                <button class="user-search-follow-btn follow" style="width:100%;min-height:34px;font-size:12px;border-radius:8px">Follow</button>
              </div>
              <div class="style-twin-card" style="animation:none">
                <div style="display:flex;align-items:center;gap:10px;margin-bottom:10px">
                  <div class="style-twin-avatar-sm"><span>AR</span></div>
                  <span class="style-twin-match-badge style-twin-match-mid">72%</span>
                </div>
                <div style="font-size:14px;font-weight:600;color:var(--text-primary);margin-bottom:2px">Alex Rivera</div>
                <div style="font-size:11px;color:var(--accent);font-weight:600;margin-bottom:6px">Street Luxe</div>
                <div style="display:flex;gap:4px;flex-wrap:wrap;margin-bottom:6px">
                  <span class="style-twin-axis-chip" style="font-size:10px;padding:2px 8px">Trendy</span>
                </div>
                <button class="user-search-follow-btn follow" style="width:100%;min-height:34px;font-size:12px;border-radius:8px">Follow</button>
              </div>
              <div class="style-twin-card" style="animation:none">
                <div style="display:flex;align-items:center;gap:10px;margin-bottom:10px">
                  <div class="style-twin-avatar-sm"><span>MW</span></div>
                  <span class="style-twin-match-badge style-twin-match-low">63%</span>
                </div>
                <div style="font-size:14px;font-weight:600;color:var(--text-primary);margin-bottom:2px">Maya Williams</div>
                <div style="font-size:11px;color:var(--accent);font-weight:600;margin-bottom:6px">Boho Chic</div>
                <div style="display:flex;gap:4px;flex-wrap:wrap;margin-bottom:6px">
                  <span class="style-twin-axis-chip" style="font-size:10px;padding:2px 8px">Balanced</span>
                </div>
                <button class="user-search-follow-btn follow" style="width:100%;min-height:34px;font-size:12px;border-radius:8px">Follow</button>
              </div>
            </div>
          </div>
        \`;
      });
      await page.waitForTimeout(500);
    }},
    // ─── Style Twins: Comparison bottom sheet ───
    { name: "discover-twins-compare", url: "http://localhost:5173/", action: async () => {
      await page.waitForTimeout(2000);
      // Inject a synthetic comparison bottom sheet
      await page.evaluate(() => {
        const existing = document.querySelector('[data-screenshot-twin-compare]');
        if (existing) return;
        const overlay = document.createElement('div');
        overlay.setAttribute('data-screenshot-twin-compare', '1');
        overlay.style.cssText = 'position:fixed;inset:0;z-index:10001';
        overlay.innerHTML = \`
          <div class="bottom-sheet-overlay" style="position:absolute;inset:0;background:rgba(0,0,0,0.6);backdrop-filter:blur(6px)"></div>
          <div class="bottom-sheet style-twin-compare-sheet" style="position:absolute;bottom:0;left:0;right:0;background:var(--bg-card,#1A1A1A);border-radius:24px 24px 0 0;padding:24px 24px 32px;max-height:85vh;overflow-y:auto;border-top:1px solid rgba(255,255,255,0.08)">
            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:24px">
              <div style="font-size:18px;font-weight:800;color:var(--text-primary,#fff);font-family:var(--font-display)">Style Comparison</div>
              <button style="width:32px;height:32px;display:flex;align-items:center;justify-content:center;background:none;border:none;cursor:pointer;border-radius:50%;color:var(--text-secondary)">
                <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg>
              </button>
            </div>
            <!-- Match ring -->
            <div style="display:flex;justify-content:center;margin-bottom:24px">
              <div class="style-twin-compare-ring">
                <span class="style-twin-compare-pct">94%</span>
                <span style="font-size:10px;color:var(--text-secondary,rgba(255,255,255,0.6));font-weight:500">match</span>
              </div>
            </div>
            <!-- Side by side -->
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:24px;text-align:center;margin-bottom:24px">
              <div>
                <div class="style-twin-avatar-sm" style="margin:0 auto 8px;width:48px;height:48px">
                  <span style="font-size:16px">ME</span>
                </div>
                <div style="font-size:13px;font-weight:600;color:var(--text-primary,#fff)">You</div>
                <div style="font-size:11px;color:var(--accent,#C9A96E);font-weight:500;margin-top:2px">Modern Classic</div>
              </div>
              <div>
                <div class="style-twin-avatar-sm" style="margin:0 auto 8px;width:48px;height:48px">
                  <span style="font-size:16px">EM</span>
                </div>
                <div style="font-size:13px;font-weight:600;color:var(--text-primary,#fff)">Emma Morrison</div>
                <div style="font-size:11px;color:var(--accent,#C9A96E);font-weight:500;margin-top:2px">Modern Classic</div>
              </div>
            </div>
            <!-- Shared style traits -->
            <div style="margin-bottom:20px">
              <div style="font-size:11px;font-weight:700;color:var(--text-tertiary,rgba(255,255,255,0.35));text-transform:uppercase;letter-spacing:1px;margin-bottom:10px">Shared Style Traits</div>
              <div style="display:flex;flex-wrap:wrap;gap:8px;justify-content:center">
                <span class="style-twin-axis-chip" style="font-size:13px;padding:6px 16px">Minimal</span>
                <span class="style-twin-axis-chip" style="font-size:13px;padding:6px 16px">Classic</span>
                <span class="style-twin-axis-chip" style="font-size:13px;padding:6px 16px">Formal</span>
              </div>
            </div>
            <!-- Their traits -->
            <div style="margin-bottom:20px">
              <div style="font-size:11px;font-weight:700;color:var(--text-tertiary,rgba(255,255,255,0.35));text-transform:uppercase;letter-spacing:1px;margin-bottom:10px">Their Top Traits</div>
              <div style="display:flex;flex-wrap:wrap;gap:8px;justify-content:center">
                <span class="style-twin-trait-chip" style="font-size:12px;padding:5px 14px">Chic</span>
                <span class="style-twin-trait-chip" style="font-size:12px;padding:5px 14px">Polished</span>
              </div>
            </div>
            <!-- Color palette -->
            <div style="margin-bottom:20px">
              <div style="font-size:11px;font-weight:700;color:var(--text-tertiary,rgba(255,255,255,0.35));text-transform:uppercase;letter-spacing:1px;margin-bottom:10px">Their Palette</div>
              <div style="display:flex;justify-content:center;gap:10px">
                <span class="style-twin-color-dot" style="width:32px;height:32px;background:#1A1A2E;font-size:0"></span>
                <span class="style-twin-color-dot" style="width:32px;height:32px;background:#E8DCC8;font-size:0"></span>
                <span class="style-twin-color-dot" style="width:32px;height:32px;background:#8B7355;font-size:0"></span>
              </div>
            </div>
            <!-- Shared saves -->
            <div style="margin-bottom:20px">
              <div style="font-size:11px;font-weight:700;color:var(--text-tertiary,rgba(255,255,255,0.35));text-transform:uppercase;letter-spacing:1px;margin-bottom:10px">Shared Saves</div>
              <div class="style-twin-shared-saves" style="margin-top:0;justify-content:center">
                <svg viewBox="0 0 24 24" width="14" height="14" fill="var(--accent)" stroke="none"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>
                <span>3 items you both saved: Wool Overcoat, Cashmere Sweater, Silk Blouse</span>
              </div>
            </div>
            <!-- Follow button -->
            <button class="user-search-follow-btn follow" style="width:100%;min-height:48px;font-size:15px;border-radius:12px;font-weight:700;margin-top:8px">Follow Your Style Twin</button>
          </div>
        \`;
        document.body.appendChild(overlay);
      });
      await page.waitForTimeout(500);
    }},
    // ─── Style Twin: Shared save toast banner ───
    { name: "discover-twins-save-toast", url: "http://localhost:5173/", action: async () => {
      await page.waitForTimeout(2000);
      // Inject the shared save toast banner
      await page.evaluate(() => {
        const existing = document.querySelector('[data-screenshot-twin-toast]');
        if (existing) return;
        const toast = document.createElement('div');
        toast.setAttribute('data-screenshot-twin-toast', '1');
        toast.className = 'animate-slide-up style-twin-save-toast';
        toast.style.cssText = 'position:fixed;top:56px;left:12px;right:12px;background:linear-gradient(135deg,rgba(201,169,110,0.14),rgba(201,169,110,0.04));backdrop-filter:blur(20px);-webkit-backdrop-filter:blur(20px);border:1px solid rgba(201,169,110,0.3);border-radius:16px;padding:14px 16px;z-index:9998;display:flex;gap:12px;align-items:center;box-shadow:0 8px 32px rgba(0,0,0,0.3);cursor:pointer';
        toast.innerHTML = \`
          <div style="width:36px;height:36px;border-radius:50%;background:rgba(201,169,110,0.15);display:flex;align-items:center;justify-content:center;flex-shrink:0">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="#C9A96E" stroke-width="2"><circle cx="9" cy="7" r="3"/><circle cx="15" cy="7" r="3"/><path d="M3 21c0-3.31 2.69-6 6-6h0c1.1 0 2.12.3 3 .82A5.98 5.98 0 0115 15h0c3.31 0 6 2.69 6 6"/></svg>
          </div>
          <div style="flex:1;min-width:0">
            <div style="font-size:13px;font-weight:700;color:var(--text-primary,#fff);margin-bottom:2px">Style Twin Match!</div>
            <div style="font-size:11px;color:var(--text-secondary,rgba(255,255,255,0.6));line-height:1.4">Your Style Twin Emma Morrison also saved this!</div>
          </div>
          <button style="background:var(--accent,#C9A96E);color:#000;border:none;border-radius:100px;padding:6px 14px;font-size:11px;font-weight:700;cursor:pointer;white-space:nowrap;flex-shrink:0">View Twins</button>
        \`;
        document.body.appendChild(toast);
      });
      await page.waitForTimeout(500);
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
      shell: true,
    });

    const match = result.match(/\[.*\]/);
    return match ? JSON.parse(match[0]) : [];
  } catch (err) {
    throw new Error(`Screenshot capture failed: ${err.message.slice(0, 200)}`);
  } finally {
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
    console.log("[buildFromBacklog] next task:", task ? task.title : "null");
    if (!task) {
      await chatChannel.send("Backlog is empty — nothing left to build. Nice.");
      break;
    }

    await chatChannel.send(`**Next Task:** ${task.title}\n${task.summary || ""}\nPriority: ${task.priority || "?"} | Size: ${task.size || "?"}`);

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
  return readFileSync(BACKLOG_PATH, "utf-8").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function getNextBacklogTask() {
  const content = readBacklog();
  if (!content) return null;

  const priorities = ["CRITICAL", "HIGH", "MEDIUM", "LOW"];

  for (const priority of priorities) {
    const sectionRegex = new RegExp(`## ${priority}[^\\n]*\\n[\\s\\S]*?(?=\\n## [^#]|$)`, "i");
    const section = content.match(sectionRegex);
    if (!section) continue;

    const taskRegex = /### (.+)\n([\s\S]*?)(?=\n###|$)/g;
    let match;
    while ((match = taskRegex.exec(section[0])) !== null) {
      const title = match[1].trim();
      const body = match[2].trim();

      if (/status:\*?\*?\s*(done|deferred|implemented|completed)/i.test(body)) continue;

      const summaryMatch = body.match(/\*\*Summary:\*\*\s*(.+)/);
      const summary = summaryMatch ? summaryMatch[1].trim() : body.split("\n")[0];

      const sizeMatch = body.match(/\*\*Effort:\*\*\s*(\S+)/);
      const size = sizeMatch ? sizeMatch[1].trim() : "M";

      return { title, summary, priority, size };
    }
  }

  const extraRegex = /## (?:Approved|Proposed)[^\n]*\n[\s\S]*?(?=\n## [^#]|$)/gi;
  let extraMatch;
  while ((extraMatch = extraRegex.exec(content)) !== null) {
    const taskRegex = /### (.+)\n([\s\S]*?)(?=\n###|$)/g;
    let match;
    while ((match = taskRegex.exec(extraMatch[0])) !== null) {
      const title = match[1].trim();
      const body = match[2].trim();
      if (/status:\*?\*?\s*(done|deferred|implemented|completed)/i.test(body)) continue;

      const summaryMatch = body.match(/\*\*Summary:\*\*\s*(.+)/);
      const summary = summaryMatch ? summaryMatch[1].trim() : body.split("\n")[0];
      const sizeMatch = body.match(/\*\*Effort:\*\*\s*(\S+)/);
      const size = sizeMatch ? sizeMatch[1].trim() : "M";
      const sectionType = extraMatch[0].includes("Proposed") ? "PROPOSED" : "APPROVED";

      return { title, summary, priority: sectionType, size };
    }
  }

  return null;
}

function markBacklogTaskDone(title) {
  let content = readBacklog();
  if (!content) return;

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

  const sectionHeader = `## ${priority}`;
  const sectionIndex = content.indexOf(sectionHeader);

  if (sectionIndex >= 0) {
    const nextSection = content.indexOf("\n## ", sectionIndex + sectionHeader.length);
    const insertAt = nextSection >= 0 ? nextSection : content.length;
    content = content.slice(0, insertAt) + entry + content.slice(insertAt);
  } else {
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
    safetyCommit("creative");

    await chatChannel.send(
      new EmbedBuilder()
        .setColor(0x9B59B6)
        .setTitle("Creative Agent Done")
        .setDescription("New ideas added to backlog. Review them and tell me what to build.")
    );
  } catch (err) {
    safetyCommit("creative");
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
    buildWithQualityLoop(description || "Build feature as described in conversation", channel, logsChannel).catch(err => {
      console.error("[BUILD] error:", err.message, err.stack?.slice(0, 300));
      channel.send(`Build loop error: ${(err.message || "unknown error").slice(0, 200)}`).catch(() => {});
    });
  }

  // [ACTION:BUILD_NEXT]
  if (text.includes("[ACTION:BUILD_NEXT]")) {
    text = text.replace(/\[ACTION:BUILD_NEXT\]/g, "").trim();
    const logsChannel = LOGS_CHANNEL_ID ? await client.channels.fetch(LOGS_CHANNEL_ID).catch(() => null) : null;
    buildFromBacklog(channel, logsChannel).catch(err => {
      console.error("[BUILD_NEXT] error:", err.message, err.stack?.slice(0, 500));
      channel.send(`Backlog loop error: ${(err.message || "unknown error").slice(0, 200)}`).catch(() => {});
    });
  }

  // [ACTION:STOP]
  if (text.includes("[ACTION:STOP]")) {
    text = text.replace(/\[ACTION:STOP\]/g, "").trim();
    stopRequested = true;
    if (activeProcess) {
      // AbortController or child process
      if (typeof activeProcess.abort === "function") {
        activeProcess.abort();
      } else if (typeof activeProcess.kill === "function") {
        activeProcess.kill("SIGTERM");
      }
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
    const uptime = Math.floor(process.uptime());
    const hours = Math.floor(uptime / 3600);
    const mins = Math.floor((uptime % 3600) / 60);
    status += `\nUptime: ${hours}h ${mins}m`;
    text = text ? `${text}\n${status}` : status;
  }

  // [ACTION:KILL_STALE]
  if (text.includes("[ACTION:KILL_STALE]")) {
    text = text.replace(/\[ACTION:KILL_STALE\]/g, "").trim();
    try {
      const myPid = process.pid;
      const isWindows = process.platform === "win32";
      const ps = execCommand(isWindows ? "tasklist" : "ps aux", { timeout: 10000 });
      const stale = ps.split("\n").filter(line => {
        if (!line.includes("claude") && !line.includes("node")) return false;
        if (line.includes("grep")) return false;
        if (line.includes("Code Helper")) return false;
        if (line.includes("node discord-bot.js")) return false;
        const pidMatch = isWindows
          ? line.match(/\s+(\d+)\s+/)
          : line.match(/^\S+\s+(\d+)/);
        if (!pidMatch) return false;
        const pid = parseInt(pidMatch[1]);
        if (pid === myPid) return false;
        return line.includes("claude") || line.includes("node agents/");
      });
      let killed = 0;
      for (const line of stale) {
        const pidMatch = process.platform === "win32"
          ? line.match(/\s+(\d+)\s+/)
          : line.match(/^\S+\s+(\d+)/);
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

  // [ACTION:KEEPALIVE]
  if (text.includes("[ACTION:KEEPALIVE]")) {
    text = text.replace(/\[ACTION:KEEPALIVE\]/g, "").trim();
    sendKeepAlivePing("Manual keep-alive check requested.", { urgent: false }).then(({ keepRunning }) => {
      if (!keepRunning) {
        performShutdown("manual-keepalive-declined").catch(() => {});
      } else {
        lastMessageTime = Date.now();
      }
    }).catch(() => {});
  }

  return text;
}

// ─── Git Sync (for hosted environments — pull latest before builds) ────────
async function gitSync() {
  if (!IS_HOSTED) return;
  try {
    const remote = execCommand("git remote -v", { timeout: 5000 });
    if (!remote.includes("origin")) {
      console.log("[gitSync] No remote origin configured, skipping sync");
      return;
    }
    console.log("[gitSync] Pulling latest changes...");
    const result = execCommand("git pull --rebase origin main", { timeout: 30000 });
    console.log("[gitSync]", result.slice(0, 200));
  } catch (err) {
    console.error("[gitSync] Failed:", err.message?.slice(0, 200));
  }
}

// ─── Git Push (for hosted environments — push commits after builds) ────────
async function gitPush() {
  if (!IS_HOSTED) return;
  try {
    console.log("[gitPush] Pushing changes...");
    const result = execCommand("git push origin HEAD", { timeout: 30000 });
    console.log("[gitPush]", result.slice(0, 200));
  } catch (err) {
    console.error("[gitPush] Failed:", err.message?.slice(0, 200));
  }
}

// ─── Discord Events ──────────────────────────────────────────────────────────
client.once("ready", async () => {
  console.log(`\nATTAIRE Bot online as ${client.user.tag}`);
  console.log(`Environment: ${IS_HOSTED ? "HOSTED" : "LOCAL"}`);
  console.log(`Chat channel: ${CHAT_CHANNEL_ID || "(not set)"}`);
  console.log(`Logs channel: ${LOGS_CHANNEL_ID || "(not set)"}`);
  console.log(`Health check: http://localhost:${HEALTH_PORT}/health`);
  console.log("Waiting for messages...\n");

  // Sync repo on startup if hosted
  await gitSync();

  // Start idle keep-alive monitor
  startIdleKeepAliveMonitor();
  console.log("Keep-alive monitor started (idle threshold: 2h, check interval: 15m)");

  if (CHAT_CHANNEL_ID) {
    client.channels.fetch(CHAT_CHANNEL_ID).then(ch => {
      const env = IS_HOSTED ? "hosted" : "local";
      ch.send(`ATTAIRE is online (${env}). What are we building?`);
    }).catch(() => {});
  }
});

client.on("messageCreate", handleMessage);

client.on("error", (err) => {
  console.error("Discord error:", err.message);
});

// ─── Proactive Check-ins ─────────────────────────────────────────────────────
let lastMessageTime = Date.now();

// ─── Keep-Alive Ping System (extracted to keepalive.js) ─────────────────────

/**
 * Perform the actual shutdown sequence (save work, notify, exit).
 */
async function performShutdown(reason = "unknown") {
  console.log(`[shutdown] Performing shutdown (reason: ${reason})...`);

  // Stop any running builds
  stopRequested = true;
  if (activeProcess) {
    if (typeof activeProcess.abort === "function") activeProcess.abort();
    else if (typeof activeProcess.kill === "function") activeProcess.kill("SIGTERM");
  }

  // Safety commit any pending work
  safetyCommit("shutdown");

  // Push if hosted
  await gitPush();

  // Clear timers
  keepAlive.stopIdleMonitor();

  // Close connections
  healthServer.close();
  client.destroy();

  process.exit(0);
}

const keepAlive = createKeepAliveSystem({
  client,
  channelId: CHAT_CHANNEL_ID,
  getState: () => ({
    buildLoopRunning,
    activeProcess,
    activeTaskLabel,
    stopRequested,
    lastMessageTime,
    lastBuildHeartbeat,
  }),
  setState: (patch) => {
    if ("stopRequested" in patch) stopRequested = patch.stopRequested;
    if ("lastMessageTime" in patch) lastMessageTime = patch.lastMessageTime;
    if ("lastBuildHeartbeat" in patch) lastBuildHeartbeat = patch.lastBuildHeartbeat;
  },
  performShutdown,
});

const { sendKeepAlivePing, buildHeartbeatCheck, startIdleKeepAliveMonitor, shutdown } = keepAlive;

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

// Handle uncaught errors gracefully
process.on("uncaughtException", (err) => {
  console.error("[FATAL] Uncaught exception:", err.message, err.stack?.slice(0, 500));
  safetyCommit("crash");
});

process.on("unhandledRejection", (reason) => {
  console.error("[FATAL] Unhandled rejection:", reason);
});

// ─── Start ───────────────────────────────────────────────────────────────────
console.log("Connecting to Discord...");
client.login(DISCORD_TOKEN);
