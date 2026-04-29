import { Liquid } from 'liquidjs';
import { Issue, ServiceConfig, RunResult, TokenUsage } from '../types';
import { LinearClient } from '../tracker/linear';
import { WorkspaceManager } from '../workspace/manager';
import { IAgentAdapter, AgentEvent } from './adapter';
import { Logger } from '../logger';

const liquid = new Liquid({ strictVariables: true, strictFilters: true });

function renderPrompt(template: string, issue: Issue, attempt: number | null): string {
  const vars = {
    issue: {
      id: issue.id,
      identifier: issue.identifier,
      title: issue.title,
      description: issue.description,
      priority: issue.priority,
      state: issue.state,
      branch_name: issue.branchName,
      url: issue.url,
      labels: issue.labels,
      blocked_by: issue.blockedBy,
      created_at: issue.createdAt?.toISOString() ?? null,
      updated_at: issue.updatedAt?.toISOString() ?? null,
    },
    attempt: attempt ?? null,
  };

  try {
    return liquid.parseAndRenderSync(template, vars);
  } catch (err) {
    throw new Error(`template_render_error: ${(err as Error).message}`);
  }
}

function continuationPrompt(issue: Issue): string {
  return `Continue working on ${issue.identifier}. The ticket is still in state "${issue.state}". Resume from the current workspace state — do not restart from scratch.`;
}

function mergeUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    totalTokens: a.totalTokens + b.totalTokens,
  };
}

interface RunnerDeps {
  tracker: LinearClient;
  workspaceManager: WorkspaceManager;
  adapter: IAgentAdapter;
  log: Logger;
}

export class AgentRunner {
  private tracker: LinearClient;
  private workspaceManager: WorkspaceManager;
  private adapter: IAgentAdapter;
  private log: Logger;

  constructor(deps: RunnerDeps) {
    this.tracker = deps.tracker;
    this.workspaceManager = deps.workspaceManager;
    this.adapter = deps.adapter;
    this.log = deps.log;
  }

  async run(
    issue: Issue,
    attempt: number | null,
    config: ServiceConfig,
    onEvent: (event: AgentEvent) => void,
    signal: AbortSignal,
  ): Promise<RunResult> {
    const runLog = this.log.child({ issue_id: issue.id, issue_identifier: issue.identifier });

    // Prepare workspace
    const ws = await this.workspaceManager.prepare(issue, config);
    runLog.info('workspace_ready', { workspace: ws.path, created_now: ws.createdNow });

    // before_run hook
    await this.workspaceManager.runHook('before_run', ws.path, config);

    let sessionId: string | null = null;
    let totalUsage: TokenUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };

    try {
      for (let turnIdx = 0; turnIdx < config.agent.maxTurns; turnIdx++) {
        if (signal.aborted) {
          const err = new Error('aborted');
          err.name = 'AbortError';
          throw err;
        }

        const isFirst = turnIdx === 0;
        const prompt = isFirst
          ? renderPrompt(config.promptTemplate, issue, attempt)
          : continuationPrompt(issue);

        runLog.info('turn_start', { turn: turnIdx + 1, session_id: sessionId });

        const result = await this.adapter.runTurn(
          prompt, ws.path, config, sessionId, onEvent, signal,
        );

        if (result.sessionId) sessionId = result.sessionId;
        totalUsage = mergeUsage(totalUsage, result.usage);

        if (!result.success) {
          runLog.warn('turn_failed', { reason: result.errorMessage, turn: turnIdx + 1 });
          throw new Error(result.errorMessage ?? 'turn_failed');
        }

        runLog.info('turn_done', {
          turn: turnIdx + 1,
          input_tokens: result.usage.inputTokens,
          output_tokens: result.usage.outputTokens,
        });

        // Check if issue is still active before next turn
        if (turnIdx < config.agent.maxTurns - 1) {
          const stateMap = await this.tracker.fetchIssueStatesByIds([issue.id], config);
          const currentState = stateMap.get(issue.id);

          if (!currentState) {
            runLog.info('issue_not_found_after_turn', { turn: turnIdx + 1 });
            break;
          }

          const activeNorm = config.tracker.activeStates.map(s => s.toLowerCase());
          if (!activeNorm.includes(currentState.toLowerCase())) {
            runLog.info('issue_no_longer_active', { state: currentState, turn: turnIdx + 1 });
            // Update the in-memory state so the caller sees the latest value
            issue.state = currentState;
            break;
          }

          // Update state snapshot
          issue.state = currentState;
        }
      }
    } finally {
      await this.workspaceManager.runHook('after_run', ws.path, config);
    }

    return { sessionId, workspacePath: ws.path, usage: totalUsage };
  }
}
