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

// ─── State ───────────────────────────────────────────────────────────────────
let armyProcess = null;             // child process for run.js
let conversationHistory = [];       // Claude conversation context
let pendingQuestion = null;         // { resolve, question, issueId } — mid-run Q&A
const BRIDGE_DIR = join(__dirname, ".discord-bridge");

// Ensure bridge directory exists
if (!existsSync(BRIDGE_DIR)) mkdirSync(BRIDGE_DIR, { recursive: true });

// ─── Opus System Prompt ──────────────────────────────────────────────────────
const SYSTEM_PROMPT = `You're Jules' product partner for ATTAIR (AI fashion shopping app). Discord on his phone.

RULES:
- TEXT like a coworker. 1 sentence max unless he asks for more.
- No intros, no "great question", no fluff. Just answer.
- If he says something vague, ask ONE clarifying question.
- You can push back, suggest things, and start conversations.
- When writing requirements: be specific (screens, files, behavior).

CONTEXT: React 19 + Vite, Node/Express on Railway, Supabase, Claude AI vision, SerpAPI, freemium model.

COMMANDS: "run" = start army, "backlog: X" = add idea, "requirements" = write today.md, "status" / "stop".`;

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

// ─── Helper: Chat with Opus via Claude Code CLI (uses Max subscription) ──────
async function chatWithOpus(userMessage) {
  conversationHistory.push({ role: "user", content: userMessage });

  // Keep conversation manageable (last 20 exchanges)
  if (conversationHistory.length > 40) {
    conversationHistory = conversationHistory.slice(-40);
  }

  // Build context from conversation history
  const context = conversationHistory.slice(0, -1).map(m =>
    `${m.role === "user" ? "Jules" : "ATTAIR"}: ${m.content}`
  ).join("\n\n");

  const fullPrompt = [
    SYSTEM_PROMPT,
    "",
    context ? `Previous conversation:\n${context}\n` : "",
    `Jules: ${userMessage}`,
  ].filter(Boolean).join("\n");

  const reply = await new Promise((resolve, reject) => {
    const proc = spawn("claude", ["-p", "--model", "opus", "--output-format", "text", "--allowedTools", "*"], {
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

  lastMessageTime = Date.now();

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
    // React immediately so Jules knows the bot heard him
    await message.react("⏳").catch(() => {});

    const reply = await chatWithOpus(content);

    // Remove thinking reaction, add done
    await message.reactions.cache.get("⏳")?.users.remove(client.user.id).catch(() => {});

    await sendToChannel(message.channel, reply);
  } catch (err) {
    await message.reactions.cache.get("⏳")?.users.remove(client.user.id).catch(() => {});
    console.error("Claude error:", err.message);
    await message.reply("Error: " + err.message.slice(0, 200));
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

// ─── Proactive Check-ins ─────────────────────────────────────────────────────
let lastMessageTime = Date.now();
const CHECKIN_INTERVAL = 3 * 60 * 60 * 1000; // 3 hours

setInterval(async () => {
  if (!CHAT_CHANNEL_ID) return;
  if (armyProcess) return; // Don't nag during a run
  if (Date.now() - lastMessageTime < CHECKIN_INTERVAL) return;

  try {
    const channel = await client.channels.fetch(CHAT_CHANNEL_ID);
    const today = new Date().toISOString().split("T")[0];
    const reqPath = join(REPO_ROOT, "requirements", "today.md");
    const hasReqs = existsSync(reqPath);

    if (!hasReqs) {
      await channel.send("Hey — no requirements written for today yet. Want to talk through what to build?");
    } else {
      await channel.send("Requirements are set. Want me to run the army, or tweak anything first?");
    }
    lastMessageTime = Date.now();
  } catch {}
}, 30 * 60 * 1000); // Check every 30 min

// ─── Start ───────────────────────────────────────────────────────────────────
console.log("Connecting to Discord...");
client.login(DISCORD_TOKEN);
