import { useCallback, useEffect, useRef, useState } from "react";

import type {
  AgentSessionRecord,
  ListAgentSessionsResponse,
  SshHostPreset,
} from "@agent-orchestrator/shared";

import { AgentFocusView } from "./components/AgentFocusView";
import { AgentGrid } from "./components/AgentGrid";
import { BottomBar } from "./components/BottomBar";
import type { DiscoveryMode } from "./components/DiscoveryDialog";
import { DiscoveryDialog } from "./components/DiscoveryDialog";
import type { AddToGridItem } from "./components/DiscoveryDialog";
import type { FilterState } from "./components/FilterBar";
import { HiddenSessionsDrawer } from "./components/HiddenSessionsDrawer";
import type { SelectedHost } from "./components/HostDropdown";
import { NewSessionDialog } from "./components/NewSessionDialog";
import { QuickTmuxConnect } from "./components/QuickTmuxConnect";
import { TopBar } from "./components/TopBar";
import {
  addDiscoveredTmux,
  createWindowCaptureSession,
  deleteAgentSession,
  focusAgentSession,
  getSshHosts,
  hideAgentSession,
  killTmuxSession,
  launchPtyAgent,
  launchSshPtyAgent,
  listAgentSessions,
  reconnectAgentSession,
  sendObserveState,
  subscribeAgentSessions,
  unhideAgentSession,
  updateAgentSession,
} from "./lib/api";
import {
  deriveLayoutMode,
  loadLayoutState,
  saveLayoutState,
  type LayoutState,
} from "./lib/layout-store";
import {
  buildDirectLaunchCommand,
  buildRemoteDirectLaunchCommand,
  wrapRemoteInteractiveCommand,
} from "./lib/session-matching";
import {
  createWindowCaptureActivityProbe,
  getWindowCaptureAvailability,
  requestWindowCapture,
  stopCapture,
  type CaptureActivityProbe,
} from "./lib/window-capture";
import "./app.css";

type ViewMode = "grid" | "focus";

interface CaptureEntry {
  stream: MediaStream;
  observeToken: string;
  label: string;
  activityProbe: CaptureActivityProbe;
}

function isEditableTarget(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  if (!element) {
    return false;
  }

  if (element.classList.contains("xterm-helper-textarea")) {
    return true;
  }

  return Boolean(
    element.closest(
      'input, textarea, select, [contenteditable="true"], [contenteditable=""]',
    ),
  );
}

