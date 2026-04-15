import * as pty from "node-pty";
import { devNull } from "node:os";

import type {
  AgentSessionRecord,
  LaunchLocalAgentInput,
  LaunchSshPtyInput,
} from "@agent-orchestrator/shared";

import { AgentSessionRegistry } from "./agent-session-registry.js";
import { resolveCopilotBinary } from "./copilot-binary.js";
import { resolveLocalWorkingDirectory } from "./resolve-local-working-directory.js";
import { resolvePreferredShell } from "./runtime-compat.js";
import { buildSshArgs, formatSshDestination } from "./ssh-command.js";
import { sanitizeReplayForTerminal } from "./terminal-control-filter.js";

type PtyDataListener = (data: string) => void;

const MAX_SCROLLBACK_BYTES = 256 * 1024; // 256 KB replay buffer
const SSH_TMUX_RESIZE_SIGNAL_RETRY_MS = [120, 360, 1000];
interface PtyHandle {
  ptyProcess: pty.IPty;
  dataListeners: Set<PtyDataListener>;
  scrollback: string[];
  scrollbackBytes: number;
}
export { sanitizeReplayForTerminal } from "./terminal-control-filter.js";

interface LocalPtySpawnPlan {
  file: string;
  args: string[];
  env: Record<string, string>;
  sendInitialCommand: boolean;
}

function buildPtyEnv(agentKind?: string): Record<string, string> {
  const env = { ...(process.env as Record<string, string | undefined>) };

  for (const key of Object.keys(env)) {
    if (/^npm_config_/i.test(key)) {
      delete env[key];
    }
  }

  // Prevent "sessions should be nested with care" error when the server
  // itself runs inside a tmux session and a PTY tries to run `tmux attach`.
  delete env.TMUX;
  delete env.TMUX_PANE;

  if (agentKind === "copilot") {
    env.NPM_CONFIG_USERCONFIG = devNull;
    env.NPM_CONFIG_GLOBALCONFIG = devNull;
    env.npm_config_userconfig = devNull;
    env.npm_config_globalconfig = devNull;
  }

  return Object.fromEntries(
    Object.entries(env).filter(([, value]) => value !== undefined),
  ) as Record<string, string>;
}

function parseDirectCopilotArgs(command: string): string[] | null {
  const match = command
    .trim()
    .match(/^(?:cd\s+.+\s+&&\s+)?copilot(?:\s+(--resume=\S+))?$/);

  if (!match) {
    return null;
  }

  return match[1] ? [match[1]] : [];
}

function buildLocalSpawnPlan(
  shell: string,
  input: LaunchLocalAgentInput,
): LocalPtySpawnPlan {
  if (
    input.agentKind === "copilot" &&
    !input.tmuxSessionName &&
    input.command
  ) {
    const directArgs = parseDirectCopilotArgs(input.command);
    if (directArgs) {
      return {
        file: resolveCopilotBinary() ?? "copilot",
        args: directArgs,
        env: buildPtyEnv("copilot"),
        sendInitialCommand: false,
      };
    }
  }

  return {
    file: shell,
    args: [],
    env: buildPtyEnv(),
    sendInitialCommand: true,
  };
}

function dispatchSigwinch(pid: number): void {
  try {
    process.kill(pid, "SIGWINCH");
  } catch {
    /* ignore processes that have already exited */
  }
}

export class PtyRuntimeManager {
  private readonly handles = new Map<string, PtyHandle>();
  private readonly resizeRetryTimers = new Map<string, NodeJS.Timeout[]>();

  constructor(private readonly registry: AgentSessionRegistry) {}

  private clearResizeRetryTimers(agentSessionId: string): void {
    const timers = this.resizeRetryTimers.get(agentSessionId);
    if (!timers) {
      return;
    }

    for (const timer of timers) {
      clearTimeout(timer);
    }

    this.resizeRetryTimers.delete(agentSessionId);
  }

