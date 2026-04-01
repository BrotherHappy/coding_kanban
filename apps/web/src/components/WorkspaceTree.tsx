import type { AgentSessionRecord } from "@agent-orchestrator/shared";

interface WorkspaceTreeProps {
  sessions: AgentSessionRecord[];
}

export function WorkspaceTree({ sessions }: WorkspaceTreeProps) {
  const groupedSessions = sessions.reduce<Record<string, AgentSessionRecord[]>>(
    (accumulator, agentSession) => {
      const key = `${agentSession.hostId ?? "local"}::${agentSession.workspaceId}`;
      accumulator[key] ??= [];
      accumulator[key].push(agentSession);
      return accumulator;
    },
    {},
  );

  return (
    <aside className="panel panel-tree">
      <div className="panel-header">
        <h2>Workspaces</h2>
      </div>
      <div className="tree-list">
        {Object.entries(groupedSessions).map(([key, agentSessions]) => {
          const [hostId, workspaceId] = key.split("::");
          const idleCount = agentSessions.filter(
            ({ interactionState }) => interactionState === "idle",
          ).length;

          return (
            <section key={key} className="tree-group">
              <header>
                <strong>{workspaceId}</strong>
                <span>{hostId}</span>
              </header>
              <p>
                {agentSessions.length} 个会话 · {idleCount} 空闲
              </p>
            </section>
          );
        })}
      </div>
    </aside>
  );
}
