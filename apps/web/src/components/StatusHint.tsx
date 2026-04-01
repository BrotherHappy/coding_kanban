import type { AgentSessionRecord } from "@agent-orchestrator/shared";

interface StatusHintProps {
  session: AgentSessionRecord;
}

const hintMessages: Record<string, string> = {
  running: "⚡ Agent 正在执行中",
  idle: "💤 Agent 当前空闲",
  detached: "🔌 会话已分离",
  exited: "⏹ 会话已结束",
};

export function StatusHint({ session }: StatusHintProps) {
  const hint = hintMessages[session.interactionState] ?? "";

  if (!hint) return null;

  return (
    <div className={`status-hint hint-${session.interactionState}`}>{hint}</div>
  );
}