  launch(input: LaunchLocalAgentInput): AgentSessionRecord {
    const shell = resolvePreferredShell();
    const resolvedWorkingDirectory = resolveLocalWorkingDirectory(
      input.workingDirectory,
    );
    const spawnPlan = buildLocalSpawnPlan(shell, input);

    const ptyProcess = pty.spawn(spawnPlan.file, spawnPlan.args, {
      name: "xterm-256color",
      cols: 120,
      rows: 30,
      cwd: resolvedWorkingDirectory,
      env: spawnPlan.env,
    });

    const agentSession = this.registry.register({
      workspaceId: input.workspaceId,
      hostId: input.hostId ?? "local",
      sourceType: "local",
      agentKind: input.agentKind,
      displayName: input.displayName,
      workingDirectory: resolvedWorkingDirectory,
      connectionState: "online",
      interactionState: "running",
      stateConfidence: "medium",
      outputPreview: `启动中: ${input.command}`,
      controlMode: "control",
      transportRef: {
        processId: ptyProcess.pid,
        tmuxSession: input.tmuxSessionName,
        tmuxPane: input.tmuxPaneId,
        runtimeId: `pty:${ptyProcess.pid}`,
      },
    });

    const handle: PtyHandle = {
      ptyProcess,
      dataListeners: new Set(),
      scrollback: [],
      scrollbackBytes: 0,
    };

    this.handles.set(agentSession.id, handle);

    ptyProcess.onData((data: string) => {
      if (!this.registry.has(agentSession.id)) {
        return;
      }

      this.appendScrollback(handle, data);

      for (const listener of handle.dataListeners) {
        listener(data);
      }

      this.registry.appendOutput(agentSession.id, data, "stdout");
    });

    ptyProcess.onExit(({ exitCode }) => {
      this.clearResizeRetryTimers(agentSession.id);
      this.handles.delete(agentSession.id);

      if (!this.registry.has(agentSession.id)) {
        return;
      }

      this.registry.markExited(agentSession.id, exitCode, null);
    });

    // Send initial command if provided
    if (spawnPlan.sendInitialCommand && input.command) {
      ptyProcess.write(input.command + "\n");
    }

    return this.registry.get(agentSession.id);
  }

  launchRemote(input: LaunchSshPtyInput): AgentSessionRecord {
    const args = buildSshArgs(input.sshTarget, {
      requestTty: true,
      remoteCommand: input.remoteCommand,
    });
    const userHost = formatSshDestination(input.sshTarget);

    const ptyProcess = pty.spawn("ssh", args, {
      name: "xterm-256color",
      cols: 120,
      rows: 30,
      cwd: process.env.HOME ?? process.cwd(),
      env: buildPtyEnv(),
    });

    const agentSession = this.registry.register({
      workspaceId: input.workspaceId,
      hostId: input.sshTarget.host,
      sourceType: "remote-connect",
      agentKind: input.agentKind,
      displayName: input.displayName,
      workingDirectory: input.workingDirectory,
      connectionState: "online",
      interactionState: "running",
      stateConfidence: "medium",
      outputPreview: `SSH → ${userHost}: ${input.remoteCommand}`,
      controlMode: "control",
      transportRef: {
        processId: ptyProcess.pid,
        tmuxSession: input.tmuxSessionName,
        tmuxPane: input.tmuxPaneId,
        runtimeId: `ssh-pty:${ptyProcess.pid}`,
        sshHost: input.sshTarget.host,
        sshPort: input.sshTarget.port,
        sshUsername: input.sshTarget.username,
      },
      agentSessionId: input.agentSessionId,
      sshTarget: input.sshTarget,
      remoteCommand: input.remoteCommand,
    });

    const handle: PtyHandle = {
      ptyProcess,
      dataListeners: new Set(),
      scrollback: [],
      scrollbackBytes: 0,
    };

    this.handles.set(agentSession.id, handle);

    ptyProcess.onData((data: string) => {
      if (!this.registry.has(agentSession.id)) {
        return;
      }

      this.appendScrollback(handle, data);

      for (const listener of handle.dataListeners) {
        listener(data);
      }

      this.registry.appendOutput(agentSession.id, data, "stdout");
    });

    ptyProcess.onExit(({ exitCode }) => {
      this.handles.delete(agentSession.id);

      if (!this.registry.has(agentSession.id)) {
        return;
      }

      this.registry.markExited(agentSession.id, exitCode, null);
    });

    return this.registry.get(agentSession.id);
  }