export default function App() {
  const [snapshot, setSnapshot] = useState<ListAgentSessionsResponse | null>(
    null,
  );
  const [viewMode, setViewMode] = useState<ViewMode>("grid");
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [newSessionHost, setNewSessionHost] = useState<SelectedHost | null>(
    null,
  );
  const [quickTmuxOpen, setQuickTmuxOpen] = useState(false);
  const [layoutState, setLayoutState] = useState<LayoutState>(loadLayoutState);
  const [sshHosts, setSshHosts] = useState<SshHostPreset[]>([]);
  const [discoveryState, setDiscoveryState] = useState<{
    open: boolean;
    mode: DiscoveryMode;
    host: SelectedHost;
  } | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [windowCaptureNotice, setWindowCaptureNotice] = useState<string | null>(
    null,
  );
  const [filters, setFilters] = useState<FilterState>({
    host: null,
    kind: null,
    transport: null,
    dirQuery: "",
  });
  const [windowCaptureAvailability] = useState(() =>
    getWindowCaptureAvailability(),
  );

  // Window capture local store
  const captureStoreRef = useRef<Map<string, CaptureEntry>>(new Map());
  const [captureStoreVersion, setCaptureStoreVersion] = useState(0);
  const heartbeatIntervalRef = useRef<ReturnType<typeof setInterval> | null>(
    null,
  );
  const captureHeartbeatPrimeTimersRef = useRef<Map<string, number>>(new Map());

  function getCaptureStore(): Map<string, CaptureEntry> {
    return captureStoreRef.current;
  }

  function bumpCaptureVersion() {
    setCaptureStoreVersion((v) => v + 1);
  }

  const sendCaptureHeartbeat = useCallback(
    (sessionId: string, entry: CaptureEntry) => {
      const screenSignature = entry.activityProbe.readScreenSignature();

      return sendObserveState(sessionId, {
        kind: "heartbeat",
        observeToken: entry.observeToken,
        ...(screenSignature ? { screenSignature } : {}),
      });
    },
    [],
  );

  function clearCaptureHeartbeatPrime(sessionId: string) {
    const timeoutId = captureHeartbeatPrimeTimersRef.current.get(sessionId);
    if (timeoutId !== undefined) {
      window.clearTimeout(timeoutId);
      captureHeartbeatPrimeTimersRef.current.delete(sessionId);
    }
  }

  const primeCaptureHeartbeat = useCallback(
    (sessionId: string, remainingAttempts = 20) => {
      clearCaptureHeartbeatPrime(sessionId);

      const entry = getCaptureStore().get(sessionId);
      if (!entry) {
        return;
      }

      const screenSignature = entry.activityProbe.readScreenSignature();
      if (screenSignature) {
        sendObserveState(sessionId, {
          kind: "heartbeat",
          observeToken: entry.observeToken,
          screenSignature,
        }).catch(() => {});
        return;
      }

      if (remainingAttempts <= 0) {
        sendCaptureHeartbeat(sessionId, entry).catch(() => {});
        return;
      }

      const timeoutId = window.setTimeout(() => {
        primeCaptureHeartbeat(sessionId, remainingAttempts - 1);
      }, 500);
      captureHeartbeatPrimeTimersRef.current.set(sessionId, timeoutId);
    },
    [sendCaptureHeartbeat],
  );

  useEffect(() => {
    listAgentSessions()
      .then((data) => {
        setSnapshot(data);
        setIsLoading(false);
      })
      .catch(() => setIsLoading(false));

    getSshHosts()
      .then((res) => setSshHosts(res.hosts))
      .catch(() => {});

    const unsubscribe = subscribeAgentSessions((data) => {
      setSnapshot(data);
      setIsLoading(false);
    });

    return () => unsubscribe();
  }, []);

  useEffect(() => {
    if (!windowCaptureAvailability.supported) {
      setWindowCaptureNotice(
        windowCaptureAvailability.reason ?? "当前浏览器环境不支持窗口共享。",
      );
    }
  }, [windowCaptureAvailability]);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (!(event.metaKey || event.ctrlKey)) {
        return;
      }

      if (isEditableTarget(event.target)) {
        return;
      }

      if (event.shiftKey && event.key.toLowerCase() === "s") {
        event.preventDefault();
        setDiscoveryState({
          open: true,
          mode: "tmux",
          host: { type: "local" },
        });
        return;
      }

      if (event.key.toLowerCase() !== "e") {
        return;
      }

      event.preventDefault();
      setQuickTmuxOpen(true);
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, []);

  const sessions = snapshot?.items ?? [];
  const visibleSessions = sessions.filter((s) => !s.hidden);
  const hiddenSessions = sessions.filter((s) => s.hidden);
  const [showHiddenDrawer, setShowHiddenDrawer] = useState(false);

  // Heartbeat effect for active captures
  useEffect(() => {
    heartbeatIntervalRef.current = setInterval(() => {
      const store = getCaptureStore();
      for (const [sessionId, entry] of store) {
        sendCaptureHeartbeat(sessionId, entry).catch(() => {});
      }
    }, 3_000);

    return () => {
      if (heartbeatIntervalRef.current) {
        clearInterval(heartbeatIntervalRef.current);
      }
    };
  }, [sendCaptureHeartbeat]);

  // Cleanup captures on unmount
  useEffect(() => {
    return () => {
      const store = getCaptureStore();
      for (const timeoutId of captureHeartbeatPrimeTimersRef.current.values()) {
        window.clearTimeout(timeoutId);
      }
      captureHeartbeatPrimeTimersRef.current.clear();
      for (const [, entry] of store) {
        entry.activityProbe.dispose();
        stopCapture(entry.stream);
      }
    };
  }, []);

  const handleAddWindowCapture = useCallback(async () => {
    if (!windowCaptureAvailability.supported) {
      setWindowCaptureNotice(
        windowCaptureAvailability.reason ?? "当前浏览器环境不支持窗口共享。",
      );
      return;
    }

    setWindowCaptureNotice(null);
    const result = await requestWindowCapture();
    if (!result) return;

    try {
      const { agentSession, observeToken } = await createWindowCaptureSession({
        suggestedDisplayName: result.label,
        windowCaptureMeta: { rawLabel: result.label },
      });

      const activityProbe = createWindowCaptureActivityProbe(result.stream);

      const entry: CaptureEntry = {
        stream: result.stream,
        observeToken,
        label: result.label,
        activityProbe,
      };

      getCaptureStore().set(agentSession.id, entry);
      bumpCaptureVersion();
      primeCaptureHeartbeat(agentSession.id);

      // Listen for track ended
      const track = result.stream.getVideoTracks()[0];
      if (track) {
        track.onended = () => {
          clearCaptureHeartbeatPrime(agentSession.id);
          entry.activityProbe.dispose();
          sendObserveState(agentSession.id, {
            kind: "transition",
            observeToken,
            connectionState: "offline",
            interactionState: "exited",
            stateConfidence: "high",
            outputPreview: "窗口共享已结束",
          }).catch(() => {});
          getCaptureStore().delete(agentSession.id);
          bumpCaptureVersion();
        };
      }

      listAgentSessions()
        .then(setSnapshot)
        .catch(() => {});
    } catch {
      stopCapture(result.stream);
      setWindowCaptureNotice("VS Code 窗口观察启动失败，请重试。");
    }
  }, [windowCaptureAvailability]);

  const handleStopCapture = useCallback(async (sessionId: string) => {
    const store = getCaptureStore();
    const entry = store.get(sessionId);
    if (entry) {
      clearCaptureHeartbeatPrime(sessionId);
      entry.activityProbe.dispose();
      stopCapture(entry.stream);
      await sendObserveState(sessionId, {
        kind: "transition",
        observeToken: entry.observeToken,
        connectionState: "offline",
        interactionState: "exited",
        stateConfidence: "high",
        outputPreview: "观察已停止",
      }).catch(() => {});
      store.delete(sessionId);
      bumpCaptureVersion();
    }
    listAgentSessions()
      .then(setSnapshot)
      .catch(() => {});
  }, []);

  const filteredSessions = visibleSessions.filter((s) => {
    if (filters.host && (s.hostId ?? "local") !== filters.host) return false;
    if (filters.kind && s.agentKind !== filters.kind) return false;
    if (filters.transport === "tmux" && !s.transportRef?.tmuxSession) {
      return false;
    }
    if (
      filters.dirQuery &&
      !(s.workingDirectory ?? "")
        .toLowerCase()
        .includes(filters.dirQuery.toLowerCase())
    )
      return false;
    return true;
  });

  function handleFocusSession(id: string) {
    setFocusedId(id);
    setViewMode("focus");
  }

  const handleQuickTmuxConnected = useCallback(
    (session: AgentSessionRecord) => {
      setSnapshot((current) => {
        const items = current?.items ?? [];
        return {
          items: [session, ...items.filter((item) => item.id !== session.id)],
          activeAgentSessionId: session.id,
          updatedAt: new Date().toISOString(),
        };
      });
      setFocusedId(session.id);
      setViewMode("focus");
      setQuickTmuxOpen(false);

      listAgentSessions()
        .then(setSnapshot)
        .catch(() => {});
    },
    [],
  );

  const handleExitFocus = useCallback(() => {
    setViewMode("grid");
  }, []);

  function handleSwitchFocus(id: string) {
    setFocusedId(id);
  }

  function handleLaunched() {
    listAgentSessions()
      .then(setSnapshot)
      .catch(() => {});
  }

  async function handleDeleteSession(id: string) {
    await deleteAgentSession(id);
    listAgentSessions()
      .then(setSnapshot)
      .catch(() => {});
  }

  async function handleHideSession(id: string) {
    await hideAgentSession(id);
    const snap = await listAgentSessions().catch(() => null);
    if (snap) {
      setSnapshot(snap);
      if (snap.activeAgentSessionId === id) {
        const nextVisible = snap.items.find((s) => !s.hidden && s.id !== id);
        if (nextVisible) {
          focusAgentSession({ agentSessionId: nextVisible.id })
            .then(setSnapshot)
            .catch(() => {});
        }
      }
    }
  }

  async function handleUnhideSession(id: string) {
    await unhideAgentSession(id);
    listAgentSessions()
      .then(setSnapshot)
      .catch(() => {});
  }

  async function handleKillTmux(id: string) {
    await killTmuxSession(id);
    listAgentSessions()
      .then(setSnapshot)
      .catch(() => {});
  }

  function handleCopyConnectCommand(id: string) {
    const session = sessions.find((s) => s.id === id);
    if (session?.transportRef?.tmuxSession) {
      const cmd = `tmux attach -t ${session.transportRef.tmuxSession}`;
      navigator.clipboard.writeText(cmd).catch(() => {});
    }
  }

  async function handleReconnectSession(id: string) {
    await reconnectAgentSession(id);
    listAgentSessions()
      .then(setSnapshot)
      .catch(() => {});
  }

  const handleRenameSession = useCallback(
    async (id: string) => {
      const session = sessions.find((item) => item.id === id);
      if (!session) {
        return;
      }

      const promptMessage =
        session.sourceType === "local-window-capture" &&
        session.windowCaptureMeta?.rawLabel
          ? `输入新的会话名称\n原始标签：${session.windowCaptureMeta.rawLabel}`
          : "输入新的会话名称";

      const nextName = window.prompt(promptMessage, session.displayName);
      if (nextName === null) {
        return;
      }

      const displayName = nextName.trim();
      if (!displayName) {
        window.alert("名称不能为空");
        return;
      }

      if (displayName === session.displayName) {
        return;
      }

      await updateAgentSession(id, { displayName }).catch(() => {});
      listAgentSessions()
        .then(setSnapshot)
        .catch(() => {});
    },
    [sessions],
  );

  const focusedSession: AgentSessionRecord | undefined = focusedId
    ? sessions.find((s) => s.id === focusedId)
    : undefined;

  const getCaptureStreamForSession = useCallback(
    (id: string): MediaStream | null => {
      return getCaptureStore().get(id)?.stream ?? null;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [captureStoreVersion],
  );

  const layoutMode = deriveLayoutMode({
    ...layoutState,
    sidebarCollapsed: false,
  });

  function updateLayout(partial: Partial<LayoutState>) {
    setLayoutState((prev) => {
      const next = { ...prev, ...partial };
      saveLayoutState(next);
      return next;
    });
  }

  function handleScanTmux(host: SelectedHost) {
    setDiscoveryState({ open: true, mode: "tmux", host });
  }

  function handleScanApps(host: SelectedHost) {
    setDiscoveryState({ open: true, mode: "apps", host });
  }

  function handleDiscoveryClose() {
    setDiscoveryState(null);
  }

  async function handleAddToGrid(items: AddToGridItem[]) {
    for (const item of items) {
      try {
        const sr = item.scanResult;
        const workingDirectory = sr.workingDirectory || "~";
        const connectMode =
          item.connectMode ?? (sr.tmuxSession ? "tmux" : "direct");

        if (connectMode === "tmux" && sr.tmuxSession) {
          await addDiscoveredTmux({
            tmuxSession: sr.tmuxSession,
            tmuxPane: sr.tmuxPane,
            displayName: sr.displayName,
            workingDirectory,
            agentKind: sr.agentKind ?? "shell",
            interactionState: sr.status === "running" ? "running" : "detached",
            outputPreview:
              sr.status === "running"
                ? `${sr.displayName} · 连接中`
                : `${sr.displayName} · detached`,
            sshTarget: sr.sshTarget,
          });
          continue;
        }

        if (sr.sshTarget) {
          await launchSshPtyAgent({
            workspaceId: "default",
            displayName: sr.displayName,
            agentKind: sr.agentKind,
            sshTarget: sr.sshTarget,
            remoteCommand: wrapRemoteInteractiveCommand(
              buildRemoteDirectLaunchCommand(
                sr.agentKind,
                workingDirectory,
                sr.displayName,
                sr.sessionId,
              ),
            ),
            workingDirectory,
            ...(sr.sessionId ? { agentSessionId: sr.sessionId } : {}),
          });
          continue;
        }

        await launchPtyAgent({
          workspaceId: "default",
          displayName: sr.displayName,
          agentKind: sr.agentKind,
          command: buildDirectLaunchCommand(
            sr.agentKind,
            workingDirectory,
            sr.displayName,
            sr.sessionId,
          ),
          workingDirectory,
          ...(sr.sessionId ? { agentSessionId: sr.sessionId } : {}),
        });
      } catch {
        // ignore individual failures
      }
    }
    listAgentSessions()
      .then(setSnapshot)
      .catch(() => {});
  }

  return (
    <main className={`app-shell-v2 layout-${layoutMode}`}>
      <TopBar
        sessions={sessions}
        collapsed={layoutState.topbarCollapsed}
        sshHosts={sshHosts}
        onToggleCollapsed={() =>
          updateLayout({ topbarCollapsed: !layoutState.topbarCollapsed })
        }
        onOpenNewSession={setNewSessionHost}
        onScanTmux={handleScanTmux}
        onScanApps={handleScanApps}
        onOpenQuickTmuxConnect={() => setQuickTmuxOpen(true)}
        onAddWindowCapture={handleAddWindowCapture}
        windowCaptureSupported={windowCaptureAvailability.supported}
        windowCaptureReason={windowCaptureAvailability.reason}
      />

      {windowCaptureNotice && (
        <div className="app-notice app-notice-warning" role="status">
          {windowCaptureNotice}
        </div>
      )}

      <div className="main-layout">
        <div className="main-content">
          {isLoading ? (
            <div className="grid-empty">
              <p>正在加载...</p>
            </div>
          ) : (
            <div className="main-content-stage">
              {focusedSession ? (
                <div
                  className={`main-content-view${
                    viewMode === "focus" ? "" : " is-hidden"
                  }`}
                  aria-hidden={viewMode !== "focus"}
                >
                  <AgentFocusView
                    focusedSession={focusedSession}
                    sessions={sessions}
                    active={viewMode === "focus"}
                    onSwitchFocus={handleSwitchFocus}
                    onExit={handleExitFocus}
                    onReconnect={handleReconnectSession}
                    onRename={handleRenameSession}
                    captureStream={getCaptureStreamForSession(
                      focusedSession.id,
                    )}
                    onStopCapture={handleStopCapture}
                    getCaptureStream={getCaptureStreamForSession}
                  />
                </div>
              ) : null}

              {viewMode === "focus" && focusedSession ? null : (
                <div className="main-content-view">
                  <AgentGrid
                    sessions={filteredSessions}
                    allSessions={visibleSessions}
                    filters={filters}
                    onFiltersChange={setFilters}
                    onFocusSession={handleFocusSession}
                    onDeleteSession={handleDeleteSession}
                    onReconnectSession={handleReconnectSession}
                    onRenameSession={handleRenameSession}
                    onHideSession={handleHideSession}
                    onCopyConnectCommand={handleCopyConnectCommand}
                    onKillTmux={handleKillTmux}
                    getCaptureStream={getCaptureStreamForSession}
                    onStopCapture={handleStopCapture}
                    hiddenCount={hiddenSessions.length}
                    onShowHidden={() => setShowHiddenDrawer(true)}
                  />
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      <BottomBar />

      <NewSessionDialog
        open={Boolean(newSessionHost)}
        host={newSessionHost}
        sessions={sessions}
        onClose={() => setNewSessionHost(null)}
        onLaunched={handleLaunched}
      />

      <QuickTmuxConnect
        open={quickTmuxOpen}
        onClose={() => setQuickTmuxOpen(false)}
        onConnected={handleQuickTmuxConnected}
      />

      {discoveryState && (
        <DiscoveryDialog
          open={discoveryState.open}
          mode={discoveryState.mode}
          host={discoveryState.host}
          sessions={sessions}
          onClose={handleDiscoveryClose}
          onAddToGrid={handleAddToGrid}
          onFocusSession={handleFocusSession}
        />
      )}

      <HiddenSessionsDrawer
        sessions={hiddenSessions}
        open={showHiddenDrawer}
        onClose={() => setShowHiddenDrawer(false)}
        onUnhide={handleUnhideSession}
        onDelete={handleDeleteSession}
      />
    </main>
  );
}
