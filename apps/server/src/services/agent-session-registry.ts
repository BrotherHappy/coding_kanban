import { randomUUID } from "node:crypto";

import {
  type AgentOutputEntry,
  type AgentOutputStream,
  type AgentSessionRecord,
  type AgentSessionDetailResponse,
  type FocusAgentSessionInput,
  type ListAgentSessionsResponse,
  type RegisterAgentSessionInput,
  type StdinAgentSessionInput,
} from "@agent-orchestrator/shared";

type SnapshotListener = (snapshot: ListAgentSessionsResponse) => void;

const MAX_OUTPUT_ENTRIES = 200;
const DEFAULT_AWAITING_INPUT_IDLE_MS = 10_000;
const MAX_INFERENCE_WINDOW_CHARS = 4096;

const ANSI_ESCAPE_PATTERN =
  /\u001B\][^\u0007]*(?:\u0007|\u001B\\)|\u001B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;

function pickOutputPreview(text: string): string | undefined {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  return lines.at(-1)?.slice(0, 160);
}

function normalizeTerminalText(text: string): string {
  return text
    .replace(ANSI_ESCAPE_PATTERN, "")
    .replace(/\u0007/g, "")
    .replace(/\r/g, "\n")
    .replace(/[\t\f\v ]+/g, " ")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

function mergeScreenWindow(previous: string, incoming: string): string {
  const normalizedIncoming = normalizeTerminalText(incoming);

  if (!normalizedIncoming) {
    return previous;
  }

  if (
    previous === normalizedIncoming ||
    previous.endsWith(normalizedIncoming) ||
    previous.endsWith(`\n${normalizedIncoming}`)
  ) {
    return previous;
  }

  const merged = previous
    ? `${previous}\n${normalizedIncoming}`
    : normalizedIncoming;

  return merged.slice(-MAX_INFERENCE_WINDOW_CHARS);
}

function byInteractionState(
  left: AgentSessionRecord,
  right: AgentSessionRecord,
  getSessionOrder: (agentSessionId: string) => number,
): number {
  // Only sort by displayName (宫格名)
  return left.displayName.localeCompare(right.displayName);
}

export class AgentSessionRegistry {
  private readonly sessions = new Map<string, AgentSessionRecord>();
  private readonly outputEntries = new Map<string, AgentOutputEntry[]>();
  private readonly screenWindows = new Map<string, string>();
  private readonly lastScreenChangedAt = new Map<string, number>();
  private readonly sessionOrder = new Map<string, number>();
  private readonly awaitingInputTimers = new Map<string, NodeJS.Timeout>();
  private readonly listeners = new Set<SnapshotListener>();
  private activeAgentSessionId: string | null = null;
  private nextSessionOrder = 0;

  constructor(
    private readonly awaitingInputIdleMs = DEFAULT_AWAITING_INPUT_IDLE_MS,
  ) {}

  list(): ListAgentSessionsResponse {
    return {
      items: [...this.sessions.values()].sort((left, right) =>
        byInteractionState(left, right, this.getSessionOrder),
      ),
      activeAgentSessionId: this.activeAgentSessionId,
      updatedAt: new Date().toISOString(),
    };
  }

  subscribe(listener: SnapshotListener): () => void {
    this.listeners.add(listener);
    listener(this.list());

    return () => {
      this.listeners.delete(listener);
    };
  }

  get(agentSessionId: string): AgentSessionRecord {
    const agentSession = this.sessions.get(agentSessionId);

    if (!agentSession) {
      throw new Error(`Unknown agent session: ${agentSessionId}`);
    }

    return agentSession;
  }

  has(agentSessionId: string): boolean {
    return this.sessions.has(agentSessionId);
  }

  getDetail(agentSessionId: string): AgentSessionDetailResponse {
    return {
      agentSession: this.get(agentSessionId),
      outputEntries: this.outputEntries.get(agentSessionId) ?? [],
    };
  }

  register(input: RegisterAgentSessionInput): AgentSessionRecord {
    const now = new Date().toISOString();

    const agentSession: AgentSessionRecord = {
      id: randomUUID(),
      workspaceId: input.workspaceId,
      hostId: input.hostId,
      sourceType: input.sourceType,
      agentKind: input.agentKind,
      displayName: input.displayName,
      workingDirectory: input.workingDirectory,
      connectionState: input.connectionState ?? "online",
      interactionState: input.interactionState ?? "idle",
      stateConfidence: input.stateConfidence,
      outputPreview: input.outputPreview,
      controlMode: input.controlMode,
      lastHeartbeatAt: now,
      lastOutputAt: input.outputPreview ? now : undefined,
      transportRef: input.transportRef,
      agentSessionId: input.agentSessionId,
      sshTarget: input.sshTarget,
      remoteCommand: input.remoteCommand,
      windowCaptureMeta: input.windowCaptureMeta,
    };

    this.sessions.set(agentSession.id, agentSession);
    this.outputEntries.set(agentSession.id, []);
    this.screenWindows.set(agentSession.id, "");
    this.lastScreenChangedAt.set(agentSession.id, Date.now());
    this.sessionOrder.set(agentSession.id, this.nextSessionOrder);
    this.nextSessionOrder += 1;

    if (this.shouldUseTimedAwaitingInput(agentSession)) {
      this.refreshAwaitingInputTimer(agentSession.id);
    }

    if (!this.activeAgentSessionId) {
      this.activeAgentSessionId = agentSession.id;
    }

    this.emitSnapshot();

    return agentSession;
  }

  findByRuntimeId(runtimeId: string): AgentSessionRecord | undefined {
    return [...this.sessions.values()].find(
      ({ transportRef }) => transportRef?.runtimeId === runtimeId,
    );
  }

  upsertByTransportRef(
    runtimeId: string,
    input: RegisterAgentSessionInput,
  ): AgentSessionRecord {
    const existingSession = [...this.sessions.values()].find(
      ({ transportRef }) => transportRef?.runtimeId === runtimeId,
    );

    if (!existingSession) {
      return this.register(input);
    }

    const nextSession: AgentSessionRecord = {
      ...existingSession,
      ...input,
      id: existingSession.id,
      controlMode: input.controlMode ?? existingSession.controlMode,
      transportRef: {
        ...existingSession.transportRef,
        ...input.transportRef,
      },
      lastHeartbeatAt: new Date().toISOString(),
    };

    this.sessions.set(existingSession.id, nextSession);
    this.emitSnapshot();

    return nextSession;
  }

  focus(input: FocusAgentSessionInput): ListAgentSessionsResponse {
    if (!this.sessions.has(input.agentSessionId)) {
      throw new Error(`Unknown agent session: ${input.agentSessionId}`);
    }

    this.activeAgentSessionId = input.agentSessionId;
    this.emitSnapshot();

    return this.list();
  }

  writeToSession(
    agentSessionId: string,
    input: StdinAgentSessionInput,
  ): AgentSessionRecord {
    this.noteUserInput(agentSessionId, input.input);

    const agentSession = this.get(agentSessionId);

    const now = new Date().toISOString();
    const nextSession: AgentSessionRecord = {
      ...agentSession,
      lastHeartbeatAt: now,
      interactionState:
        agentSession.interactionState === "awaiting_input"
          ? "running"
          : agentSession.interactionState,
      outputPreview: input.input.trim()
        ? `Last input: ${input.input.trim()}`
        : agentSession.outputPreview,
    };

    this.sessions.set(agentSessionId, nextSession);
    this.pushOutputEntry(agentSessionId, {
      id: randomUUID(),
      timestamp: now,
      stream: "system",
      text: `> ${input.input.trim() || "[empty input]"}`,
    });
    this.emitSnapshot();

    return nextSession;
  }

  appendOutput(
    agentSessionId: string,
    text: string,
    stream: AgentOutputStream,
  ): AgentSessionRecord {
    const agentSession = this.get(agentSessionId);
    const now = new Date().toISOString();
    const outputPreview = pickOutputPreview(text) ?? agentSession.outputPreview;
    const nextScreenWindow = mergeScreenWindow(
      this.screenWindows.get(agentSessionId) ?? "",
      text,
    );
    const screenChanged =
      stream !== "system" &&
      nextScreenWindow !== (this.screenWindows.get(agentSessionId) ?? "");

    if (screenChanged) {
      this.screenWindows.set(agentSessionId, nextScreenWindow);
      this.lastScreenChangedAt.set(agentSessionId, Date.now());
      this.refreshAwaitingInputTimer(agentSessionId);
    }

    const nextSession: AgentSessionRecord = {
      ...agentSession,
      lastHeartbeatAt: now,
      lastOutputAt: screenChanged ? now : agentSession.lastOutputAt,
      outputPreview: screenChanged ? outputPreview : agentSession.outputPreview,
      interactionState:
        screenChanged && this.shouldUseTimedAwaitingInput(agentSession)
          ? "running"
          : agentSession.interactionState,
      stateConfidence:
        screenChanged && this.shouldUseTimedAwaitingInput(agentSession)
          ? "medium"
          : agentSession.stateConfidence,
      lastRefreshedAt: now,
    };

    this.sessions.set(agentSessionId, nextSession);
    this.pushOutputEntry(agentSessionId, {
      id: randomUUID(),
      timestamp: now,
      stream,
      text,
    });
    this.emitSnapshot();

    return nextSession;
  }

  replaceOutputEntries(
    agentSessionId: string,
    entries: AgentOutputEntry[],
  ): AgentSessionDetailResponse {
    this.get(agentSessionId);
    this.outputEntries.set(agentSessionId, entries.slice(-MAX_OUTPUT_ENTRIES));
    this.emitSnapshot();

    return this.getDetail(agentSessionId);
  }

  syncCapturedScreen(
    agentSessionId: string,
    screenText: string,
  ): AgentSessionRecord {
    const agentSession = this.get(agentSessionId);
    const normalizedScreen = normalizeTerminalText(screenText).slice(
      -MAX_INFERENCE_WINDOW_CHARS,
    );
    const previousScreen = this.screenWindows.get(agentSessionId) ?? "";
    const nowMs = Date.now();

    if (normalizedScreen !== previousScreen) {
      this.screenWindows.set(agentSessionId, normalizedScreen);
      this.lastScreenChangedAt.set(agentSessionId, nowMs);
    }

    const lastChangedAt = this.lastScreenChangedAt.get(agentSessionId) ?? nowMs;
    const shouldInferFromStableScreen =
      agentSession.sourceType === "local-window-capture" ||
      agentSession.controlMode !== "observe";
    const hasBeenStableLongEnough =
      nowMs - lastChangedAt >= this.awaitingInputIdleMs;

    return this.updateSession(agentSessionId, {
      interactionState: shouldInferFromStableScreen
        ? hasBeenStableLongEnough
          ? "awaiting_input"
          : "running"
        : "detached",
      stateConfidence: shouldInferFromStableScreen
        ? hasBeenStableLongEnough
          ? "medium"
          : "medium"
        : "high",
      lastHeartbeatAt: new Date(nowMs).toISOString(),
      lastRefreshedAt: new Date(nowMs).toISOString(),
    });
  }

  updateSession(
    agentSessionId: string,
    updater: Partial<AgentSessionRecord>,
  ): AgentSessionRecord {
    const agentSession = this.get(agentSessionId);
    const nextSession: AgentSessionRecord = {
      ...agentSession,
      ...updater,
      id: agentSession.id,
      controlMode: updater.controlMode ?? agentSession.controlMode,
      transportRef: {
        ...agentSession.transportRef,
        ...updater.transportRef,
      },
    };

    this.sessions.set(agentSessionId, nextSession);
    this.emitSnapshot();

    return nextSession;
  }

  markExited(
    agentSessionId: string,
    exitCode: number | null,
    signal: NodeJS.Signals | null,
  ): AgentSessionRecord {
    const exitSummary =
      exitCode !== null
        ? `Process exited with code ${exitCode}`
        : `Process exited with signal ${signal ?? "unknown"}`;

    const nextSession = this.updateSession(agentSessionId, {
      connectionState: "offline",
      interactionState: "exited",
      stateConfidence: "high",
      outputPreview: exitSummary,
      lastHeartbeatAt: new Date().toISOString(),
      lastRefreshedAt: new Date().toISOString(),
    });

    this.pushOutputEntry(agentSessionId, {
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      stream: "system",
      text: exitSummary,
    });
    this.emitSnapshot();
    this.clearAwaitingInputTimer(agentSessionId);

    return nextSession;
  }

  remove(agentSessionId: string): void {
    this.sessions.delete(agentSessionId);
    this.outputEntries.delete(agentSessionId);
    this.screenWindows.delete(agentSessionId);
    this.lastScreenChangedAt.delete(agentSessionId);
    this.sessionOrder.delete(agentSessionId);
    this.clearAwaitingInputTimer(agentSessionId);
    if (this.activeAgentSessionId === agentSessionId) {
      this.activeAgentSessionId = null;
    }
    this.emitSnapshot();
  }

  private pushOutputEntry(
    agentSessionId: string,
    outputEntry: AgentOutputEntry,
  ): void {
    const currentEntries = this.outputEntries.get(agentSessionId) ?? [];
    currentEntries.push(outputEntry);
    this.outputEntries.set(
      agentSessionId,
      currentEntries.slice(-MAX_OUTPUT_ENTRIES),
    );
  }

  private getSessionOrder = (agentSessionId: string): number =>
    this.sessionOrder.get(agentSessionId) ?? Number.MAX_SAFE_INTEGER;

  private emitSnapshot(): void {
    const snapshot = this.list();

    for (const listener of this.listeners) {
      listener(snapshot);
    }
  }

  noteUserInput(agentSessionId: string, input: string): AgentSessionRecord {
    const agentSession = this.get(agentSessionId);
    this.lastScreenChangedAt.set(agentSessionId, Date.now());

    if (this.shouldUseTimedAwaitingInput(agentSession)) {
      this.refreshAwaitingInputTimer(agentSessionId);
    }

    if (agentSession.interactionState === "exited") {
      return agentSession;
    }

    return this.updateSession(agentSessionId, {
      interactionState: "running",
      stateConfidence: "medium",
      lastHeartbeatAt: new Date().toISOString(),
    });
  }

  private shouldUseTimedAwaitingInput(
    agentSession: AgentSessionRecord,
  ): boolean {
    return (
      agentSession.connectionState === "online" &&
      agentSession.sourceType !== "remote-tmux-discovered" &&
      agentSession.sourceType !== "local-window-capture"
    );
  }

  private refreshAwaitingInputTimer(agentSessionId: string): void {
    this.clearAwaitingInputTimer(agentSessionId);

    const timeout = setTimeout(() => {
      const agentSession = this.sessions.get(agentSessionId);
      if (!agentSession || !this.shouldUseTimedAwaitingInput(agentSession)) {
        return;
      }

      const lastChangedAt = this.lastScreenChangedAt.get(agentSessionId) ?? 0;
      if (Date.now() - lastChangedAt < this.awaitingInputIdleMs) {
        return;
      }

      if (agentSession.interactionState === "awaiting_input") {
        return;
      }

      this.updateSession(agentSessionId, {
        interactionState: "awaiting_input",
        stateConfidence: "medium",
        lastHeartbeatAt: new Date().toISOString(),
      });
    }, this.awaitingInputIdleMs);

    this.awaitingInputTimers.set(agentSessionId, timeout);
  }

  private clearAwaitingInputTimer(agentSessionId: string): void {
    const timeout = this.awaitingInputTimers.get(agentSessionId);
    if (timeout) {
      clearTimeout(timeout);
      this.awaitingInputTimers.delete(agentSessionId);
    }
  }
}