  write(agentSessionId: string, data: string): void {
    const handle = this.handles.get(agentSessionId);

    if (!handle) {
      throw new Error(`没有找到 PTY 运行时: ${agentSessionId}`);
    }

    this.registry.noteUserInput(agentSessionId, data);
    handle.ptyProcess.write(data);
  }

  resize(agentSessionId: string, cols: number, rows: number): void {
    const handle = this.handles.get(agentSessionId);

    if (!handle) {
      return;
    }

    handle.ptyProcess.resize(cols, rows);

    // Some interactive programs, especially ssh -> tmux, only propagate the
    // new window size after the foreground process receives SIGWINCH. On
    // slower remote hosts, the initial signal can arrive before tmux has fully
    // attached, so we retry a few times to help the remote client adopt the
    // fitted browser geometry.
    dispatchSigwinch(handle.ptyProcess.pid);

    const session = this.registry.get(agentSessionId);
    const needsRetry =
      Boolean(session.transportRef?.tmuxSession) ||
      session.transportRef?.runtimeId?.startsWith("ssh-pty:") === true;

    if (!needsRetry) {
      return;
    }

    this.clearResizeRetryTimers(agentSessionId);
    const timers: NodeJS.Timeout[] = [];

    for (const delay of SSH_TMUX_RESIZE_SIGNAL_RETRY_MS) {
      const timer = setTimeout(() => {
        dispatchSigwinch(handle.ptyProcess.pid);
      }, delay);
      timer.unref?.();
      timers.push(timer);
    }

    this.resizeRetryTimers.set(agentSessionId, timers);
  }

  getScrollback(agentSessionId: string): string {
    const handle = this.handles.get(agentSessionId);

    if (!handle) {
      throw new Error(`没有找到 PTY 运行时: ${agentSessionId}`);
    }

    return handle.scrollback.join("");
  }

  subscribe(
    agentSessionId: string,
    listener: PtyDataListener,
    options?: { replay?: boolean },
  ): () => void {
    const handle = this.handles.get(agentSessionId);

    if (!handle) {
      throw new Error(`没有找到 PTY 运行时: ${agentSessionId}`);
    }

    // Replay scrollback buffer to the new subscriber
    if (options?.replay !== false && handle.scrollback.length > 0) {
      const replay = sanitizeReplayForTerminal(handle.scrollback.join(""));
      if (replay) {
        listener(replay);
      }
    }

    handle.dataListeners.add(listener);

    return () => {
      handle.dataListeners.delete(listener);
    };
  }

  has(agentSessionId: string): boolean {
    return this.handles.has(agentSessionId);
  }

  kill(agentSessionId: string): void {
    this.clearResizeRetryTimers(agentSessionId);
    const handle = this.handles.get(agentSessionId);
    if (handle) {
      handle.ptyProcess.kill();
      this.handles.delete(agentSessionId);
    }
  }

