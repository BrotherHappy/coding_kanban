export type AgentSourceType =
  | "local"
  | "remote-connect"
  | "remote-tmux-discovered"
  | "local-window-capture";

export type ConnectionState = "online" | "degraded" | "offline";

export type InteractionState = "running" | "idle" | "detached" | "exited";

export type StateConfidence = "high" | "medium" | "low";
export type AgentOutputStream = "stdout" | "stderr" | "system";
export type AgentControlMode = "observe" | "control";

export interface AgentTransportRef {
  terminalId?: string;
  processId?: number;
  tmuxSession?: string;
  tmuxPane?: string;
  runtimeId?: string;
  sshHost?: string;
  sshPort?: number;
  sshUsername?: string;
}

export interface SshTarget {
  host: string;
  port?: number;
  username?: string;
  identityFile?: string;
}

export interface SshHostPreset {
  name: string;
  host: string;
  port: number;
  username?: string;
  identityFile?: string;
  defaultPath: string;
}

export interface SshHostsResponse {
  hosts: SshHostPreset[];
}

export interface AgentSessionRecord {
  id: string;
  workspaceId: string;
  hostId?: string;
  sourceType: AgentSourceType;
  agentKind: string;
  displayName: string;
  workingDirectory?: string;
  connectionState: ConnectionState;
  interactionState: InteractionState;
  stateConfidence?: StateConfidence;
  lastOutputAt?: string;
  lastHeartbeatAt?: string;
  lastRefreshedAt?: string;
  outputPreview?: string;
  controlMode?: AgentControlMode;
  transportRef?: AgentTransportRef;
  agentSessionId?: string;
  sshTarget?: SshTarget;
  remoteCommand?: string;
  windowCaptureMeta?: WindowCaptureMeta;
  hidden?: boolean;
}

export interface AgentOutputEntry {
  id: string;
  timestamp: string;
  stream: AgentOutputStream;
  text: string;
}

export interface ListAgentSessionsResponse {
  items: AgentSessionRecord[];
  activeAgentSessionId: string | null;
  updatedAt: string;
}

export interface AgentSessionDetailResponse {
  agentSession: AgentSessionRecord;
  outputEntries: AgentOutputEntry[];
}

export interface RegisterAgentSessionInput {
  workspaceId: string;
  hostId?: string;
  sourceType: AgentSourceType;
  agentKind: string;
  displayName: string;
  workingDirectory?: string;
  connectionState?: ConnectionState;
  interactionState?: InteractionState;
  stateConfidence?: StateConfidence;
  controlMode?: AgentControlMode;
  outputPreview?: string;
  transportRef?: AgentTransportRef;
  agentSessionId?: string;
  sshTarget?: SshTarget;
  remoteCommand?: string;
  windowCaptureMeta?: WindowCaptureMeta;
}

export interface FocusAgentSessionInput {
  agentSessionId: string;
}

export interface UpdateAgentSessionInput {
  displayName?: string;
  hidden?: boolean;
}

export interface StdinAgentSessionInput {
  input: string;
}

export interface LaunchLocalAgentInput {
  workspaceId: string;
  displayName: string;
  agentKind: string;
  workingDirectory?: string;
  hostId?: string;
  command: string;
  tmuxSessionName?: string;
  tmuxPaneId?: string;
}

export interface LaunchRemoteAgentInput {
  workspaceId: string;
  displayName: string;
  agentKind: string;
  workingDirectory?: string;
  command: string;
  sshTarget: SshTarget;
}

export interface DiscoverTmuxSessionsResponse {
  items: AgentSessionRecord[];
  unavailable: boolean;
}

export interface TmuxControlActionResponse {
  agentSession: AgentSessionRecord;
  outputEntries: AgentOutputEntry[];
}

export interface AgentSessionSnapshotEvent {
  type: "snapshot";
  payload: ListAgentSessionsResponse;
}

export interface PtyResizeInput {
  cols: number;
  rows: number;
}

export interface ScanDirectoryInput {
  path: string;
  hostId?: string;
  sshTarget?: SshTarget;
}

export interface DirectorySuggestionsInput {
  prefix: string;
  sshTarget?: SshTarget;
}

export interface DirectorySuggestionsResponse {
  enabled: boolean;
  suggestions: string[];
}

export interface ScanResult {
  agentKind: string;
  status: "running" | "stopped";
  displayName: string;
  workingDirectory: string;
  pid?: number;
  tmuxSession?: string;
  tmuxPane?: string;
  lastActivity?: string;
  historyPath?: string;
  sshTarget?: SshTarget;
  sessionId?: string;
  sessionName?: string;
  binaryPath?: string;
}

export interface LaunchSshPtyInput {
  workspaceId: string;
  displayName: string;
  agentKind: string;
  sshTarget: SshTarget;
  remoteCommand: string;
  workingDirectory?: string;
  agentSessionId?: string;
  tmuxSessionName?: string;
  tmuxPaneId?: string;
}

export interface ScanDirectoryResponse {
  results: ScanResult[];
  scannedPath: string;
  hostId: string;
}

export const interactionStateOrder: InteractionState[] = [
  "running",
  "idle",
  "detached",
  "exited",
];

// --- Discovery & Grid Control DTOs ---

export interface DiscoverTmuxInput {
  hostId?: string;
  sshTarget?: SshTarget;
}

export interface AddDiscoveredTmuxInput {
  tmuxSession: string;
  tmuxPane?: string;
  displayName: string;
  workingDirectory: string;
  agentKind: string;
  interactionState?: InteractionState;
  outputPreview?: string;
  sshTarget?: SshTarget;
}

export interface KillTmuxSessionInput {
  tmuxSessionName: string;
  hostId?: string;
  sshTarget?: SshTarget;
}

// --- Window Capture DTOs ---

export interface WindowCaptureMeta {
  rawLabel: string;
}

export interface CreateWindowCaptureSessionInput {
  suggestedDisplayName?: string;
  windowCaptureMeta?: WindowCaptureMeta;
}

export interface CreateWindowCaptureSessionResponse {
  agentSession: AgentSessionRecord;
  observeToken: string;
}

export interface ObserveStateHeartbeatInput {
  kind: "heartbeat";
  observeToken: string;
  outputPreview?: string;
  screenSignature?: string;
}

export interface ObserveStateTransitionInput {
  kind: "transition";
  observeToken: string;
  connectionState: ConnectionState;
  interactionState: InteractionState;
  stateConfidence: StateConfidence;
  outputPreview?: string;
}

export type ObserveStateInput =
  | ObserveStateHeartbeatInput
  | ObserveStateTransitionInput;
