import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { platform } from "node:os";
import { join } from "node:path";

import type { FastifyInstance } from "fastify";

import type {
  AgentSessionRecord,
  LaunchRemoteAgentInput,
  LaunchLocalAgentInput,
  LaunchSshPtyInput,
  FocusAgentSessionInput,
  PtyResizeInput,
  RegisterAgentSessionInput,
  ScanDirectoryInput,
  StdinAgentSessionInput,
  CreateWindowCaptureSessionInput,
  ObserveStateInput,
  UpdateAgentSessionInput,
  DiscoverTmuxInput,
  AddDiscoveredTmuxInput,
} from "@agent-orchestrator/shared";

import { scanAgentDirectory } from "../services/agent-scanner.js";
import { AgentSessionRegistry } from "../services/agent-session-registry.js";
import { LocalProcessRuntimeManager } from "../services/local-process-runtime-manager.js";
import { LocalTmuxAdapter } from "../services/local-tmux-adapter.js";
import {
  ObserveSessionManager,
  TokenMismatchError,
  InvalidTransitionError,
} from "../services/observe-session-manager.js";
import { PtyRuntimeManager } from "../services/pty-runtime-manager.js";
import {
  buildInteractiveShellCommand,
  buildTmuxCommand,
  quoteForPosixShell,
} from "../services/runtime-compat.js";
import { SshRuntimeManager } from "../services/ssh-runtime-manager.js";

function shellQuote(value: string): string {
  return quoteForPosixShell(value);
}

function formatWorkingDirectory(workingDirectory: string): string {
  if (workingDirectory === "~" || workingDirectory === "~/") {
    return "~";
  }

  if (workingDirectory.startsWith("~/")) {
    const suffix = workingDirectory
      .slice(2)
      .split("/")
      .filter(Boolean)
      .map((segment) => shellQuote(segment))
      .join("/");

    return suffix ? `~/${suffix}` : "~";
  }

  return shellQuote(workingDirectory);
}

function buildAgentInvocation(
  agentKind: string,
  displayName: string,
  sessionId?: string,
): string | undefined {
  if (agentKind === "shell") {
    return undefined;
  }

  if (sessionId) {
    return `${agentKind} --resume=${sessionId}`;
  }

  if (agentKind === "claude") {
    return `claude -n ${shellQuote(displayName)}`;
  }

  return agentKind;
}

function buildDirectLaunchCommand(
  agentKind: string,
  workingDirectory: string,
  displayName: string,
  sessionId?: string,
): string {
  const invocation = buildAgentInvocation(agentKind, displayName, sessionId);

  if (!invocation) {
    return "";
  }

  return `cd ${formatWorkingDirectory(workingDirectory)} && ${invocation}`;
}

function buildTmuxLaunchCommand(
  agentKind: string,
  workingDirectory: string,
  displayName: string,
  tmuxSessionName: string,
  sessionId?: string,
): string {
  if (agentKind === "shell") {
    return `tmux new-session -s ${shellQuote(tmuxSessionName)} -c ${formatWorkingDirectory(workingDirectory)}`;
  }

  return `tmux new-session -s ${shellQuote(tmuxSessionName)} ${buildTmuxCommand(buildDirectLaunchCommand(agentKind, workingDirectory, displayName, sessionId), true)}`;
}

function buildTmuxAttachCommand(
  tmuxSessionName: string,
  tmuxPaneId?: string,
): string {
  if (tmuxPaneId) {
    return `tmux select-pane -t ${shellQuote(tmuxPaneId)} && tmux attach -t ${shellQuote(tmuxSessionName)}`;
  }

  return `tmux attach -t ${shellQuote(tmuxSessionName)}`;
}

function buildTmuxReconnectCommand(
  tmuxSessionName: string,
  workingDirectory: string,
): string {
  return `tmux new-session -A -s ${shellQuote(tmuxSessionName)} -c ${formatWorkingDirectory(workingDirectory)}`;
}

function isPtyCapacityError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");

  return /posix_openpt failed|device not configured/i.test(message);
}

