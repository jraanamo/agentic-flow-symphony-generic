import * as path from 'path';
import * as http from 'http';
import * as chokidar from 'chokidar';
import {
  Issue,
  ServiceConfig,
  RunningEntry,
  RetryEntry,
  AgentTotals,
  TokenUsage,
  emptySession,
} from '../types';
import { WorkflowDefinition } from '../types';
import { loadWorkflow } from '../workflow/loader';
import { parseConfig, validateConfig } from '../workflow/config';
import { LinearClient } from '../tracker/linear';
import { WorkspaceManager } from '../workspace/manager';
import { AgentRunner } from '../agent/runner';
import { AgentEvent } from '../agent/adapter';
import { Logger } from '../logger';

interface OrchestratorState {
  running: Map<string, RunningEntry>;
  claimed: Set<string>;
  retryAttempts: Map<string, RetryEntry>;
  completed: Set<string>;
  agentTotals: AgentTotals;
  endedSessionSeconds: number;
  agentRateLimits: unknown;
}

interface OrchestratorDeps {
  workflowPath: string;
  tracker: LinearClient;
  workspaceManager: WorkspaceManager;
  runner: AgentRunner;
  log: Logger;
  /** Override server.port from WORKFLOW.md (from --port CLI flag) */
  cliPort?: number;
}

export class Orchestrator {
  private workflowPath: string;
  private tracker: LinearClient;
  private workspaceManager: WorkspaceManager;
  private runner: AgentRunner;
  private log: Logger;

  private config!: ServiceConfig;
  private state: OrchestratorState;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private watcher: chokidar.FSWatcher | null = null;
  private httpServer: http.Server | null = null;
  private cliPort: number | undefined;

  constructor(deps: OrchestratorDeps) {
    this.workflowPath = path.resolve(deps.workflowPath);
    this.tracker = deps.tracker;
    this.workspaceManager = deps.workspaceManager;
    this.runner = deps.runner;
    this.log = deps.log;
    this.cliPort = deps.cliPort;

    this.state = {
      running: new Map(),
      claimed: new Set(),
      retryAttempts: new Map(),
      completed: new Set(),
      agentTotals: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      endedSessionSeconds: 0,
      agentRateLimits: null,
    };
  }

  async start(): Promise<void> {
    // Load and validate initial config
    this.config = this.reloadWorkflow();
    const validation = validateConfig(this.config);
    if (!validation.valid) {
      throw new Error(`startup validation failed: ${validation.errors.join(', ')}`);
    }

    this.log.info('symphony_started', {
      project: this.config.tracker.projectSlug,
      poll_interval_ms: this.config.polling.intervalMs,
      max_agents: this.config.agent.maxConcurrentAgents,
    });

    // Watch for WORKFLOW.md changes
    this.watcher = chokidar.watch(this.workflowPath, { ignoreInitial: true });
    this.watcher.on('change', () => {
      this.log.info('workflow_changed', { path: this.workflowPath });
      try {
        this.config = this.reloadWorkflow();
        this.log.info('workflow_reloaded');
        // Re-apply HTTP server config on reload (port changes require restart)
        const port = this.cliPort ?? this.config.server.port;
        this.startHttpServer(port);
      } catch (err) {
        this.log.error('workflow_reload_failed', { error: (err as Error).message });
      }
    });

    // Start optional HTTP server
    const port = this.cliPort ?? this.config.server.port;
    this.startHttpServer(port);

    // Startup terminal cleanup
    await this.startupCleanup();

    // Schedule immediate first tick
    this.scheduleTick(0);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    if (this.watcher) await this.watcher.close();

    // Cancel all running workers
    for (const [issueId, entry] of this.state.running) {
      this.log.info('worker_cancel_on_shutdown', { issue_id: issueId });
      entry.abortController.abort();
    }

    // Shut down HTTP server if running
    if (this.httpServer) {
      await new Promise<void>((resolve) => this.httpServer!.close(() => resolve()));
      this.httpServer = null;
    }
  }

