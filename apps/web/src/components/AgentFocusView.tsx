import { useEffect } from "react";

import type { AgentSessionRecord } from "@agent-orchestrator/shared";

import { getWindowCaptureDisplay } from "../lib/window-capture-label";
import { TerminalView } from "./TerminalView";
import { WindowCapturePreview } from "./WindowCapturePreview";

interface AgentFocusViewProps {
  focusedSession: AgentSessionRecord;
  sessions: AgentSessionRecord[];
  onSwitchFocus: (id: string) => void;
  onExit: () => void;
  onReconnect: (id: string) => void;
  onRename?: (id: string) => void;
  captureStream?: MediaStream | null;
  onStopCapture?: (id: string) => void;
  getCaptureStream?: (id: string) => MediaStream | null;
}

const stateLabels: Record<string, string> = {
  running: "运行中",
  idle: "空闲",
  awaiting_input: "等待输入",
  detached: "已分离",
  exited: "已退出",
};

export function AgentFocusView({
  focusedSession,
  sessions,
  onSwitchFocus,
  onExit,
  onReconnect,
  onRename,
  captureStream,
  onStopCapture,
  getCaptureStream,
}: AgentFocusViewProps) {
  useEffect(() => {
    function isInTerminal(node: HTMLElement | null): boolean {
      return Boolean(
        node?.closest(".focus-main-terminal") ||
        node?.classList.contains("xterm-helper-textarea"),
      );
    }

    function handleKeyDown(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      const active = document.activeElement as HTMLElement | null;

      if (e.key === "Escape") {
        // Don't intercept Escape when terminal has focus
        if (isInTerminal(target) || isInTerminal(active)) {
          return;
        }
        onExit();
        return;
      }

      // If focus is outside the terminal and outside a text input, redirect it
      // to the xterm textarea so the keypress reaches the running process.
      const inInput =
        active instanceof HTMLInputElement ||
        active instanceof HTMLTextAreaElement ||
        active?.isContentEditable;
      if (!inInput && !isInTerminal(target) && !isInTerminal(active)) {
        const textarea = document.querySelector(
          ".focus-main-terminal .xterm-helper-textarea",
        ) as HTMLTextAreaElement | null;
        textarea?.focus();
      }
    }

    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [onExit]);

  const otherSessions = sessions.filter((s) => s.id !== focusedSession.id);
  const isWindowCapture = focusedSession.sourceType === "local-window-capture";
  const isExited = focusedSession.interactionState === "exited";
  const isDetached = focusedSession.interactionState === "detached";
  const canStopCapture =
    isWindowCapture && !isExited && !isDetached && Boolean(captureStream);

  const focusDisplay = isWindowCapture
    ? getWindowCaptureDisplay(
        focusedSession.displayName,
        focusedSession.windowCaptureMeta?.rawLabel,
      )
    : null;

  return (
    <div className="focus-view">
      <div className="focus-main">
        <div className="focus-main-header">
          <span className="focus-main-name">
            {focusDisplay ? focusDisplay.title : focusedSession.displayName}
          </span>
          {focusDisplay?.appName && (
            <span className="focus-main-app-name">{focusDisplay.appName}</span>
          )}
          <span
            className={`grid-card-badge badge-${focusedSession.interactionState}`}
          >
            {stateLabels[focusedSession.interactionState] ??
              focusedSession.interactionState}
          </span>
          <button
            className="focus-rename-btn"
            onClick={() => onRename?.(focusedSession.id)}
            type="button"
          >
            ✎ 改名
          </button>
          <button className="focus-exit-btn" onClick={onExit}>
            返回宫格
          </button>
          {canStopCapture && (
            <button
              className="focus-reconnect-btn"
              onClick={() => onStopCapture?.(focusedSession.id)}
            >
              ⏹ 停止观察
            </button>
          )}
          {focusedSession.interactionState === "exited" &&
            focusedSession.sourceType !== "remote-tmux-discovered" &&
            !isWindowCapture && (
              <button
                className="focus-reconnect-btn"
                onClick={() => onReconnect(focusedSession.id)}
              >
                🔄 重新连接
              </button>
            )}
        </div>
        <div className="focus-main-terminal">
          {isWindowCapture ? (
            <WindowCapturePreview
              stream={captureStream ?? null}
              interactionState={focusedSession.interactionState}
              connectionState={focusedSession.connectionState}
              large
            />
          ) : (
            <TerminalView
              agentSessionId={focusedSession.id}
              interactive={true}
            />
          )}
        </div>
        {isWindowCapture && focusedSession.windowCaptureMeta?.rawLabel && (
          <div className="focus-capture-meta">
            <span className="focus-capture-meta-label">原始标签</span>
            <span className="focus-capture-meta-value">
              {focusedSession.windowCaptureMeta.rawLabel}
            </span>
          </div>
        )}
        {isWindowCapture && (
          <div className="focus-capture-note">
            这是浏览器侧的窗口共享预览。网页无法直接激活你本机的 VS Code
            原生窗口，请手动切换。
          </div>
        )}
      </div>

      {otherSessions.length > 0 && (
        <div className="focus-sidebar">
          <h3 className="focus-sidebar-title">其他会话</h3>
          {otherSessions.map((session) => {
            const sIsCapture = session.sourceType === "local-window-capture";
            const sideStream = sIsCapture
              ? (getCaptureStream?.(session.id) ?? null)
              : null;
            const sideDisplay = sIsCapture
              ? getWindowCaptureDisplay(
                  session.displayName,
                  session.windowCaptureMeta?.rawLabel,
                )
              : null;

            return (
              <div
                key={session.id}
                className={`focus-sidebar-card card-${session.interactionState}`}
                onDoubleClick={() => onSwitchFocus(session.id)}
              >
                <div className="focus-sidebar-card-header">
                  <span>
                    {sideDisplay ? sideDisplay.title : session.displayName}
                  </span>
                  <div className="focus-sidebar-card-actions">
                    <button
                      className="grid-card-rename"
                      onClick={(event) => {
                        event.stopPropagation();
                        onRename?.(session.id);
                      }}
                      title="修改名称"
                      type="button"
                    >
                      ✎
                    </button>
                    <span
                      className={`grid-card-badge badge-${session.interactionState}`}
                    >
                      {stateLabels[session.interactionState] ??
                        session.interactionState}
                    </span>
                  </div>
                </div>
                <div className="focus-sidebar-terminal">
                  {sIsCapture ? (
                    <WindowCapturePreview
                      stream={sideStream}
                      interactionState={session.interactionState}
                      connectionState={session.connectionState}
                    />
                  ) : (
                    <TerminalView
                      agentSessionId={session.id}
                      interactive={false}
                    />
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
