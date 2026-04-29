import { ServiceConfig, TokenUsage } from '../types';

export type AgentEventType =
  | 'session_started'
  | 'startup_failed'
  | 'turn_completed'
  | 'turn_failed'
  | 'turn_cancelled'
  | 'turn_ended_with_error'
  | 'turn_input_required'
  | 'approval_required'
  | 'tool_call'
  | 'agent_message'
  | 'usage_update'
  | 'other_message'
  | 'malformed';

export interface AgentEvent {
  event: AgentEventType;
  timestamp: Date;
  agentPid: number | null;
  sessionId?: string;
  message?: string;
  usage?: TokenUsage;
  raw?: unknown;
}

export interface TurnResult {
  sessionId: string | null;
  usage: TokenUsage;
  success: boolean;
  errorMessage?: string;
}

export interface IAgentAdapter {
  runTurn(
    prompt: string,
    workspacePath: string,
    config: ServiceConfig,
    sessionId: string | null,
    onEvent: (event: AgentEvent) => void,
    signal: AbortSignal,
  ): Promise<TurnResult>;
}
