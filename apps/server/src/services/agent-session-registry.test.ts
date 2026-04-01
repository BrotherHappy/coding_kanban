import test from "node:test";
import assert from "node:assert/strict";

import { AgentSessionRegistry } from "./agent-session-registry.js";

function createSession(registry: AgentSessionRegistry) {
  return registry.register({
    workspaceId: "test",
    hostId: "local",
    sourceType: "local",
    agentKind: "copilot",
    displayName: "Awaiting Input Test",
    interactionState: "running",
  });
}

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("marks direct sessions idle after screen stays unchanged", async () => {
  const registry = new AgentSessionRegistry(20);
  const session = createSession(registry);

  const updated = registry.appendOutput(session.id, "first frame\n", "stdout");

  assert.equal(updated.interactionState, "running");
  assert.equal(updated.stateConfidence, "medium");

  await wait(60);

  assert.equal(registry.get(session.id).interactionState, "idle");
  assert.equal(registry.get(session.id).stateConfidence, "medium");
});

test("rapid output coalesces snapshot broadcasts", async () => {
  const registry = new AgentSessionRegistry(1_000);
  const snapshots: string[] = [];

  registry.subscribe((snapshot) => {
    snapshots.push(snapshot.updatedAt);
  });

  const session = createSession(registry);

  registry.appendOutput(session.id, "frame-1\n", "stdout");
  registry.appendOutput(session.id, "frame-2\n", "stdout");
  registry.appendOutput(session.id, "frame-3\n", "stdout");

  assert.equal(snapshots.length, 2);

  await wait(150);

  assert.equal(snapshots.length, 3);
});

test("user input resets inactivity timer and later returns to idle", async () => {
  const registry = new AgentSessionRegistry(25);
  const session = createSession(registry);

  registry.appendOutput(session.id, "first frame\n", "stdout");
  await wait(10);

  registry.noteUserInput(session.id, "hello");
  assert.equal(registry.get(session.id).interactionState, "running");

  await wait(10);
  assert.equal(registry.get(session.id).interactionState, "running");

  await wait(40);
  assert.equal(registry.get(session.id).interactionState, "idle");
});

test("repeated identical terminal redraws do not keep sessions running", async () => {
  const registry = new AgentSessionRegistry(60);
  const session = createSession(registry);

  registry.appendOutput(session.id, "prompt> ", "stdout");
  await wait(25);

  registry.appendOutput(session.id, "\u001b[2K\rprompt> ", "stdout");
  await wait(40);

  assert.equal(registry.get(session.id).interactionState, "idle");
});

test("identical redraws do not reorder sessions in the board", async () => {
  const registry = new AgentSessionRegistry(60);
  const first = createSession(registry);
  const second = registry.register({
    workspaceId: "test",
    hostId: "local",
    sourceType: "local",
    agentKind: "copilot",
    displayName: "Second Session",
    interactionState: "running",
  });

  registry.appendOutput(first.id, "first prompt> ", "stdout");
  await wait(5);
  registry.appendOutput(second.id, "second prompt> ", "stdout");

  const before = registry.list().items.map((item) => item.id);

  registry.appendOutput(first.id, "\u001b[2K\rfirst prompt> ", "stdout");

  assert.deepEqual(
    registry.list().items.map((item) => item.id),
    before,
  );
});

test("heartbeat updates do not reorder sessions without new output", () => {
  const registry = new AgentSessionRegistry(60);
  const first = registry.register({
    workspaceId: "capture",
    hostId: "local",
    sourceType: "local-window-capture",
    agentKind: "vscode",
    displayName: "Window 1",
    interactionState: "running",
  });
  const second = registry.register({
    workspaceId: "capture",
    hostId: "local",
    sourceType: "local-window-capture",
    agentKind: "vscode",
    displayName: "Window 2",
    interactionState: "running",
  });

  const before = registry.list().items.map((item) => item.id);

  registry.syncCapturedScreen(second.id, "frame 2");

  assert.deepEqual(before, [first.id, second.id]);
  assert.deepEqual(
    registry.list().items.map((item) => item.id),
    before,
  );
});

test("tmux observe-only sessions stay detached even when screen is unchanged", async () => {
  const registry = new AgentSessionRegistry(20);
  const session = registry.register({
    workspaceId: "tmux",
    hostId: "local-tmux",
    sourceType: "remote-tmux-discovered",
    agentKind: "copilot",
    displayName: "tmux pane",
    controlMode: "observe",
    interactionState: "detached",
  });

  registry.syncCapturedScreen(session.id, "stable frame");
  await wait(50);
  const updated = registry.syncCapturedScreen(session.id, "stable frame");

  assert.equal(updated.interactionState, "detached");
  assert.equal(updated.stateConfidence, "high");
});

test("local-window-capture sessions enter idle after the captured screen stays unchanged", async () => {
  const registry = new AgentSessionRegistry(20);
  const session = registry.register({
    workspaceId: "local-vscode-window-observe",
    hostId: "local",
    sourceType: "local-window-capture",
    agentKind: "vscode",
    displayName: "VS Code 窗口 1",
    controlMode: "observe",
    interactionState: "running",
  });

  assert.equal(session.interactionState, "running");

  registry.syncCapturedScreen(session.id, "stable frame");
  await wait(60);

  const updated = registry.syncCapturedScreen(session.id, "stable frame");
  assert.equal(updated.interactionState, "idle");
  assert.equal(updated.stateConfidence, "medium");
});
