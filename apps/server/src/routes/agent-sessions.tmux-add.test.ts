import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";

import { buildServer } from "../app.js";
import { PtyRuntimeManager } from "../services/pty-runtime-manager.js";
import { resolveTmuxBinary } from "../services/runtime-compat.js";

const TMUX_BINARY = resolveTmuxBinary();

function runTmux(args: string[]): string {
  return execFileSync(TMUX_BINARY, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

function firstPaneId(sessionName: string): string {
  return runTmux(["list-panes", "-t", sessionName, "-F", "#{pane_id}"])
    .split("\n")
    .find(Boolean) as string;
}

function killTmuxSession(sessionName: string): void {
  try {
    execFileSync(TMUX_BINARY, ["kill-session", "-t", sessionName], {
      stdio: "ignore",
    });
  } catch {
    // ignore cleanup failures
  }
}

function waitForTerminalMarker(
  terminalUrl: string,
  marker: string,
  timeoutMs = 3_000,
): Promise<{ kind: "message"; payload: string }> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(terminalUrl);
    const timeoutId = setTimeout(() => {
      socket.close();
      reject(new Error(`terminal websocket did not receive marker ${marker}`));
    }, timeoutMs);

    const cleanup = () => {
      clearTimeout(timeoutId);
      socket.close();
    };

    socket.addEventListener("message", async (event) => {
      const payload =
        typeof event.data === "string" ? event.data : await event.data.text();

      if (payload.includes(marker)) {
        cleanup();
        resolve({ kind: "message", payload });
      }
    });

    socket.addEventListener("close", (event) => {
      clearTimeout(timeoutId);
      reject(
        new Error(
          `terminal websocket closed before marker: ${event.code} ${event.reason}`,
        ),
      );
    });

    socket.addEventListener("error", () => {
      clearTimeout(timeoutId);
      reject(new Error("terminal websocket connection failed"));
    });
  });
}

test("POST /api/agent-discovery/tmux/add creates a live terminal session for the added tmux card", async () => {
  const { app } = buildServer();
  const sessionName = `tmux-add-live-${Date.now()}`;
  const marker = `TMUX_ADD_LIVE_${Date.now()}`;
  let agentSessionId: string | undefined;

  killTmuxSession(sessionName);

  runTmux([
    "new-session",
    "-d",
    "-s",
    sessionName,
    "-c",
    process.cwd(),
    `sh -lc 'printf "${marker}\\n"; sleep 30'`,
  ]);

  await app.listen({ port: 0, host: "127.0.0.1" });
  const address = app.server.address();

  assert.ok(address && typeof address === "object");

  const baseUrl = `http://127.0.0.1:${address.port}`;
  const terminalUrl = `ws://127.0.0.1:${address.port}`;

  try {
    const response = await fetch(`${baseUrl}/api/agent-discovery/tmux/add`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        tmuxSession: sessionName,
        displayName: sessionName,
        workingDirectory: process.cwd(),
        agentKind: "shell",
        interactionState: "running",
      }),
    });

    assert.equal(response.status, 201);

    const payload = (await response.json()) as { id: string };
    agentSessionId = payload.id;

    const terminalMessage = await waitForTerminalMarker(
      `${terminalUrl}/ws/agent-sessions/${agentSessionId}/terminal`,
      marker,
    );

    assert.match(terminalMessage.payload, new RegExp(marker));
  } finally {
    if (agentSessionId) {
      await fetch(`${baseUrl}/api/agent-sessions/${agentSessionId}`, {
        method: "DELETE",
      }).catch(() => {});
    }

    await app.close();
    killTmuxSession(sessionName);
  }
});

test("POST /api/agent-discovery/tmux/add can attach to a discovered tmux pane without exiting immediately", async () => {
  const { app } = buildServer();
  const sessionName = `tmux-add-pane-${Date.now()}`;
  const marker = `TMUX_ADD_PANE_${Date.now()}`;
  let agentSessionId: string | undefined;

  killTmuxSession(sessionName);

  runTmux([
    "new-session",
    "-d",
    "-s",
    sessionName,
    "-c",
    process.cwd(),
    `sh -lc 'printf "${marker}\\n"; sleep 30'`,
  ]);

  const tmuxPane = firstPaneId(sessionName);

  await app.listen({ port: 0, host: "127.0.0.1" });
  const address = app.server.address();

  assert.ok(address && typeof address === "object");

  const baseUrl = `http://127.0.0.1:${address.port}`;
  const terminalUrl = `ws://127.0.0.1:${address.port}`;

  try {
    const response = await fetch(`${baseUrl}/api/agent-discovery/tmux/add`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        tmuxSession: sessionName,
        tmuxPane,
        displayName: sessionName,
        workingDirectory: process.cwd(),
        agentKind: "copilot",
        interactionState: "running",
      }),
    });

    assert.equal(response.status, 201);

    const payload = (await response.json()) as { id: string };
    agentSessionId = payload.id;

    const terminalMessage = await waitForTerminalMarker(
      `${terminalUrl}/ws/agent-sessions/${agentSessionId}/terminal`,
      marker,
    );

    assert.match(terminalMessage.payload, new RegExp(marker));
  } finally {
    if (agentSessionId) {
      await fetch(`${baseUrl}/api/agent-sessions/${agentSessionId}`, {
        method: "DELETE",
      }).catch(() => {});
    }

    await app.close();
    killTmuxSession(sessionName);
  }
});

test("POST /api/agent-discovery/tmux/add returns a clear error when PTY capacity is exhausted", async () => {
  const originalLaunch = PtyRuntimeManager.prototype.launch;

  PtyRuntimeManager.prototype.launch = function mockedLaunch() {
    throw new Error("posix_openpt failed: Device not configured");
  } as typeof PtyRuntimeManager.prototype.launch;

  const { app } = buildServer();
  const sessionName = `tmux-add-capacity-${Date.now()}`;

  killTmuxSession(sessionName);

  runTmux([
    "new-session",
    "-d",
    "-s",
    sessionName,
    "-c",
    process.cwd(),
    "sh -lc 'sleep 30'",
  ]);

  await app.listen({ port: 0, host: "127.0.0.1" });
  const address = app.server.address();

  assert.ok(address && typeof address === "object");

  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const response = await fetch(`${baseUrl}/api/agent-discovery/tmux/add`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        tmuxSession: sessionName,
        displayName: sessionName,
        workingDirectory: process.cwd(),
        agentKind: "shell",
        interactionState: "running",
      }),
    });

    assert.equal(response.status, 503);

    const payload = (await response.json()) as {
      error?: string;
      message?: string;
    };

    assert.equal(payload.error, "PTY capacity exhausted");
    assert.match(payload.message ?? "", /pty|资源|capacity/i);
  } finally {
    PtyRuntimeManager.prototype.launch = originalLaunch;
    await app.close();
    killTmuxSession(sessionName);
  }
});