interface AgentSessionRoutesOptions {
  registry: AgentSessionRegistry;
  processRuntimeManager: LocalProcessRuntimeManager;
  tmuxAdapter: LocalTmuxAdapter;
  sshRuntimeManager: SshRuntimeManager;
  ptyRuntimeManager: PtyRuntimeManager;
  observeSessionManager: ObserveSessionManager;
}

export async function registerAgentSessionRoutes(
  fastify: FastifyInstance,
  options: AgentSessionRoutesOptions,
): Promise<void> {
  const {
    registry,
    processRuntimeManager,
    tmuxAdapter,
    sshRuntimeManager,
    ptyRuntimeManager,
    observeSessionManager,
  } = options;

  fastify.get("/api/health", async () => ({ status: "ok" }));

  fastify.get("/api/agent-sessions", async () => registry.list());

  fastify.get<{ Params: { id: string } }>(
    "/api/agent-sessions/:id",
    async (request) => {
      const agentSession = registry.get(request.params.id);

      if (agentSession.sourceType === "remote-tmux-discovered") {
        return tmuxAdapter.getDetail(agentSession);
      }

      return registry.getDetail(request.params.id);
    },
  );

  fastify.post<{ Body: RegisterAgentSessionInput }>(
    "/api/agent-sessions/register",
    async (request, reply) => {
      const agentSession = registry.register(request.body);
      reply.code(201);
      return agentSession;
    },
  );

  fastify.post<{ Body: FocusAgentSessionInput }>(
    "/api/agent-sessions/focus",
    async (request) => registry.focus(request.body),
  );

  fastify.patch<{ Params: { id: string }; Body: UpdateAgentSessionInput }>(
    "/api/agent-sessions/:id",
    async (request, reply) => {
      const { displayName, hidden } = request.body ?? {};
      const updates: Partial<AgentSessionRecord> = {};

      if (displayName !== undefined) {
        const trimmed = displayName.trim();
        if (!trimmed) {
          reply.code(400);
          return { error: "displayName cannot be empty" };
        }
        updates.displayName = trimmed;
      }

      if (hidden !== undefined) {
        updates.hidden = Boolean(hidden);
      }

      if (Object.keys(updates).length === 0) {
        reply.code(400);
        return { error: "No valid fields to update" };
      }

      return registry.updateSession(request.params.id, updates);
    },
  );

  fastify.post<{ Body: LaunchLocalAgentInput }>(
    "/api/agent-launch/local",
    async (request, reply) => {
      const agentSession = processRuntimeManager.launch(request.body);
      reply.code(201);
      return agentSession;
    },
  );

  fastify.post<{ Body: LaunchRemoteAgentInput }>(
    "/api/agent-launch/remote",
    async (request, reply) => {
      const agentSession = sshRuntimeManager.launch(request.body);
      reply.code(201);
      return agentSession;
    },
  );

  fastify.post<{ Body: LaunchLocalAgentInput }>(
    "/api/agent-launch/pty",
    async (request, reply) => {
      const agentSession = ptyRuntimeManager.launch(request.body);
      reply.code(201);
      return agentSession;
    },
  );

  fastify.post<{ Body: LaunchSshPtyInput }>(
    "/api/agent-launch/ssh-pty",
    async (request, reply) => {
      const agentSession = ptyRuntimeManager.launchRemote(request.body);
      reply.code(201);
      return agentSession;
    },
  );

  fastify.post<{ Params: { id: string }; Body: PtyResizeInput }>(
    "/api/agent-sessions/:id/resize",
    async (request) => {
      ptyRuntimeManager.resize(
        request.params.id,
        request.body.cols,
        request.body.rows,
      );

      return { ok: true };
    },
  );

  fastify.post<{ Body: DiscoverTmuxInput }>(
    "/api/agent-discovery/tmux/scan",
    async (request) => {
      const { sshTarget } = request.body ?? {};
      if (sshTarget) {
        return tmuxAdapter.discoverRemote(sshTarget);
      }
      return tmuxAdapter.discover();
    },
  );

  fastify.post<{ Body: AddDiscoveredTmuxInput }>(
    "/api/agent-discovery/tmux/add",
    async (request, reply) => {
      const {
        tmuxSession,
        tmuxPane,
        displayName,
        workingDirectory,
        agentKind,
        interactionState,
        outputPreview,
        sshTarget,
      } = request.body;

      const hostId = sshTarget?.host ?? "local";
      const runtimeId = sshTarget
        ? `tmux:${hostId}:${tmuxSession}`
        : `tmux:${tmuxSession}`;

      if (interactionState === "running") {
        const existingSession = registry.findByRuntimeId(runtimeId);

        if (existingSession && ptyRuntimeManager.has(existingSession.id)) {
          reply.code(201);
          return existingSession;
        }

        if (existingSession) {
          registry.remove(existingSession.id);
        }

        try {
          const attachedSession = sshTarget
            ? ptyRuntimeManager.launchRemote({
                workspaceId: tmuxSession,
                displayName,
                agentKind,
                sshTarget,
                remoteCommand: buildInteractiveShellCommand(
                  buildTmuxAttachCommand(tmuxSession, tmuxPane),
                ),
                workingDirectory,
                tmuxSessionName: tmuxSession,
                tmuxPaneId: tmuxPane,
              })
            : ptyRuntimeManager.launch({
                workspaceId: tmuxSession,
                hostId,
                displayName,
                agentKind,
                command: buildTmuxAttachCommand(tmuxSession, tmuxPane),
                workingDirectory,
                tmuxSessionName: tmuxSession,
                tmuxPaneId: tmuxPane,
              });

          reply.code(201);
          return attachedSession;
        } catch (error) {
          if (!isPtyCapacityError(error)) {
            throw error;
          }

          reply.code(503);
          return {
            error: "PTY capacity exhausted",
            message:
              "PTY 资源已耗尽，无法再附加更多交互式 tmux 会话。请先关闭部分运行中的终端后重试。",
          };
        }
      }

      const agentSession = registry.upsertByTransportRef(runtimeId, {
        workspaceId: tmuxSession,
        hostId,
        sourceType: "remote-tmux-discovered",
        agentKind,
        displayName,
        workingDirectory,
        connectionState: "online",
        interactionState: interactionState ?? "detached",
        stateConfidence: "medium",
        outputPreview,
        controlMode: "observe",
        transportRef: {
          tmuxSession,
          ...(tmuxPane ? { tmuxPane } : {}),
          runtimeId,
          ...(sshTarget && {
            sshHost: sshTarget.host,
            sshPort: sshTarget.port,
            sshUsername: sshTarget.username,
          }),
        },
        ...(sshTarget && { sshTarget }),
      });

      reply.code(201);
      return agentSession;
    },
  );

  fastify.post<{ Params: { id: string } }>(
    "/api/agent-sessions/:id/tmux/kill",
    async (request, reply) => {
      const { id } = request.params;
      const session = registry.get(id);
      const tmuxSessionName = session.transportRef?.tmuxSession;
      if (!tmuxSessionName) {
        reply.code(400);
        return { error: "Session has no tmux session reference" };
      }
      ptyRuntimeManager.kill(id);
      await tmuxAdapter.killSession(tmuxSessionName, session.sshTarget);
      registry.remove(id);
      reply.code(204);
    },
  );

  fastify.post<{ Params: { id: string } }>(
    "/api/agent-sessions/:id/tmux/takeover",
    async (request) => {
      const agentSession = registry.get(request.params.id);
      return tmuxAdapter.takeOver(agentSession);
    },
  );

  fastify.post<{ Params: { id: string } }>(
    "/api/agent-sessions/:id/tmux/release",
    async (request) => {
      const agentSession = registry.get(request.params.id);
      return tmuxAdapter.release(agentSession);
    },
  );

  fastify.post<{ Params: { id: string } }>(
    "/api/agent-sessions/:id/tmux/refresh",
    async (request) => {
      const agentSession = registry.get(request.params.id);
      return tmuxAdapter.refresh(agentSession);
    },
  );

  fastify.post<{ Params: { id: string }; Body: StdinAgentSessionInput }>(
    "/api/agent-sessions/:id/stdin",
    async (request) => {
      const agentSession = registry.get(request.params.id);

      if (agentSession.sourceType === "remote-tmux-discovered") {
        return tmuxAdapter.writeInput(agentSession, request.body);
      }

      if (
        agentSession.sourceType === "remote-connect" &&
        agentSession.transportRef?.runtimeId?.startsWith("ssh:")
      ) {
        return sshRuntimeManager.writeInput(request.params.id, request.body);
      }

      if (ptyRuntimeManager.has(request.params.id)) {
        ptyRuntimeManager.write(request.params.id, request.body.input);
        return registry.get(request.params.id);
      }

      return processRuntimeManager.writeInput(request.params.id, request.body);
    },
  );

  fastify.post<{ Body: ScanDirectoryInput }>(
    "/api/agent-discovery/scan",
    async (request) => scanAgentDirectory(request.body),
  );

  fastify.post<{ Body: CreateWindowCaptureSessionInput }>(
    "/api/agent-sessions/window-capture",
    async (request, reply) => {
      const result = observeSessionManager.createSession(request.body ?? {});
      reply.code(201);
      return result;
    },
  );

  fastify.post<{ Params: { id: string }; Body: ObserveStateInput }>(
    "/api/agent-sessions/:id/observe-state",
    async (request, reply) => {
      try {
        const updated = observeSessionManager.processObserveState(
          request.params.id,
          request.body,
        );
        return updated;
      } catch (err) {
        if (err instanceof TokenMismatchError) {
          reply.code(403);
          return { error: err.message };
        }
        if (err instanceof InvalidTransitionError) {
          reply.code(400);
          return { error: err.message };
        }
        throw err;
      }
    },
  );

  fastify.post<{ Params: { id: string } }>(
    "/api/agent-sessions/:id/focus-window",
    async (request, reply) => {
      const session = registry.get(request.params.id);
      if (session.sourceType !== "local-window-capture") {
        reply.code(400);
        return { error: "Only window-capture sessions support focus" };
      }

      if (platform() !== "darwin") {
        reply.code(501);
        return { error: "Window focus is only supported on macOS" };
      }

      const windowTitle =
        session.windowCaptureMeta?.rawLabel?.trim() || session.displayName;
      const safeTitle = windowTitle.replace(/\\/g, "\\\\").replace(/"/g, '\\"');

      // Strategy 1: AppleScript with Accessibility — most precise.
      // Finds the exact window by title, raises it, moves mouse to center.
      const accessibilityScript = `
tell application "System Events"
  set allProcs to every process whose name is "Code" or name is "Electron" or name contains "Visual Studio Code"
  repeat with proc in allProcs
    try
      set allWins to every window of proc
      repeat with win in allWins
        try
          if title of win contains "${safeTitle}" then
            perform action "AXRaise" of win
            set frontmost of proc to true
            set winPos to position of win
            set winSize to size of win
            set cx to (item 1 of winPos) + ((item 1 of winSize) / 2)
            set cy to (item 2 of winPos) + ((item 2 of winSize) / 2)
            set cxInt to cx as integer
            set cyInt to cy as integer
            do shell script "python3 -c 'import Quartz; Quartz.CGEventPost(Quartz.kCGHIDEventTap, Quartz.CGEventCreateMouseEvent(None, Quartz.kCGEventMouseMoved, (" & cxInt & ", " & cyInt & "), Quartz.kCGMouseButtonLeft))'"
            return "focused"
          end if
        end try
      end repeat
    end try
  end repeat
end tell
return "not_found"
`;

      const axResult = await new Promise<string>((resolve) => {
        execFile(
          "osascript",
          ["-e", accessibilityScript],
          { timeout: 8000 },
          (_err, stdout) => resolve(stdout?.trim() ?? "error"),
        );
      });

      if (axResult === "focused") {
        return { ok: true, method: "focused" };
      }

      // Strategy 2: Use `code` CLI to open the folder by name.
      // Window title from getDisplayMedia is typically
      // "folder_name — Visual Studio Code" or just "folder_name".
      const folderName = windowTitle
        .replace(/\s*[—–-]\s*Visual Studio Code.*$/i, "")
        .replace(/\s*\[.*?\]\s*$/, "")
        .trim();

      const home = homedir();
      const candidates = [
        join(home, folderName),
        join(home, "Documents", folderName),
        join(home, "Projects", folderName),
        join(home, "Documents", "Codes", folderName),
        join(home, "Documents", "Codes", "VibeCoding", folderName),
        join(home, "Desktop", folderName),
        join(home, "code", folderName),
        join(home, "src", folderName),
        join(home, "dev", folderName),
      ];

      const codePath =
        "/Applications/Visual Studio Code.app" +
        "/Contents/Resources/app/bin/code";

      for (const candidate of candidates) {
        if (existsSync(candidate)) {
          await new Promise<void>((resolve) => {
            execFile(codePath, ["-r", candidate], { timeout: 5000 }, () =>
              resolve(),
            );
          });
          return { ok: true, method: "code-cli", path: candidate };
        }
      }

      // Strategy 3: Simple fallback — just activate VS Code
      await new Promise<void>((resolve) => {
        execFile(
          "osascript",
          ["-e", 'tell application "Code" to activate'],
          { timeout: 5000 },
          () => resolve(),
        );
      });

      return { ok: true, method: "activated" };
    },
  );

  fastify.delete<{ Params: { id: string } }>(
    "/api/agent-sessions/:id",
    async (request, reply) => {
      const { id } = request.params;
      const session = registry.get(id);

      if (observeSessionManager.isRunningCapture(id)) {
        observeSessionManager.stopCapture(id);
      }

      if (
        session.sourceType === "remote-tmux-discovered" &&
        session.controlMode === "control"
      ) {
        await tmuxAdapter.release(session);
      }

      ptyRuntimeManager.kill(id);
      registry.remove(id);
      reply.code(204);
    },
  );

  fastify.post<{ Params: { id: string } }>(
    "/api/agent-sessions/:id/reconnect",
    async (request) => {
      const session = registry.get(request.params.id);
      if (session.sshTarget && session.transportRef?.tmuxSession) {
        return ptyRuntimeManager.reconnectRemote(request.params.id, {
          workspaceId: session.workspaceId,
          displayName: session.displayName,
          agentKind: session.agentKind,
          sshTarget: session.sshTarget,
          remoteCommand: buildInteractiveShellCommand(
            buildTmuxReconnectCommand(
              session.transportRef.tmuxSession,
              session.workingDirectory ?? "~",
            ),
          ),
          workingDirectory: session.workingDirectory,
          tmuxSessionName: session.transportRef.tmuxSession,
          tmuxPaneId: session.transportRef.tmuxPane,
        });
      }

      if (session.sshTarget && session.remoteCommand) {
        return ptyRuntimeManager.reconnectRemote(request.params.id, {
          workspaceId: session.workspaceId,
          displayName: session.displayName,
          agentKind: session.agentKind,
          sshTarget: session.sshTarget,
          remoteCommand: session.remoteCommand,
          workingDirectory: session.workingDirectory,
          tmuxSessionName: session.transportRef?.tmuxSession,
          tmuxPaneId: session.transportRef?.tmuxPane,
        });
      }
      const cmd = session.transportRef?.tmuxSession
        ? buildTmuxReconnectCommand(
            session.transportRef.tmuxSession,
            session.workingDirectory ?? "~",
          )
        : session.agentSessionId
          ? buildDirectLaunchCommand(
              session.agentKind,
              session.workingDirectory ?? "~",
              session.displayName,
              session.agentSessionId,
            )
          : buildDirectLaunchCommand(
              session.agentKind,
              session.workingDirectory ?? "~",
              session.displayName,
            );
      return ptyRuntimeManager.reconnectLocal(request.params.id, {
        workspaceId: session.workspaceId,
        displayName: session.displayName,
        agentKind: session.agentKind,
        command: cmd,
        workingDirectory: session.workingDirectory,
        tmuxSessionName: session.transportRef?.tmuxSession,
        tmuxPaneId: session.transportRef?.tmuxPane,
      });
    },
  );
}
