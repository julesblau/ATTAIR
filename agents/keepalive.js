/**
 * Keep-Alive Ping System — Extracted for testability
 * ─────────────────────────────────────────────────────
 * Sends keep-alive pings to Jules via Discord when processes are about to
 * shut down or go idle. All Discord/process dependencies are injected.
 */

import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType } from "discord.js";

// ─── Configuration Constants ────────────────────────────────────────────────
export const KEEPALIVE_RESPONSE_TIMEOUT = 2 * 60 * 1000;   // 2 min to respond before shutdown
export const IDLE_KEEPALIVE_THRESHOLD = 2 * 60 * 60 * 1000; // 2 hours idle → send keep-alive ping
export const IDLE_CHECK_INTERVAL = 15 * 60 * 1000;          // check every 15 min
export const BUILD_HEARTBEAT_INTERVAL = 30 * 60 * 1000;     // heartbeat every 30 min during builds

/**
 * Create a keep-alive system with injected dependencies.
 *
 * @param {object} deps
 * @param {object} deps.client           - Discord.js Client instance
 * @param {string} deps.channelId        - Discord channel ID for pings
 * @param {() => object} deps.getState   - Returns { buildLoopRunning, activeProcess, activeTaskLabel, stopRequested, lastMessageTime, lastBuildHeartbeat }
 * @param {(patch: object) => void} deps.setState - Merge partial state updates
 * @param {(reason: string) => Promise<void>} deps.performShutdown - Shutdown handler
 * @param {() => number} deps.getUptime  - Returns process uptime in seconds
 * @param {object} [deps.logger]         - Logger with .log() and .error() (defaults to console)
 */