  snapshot(): object {
    const now = Date.now();
    const running = [...this.state.running.entries()].map(([id, e]) => ({
      issue_id: id,
      identifier: e.issue.identifier,
      state: e.issue.state,
      attempt: e.attempt,
      turn_count: e.session.turnCount,
      started_at: e.startedAt.toISOString(),
      session_id: e.session.sessionId || null,
    }));

    const retrying = [...this.state.retryAttempts.entries()].map(([id, r]) => ({
      issue_id: id,
      identifier: r.identifier,
      attempt: r.attempt,
      due_in_ms: r.dueAtMs - now,
      error: r.error,
    }));

    const activeSeconds = [...this.state.running.values()]
      .reduce((sum, e) => sum + (now - e.startedAt.getTime()) / 1000, 0);

    return {
      running,
      retrying,
      agent_totals: {
        ...this.state.agentTotals,
        seconds_running: this.state.endedSessionSeconds + activeSeconds,
      },
    };
  }

  // ─── Private: scheduling ─────────────────────────────────────────────────

  private scheduleTick(delayMs: number): void {
    this.pollTimer = setTimeout(() => void this.tick(), delayMs);
  }

  private async tick(): Promise<void> {
    if (this.stopped) return;

    try {
      await this.reconcile();

      // Defensive reload in case watcher missed a change
      try {
        const fresh = this.reloadWorkflow();
        const v = validateConfig(fresh);
        if (v.valid) {
          this.config = fresh;
        } else {
          this.log.warn('dispatch_validation_failed', { errors: v.errors });
          return;
        }
      } catch (err) {
        this.log.warn('workflow_reload_error', { error: (err as Error).message });
        return;
      }

      let candidates: Issue[];
      try {
        candidates = await this.tracker.fetchCandidateIssues(this.config);
        this.log.info('candidates_fetched', { count: candidates.length });
      } catch (err) {
        this.log.warn('candidate_fetch_failed', { error: (err as Error).message });
        return;
      }

      this.dispatch(candidates);
    } catch (err) {
      this.log.error('tick_error', { error: (err as Error).message });
    } finally {
      if (!this.stopped) {
        this.scheduleTick(this.config.polling.intervalMs);
      }
    }
  }

  // ─── Private: dispatch ────────────────────────────────────────────────────

  private dispatch(candidates: Issue[]): void {
    const eligible = candidates
      .filter(i => this.isEligible(i))
      .sort(compareIssues);

    for (const issue of eligible) {
      if (this.availableSlots() <= 0) break;
      if (this.perStateSlots(issue.state) <= 0) continue;
      this.launchWorker(issue, null);
    }
  }

  private isEligible(issue: Issue): boolean {
    if (!issue.id || !issue.identifier || !issue.title || !issue.state) return false;

    const stateNorm = issue.state.toLowerCase();
    const active = this.config.tracker.activeStates.map(s => s.toLowerCase());
    const terminal = this.config.tracker.terminalStates.map(s => s.toLowerCase());

    if (!active.includes(stateNorm)) return false;
    if (terminal.includes(stateNorm)) return false;
    if (this.state.running.has(issue.id)) return false;
    if (this.state.claimed.has(issue.id)) return false;

    // Blocker check for Todo state
    if (stateNorm === 'todo') {
      const hasActiveBlocker = issue.blockedBy.some(b => {
        if (!b.state) return false;
        return !terminal.includes(b.state.toLowerCase());
      });
      if (hasActiveBlocker) return false;
    }

    return true;
  }

  private availableSlots(): number {
    return Math.max(this.config.agent.maxConcurrentAgents - this.state.running.size, 0);
  }

  private perStateSlots(state: string): number {
    const norm = state.toLowerCase();
    const limit = this.config.agent.maxConcurrentAgentsByState[norm];
    if (limit === undefined) return this.availableSlots();

    const countInState = [...this.state.running.values()]
      .filter(e => e.issue.state.toLowerCase() === norm).length;

    return Math.max(limit - countInState, 0);
  }

