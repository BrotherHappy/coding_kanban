import test from "node:test";
import assert from "node:assert/strict";

import { AgentSessionRegistry } from "./agent-session-registry.js";
import {
  ObserveSessionManager,
  TokenMismatchError,
  InvalidTransitionError,
} from "./observe-session-manager.js";

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("createSession returns agentSession and observeToken", () => {
  const registry = new AgentSessionRegistry();
  const manager = new ObserveSessionManager(registry);

  const result = manager.createSession({
    suggestedDisplayName: "VS Code 窗口 1",
  });

  assert.ok(result.agentSession.id);
  assert.ok(result.observeToken);
  assert.equal(result.agentSession.sourceType, "local-window-capture");
  assert.equal(result.agentSession.connectionState, "online");
  assert.equal(result.agentSession.interactionState, "running");
  assert.equal(result.agentSession.controlMode, "observe");
  assert.equal(result.agentSession.displayName, "VS Code 窗口 1");
});

test("createSession uses default name when none suggested", () => {
  const registry = new AgentSessionRegistry();
  const manager = new ObserveSessionManager(registry);

  const result = manager.createSession({});

  assert.equal(result.agentSession.displayName, "VS Code 窗口");
});

test("heartbeat refreshes lastHeartbeatAt", () => {
  const registry = new AgentSessionRegistry();
  const manager = new ObserveSessionManager(registry);

  const { agentSession, observeToken } = manager.createSession({});
  const before = registry.get(agentSession.id).lastHeartbeatAt;

  const updated = manager.processObserveState(agentSession.id, {
    kind: "heartbeat",
    observeToken,
    outputPreview: "new preview",
  });

  assert.ok(updated.lastHeartbeatAt);
  assert.equal(updated.outputPreview, "new preview");
});

test("heartbeat marks observed captures idle after the screen stays unchanged", async () => {
  const registry = new AgentSessionRegistry(20);
  const manager = new ObserveSessionManager(registry);

  const { agentSession, observeToken } = manager.createSession({});

  manager.processObserveState(agentSession.id, {
    kind: "heartbeat",
    observeToken,
    outputPreview: "capturing...",
    screenSignature: "frame-stable",
  } as any);

  await wait(30);

  const updated = manager.processObserveState(agentSession.id, {
    kind: "heartbeat",
    observeToken,
    outputPreview: "capturing...",
    screenSignature: "frame-stable",
  } as any);

  assert.equal(updated.interactionState, "idle");
  assert.equal(updated.stateConfidence, "medium");
});

test("wrong token is rejected", () => {
  const registry = new AgentSessionRegistry();
  const manager = new ObserveSessionManager(registry);

  const { agentSession } = manager.createSession({});

  assert.throws(
    () =>
      manager.processObserveState(agentSession.id, {
        kind: "heartbeat",
        observeToken: "wrong-token",
      }),
    TokenMismatchError,
  );
});

test("valid transition running -> detached succeeds", () => {
  const registry = new AgentSessionRegistry();
  const manager = new ObserveSessionManager(registry);

  const { agentSession, observeToken } = manager.createSession({});

  const updated = manager.processObserveState(agentSession.id, {
    kind: "transition",
    observeToken,
    connectionState: "degraded",
    interactionState: "detached",
    stateConfidence: "high",
    outputPreview: "detached",
  });

  assert.equal(updated.connectionState, "degraded");
  assert.equal(updated.interactionState, "detached");
});

test("valid transition running -> exited succeeds", () => {
  const registry = new AgentSessionRegistry();
  const manager = new ObserveSessionManager(registry);

  const { agentSession, observeToken } = manager.createSession({});

  const updated = manager.processObserveState(agentSession.id, {
    kind: "transition",
    observeToken,
    connectionState: "offline",
    interactionState: "exited",
    stateConfidence: "high",
    outputPreview: "capture ended",
  });

  assert.equal(updated.connectionState, "offline");
  assert.equal(updated.interactionState, "exited");
});

test("invalid transition running -> idle is rejected", () => {
  const registry = new AgentSessionRegistry();
  const manager = new ObserveSessionManager(registry);

  const { agentSession, observeToken } = manager.createSession({});

  assert.throws(
    () =>
      manager.processObserveState(agentSession.id, {
        kind: "transition",
        observeToken,
        connectionState: "online",
        interactionState: "idle",
        stateConfidence: "high",
      }),
    InvalidTransitionError,
  );
});

test("sweep transitions expired sessions to degraded+detached", async () => {
  const registry = new AgentSessionRegistry();
  const manager = new ObserveSessionManager(registry, 30);

  const { agentSession } = manager.createSession({});
  assert.equal(registry.get(agentSession.id).connectionState, "online");

  await wait(40);

  const expired = manager.sweepExpiredSessions(Date.now());
  assert.equal(expired.length, 1);
  assert.equal(expired[0], agentSession.id);

  const session = registry.get(agentSession.id);
  assert.equal(session.connectionState, "degraded");
  assert.equal(session.interactionState, "detached");
});

test("sweep does not affect sessions with recent heartbeat", async () => {
  const registry = new AgentSessionRegistry();
  const manager = new ObserveSessionManager(registry, 50);

  const { agentSession, observeToken } = manager.createSession({});

  await wait(20);

  // Send heartbeat to refresh
  manager.processObserveState(agentSession.id, {
    kind: "heartbeat",
    observeToken,
  });

  await wait(20);

  const expired = manager.sweepExpiredSessions(Date.now());
  assert.equal(expired.length, 0);
  assert.equal(registry.get(agentSession.id).connectionState, "online");
});

test("isRunningCapture returns true for active sessions", () => {
  const registry = new AgentSessionRegistry();
  const manager = new ObserveSessionManager(registry);

  const { agentSession, observeToken } = manager.createSession({});

  assert.equal(manager.isRunningCapture(agentSession.id), true);

  // After transition to exited
  manager.processObserveState(agentSession.id, {
    kind: "transition",
    observeToken,
    connectionState: "offline",
    interactionState: "exited",
    stateConfidence: "high",
  });

  assert.equal(manager.isRunningCapture(agentSession.id), false);
});
