export interface Issue {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  priority: number | null;
  state: string;
  branchName: string | null;
  url: string | null;
  labels: string[];
  blockedBy: BlockerRef[];
  createdAt: Date | null;
  updatedAt: Date | null;
}

export interface BlockerRef {
  id: string | null;
  identifier: string | null;
  state: string | null;
}

export interface WorkflowDefinition {
  config: Record<string, unknown>;
  promptTemplate: string;
}

export interface ServiceConfig {
  promptTemplate: string;
  tracker: TrackerConfig;
  polling: PollingConfig;
  workspace: WorkspaceConfig;
  hooks: HooksConfig;
  agent: AgentConfig;
  agentBackend: AgentBackendConfig;
  server: ServerConfig;
}

export interface ServerConfig {
  /** null means the HTTP server is disabled */
  port: number | null;
}


export interface TrackerConfig {
  kind: 'linear';
  endpoint: string;
  apiKey: string;
  projectSlug: string;
  activeStates: string[];
  terminalStates: string[];
}

export interface PollingConfig {
  intervalMs: number;
}

export interface WorkspaceConfig {
  root: string;
}

export interface HooksConfig {
  afterCreate: string | null;
  beforeRun: string | null;
  afterRun: string | null;
  beforeRemove: string | null;
  timeoutMs: number;
}

export interface AgentConfig {
  maxConcurrentAgents: number;
  maxTurns: number;
  maxRetryBackoffMs: number;
  maxConcurrentAgentsByState: Record<string, number>;
}

export interface AgentBackendConfig {
  kind: 'subprocess';
  command: string;
  model: string | null;
  apiKey: string | null;
  baseUrl: string | null;
  executionPolicy: Record<string, unknown>;
  turnTimeoutMs: number;
  readTimeoutMs: number;
  stallTimeoutMs: number;
}

export interface WorkspaceResult {
  path: string;
  workspaceKey: string;
  createdNow: boolean;
}

export type RunStatus =
  | 'PreparingWorkspace'
  | 'BuildingPrompt'
  | 'LaunchingAgentBackend'
  | 'InitializingSession'
  | 'StreamingTurn'
  | 'Finishing'
  | 'Succeeded'
  | 'Failed'
  | 'TimedOut'
  | 'Stalled'
  | 'CanceledByReconciliation';

export interface LiveSession {
  sessionId: string;
  threadId: string;
  turnId: string;
  agentPid: number | null;
  lastAgentEvent: string | null;
  lastAgentTimestamp: Date | null;
  lastAgentMessage: string;
  agentInputTokens: number;
  agentOutputTokens: number;
  agentTotalTokens: number;
  lastReportedInputTokens: number;
  lastReportedOutputTokens: number;
  lastReportedTotalTokens: number;
  turnCount: number;
}

export interface RetryEntry {
  issueId: string;
  identifier: string;
  attempt: number;
  dueAtMs: number;
  timerHandle: ReturnType<typeof setTimeout>;
  error: string | null;
}

export interface RunningEntry {
  issue: Issue;
  attempt: number | null;
  workspacePath: string;
  startedAt: Date;
  session: LiveSession;
  abortController: AbortController;
}

export interface AgentTotals {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface RunResult {
  sessionId: string | null;
  workspacePath: string;
  usage: TokenUsage;
}

export function emptySession(): LiveSession {
  return {
    sessionId: '',
    threadId: '',
    turnId: '',
    agentPid: null,
    lastAgentEvent: null,
    lastAgentTimestamp: null,
    lastAgentMessage: '',
    agentInputTokens: 0,
    agentOutputTokens: 0,
    agentTotalTokens: 0,
    lastReportedInputTokens: 0,
    lastReportedOutputTokens: 0,
    lastReportedTotalTokens: 0,
    turnCount: 0,
  };
}