  // ─── Private: worker lifecycle ────────────────────────────────────────────

  private launchWorker(issue: Issue, attempt: number | null): void {
    const abortController = new AbortController();
    const startedAt = new Date();

    this.state.claimed.add(issue.id);
    this.state.running.set(issue.id, {
      issue,
      attempt,
      workspacePath: '',
      startedAt,
      session: emptySession(),
      abortController,
    });

    this.log.info('worker_launched', {
      issue_id: issue.id,
      issue_identifier: issue.identifier,
      attempt,
    });

    const onEvent = this.makeEventHandler(issue.id);

    this.runner
      .run(issue, attempt, this.config, onEvent, abortController.signal)
      .then(result => this.onWorkerSuccess(issue.id, result.usage, startedAt))
      .catch(err => this.onWorkerFailure(issue.id, err, attempt, startedAt));
  }

  private makeEventHandler(issueId: string): (event: AgentEvent) => void {
    return (event: AgentEvent) => {
      const entry = this.state.running.get(issueId);
      if (!entry) return;

      entry.session.lastAgentEvent = event.event;
      entry.session.lastAgentTimestamp = event.timestamp;

      if (event.message) entry.session.lastAgentMessage = event.message;
      if (event.agentPid) entry.session.agentPid = event.agentPid;
      if (event.sessionId) {
        entry.session.sessionId = event.sessionId;
        entry.session.threadId = event.sessionId;
      }

      if (event.event === 'session_started') {
        entry.session.turnCount += 1;
        this.log.info('agent_session_started', { issue_id: issueId, session_id: event.sessionId });
      }

      if (event.usage) {
        const u = event.usage;
        const deltaIn = Math.max(u.inputTokens - entry.session.lastReportedInputTokens, 0);
        const deltaOut = Math.max(u.outputTokens - entry.session.lastReportedOutputTokens, 0);

        entry.session.lastReportedInputTokens = u.inputTokens;
        entry.session.lastReportedOutputTokens = u.outputTokens;
        entry.session.lastReportedTotalTokens = u.totalTokens;
        entry.session.agentInputTokens += deltaIn;
        entry.session.agentOutputTokens += deltaOut;
        entry.session.agentTotalTokens += deltaIn + deltaOut;
      }
    };
  }

  private onWorkerSuccess(issueId: string, usage: TokenUsage, startedAt: Date): void {
    const entry = this.state.running.get(issueId);
    const elapsed = (Date.now() - startedAt.getTime()) / 1000;

    this.state.running.delete(issueId);
    this.state.endedSessionSeconds += elapsed;
    this.addToTotals(usage);

    const attempt = (entry?.attempt ?? 0) + 1;
    const identifier = entry?.issue.identifier ?? issueId;

    this.log.info('worker_succeeded', {
      issue_id: issueId,
      issue_identifier: identifier,
      elapsed_s: elapsed.toFixed(1),
      total_tokens: usage.totalTokens,
    });

    // Short continuation retry — orchestrator re-checks if issue still needs work
    this.scheduleRetry(issueId, identifier, attempt, 1000, null);
  }

  private onWorkerFailure(
    issueId: string,
    err: Error,
    prevAttempt: number | null,
    startedAt: Date,
  ): void {
    // Graceful abort from reconciliation — no retry
    if (err.name === 'AbortError') {
      this.state.running.delete(issueId);
      // claimed already cleared by terminateWorker caller
      return;
    }

    const entry = this.state.running.get(issueId);
    const elapsed = (Date.now() - startedAt.getTime()) / 1000;

    this.state.running.delete(issueId);
    this.state.endedSessionSeconds += elapsed;

    const attempt = (prevAttempt ?? 0) + 1;
    const identifier = entry?.issue.identifier ?? issueId;
    const delay = Math.min(10000 * Math.pow(2, attempt - 1), this.config.agent.maxRetryBackoffMs);

    this.log.warn('worker_failed', {
      issue_id: issueId,
      issue_identifier: identifier,
      error: err.message,
      retry_in_ms: delay,
    });

    this.scheduleRetry(issueId, identifier, attempt, delay, err.message);
  }

