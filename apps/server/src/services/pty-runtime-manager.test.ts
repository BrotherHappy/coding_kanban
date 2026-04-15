import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import test from "node:test";

import { AgentSessionRegistry } from "./agent-session-registry.js";
import {
  PtyRuntimeManager,
  sanitizeReplayForTerminal,
} from "./pty-runtime-manager.js";
import { resolveTmuxBinary } from "./runtime-compat.js";

const TMUX_BINARY = resolveTmuxBinary();

function killTmuxSession(sessionName: string): void {
  try {
    execFileSync(TMUX_BINARY, ["kill-session", "-t", sessionName], {
      stdio: "ignore",
    });
  } catch {
    // ignore cleanup failures
  }
}

async function waitForExit(
  registry: AgentSessionRegistry,
  sessionId: string,
  timeoutMs = 5000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (registry.get(sessionId).interactionState === "exited") {
      return;
    }

    await sleep(50);
  }

  throw new Error(`PTY session did not exit within ${timeoutMs}ms`);
}

async function waitForOutputMatch(
  registry: AgentSessionRegistry,
  sessionId: string,
  pattern: RegExp,
  timeoutMs = 5000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const outputText = registry
      .getDetail(sessionId)
      .outputEntries.map((entry) => entry.text)
      .join("\n");

    if (pattern.test(outputText)) {
      return outputText;
    }

    await sleep(50);
  }

  throw new Error(
    `PTY session did not output ${pattern} within ${timeoutMs}ms`,
  );
}

test("launch does not leak npm config env vars into local PTY sessions", async () => {
  const originalRecursive = process.env.npm_config_recursive;
  const originalVerifyDeps = process.env.npm_config_verify_deps_before_run;
  const originalJsrRegistry = process.env.npm_config__jsr_registry;

  process.env.npm_config_recursive = "1";
  process.env.npm_config_verify_deps_before_run = "true";
  process.env.npm_config__jsr_registry = "https://registry.example.test";

  const registry = new AgentSessionRegistry();
  const runtimeManager = new PtyRuntimeManager(registry);

  try {
    const session = runtimeManager.launch({
      workspaceId: "default",
      displayName: "env-leak-test",
      agentKind: "shell",
      workingDirectory: process.cwd(),
      command: "env | grep '^npm_config_' || true; printf '__DONE__\\n'; exit",
    });

    await waitForExit(registry, session.id);

    const detail = registry.getDetail(session.id);
    const outputText = detail.outputEntries
      .map((entry) => entry.text)
      .join("\n");

    assert.doesNotMatch(outputText, /npm_config_recursive=/);
    assert.doesNotMatch(outputText, /npm_config_verify_deps_before_run=/);
    assert.doesNotMatch(outputText, /npm_config__jsr_registry=/);
    assert.match(outputText, /__DONE__/);
  } finally {
    process.env.npm_config_recursive = originalRecursive;
    process.env.npm_config_verify_deps_before_run = originalVerifyDeps;
    process.env.npm_config__jsr_registry = originalJsrRegistry;
  }
});