export function createKeepAliveSystem(deps) {
  const {
    client,
    channelId,
    getState,
    setState,
    performShutdown,
    getUptime = () => Math.floor(process.uptime()),
    logger = console,
  } = deps;

  let keepAlivePending = false;
  let shutdownDeferred = false;
  let idleKeepaliveTimer = null;

  /**
   * Send a keep-alive ping to Jules with interactive buttons.
   * Returns a promise that resolves to { keepRunning: boolean }.
   * Times out after KEEPALIVE_RESPONSE_TIMEOUT.
   */
  async function sendKeepAlivePing(reason, { urgent = false } = {}) {
    if (!channelId || !client.isReady()) return { keepRunning: false };
    if (keepAlivePending) return { keepRunning: true }; // don't double-ping

    keepAlivePending = true;

    try {
      const channel = await client.channels.fetch(channelId);

      const uptime = getUptime();
      const hours = Math.floor(uptime / 3600);
      const mins = Math.floor((uptime % 3600) / 60);

      const state = getState();
      const statusParts = [];
      if (state.buildLoopRunning) statusParts.push(`🔨 Build running: ${state.activeTaskLabel || "unknown"}`);
      else if (state.activeProcess) statusParts.push(`⚙️ Agent active: ${state.activeTaskLabel || "unknown"}`);
      else statusParts.push("💤 Idle — no active tasks");
      statusParts.push(`⏱️ Uptime: ${hours}h ${mins}m`);

      const embed = new EmbedBuilder()
        .setColor(urgent ? 0xE74C3C : 0xF39C12)
        .setTitle(urgent ? "⚠️ Process Shutting Down" : "🏓 Keep-Alive Ping")
        .setDescription(reason)
        .addFields({ name: "Status", value: statusParts.join("\n"), inline: false })
        .setFooter({ text: `Auto-shutdown in ${Math.round(KEEPALIVE_RESPONSE_TIMEOUT / 1000)}s if no response` })
        .setTimestamp();

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId("keepalive_yes")
          .setLabel("Keep Running")
          .setStyle(ButtonStyle.Success)
          .setEmoji("🟢"),
        new ButtonBuilder()
          .setCustomId("keepalive_no")
          .setLabel("Let it Sleep")
          .setStyle(ButtonStyle.Secondary)
          .setEmoji("😴"),
      );

      const pingMsg = await channel.send({
        content: "<@&everyone>",
        embeds: [embed],
        components: [row],
      });

      // Wait for button response or timeout
      const result = await new Promise((resolve) => {
        const collector = pingMsg.createMessageComponentCollector({
          componentType: ComponentType.Button,
          time: KEEPALIVE_RESPONSE_TIMEOUT,
        });

        collector.on("collect", async (interaction) => {
          const keepRunning = interaction.customId === "keepalive_yes";

          const disabledRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
              .setCustomId("keepalive_yes")
              .setLabel("Keep Running")
              .setStyle(keepRunning ? ButtonStyle.Success : ButtonStyle.Secondary)
              .setEmoji("🟢")
              .setDisabled(true),
            new ButtonBuilder()
              .setCustomId("keepalive_no")
              .setLabel("Let it Sleep")
              .setStyle(keepRunning ? ButtonStyle.Secondary : ButtonStyle.Primary)
              .setEmoji("😴")
              .setDisabled(true),
          );

          const responseEmbed = new EmbedBuilder()
            .setColor(keepRunning ? 0x2ECC71 : 0x95A5A6)
            .setTitle(keepRunning ? "✅ Staying Online" : "😴 Going to Sleep")
            .setDescription(keepRunning
              ? "Process will keep running. Back to work."
              : "Shutting down gracefully. Saving all work first.")
            .setTimestamp();

          await interaction.update({
            content: null,
            embeds: [responseEmbed],
            components: [disabledRow],
          });

          collector.stop();
          resolve({ keepRunning });
        });

        collector.on("end", (collected, endReason) => {
          if (endReason === "time" && collected.size === 0) {
            const timeoutEmbed = new EmbedBuilder()
              .setColor(0xE74C3C)
              .setTitle("⏰ No Response — Shutting Down")
              .setDescription("Keep-alive ping timed out. Saving work and going offline.")
              .setTimestamp();

            const disabledRow = new ActionRowBuilder().addComponents(
              new ButtonBuilder()
                .setCustomId("keepalive_yes")
                .setLabel("Keep Running")
                .setStyle(ButtonStyle.Secondary)
                .setEmoji("🟢")
                .setDisabled(true),
              new ButtonBuilder()
                .setCustomId("keepalive_no")
                .setLabel("Let it Sleep")
                .setStyle(ButtonStyle.Secondary)
                .setEmoji("😴")
                .setDisabled(true),
            );

            pingMsg.edit({
              content: null,
              embeds: [timeoutEmbed],
              components: [disabledRow],
            }).catch((editErr) => {
              logger.error("[keepAlive] Failed to update timeout message:", editErr.message);
            });

            resolve({ keepRunning: false });
          }
        });
      });

      return result;
    } catch (err) {
      logger.error("[keepAlive] Failed to send ping:", err.message);
      return { keepRunning: false };
    } finally {
      keepAlivePending = false;
    }
  }

  /**
   * Build heartbeat — called during long builds to check if Jules wants to continue.
   * Non-blocking: if Jules doesn't respond, build continues.
   */
  async function buildHeartbeatCheck() {
    const state = getState();
    if (!state.buildLoopRunning) return;
    if (Date.now() - state.lastBuildHeartbeat < BUILD_HEARTBEAT_INTERVAL) return;

    setState({ lastBuildHeartbeat: Date.now() });

    const uptime = getUptime();
    const hours = Math.floor(uptime / 3600);

    // Only send heartbeat if build has been running for 1+ hours
    if (hours < 1) return;

    if (!channelId || !client.isReady()) return;

    try {
      const channel = await client.channels.fetch(channelId);

      const embed = new EmbedBuilder()
        .setColor(0x3498DB)
        .setTitle("💙 Build Heartbeat")
        .setDescription(`Still building: **${state.activeTaskLabel || "backlog tasks"}**\nRunning for ${hours}h+. All good — just checking in.`)
        .setTimestamp();

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId("heartbeat_continue")
          .setLabel("Keep Going")
          .setStyle(ButtonStyle.Success)
          .setEmoji("👍"),
        new ButtonBuilder()
          .setCustomId("heartbeat_stop")
          .setLabel("Stop After This Task")
          .setStyle(ButtonStyle.Danger)
          .setEmoji("✋"),
      );

      const msg = await channel.send({ embeds: [embed], components: [row] });

      const collector = msg.createMessageComponentCollector({
        componentType: ComponentType.Button,
        time: 10 * 60 * 1000,
      });

      collector.on("collect", async (interaction) => {
        const shouldStop = interaction.customId === "heartbeat_stop";

        if (shouldStop) {
          setState({ stopRequested: true });
        }

        const responseEmbed = new EmbedBuilder()
          .setColor(shouldStop ? 0xE74C3C : 0x2ECC71)
          .setTitle(shouldStop ? "✋ Stopping After Current Task" : "👍 Continuing Build")
          .setTimestamp();

        const disabledRow = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId("heartbeat_continue")
            .setLabel("Keep Going")
            .setStyle(shouldStop ? ButtonStyle.Secondary : ButtonStyle.Success)
            .setEmoji("👍")
            .setDisabled(true),
          new ButtonBuilder()
            .setCustomId("heartbeat_stop")
            .setLabel("Stop After This Task")
            .setStyle(shouldStop ? ButtonStyle.Danger : ButtonStyle.Secondary)
            .setEmoji("✋")
            .setDisabled(true),
        );

        await interaction.update({ embeds: [responseEmbed], components: [disabledRow] });
        collector.stop();
      });

      collector.on("end", (collected, endReason) => {
        if (endReason === "time" && collected.size === 0) {
          const timeoutEmbed = new EmbedBuilder()
            .setColor(0x95A5A6)
            .setTitle("💙 Build Continuing")
            .setDescription("No response — keeping at it.")
            .setTimestamp();

          const disabledRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId("heartbeat_continue").setLabel("Keep Going").setStyle(ButtonStyle.Secondary).setEmoji("👍").setDisabled(true),
            new ButtonBuilder().setCustomId("heartbeat_stop").setLabel("Stop After This Task").setStyle(ButtonStyle.Secondary).setEmoji("✋").setDisabled(true),
          );

          msg.edit({ embeds: [timeoutEmbed], components: [disabledRow] }).catch((editErr) => {
            logger.error("[buildHeartbeat] Failed to update timeout message:", editErr.message);
          });
        }
      });
    } catch (err) {
      logger.error("[buildHeartbeat] Error:", err.message);
    }
  }

  /**
   * Start idle keep-alive monitoring.
   * Pings Jules when the bot has been idle for too long.
   */
  function startIdleKeepAliveMonitor() {
    if (idleKeepaliveTimer) clearInterval(idleKeepaliveTimer);

    idleKeepaliveTimer = setInterval(async () => {
      const state = getState();
      if (state.buildLoopRunning || state.activeProcess || keepAlivePending) return;

      const idleTime = Date.now() - state.lastMessageTime;
      if (idleTime < IDLE_KEEPALIVE_THRESHOLD) return;

      logger.log(`[keepAlive] Idle for ${Math.round(idleTime / 60000)}min — sending keep-alive ping`);

      const { keepRunning } = await sendKeepAlivePing(
        `Bot has been idle for **${Math.round(idleTime / 60000)} minutes**.\nHosting platforms may shut down idle processes. Want to keep me running?`,
        { urgent: false },
      );

      if (keepRunning) {
        setState({ lastMessageTime: Date.now() });
        logger.log("[keepAlive] Jules confirmed — staying alive");
      } else {
        logger.log("[keepAlive] Jules said sleep or no response — shutting down");
        await performShutdown("idle-keepalive");
      }
    }, IDLE_CHECK_INTERVAL);

    return idleKeepaliveTimer;
  }

  /**
   * Handle shutdown signals with keep-alive ping.
   * Gives Jules a chance to keep the process running before it dies.
   */
  async function shutdown(signal) {
    logger.log(`\n${signal} received — sending keep-alive ping before shutdown...`);

    if (shutdownDeferred) {
      logger.log("[shutdown] Second signal received — forcing shutdown");
      await performShutdown(`${signal}-forced`);
      return;
    }

    shutdownDeferred = true;

    const state = getState();
    const hasWork = state.buildLoopRunning || state.activeProcess;
    const reason = hasWork
      ? `**${signal}** received while ${state.buildLoopRunning ? "build loop is running" : `agent is working on: ${state.activeTaskLabel}`}.\nProcess will shut down unless you confirm to keep it running.`
      : `**${signal}** received — process is about to shut down.\nSay the word to keep it running.`;

    const { keepRunning } = await sendKeepAlivePing(reason, { urgent: true });

    if (keepRunning) {
      logger.log("[shutdown] Jules confirmed keep-alive — cancelling shutdown");
      shutdownDeferred = false;

      if (channelId && client.isReady()) {
        try {
          const ch = await client.channels.fetch(channelId);
          await ch.send("Shutdown cancelled — still here. 🫡");
        } catch (err) {
          logger.error("[shutdown] Failed to send cancellation notice:", err.message);
        }
      }
      return;
    }

    await performShutdown(signal);
  }

  /**
   * Stop the idle keep-alive monitor.
   */
  function stopIdleMonitor() {
    if (idleKeepaliveTimer) {
      clearInterval(idleKeepaliveTimer);
      idleKeepaliveTimer = null;
    }
  }

  /**
   * Check if a keep-alive ping is currently pending.
   */
  function isPending() {
    return keepAlivePending;
  }

  /**
   * Check if shutdown has been deferred for a keep-alive response.
   */
  function isShutdownDeferred() {
    return shutdownDeferred;
  }

  return {
    sendKeepAlivePing,
    buildHeartbeatCheck,
    startIdleKeepAliveMonitor,
    shutdown,
    stopIdleMonitor,
    isPending,
    isShutdownDeferred,
  };
}