  // ─── Private: retry ───────────────────────────────────────────────────────

  private scheduleRetry(
    issueId: string,
    identifier: string,
    attempt: number,
    delayMs: number,
    error: string | null,
  ): void {
    const existing = this.state.retryAttempts.get(issueId);
    if (existing) clearTimeout(existing.timerHandle);

    const handle = setTimeout(() => void this.onRetryFired(issueId), delayMs);

    this.state.retryAttempts.set(issueId, {
      issueId,
      identifier,
      attempt,
      dueAtMs: Date.now() + delayMs,
      timerHandle: handle,
      error,
    });
  }

  private async onRetryFired(issueId: string): Promise<void> {
    const retryEntry = this.state.retryAttempts.get(issueId);
    if (!retryEntry) return;

    this.state.retryAttempts.delete(issueId);

    let candidates: Issue[];
    try {
      candidates = await this.tracker.fetchCandidateIssues(this.config);
    } catch (err) {
      this.log.warn('retry_fetch_failed', { issue_id: issueId, error: (err as Error).message });
      this.state.claimed.delete(issueId);
      return;
    }

    const issue = candidates.find(i => i.id === issueId);

    if (!issue) {
      this.log.info('retry_issue_gone', { issue_id: issueId });
      this.state.claimed.delete(issueId);
      return;
    }

    const stateNorm = issue.state.toLowerCase();
    const active = this.config.tracker.activeStates.map(s => s.toLowerCase());

    if (!active.includes(stateNorm)) {
      this.log.info('retry_issue_inactive', { issue_id: issueId, state: issue.state });
      this.state.claimed.delete(issueId);
      return;
    }

    if (this.availableSlots() > 0) {
      this.launchWorker(issue, retryEntry.attempt);
    } else {
      this.log.info('retry_no_slots', { issue_id: issueId });
      this.scheduleRetry(issueId, retryEntry.identifier, retryEntry.attempt, 10000, 'no available orchestrator slots');
    }
  }

  // ─── Private: reconciliation ──────────────────────────────────────────────

  private async reconcile(): Promise<void> {
    if (this.state.running.size === 0) return;

    const stallMs = this.config.agentBackend.stallTimeoutMs;
    const now = Date.now();

    // Part A: stall detection
    if (stallMs > 0) {
      for (const [issueId, entry] of this.state.running) {
        const ref = entry.session.lastAgentTimestamp ?? entry.startedAt;
        const elapsed = now - ref.getTime();

        if (elapsed > stallMs) {
          this.log.warn('stall_detected', {
            issue_id: issueId,
            elapsed_ms: elapsed,
            stall_timeout_ms: stallMs,
          });
          this.terminateWorker(issueId, 'stall');
          const attempt = (entry.attempt ?? 0) + 1;
          const delay = Math.min(10000 * Math.pow(2, attempt - 1), this.config.agent.maxRetryBackoffMs);
          this.scheduleRetry(issueId, entry.issue.identifier, attempt, delay, 'stall timeout');
        }
      }
    }

    // Part B: tracker state refresh
    const runningIds = [...this.state.running.keys()];
    if (runningIds.length === 0) return;

    let stateMap: Map<string, string>;
    try {
      stateMap = await this.tracker.fetchIssueStatesByIds(runningIds, this.config);
    } catch (err) {
      this.log.warn('reconcile_state_refresh_failed', { error: (err as Error).message });
      return;
    }

    const terminalNorm = this.config.tracker.terminalStates.map(s => s.toLowerCase());
    const activeNorm = this.config.tracker.activeStates.map(s => s.toLowerCase());

    for (const [issueId, entry] of this.state.running) {
      const trackerState = stateMap.get(issueId);
      if (!trackerState) continue;

      const norm = trackerState.toLowerCase();

      if (terminalNorm.includes(norm)) {
        this.log.info('reconcile_terminal', { issue_id: issueId, state: trackerState });
        this.terminateWorker(issueId, 'terminal_state');
        this.state.claimed.delete(issueId);
        await this.workspaceManager.removeWorkspace(entry.issue.identifier, this.config).catch(e => {
          this.log.warn('workspace_remove_failed', { issue_id: issueId, error: (e as Error).message });
        });
      } else if (activeNorm.includes(norm)) {
        entry.issue.state = trackerState;
      } else {
        this.log.info('reconcile_inactive', { issue_id: issueId, state: trackerState });
        this.terminateWorker(issueId, 'inactive_state');
        this.state.claimed.delete(issueId);
      }
    }
  }

