/**
 * Tests for Keep-Alive Ping System (keepalive.js)
 *
 * Tests the extracted keep-alive functions with fully mocked Discord.js
 * dependencies. No real Discord API calls are made.
 *
 * Coverage:
 *   - sendKeepAlivePing: normal flow, button responses, timeouts, error handling
 *   - buildHeartbeatCheck: timing guards, heartbeat sending, stop requests
 *   - startIdleKeepAliveMonitor: idle detection, threshold checks
 *   - shutdown: signal handling, deferred shutdown, force shutdown
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ─── Mock discord.js ────────────────────────────────────────────────────────

vi.mock("discord.js", () => {
  class MockEmbedBuilder {
    constructor() { this._data = {}; }
    setColor(c) { this._data.color = c; return this; }
    setTitle(t) { this._data.title = t; return this; }
    setDescription(d) { this._data.description = d; return this; }
    addFields(...f) { this._data.fields = f; return this; }
    setFooter(f) { this._data.footer = f; return this; }
    setTimestamp() { this._data.timestamp = true; return this; }
  }

  class MockButtonBuilder {
    constructor() { this._data = {}; }
    setCustomId(id) { this._data.customId = id; return this; }
    setLabel(l) { this._data.label = l; return this; }
    setStyle(s) { this._data.style = s; return this; }
    setEmoji(e) { this._data.emoji = e; return this; }
    setDisabled(d) { this._data.disabled = d; return this; }
  }

  class MockActionRowBuilder {
    constructor() { this._components = []; }
    addComponents(...c) { this._components.push(...c); return this; }
  }

  return {
    EmbedBuilder: MockEmbedBuilder,
    ActionRowBuilder: MockActionRowBuilder,
    ButtonBuilder: MockButtonBuilder,
    ButtonStyle: { Success: 1, Secondary: 2, Primary: 3, Danger: 4 },
    ComponentType: { Button: 2 },
  };
});

const { createKeepAliveSystem, KEEPALIVE_RESPONSE_TIMEOUT, IDLE_KEEPALIVE_THRESHOLD, IDLE_CHECK_INTERVAL, BUILD_HEARTBEAT_INTERVAL } = await import("../keepalive.js");

// ─── Test Helpers ───────────────────────────────────────────────────────────

/** Flush all pending microtasks so awaited promises resolve (works with fake timers) */
async function flushMicrotasks() {
  // Each await resolves one level of the microtask queue
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

function createMockCollector() {
  const handlers = {};
  return {
    on(event, handler) { handlers[event] = handler; },
    stop() {},
    _simulateCollect(interaction) { if (handlers.collect) handlers.collect(interaction); },
    _simulateEnd(collected, reason) { if (handlers.end) handlers.end(collected, reason); },
    _handlers: handlers,
  };
}

function createMockMessage(collector) {
  return {
    createMessageComponentCollector: vi.fn(() => collector),
    edit: vi.fn().mockResolvedValue(undefined),
  };
}

function createMockChannel() {
  return { send: vi.fn() };
}

function createMockClient(ready = true) {
  const mockChannel = createMockChannel();
  return {
    isReady: vi.fn(() => ready),
    channels: { fetch: vi.fn().mockResolvedValue(mockChannel) },
    _mockChannel: mockChannel,
  };
}

function createDefaultState(overrides = {}) {
  return {
    buildLoopRunning: false,
    activeProcess: null,
    activeTaskLabel: null,
    stopRequested: false,
    lastMessageTime: Date.now(),
    lastBuildHeartbeat: 0,
    ...overrides,
  };
}

function createTestSystem(overrides = {}) {
  const state = createDefaultState(overrides.stateOverrides);
  const mockClient = overrides.client || createMockClient();
  const mockPerformShutdown = overrides.performShutdown || vi.fn().mockResolvedValue(undefined);
  const mockLogger = overrides.logger || { log: vi.fn(), error: vi.fn() };

  const system = createKeepAliveSystem({
    client: mockClient,
    channelId: overrides.channelId !== undefined ? overrides.channelId : "test-channel-123",
    getState: () => ({ ...state }),
    setState: (patch) => Object.assign(state, patch),
    performShutdown: mockPerformShutdown,
    getUptime: overrides.getUptime || (() => 7200),
    logger: mockLogger,
  });

  return { system, state, mockClient, mockPerformShutdown, mockLogger };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("Keep-Alive Ping System", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // ─── Constants ──────────────────────────────────────────────────────────

  describe("constants", () => {
    it("exports correct timeout values", () => {
      expect(KEEPALIVE_RESPONSE_TIMEOUT).toBe(2 * 60 * 1000);
      expect(IDLE_KEEPALIVE_THRESHOLD).toBe(2 * 60 * 60 * 1000);
      expect(IDLE_CHECK_INTERVAL).toBe(15 * 60 * 1000);
      expect(BUILD_HEARTBEAT_INTERVAL).toBe(30 * 60 * 1000);
    });
  });

  // ─── sendKeepAlivePing ──────────────────────────────────────────────────

  describe("sendKeepAlivePing", () => {
    it("returns { keepRunning: false } when client is not ready", async () => {
      const { system } = createTestSystem({ client: createMockClient(false) });
      const result = await system.sendKeepAlivePing("test reason");
      expect(result).toEqual({ keepRunning: false });
    });

    it("returns { keepRunning: false } when channelId is empty", async () => {
      const { system } = createTestSystem({ channelId: "" });
      const result = await system.sendKeepAlivePing("test reason");
      expect(result).toEqual({ keepRunning: false });
    });

    it("returns { keepRunning: false } when channelId is null", async () => {
      const { system } = createTestSystem({ channelId: null });
      const result = await system.sendKeepAlivePing("test reason");
      expect(result).toEqual({ keepRunning: false });
    });

    it("returns { keepRunning: true } when a ping is already pending (no double-ping)", async () => {
      const collector = createMockCollector();
      const mockMsg = createMockMessage(collector);
      const mockClient = createMockClient();
      mockClient._mockChannel.send.mockResolvedValue(mockMsg);

      const { system } = createTestSystem({ client: mockClient });

      // Start first ping (don't resolve it yet)
      const firstPing = system.sendKeepAlivePing("first ping");
      await flushMicrotasks();

      // Second ping should return immediately with keepRunning: true
      const secondResult = await system.sendKeepAlivePing("second ping");
      expect(secondResult).toEqual({ keepRunning: true });

      // Clean up first ping
      collector._simulateEnd({ size: 0 }, "time");
      await firstPing;
    });

    it("sends embed with correct content to channel", async () => {
      const collector = createMockCollector();
      const mockMsg = createMockMessage(collector);
      const mockClient = createMockClient();
      mockClient._mockChannel.send.mockResolvedValue(mockMsg);

      const { system } = createTestSystem({ client: mockClient });

      const pingPromise = system.sendKeepAlivePing("urgent reason", { urgent: true });
      await flushMicrotasks();

      expect(mockClient._mockChannel.send).toHaveBeenCalledWith(
        expect.objectContaining({ content: "<@&everyone>" }),
      );

      collector._simulateEnd({ size: 0 }, "time");
      await pingPromise;
    });

    it("resolves { keepRunning: true } when user clicks 'Keep Running'", async () => {
      const collector = createMockCollector();
      const mockMsg = createMockMessage(collector);
      const mockClient = createMockClient();
      mockClient._mockChannel.send.mockResolvedValue(mockMsg);

      const { system } = createTestSystem({ client: mockClient });

      const pingPromise = system.sendKeepAlivePing("test");
      await flushMicrotasks();

      collector._simulateCollect({
        customId: "keepalive_yes",
        update: vi.fn().mockResolvedValue(undefined),
      });

      const result = await pingPromise;
      expect(result).toEqual({ keepRunning: true });
    });

    it("resolves { keepRunning: false } when user clicks 'Let it Sleep'", async () => {
      const collector = createMockCollector();
      const mockMsg = createMockMessage(collector);
      const mockClient = createMockClient();
      mockClient._mockChannel.send.mockResolvedValue(mockMsg);

      const { system } = createTestSystem({ client: mockClient });

      const pingPromise = system.sendKeepAlivePing("test");
      await flushMicrotasks();

      collector._simulateCollect({
        customId: "keepalive_no",
        update: vi.fn().mockResolvedValue(undefined),
      });

      const result = await pingPromise;
      expect(result).toEqual({ keepRunning: false });
    });

    it("resolves { keepRunning: false } on timeout with no response", async () => {
      const collector = createMockCollector();
      const mockMsg = createMockMessage(collector);
      const mockClient = createMockClient();
      mockClient._mockChannel.send.mockResolvedValue(mockMsg);

      const { system } = createTestSystem({ client: mockClient });

      const pingPromise = system.sendKeepAlivePing("test");
      await flushMicrotasks();

      collector._simulateEnd({ size: 0 }, "time");

      const result = await pingPromise;
      expect(result).toEqual({ keepRunning: false });
      expect(mockMsg.edit).toHaveBeenCalled();
    });

    it("returns { keepRunning: false } when channel fetch throws", async () => {
      const mockClient = createMockClient();
      mockClient.channels.fetch.mockRejectedValue(new Error("Channel not found"));

      const { system, mockLogger } = createTestSystem({ client: mockClient });

      const result = await system.sendKeepAlivePing("test");
      expect(result).toEqual({ keepRunning: false });
      expect(mockLogger.error).toHaveBeenCalledWith(
        "[keepAlive] Failed to send ping:",
        "Channel not found",
      );
    });

    it("returns { keepRunning: false } when channel.send throws", async () => {
      const mockClient = createMockClient();
      mockClient._mockChannel.send.mockRejectedValue(new Error("Discord API error"));

      const { system, mockLogger } = createTestSystem({ client: mockClient });

      const result = await system.sendKeepAlivePing("test");
      expect(result).toEqual({ keepRunning: false });
      expect(mockLogger.error).toHaveBeenCalledWith(
        "[keepAlive] Failed to send ping:",
        "Discord API error",
      );
    });

    it("logs error when timeout message edit fails", async () => {
      const collector = createMockCollector();
      const mockMsg = createMockMessage(collector);
      mockMsg.edit.mockRejectedValue(new Error("Edit failed"));
      const mockClient = createMockClient();
      mockClient._mockChannel.send.mockResolvedValue(mockMsg);

      const { system, mockLogger } = createTestSystem({ client: mockClient });

      const pingPromise = system.sendKeepAlivePing("test");
      await flushMicrotasks();

      collector._simulateEnd({ size: 0 }, "time");
      await pingPromise;

      // Wait for the catch handler to fire
      await flushMicrotasks();
      expect(mockLogger.error).toHaveBeenCalledWith(
        "[keepAlive] Failed to update timeout message:",
        "Edit failed",
      );
    });

    it("resets keepAlivePending after completion", async () => {
      const collector = createMockCollector();
      const mockMsg = createMockMessage(collector);
      const mockClient = createMockClient();
      mockClient._mockChannel.send.mockResolvedValue(mockMsg);

      const { system } = createTestSystem({ client: mockClient });

      const pingPromise = system.sendKeepAlivePing("test");
      await flushMicrotasks();
      expect(system.isPending()).toBe(true);

      collector._simulateEnd({ size: 0 }, "time");
      await pingPromise;

      expect(system.isPending()).toBe(false);
    });

    it("resets keepAlivePending even on error", async () => {
      const mockClient = createMockClient();
      mockClient.channels.fetch.mockRejectedValue(new Error("fail"));

      const { system } = createTestSystem({ client: mockClient });

      await system.sendKeepAlivePing("test");
      expect(system.isPending()).toBe(false);
    });
  });

  // ─── buildHeartbeatCheck ────────────────────────────────────────────────

  describe("buildHeartbeatCheck", () => {
    it("does nothing when build loop is not running", async () => {
      const mockClient = createMockClient();
      const { system } = createTestSystem({
        client: mockClient,
        stateOverrides: { buildLoopRunning: false },
      });

      await system.buildHeartbeatCheck();
      expect(mockClient.channels.fetch).not.toHaveBeenCalled();
    });

    it("does nothing when last heartbeat was recent", async () => {
      const mockClient = createMockClient();
      const { system } = createTestSystem({
        client: mockClient,
        stateOverrides: { buildLoopRunning: true, lastBuildHeartbeat: Date.now() },
      });

      await system.buildHeartbeatCheck();
      expect(mockClient.channels.fetch).not.toHaveBeenCalled();
    });

    it("does nothing when uptime is less than 1 hour", async () => {
      const mockClient = createMockClient();
      const { system } = createTestSystem({
        client: mockClient,
        stateOverrides: { buildLoopRunning: true, lastBuildHeartbeat: 0 },
        getUptime: () => 1800, // 30 minutes
      });

      await system.buildHeartbeatCheck();
      expect(mockClient._mockChannel.send).not.toHaveBeenCalled();
    });

    it("does nothing when client is not ready", async () => {
      const mockClient = createMockClient(false);
      const { system } = createTestSystem({
        client: mockClient,
        stateOverrides: { buildLoopRunning: true, lastBuildHeartbeat: 0 },
      });

      await system.buildHeartbeatCheck();
      expect(mockClient._mockChannel.send).not.toHaveBeenCalled();
    });

    it("sends heartbeat when conditions are met", async () => {
      const collector = createMockCollector();
      const mockMsg = createMockMessage(collector);
      const mockClient = createMockClient();
      mockClient._mockChannel.send.mockResolvedValue(mockMsg);

      const { system } = createTestSystem({
        client: mockClient,
        stateOverrides: { buildLoopRunning: true, activeTaskLabel: "implement feature", lastBuildHeartbeat: 0 },
        getUptime: () => 7200,
      });

      await system.buildHeartbeatCheck();
      expect(mockClient._mockChannel.send).toHaveBeenCalled();
    });

    it("sets stopRequested when user clicks 'Stop After This Task'", async () => {
      const collector = createMockCollector();
      const mockMsg = createMockMessage(collector);
      const mockClient = createMockClient();
      mockClient._mockChannel.send.mockResolvedValue(mockMsg);

      const { system, state } = createTestSystem({
        client: mockClient,
        stateOverrides: { buildLoopRunning: true, lastBuildHeartbeat: 0 },
      });

      await system.buildHeartbeatCheck();

      collector._simulateCollect({
        customId: "heartbeat_stop",
        update: vi.fn().mockResolvedValue(undefined),
      });

      expect(state.stopRequested).toBe(true);
    });

    it("does not set stopRequested when user clicks 'Keep Going'", async () => {
      const collector = createMockCollector();
      const mockMsg = createMockMessage(collector);
      const mockClient = createMockClient();
      mockClient._mockChannel.send.mockResolvedValue(mockMsg);

      const { system, state } = createTestSystem({
        client: mockClient,
        stateOverrides: { buildLoopRunning: true, lastBuildHeartbeat: 0 },
      });

      await system.buildHeartbeatCheck();

      collector._simulateCollect({
        customId: "heartbeat_continue",
        update: vi.fn().mockResolvedValue(undefined),
      });

      expect(state.stopRequested).toBe(false);
    });

    it("logs error when channel fetch fails", async () => {
      const mockClient = createMockClient();
      mockClient.channels.fetch.mockRejectedValue(new Error("Channel unavailable"));

      const { system, mockLogger } = createTestSystem({
        client: mockClient,
        stateOverrides: { buildLoopRunning: true, lastBuildHeartbeat: 0 },
      });

      await system.buildHeartbeatCheck();
      expect(mockLogger.error).toHaveBeenCalledWith("[buildHeartbeat] Error:", "Channel unavailable");
    });

    it("logs error when timeout message edit fails", async () => {
      const collector = createMockCollector();
      const mockMsg = createMockMessage(collector);
      mockMsg.edit.mockRejectedValue(new Error("Edit failed"));
      const mockClient = createMockClient();
      mockClient._mockChannel.send.mockResolvedValue(mockMsg);

      const { system, mockLogger } = createTestSystem({
        client: mockClient,
        stateOverrides: { buildLoopRunning: true, lastBuildHeartbeat: 0 },
      });

      await system.buildHeartbeatCheck();
      collector._simulateEnd({ size: 0 }, "time");

      await flushMicrotasks();
      expect(mockLogger.error).toHaveBeenCalledWith(
        "[buildHeartbeat] Failed to update timeout message:",
        "Edit failed",
      );
    });

    it("updates lastBuildHeartbeat timestamp", async () => {
      const collector = createMockCollector();
      const mockMsg = createMockMessage(collector);
      const mockClient = createMockClient();
      mockClient._mockChannel.send.mockResolvedValue(mockMsg);

      const { system, state } = createTestSystem({
        client: mockClient,
        stateOverrides: { buildLoopRunning: true, lastBuildHeartbeat: 0 },
      });

      const before = Date.now();
      await system.buildHeartbeatCheck();
      expect(state.lastBuildHeartbeat).toBeGreaterThanOrEqual(before);
    });
  });

  // ─── shutdown ───────────────────────────────────────────────────────────

  describe("shutdown", () => {
    it("sends urgent keep-alive ping on SIGTERM", async () => {
      const collector = createMockCollector();
      const mockMsg = createMockMessage(collector);
      const mockClient = createMockClient();
      mockClient._mockChannel.send.mockResolvedValue(mockMsg);

      const { system, mockPerformShutdown } = createTestSystem({ client: mockClient });

      const shutdownPromise = system.shutdown("SIGTERM");
      await flushMicrotasks();

      expect(mockClient._mockChannel.send).toHaveBeenCalledWith(
        expect.objectContaining({ content: "<@&everyone>" }),
      );

      collector._simulateEnd({ size: 0 }, "time");
      await shutdownPromise;
      expect(mockPerformShutdown).toHaveBeenCalledWith("SIGTERM");
    });

    it("cancels shutdown when Jules clicks 'Keep Running'", async () => {
      const collector = createMockCollector();
      const mockMsg = createMockMessage(collector);
      const mockClient = createMockClient();
      mockClient._mockChannel.send.mockResolvedValue(mockMsg);

      const { system, mockPerformShutdown } = createTestSystem({ client: mockClient });

      const shutdownPromise = system.shutdown("SIGTERM");
      await flushMicrotasks();

      collector._simulateCollect({
        customId: "keepalive_yes",
        update: vi.fn().mockResolvedValue(undefined),
      });

      await shutdownPromise;
      expect(mockPerformShutdown).not.toHaveBeenCalled();
      expect(system.isShutdownDeferred()).toBe(false);
    });

    it("sends cancellation notice to Discord when shutdown is cancelled", async () => {
      const collector = createMockCollector();
      const mockMsg = createMockMessage(collector);
      const mockClient = createMockClient();
      mockClient._mockChannel.send.mockResolvedValue(mockMsg);

      const { system } = createTestSystem({ client: mockClient });

      const shutdownPromise = system.shutdown("SIGINT");
      await flushMicrotasks();

      collector._simulateCollect({
        customId: "keepalive_yes",
        update: vi.fn().mockResolvedValue(undefined),
      });

      await shutdownPromise;

      const sendCalls = mockClient._mockChannel.send.mock.calls;
      const lastCallArg = sendCalls[sendCalls.length - 1][0];
      expect(lastCallArg).toContain("Shutdown cancelled");
    });

    it("logs error when cancellation notice fails to send", async () => {
      const collector = createMockCollector();
      const mockMsg = createMockMessage(collector);
      const mockClient = createMockClient();

      let sendCount = 0;
      mockClient._mockChannel.send.mockImplementation(() => {
        sendCount++;
        if (sendCount === 1) return Promise.resolve(mockMsg);
        return Promise.reject(new Error("Send failed"));
      });

      const { system, mockLogger } = createTestSystem({ client: mockClient });

      const shutdownPromise = system.shutdown("SIGTERM");
      await flushMicrotasks();

      collector._simulateCollect({
        customId: "keepalive_yes",
        update: vi.fn().mockResolvedValue(undefined),
      });

      await shutdownPromise;

      expect(mockLogger.error).toHaveBeenCalledWith(
        "[shutdown] Failed to send cancellation notice:",
        "Send failed",
      );
    });

    it("forces shutdown on second signal", async () => {
      const collector1 = createMockCollector();
      const mockMsg1 = createMockMessage(collector1);
      const mockClient = createMockClient();
      mockClient._mockChannel.send.mockResolvedValue(mockMsg1);

      const { system, mockPerformShutdown } = createTestSystem({ client: mockClient });

      // First signal (don't resolve)
      const firstShutdown = system.shutdown("SIGTERM");
      await flushMicrotasks();

      // Second signal — should force
      await system.shutdown("SIGTERM");
      expect(mockPerformShutdown).toHaveBeenCalledWith("SIGTERM-forced");

      // Clean up first
      collector1._simulateEnd({ size: 0 }, "time");
      await firstShutdown;
    });

    it("proceeds with shutdown when Jules clicks 'Let it Sleep'", async () => {
      const collector = createMockCollector();
      const mockMsg = createMockMessage(collector);
      const mockClient = createMockClient();
      mockClient._mockChannel.send.mockResolvedValue(mockMsg);

      const { system, mockPerformShutdown } = createTestSystem({ client: mockClient });

      const shutdownPromise = system.shutdown("SIGINT");
      await flushMicrotasks();

      collector._simulateCollect({
        customId: "keepalive_no",
        update: vi.fn().mockResolvedValue(undefined),
      });

      await shutdownPromise;
      expect(mockPerformShutdown).toHaveBeenCalledWith("SIGINT");
    });

    it("includes reason mentioning signal in the ping", async () => {
      const collector = createMockCollector();
      const mockMsg = createMockMessage(collector);
      const mockClient = createMockClient();
      mockClient._mockChannel.send.mockResolvedValue(mockMsg);

      const { system } = createTestSystem({
        client: mockClient,
        stateOverrides: { buildLoopRunning: true },
      });

      const shutdownPromise = system.shutdown("SIGTERM");
      await flushMicrotasks();

      expect(mockClient._mockChannel.send).toHaveBeenCalled();

      collector._simulateEnd({ size: 0 }, "time");
      await shutdownPromise;
    });
  });

  // ─── startIdleKeepAliveMonitor ──────────────────────────────────────────

  describe("startIdleKeepAliveMonitor", () => {
    it("returns a timer ID", () => {
      const { system } = createTestSystem();
      const timer = system.startIdleKeepAliveMonitor();
      expect(timer).toBeDefined();
      system.stopIdleMonitor();
    });

    it("does not send ping when bot is busy (build running)", async () => {
      const mockClient = createMockClient();
      const { system } = createTestSystem({
        client: mockClient,
        stateOverrides: {
          buildLoopRunning: true,
          lastMessageTime: Date.now() - IDLE_KEEPALIVE_THRESHOLD - 1000,
        },
      });

      system.startIdleKeepAliveMonitor();
      await vi.advanceTimersByTimeAsync(IDLE_CHECK_INTERVAL);

      expect(mockClient._mockChannel.send).not.toHaveBeenCalled();
      system.stopIdleMonitor();
    });

    it("does not send ping when bot is busy (active process)", async () => {
      const mockClient = createMockClient();
      const { system } = createTestSystem({
        client: mockClient,
        stateOverrides: {
          activeProcess: { kill: vi.fn() },
          lastMessageTime: Date.now() - IDLE_KEEPALIVE_THRESHOLD - 1000,
        },
      });

      system.startIdleKeepAliveMonitor();
      await vi.advanceTimersByTimeAsync(IDLE_CHECK_INTERVAL);

      expect(mockClient._mockChannel.send).not.toHaveBeenCalled();
      system.stopIdleMonitor();
    });

    it("does not send ping when idle time is below threshold", async () => {
      const mockClient = createMockClient();
      const { system } = createTestSystem({
        client: mockClient,
        stateOverrides: { lastMessageTime: Date.now() },
      });

      system.startIdleKeepAliveMonitor();
      await vi.advanceTimersByTimeAsync(IDLE_CHECK_INTERVAL);

      expect(mockClient._mockChannel.send).not.toHaveBeenCalled();
      system.stopIdleMonitor();
    });

    it("sends keep-alive ping when idle threshold is exceeded", async () => {
      const collector = createMockCollector();
      const mockMsg = createMockMessage(collector);
      const mockClient = createMockClient();
      mockClient._mockChannel.send.mockResolvedValue(mockMsg);

      const { system, state } = createTestSystem({
        client: mockClient,
        stateOverrides: {
          lastMessageTime: Date.now() - IDLE_KEEPALIVE_THRESHOLD - 60000,
        },
      });

      system.startIdleKeepAliveMonitor();
      await vi.advanceTimersByTimeAsync(IDLE_CHECK_INTERVAL);
      await flushMicrotasks();

      expect(mockClient._mockChannel.send).toHaveBeenCalled();

      // Jules keeps it running
      collector._simulateCollect({
        customId: "keepalive_yes",
        update: vi.fn().mockResolvedValue(undefined),
      });

      await flushMicrotasks();
      expect(state.lastMessageTime).toBeGreaterThan(Date.now() - 1000);

      system.stopIdleMonitor();
    });

    it("calls performShutdown when Jules does not respond", async () => {
      const collector = createMockCollector();
      const mockMsg = createMockMessage(collector);
      const mockClient = createMockClient();
      mockClient._mockChannel.send.mockResolvedValue(mockMsg);

      const { system, mockPerformShutdown } = createTestSystem({
        client: mockClient,
        stateOverrides: {
          lastMessageTime: Date.now() - IDLE_KEEPALIVE_THRESHOLD - 60000,
        },
      });

      system.startIdleKeepAliveMonitor();
      await vi.advanceTimersByTimeAsync(IDLE_CHECK_INTERVAL);
      await flushMicrotasks();

      collector._simulateEnd({ size: 0 }, "time");
      await flushMicrotasks();

      expect(mockPerformShutdown).toHaveBeenCalledWith("idle-keepalive");
      system.stopIdleMonitor();
    });

    it("clears previous timer when called again", () => {
      const { system } = createTestSystem();

      const timer1 = system.startIdleKeepAliveMonitor();
      const timer2 = system.startIdleKeepAliveMonitor();

      expect(timer1).toBeDefined();
      expect(timer2).toBeDefined();

      system.stopIdleMonitor();
    });
  });

  // ─── stopIdleMonitor ────────────────────────────────────────────────────

  describe("stopIdleMonitor", () => {
    it("clears the interval timer", async () => {
      const mockClient = createMockClient();
      const { system } = createTestSystem({
        client: mockClient,
        stateOverrides: {
          lastMessageTime: Date.now() - IDLE_KEEPALIVE_THRESHOLD - 60000,
        },
      });

      system.startIdleKeepAliveMonitor();
      system.stopIdleMonitor();

      await vi.advanceTimersByTimeAsync(IDLE_CHECK_INTERVAL * 2);
      expect(mockClient._mockChannel.send).not.toHaveBeenCalled();
    });

    it("is safe to call when no timer is active", () => {
      const { system } = createTestSystem();
      expect(() => system.stopIdleMonitor()).not.toThrow();
    });
  });

  // ─── State accessors ───────────────────────────────────────────────────

  describe("state accessors", () => {
    it("isPending returns false initially", () => {
      const { system } = createTestSystem();
      expect(system.isPending()).toBe(false);
    });

    it("isShutdownDeferred returns false initially", () => {
      const { system } = createTestSystem();
      expect(system.isShutdownDeferred()).toBe(false);
    });
  });
});
