#!/usr/bin/env node
/**
 * ATTAIR Discord Bot — Mobile command center for the Agent Army
 * ─────────────────────────────────────────────────────────────
 * Run: node discord-bot.js
 *
 * Features:
 *   - Opus-powered chat: helps you write requirements, brainstorm, plan
 *   - "run" / "run the army": triggers agents/run.js
 *   - Mid-run Q&A: agent questions appear in #agent-chat, your reply pipes back
 *   - "backlog: [idea]": appends to creative-backlog.md
 *   - Agent logs stream to #agent-logs
 */

import { Client, GatewayIntentBits, Partials, EmbedBuilder } from "discord.js";
import Anthropic from "@anthropic-ai/sdk";
import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync } from "fs";
import { spawn } from "child_process";
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

// ─── Claude Client (Opus for chat) ──────────────────────────────────────────
const claude = new Anthropic();

// ─── State ───────────────────────────────────────────────────────────────────
let armyProcess = null;             // child process for run.js
let conversationHistory = [];       // Claude conversation context
let pendingQuestion = null;         // { resolve, question, issueId } — mid-run Q&A
const BRIDGE_DIR = join(__dirname, ".discord-bridge");

// Ensure bridge directory exists
if (!existsSync(BRIDGE_DIR)) mkdirSync(BRIDGE_DIR, { recursive: true });

// ─── Opus System Prompt ──────────────────────────────────────────────────────
const SYSTEM_PROMPT = `You are Jules' AI product partner for ATTAIR — an AI-powered fashion shopping app.
You're chatting via Discord on his phone while he's at work.

YOUR ROLE:
- Help Jules think through what to build today
- Turn conversations into clear, structured requirements
- Manage the creative backlog
- Answer questions about the codebase and product
- Be concise — Jules is on mobile, short messages work best

ATTAIR CONTEXT:
- React 19 + Vite frontend (App.jsx monolith)
- Node.js/Express backend on Railway
- Supabase (Postgres + Auth + Storage)
- Claude AI for clothing identification
- SerpAPI for product search (Google Lens + Shopping)
- Business model: freemium (12 scans/mo free, Pro unlimited)

SPECIAL COMMANDS (Jules types these directly):
- "run" or "run the army" → triggers the agent army
- "backlog: [idea]" → adds idea to creative-backlog.md
- "requirements" or "write requirements" → you generate today.md from the conversation
- "status" → show army run status
- "stop" → stop the current army run

WHEN WRITING REQUIREMENTS:
- Be specific and actionable
- Include screen names, file paths, behavioral specs
- Reference the existing codebase structure
- Format as markdown sections the PM agent can parse

Keep responses SHORT. 1-3 sentences unless Jules asks for detail. You're texting, not writing docs.`;

// ─── Helper: Send to channel (handles 2000 char limit) ──────────────────────
async function sendToChannel(channel, text) {
  if (!channel) return;
  // Discord has a 2000 char limit per message
  const chunks = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= 1900) {
      chunks.push(remaining);
      break;
    }
    // Find a good break point
    let breakAt = remaining.lastIndexOf("\n", 1900);
    if (breakAt < 500) breakAt = 1900;
    chunks.push(remaining.slice(0, breakAt));
    remaining = remaining.slice(breakAt);
  }
  for (const chunk of chunks) {
    await channel.send(chunk);
  }
}

// ─── Helper: Chat with Opus ──────────────────────────────────────────────────
async function chatWithOpus(userMessage) {
  conversationHistory.push({ role: "user", content: userMessage });

  // Keep conversation manageable (last 40 messages)
  if (conversationHistory.length > 40) {
    conversationHistory = conversationHistory.slice(-40);
  }

  const response = await claude.messages.create({
    model: "claude-opus-4-20250514",
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
    messages: conversationHistory,
  });

  const reply = response.content[0].text;
  conversationHistory.push({ role: "assistant", content: reply });
  return reply;
}