  private terminateWorker(issueId: string, reason: string): void {
    const entry = this.state.running.get(issueId);
    if (!entry) return;
    this.log.info('worker_terminated', { issue_id: issueId, reason });
    entry.abortController.abort();
    // The abort causes the worker promise to reject with AbortError,
    // which is handled in onWorkerFailure without scheduling a retry.
    this.state.running.delete(issueId);
  }

  // ─── Private: startup cleanup ─────────────────────────────────────────────

  private async startupCleanup(): Promise<void> {
    this.log.info('startup_cleanup_start');
    try {
      const terminal = await this.tracker.fetchIssuesByStates(
        this.config.tracker.terminalStates,
        this.config,
      );
      for (const issue of terminal) {
        await this.workspaceManager.removeWorkspace(issue.identifier, this.config).catch(e => {
          this.log.warn('cleanup_remove_failed', { identifier: issue.identifier, error: (e as Error).message });
        });
      }
      this.log.info('startup_cleanup_done', { terminal_count: terminal.length });
    } catch (err) {
      this.log.warn('startup_cleanup_failed', { error: (err as Error).message });
    }
  }

  // ─── Private: helpers ────────────────────────────────────────────────────

  private reloadWorkflow(): ServiceConfig {
    const def: WorkflowDefinition = loadWorkflow(this.workflowPath);
    return parseConfig(def);
  }

  // ─── Private: HTTP server ────────────────────────────────────────────────

  private startHttpServer(port: number | null): void {
    // If already running on the same port, nothing to do
    const addr = this.httpServer?.address();
    const currentPort = addr && typeof addr === 'object' ? addr.port : null;
    if (port === currentPort) return;

    // Close existing server if any
    if (this.httpServer) {
      this.httpServer.close();
      this.httpServer = null;
    }

    if (port === null) return;

    const server = http.createServer((req, res) => {
      if (req.method === 'GET' && req.url === '/status') {
        const snap = this.snapshot();
        const body = JSON.stringify(snap, null, 2);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(body);
      } else {
        res.writeHead(404);
        res.end('Not found');
      }
    });

    server.listen(port, () => {
      const addr = server.address();
      const bound = addr && typeof addr === 'object' ? addr.port : port;
      this.log.info('http_server_started', { port: bound });
    });

    server.on('error', (err) => {
      this.log.error('http_server_error', { error: (err as Error).message });
    });

    this.httpServer = server;
  }

  private addToTotals(usage: TokenUsage): void {
    this.state.agentTotals.inputTokens += usage.inputTokens;
    this.state.agentTotals.outputTokens += usage.outputTokens;
    this.state.agentTotals.totalTokens += usage.totalTokens;
  }
}

function compareIssues(a: Issue, b: Issue): number {
  const ap = a.priority ?? 999;
  const bp = b.priority ?? 999;
  if (ap !== bp) return ap - bp;

  const ac = a.createdAt?.getTime() ?? 0;
  const bc = b.createdAt?.getTime() ?? 0;
  if (ac !== bc) return ac - bc;

  return a.identifier.localeCompare(b.identifier);
}
