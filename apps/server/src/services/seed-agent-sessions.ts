import { AgentSessionRegistry } from "./agent-session-registry.js";

export function seedAgentSessions(registry: AgentSessionRegistry): void {
  registry.register({
    workspaceId: "checkout-redesign",
    hostId: "local-dev",
    sourceType: "local",
    agentKind: "codex",
    displayName: "Local Codex / checkout-redesign",
    workingDirectory: "/Users/hx/projects/checkout-redesign",
    interactionState: "idle",
    connectionState: "online",
    stateConfidence: "high",
    outputPreview: "Ready for your next instruction.",
  });

  registry.register({
    workspaceId: "infra-observability",
    hostId: "ssh-prod-1",
    sourceType: "remote-connect",
    agentKind: "copilot",
    displayName: "Remote Copilot / infra-observability",
    workingDirectory: "/srv/workspaces/infra-observability",
    interactionState: "running",
    connectionState: "online",
    stateConfidence: "medium",
    outputPreview: "Streaming deployment diagnostics from remote host.",
  });

  registry.register({
    workspaceId: "support-automation",
    hostId: "ssh-tools-2",
    sourceType: "remote-tmux-discovered",
    agentKind: "copilot",
    displayName: "Tmux Copilot / support-automation",
    workingDirectory: "/opt/agents/support-automation",
    interactionState: "idle",
    connectionState: "degraded",
    stateConfidence: "low",
    outputPreview: "No output in the last 90 seconds.",
  });
}