  reconnectRemote(
    agentSessionId: string,
    input: LaunchSshPtyInput,
  ): AgentSessionRecord {
    this.kill(agentSessionId);

    const args = buildSshArgs(input.sshTarget, {
      requestTty: true,
      remoteCommand: input.remoteCommand,
    });
    const userHost = formatSshDestination(input.sshTarget);

    const ptyProcess = pty.spawn("ssh", args, {
      name: "xterm-256color",
      cols: 120,
      rows: 30,
      cwd: process.env.HOME ?? process.cwd(),
      env: buildPtyEnv(),
    });

    const handle: PtyHandle = {
      ptyProcess,
      dataListeners: new Set(),
      scrollback: [],
      scrollbackBytes: 0,
    };
    this.handles.set(agentSessionId, handle);

    this.registry.updateSession(agentSessionId, {
      connectionState: "online",
      interactionState: "running",
      stateConfidence: "medium",
      outputPreview: `重新连接中: SSH → ${userHost}`,
      transportRef: {
        processId: ptyProcess.pid,
        tmuxSession: input.tmuxSessionName,
        tmuxPane: input.tmuxPaneId,
        runtimeId: `ssh-pty:${ptyProcess.pid}`,
        sshHost: input.sshTarget.host,
        sshPort: input.sshTarget.port,
        sshUsername: input.sshTarget.username,
      },
    });

    ptyProcess.onData((data: string) => {
      if (!this.registry.has(agentSessionId)) {
        return;
      }

      this.appendScrollback(handle, data);
      for (const listener of handle.dataListeners) {
        listener(data);
      }
      this.registry.appendOutput(agentSessionId, data, "stdout");
    });

    ptyProcess.onExit(({ exitCode }) => {
      this.clearResizeRetryTimers(agentSessionId);
      this.handles.delete(agentSessionId);

      if (!this.registry.has(agentSessionId)) {
        return;
      }

      this.registry.markExited(agentSessionId, exitCode, null);
    });

    return this.registry.get(agentSessionId);
  }

  reconnectLocal(
    agentSessionId: string,
    input: LaunchLocalAgentInput,
  ): AgentSessionRecord {
    this.kill(agentSessionId);

    const shell = resolvePreferredShell();
    const resolvedWorkingDirectory = resolveLocalWorkingDirectory(
      input.workingDirectory,
    );
    const spawnPlan = buildLocalSpawnPlan(shell, input);
    const ptyProcess = pty.spawn(spawnPlan.file, spawnPlan.args, {
      name: "xterm-256color",
      cols: 120,
      rows: 30,
      cwd: resolvedWorkingDirectory,
      env: spawnPlan.env,
    });

    const handle: PtyHandle = {
      ptyProcess,
      dataListeners: new Set(),
      scrollback: [],
      scrollbackBytes: 0,
    };
    this.handles.set(agentSessionId, handle);

    this.registry.updateSession(agentSessionId, {
      connectionState: "online",
      interactionState: "running",
      stateConfidence: "medium",
      outputPreview: `重新连接中: ${input.command}`,
      workingDirectory: resolvedWorkingDirectory,
      transportRef: {
        processId: ptyProcess.pid,
        tmuxSession: input.tmuxSessionName,
        tmuxPane: input.tmuxPaneId,
        runtimeId: `pty:${ptyProcess.pid}`,
      },
    });

    ptyProcess.onData((data: string) => {
      if (!this.registry.has(agentSessionId)) {
        return;
      }

      this.appendScrollback(handle, data);
      for (const listener of handle.dataListeners) {
        listener(data);
      }
      this.registry.appendOutput(agentSessionId, data, "stdout");
    });

    ptyProcess.onExit(({ exitCode }) => {
      this.clearResizeRetryTimers(agentSessionId);
      this.handles.delete(agentSessionId);

      if (!this.registry.has(agentSessionId)) {
        return;
      }

      this.registry.markExited(agentSessionId, exitCode, null);
    });

    if (spawnPlan.sendInitialCommand && input.command) {
      ptyProcess.write(input.command + "\n");
    }

    return this.registry.get(agentSessionId);
  }

  private appendScrollback(handle: PtyHandle, data: string): void {
    handle.scrollback.push(data);
    handle.scrollbackBytes += data.length;

    while (
      handle.scrollbackBytes > MAX_SCROLLBACK_BYTES &&
      handle.scrollback.length > 1
    ) {
      const removed = handle.scrollback.shift()!;
      handle.scrollbackBytes -= removed.length;
    }
  }
}
