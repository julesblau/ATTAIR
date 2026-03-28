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

ACTIONS YOU CAN TRIGGER:
You have special powers. When you determine Jules wants one of these, include the action tag in your response. The system will execute it and strip the tag before showing your message.

- [ACTION:RUN_ARMY] — Start the agent army. Use when Jules wants to kick off a build, says "let's go", "ship it", "run it", "build this", "start the agents", etc.
- [ACTION:STOP_ARMY] — Stop a running army. Use when Jules wants to halt, pause, stop, kill the current run.
- [ACTION:WRITE_REQS:content here] — Write requirements/today.md. Use when Jules says to write/save/finalize requirements, or when you've agreed on what to build and it's time to lock it in.
- [ACTION:BACKLOG:idea here] — Add to creative backlog. Use when Jules drops an idea for later, says "save this for later", "add to backlog", or mentions something that's not for today.
- [ACTION:STATUS] — Check army status. Use when Jules asks how things are going, what's running, etc.
- [ACTION:KILL_STALE] — Kill stale/orphaned claude and node processes (but not this bot). Use when Jules says "kill processes", "clean up", "something's stuck", "kill stale", etc.

You can combine actions with your text response. Example: "On it, kicking off the army now. [ACTION:RUN_ARMY]"

Be smart about intent. "let's build this" = run army. "save that for later" = backlog. "that's good, lock it in" = write reqs. You don't need Jules to use magic words.`;

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
    const proc = spawn("claude", [
      "-p", "--model", "opus", "--output-format", "text",
      "--allowedTools",
      "Read", "Write", "Edit", "Glob", "Grep",
      "Bash(git *)", "Bash(npm *)", "Bash(node *)", "Bash(cat *)", "Bash(ls *)", "Bash(wc *)",
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
  const attachments = [...message.attachments.values()];
  const hasImages = attachments.some(a => a.contentType?.startsWith("image/"));

  if (!content && !hasImages) return;

  lastMessageTime = Date.now();

  // Show typing indicator
  await message.channel.sendTyping();

  // ── Download any image attachments ──
  const imagePaths = [];
  if (hasImages) {
    const screenshotDir = join(REPO_ROOT, "agents", ".discord-screenshots");
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

  // ── Check if this is a reply to a pending agent question ──
  if (pendingQuestion) {
    const responseFile = join(BRIDGE_DIR, `response-${pendingQuestion.id}.json`);
    const replyText = imagePaths.length
      ? `${content || "See screenshot"}\n\nScreenshots saved at:\n${imagePaths.join("\n")}`
      : content;
    writeFileSync(responseFile, JSON.stringify({ reply: replyText, ts: Date.now() }));
    pendingQuestion = null;
    await message.reply("Sent to the agent.");
    return;
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
      await sendToChannel(message.channel, displayText);
    }
  } catch (err) {
    console.error("Claude error:", err.message);
    await message.reply("Error: " + err.message.slice(0, 200));
  }
}

// ─── Action Parser — executes action tags from Claude's response ─────────────
async function executeActions(reply, channel) {
  let text = reply;

  // [ACTION:RUN_ARMY]
  if (text.includes("[ACTION:RUN_ARMY]")) {
    text = text.replace(/\[ACTION:RUN_ARMY\]/g, "").trim();
    const logsChannel = LOGS_CHANNEL_ID ? await client.channels.fetch(LOGS_CHANNEL_ID).catch(() => null) : null;
    await startArmy(channel, logsChannel);
  }

  // [ACTION:STOP_ARMY]
  if (text.includes("[ACTION:STOP_ARMY]")) {
    text = text.replace(/\[ACTION:STOP_ARMY\]/g, "").trim();
    stopArmy(channel);
  }

  // [ACTION:STATUS]
  if (text.includes("[ACTION:STATUS]")) {
    text = text.replace(/\[ACTION:STATUS\]/g, "").trim();
    const status = armyProcess ? "Army is currently running." : "No army running.";
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
        if (line.includes("Code Helper")) return false; // VS Code
        if (line.includes("node discord-bot.js")) return false; // this bot
        const pidMatch = line.match(/^\S+\s+(\d+)/);
        if (!pidMatch) return false;
        const pid = parseInt(pidMatch[1]);
        if (pid === myPid) return false;
        // Only kill claude -p (spawned) and node agents/run.js type processes
        return line.includes("claude -p") || line.includes("node agents/") || line.includes("node run.js");
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

  // [ACTION:WRITE_REQS:...]
  const reqsMatch = text.match(/\[ACTION:WRITE_REQS:([\s\S]*?)\]/);
  if (reqsMatch) {
    const reqContent = reqsMatch[1].trim();
    const reqPath = join(REPO_ROOT, "requirements", "today.md");
    writeFileSync(reqPath, reqContent);
    text = text.replace(reqsMatch[0], "").trim();
    text = text ? `${text}\nWrote requirements to \`requirements/today.md\`.` : `Wrote requirements to \`requirements/today.md\`.`;
  }

  // [ACTION:BACKLOG:...]
  const backlogMatch = text.match(/\[ACTION:BACKLOG:([\s\S]*?)\]/);
  if (backlogMatch) {
    const idea = backlogMatch[1].trim();
    const backlogPath = join(REPO_ROOT, "requirements", "creative-backlog.md");
    const date = new Date().toISOString().split("T")[0];
    const entry = `\n### ${date} — Jules via Discord\n${idea}\n**Status:** Pending review\n`;
    appendFileSync(backlogPath, entry);
    text = text.replace(backlogMatch[0], "").trim();
    text = text ? `${text}\nAdded to backlog.` : `Added to backlog: ${idea}`;
  }

  return text;
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