test("launch stores the resolved local working directory when input is omitted", async () => {
  const registry = new AgentSessionRegistry();
  const runtimeManager = new PtyRuntimeManager(registry);

  const session = runtimeManager.launch({
    workspaceId: "default",
    displayName: "default-cwd-test",
    agentKind: "shell",
    command: "pwd; printf '__DONE__\\n'; exit",
  });

  await waitForExit(registry, session.id);

  const detail = registry.getDetail(session.id);
  const outputText = detail.outputEntries.map((entry) => entry.text).join("\n");

  assert.equal(registry.get(session.id).workingDirectory, process.cwd());
  assert.match(
    outputText,
    new RegExp(process.cwd().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
  );
});

test("launch does not surface npm config warnings before local Copilot starts", async () => {
  const registry = new AgentSessionRegistry();
  const runtimeManager = new PtyRuntimeManager(registry);

  const session = runtimeManager.launch({
    workspaceId: "default",
    displayName: "copilot-warning-test",
    agentKind: "copilot",
    command: "cd '.' && copilot",
  });

  try {
    const outputText = await waitForOutputMatch(
      registry,
      session.id,
      /GitHub Copilot|Unknown env config/,
      10000,
    );

    assert.doesNotMatch(outputText, /Unknown env config/);
    assert.match(outputText, /GitHub Copilot/);
  } finally {
    runtimeManager.kill(session.id);
    registry.remove(session.id);
  }
});

test("launch keeps tmux attach sessions alive when the card is labeled as copilot", async () => {
  const registry = new AgentSessionRegistry();
  const runtimeManager = new PtyRuntimeManager(registry);
  const sessionName = `pty-tmux-attach-${Date.now()}`;
  const marker = `TMUX_ATTACH_OK_${Date.now()}`;
  const originalRecursive = process.env.npm_config_recursive;
  const originalVerifyDeps = process.env.npm_config_verify_deps_before_run;
  const originalJsrRegistry = process.env.npm_config__jsr_registry;

  killTmuxSession(sessionName);
  process.env.npm_config_recursive = "1";
  process.env.npm_config_verify_deps_before_run = "true";
  process.env.npm_config__jsr_registry = "https://registry.example.test";
  execFileSync(
    TMUX_BINARY,
    [
      "new-session",
      "-d",
      "-s",
      sessionName,
      "-c",
      process.cwd(),
      `sh -lc 'printf "${marker}\\n"; sleep 30'`,
    ],
    {
      stdio: "ignore",
    },
  );

  const session = runtimeManager.launch({
    workspaceId: "default",
    displayName: sessionName,
    agentKind: "copilot",
    command: `tmux attach -t '${sessionName}'`,
    workingDirectory: process.cwd(),
    tmuxSessionName: sessionName,
  });

  try {
    const outputText = await waitForOutputMatch(
      registry,
      session.id,
      new RegExp(
        `${marker}|double-loading config|Exit prior to config file resolving|Unknown env config`,
      ),
      10000,
    );

    assert.match(outputText, new RegExp(marker));
    assert.doesNotMatch(outputText, /double-loading config/);
    assert.doesNotMatch(outputText, /Exit prior to config file resolving/);
    assert.doesNotMatch(outputText, /Unknown env config/);
    assert.notEqual(registry.get(session.id).interactionState, "exited");
  } finally {
    runtimeManager.kill(session.id);
    registry.remove(session.id);
    killTmuxSession(sessionName);
    process.env.npm_config_recursive = originalRecursive;
    process.env.npm_config_verify_deps_before_run = originalVerifyDeps;
    process.env.npm_config__jsr_registry = originalJsrRegistry;
  }
});

test("resize retries SIGWINCH for ssh/tmux sessions", async () => {
  const registry = new AgentSessionRegistry();
  const runtimeManager = new PtyRuntimeManager(registry);
  const resizeCalls: Array<{ cols: number; rows: number }> = [];
  const killCalls: Array<{ pid: number; signal: NodeJS.Signals }> = [];
  const originalKill = process.kill;

  const session = registry.register({
    workspaceId: "remote-tmux",
    hostId: "hm20",
    sourceType: "remote-connect",
    agentKind: "shell",
    displayName: "Remote tmux",
    interactionState: "running",
    transportRef: {
      runtimeId: "ssh-pty:4321",
      tmuxSession: "hm20-dev",
    },
  });

  (runtimeManager as unknown as { handles: Map<string, unknown> }).handles.set(
    session.id,
    {
      ptyProcess: {
        pid: 4321,
        resize(cols: number, rows: number) {
          resizeCalls.push({ cols, rows });
        },
      },
    },
  );

  process.kill = ((pid: number, signal?: NodeJS.Signals | number) => {
    if (typeof signal === "string") {
      killCalls.push({ pid, signal });
    }
    return true;
  }) as typeof process.kill;

  try {
    runtimeManager.resize(session.id, 160, 48);
    await sleep(1_150);

    assert.deepEqual(resizeCalls, [{ cols: 160, rows: 48 }]);
    assert.equal(killCalls.length, 4);
    assert.deepEqual(
      killCalls.map(({ pid, signal }) => ({ pid, signal })),
      [
        { pid: 4321, signal: "SIGWINCH" },
        { pid: 4321, signal: "SIGWINCH" },
        { pid: 4321, signal: "SIGWINCH" },
        { pid: 4321, signal: "SIGWINCH" },
      ],
    );
  } finally {
    process.kill = originalKill;
  }
});

test("resize coalesces pending ssh/tmux SIGWINCH retries", async () => {
  const registry = new AgentSessionRegistry();
  const runtimeManager = new PtyRuntimeManager(registry);
  const killCalls: Array<{ pid: number; signal: NodeJS.Signals }> = [];
  const originalKill = process.kill;

  const session = registry.register({
    workspaceId: "remote-tmux",
    hostId: "hm20",
    sourceType: "remote-connect",
    agentKind: "shell",
    displayName: "Remote tmux",
    interactionState: "running",
    transportRef: {
      runtimeId: "ssh-pty:9876",
      tmuxSession: "hm20-dev",
    },
  });

  (runtimeManager as unknown as { handles: Map<string, unknown> }).handles.set(
    session.id,
    {
      ptyProcess: {
        pid: 9876,
        resize() {},
      },
    },
  );

  process.kill = ((pid: number, signal?: NodeJS.Signals | number) => {
    if (typeof signal === "string") {
      killCalls.push({ pid, signal });
    }
    return true;
  }) as typeof process.kill;

  try {
    runtimeManager.resize(session.id, 120, 30);
    await sleep(20);
    runtimeManager.resize(session.id, 160, 48);
    await sleep(1_150);

    assert.equal(killCalls.length, 5);
    assert.deepEqual(
      killCalls.map(({ pid, signal }) => ({ pid, signal })),
      [
        { pid: 9876, signal: "SIGWINCH" },
        { pid: 9876, signal: "SIGWINCH" },
        { pid: 9876, signal: "SIGWINCH" },
        { pid: 9876, signal: "SIGWINCH" },
        { pid: 9876, signal: "SIGWINCH" },
      ],
    );
  } finally {
    process.kill = originalKill;
  }
});

test("strip replayed device attribute and status queries", () => {
  const replay = "prompt> \u001b[>cprompt redraw\u001b[6n\u001b[18tstill here";

  const sanitized = sanitizeReplayForTerminal(replay);

  assert.equal(sanitized, "prompt> prompt redrawstill here");
});

test("keep normal styling escapes in replay", () => {
  const replay = "\u001b[31mred\u001b[0m text";

  const sanitized = sanitizeReplayForTerminal(replay);

  assert.equal(sanitized, replay);
});