// ─── Army Runner ─────────────────────────────────────────────────────────────
async function startArmy(chatChannel, logsChannel) {
  if (armyProcess) {
    await chatChannel.send("The army is already running. Say `stop` to kill it first.");
    return;
  }

  await chatChannel.send("Starting the agent army... Output will stream to #agent-logs.");

  // Set DISCORD_BRIDGE env so notify.js routes through Discord
  const env = {
    ...process.env,
    DISCORD_BRIDGE: "true",
    DISCORD_BRIDGE_DIR: BRIDGE_DIR,
  };

  armyProcess = spawn("node", [join(__dirname, "run.js")], {
    cwd: REPO_ROOT,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });

  let logBuffer = "";
  const FLUSH_INTERVAL = 3000; // Batch logs every 3 seconds

  const flushLogs = async () => {
    if (logBuffer.trim() && logsChannel) {
      const toSend = logBuffer.slice(0, 1900);
      logBuffer = logBuffer.slice(1900);
      try {
        await logsChannel.send("```\n" + toSend + "\n```");
      } catch { /* channel might not exist yet */ }
    }
  };

  const logInterval = setInterval(flushLogs, FLUSH_INTERVAL);

  armyProcess.stdout.on("data", (data) => {
    const text = data.toString();
    process.stdout.write(text); // Also log locally
    logBuffer += text;
  });

  armyProcess.stderr.on("data", (data) => {
    const text = data.toString();
    process.stderr.write(text);
    logBuffer += "[stderr] " + text;
  });

  armyProcess.on("close", async (code) => {
    clearInterval(logInterval);
    await flushLogs();
    armyProcess = null;
    pendingQuestion = null;

    const status = code === 0 ? "completed successfully" : `exited with code ${code}`;
    if (chatChannel) {
      await chatChannel.send(`The agent army has ${status}.`);
    }
  });

  // Start watching for bridge questions (mid-run Q&A)
  startBridgeWatcher(chatChannel);
}

function stopArmy(chatChannel) {
  if (!armyProcess) {
    chatChannel.send("No army is currently running.");
    return;
  }
  armyProcess.kill("SIGTERM");
  chatChannel.send("Sent stop signal to the agent army.");
}

// ─── Bridge Watcher (mid-run agent questions + notifications → Discord) ──────
function startBridgeWatcher(chatChannel) {
  const questionFile = join(BRIDGE_DIR, "question.json");
  const notifyFile = join(BRIDGE_DIR, "notification.json");

  const watcher = setInterval(async () => {
    if (!armyProcess) {
      clearInterval(watcher);
      return;
    }

    // Check for agent questions
    if (existsSync(questionFile)) {
      try {
        const raw = readFileSync(questionFile, "utf-8");
        if (raw.trim()) {
          const question = JSON.parse(raw);
          writeFileSync(questionFile, "");

          if (question.text) {
            const embed = new EmbedBuilder()
              .setColor(0xD93F0B)
              .setTitle("Agent Question")
              .setDescription(question.text)
              .setFooter({ text: `Reply in this channel. The agent is waiting. | ID: ${question.id}` });

            if (question.context) {
              embed.addFields({ name: "Context", value: question.context.slice(0, 1024) });
            }

            await chatChannel.send({ embeds: [embed] });

            pendingQuestion = {
              id: question.id,
              resolve: null,
            };
          }
        }
      } catch { /* file mid-write, retry next tick */ }
    }

    // Check for notifications (status updates)
    if (existsSync(notifyFile)) {
      try {
        const raw = readFileSync(notifyFile, "utf-8");
        if (raw.trim()) {
          const notification = JSON.parse(raw);
          writeFileSync(notifyFile, "");

          if (notification.text) {
            const embed = new EmbedBuilder()
              .setColor(0x0075CA)
              .setTitle("Agent Update")
              .setDescription(notification.text.slice(0, 4000));

            await chatChannel.send({ embeds: [embed] });
          }
        }
      } catch { /* file mid-write */ }
    }
  }, 2000);
}

