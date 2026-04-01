import type {
  AgentSessionRecord,
  SshHostPreset,
} from "@agent-orchestrator/shared";

import { getQuickTmuxShortcutLabel } from "../lib/platform-compat";

import { HostDropdown, type SelectedHost } from "./HostDropdown";

interface TopBarProps {
  sessions: AgentSessionRecord[];
  collapsed: boolean;
  sshHosts: SshHostPreset[];
  onToggleCollapsed: () => void;
  onOpenNewSession: (host: SelectedHost) => void;
  onScanTmux: (host: SelectedHost) => void;
  onScanApps: (host: SelectedHost) => void;
  onOpenQuickTmuxConnect: () => void;
  onAddWindowCapture: () => void;
  windowCaptureSupported: boolean;
  windowCaptureReason?: string | null;
}

export function TopBar({
  sessions,
  collapsed,
  sshHosts,
  onToggleCollapsed,
  onOpenNewSession,
  onScanTmux,
  onScanApps,
  onOpenQuickTmuxConnect,
  onAddWindowCapture,
  windowCaptureSupported,
  windowCaptureReason,
}: TopBarProps) {
  const quickTmuxShortcutLabel = getQuickTmuxShortcutLabel();
  const runningCount = sessions.filter(
    (s) => s.interactionState === "running",
  ).length;
  const idleCount = sessions.filter(
    (s) => s.interactionState === "idle",
  ).length;
  const totalCount = sessions.length;

  if (collapsed) {
    return (
      <header className="top-bar top-bar--collapsed">
        <button
          className="top-bar-expand-btn"
          onClick={onToggleCollapsed}
          title="展开顶栏"
        >
          ▼ 展开
        </button>
      </header>
    );
  }

  return (
    <header className="top-bar">
      <div className="top-bar-left">
        <h1 className="top-bar-title">Coding Kanban</h1>
      </div>
      <div className="top-bar-stats">
        <HostDropdown
          sshHosts={sshHosts}
          onSelectHost={onOpenNewSession}
          triggerLabel="新建会话"
          buttonTestId="new-session-toggle"
          triggerClassName="top-bar-action top-bar-action--primary"
        />
        <HostDropdown
          sshHosts={sshHosts}
          onSelectHost={onScanTmux}
          triggerLabel="扫描 tmux"
        />
        <HostDropdown
          sshHosts={sshHosts}
          onSelectHost={onScanApps}
          triggerLabel="扫描会话"
        />
        <button
          className="top-bar-action"
          onClick={onAddWindowCapture}
          disabled={!windowCaptureSupported}
          title={
            windowCaptureSupported
              ? "选择一个要观察的 VS Code 窗口"
              : (windowCaptureReason ?? "当前浏览器环境不支持窗口共享")
          }
        >
          添加 VS Code 窗口
          {!windowCaptureSupported && (
            <span className="top-bar-shortcut">当前不可用</span>
          )}
        </button>
        <button className="top-bar-action" onClick={onOpenQuickTmuxConnect}>
          快速连接 tmux
          <span className="top-bar-shortcut">{quickTmuxShortcutLabel}</span>
        </button>
        <span className="stat-item">
          共 <strong>{totalCount}</strong> 个会话
        </span>
        {runningCount > 0 && (
          <span className="stat-item stat-running">
            🟢 {runningCount} 运行中
          </span>
        )}
        {idleCount > 0 && (
          <span className="stat-item stat-idle">🔵 {idleCount} 空闲</span>
        )}
        <button
          className="top-bar-collapse-btn"
          onClick={onToggleCollapsed}
          title="折叠顶栏"
        >
          ─
        </button>
      </div>
    </header>
  );
}
