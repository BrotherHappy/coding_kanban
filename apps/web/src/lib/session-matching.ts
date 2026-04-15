import type {
  AgentSessionRecord,
  ScanResult,
} from "@agent-orchestrator/shared";

import { buildRemoteInteractiveShellCommand } from "./platform-compat";

export type LaunchMode = "direct" | "tmux";

const kindPriority: Record<string, number> = {
  copilot: 0,
  codex: 1,
  claude: 2,
  shell: 3,
};

export function sortScanResults(results: ScanResult[]): ScanResult[] {
  return [...results].sort((a, b) => {
    // Only sort by displayName (宫格名)
    return a.displayName.localeCompare(b.displayName);
  });
}

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function buildTmuxPaneBorderNormalizationCommand(
  tmuxSessionName: string,
): string {
  const quotedSessionName = shellQuote(tmuxSessionName);
  return `tmux set-window-option -t ${quotedSessionName} pane-border-style "fg=#4b5563" && tmux set-window-option -t ${quotedSessionName} pane-active-border-style "fg=#4b5563"`;
}

export function formatWorkingDirectory(workingDirectory: string): string {
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

export function buildDirectLaunchCommand(
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

export function buildTmuxLaunchCommand(
  agentKind: string,
  workingDirectory: string,
  displayName: string,
  tmuxSessionName: string,
  sessionId?: string,
): string {
  if (agentKind === "shell") {
    return `tmux new-session -s ${shellQuote(tmuxSessionName)} -c ${formatWorkingDirectory(workingDirectory)}`;
  }

  return `tmux new-session -s ${shellQuote(tmuxSessionName)} ${shellQuote(buildDirectLaunchCommand(agentKind, workingDirectory, displayName, sessionId))}`;
}

export function buildRemoteDirectLaunchCommand(
  agentKind: string,
  workingDirectory: string,
  displayName: string,
  sessionId?: string,
): string {
  if (agentKind === "shell") {
    return `cd ${formatWorkingDirectory(workingDirectory)} && exec "\${SHELL:-\$(command -v bash || command -v zsh || command -v sh || printf /bin/sh)}" -i`;
  }

  return buildDirectLaunchCommand(
    agentKind,
    workingDirectory,
    displayName,
    sessionId,
  );
}

export function buildTmuxAttachCommand(
  tmuxSessionName: string,
  tmuxPaneId?: string,
): string {
  const normalizePaneBorder =
    buildTmuxPaneBorderNormalizationCommand(tmuxSessionName);

  if (tmuxPaneId) {
    return `${normalizePaneBorder} && tmux select-pane -t ${shellQuote(tmuxPaneId)} && tmux attach -t ${shellQuote(tmuxSessionName)}`;
  }

  return `${normalizePaneBorder} && tmux attach -t ${shellQuote(tmuxSessionName)}`;
}

export function wrapRemoteInteractiveCommand(command: string): string {
  return buildRemoteInteractiveShellCommand(command);
}

export function findExistingSession(
  result: ScanResult,
  sessions: AgentSessionRecord[],
): AgentSessionRecord | undefined {
  if (result.sessionId) {
    return sessions.find((s) => s.agentSessionId === result.sessionId);
  }
  if (result.tmuxSession) {
    const hostId = result.sshTarget?.host ?? "local";
    return sessions.find(
      (s) =>
        (s.hostId ?? "local") === hostId &&
        s.transportRef?.tmuxSession === result.tmuxSession,
    );
  }
  const hostId = result.sshTarget?.host ?? "local";
  return sessions.find(
    (s) =>
      (s.hostId ?? "local") === hostId &&
      s.workingDirectory === result.workingDirectory &&
      s.agentKind === result.agentKind,
  );
}