// ─── Handle incoming Discord messages ────────────────────────────────────────
async function handleMessage(message) {
  // Ignore bots and messages outside our channel
  if (message.author.bot) return;
  if (message.channel.id !== CHAT_CHANNEL_ID) return;

  const content = message.content.trim();
  if (!content) return;

  // Show typing indicator
  await message.channel.sendTyping();

  // ── Check if this is a reply to a pending agent question ──
  if (pendingQuestion) {
    const responseFile = join(BRIDGE_DIR, `response-${pendingQuestion.id}.json`);
    writeFileSync(responseFile, JSON.stringify({ reply: content, ts: Date.now() }));
    pendingQuestion = null;
    await message.reply("Got it, sending your reply back to the agent.");
    return;
  }

  // ── Special commands ──
  const lower = content.toLowerCase();

  // Run the army
  if (lower === "run" || lower === "run the army" || lower === "start" || lower === "go") {
    const logsChannel = LOGS_CHANNEL_ID ? await client.channels.fetch(LOGS_CHANNEL_ID).catch(() => null) : null;
    await startArmy(message.channel, logsChannel);
    return;
  }

  // Stop the army
  if (lower === "stop" || lower === "kill" || lower === "abort") {
    stopArmy(message.channel);
    return;
  }

  // Status check
  if (lower === "status") {
    if (armyProcess) {
      await message.reply("The agent army is currently running.");
    } else {
      await message.reply("No army running. Say `run` to start one.");
    }
    return;
  }

  // Backlog idea
  if (lower.startsWith("backlog:") || lower.startsWith("idea:")) {
    const idea = content.slice(content.indexOf(":") + 1).trim();
    const backlogPath = join(REPO_ROOT, "requirements", "creative-backlog.md");
    const date = new Date().toISOString().split("T")[0];
    const entry = `\n### ${date} — Jules via Discord\n${idea}\n**Status:** Pending review\n`;
    appendFileSync(backlogPath, entry);
    await message.reply(`Added to creative backlog:\n> ${idea}`);
    return;
  }

  // Write requirements
  if (lower === "requirements" || lower === "write requirements" || lower === "write reqs") {
    const reply = await chatWithOpus(
      "Based on our conversation so far, write the requirements for today. " +
      "Format it as a complete requirements/today.md file that the agent army PM can parse. " +
      "Include specific screens, features, and behavioral specs. Use the standard format with sections."
    );

    const reqPath = join(REPO_ROOT, "requirements", "today.md");
    writeFileSync(reqPath, reply);

    await sendToChannel(message.channel, `Wrote requirements to \`requirements/today.md\`:\n\n${reply}`);
    return;
  }

  // ── Default: chat with Opus ──
  try {
    const reply = await chatWithOpus(content);
    await sendToChannel(message.channel, reply);
  } catch (err) {
    console.error("Claude error:", err.message);
    await message.reply("Claude error: " + err.message.slice(0, 200));
  }
}

// ─── Discord Events ──────────────────────────────────────────────────────────
client.once("ready", () => {
  console.log(`\nATTAIR Bot online as ${client.user.tag}`);
  console.log(`Chat channel: ${CHAT_CHANNEL_ID || "(not set — add DISCORD_CHAT_CHANNEL_ID to .env)"}`);
  console.log(`Logs channel: ${LOGS_CHANNEL_ID || "(not set — add DISCORD_LOGS_CHANNEL_ID to .env)"}`);
  console.log("Waiting for messages...\n");

  // Send online message to chat channel
  if (CHAT_CHANNEL_ID) {
    client.channels.fetch(CHAT_CHANNEL_ID).then(ch => {
      ch.send("ATTAIR Agent is online. Chat with me to plan today's work, or say `run` to start the army.");
    }).catch(() => {});
  }
});

client.on("messageCreate", handleMessage);

client.on("error", (err) => {
  console.error("Discord error:", err.message);
});

// ─── Start ───────────────────────────────────────────────────────────────────
console.log("Connecting to Discord...");
client.login(DISCORD_TOKEN);
